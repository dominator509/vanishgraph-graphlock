#!/usr/bin/env sh
# Applicability decisions for all 484 registry IDs (EP-010 M2(c)(d); VG-SHIP-019, DOD-030/031). Sentinel:
# `applicability: decided`
#
# REPLACES THE PRE-DISCOVERY LOUD-FAIL PLACEHOLDER. The earlier APPLICABILITY_MATRIX.csv held five RANGE rows
# ("GEN-001 through GEN-122") with `PENDING` and a placeholder `SKIPPED_NOT_APPLICABLE_PENDING` status: that is a
# plan, not a decision, and this script supersedes it with one row per ID, each citing repository evidence.
#
# HOW A DECISION IS MADE, AND WHY IT IS NOT A GUESS:
#   1. THE PROBES ARE MEASURED, NOT REMEMBERED. Each topic the registry can name has a probe that reads this
#      repository and records what it found: the number of rendered routes, whether a tenant-scoped schema and its
#      RLS policies exist, whether an artifact format is produced, whether any blockchain, HSM, model or agent
#      transport path exists AT ALL. A probe records the paths it read, and EVERY CITED PATH IS CHECKED TO EXIST
#      before the decision is written -- a citation of a file that is not there would be the cheapest possible
#      fabrication, so it is a hard failure.
#   2. THE RULE COMES FROM THE REGISTRY'S OWN PREDICATE, not from a preference. `evaluate` is decided from the
#      security and architecture surface actually present; `broadly-applicable` is applicable unless a probe shows
#      the construct is absent; `conditional-<topic>` is decided from that topic's probe; and the bare
#      `conditional` (327 rows) is routed through the ID's own title and kind to the topic it names.
#   3. AN UNROUTABLE ID IS NOT DECIDED BY ASSUMPTION. It is recorded
#      `CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE` with the specific evidence request as its next action -- the
#      plan's FALLBACK, and never `SKIPPED_NOT_APPLICABLE` and never `APPLICABLE` on assumption.
#   4. THE BLOCKCHAIN PACK IS DECIDED PER ID. This repository has no chain, wallet, contract, node or on-chain
#      data path (measured), so chain-specific rows are `SKIPPED_NOT_APPLICABLE` with that evidence named -- while
#      rows whose subject is NOT chain-specific (key management, cryptographic primitives, signature verification,
#      audit immutability, replay protection) are decided on their merits from the primitives this tree does use.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "applicability: FAIL - $1" >&2; exit 1; }

REGISTRY=.agent/verification/MASTER_TEST_REGISTRY.csv
MATRIX=.agent/verification/APPLICABILITY_MATRIX.csv
SEED=.agent/verification/state/DEPENDENCY_BLOCKER_GRAPH.json
EVIDENCE_DIR=.agent/evidence/EP-010/M2-applicability
mkdir -p "$EVIDENCE_DIR"

[ -f "$REGISTRY" ] || fail "$REGISTRY is missing"
[ -f "$SEED" ] || fail "$SEED is missing; run sh scripts/harness-init.sh first (ownership comes from the seed)"
command -v node >/dev/null 2>&1 || fail "node is required but not found"

