#!/usr/bin/env sh
# Alert catalogue guard (SPEC-007 §8, §12.6; EP-008 M6). Sentinel: `alert catalogue: ok`
#
# WHAT IT CHECKS, AND WHAT IT REFUSES TO PRETEND:
#
#   1. EXACTLY 20 ROWS with the ids §8 declares, each carrying an expression, a threshold, a `for`, a severity, a routing
#      lane from the four §8 defines, and a runbook path. A PLACEHOLDER IN ANY FIELD IS A FAILURE — an empty string, TBD,
#      TODO, or a threshold that says nothing.
#   2. A FIRING CONDITION IS STATED, IN THE EXPRESSION OR IN THE THRESHOLD. MEASURED WHY BOTH PLACES ARE ACCEPTED: the §8
#      table gives six alerts a BARE aggregation in the expression column (A-09b, A-10, A-11, A-12, A-13, A-14) and puts
#      the comparison in the separate THRESHOLD column. Requiring the comparison inside the expression failed those six
#      rows on the layout of the specification itself.
#   3. THE REQUIRED CRITICAL SET of §8 coverage rule 1 is present as ROWS, AND ITS DISAGREEMENT WITH THE §8 TABLE IS
#      KEPT VISIBLE RATHER THAN RESOLVED HERE: rule 1 calls A-01…A-10 critical while the table marks A-02, A-03, A-06,
#      A-07, A-09 and A-10 as `warning`. The guard requires every such id to be LISTED in the catalogue's recorded
#      conflict, so the contradiction cannot be papered over by editing one of two normative statements.
#   4. EVERY METRIC NAMED IN EVERY EXPRESSION IS REGISTERED (VG-OBS-016), with histogram suffixes (`_bucket`, `_sum`,
#      `_count`) resolving to their family.
#   5. EVERY RUNBOOK PATH EXISTS AND IS NOT EMPTY: a row pointing at a document nobody wrote is a promise nobody can keep.
#   6. NO ALERT IS PHRASED OR ANNOTATED AS SUCCESS (§8 coverage rule 2).
#   7. THE INDUCED FIRE-AND-RESOLVE PROOF IS **NOT RUN**, AND THIS GUARD SAYS SO RATHER THAN IMPLYING IT. §8 requires each
#      alert to be demonstrated firing under an induced condition with correct labels and resolving after remediation.
#      THAT NEEDS AN EXPRESSION EVALUATOR AND A SERIES STORE, AND THIS REPOSITORY HAS NEITHER: no Prometheus server, no
#      recording rules, no alert rules loaded anywhere. A miniature evaluator written here would prove that a hand-written
#      interpreter agrees with itself, not that the alert fires — so the check is reported as NOT RUN with its reason, and
#      the sentinel covers the six structural checks above.
#
# THE CHECK IS WRITTEN TO A FILE AND RUN AS A FILE, NOT AS AN INLINE `-e` STRING, and that is a MEASURED correction: the
# first version embedded the script in single quotes, so the apostrophes in its own comments terminated the shell string
# and the guard died with a syntax error three times before the cause was found. A quoted heredoc has no such quoting
# surface.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "alert catalogue: FAIL - node is required but not found" >&2; exit 1; }
[ -f config/alerts/catalogue.json ] || { echo "alert catalogue: FAIL - config/alerts/catalogue.json is missing" >&2; exit 1; }

EVIDENCE=.agent/evidence/EP-008/alerts
mkdir -p "$EVIDENCE"

cat >"$EVIDENCE/alert-check.mjs" <<'CHECK_EOF'
const { pathToFileURL } = await import("node:url");
const registry = await import(pathToFileURL(`${process.cwd()}/src/adapters/observability/metrics-registry.ts`).href);
const fs = await import("node:fs");

const problems = [];
const catalogue = JSON.parse(fs.readFileSync("config/alerts/catalogue.json", "utf8"));
const loaded = registry.loadMetricCatalogue("config/metrics/catalogue.json");
if (!loaded.ok) problems.push("the metric catalogue does not validate, so no expression can be checked against it");
const registered = new Set(loaded.ok ? loaded.catalogue.families.map((f) => f.name) : []);

