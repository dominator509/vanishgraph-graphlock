#!/usr/bin/env sh
# Harness initialization: ingest the registry, verify the casebooks, derive stage ownership, seed the
# dependency graph (EP-010 M2(a)(b); VG-SHIP-018/019, DOD-030/031/033). Sentinel: `harness init: ok`
#
# REPLACES THE PRE-DISCOVERY LOUD-FAIL PLACEHOLDER, which refused to print a sentinel while no harness existed
# (DOD-024, DOD-027). This is the implementation it was waiting for, and the sentinel is still printed only when
# every count below validates.
#
# WHAT IT VERIFIES, AND WHY EACH CHECK IS A COUNT RATHER THAN A CLAIM:
#   * the registry holds exactly 484 rows with 484 UNIQUE ids, and the five prefix counts are exactly
#     122/125/202/20/15. A missing or duplicated ID is the failure the accounting invariant exists to catch, and
#     catching it here means it is caught before any stage has run;
#   * the source-body split HARNESS_LAWS.md declares (434 supplied bodies plus 15 reconstructed Blockchain rows,
#     plus the E2E and SUP families) matches the registry's own `source_body_status` column;
#   * EVERY id has a casebook object, drawn from the five casebook files, and every object carries the six fields
#     a casebook exists to provide (exact commands, oracle, positive case, negative case, mutation case, evidence
#     paths) with no placeholder text -- a casebook entry that says TODO is not a test definition;
#   * stage ownership is derived from the registry's `default_stage` column through the mapping the plan fixes, and
#     the ownership is TOTAL (every id owned exactly once), which is VG-SHIP-019;
#   * the dependency-graph seed is written from `.agent/verification/GRAPH.md` PARSED AT RUN TIME rather than from
#     a copy of it, and the seed refuses a DAG that could cascade (a stage depending on a later stage).
#
# IT IS SAFE TO RE-RUN, AND THE RE-RUN IS PROVEN RATHER THAN ASSERTED: the ingest program runs TWICE in this
# script and the two renders of the seed must be byte-identical, which is what "resume, not duplicate" means
# mechanically.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "harness init: FAIL - $1" >&2; exit 1; }

REGISTRY=.agent/verification/MASTER_TEST_REGISTRY.csv
CASEBOOKS=.agent/verification/casebooks
GRAPH=.agent/verification/GRAPH.md
SEED=.agent/verification/state/DEPENDENCY_BLOCKER_GRAPH.json
EVIDENCE_DIR=.agent/evidence/EP-010/M2-applicability
mkdir -p "$EVIDENCE_DIR" .agent/verification/state

for path in "$REGISTRY" "$GRAPH"; do
  [ -f "$path" ] || fail "$path is missing; the harness cannot ingest what does not exist"
done
[ -d "$CASEBOOKS" ] || fail "$CASEBOOKS is missing; no casebook object could be verified"
command -v node >/dev/null 2>&1 || fail "node is required but not found"

INGEST=$(mktemp)
trap 'rm -f "$INGEST"' EXIT INT TERM
cat >"$INGEST" <<'ENDS_HARNESS_INIT'
const fs = require("node:fs");
const path = require("node:path");
const [registryPath, casebookDir, graphPath, seedPath, evidenceDir] = process.argv.slice(2);
const problems = [];
const facts = {};

// A MINIMAL RFC4180 READER. The registry is a real CSV with quoted titles, so splitting on commas would silently
// corrupt rows and every count computed from them.
function readCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; } else { quoted = false; }
      } else { field += character; }
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ",") { row.push(field); field = ""; continue; }
    if (character === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (character === "\r") continue;
    field += character;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((entry) => entry.length > 1 || (entry[0] ?? "").trim() !== "");
}

const registryRows = readCsv(fs.readFileSync(registryPath, "utf8"));
const header = registryRows[0].map((name) => name.trim());
const records = registryRows.slice(1).map((values) => Object.fromEntries(header.map((name, index) => [name, (values[index] ?? "").trim()])));
facts.registry_rows = records.length;
if (records.length !== 484) problems.push(`the registry holds ${records.length} rows and the pack fixes 484`);