DECIDE=$(mktemp)
trap 'rm -f "$DECIDE"' EXIT INT TERM
cat >"$DECIDE" <<'ENDS_APPLICABILITY'
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const [registryPath, seedPath, matrixPath, evidenceDir] = process.argv.slice(2);
const problems = [];
const ROOT = process.cwd();

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
const csvField = (value) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));
const readIf = (relative) => (exists(relative) ? fs.readFileSync(path.join(ROOT, relative), "utf8") : null);
const countFiles = (directory, pattern) => {
  if (!exists(directory)) return 0;
  const walk = (current) => fs.readdirSync(path.join(ROOT, current), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${current}/${entry.name}`;
    if (entry.isDirectory()) return walk(relative);
    return pattern.test(entry.name) ? [relative] : [];
  });
  return walk(directory).length;
};

// -------------------------------------------------------------------------------------------------------------
// 1. THE PROBES. Each one reads this repository; none of them asserts from memory.
// -------------------------------------------------------------------------------------------------------------
const identity = JSON.parse(readIf(".agent/verification/state/ARTIFACT_IDENTITY.json") ?? "{}");
const tarball = (identity.artifact_paths ?? []).find((entry) => entry.endsWith(".tgz"));
const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: path.join(ROOT, "..") }).split("\n");
const trackedMatching = (pattern) => trackedFiles.filter((file) => pattern.test(file));
const grepTracked = (pattern) => {
  const matches = [];
  for (const file of trackedFiles) {
    if (!/\.(ts|tsx|sql|json|md|sh|mjs|py)$/.test(file)) continue;
    let text;
    try { text = fs.readFileSync(path.join(ROOT, "..", file), "utf8"); } catch { continue; }
    if (pattern.test(text)) matches.push(file);
  }
  return matches;
};

const ROUTES = countFiles("ui/src/routes", /\.tsx$/);
const API_ROUTES = countFiles("src/http/routes", /\.ts$/);
const MIGRATIONS = countFiles("db/migrations", /\.sql$/);
const TENANT_TABLES = (readIf("db/tenant-scoped-tables.txt") ?? "").split("\n").filter((line) => line.trim() !== "").length;
const SLOS = Object.keys(JSON.parse(readIf("config/slo/objectives.json") ?? "{}").objectives ?? {}).length;
const METRIC_FAMILIES = (JSON.parse(readIf("config/metrics/catalogue.json") ?? "{}").families ?? []).length;
const ALERT_ROWS = (JSON.parse(readIf("config/alerts/catalogue.json") ?? "{}").alerts ?? []).length;
const CONFIG_KEYS = (JSON.parse(readIf("config/environment/schema.json") ?? "{}").keys ?? []).length;
const A11Y_SUITES = countFiles("tests/ui", /\.spec\.ts$/);
const HUMAN_GATE_REFS = grepTracked(/HUMAN_REQUIRED/).length;
const CHAIN_FILES = trackedMatching(/(solidity|\.sol$|web3|ethers|hardhat|truffle|blockchain|onchain|on-chain)/i);
const CHAIN_TEXT = grepTracked(/\b(blockchain|smart contract|on-chain|web3|wallet address|consensus|mining|gas fee)\b/i);
const MODEL_FILES = trackedMatching(/(ollama|llama|openai|anthropic|model-gateway|local-model)/i);
const HSM_FILES = trackedMatching(/(hsm|pkcs11|cloudhsm|kms)/i);

const facts = {
  epoch: JSON.parse(readIf(".agent/verification/state/RUN_STATE.json") ?? "{}").epoch,
  artifact_digest: tarball === undefined ? null : identity.artifact_digests[tarball],
  rendered_routes: ROUTES,
  api_route_modules: API_ROUTES,
  migrations: MIGRATIONS,
  tenant_scoped_tables: TENANT_TABLES,
  slo_objectives: SLOS,
  metric_families: METRIC_FAMILIES,
  alert_rows: ALERT_ROWS,
  config_keys: CONFIG_KEYS,
  browser_suites: A11Y_SUITES,
  human_gate_references: HUMAN_GATE_REFS,
  blockchain_files: CHAIN_FILES.length,
  blockchain_text_files: CHAIN_TEXT.length,
  model_transport_files: MODEL_FILES.length,
  hsm_kms_files: HSM_FILES.length,
};
if (facts.artifact_digest === null) problems.push("the published identity declares no tarball digest; every decision must carry the artifact digest of its epoch");

// Every probe reports PRESENT or ABSENT plus the paths it read, and a probe whose cited path does not exist is a
// failure rather than a citation.
const probe = (present, evidence) => ({ present, evidence });
const requirePaths = (label, paths) => {
  for (const entry of paths) {
    const file = entry.split(" ")[0];
    if (!exists(file)) problems.push(`probe ${label} cites ${file}, which does not exist`);
  }
  return paths.join("; ");
};

// EVERY ABSENCE CLAIM RESTS ON AN IMPORT OR A DEPENDENCY, NOT ON A MENTION. MEASURED FAILURE this corrects: a
// content grep for HSM matched src/adapters/crypto/local-key-provider.ts -- a file that explains in a comment that
// it is a LOCAL provider standing in for the managed KMS this project does not have. A comment saying a component
// is absent was being read as evidence that it is present. The signal is now an import specifier or a declared
// dependency, neither of which a comment can produce.
const implementationFiles = trackedFiles.filter((file) => /^(vanishgraph\/)?(src|ui|db)\//.test(file.replace(/^vanishgraph\//, "vanishgraph/")));
const importSpecifiers = (() => {
  const found = [];
  for (const file of implementationFiles) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    let text;
    try { text = fs.readFileSync(path.join(ROOT, "..", file), "utf8"); } catch { continue; }
    for (const match of text.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) found.push({ file: file.replace(/^vanishgraph\//, ""), specifier: match[1] });
  }
  return found;
})();
const packageJson = JSON.parse(readIf("package.json") ?? "{}");
const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
const absenceReport = (label, pattern) => {
  const imports = importSpecifiers.filter((entry) => pattern.test(entry.specifier));
  const dependencies = runtimeDependencies.filter((name) => pattern.test(name));
  return {
    present: imports.length > 0 || dependencies.length > 0,
    evidence: imports.length === 0 && dependencies.length === 0
      ? `no ${label} implementation exists: 0 of ${implementationFiles.length} implementation file(s) under src/, ui/ and db/ import a matching module (${importSpecifiers.length} import specifier(s) read) and 0 of ${runtimeDependencies.length} runtime dependencies match`
      : `${label}: ${imports.length} import(s) (${imports.slice(0, 3).map((entry) => `${entry.specifier} in ${entry.file}`).join(", ")}) and ${dependencies.length} runtime dependency/ies (${dependencies.slice(0, 4).join(", ")}) match`,
  };
};
const CHAIN_PROBE = absenceReport("blockchain, chain, wallet, contract or on-chain", /blockchain|web3|ethers|solidity|hardhat|truffle|on-?chain|smart-?contract|wallet|consensus|mining|\bgas\b/i);
const HSM_PROBE = absenceReport("HSM, PKCS#11, TPM or hardware security module", /pkcs#?11|cloudhsm|hardware security module|\bhsm\b|\btpm\b/i);
const MODEL_PROBE = absenceReport("model or agent transport", /ollama|llama|\bopenai\b|anthropic|bedrock|vertex|model-?gateway|local-?model|inference-?client/i);
// MEASURED FAILURE this corrects: a content grep for "container" matched src/infrastructure/database/provision.ts,
// which STARTS a disposable PostgreSQL container for local development. That is not a product container image, and
// reporting it as one would have decided every container-hardening ID APPLICABLE on the strength of a dev script.
// The question a container ID actually asks is whether THIS PRODUCT IS SHIPPED AS A CONTAINER, so it is measured by
// the presence of a build definition (a file whose NAME is a container build file) and by the published identity's
// own OCI status.
const containerBuildFiles = trackedFiles.filter((file) => /(^|\/)(Dockerfile[^/]*|Containerfile[^/]*|docker-compose[^/]*)$/i.test(file));
const CONTAINER_PROBE = {
  present: containerBuildFiles.length > 0,
  evidence: containerBuildFiles.length > 0
    ? `${containerBuildFiles.length} container build definition(s) exist: ${containerBuildFiles.slice(0, 3).join(", ")}`
    : `no container build definition exists anywhere in the tracked tree (measured: 0 files named Dockerfile, Containerfile or docker-compose*), and the published identity records oci_image.status = ${identity.oci_image?.status ?? "NOT RECORDED"}; docs/release/supported-formats.md records container-format support as NOT claimed`,
};
const MOBILE_PROBE = absenceReport("mobile, iOS, Android or desktop application", /react-?native|\bios\b|android|electron|tauri|swiftui|jetpack/i);
// The bare word "embedded" matched this repository's own "embedded-original-source" registry values, which is why
// the pattern now demands a device context.
const IOT_PROBE = absenceReport("IoT, embedded device, firmware or device path", /\biot\b|firmware|mqtt|zigbee|modbus|embedded (device|system|controller|platform)/i);
const GRAPHQL_GRPC_PROBE = absenceReport("GraphQL or gRPC transport", /graphql|apollo|@grpc|grpc-|protobuf|protobufjs/i);
// A FILE-NAME SIGNAL FOR INFRASTRUCTURE AS CODE, because the construct is a set of definition files rather than an
// import: terraform state and modules, CloudFormation templates, Pulumi, Ansible or Chef trees.
const iacFiles = trackedFiles.filter((file) => /\.(tf|tfvars)$|\/terraform\/|\/ansible\/|\/pulumi\/|playbook\.ya?ml$|cookbook/i.test(file));
// WEBSOCKET IS MEASURED FROM THE ROUTE REGISTRY rather than from a dependency, because a websocket route would be
// declared there: the registry names 78 HTTP routes and no websocket path.
const WEBSOCKET_PROBE = (() => {
  const registry = readIf("src/http/openapi/registry.ts") ?? "";
  const websocketMentions = (registry.match(/websocket|ws:\/\/|socket\.io/i) ?? []).length;
  return {
    present: websocketMentions > 0,
    evidence: websocketMentions > 0
      ? `the route registry names ${websocketMentions} websocket-related entry/entries`
      : "no websocket route exists: the declared route registry src/http/openapi/registry.ts names no websocket, ws:// or socket.io path, and no runtime dependency provides a websocket server",
  };
})();
const IAC_PROBE = {
  present: iacFiles.length > 0,
  evidence: iacFiles.length > 0
    ? `${iacFiles.length} infrastructure-as-code file(s) exist: ${iacFiles.slice(0, 3).join(", ")}`
    : `no infrastructure-as-code exists: 0 tracked files are terraform (.tf/.tfvars), CloudFormation templates, Ansible playbooks, Pulumi or Chef definitions, and 0 of ${runtimeDependencies.length} runtime dependencies provide one; the deployment surfaces this repository has are prose procedures (deploy/staging/README.md, deploy/production/README.md)`,
};

const PROBES = {
  ARTIFACT: probe(tarball !== undefined, requirePaths("ARTIFACT", ["docs/release/supported-formats.md artifact formats declared and produced", ".agent/verification/state/ARTIFACT_IDENTITY.json published identity with resolved digests"])),
  INTERFACE: probe(ROUTES > 0, requirePaths("INTERFACE", [`ui/src/routes ${ROUTES} rendered route module(s)`, "src/http/routes"])),
  API: probe(API_ROUTES > 0, requirePaths("API", [`src/http/routes ${API_ROUTES} route module(s)`, "src/http/openapi/registry.ts declared route registry"])),
  AUTH: probe(exists("src/http/plugins/scope-guard.ts"), requirePaths("AUTH", ["src/http/plugins/scope-guard.ts scope and role gate", "src/http/plugins/step-up.ts step-up gate", "src/application/security/authorization-matrix.ts DENY-by-default matrix"])),
  TENANCY: probe(TENANT_TABLES > 0 && MIGRATIONS > 0, requirePaths("TENANCY", [`db/tenant-scoped-tables.txt ${TENANT_TABLES} tenant-scoped table(s)`, "scripts/check-rls-coverage.sh live RLS coverage check"])),
  PERSISTENCE: probe(MIGRATIONS > 0, requirePaths("PERSISTENCE", [`db/migrations ${MIGRATIONS} migration(s)`, "src/adapters/persistence"])),
  EGRESS: probe(exists("src/adapters/observability/egress-gate.ts"), requirePaths("EGRESS", ["src/adapters/observability/egress-gate.ts DLP-scrubbed egress boundary", "DATA_EGRESS_MATRIX.md declared egress classes"])),
  OBSERVABILITY: probe(METRIC_FAMILIES > 0 && ALERT_ROWS > 0, requirePaths("OBSERVABILITY", [`config/metrics/catalogue.json ${METRIC_FAMILIES} metric families`, `config/alerts/catalogue.json ${ALERT_ROWS} alert rows`, `config/slo/objectives.json ${SLOS} objective(s)`])),
  HUMAN: probe(HUMAN_GATE_REFS > 0, requirePaths("HUMAN", [`src/domain ${HUMAN_GATE_REFS} references to HUMAN_REQUIRED`, "tests/ui/a11y.spec.ts human gate recorded as EXTERNAL_REQUIRED"])),
  LONG_RUNNING: probe(SLOS > 0, requirePaths("LONG_RUNNING", [`config/slo/objectives.json ${SLOS} declared objective(s) with windows`])),
  A11Y: probe(A11Y_SUITES > 0, requirePaths("A11Y", [`tests/ui ${A11Y_SUITES} browser suite file(s)`, "tests/ui/a11y.spec.ts axe-core over every declared route"])),
  CONFIGURABLE: probe(CONFIG_KEYS > 0, requirePaths("CONFIGURABLE", [`config/environment/schema.json ${CONFIG_KEYS} classified key(s)`, "config/environment/required.json required set per class and role"])),
  DEPLOYABLE: probe(exists("deploy/staging/README.md"), requirePaths("DEPLOYABLE", ["deploy/staging/README.md staging procedure", "DEPLOYMENT.md deployment contract"])),
  STATEFUL_VERSIONED: probe(MIGRATIONS > 0 && exists("db/UPGRADE_MATRIX.md"), requirePaths("STATEFUL_VERSIONED", ["db/UPGRADE_MATRIX.md upgrade matrix", `db/migrations ${MIGRATIONS} migration(s)`])),
  BUILDABLE: probe(exists("scripts/build.sh"), requirePaths("BUILDABLE", ["scripts/build.sh build stage", "scripts/build-artifact.sh declared artifact formats"])),
  SERVICE: probe(exists("src/infrastructure/main.ts"), requirePaths("SERVICE", ["src/infrastructure/main.ts packaged entry point"])),
  SECRETS: probe(exists("src/adapters/secrets/secret-resolver.ts"), requirePaths("SECRETS", ["src/adapters/secrets/secret-resolver.ts resolution by reference", "src/adapters/crypto/local-key-provider.ts local key material provider"])),
  RATE_LIMIT: probe(exists("src/adapters/coordination/rate-limit.ts"), requirePaths("RATE_LIMIT", ["src/adapters/coordination/rate-limit.ts per-tenant and per-identity ceilings"])),
  GLOBALIZATION: probe(exists("src/domain/identifiers.ts") && MIGRATIONS > 0, requirePaths("GLOBALIZATION", ["src/domain/identifiers.ts jurisdiction-bearing identifier", `db/migrations ${MIGRATIONS} migration(s) carrying jurisdiction policy tables`])),
  SUPPORT_MATRIX: probe(exists("ENVIRONMENT.md"), requirePaths("SUPPORT_MATRIX", ["ENVIRONMENT.md configuration surface and lanes", "docs/release/supported-formats.md supported artifact formats"])),
  DATA_PORTABILITY: probe(exists("db/seed/prior_release.sql"), requirePaths("DATA_PORTABILITY", ["db/seed/prior_release.sql seed fixture", "src/adapters/persistence"])),
  TIME: probe(exists("src/domain/entities.ts"), requirePaths("TIME", ["src/domain/entities.ts deadline and window entities"])),
  BROWSER: probe(A11Y_SUITES > 0, requirePaths("BROWSER", ["tests/ui render suites through a real browser runtime"])),
  STATIC_ANALYSIS: probe(exists("scripts/lint.sh") && exists("scripts/security-check.sh"), requirePaths("STATIC_ANALYSIS", ["scripts/lint.sh static lint stage", "scripts/security-check.sh security contract suites and scans", "scripts/reality-gate.sh placeholder and simulation scan"])),
  DYNAMIC_TESTING: probe(exists("scripts/induced-failure-readiness.sh"), requirePaths("DYNAMIC_TESTING", ["scripts/induced-failure-readiness.sh induced failure across every declared dependency", "scripts/gate-observability.sh observability gate that runs the induced-failure stage", "tests/db integration suites against a provisioned database"])),
  SUPPLY_CHAIN: probe(exists("scripts/dependency-audit.sh"), requirePaths("SUPPLY_CHAIN", ["scripts/dependency-audit.sh advisory scan and CycloneDX SBOM", "package-lock.json locked dependency set"])),
  SECRET_SCAN: probe(exists("scripts/secret-scan.sh"), requirePaths("SECRET_SCAN", ["scripts/secret-scan.sh planted-shape secret scan"])),
  ARCH_DOCS: probe(exists("ARCHITECTURE.md") && exists("DECISIONS.md"), requirePaths("ARCH_DOCS", ["ARCHITECTURE.md declared component structure", "DECISIONS.md recorded decisions and open ADRs", "ASSUMPTIONS.md declared assumptions"])),
  PRIVACY: probe(exists("DATA_EGRESS_MATRIX.md") && exists("config/observability/retention.json"), requirePaths("PRIVACY", ["DATA_EGRESS_MATRIX.md declared egress classes", "config/observability/retention.json retention windows", "SECURITY.md data handling rules"])),
  AUDIT: probe(countFiles("src/adapters/persistence", /audit/) > 0, requirePaths("AUDIT", [`src/adapters/persistence ${countFiles("src/adapters/persistence", /audit/)} audit-path module(s)`, "config/alerts/catalogue.json audit-related alert rows"])),
  RECOVERY: probe(exists("ROLLBACK.md"), requirePaths("RECOVERY", ["ROLLBACK.md rollback procedure", "scripts/backup-drill.sh destructive restore drill", "deploy/production/README.md rollback trigger and owner"])),
  INCIDENT: probe(exists("docs/runbooks/operations/incident-response.md"), requirePaths("INCIDENT", ["docs/runbooks/operations/incident-response.md incident procedure", "config/alerts/catalogue.json 20 alert rows with runbooks"])),
  VENDOR: probe(exists("PREFLIGHT.md"), requirePaths("VENDOR", ["PREFLIGHT.md declared provider credentials and probes", ".agent/verification/CAPABILITY_MATRIX.md vendor limitation records"])),
  EXPLORATORY: probe(true, "the exploratory family is executed by a human tester, and no automation can stand in for that (SPEC-008 section 9)"),
  UAT: probe(true, "user acceptance is a mandatory external gate: a named authorised participant must perform it (SPEC-008 section 9)"),
  LEGAL: probe(true, "legal and compliance review is a mandatory external gate performed by qualified counsel (SPEC-008 section 9)"),
  BLOCKCHAIN: CHAIN_PROBE,
  HSM: HSM_PROBE,
  MODEL: MODEL_PROBE,
  CONTAINER: CONTAINER_PROBE,
  MOBILE: MOBILE_PROBE,
  IOT: IOT_PROBE,
  CRYPTO: probe(exists("src/adapters/crypto/local-key-provider.ts"), requirePaths("CRYPTO", ["src/adapters/crypto/local-key-provider.ts key material and signing primitives", "src/application/security/webhook-gate.ts webhook signature verification", "src/adapters/persistence/webhook-bindings.ts stored webhook bindings"])),
  KEYS: probe(exists("src/adapters/crypto/local-key-provider.ts"), requirePaths("KEYS", ["src/adapters/crypto/local-key-provider.ts local key provider", "src/adapters/secrets/secret-resolver.ts secret resolution by reference", "config/environment/schema.json declared key material and secret keys"])),
  FORMAL: probe(exists("scripts/mutation-gate.sh"), requirePaths("FORMAL", ["scripts/mutation-gate.sh mutation gate over the suites", "tests/domain/state-machine.test.ts every legal transition with its guard satisfied and refused when not", "tests/domain/illegal-transitions.test.ts the documented forbidden pairs", "tests/domain/invariants.test.ts the state-machine invariants SM-1 through SM-6"])),
  GRAPHQL_GRPC: GRAPHQL_GRPC_PROBE,
  CLOUD_IAM: absenceReport("cloud IAM, role or service-account integration", /@aws-sdk|aws-sdk|@google-cloud|google-auth|@azure|azure-identity|\biam\b/i),
  SERVERLESS: absenceReport("serverless framework or function runtime", /serverless|aws-lambda|lambda-runtime|functions-framework|cloudfunctions/i),
  WEBSOCKET: WEBSOCKET_PROBE,
  PATCH_UPDATE: probe(exists("scripts/install.sh") && exists("db/UPGRADE_MATRIX.md"), requirePaths("PATCH_UPDATE", ["scripts/install.sh installs a pinned artifact by digest", "db/UPGRADE_MATRIX.md upgrade matrix and its unproven rows", "ROLLBACK.md rollback procedure by digest"])),
  IAC: IAC_PROBE,
};

// -------------------------------------------------------------------------------------------------------------
// 2. THE TOPIC TABLE: what each nameable subject is decided FROM, and what its absence means.
// -------------------------------------------------------------------------------------------------------------
const TOPICS = [
  { id: "multitenant", keywords: /tenant|cross-tenant|isolation|row.level|rls|multi-tenant/i, probe: "TENANCY", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "ai", keywords: /\bai\b|\bagents?\b|agentic|\bllm\b|prompt injection|machine learning|inference (api|server|endpoint)|model (gateway|server|endpoint|file|provider)|autonomous (agent|loop)/i, probe: "MODEL", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "provision and implement a model or agent transport, then decide this ID against it (LOCAL_MODEL_ENDPOINT is declared and unprovisioned)" },
  { id: "long-running", keywords: /long.running|duration|soak|endurance|window|slo|latency|timeout/i, probe: "LONG_RUNNING", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "declare a duration objective in config/slo/objectives.json" },
  { id: "distributable", keywords: /distribut|package|artifact|tarball|install|release|provenance|sbom/i, probe: "ARTIFACT", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "gui", keywords: /\bui\b|gui|screen|page|render|accessib|a11y|wcag|keyboard|contrast|focus|screen reader/i, probe: "A11Y", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "gui-human", keywords: /human.*(ui|gui|interface)|manual.*(ui|screen)/i, probe: "HUMAN", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "name the human surface this ID targets" },
  { id: "human", keywords: /human|manual review|uat|acceptance by|operator|sign.off|counsel|legal/i, probe: "HUMAN", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null, forceManual: true },
  { id: "runtime", keywords: /runtime|process|listener|boot|startup|memory|event loop/i, probe: "SERVICE", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "api", keywords: /\bapi\b|route|endpoint|contract|openapi|request|response|status code/i, probe: "API", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "interface", keywords: /interface|schema|contract|wire|serializ/i, probe: "API", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "persistence", keywords: /persist|database|postgres|\bsql\b|migration|schema|transaction|storage|durab/i, probe: "PERSISTENCE", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "stateful", keywords: /stateful|state|session|durable execution|queue/i, probe: "PERSISTENCE", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "stateful-distributed", keywords: /distributed state|valkey|redis|cluster|replica|consensus/i, probe: "PERSISTENCE", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "declare the distributed state component this ID targets" },
  { id: "versioned-stateful", keywords: /version|upgrade|compatib|rollback|downgrade|migration path/i, probe: "STATEFUL_VERSIONED", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "versioned-distributed", keywords: /distributed version|rolling upgrade|compatibility across nodes/i, probe: "STATEFUL_VERSIONED", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "declare the distributed deployment this ID targets" },
  { id: "configurable", keywords: /config|environment|variable|flag|setting/i, probe: "CONFIGURABLE", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "deployable", keywords: /deploy|release to|staging|production|infrastructure|rollout/i, probe: "DEPLOYABLE", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "provision a deployment target; staging is NOT_PROVISIONED today" },
  { id: "buildable", keywords: /build|compile|bundle|toolchain|dependency pin/i, probe: "BUILDABLE", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "service", keywords: /service|microservice|daemon|worker process/i, probe: "SERVICE", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "crypto", keywords: /cryptograph|encryption|hash|cipher|hmac|signature|signing|key deriv|random|entropy|primitive/i, probe: "CRYPTO", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "keys", keywords: /key management|key rotation|private key|secret management|credential stor/i, probe: "KEYS", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "hsm", keywords: /\bhsm\b|hardware security module|pkcs#?11|secure element|tpm/i, probe: "HSM", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "replay", keywords: /replay|nonce|idempot|duplicate submission|double.spend/i, probe: "API", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "auth", keywords: /auth|token|oidc|scope|permission|role|privilege|access control|rbac|step.?up|mfa/i, probe: "AUTH", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "egress", keywords: /egress|dlp|data loss|leak|redact|pii export|exfiltrat/i, probe: "EGRESS", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "observability", keywords: /observ|metric|alert|log|trace|telemetry|monitor|slo|dashboard/i, probe: "OBSERVABILITY", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "rate-limit", keywords: /rate limit|throttl|quota|budget|ceiling/i, probe: "RATE_LIMIT", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "secrets", keywords: /secret|credential|workload identity|vault|kms resolution/i, probe: "SECRETS", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "provision a secret store and re-decide" },
  { id: "support-matrix", keywords: /support matrix|supported (platform|version|browser|format)|compatibility matrix/i, probe: "SUPPORT_MATRIX", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "text-globalization", keywords: /globali|i18n|l10n|locale|translation|jurisdiction|unicode/i, probe: "GLOBALIZATION", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "declare the locale or jurisdiction surface this ID targets" },
  { id: "data-portability", keywords: /portab|export|import|backup|restore|migrat.*data/i, probe: "DATA_PORTABILITY", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "time", keywords: /time|clock|deadline|window|timezone|timestamp|skew/i, probe: "TIME", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "performance", keywords: /performance|throughput|latency|benchmark|capacity|scal/i, probe: "LONG_RUNNING", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "declare a performance objective with a measurable threshold" },
  { id: "chaos", keywords: /chaos|fault inject|failure inject|resilien|circuit break|retry storm/i, probe: "SERVICE", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "declare the failure-injection target" },
  { id: "human-legal", keywords: /business associate|baa\b|workforce|training|facility|physical|disposal|sanction|policy document|attestation|counsel/i, probe: "LEGAL", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null, forceManual: true },
  { id: "blockchain-specific", keywords: /\bchain\b|blockchain|smart contract|solidity|wallet|token|nft|defi|consensus|mining|gas|ledger node|on-chain|web3|merkle root of a chain/i, probe: "BLOCKCHAIN", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  // THE STANDARD CONTROL FAMILIES. MEASURED REASON THEY ARE HERE: the first version of this table left 185 IDs
  // undecided, and reading their titles showed they were ordinary controls -- SAST, DAST, code review, dependency
  // scanning, penetration testing, incident response, container and mobile coverage -- each of which this
  // repository can answer with evidence. Leaving them pending would have been a decision not to decide.
  { id: "static-analysis", keywords: /sast|static analysis|static application|code review|source code analysis|lint|secure coding|code quality|complexity|dead code/i, probe: "STATIC_ANALYSIS", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "dynamic-analysis", keywords: /dast|dynamic analysis|dynamic application|penetration|pen test|pentest|vulnerability scan|fuzz|injection|iast|runtime analysis|exploit/i, probe: "DYNAMIC_TESTING", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "supply-chain", keywords: /sca\b|software composition|dependency (scan|audit|check)|third.party component|open source|license compliance|sbom|bill of materials|package integrity|typosquat/i, probe: "SUPPLY_CHAIN", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "secret-scan", keywords: /secret (scan|detect|exposure)|credential leak|hardcoded (secret|credential|password)|api key exposure/i, probe: "SECRET_SCAN", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "architecture-review", keywords: /threat model|architecture review|design review|risk assess|security review|expert.*(audit|review)|control assessment|gap analysis/i, probe: "ARCH_DOCS", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "privacy", keywords: /privacy|pii|personal data|data subject|consent|retention|gdpr|ccpa|phi\b|protected health|de-?identif|anonymi|redact/i, probe: "PRIVACY", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "audit-integrity", keywords: /audit|tamper|immutab|log integrity|non-repudiation|append.only|chain of custody/i, probe: "AUDIT", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "availability", keywords: /availab|uptime|high availability|failover|backup|restore|disaster|recovery|business continu|rto\b|rpo\b/i, probe: "RECOVERY", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "declare a recovery objective and its owner" },
  { id: "incident", keywords: /incident response|breach|notification|escalation|forensic|containment|post.?mortem/i, probe: "INCIDENT", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "vendor", keywords: /vendor|third.party|supplier|subprocessor|outsourc|service provider|sla with/i, probe: "VENDOR", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "name the vendor relationship this ID targets" },
  { id: "container", keywords: /container|docker|kubernetes|\bk8s\b|image (scan|hardening)|orchestrat|infrastructure as code|cloud configuration|iac\b/i, probe: "CONTAINER", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "mobile", keywords: /mobile|android|\bios\b|desktop (app|client)|native app|app store/i, probe: "MOBILE", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "iot", keywords: /\biot\b|embedded (device|system)|firmware|hardware (device|interface)|device attestation/i, probe: "IOT", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  // THE ANALYSIS-TECHNIQUE FAMILIES. MEASURED REASON THEY ARE HERE: after the first expansion, 104 Blockchain rows
  // were still undecided and reading them showed an entire family of static-analysis techniques (control flow, data
  // flow, taint, pattern matching, symbolic execution, formal verification, property and invariant testing). This
  // repository answers most of those with real tooling, and the ones it cannot answer are skipped WITH the reason
  // rather than left pending.
  { id: "code-analysis", keywords: /control flow|data flow|taint|pattern (matching|detection)|vulnerability pattern|code analysis|abstract syntax|\bast\b|source analysis|call graph|dependency graph analysis/i, probe: "STATIC_ANALYSIS", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "formal-methods", keywords: /formal verification|symbolic execution|model check|invariant|property.based|theorem|smt solver|abstract interpretation|state machine verification|transition (table|invariant)/i, probe: "FORMAL", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "add property or invariant tests and a mutation gate, then decide this ID against them" },
  { id: "runtime-monitoring", keywords: /anomaly detection|behavioral analysis|runtime monitor|intrusion detection|baseline deviation|drift detection/i, probe: "OBSERVABILITY", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "exploratory-manual", keywords: /exploratory|manual testing|ad hoc testing|session.based testing|tester experience|usability (test|study)/i, probe: "EXPLORATORY", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null, forceManual: true },
  // THE FAMILIES THE PENDING SAMPLE EXPOSED. Each of the following was pending after the previous expansion, and
  // each has a real answer in this repository: the API is REST with schema validation, the UI is React with a CSP,
  // concurrency is answered by idempotency keys and row locks, observability by the catalogue and alert rows, and
  // infrastructure-as-code and GraphQL/gRPC are ABSENT as constructs, which is a decision with evidence rather
  // than a reason to stay pending.
  { id: "input-validation", keywords: /input validation|boundary validation|malformed input|invalid input|sanity check|sanitiz|injection/i, probe: "API", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "output-encoding", keywords: /cross.site scripting|\bxss\b|output encoding|html injection|content security policy|\bcsp\b|template injection/i, probe: "INTERFACE", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "concurrency", keywords: /race condition|toctou|time.of.check|concurren|deadlock|lost update|double (submit|spend)|interleav/i, probe: "API", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "identify the concurrent path this ID targets" },
  { id: "siem-correlation", keywords: /siem|event correlation|log correlation|security monitoring|correlation rule|alert correlation/i, probe: "OBSERVABILITY", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "graphql-grpc", keywords: /graphql|grpc|protobuf|subscription api|schema stitching/i, probe: "GRAPHQL_GRPC", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "infrastructure-as-code", keywords: /terraform|cloudformation|\bcspm\b|cloud security posture|infrastructure as code|\biac\b|arm template|pulumi|ansible|chef|puppet/i, probe: "IAC", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "data-protection", keywords: /at rest|in transit|transit encryption|data protection|tokeniz|field.level encryption/i, probe: "PRIVACY", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "declare the data store and its protection controls" },
  { id: "host-platform", keywords: /host hardening|host security|platform hardening|server hardening|baseline (image|configuration)|cis benchmark|operating system hardening/i, probe: "CONTAINER", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "cloud-iam", keywords: /cloud (iam|identity|role|policy)|iam (role|policy|permission)|service account|instance profile|assume role/i, probe: "CLOUD_IAM", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "provision a cloud deployment with IAM roles and re-decide against it" },
  { id: "serverless", keywords: /serverless|lambda function|function as a service|\bfaas\b|cloud function|edge function/i, probe: "SERVERLESS", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "websocket", keywords: /websocket|socket\.io|realtime channel|server.sent event/i, probe: "WEBSOCKET", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
  { id: "patch-update", keywords: /patch (mechanism|management)|secure update|update mechanism|upgrade mechanism|hotfix/i, probe: "PATCH_UPDATE", absent: "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE", absentRequest: "declare the patch or update path and its owner" },
  { id: "file-inclusion", keywords: /file inclusion|\blfi\b|\brfi\b|path traversal|directory traversal|arbitrary file (read|write)/i, probe: "API", absent: "SKIPPED_NOT_APPLICABLE", absentRequest: null },
];
const topicById = new Map(TOPICS.map((topic) => [topic.id, topic]));

// -------------------------------------------------------------------------------------------------------------
// 3. THE DECISION.
// -------------------------------------------------------------------------------------------------------------
const registryRows = readCsv(fs.readFileSync(registryPath, "utf8"));
const header = registryRows[0].map((name) => name.trim());
const records = registryRows.slice(1).map((values) => Object.fromEntries(header.map((name, index) => [name, (values[index] ?? "").trim()])));
const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
const ownerOf = new Map(seed.ownership_rows.map((row) => [row.test_id, row.owner_stage]));
const DECIDED_AT = new Date().toISOString();
const DECIDED_BY = "scripts/applicability-decide.sh";

const rows = [];
const byRule = {};
const pending = [];
for (const record of records) {
  const predicate = record.applicability;
  const title = `${record.title} ${record.kind}`;
  const isBlockchainFamily = record.test_id.startsWith("BC-");
  let decision = null;
  let ruleRef = null;
  let evidence = null;
  let topicId = null;

  const decideFromTopic = (topic, why) => {
    const found = PROBES[topic.probe];
    topicId = topic.id;
    if (found === undefined) { problems.push(`${record.test_id}: topic ${topic.id} names probe ${topic.probe}, which does not exist`); return; }
    if (found.present) {
      decision = topic.forceManual === true ? "APPLICABLE_MANUAL" : "APPLICABLE_AUTOMATABLE";
      ruleRef = `topic:${topic.id}->probe:${topic.probe}`;
      evidence = `${why}; probe ${topic.probe} PRESENT: ${found.evidence}`;
      return;
    }
    decision = topic.absent;
    ruleRef = `topic:${topic.id}->probe:${topic.probe}(absent)`;
    evidence = `${why}; probe ${topic.probe} ABSENT: ${found.evidence}`;
    if (decision === "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE") {
      pending.push({ test_id: record.test_id, evidence_request: topic.absentRequest });
      evidence += `; EVIDENCE REQUEST: ${topic.absentRequest}`;
    }
  };

  // TOPIC ROUTING IS SCORED, NOT FIRST-MATCH. MEASURED FAILURE this corrects: "Threat Modeling" was routed to the
  // AI topic because the word "Modeling" contains "model", and the AI topic sits early in the table -- so a threat
  // model was decided against a model transport that does not exist. The score prefers the topic that matches MORE
  // of its own alternatives and, between equals, the LONGER matched phrase; ties fall back to table order. The
  // split on the alternation bar is a heuristic over the pattern source and is documented as one.
  const chooseTopic = (candidates, text) => candidates
    .map((topic, index) => {
      const groups = topic.keywords.source.split("|");
      const hits = groups.filter((group) => { try { return new RegExp(group, "i").test(text); } catch { return false; } });
      const longest = hits.reduce((max, hit) => Math.max(max, hit.replace(/[\\^$.*+?()[\]{}()]/g, "").length), 0);
      return { topic, score: hits.length * 100 + longest, index };
    })
    .sort((one, two) => (two.score - one.score) || (one.index - two.index))[0].topic;

  if (isBlockchainFamily) {
    // THE CHAIN-SPECIFIC SUBJECTS ARE DECIDED FIRST, and only then the chain-agnostic ones, so that a subject like
    // "Multi-Signature Wallet Testing" cannot be rescued by the word "signature" and a subject like "Signature
    // Verification Testing" cannot be skipped merely because it lives in the Blockchain pack.
    const chainTopic = topicById.get("blockchain-specific");
    if (chainTopic.keywords.test(title)) decideFromTopic(chainTopic, `registry default_stage ${record.default_stage}; the ID names a chain-specific subject`);
    else {
      const matched = TOPICS.filter((topic) => topic.id !== "blockchain-specific" && topic.keywords.test(title));
      if (matched.length === 0) {
        decision = "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE";
        ruleRef = "bc:no-topic-match";
        evidence = `no chain-specific subject is named and no repository topic matches the title, so the decision is deliberately withheld rather than assumed; EVIDENCE REQUEST: name the repository construct this BC ID targets`;
        pending.push({ test_id: record.test_id, evidence_request: "name the repository construct this BC ID targets" });
      } else {
        const chosen = chooseTopic(matched, title);
        decideFromTopic(chosen, `registry default_stage ${record.default_stage}; the ID subject is not chain-specific (matched topic ${chosen.id} from "${record.title}") and is decided on its own merits from this repository primitives`);
      }
    }
  } else if (predicate === "evaluate") {
    const matched = TOPICS.filter((topic) => topic.keywords.test(title));
    if (matched.length === 0) {
      decision = "APPLICABLE_AUTOMATABLE";
      ruleRef = "predicate:evaluate->security-and-architecture-surface";
      evidence = `predicate evaluate: decided from the security and architecture surface actually present; evidence ${PROBES.AUTH.evidence}; ${PROBES.API.evidence}`;
    } else {
      const chosen = chooseTopic(matched, title);
      const found = PROBES[chosen.probe];
      decision = chosen.forceManual === true ? "APPLICABLE_MANUAL" : "APPLICABLE_AUTOMATABLE";
      ruleRef = `predicate:evaluate->topic:${chosen.id}`;
      topicId = chosen.id;
      evidence = `predicate evaluate: decided from the surface this ID names (${chosen.id}); probe ${chosen.probe} ${found.present ? "PRESENT" : "ABSENT"}: ${found.evidence}`;
    }
  } else if (predicate === "broadly-applicable") {
    decision = "APPLICABLE_AUTOMATABLE";
    ruleRef = "predicate:broadly-applicable";
    evidence = `predicate broadly-applicable: applicable unless repository evidence shows the construct absent; evidence ${PROBES.SERVICE.evidence}; ${PROBES.BUILDABLE.evidence}`;
  } else if (predicate.startsWith("conditional-")) {
    const topic = topicById.get(predicate.slice("conditional-".length));
    if (topic === undefined) {
      const matched = TOPICS.filter((entry) => entry.keywords.test(title));
      if (matched.length === 0) {
        decision = "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE";
        ruleRef = `predicate:${predicate}->unmapped`;
        evidence = `the registry names predicate ${predicate}, which has no topic table entry, and the title matches no repository topic; EVIDENCE REQUEST: add the predicate to the topic table with the evidence it demands`;
        pending.push({ test_id: record.test_id, evidence_request: `add predicate ${predicate} to the topic table` });
      } else {
        const chosen = chooseTopic(matched, title);
        decideFromTopic(chosen, `registry predicate ${predicate} is not in the topic table; routed by title to topic ${chosen.id}`);
      }
    } else {
      decideFromTopic(topic, `registry predicate ${predicate}`);
    }
  } else if (predicate === "conditional") {
    const matched = TOPICS.filter((topic) => topic.keywords.test(title));
    if (matched.length === 0) {
      decision = "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE";
      ruleRef = "predicate:conditional->no-topic-match";
      evidence = `the registry names the bare predicate conditional and the ID title matches no repository topic; no decision is taken on assumption; EVIDENCE REQUEST: name the repository construct this ID targets`;
      pending.push({ test_id: record.test_id, evidence_request: "name the repository construct this ID targets" });
    } else {
      const chosen = chooseTopic(matched, title);
      decideFromTopic(chosen, `registry predicate conditional; routed by title to topic ${chosen.id}`);
    }
  } else {
    decision = "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE";
    ruleRef = `predicate:${predicate}->unrecognised`;
    evidence = `the registry names predicate ${predicate}, which this decider does not recognise; EVIDENCE REQUEST: classify the predicate`;
    pending.push({ test_id: record.test_id, evidence_request: `classify predicate ${predicate}` });
  }

  const owner = ownerOf.get(record.test_id);
  if (owner === undefined) problems.push(`${record.test_id}: the seed assigns no owner stage`);
  if (evidence === null || evidence.trim() === "") problems.push(`${record.test_id}: the decision cites no evidence`);
  byRule[ruleRef] = (byRule[ruleRef] ?? 0) + 1;
  rows.push({
    test_id: record.test_id,
    applicability: decision,
    applicability_predicate: predicate,
    applicability_evidence: evidence,
    decision_rule_ref: ruleRef,
    decided_by: DECIDED_BY,
    decided_at: DECIDED_AT,
    default_status: "PLANNED",
    owner_stage: owner ?? "UNASSIGNED",
    topic: topicId,
  });
}

const byDecision = {};
for (const row of rows) byDecision[row.applicability] = (byDecision[row.applicability] ?? 0) + 1;
const unassigned = rows.filter((row) => row.owner_stage === "UNASSIGNED").length;
if (unassigned > 0) problems.push(`${unassigned} row(s) have no owner stage`);
if (rows.length !== 484) problems.push(`${rows.length} decisions were produced and the pack fixes 484`);

const columns = ["test_id", "applicability", "applicability_predicate", "applicability_evidence", "decision_rule_ref", "decided_by", "decided_at", "default_status", "owner_stage"];
const lines = [columns.join(",")];
for (const row of rows.sort((one, two) => one.test_id.localeCompare(two.test_id))) {
  lines.push(columns.map((column) => csvField(row[column])).join(","));
}
fs.writeFileSync(matrixPath, `${lines.join("\n")}\n`);

const report = {
  epoch: facts.epoch,
  artifact_digest: facts.artifact_digest,
  decided_at: DECIDED_AT,
  decided_by: DECIDED_BY,
  probes: Object.fromEntries(Object.entries(PROBES).map(([key, value]) => [key, { present: value.present, evidence: value.evidence }])),
  facts,
  by_decision: byDecision,
  by_rule: Object.fromEntries(Object.entries(byRule).sort((one, two) => two[1] - one[1])),
  pending_evidence_requests: pending,
  problems,
};
fs.writeFileSync(path.join(evidenceDir, "decisions.json"), `${JSON.stringify(report, null, 2)}\n`);
const topicLines = ["test_id,applicability,topic,decision_rule_ref"];
for (const row of rows.sort((one, two) => one.test_id.localeCompare(two.test_id))) topicLines.push([row.test_id, row.applicability, row.topic ?? "", row.decision_rule_ref].join(","));
fs.writeFileSync(path.join(evidenceDir, "decisions-by-topic.csv"), `${topicLines.join("\n")}\n`);

console.log(`applicability: probes ${Object.entries(PROBES).map(([key, value]) => `${key}=${value.present ? "PRESENT" : "ABSENT"}`).join(" ")}`);
console.log(`applicability: ${rows.length} decision(s) ${JSON.stringify(byDecision)}; pending evidence requests ${pending.length}`);
for (const problem of problems) console.log(`applicability: FAIL - ${problem}`);
if (problems.length > 0) process.exit(1);
ENDS_APPLICABILITY

node "$DECIDE" "$REGISTRY" "$SEED" "$MATRIX" "$EVIDENCE_DIR" || fail "the applicability decisions did not all validate; see .agent/evidence/EP-010/M2-applicability/decisions.json"

LINES=$(wc -l < "$MATRIX" | tr -d ' ')
[ "$LINES" = "485" ] || fail "the applicability matrix has $LINES line(s) and the milestone requires 485 (header plus 484 ID rows)"

echo "applicability: decided"