const EXPECTED_IDS = ["A-01", "A-01b", "A-02", "A-03", "A-04", "A-05", "A-06", "A-06b", "A-06c", "A-07", "A-07b", "A-08", "A-09", "A-09b", "A-10", "A-11", "A-12", "A-13", "A-14", "A-15"];
const LANES = ["page", "page-security", "ticket", "advisory"];
const PLACEHOLDER = /^(|tbd|todo|tba|n\/?a|placeholder|xxx+|-\?*)$/i;
const SUCCESS_VOCABULARY = /(removal confirmed|success rate|successful removal|all clear|good news|celebrat)/i;
// THE REGEX IS A CHARACTER CLASS OF THREE COMPARISON SIGNS, AND THE FIRST VERSION WROTE IT AS `[><]=`, WHICH MEANS
// "GREATER-THAN OR LESS-THAN FOLLOWED BY AN EQUALS" — so a threshold like `> 0` matched nothing and every alert was
// reported as having no firing condition. MEASURED, and the kind of defect a negative control would have caught earlier.
const COMPARATOR = /[><=]|absent\(/;

const alerts = Array.isArray(catalogue.alerts) ? catalogue.alerts : [];
if (alerts.length !== 20) problems.push(`the catalogue must carry exactly 20 alert rows and carries ${alerts.length}`);
const ids = alerts.map((a) => a.id);
if (new Set(ids).size !== ids.length) problems.push("two alert rows share an id");
for (const id of EXPECTED_IDS) if (!ids.includes(id)) problems.push(`the specification declares ${id} and the catalogue does not carry it`);
for (const id of ids) if (!EXPECTED_IDS.includes(id)) problems.push(`${id} is not an alert the specification declares`);

let conditionInExpr = 0;
let conditionInThreshold = 0;
for (const alert of alerts) {
  for (const field of ["id", "name", "expr", "threshold", "for", "severity", "routing", "runbook"]) {
    const value = alert[field];
    if (typeof value !== "string" || PLACEHOLDER.test(value.trim())) problems.push(`${alert.id}: ${field} is missing or a placeholder`);
  }
  if (!LANES.includes(alert.routing)) problems.push(`${alert.id}: routing "${alert.routing}" is not one of ${LANES.join(", ")}`);
  if (!["critical", "warning"].includes(alert.severity)) problems.push(`${alert.id}: severity "${alert.severity}" is not critical or warning`);
  if (COMPARATOR.test(alert.expr)) conditionInExpr += 1;
  else if (COMPARATOR.test(alert.threshold)) conditionInThreshold += 1;
  else problems.push(`${alert.id}: neither the expression nor the threshold states a firing condition`);
  if (SUCCESS_VOCABULARY.test(alert.name) || SUCCESS_VOCABULARY.test(alert.expr)) problems.push(`${alert.id}: an alert may not be phrased or annotated as success (coverage rule 2)`);
  for (const name of alert.expr.match(/vanishgraph_[a-z0-9_]+/g) ?? []) {
    const base = name.replace(/_(bucket|sum|count)$/, "");
    if (!registered.has(name) && !registered.has(base)) problems.push(`${alert.id}: expression refers to unregistered metric ${name} (VG-OBS-016)`);
  }
  if (!fs.existsSync(alert.runbook)) problems.push(`${alert.id}: runbook ${alert.runbook} does not exist`);
  else if (fs.readFileSync(alert.runbook, "utf8").trim().length < 500) problems.push(`${alert.id}: runbook ${alert.runbook} is effectively empty`);
}

const requiredSet = catalogue.required_critical_set ?? [];
const recordedConflicts = catalogue.coverage_rule_1_conflicts?.ids_marked_warning_by_the_table_but_required_critical_by_rule_1 ?? [];
for (const id of requiredSet) {
  if (!ids.includes(id)) problems.push(`coverage rule 1 names ${id} and the catalogue carries no such row`);
  const row = alerts.find((a) => a.id === id);
  if (row !== undefined && row.severity !== "critical" && !recordedConflicts.includes(id)) {
    problems.push(`coverage rule 1 requires ${id} to be critical, the table says ${row.severity}, and the disagreement is not recorded`);
  }
}

console.log(`alerts: ${alerts.length} rows, ${new Set(ids).size} unique ids, all fields present and non-placeholder`);
console.log(`conditions: ${conditionInExpr} stated in the expression, ${conditionInThreshold} in the threshold column (the specification puts them in both places)`);
console.log(`routing lanes: ${[...new Set(alerts.map((a) => a.routing))].sort().join(", ")}`);
console.log(`coverage rule 1: ${requiredSet.length} id(s) present as rows; ${recordedConflicts.length} row(s) where rule 1 and the table disagree, RECORDED rather than silently resolved`);
console.log(`runbooks: ${new Set(alerts.map((a) => a.runbook)).size} document(s), all present and non-empty`);
console.log("metrics: every metric named in every expression is registered (histogram suffixes resolved to their family)");
console.log("success phrasing: no alert name or expression carries success vocabulary");
console.log("induction: NOT RUN - there is no expression evaluator and no series store in this repository, so no alert has been demonstrated firing or resolving; the sentinel covers the structural checks only");

if (problems.length > 0) {
  console.log("problems:");
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log("verdict: OK (structural; induction NOT RUN)");
CHECK_EOF

if ! node "$EVIDENCE/alert-check.mjs" >"$EVIDENCE/alert-catalogue-guard.txt" 2>&1; then
  echo "alert catalogue: FAIL - the catalogue, a runbook or an expression failed validation:" >&2
  cat "$EVIDENCE/alert-catalogue-guard.txt" >&2
  exit 1
fi

cat "$EVIDENCE/alert-catalogue-guard.txt"
grep -q 'verdict: OK' "$EVIDENCE/alert-catalogue-guard.txt" || { echo "alert catalogue: FAIL - the check printed no verdict" >&2; exit 1; }

echo "alert catalogue: ok"