const ids = records.map((record) => record.test_id);
const unique = new Set(ids);
facts.unique_ids = unique.size;
if (unique.size !== 484) problems.push(`the registry holds ${unique.size} unique ids and the pack fixes 484`);
if (unique.size !== ids.length) problems.push("the registry contains duplicated ids");

const prefixes = {};
for (const id of ids) {
  const prefix = id.split("-")[0];
  prefixes[prefix] = (prefixes[prefix] ?? 0) + 1;
}
facts.prefix_counts = prefixes;
for (const [prefix, expected] of Object.entries({ GEN: 122, HIPAA: 125, BC: 202, E2E: 20, SUP: 15 })) {
  if ((prefixes[prefix] ?? 0) !== expected) problems.push(`prefix ${prefix} has ${prefixes[prefix] ?? 0} rows and the pack fixes ${expected}`);
}

// The source-body split, read from the registry rather than restated.
const bodyStatus = {};
for (const record of records) bodyStatus[record.source_body_status] = (bodyStatus[record.source_body_status] ?? 0) + 1;
facts.source_body_status = bodyStatus;
const reconstructed = records.filter((record) => /reconstruct/i.test(record.source_body_status));
facts.reconstructed_ids = reconstructed.map((record) => record.test_id);
if (reconstructed.length !== 15) problems.push(`${reconstructed.length} rows are marked reconstructed and HARNESS_LAWS.md declares 15`);
const declaredFamilies = records.filter((record) => /^(GEN|HIPAA|BC)-/.test(record.test_id));
const declaredSupplied = declaredFamilies.filter((record) => !/reconstruct/i.test(record.source_body_status)).length;
facts.declared_family_supplied = declaredSupplied;
if (declaredSupplied !== 434) problems.push(`the three declared families supply ${declaredSupplied} original bodies and HARNESS_LAWS.md declares 434`);

// The casebooks: one object per id, with the fields a test definition needs.
const casebookFiles = fs.readdirSync(casebookDir).filter((name) => name.endsWith(".jsonl")).sort();
facts.casebook_files = casebookFiles;
const casebooks = new Map();
const REQUIRED_FIELDS = ["exact_commands", "oracle", "positive_case", "negative_case", "mutation_case", "evidence_paths"];
const PLACEHOLDER = /\b(TODO|TBD|FIXME|XXX|PLACEHOLDER|LOREM|FILL[ _-]?IN|EXAMPLE\.COM)\b/i;
for (const file of casebookFiles) {
  const lines = fs.readFileSync(path.join(casebookDir, file), "utf8").split("\n").filter((line) => line.trim() !== "");
  for (const line of lines) {
    let object;
    try { object = JSON.parse(line); } catch { problems.push(`${file}: a line is not JSON`); continue; }
    if (typeof object.test_id !== "string" || object.test_id === "") { problems.push(`${file}: an object has no test_id`); continue; }
    if (casebooks.has(object.test_id)) problems.push(`${object.test_id} appears in more than one casebook object`);
    casebooks.set(object.test_id, { file, object });
    for (const field of REQUIRED_FIELDS) {
      const value = object[field];
      const empty = value === undefined || value === null || (Array.isArray(value) ? value.length === 0 : String(value).trim() === "");
      if (empty) problems.push(`${object.test_id}: casebook field ${field} is empty`);
      else if (PLACEHOLDER.test(JSON.stringify(value))) problems.push(`${object.test_id}: casebook field ${field} contains placeholder text`);
    }
  }
}
facts.casebook_objects = casebooks.size;
if (casebooks.size !== 484) problems.push(`${casebooks.size} casebook objects exist and the pack fixes 484`);
for (const id of ids) if (!casebooks.has(id)) problems.push(`${id} has no casebook object`);

