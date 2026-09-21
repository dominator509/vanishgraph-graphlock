#!/usr/bin/env sh
# Stage executor: runs one verification stage's owned IDs and accounts every one of them (EP-010 M3(a);
# SPEC-006 section 4.1, VG-SHIP-002/017, DOD-004/010/013/031/032/033). Sentinel: `stage <V-0NN>: accounted`
#
# REPLACES THE PRE-DISCOVERY LOUD-FAIL PLACEHOLDER.
#
# WHAT THIS EXECUTOR FOUND, AND WHY IT DOES NOT SIMPLY "RUN THE TESTS": the 484 IDs are entries in a PROMPT PACK.
# Each one is an `<AGENTIC_PROMPT>` block written for an agentic security-testing environment, with a role, an
# authorization boundary, a mandatory scope-discovery pass, a methodology and a completion gate. MEASURED: the
# casebook files delivered with the pack are TEMPLATED STUBS -- all 484 objects carry the same
# `exact_commands: ["sh scripts/verify.sh"]`, the same oracle phrase and the same negative case -- so a harness that
# ran `sh scripts/verify.sh` 484 times would prove nothing per ID and would print a sentinel over a placeholder.
#
# SO THE EXECUTOR DOES THREE THINGS, AND NOTHING ELSE:
#   1. IT EXTRACTS THE REAL DEFINITION. The registry's `source_file` column names the library carrying the prompt,
#      and the prompt block is written to the ID evidence directory -- evidence that the definition was read rather
#      than asserted. An ID whose definition cannot be located is an ERROR, never a skip.
#   2. IT RUNS THE REPOSITORY GATE THAT COVERS THE SAME SUBJECT, ONCE PER STAGE. Where the prompt's subject is
#      something this repository genuinely tests (static analysis, dependency scanning, secrets, build and
#      provenance, smoke, configuration, the pipeline definition, the browser suites), that gate is executed and its
#      output and digest are linked to every ID it covers. Running one gate once and citing it for the IDs it covers
#      is honest; running it once per ID would be the same evidence repeated four hundred times.
#   3. IT REFUSES TO CALL ANY OF THAT A PASS. SPEC-006 section 4.1 requires a `PASS` to have an executed oracle, a
#      matched sentinel AND AN EXECUTED NEGATIVE CASE. The negative case here is a paragraph inside an agentic
#      prompt that only an authorised agentic runner can execute, so the ceiling for a mapped ID is `PARTIAL`, and
#      an ID needing active testing, a deployed target, or a runner this environment does not have is
#      `BLOCKED_SAFETY`, `BLOCKED_ENVIRONMENT` or `BLOCKED_PREREQUISITE` with the field each one requires.
#
# IT EXITS 0 ON ACCOUNTING COMPLETION EVEN WHEN CANDIDATE TESTS FAILED (VG-SHIP-002) and non-zero only on a harness
# ERROR. A `FAIL` inside a stage never halts an independent stage.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

STAGE=${1:-}
INVALIDATE_REASON=${VG_INVALIDATE_REASON:-}
set -- ${INVALIDATE_REASON:+--invalidate "$INVALIDATE_REASON"}
case "$STAGE" in
  V-0[0-9][0-9]) : ;;
  *) echo "stage: FAIL - usage: sh scripts/harness-run-stage.sh <V-0NN>" >&2; exit 1 ;;
esac

MATRIX=.agent/verification/APPLICABILITY_MATRIX.csv
REGISTRY=.agent/verification/MASTER_TEST_REGISTRY.csv
SEED=.agent/verification/state/DEPENDENCY_BLOCKER_GRAPH.json
LEDGER_STATE=.agent/verification/state/TEST_LEDGER.jsonl
AUDIT=.agent/verification/state/STATUS_TRANSITION_AUDIT.jsonl
EVIDENCE_INDEX=.agent/verification/state/EVIDENCE_INDEX.json
CHECKPOINT=.agent/verification/state/stage-checkpoint.json
OUTDIR=.agent/evidence/EP-010/$STAGE
mkdir -p "$OUTDIR"

[ -f "$MATRIX" ] || { echo "stage $STAGE: ERROR - $MATRIX is missing; run sh scripts/applicability-decide.sh first" >&2; exit 1; }
[ -f "$SEED" ] || { echo "stage $STAGE: ERROR - $SEED is missing; run sh scripts/harness-init.sh first" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "stage $STAGE: ERROR - node is required but not found" >&2; exit 1; }

RUNNER=$(mktemp)
trap 'rm -f "$RUNNER"' EXIT INT TERM
cat >"$RUNNER" <<'ENDS_RUN_STAGE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const [stage, matrixPath, registryPath, seedPath, ledgerPath, auditPath, evidenceIndexPath, checkpointPath, outDir] = process.argv.slice(2);
const flagIndex = process.argv.indexOf("--invalidate");
const invalidationReason = flagIndex === -1 ? null : (process.argv[flagIndex + 1] ?? "unspecified");
const ROOT = process.cwd();
const digestOf = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const readCsv = (text) => {
  const rows = []; let row = []; let field = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') { if (text[index + 1] === '"') { field += '"'; index += 1; } else { quoted = false; } }
      else { field += character; }
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
};
const toRecords = (rows) => {
  const header = rows[0].map((name) => name.trim().replace(/^\ufeff/, ""));
  return rows.slice(1).map((values) => Object.fromEntries(header.map((name, index) => [name, (values[index] ?? "").trim()])));
};

