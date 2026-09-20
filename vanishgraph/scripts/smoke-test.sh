#!/usr/bin/env sh
# Artifact-bound smoke test (EP-009 M4; SPEC-008 section 7 VG-SHIP-021/022, DOD-004, DOD-012).
# Sentinel: `smoke test: ok`
#
# REPLACES THE PRE-DISCOVERY LOUD-FAIL PLACEHOLDER. The placeholder was correct while no artifact existed: it
# refused to print a sentinel rather than reporting a false green (DOD-024, DOD-027). This is the implementation
# it was waiting for, and the sentinel is still printed only on genuine success.
#
# WHAT IT DOES: it verifies the PUBLISHED ARTIFACT DIGEST, extracts that artifact, boots the packaged entry point
# as a real process, and asserts the health surface SPEC-007 section 7.1 declares. It is not a source-tree test:
# the bytes that run come out of the tarball the identity describes, and a caller that does not declare the
# digest it intends to test is refused before anything is extracted.
#
# THE DECLARATION OF THE DIGEST IS THE POINT: `VG_ARTIFACT_DIGEST` must equal the tarball digest recorded in
# .agent/verification/state/ARTIFACT_IDENTITY.json, and the tarball's own bytes are re-hashed and compared with
# that same digest. A stage that tests "whatever is in dist/" cannot tell a stale artifact from a fresh one.
#
# TWO MEASURED HARNESS ARRANGEMENTS, STATED RATHER THAN HIDDEN:
#   1. The artifact is extracted INSIDE the repository tree, so Node resolves its dependencies from the
#      lockfile-installed node_modules. This environment is offline, so a clean-room `npm install <tarball>` is
#      not possible here; the code that runs is the artifact's own, and the dependency supply is recorded in the
#      fingerprint. A true clean-room install remains VG-SHIP-028 work and is not claimed.
#   2. Configuration is read from the state files the environment declares and from the repository's own
#      declared local defaults -- never invented. `VALKEY_URL` defaults to the same value the EP-008 gates
#      declare (`redis://127.0.0.1:56379`), `DATABASE_URL` falls back to the provisioned application DSN, and
#      the Keycloak values come from the state file EP-009 M4 provisioned. A required key with no provisioned
#      value is BLOCKED_CREDENTIALS naming that key: the smoke never substitutes a plausible issuer or a
#      made-up client id, because that is exactly how a misconfigured deployment comes to look configured
#      (src/adapters/config/security-config.ts states the same rule for the same reason).
#
# IT FAILS CLOSED. No usable artifact, no provisioned configuration, or an endpoint that answers something the
# specification does not declare is a non-zero exit with the reason named.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "smoke test: FAIL - $1" >&2; exit 1; }
blocked() { echo "smoke test: BLOCKED_CREDENTIALS - $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "node is required but not found"
command -v tar >/dev/null 2>&1 || fail "tar is required but not found"

IDENTITY=.agent/verification/state/ARTIFACT_IDENTITY.json
[ -f "$IDENTITY" ] || fail "$IDENTITY is missing; run sh scripts/build-artifact.sh first"

# ---------------------------------------------------------------------------------------------
# 1. The pinned digest, read from the identity document rather than from a variable someone set.
# ---------------------------------------------------------------------------------------------
PINNED=$(node -e '
const fs = require("node:fs");
// READ AND PARSE RATHER THAN require(): require() treats a relative path without a leading ./ as a module id
// and reports MODULE_NOT_FOUND for a file that is plainly there, which is a confusing failure for a digest check.
const i = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const path = i.artifact_paths.find((p) => p.endsWith(".tgz"));
if (path === undefined) { console.error("the identity declares no tarball"); process.exit(1); }
process.stdout.write(path + "\n" + i.artifact_digests[path] + "\n");
' "$IDENTITY") || fail "the identity could not be read"
TARBALL=$(printf '%s\n' "$PINNED" | sed -n '1p')
PINNED_DIGEST=$(printf '%s\n' "$PINNED" | sed -n '2p')
[ -n "$TARBALL" ] && [ -n "$PINNED_DIGEST" ] || fail "the identity declares no tarball digest"
[ -f "$TARBALL" ] || fail "the artifact $TARBALL does not exist; the identity describes bytes that are not here"

DECLARED=${VG_ARTIFACT_DIGEST:-}
[ -n "$DECLARED" ] || fail "VG_ARTIFACT_DIGEST is not declared: this stage tests a DIGEST, and a run that does not say which digest it is testing is not artifact-bound (DOD-004, SPEC-008 VG-SHIP-021)"
[ "$DECLARED" = "$PINNED_DIGEST" ] || fail "the declared digest $DECLARED is not the published digest $PINNED_DIGEST; a mismatched digest is a stop condition"

ACTUAL=$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write("sha256:"+c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$TARBALL")
[ "$ACTUAL" = "$PINNED_DIGEST" ] || fail "the bytes at $TARBALL hash to $ACTUAL, and the identity records $PINNED_DIGEST"

# ---------------------------------------------------------------------------------------------
# 2. Extract the artifact. The extraction directory is emptied first, so a stale extraction cannot be
#    mistaken for the artifact under test.
# ---------------------------------------------------------------------------------------------
WORK=.agent/verification/state/artifact-smoke
rm -rf "$WORK"
mkdir -p "$WORK"
tar -xzf "$TARBALL" -C "$WORK" || fail "the artifact could not be extracted; it is not a usable tarball"
ENTRY="$WORK/package/src/infrastructure/main.ts"
[ -f "$ENTRY" ] || fail "the artifact does not contain $ENTRY; the packaged entry point is missing"
EXTRACTED_FILES=$(find "$WORK/package" -type f | wc -l | tr -d ' ')

# ---------------------------------------------------------------------------------------------
# 3. Configuration, from declared sources only.
# ---------------------------------------------------------------------------------------------
DB_ENV=${VG_DB_STATE_FILE:-C:/tmp/vanishgraph-db.env}
if [ -f "$DB_ENV" ]; then
  # The state file holds disposable local credentials and lives outside the repository (VG-SEC-002).
  # shellcheck disable=SC1090
  . "$DB_ENV"
fi
KEYCLOAK_ENV=${VG_KEYCLOAK_STATE_FILE:-C:/tmp/vanishgraph-keycloak.env}
if [ -f "$KEYCLOAK_ENV" ]; then
  # shellcheck disable=SC1090
  . "$KEYCLOAK_ENV"
fi
export DATABASE_URL=${DATABASE_URL:-${VG_TEST_DSN_APP:-}}
# The same declared local default the EP-008 gates use (scripts/induced-failure-readiness.sh, scripts/gate-observability.sh).
export VALKEY_URL=${VALKEY_URL:-redis://127.0.0.1:56379}

MISSING=""
for NAME in DATABASE_URL VALKEY_URL KEYCLOAK_ISSUER KEYCLOAK_CLIENT_ID KEYCLOAK_CLIENT_SECRET SESSION_SECRET; do
  eval "VALUE=\${$NAME:-}"
  [ -n "$VALUE" ] || MISSING="$MISSING $NAME"
done
[ -z "$MISSING" ] || blocked "the boot smoke needs configuration this environment has not provisioned:$MISSING. PREFLIGHT.md declares each key; provision it and re-run. No value is invented here."

# The local Keycloak serves a self-signed certificate; its CA is supplied explicitly, never disabled.
CERT=${VG_KEYCLOAK_CA:-C:/tmp/vg-keycloak-certs/cert.pem}
if [ -f "$CERT" ]; then export NODE_EXTRA_CA_CERTS="$CERT"; fi
# A FIXED, DECLARED PORT RATHER THAN A PARSED ONE. The first version let the OS choose (PORT=0) and recovered the
# number by parsing the boot log with a command substitution; MEASURED: the log said it was listening and the
# first request was refused, because the substitution's subshell ran the exit trap and killed the server it had
# just started. A declared port removes the parsing, the subshell and the race: the assertion below connects and
# RETRIES until the server answers, which is what waiting for a socket actually means.
SMOKE_PORT=${VG_SMOKE_PORT:-45711}
export PORT="$SMOKE_PORT"
export VANISHGRAPH_ENVIRONMENT=local

# ---------------------------------------------------------------------------------------------
# 4. Boot the artifact as a process.
# ---------------------------------------------------------------------------------------------
BOOT_LOG="$WORK/boot.log"
node "$ENTRY" >"$BOOT_LOG" 2>&1 &
BOOT_PID=$!
cleanup() { kill "$BOOT_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------------------------
# 5. Assert the health surface and one denial, over HTTP, against the running artifact. The first
#    request is retried, because a server that is booting has not failed yet.
# ---------------------------------------------------------------------------------------------
node -e '
const port = process.argv[1];
const base = `http://127.0.0.1:${port}/v1`;
const problems = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = async (path) => {
  const response = await fetch(base + path, { headers: { accept: "application/json" } });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
};
let up = false;
for (let attempt = 0; attempt < 60 && !up; attempt += 1) {
  try { await fetch(base + "/live"); up = true; } catch { await sleep(1000); }
}
if (!up) {
  console.error(`smoke test: FAIL - the artifact did not answer on port ${port} within 60s; see the boot log`);
  process.exit(1);
}

const health = await get("/health");
// SPEC-003 section 5.17.1, VERBATIM: the state field is `dependencyState`, NOT `status`, because it is a
// dependency-health classification and must never be confused with a truth state.
if (health.status !== 200) problems.push(`/v1/health answered ${health.status}`);
else {
  if ("status" in (health.body ?? {})) problems.push("/v1/health carries a `status` field, and SPEC-003 section 5.17.1 requires `dependencyState` and forbids `status`");
  if (!["HEALTHY", "DEGRADED", "UNHEALTHY"].includes(health.body?.dependencyState)) problems.push(`/v1/health dependencyState is ${JSON.stringify(health.body?.dependencyState)}, not one of HEALTHY, DEGRADED, UNHEALTHY`);
  if (health.body?.service !== "vanishgraph-api") problems.push(`/v1/health service is ${JSON.stringify(health.body?.service)}, and SPEC-007 fixes it as vanishgraph-api`);
  const deps = (health.body?.dependencies ?? []).map((entry) => entry.name);
  for (const dependency of ["postgresql", "valkey", "job-worker", "object-store", "keycloak-jwks"]) {
    if (!deps.includes(dependency)) problems.push(`/v1/health reports no dependency named ${dependency}`);
  }
}

const live = await get("/live");
if (live.status !== 200) problems.push(`/v1/live answered ${live.status}`);
else {
  if (live.body?.dependencyState !== "ALIVE") problems.push(`/v1/live dependencyState is ${JSON.stringify(live.body?.dependencyState)}, not ALIVE`);
  if (typeof live.body?.uptimeSeconds !== "number") problems.push("/v1/live does not report uptimeSeconds");
}

const startup = await get("/startup");
const startupState = startup.body?.dependencyState;
if (startup.status !== 200 && startup.status !== 503) problems.push(`/v1/startup answered ${startup.status}, and SPEC-003 section 5.17.4 declares 200 or 503`);
else if (!["STARTED", "NOT_STARTED"].includes(startupState)) problems.push(`/v1/startup dependencyState is ${JSON.stringify(startupState)}, not STARTED or NOT_STARTED`);
else if (startupState === "STARTED") {
  for (const flag of ["configurationResolved", "migrationApplied", "resourceAttributesResolved"]) {
    if (startup.body?.[flag] !== true) problems.push(`/v1/startup reports STARTED with ${flag} not true, and SPEC-003 section 5.17.4 requires all three`);
  }
} else if (!Array.isArray(startup.body?.failedChecks)) problems.push("/v1/startup reports NOT_STARTED with no failedChecks array");

// READINESS IS ALLOWED TO BE 503 AND IS NOT ALLOWED TO BE VAGUE: SPEC-007 section 7.1 requires one check per
// declared dependency and the `dependencyState`/`failedChecks` vocabulary, so a body that omits a dependency or
// renames the verdict fails here.
const ready = await get("/ready");
const DECLARED = ["postgresql", "valkey", "job-worker", "object-store", "keycloak-jwks", "provider-transport"];
if (ready.status !== 200 && ready.status !== 503) problems.push(`/v1/ready answered ${ready.status}, and only 200 or 503 are declared`);
else {
  const state = ready.body?.dependencyState;
  if (!["READY", "NOT_READY"].includes(state)) problems.push(`/v1/ready dependencyState is ${JSON.stringify(state)}, not READY or NOT_READY`);
  if ((state === "READY") !== (ready.status === 200)) problems.push(`/v1/ready answered ${ready.status} with dependencyState ${JSON.stringify(state)}, and the two must agree`);
  if (!Array.isArray(ready.body?.failedChecks)) problems.push("/v1/ready carries no failedChecks array");
  const checks = Array.isArray(ready.body?.checks) ? ready.body.checks : [];
  const named = checks.map((check) => check.name);
  for (const dependency of DECLARED) {
    if (!named.includes(dependency)) problems.push(`the readiness body names no check for the declared dependency ${dependency}`);
  }
  for (const check of checks) {
    if (typeof check.reachable !== "boolean") problems.push(`the readiness check ${check.name} does not report reachable as a boolean`);
  }
  console.log(`smoke test: readiness ${ready.status} dependencyState=${state} with ${checks.length} declared check(s): ${checks.map((check) => `${check.name}=${check.reachable}`).join(" ")}`);
}

// One denial, asserted through the same running artifact, so this is not only a liveness check.
const denied = await fetch(base + "/subjects", { headers: { accept: "application/json" } });
if (denied.status !== 401) problems.push(`an unauthenticated request to /v1/subjects answered ${denied.status}, and SPEC-003 section 3 requires 401`);

if (problems.length > 0) {
  for (const problem of problems) console.error(`smoke test: FAIL - ${problem}`);
  process.exit(1);
}
console.log("smoke test: /v1/health, /v1/live, /v1/startup and /v1/ready answered as declared, and an unauthenticated scoped request was refused 401");
' "$SMOKE_PORT" || fail "the artifact answered the health surface in a way the specification does not declare, or did not answer at all; the boot log is in $BOOT_LOG"

# ---------------------------------------------------------------------------------------------
# 6. The fingerprint: what was actually tested, recorded with the result.
# ---------------------------------------------------------------------------------------------
FINGERPRINT=.agent/verification/state/artifact-smoke-fingerprint.txt
mkdir -p .agent/evidence/EP-009
cp "$BOOT_LOG" .agent/evidence/EP-009/M4-artifact-smoke-boot.log 2>/dev/null || true
{
  echo "artifact digest: $PINNED_DIGEST"
  echo "artifact files extracted: $EXTRACTED_FILES"
  echo "entry point (from the artifact): $ENTRY"
  echo "commit: $(git rev-parse HEAD)"
  echo "node: $(node --version)"
  echo "environment token: $VANISHGRAPH_ENVIRONMENT"
  echo "keycloak issuer host: $(printf '%s' "${KEYCLOAK_ISSUER:-unset}" | sed 's|\(https\{0,1\}://[^/]*\).*|\1|')"
  echo "dependency supply: the lockfile-installed node_modules of this repository, resolved through the extraction directory (offline environment; a clean-room install is VG-SHIP-028 work and is not claimed)"
  echo "boot log: .agent/evidence/EP-009/M4-artifact-smoke-boot.log"
} > "$FINGERPRINT"

kill "$BOOT_PID" 2>/dev/null || true
trap - EXIT INT TERM
node -e 'const fs=require("node:fs");const crypto=require("node:crypto");const p=process.argv[1];const d=crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");fs.writeFileSync(p+".sha256",d+"\n");console.log("smoke test: fingerprint sha256 "+d)' "$FINGERPRINT"

# THE EXTRACTION IS REMOVED AND THE LOG KEPT: an unpacked artifact left in the tree is exactly the stale state
# that makes the next run's evidence ambiguous, and the recorded log plus the fingerprint are what a reader
# needs. The fingerprint names the log path, which is the copy under .agent/evidence/EP-009/.
rm -rf "$WORK"

echo "smoke test: ok"