// Ownership: the plan mapping applied to the registry default_stage, with the one multi-stage value split per id.
const MAPPING = {
  "02-CLAIMS-TRACEABILITY": ["V-002"],
  "03-STATIC-DESIGN-SUPPLY-CHAIN": ["V-004"],
  "04-BUILD-ARTIFACT-DEPLOYMENT": ["V-005"],
  "05-SMOKE": ["V-006"],
  "06-SANITY": ["V-007"],
  "07-FUNCTIONAL-REALITY": ["V-008"],
  "08-API-INTEGRATION": ["V-009"],
  "09-DATA-SEMANTICS": ["V-010"],
  "10-COMPATIBILITY": ["V-011"],
  "11-FORMAL-PROPERTY-REGRESSION": ["V-012"],
  "11-REGRESSION": ["V-012"],
  "12-AI-AGENT-SAFETY": ["V-013"],
  "12-DYNAMIC-SECURITY": ["V-013"],
  "13-EXPLORATORY": ["V-014"],
  "14-USABILITY-A11Y-DX": ["V-015"],
  "15-PERFORMANCE": ["V-016"],
  "16-SOAK": ["V-017"],
  "17-STRESS-CHAOS": ["V-018"],
  "17-RECOVERY-OBSERVABILITY": ["V-019"],
  "18-RECOVERY-DR": ["V-019"],
  "19-EXTERNAL-HUMAN": ["V-021"],
  "19-FINAL-ARTIFACT": ["V-020"],
  "20-UAT-HUMAN": ["V-021"],
};
const MULTI = "15-17-PERFORMANCE-STRESS-RECOVERY";
const owners = new Map();
const splitLog = [];
for (const record of records) {
  const stage = record.default_stage;
  let targets = MAPPING[stage];
  if (stage === MULTI) {
    // WHERE A default_stage MAPS TO MORE THAN ONE STAGE, THE SPLIT IS DECIDED PER ID FROM ITS TITLE and recorded,
    // because the pack says so and because a range-based split would be a guess dressed as a mapping.
    const title = `${record.title} ${record.kind}`.toLowerCase();
    if (/recover|restore|failover|disaster|resume|resilien/.test(title)) targets = ["V-019"];
    else if (/soak|endurance|leak|long.run|sustain/.test(title)) targets = ["V-017"];
    else if (/stress|chaos|spike|burst|saturat|load/.test(title)) targets = ["V-018"];
    else targets = ["V-016"];
    splitLog.push({ test_id: record.test_id, default_stage: stage, owner_stage: targets[0], title: record.title });
  }
  if (targets === undefined) { problems.push(`${record.test_id}: default_stage ${stage} has no mapping`); continue; }
  if (targets.length !== 1) { problems.push(`${record.test_id}: default_stage ${stage} maps to ${targets.length} stages without a per-id rule`); continue; }
  owners.set(record.test_id, targets[0]);
}
facts.ownership = {};
for (const stage of owners.values()) facts.ownership[stage] = (facts.ownership[stage] ?? 0) + 1;
const ownershipTotal = Object.values(facts.ownership).reduce((sum, count) => sum + count, 0);
facts.ownership_total = ownershipTotal;
if (ownershipTotal !== 484) problems.push(`stage ownership covers ${ownershipTotal} ids and must cover 484`);
if (owners.size !== 484) problems.push(`stage ownership assigns ${owners.size} ids and must assign 484`);

// The dependency-graph seed, from GRAPH.md parsed as the source of the DAG.
const graphText = fs.readFileSync(graphPath, "utf8");
const block = graphText.split("VERIFICATION-GRAPH-TABLE-BEGIN")[1]?.split("VERIFICATION-GRAPH-TABLE-END")[0] ?? "";
const nodes = [];
for (const line of block.split("\n")) {
  const match = /^STAGE (V-\d{3}) DEPS (.*)$/.exec(line.trim());
  if (match === null) continue;
  const deps = match[2].trim() === "-" ? [] : match[2].trim().split(/\s+/);
  nodes.push({ stage: match[1], depends_on: deps });
}
facts.stages = nodes.length;
if (nodes.length !== 22) problems.push(`GRAPH.md declares ${nodes.length} stages and the pack fixes 22 (V-000 through V-021)`);
const declaredStages = nodes.map((node) => node.stage);
for (let index = 0; index < 22; index += 1) {
  const expected = `V-${String(index).padStart(3, "0")}`;
  if (!declaredStages.includes(expected)) problems.push(`GRAPH.md does not declare ${expected}`);
}
// NON-CASCADING: a stage may depend only on stages declared before it, so a failure cannot cascade forwards.
const position = new Map(declaredStages.map((stage, index) => [stage, index]));
for (const node of nodes) {
  for (const dependency of node.depends_on) {
    if (!position.has(dependency)) { problems.push(`${node.stage} depends on ${dependency}, which GRAPH.md does not declare`); continue; }
    if (position.get(dependency) >= position.get(node.stage)) problems.push(`${node.stage} depends on ${dependency}, which is not earlier: the DAG would cascade`);
  }
}