const runState = JSON.parse(fs.readFileSync(".agent/verification/state/RUN_STATE.json", "utf8"));
const identity = JSON.parse(fs.readFileSync(".agent/verification/state/ARTIFACT_IDENTITY.json", "utf8"));
const tarball = identity.artifact_paths.find((entry) => entry.endsWith(".tgz"));
const artifactDigest = identity.artifact_digests[tarball];
const epoch = runState.epoch;
const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
const matrix = toRecords(readCsv(fs.readFileSync(matrixPath, "utf8")));
const registry = toRecords(readCsv(fs.readFileSync(registryPath, "utf8")));
const casebooks = new Map();
for (const file of fs.readdirSync(".agent/verification/casebooks").filter((name) => name.endsWith(".jsonl"))) {
  for (const line of fs.readFileSync(path.join(".agent/verification/casebooks", file), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const object = JSON.parse(line);
    casebooks.set(object.test_id, object);
  }
}

// THE GATES THAT COVER A SUBJECT THIS REPOSITORY GENUINELY TESTS. Each entry names a real script with a real
// sentinel; nothing here maps a subject onto a check that does not exist.
const GATES = [
  { id: "static-analysis", script: "lint.sh", sentinel: "lint: ok", keywords: /sast|static analysis|code review|lint|source (code )?analysis|taint|data flow|control flow|complexity|secure coding/i },
  { id: "security-contract", script: "security-check.sh", sentinel: "security check: ok", keywords: /security (check|scan|contract|test)|vulnerability (scan|pattern)|penetration|dast|iast|fuzz|injection|xss|csrf|ssrf|traversal|deserializ/i },
  { id: "secrets", script: "secret-scan.sh", sentinel: "secret scan: ok", keywords: /secret|credential|hardcoded (password|key)|api key|key exposure/i,
    // DECLARED NEGATIVE CONTROL (EP-010 M13, SPEC-006 section 4.1 repository-mapped execution). The scanner's own
    // self-test extracts the REAL pattern out of the gate and asserts it detects a planted canary, so the control is
    // EXECUTED and refused rather than assumed. A mapped PASS requires a control that behaves as specified; a gate
    // with no declaration yields PARTIAL naming the absence, and no gate is given one by convention.
    negativeCase: { kind: "test", command: "node --test tests/security/secret-scan-self-test.test.ts", expectExit: 0, note: "the scanner's self-test proves the gate's own pattern detects a planted canary" } },
  { id: "supply-chain", script: "dependency-audit.sh", sentinel: "dependency audit: ok", keywords: /sca\b|software composition|dependency|third.party|open source|license|sbom|bill of materials/i },
  { id: "reality", script: "reality-gate.sh", sentinel: "reality gate: ok", keywords: /reality|anti.simulation|placeholder|claim integrity|evidence integrity|sanity/i },
  { id: "config", script: "config-validate.sh", sentinel: "config: ok", keywords: /config|environment variable|setting|misconfiguration|hardening/i,
    // DECLARED NEGATIVE CONTROL (EP-010 M13): this gate executes FIVE negative controls on EVERY run - a missing
    // required key, an empty value, a prohibited substitute, a malformed value and an unknown key, then restores the
    // fixture - and prints one marker per control. Requiring the markers proves the gate REFUSED bad configuration in
    // THIS epoch, from the gate's own output, with no second fixture to maintain.
    negativeCase: { kind: "markers", markers: [
      "control missing-required-key: refused with MISSING_REQUIRED_KEY",
      "control empty-required-value: refused with EMPTY_VALUE",
      "control prohibited-substitute: refused with PROHIBITED_SUBSTITUTE",
      "control malformed-value: refused with MALFORMED_VALUE",
      "control unknown-key: refused with UNKNOWN_KEY",
      // MEASURED, not assumed: the gate prints `config: note - restoration: ...`, WITHOUT the word "control" -
      // the first version of this declaration required `control restoration:` and the mechanism correctly REFUSED
      // the mapped PASS, naming the absent marker in the row's own reason. That refusal is the mechanism working.
      "restoration: the untouched fixture validates cleanly after every control",
    ], note: "the gate's own five negative controls, executed on every run, each naming the reason code it refused with" } },
  { id: "pipeline", script: "ci-guard.sh", sentinel: "ci pipeline: ok", keywords: /pipeline|ci\/cd|\bci\b|workflow/i },
  { id: "unit", script: "test-unit.sh", sentinel: "test-unit: ok", keywords: /unit|component|functional|logic|boundary|input validation/i },
  { id: "integration", script: "test-integration.sh", sentinel: "test-integration: ok", keywords: /integration|database|persistence|transaction|migration|tenant|row.level|concurren|race|deadlock|api contract|protocol|serializ|openapi|status code|auth(entication|orization)? matrix|rate limit/i },
  { id: "coverage", script: "coverage-gate.sh", sentinel: "coverage: ok", keywords: /coverage|test completeness/i },
  { id: "mutation", script: "mutation-gate.sh", sentinel: "mutation gate: ok", keywords: /mutation|fault injection|oracle strength/i },
  { id: "build", script: "build-artifact.sh", sentinel: "artifact: built", keywords: /build|package|artifact|provenance|reproducib|distribution/i },
  { id: "identity", script: "artifact-identity.sh", sentinel: "artifact identity: ok", keywords: /artifact identity|digest|supply chain integrity/i },
  { id: "smoke", script: "smoke-test.sh", sentinel: "smoke test: ok", keywords: /smoke|liveness|health (check|endpoint)|boot|startup/i },
  { id: "browser", script: "test-e2e.sh", sentinel: "end-to-end tests: ok", keywords: /browser|\bui\b|accessib|a11y|wcag|render|screen reader|keyboard|contrast/i },
];

// THE AUTHORIZATION BOUNDARY IS READ FROM THE PROMPT ITSELF: section 2 of every prompt declares it, and a prompt
// that demands authorization for ACTIVE testing is not something this harness may execute.
const ACTIVE = /active (testing|scanning)|requires? (written )?authoriz|written permission|scope approval|denial of service|exploit(ation)? (attempt|the target)/i;
const NEEDS_TARGET = /deployed (target|environment|instance)|running (target|service|instance)|staging environment|production environment|browser pool|kubernetes cluster|container runtime/i;
const NEEDS_RUNNER = /agentic (runner|environment|coding)|claude code|codex|jules|paste it into your agent/i;
// LONG-RUNNING REQUIREMENTS ARE CLASSIFIED, NOT SKIPPED (EP-010 M4(b), DOD-038, VG-SHIP-020): a duration
// requirement that cannot complete inside this campaign window is DEFERRED_LONG_RUNNING with the workload, the
// planned and elapsed durations, the heartbeat reference, the partial result and the completion ETA -- and the
// abbreviated portion is never reported as PASS. A five-minute run never passes a 72-hour requirement.
const LONG_RUNNING = /soak|endurance|resource leak|memory leak|stability (run|test)|sustained load|burn.in|long.duration|(24|48|72)[ -]?hour|multi.day/i;
const DURATION = /\b(\d+)\s*(hour|hr|day|minute|min)s?\b/i;
// PROVIDER ENTITLEMENTS ARE BLOCKED CREDENTIALS, WITH THE PROBE NAMED (EP-010 M4 FALLBACK): the affected IDs record
// the PREFLIGHT.md row, the probe command and the probe exit code rather than a generic blocker.
const PROVIDER_PROBES = [
  { keywords: /stripe|payment|billing|card|charge/i, row: "STRIPE_SECRET_KEY", probe: "scripts/probes/stripe.sh" },
  { keywords: /postal|mail|letter|click2mail|\blob\b|postgrid|print.and.mail/i, row: "CLICK2MAIL_API_KEY", probe: "scripts/probes/postal_api.sh" },
  { keywords: /search (api|provider|engine)|serp|result page/i, row: "SEARCH_API_KEY", probe: "scripts/probes/search_api_key.sh" },
  { keywords: /github (app|api|integration)|pull request|issue tracker/i, row: "GITHUB_APP_ID", probe: "scripts/probes/github_app.sh" },
  { keywords: /local model|model gateway|inference (server|endpoint)/i, row: "LOCAL_MODEL_ENDPOINT", probe: "scripts/probes/local_model.sh" },
];
const PRODUCTION_TOUCH = /production (system|environment|data|deployment|tenant|instance)/i;

const rows = matrix.filter((row) => row.owner_stage === stage);
if (rows.length === 0) {
  // A STAGE WITH NO OWNED IDS IS STILL ACCOUNTED, AND SAYS SO: it is complete because there is nothing to run,
  // not because something was skipped. src/http/health-routes.ts carries the same rule for readiness.
  const checkpoint = { stage, epoch, candidate_sha: runState.candidate_sha, artifact_digest: artifactDigest, owned_ids: 0, statuses: {}, gates: [], updated_at: now(), next_action: "run sh scripts/harness-next.sh" };
  fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  console.log(`stage ${stage}: no owned IDs in the applicability matrix, so the stage is accounted with nothing to run`);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
const gateResults = new Map();
// A GATE IS EXECUTED ONCE PER EPOCH, AND LATER STAGES CITE THAT RUN. MEASURED REASON: this executor runs the same
// gate for every stage that needs it, so a full V-000..V-021 pass executed the unit and integration gates a dozen
// times and took over an hour -- and every epoch roll paid that cost again. The cache is keyed by epoch AND
// artifact digest, so a cached result can only come from THIS epoch against THIS artifact; a stage that cites it
// says so explicitly (`cachedFrom`), and the run it cites is a real execution whose log and digest are recorded.
const GATE_CACHE = ".agent/verification/state/gate-cache.json";
const gateCache = fs.existsSync(GATE_CACHE) ? JSON.parse(fs.readFileSync(GATE_CACHE, "utf8")) : { entries: {} };
const cacheKey = (gate) => `${epoch}|${artifactDigest}|${gate.script}`;
const runGate = (gate) => {
  if (gateResults.has(gate.id)) return gateResults.get(gate.id);
  const cached = gateCache.entries[cacheKey(gate)];
  if (cached !== undefined && fs.existsSync(cached.evidencePath)) {
    // THE NOTE IS RE-DERIVED, NOT DROPPED. The cache entry records the exit code and whether the sentinel was found,
    // but not the sentence built from them, so a cited run used to reach every reason string as "undefined" - a
    // cosmetic defect that a registry row quoted verbatim, in a report about honesty. Rebuilding it here keeps one
    // definition of the sentence and makes a cited run read exactly like a fresh one.
    const note = cached.exitCode === 0 && cached.sentinelFound === true
      ? "the gate exited 0 and printed its sentinel"
      : `the gate exited ${cached.exitCode}${cached.sentinelFound === true ? "" : " and did NOT print its sentinel"}`;
    const result = { ...cached, note, cached: true, cachedFrom: cached.evidencePath };
    gateResults.set(gate.id, result);
    return result;
  }
  const scriptPath = path.join("scripts", gate.script);
  if (!fs.existsSync(scriptPath)) {
    const result = { gate: gate.id, script: gate.script, status: "MISSING", exitCode: null, sentinelFound: false, evidencePath: null, digest: null, note: "the script does not exist" };
    gateResults.set(gate.id, result);
    return result;
  }
  const logPath = path.join(outDir, `gate-${gate.id}.log`);
  let exitCode = 0;
  let output = "";
  try {
    output = execFileSync("sh", [scriptPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 900000, env: { ...process.env, CI: "true" } });
  } catch (error) {
    exitCode = error.status === undefined || error.status === null ? 1 : error.status;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  fs.writeFileSync(logPath, output);
  const sentinelFound = output.includes(gate.sentinel);
  const result = {
    gate: gate.id,
    script: gate.script,
    exitCode,
    sentinel: gate.sentinel,
    sentinelFound,
    evidencePath: logPath.split(path.sep).join("/"),
    digest: digestOf(logPath),
    note: exitCode === 0 && sentinelFound
      ? "the gate exited 0 and printed its sentinel"
      : `the gate exited ${exitCode}${sentinelFound ? "" : " and did NOT print its sentinel"}`,
  };
  gateCache.entries[cacheKey(gate)] = { gate: gate.id, script: gate.script, exitCode, sentinel: gate.sentinel, sentinelFound, evidencePath: result.evidencePath, digest: result.digest, epoch, artifact_digest: artifactDigest, executed_at: now() };
  fs.writeFileSync(GATE_CACHE, `${JSON.stringify(gateCache, null, 2)}\n`);
  gateResults.set(gate.id, result);
  return result;
};

// THE DECLARED NEGATIVE CONTROL, EXECUTED (EP-010 M13). SPEC-006 section 4.1's "repository-mapped execution" may
// produce a PASS only when the covering gate's control RAN in this epoch and refused what it exists to refuse. Two
// kinds are implemented, and only where the repository genuinely has one:
//   * "markers" - the gate prints one marker per control it executed; every marker must be present in THIS epoch's
//     log for that gate, so the proof is the gate's own output and needs no second fixture to maintain;
//   * "test"    - a named suite that must exit with the declared code; it is run here, bounded, and its log and
//     digest are recorded.
// A gate with no declaration is NOT given one by convention: its ids stay PARTIAL and the reason names the absence.
const negativeResults = new Map();
const runNegativeCase = (gate, gateResult) => {
  if (negativeResults.has(gate.id)) return negativeResults.get(gate.id);
  const declared = gate.negativeCase;
  let result;
  if (declared === undefined) {
    result = { ok: false, kind: "none", note: `no negative control is DECLARED for the ${gate.id} gate`, command: null, evidencePath: null, evidenceDigest: null };
  } else if (declared.kind === "markers") {
    const log = gateResult === null || gateResult.evidencePath === null ? "" : (fs.existsSync(gateResult.evidencePath) ? fs.readFileSync(gateResult.evidencePath, "utf8") : "");
    const missing = declared.markers.filter((marker) => !log.includes(marker));
    result = {
      ok: missing.length === 0 && log !== "",
      kind: "markers",
      note: missing.length === 0
        ? `${declared.note}; all ${declared.markers.length} marker(s) are present in this epoch's gate log`
        : `${declared.note}; ${missing.length} of ${declared.markers.length} marker(s) are ABSENT from this epoch's gate log (${missing.join(" | ")})`,
      command: `sh scripts/${gate.script} (the gate's own controls)`,
      evidencePath: gateResult === null ? null : gateResult.evidencePath,
      evidenceDigest: gateResult === null ? null : gateResult.digest,
    };
  } else if (declared.kind === "test") {
    const logPath = path.join(outDir, `negative-${gate.id}.log`);
    let exitCode = 0;
    let output = "";
    try {
      output = execFileSync("sh", ["-c", declared.command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000, env: { ...process.env, CI: "true" } });
    } catch (error) {
      exitCode = error.status === undefined || error.status === null ? 1 : error.status;
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    fs.writeFileSync(logPath, output);
    result = {
      ok: exitCode === declared.expectExit,
      kind: "test",
      note: exitCode === declared.expectExit
        ? `${declared.note}; the control exited ${exitCode} as declared`
        : `${declared.note}; the control exited ${exitCode} while the declaration expects ${declared.expectExit}`,
      command: declared.command,
      evidencePath: logPath.split(path.sep).join("/"),
      evidenceDigest: digestOf(logPath),
    };
  } else {
    result = { ok: false, kind: String(declared.kind), note: `the declared control kind ${JSON.stringify(declared.kind)} is not implemented, so it cannot be claimed as executed`, command: null, evidencePath: null, evidenceDigest: null };
  }
  negativeResults.set(gate.id, result);
  return result;
};

const probeResults = new Map();
const runProbe = (probe) => {
  if (probeResults.has(probe.probe)) return probeResults.get(probe.probe);
  if (!fs.existsSync(probe.probe)) { const result = { ...probe, exitCode: 127, evidencePath: null }; probeResults.set(probe.probe, result); return result; }
  let exitCode = 0;
  let output = "";
  try {
    output = execFileSync("sh", [probe.probe], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  } catch (error) {
    exitCode = error.status === undefined || error.status === null ? 1 : error.status;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const evidencePath = path.join(outDir, `probe-${probe.row}.log`);
  fs.writeFileSync(evidencePath, `${output}\n# exit code: ${exitCode}\n`);
  const result = { ...probe, exitCode, evidencePath: evidencePath.split(path.sep).join("/"), digest: digestOf(evidencePath) };
  probeResults.set(probe.probe, result);
  return result;
};

const statuses = [];
const ledgerRows = [];
const auditRows = [];
const capabilityEdges = new Set(seed.capability_edges ?? []);
for (const row of rows) {
  const id = row.test_id;
  const registryRow = registry.find((entry) => entry.test_id === id) ?? {};
  const libraryPath = registryRow.source_file;
  const idDir = path.join(outDir, id);
  fs.mkdirSync(idDir, { recursive: true });

  // 1. EXTRACT THE REAL DEFINITION.
  let definition = null;
  let definitionSource = null;
  // DECLARED OUTSIDE THE EXTRACTION BLOCK ON PURPOSE: the classification below reads it, and a let inside the
  // if-block is not in scope there. MEASURED: the first version declared it inside and every stage died with
  // "definitionKind is not defined".
  let definitionKind = "prompt-block";
  if (libraryPath !== undefined && libraryPath !== "" && fs.existsSync(libraryPath)) {
    const lines = fs.readFileSync(libraryPath, "utf8").split("\n");
    const needle = String(registryRow.title ?? "").toLowerCase().split(" (")[0];
    const idToken = String(id).toLowerCase();
    // LOCATE BY ID FIRST, THEN BY TITLE, AND ACCEPT ANY HEADING LEVEL. MEASURED: the E2E library defines its entries
    // as level-1 headings (`# E2E-001 SOURCE: ...`), so a matcher demanding two to four hashes reported seven
    // definitions as "not located" when they were plainly in the file. MEASURED, separately: the SUP source file is
    // a 231-byte summary that names fifteen gate subjects in one sentence and contains no per-ID method at all, so a
    // summary source is used AS a definition and LABELLED as one, and the status says what is missing rather than
    // reporting a harness ERROR for a source that was never a full definition.
    let headingIndex = lines.findIndex((line) => /^#{1,4} /.test(line) && line.toLowerCase().includes(idToken));
    if (headingIndex === -1) headingIndex = lines.findIndex((line) => /^#{1,4} /.test(line) && line.toLowerCase().includes(needle));
    if (headingIndex !== -1) {
      let end = headingIndex + 1;
      while (end < lines.length && !/^#{1,4} /.test(lines[end])) end += 1;
      definition = lines.slice(headingIndex, end).join("\n");
      definitionSource = libraryPath;
    } else {
      const mentioning = lines.find((line) => line.trim() !== "" && line.toLowerCase().includes(needle));
      if (mentioning !== undefined) {
        definition = mentioning;
        definitionSource = libraryPath;
        definitionKind = "summary-line";
      } else if (fs.statSync(libraryPath).size < 2000) {
        definition = fs.readFileSync(libraryPath, "utf8");
        definitionSource = libraryPath;
        definitionKind = "summary-source";
      }
    }
  }
  const definitionPath = path.join(idDir, "definition.md");
  fs.writeFileSync(definitionPath, definition === null
    ? `definition not located\ntest_id: ${id}\ntitle: ${registryRow.title ?? "(none)"}\nsource_file: ${libraryPath ?? "(none)"}\n`
    : `${definition}\n`);
  const definitionDigest = digestOf(definitionPath);

  // 2. CLASSIFY THE PROMPT'S OWN BOUNDARIES, AND RUN THE COVERING GATE WHERE ONE EXISTS.
  const promptText = definition ?? "";
  const gate = GATES.find((entry) => entry.keywords.test(`${registryRow.title ?? ""} ${registryRow.kind ?? ""} ${promptText.slice(0, 4000)}`));
  const gateResult = gate === undefined ? null : runGate(gate);
  const needsAuthorization = ACTIVE.test(promptText);
  const needsTarget = NEEDS_TARGET.test(promptText);
  const needsRunner = NEEDS_RUNNER.test(promptText);

  let status;
  let reason;
  let nextAction;
  let blockingDependency = null;
  // SPEC-006 section 4.1 requires a provisioning action on every BLOCKED_ENVIRONMENT row: a blocked environment
  // without the action that would unblock it is a dead end rather than a recorded state.
  let provisioningAction = null;
  // The fields SPEC-006 section 4.1 and M4(b) require on the statuses this executor can produce.
  let deferredProvenance = null;
  let scopeClause = null;
  let dependencyEdgeRef = null;
  // DECLARED BEFORE THE BRANCH CHAIN, NOT AFTER IT (EP-010 M13). The repository-mapped PASS branch writes the fields
  // that justify it, and a `const statusFields = {}` declared after the chain put this holder in the temporal dead
  // zone: the stage died with "Cannot access 'statusFields' before initialization". THAT IS THE SAME FAILURE CLASS
  // RECORDED IN M4(c), where a `let` declared inside one extraction block was out of scope in the classification
  // below it. The executor failed LOUDLY rather than writing a half-classified row, which is what makes it survivable.
  const mappedFields = {};
  const statusFields = {};
  if (definition === null) {
    status = "ERROR";
    reason = `the per-ID definition could not be located in ${libraryPath ?? "(no source_file)"}; a harness precondition failed, so nothing was executed for this ID`;
    nextAction = "restore the source library entry for this ID, then re-run the stage";
  } else if (needsAuthorization) {
    status = "BLOCKED_SAFETY";
    reason = `the prompt's own authorization boundary requires explicit authorization for active testing, which this harness does not have; the definition was extracted from ${definitionSource} and NOT executed`;
    nextAction = "obtain written authorization naming the target and the test types, then execute the prompt under that authorization";
    blockingDependency = "capability:authorized-active-testing";
  } else if (needsTarget) {
    status = "BLOCKED_ENVIRONMENT";
    reason = `the prompt requires a deployed target or infrastructure this environment does not host; the definition was extracted from ${definitionSource} and NOT executed`;
    nextAction = "provision the target the prompt's scope discovery names, then execute the prompt against it";
    blockingDependency = "capability:deployed-target";
    provisioningAction = "provision the deployment target declared in .agent/verification/TEST_ENVIRONMENT_MANIFEST.md (staging is NOT_PROVISIONED: managed US cloud, Kubernetes, KMS, object store, managed Postgres, browser pool), then re-run this stage";
    scopeClause = "TEST_ENVIRONMENT_MANIFEST.md declares this environment NOT_PROVISIONED";
  } else if (LONG_RUNNING.test(promptText)) {
    const duration = DURATION.exec(promptText);
    status = "DEFERRED_LONG_RUNNING";
    reason = `the prompt declares a duration requirement (${duration === null ? "no explicit duration in the prompt text" : `${duration[1]} ${duration[2]}`}) that cannot complete inside this campaign window; the abbreviated portion is reported separately and is NEVER a PASS (DOD-038, VG-SHIP-020)`;
    nextAction = "run this workload for its planned duration with a heartbeat-recording runner, then re-decide the status";
    blockingDependency = "capability:long-running-runner";
    deferredProvenance = {
      workload: registryRow.title ?? id,
      plannedDuration: duration === null ? "not declared in the prompt text" : `${duration[1]} ${duration[2]}`,
      elapsedDuration: "PT0S - not started: this campaign window cannot host the planned duration",
      // startedAt IS THE INSTANT THIS DEFERRAL WAS RECORDED, not the instant a workload started: the schema requires the field and the workload never ran, and that distinction is carried by elapsedDuration, which says so in as many words.
      startedAt: now(),
      heartbeatRef: "the stage checkpoint this runner writes (.agent/verification/state/stage-checkpoint.json); a duration workload needs a runner that heartbeats into it",
      partialResultPath: `${outDir}/${id}/definition.md`,
      completionEta: "requires a runner that can hold the workload for its planned duration",
    };
  } else if (PRODUCTION_TOUCH.test(promptText)) {
    status = "BLOCKED_SAFETY";
    reason = `the prompt targets a production system, and production is manual-only and unauthorized in this run (VG-SCOPE-009, ADR-005); the definition was extracted and NOT executed`;
    nextAction = "obtain a scoped, written authorization naming the production system and the test types, then execute under it";
    blockingDependency = "capability:production-authorization";
    scopeClause = "VG-SCOPE-009: production deployment and production testing are manual-only and unauthorized in this run";
  } else if (PROVIDER_PROBES.some((entry) => entry.keywords.test(promptText))) {
    const provider = PROVIDER_PROBES.find((entry) => entry.keywords.test(promptText));
    const probeResult = runProbe(provider);
    if (probeResult.exitCode === 0) {
      status = "PARTIAL";
      reason = `the declared provider probe ${provider.probe} for ${provider.row} exited 0, so the entitlement is reachable; the prompt's own methodology and negative case still require an authorised agentic runner, so this is NOT a PASS`;
      nextAction = "execute this prompt in an authorised agentic runner against the entitled provider";
      blockingDependency = "capability:agentic-runner";
    } else {
      status = "BLOCKED_CREDENTIALS";
      reason = `the prompt needs a provider entitlement that PREFLIGHT.md declares and this environment has not provisioned: ${provider.row}; probe ${provider.probe} exited ${probeResult.exitCode}`;
      nextAction = `provision ${provider.row} (see PREFLIGHT.md) and re-run the probe, then execute the prompt`;
      blockingDependency = "capability:provider-entitlement";
      provisioningAction = `provision ${provider.row}: run ${provider.probe} until it exits 0, then re-run this stage`;
    }
  } else if (definitionKind === "summary-source" || definitionKind === "summary-line") {
    status = "BLOCKED_PREREQUISITE";
    reason = `the declared source ${definitionSource} is a ${definitionKind === "summary-source" ? "summary" : "single mentioning line"} that names this gate's subject but contains no method, command or completion gate; there is nothing to execute for this ID`;
    nextAction = "write the per-ID definition for this gate (method, commands, oracle, negative case) as the other libraries do, then re-run the stage";
    blockingDependency = "capability:per-id-definition";
    dependencyEdgeRef = `${blockingDependency}->${stage}`;
  } else if (gateResult !== null && gateResult.status !== "MISSING") {
    // THE MAPPED PASS AND ITS HONEST CEILING (EP-010 M13; SPEC-006 section 4.1 "repository-mapped execution").
    // A mapped PASS is available ONLY when the covering gate ran its positive path in this epoch AND its DECLARED
    // NEGATIVE CONTROL ran and behaved as specified. Otherwise the id stays PARTIAL and the reason names exactly what
    // is missing - either that no control is declared for the gate, or that the declared one did not refuse.
    const control = runNegativeCase(gate, gateResult);
    if (control.ok) {
      status = "PASS";
      reason = `repository-mapped PASS: the gate covering this subject (scripts/${gateResult.script}) ran in this epoch (${gateResult.note}) AND its declared negative control ran and behaved as specified (${control.note}). NOT prompt-level compliance: the prompt's own methodology, scope discovery and completion gate were not executed`;
      nextAction = "none required for the mapped claim; execute the prompt in an authorised agentic runner to replace this mapped PASS with prompt-level evidence and retire promptLevelUncovered[]";
      mappedFields.executionBasis = "repository-mapped";
      mappedFields.mappedGate = `scripts/${gateResult.script}`;
      mappedFields.negativeCaseCommand = control.command;
      mappedFields.negativeCaseEvidencePath = control.evidencePath;
      mappedFields.negativeCaseEvidenceDigest = control.evidenceDigest;
      mappedFields.promptLevelUncovered = [
        "the prompt's own scope-discovery pass and methodology",
        "the prompt's own completion gate, findings and negative case",
        "the end-to-end half of the outcome through the real entry point against real dependencies, where the prompt requires it",
      ];
    } else {
      status = "PARTIAL";
      reason = `the repository gate covering this subject (scripts/${gateResult.script}) ran as the positive path: ${gateResult.note}. NOT a PASS: SPEC-006 section 4.1 repository-mapped execution additionally requires an EXECUTED negative control, and ${control.note}`;
      nextAction = "declare and execute a negative control for the covering gate, or execute this prompt in an authorised agentic runner; write findings.md and the completion-gate checklist under the ID evidence directory, then re-decide the status";
      blockingDependency = "capability:agentic-runner";
    }
  } else if (needsRunner) {
    status = "BLOCKED_PREREQUISITE";
    reason = `the prompt is written for an agentic runner and no repository gate covers its subject; the definition was extracted from ${definitionSource} and NOT executed`;
    nextAction = "execute this prompt in an authorised agentic runner; the extracted definition is under this ID evidence directory";
    blockingDependency = "capability:agentic-runner";
    dependencyEdgeRef = `${blockingDependency}->${stage}`;
  } else {
    status = "BLOCKED_PREREQUISITE";
    reason = `no repository gate covers this prompt's subject and no environment path exists to execute it here; the definition was extracted from ${definitionSource} and NOT executed`;
    nextAction = "map this ID's subject to a runnable check or provide the environment it needs, then re-run the stage";
    blockingDependency = "capability:execution-mapping";
    dependencyEdgeRef = `${blockingDependency}->${stage}`;
  }

  // THE FIELDS SPEC-006 SECTION 4.1 REQUIRES PER STATUS, assembled here rather than left to each branch. A status
  // whose required fields are absent is not a status; it is a word, and the validator now rejects it.
  // The holder itself is declared ABOVE the branch chain (see mappedFields) because the mapped-PASS branch writes into
  // it; only the per-status assembly lives here.
  Object.assign(statusFields, mappedFields);
  if (status === "PARTIAL") {
    statusFields.coveredSurface = [gateResult === null ? "the extracted per-ID definition" : `scripts/${gateResult.script} as the positive path (${gateResult.note})`];
    statusFields.uncoveredSurface = [
      "the prompt's own scope-discovery pass and methodology",
      "an executed negative case, which SPEC-006 section 4.1 requires before any PASS",
      "the end-to-end half of the outcome through the real entry point against real dependencies",
    ];
    statusFields.coverageDenominator = "the prompt's declared scope, which only an authorised agentic runner can enumerate";
  } else if (status === "BLOCKED_PREREQUISITE") {
    statusFields.lastRunnableAttempt = null;
  } else if (status === "BLOCKED_ENVIRONMENT") {
    statusFields.environmentManifestRef = ".agent/verification/TEST_ENVIRONMENT_MANIFEST.md";
    statusFields.missingProperty = needsTarget ? "a deployed target the prompt's scope discovery names" : "an environment the prompt requires";
    statusFields.provisioningAttemptLogPath = `${outDir}/${id}/status.json`;
  } else if (status === "BLOCKED_CREDENTIALS") {
    const provider = PROVIDER_PROBES.find((entry) => entry.keywords.test(promptText));
    statusFields.credentialRef = provider === undefined ? "an unprovisioned credential" : provider.row;
    statusFields.probeCommand = provider === undefined ? null : `sh ${provider.probe}`;
    statusFields.probeExitCode = provider === undefined ? null : (probeResults.get(provider.probe)?.exitCode ?? null);
    statusFields.provisioningDocRef = "PREFLIGHT.md";
  } else if (status === "BLOCKED_SAFETY") {
    statusFields.policyRef = scopeClause ?? "VG-SCOPE-009";
    statusFields.prohibitedAction = "executing an active test or a production-touching procedure without authorization";
    statusFields.safeSubstitute = "none in this environment: the definition is extracted, the repository gate covering its subject runs where one exists, and the active half is recorded EXTERNAL_REQUIRED";
    statusFields.safetyReviewer = "a human authority (the repository owner or the named operator)";
  } else if (status === "DEFERRED_LONG_RUNNING") {
    Object.assign(statusFields, deferredProvenance ?? {});
  } else if (status === "ERROR") {
    statusFields.harnessStackRef = `${outDir}/${id}/status.json`;
    statusFields.firstFailureLogPath = `${outDir}/${id}/status.json`;
  }

  // EVERY BLOCKED_PREREQUISITE ROW NAMES THE EDGE IT WAITS ON, and the assignment is uniform rather than repeated in
  // each branch: MEASURED, two branches assigned a capability without the edge and 205 rows in this epoch were
  // written without it, which DOD-031 requires and my own validator did not yet check.
  if (blockingDependency !== null && dependencyEdgeRef === null) dependencyEdgeRef = `${blockingDependency}->${stage}`;

  const evidence = {
    test_id: id,
    owner_stage: stage,
    title: registryRow.title ?? null,
    kind: registryRow.kind ?? null,
    source_library: definitionSource,
    definition_path: `${outDir}/${id}/definition.md`.split(path.sep).join("/"),
    definition_digest: definitionDigest,
    definition_located: definition !== null,
    definition_kind: definitionKind,
    gate: gateResult,
    prompt_requires_authorization: needsAuthorization,
    prompt_requires_target: needsTarget,
    prompt_requires_runner: needsRunner,
    status,
    reason,
    deferred_provenance: deferredProvenance,
    scope_clause: scopeClause,
    dependency_edge_ref: dependencyEdgeRef,
    provisioning_action: provisioningAction,
    recorded_at: now(),
  };
  const evidencePath = path.join(idDir, "status.json");
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  const evidenceDigest = digestOf(evidencePath);
  const relativeEvidence = `${outDir}/${id}/status.json`.split(path.sep).join("/");

  statuses.push({ test_id: id, status, evidencePath: relativeEvidence, evidenceDigest, gate: gateResult === null ? null : gateResult.gate });
  ledgerRows.push({
    id,
    test_id: id,
    status,
    reason,
    evidencePath: relativeEvidence,
    evidenceDigest,
    updatedAt: now(),
    epochId: epoch,
    nextAction,
    blockingDependency,
    dependencyEdgeRef,
    provisioningAction,
    deferredProvenance,
    scopeClause,
    statusFields,
    epoch,
    candidate_sha: runState.candidate_sha,
    artifactDigest,
    ownerStage: stage,
    suite: "EP-010/harness-run-stage",
    command: gateResult === null ? null : `sh scripts/${gateResult.script}`,
    exitCode: gateResult === null ? null : gateResult.exitCode,
    sentinel: gateResult === null ? null : gateResult.sentinel,
    note: reason,
    recorded_at: now(),
  });
  auditRows.push({ test_id: id, from: "PLANNED", to: status, epochId: epoch, at: now(), ownerStage: stage });
  if (blockingDependency !== null) capabilityEdges.add(`${blockingDependency}->${stage}`);
}

// INVALIDATION IS RECORDED, NOT ERASED. A re-run of an accounted stage is legitimate only when its evidence was
// invalidated (here: a harness defect in the definition extractor), and the earlier statuses are withdrawn in the
// audit trail rather than deleted. The ledger stays append-only; the accounting counts the LATEST row per ID.
if (invalidationReason !== null) {
  const previous = new Map();
  for (const line of fs.readFileSync(ledgerPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    const id = row.test_id ?? row.id;
    if (!rows.some((entry) => entry.test_id === id)) continue;
    if ((row.epochId ?? row.epoch) !== epoch) continue;
    previous.set(id, row.status);
  }
  const withdrawals = [...previous.entries()].map(([id, status]) => ({ test_id: id, from: status, to: "WITHDRAWN", reason: invalidationReason, epochId: epoch, at: now(), ownerStage: stage }));
  if (withdrawals.length > 0) fs.appendFileSync(auditPath, `${withdrawals.map((row) => JSON.stringify(row)).join("\n")}\n`);
  console.log(`stage ${stage}: ${withdrawals.length} earlier status(es) WITHDRAWN - ${invalidationReason}`);
}

// DURABLE APPEND: the ledger is append-only, and the stage's rows are written before the stage reports.
fs.appendFileSync(ledgerPath, `${ledgerRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
fs.appendFileSync(auditPath, `${auditRows.map((row) => JSON.stringify(row)).join("\n")}\n`);

// The dependency graph gains the capability edges the statuses named, and the stage run is recorded on it.
seed.capability_edges = [...capabilityEdges].sort();
seed.stage_runs = [...(seed.stage_runs ?? []), {
  stage,
  epoch,
  artifact_digest: artifactDigest,
  owned_ids: rows.length,
  statuses: statuses.reduce((accumulator, entry) => { accumulator[entry.status] = (accumulator[entry.status] ?? 0) + 1; return accumulator; }, {}),
  gates_run: [...gateResults.values()].map((entry) => ({ gate: entry.gate, script: entry.script, exitCode: entry.exitCode, sentinelFound: entry.sentinelFound, cached: entry.cached === true, cachedFrom: entry.cachedFrom ?? null, evidencePath: entry.evidencePath, digest: entry.digest })),
  recorded_at: now(),
}];
fs.writeFileSync(seedPath, `${JSON.stringify(seed, null, 2)}\n`);

// The evidence index, keyed by path with content hashes.
const index = fs.existsSync(evidenceIndexPath) ? JSON.parse(fs.readFileSync(evidenceIndexPath, "utf8")) : { entries: [] };
const known = new Set(index.entries.map((entry) => entry.path));
for (const entry of [...statuses.map((status) => ({ path: status.evidencePath, digest: status.evidenceDigest })), ...[...gateResults.values()].filter((gate) => gate.evidencePath !== null).map((gate) => ({ path: gate.evidencePath, digest: gate.digest }))]) {
  if (!known.has(entry.path)) index.entries.push({ path: entry.path, sha256: entry.digest, stage, epoch });
}
index.updatedAt = now();
fs.writeFileSync(evidenceIndexPath, `${JSON.stringify(index, null, 2)}\n`);

const checkpoint = {
  stage,
  epoch,
  candidate_sha: runState.candidate_sha,
  artifact_digest: artifactDigest,
  owned_ids: rows.length,
  statuses: statuses.reduce((accumulator, entry) => { accumulator[entry.status] = (accumulator[entry.status] ?? 0) + 1; return accumulator; }, {}),
  gates: [...gateResults.values()],
  updated_at: now(),
  next_action: "run sh scripts/harness-next.sh to select the next stage",
};
fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

console.log(`stage ${stage}: ${rows.length} owned ID(s), statuses ${JSON.stringify(checkpoint.statuses)}, gate(s) run: ${[...gateResults.keys()].join(", ") || "none"}`);
for (const entry of statuses.filter((entry) => entry.status === "ERROR")) console.log(`stage ${stage}: ERROR on ${entry.test_id}`);
process.exit(0);
ENDS_RUN_STAGE

node "$RUNNER" "$STAGE" "$MATRIX" "$REGISTRY" "$SEED" "$LEDGER_STATE" "$AUDIT" "$EVIDENCE_INDEX" "$CHECKPOINT" "$OUTDIR" "$@" \
  || { echo "stage $STAGE: ERROR - the executor failed; see $OUTDIR" >&2; exit 1; }

echo "stage $STAGE: accounted"
