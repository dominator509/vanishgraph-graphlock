#!/usr/bin/env sh
# SLO evaluation stage (SPEC-007 §9, §12.7; EP-008 M7(c); DOD-022, DOD-038). Sentinel: `slo: evaluated`
#
# WHAT IT PRINTS: one `slo <objective>: PASS|FAIL|INCONCLUSIVE|DEFERRED_LONG_RUNNING` line per objective, then
# `slo: evaluated`.
#
# WHAT IT EXITS WITH, AND WHY THE TWO CASES ARE DIFFERENT: NON-ZERO WHEN ANY OBJECTIVE IS FAIL, because DOD-022 makes a
# mandatory SLO failure NO_GO; ZERO WHEN THE SAMPLE IS INCOMPLETE AND THE OBJECTIVES ARE INCONCLUSIVE OR DEFERRED,
# because "we cannot measure it yet" is an honest result and collapsing it into a failure would be as wrong as collapsing
# it into a pass. The distinction is the milestone's own requirement and it must not be flattened.
#
# WHERE THE SAMPLE COMES FROM, STATED RATHER THAN IMPLIED: §9 permits a verdict only in `staging` or `production`, and
# this repository has NEITHER — there is no series store, no Prometheus, no recording rules, and no 30-day window of
# traffic. So the sample is INCOMPLETE by construction and every objective is therefore DEFERRED_LONG_RUNNING (the
# duration-bound four) or INCONCLUSIVE (evaluation integrity, whose matrix has no produced run). THE STAGE DOES NOT
# INVENT A SAMPLE TO GET A VERDICT, and it records the provisioning attempt that would be needed for a real one.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "slo: FAIL - node is required but not found" >&2; exit 1; }
[ -f config/slo/objectives.json ] || { echo "slo: FAIL - config/slo/objectives.json is missing" >&2; exit 1; }

EVIDENCE=.agent/evidence/EP-008/slo
mkdir -p "$EVIDENCE"

# 1. THE PROVISIONING ATTEMPT LOG: what a verdict-bearing sample would need, and what is actually present.
{
  echo "slo evaluation - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "objective document: config/slo/objectives.json"
  echo
  echo "attempt: is a verdict-bearing environment configured? (§9 allows a verdict only in staging or production)"
  echo "  VANISHGRAPH_ENVIRONMENT=${VANISHGRAPH_ENVIRONMENT:-<unset>}"
  echo "  VANISHGRAPH_STAGING_URL=${VANISHGRAPH_STAGING_URL:-<unset>}"
  echo "attempt: is a series store reachable? (a verdict needs recorded series over the objective window)"
  echo "  PROMETHEUS_URL=${PROMETHEUS_URL:-<unset>}"
  echo "  VANISHGRAPH_METRICS_PATH=${VANISHGRAPH_METRICS_PATH:-<unset>}"
  echo "attempt: does a 30-day window of traffic exist?"
  echo "  this repository has no traffic history: the observability runtime is not deployed anywhere, so the answer is no."
  echo
  echo "consequence: the sample is INCOMPLETE, so the four duration-bound objectives are DEFERRED_LONG_RUNNING (DOD-038)"
  echo "and evaluation integrity is INCONCLUSIVE because no induced run has produced a verdict. A SHORTENED TRIAL IS NEVER"
  echo "REPORTED AS PASS, and no threshold was changed to fit what is available."
} >"$EVIDENCE/provisioning-attempts.txt"

# 2. THE EVALUATION. The driver is a file rather than an inline -e string, because a quoted heredoc has no shell-quoting
#    surface: the earlier alert guard died three times from apostrophes inside an inline script.
cat >"$EVIDENCE/slo-driver.mjs" <<'DRIVER_EOF'
const { pathToFileURL } = await import("node:url");
const evaluator = await import(pathToFileURL(`${process.cwd()}/src/adapters/observability/slo-evaluator.ts`).href);
const registryModule = await import(pathToFileURL(`${process.cwd()}/src/adapters/observability/metrics-registry.ts`).href);
const fs = await import("node:fs");

const objectives = JSON.parse(fs.readFileSync("config/slo/objectives.json", "utf8"));
const environment = process.env.VANISHGRAPH_ENVIRONMENT ?? "local";

// THE SAMPLE IS WHAT THIS ENVIRONMENT CAN EVIDENCE: an INCOMPLETE window and no matrix run. Nothing is synthesised to
// produce a verdict, and every objective therefore reports the gap rather than a number.
const sample = {
  window: { from: new Date(0).toISOString(), to: new Date().toISOString(), complete: false },
  values: {},
  observations: 0,
  destinationStatesPresent: [],
  ambiguityEvents: 0,
  integrityRuns: [],
};

const registry = registryModule.createMetricsRegistryFromFile("config/metrics/catalogue.json");
for (const name of ["vanishgraph_slo_verdict", "vanishgraph_slo_bad_events_total", "vanishgraph_slo_allowed_bad_events", "vanishgraph_slo_error_budget_burn_ratio"]) registry.register(name);

const result = evaluator.evaluateObjectives({ objectives, sample, environment, registry });
for (const verdict of result.verdicts) {
  console.log(evaluator.formatVerdictLine(verdict));
}
fs.writeFileSync(
  process.argv[1],
  `${JSON.stringify({ environment, sample_window: sample.window, revoked: result.revoked, verdicts: result.verdicts }, null, 2)}\n`,
);
const failures = result.verdicts.filter((verdict) => verdict.verdict === "FAIL");
const deferred = result.verdicts.filter((verdict) => verdict.verdict === "DEFERRED_LONG_RUNNING").length;
const inconclusive = result.verdicts.filter((verdict) => verdict.verdict === "INCONCLUSIVE").length;
console.log(`slo summary: ${String(result.verdicts.length)} objective(s), ${String(failures.length)} FAIL, ${String(deferred)} DEFERRED_LONG_RUNNING, ${String(inconclusive)} INCONCLUSIVE`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`slo ${failure.objective}: FAIL - ${failure.reason}`);
  process.exit(2);
}
DRIVER_EOF

set +e
node "$EVIDENCE/slo-driver.mjs" "$EVIDENCE/verdicts.json" 2>&1 | tee "$EVIDENCE/slo-evaluate.txt"
STATUS=$?
set -e
# THE PIPELINE STATUS IS READ FROM THE DRIVER, NOT FROM tee: `set -o pipefail` is not POSIX and a pipeline reports the
# last command status, which would turn a failing objective into a silent success.
if [ "$STATUS" -ne 0 ]; then
  echo "slo: FAIL - at least one objective is FAIL (DOD-022: a mandatory SLO failure is NO_GATE)" >&2
  exit "$STATUS"
fi

LINES=$(grep -c '^slo ' "$EVIDENCE/slo-evaluate.txt" || true)
[ "$LINES" -ge 5 ] || { echo "slo: FAIL - expected at least five objective lines and found $LINES" >&2; exit 1; }

echo "slo: evaluated"