const runState = JSON.parse(fs.readFileSync(".agent/verification/state/RUN_STATE.json", "utf8"));
const identity = JSON.parse(fs.readFileSync(".agent/verification/state/ARTIFACT_IDENTITY.json", "utf8"));
const tarball = identity.artifact_paths.find((entry) => entry.endsWith(".tgz"));
const seed = {
  epoch: runState.epoch,
  artifact_digest: identity.artifact_digests[tarball],
  generated_by: "sh scripts/harness-init.sh",
  nodes,
  stage_edges: nodes.flatMap((node) => node.depends_on.map((dependency) => ({ from: dependency, to: node.stage, kind: "stage-order" }))),
  ownership: Object.entries(facts.ownership).sort().map(([stage, count]) => ({ stage, ids_owned: count })),
  ownership_rows: [...owners.entries()].sort().map(([test_id, stage]) => ({ test_id, owner_stage: stage })),
  split_decisions: splitLog,
  counts: { registry_rows: records.length, unique_ids: unique.size, prefix_counts: prefixes, casebook_objects: casebooks.size, ownership_total: ownershipTotal },
  note:
    "The dependency-blocker graph seed. Stage order comes from .agent/verification/GRAPH.md PARSED AT RUN TIME; " +
    "ownership comes from the registry default_stage column through the plan mapping, with the one multi-stage " +
    "value split per id from its title and every such decision listed in split_decisions. Blocker edges are added " +
    "by the stages themselves as they run: an id that is BLOCKED_PREREQUISITE must name the edge it waits on, " +
    "which scripts/harness-validate.sh refuses to accept without.",
};
fs.writeFileSync(seedPath, `${JSON.stringify(seed, null, 2)}\n`);
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(evidenceDir, "harness-init.json"), `${JSON.stringify({ problems, facts }, null, 2)}\n`);
for (const problem of problems) console.log(`harness init: FAIL - ${problem}`);
console.log(`harness init: ${records.length} rows, ${unique.size} unique ids, ${casebooks.size} casebook objects, ${nodes.length} stages, ownership total ${ownershipTotal}`);
console.log(`harness init: prefix counts ${JSON.stringify(prefixes)}; source bodies ${JSON.stringify(bodyStatus)}; reconstructed ${reconstructed.length}`);
if (problems.length > 0) process.exit(1);
ENDS_HARNESS_INIT

digest_of() { node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$1"; }

node "$INGEST" "$REGISTRY" "$CASEBOOKS" "$GRAPH" "$SEED" "$EVIDENCE_DIR" || fail "the registry, the casebooks or the ownership derivation did not validate; see .agent/evidence/EP-010/M2-applicability/harness-init.json"
FIRST=$(digest_of "$SEED")

# SAFE TO RE-RUN, PROVEN BY RE-RUNNING: the same ingest runs a second time and the seed must be byte-identical.
node "$INGEST" "$REGISTRY" "$CASEBOOKS" "$GRAPH" "$SEED" "$EVIDENCE_DIR" >/dev/null || fail "the second ingest failed; the init is not resumable"
SECOND=$(digest_of "$SEED")
[ "$FIRST" = "$SECOND" ] || fail "two consecutive ingests produced different seeds ($FIRST vs $SECOND); the init is not idempotent"

echo "harness init: seed sha256 $FIRST (a second ingest reproduced it byte for byte)"
echo "harness init: ok"
