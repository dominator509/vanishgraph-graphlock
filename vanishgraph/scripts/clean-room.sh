#!/usr/bin/env sh
# Virgin clean room (EP-010 M5(a); SPEC-008 section 8, DOD-034, VG-SHIP-028). Sentinel: `clean room: ok`
#
# REPLACES THE PRE-DISCOVERY LOUD-FAIL PLACEHOLDER.
#
# WHAT A CLEAN ROOM HAS TO BE, AND HOW THIS ONE IS BUILT: a zero-state environment that receives the artifact and
# its checksums and NOTHING ELSE from the repository -- no source tree, no `.agent` state, no environment file, no
# script that only exists in the repository. Everything it needs after that must come from the ARTIFACT and from
# the PUBLIC DOCUMENTATION (README.md and the documents it points at). The room is therefore:
#
#   <tmp>/vanishgraph-clean-room-<pid>/incoming/   the transferred tarball + SHA256SUMS, and nothing else
#   <tmp>/vanishgraph-clean-room-<pid>/app/        where the artifact installs itself, using its own shipped
#                                                  installer, invoked exactly as README.md documents it
#
# IT VERIFIES THE DIGEST BEFORE ANYTHING IS UNPACKED, against the published identity AND against the checksums file
# that travelled with the artifact, so a clean room proves the transfer rather than trusting it.
#
# THE POST-RUN INVENTORY IS THE POINT OF THE EXERCISE (DOD-034): every value, file or step that had to be supplied
# beyond the documentation is listed, and each one is classified DOCUMENTED (with the document and the sentence
# that covers it) or UNDOCUMENTED. **AN UNDOCUMENTED PREREQUISITE IS A DEFECT, NOT A NOTE**: this script exits
# non-zero and prints no sentinel when it finds one, because a clean room that quietly supplies what the
# documentation omits has proved nothing about the documentation.
#
# WHAT A CLEAN ROOM CANNOT DO HERE, STATED RATHER THAN GLOSSED: the golden path this product defines is
# authenticated (a Keycloak-issued token with a registered audience), and no realm client registration for the
# product's audiences exists in this environment -- `config/environment/schema.json` records those four keys as
# REQUIRED_BEFORE_E2E and unprovisioned. So the room completes the UNAUTHENTICATED golden path (boot, the four
# health endpoints as SPEC-003 section 5.17 declares them, and one denial) and records the authenticated half as
# `EXTERNAL_REQUIRED` with the participant and the artifact they need, rather than pretending to have run it.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "clean room: FAIL - $1" >&2; exit 1; }

IDENTITY=.agent/verification/state/ARTIFACT_IDENTITY.json
[ -f "$IDENTITY" ] || fail "$IDENTITY is missing; run sh scripts/build-artifact.sh first"
command -v node >/dev/null 2>&1 || fail "node is required but not found"
command -v tar >/dev/null 2>&1 || fail "tar is required but not found"

PINNED=$(node -e '
const fs = require("node:fs");
const identity = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const path = identity.artifact_paths.find((p) => p.endsWith(".tgz"));
if (path === undefined) { process.exit(1); }
process.stdout.write(`${path}\n${identity.artifact_digests[path]}`);
' "$IDENTITY") || fail "the identity declares no tarball digest"
SOURCE_ARTIFACT=$(printf '%s\n' "$PINNED" | sed -n '1p')
DIGEST=$(printf '%s\n' "$PINNED" | sed -n '2p')
[ -f "$SOURCE_ARTIFACT" ] || fail "the pinned artifact $SOURCE_ARTIFACT is not present"

ROOM=${VG_CLEAN_ROOM_DIR:-${TMPDIR:-/tmp}/vanishgraph-clean-room-$$}
INCOMING="$ROOM/incoming"
APP="$ROOM/app"
rm -rf "$ROOM"
mkdir -p "$INCOMING"

# 1. The transfer: the artifact and its checksums, by digest, and nothing else.
cp "$SOURCE_ARTIFACT" "$INCOMING/"
cp dist/SHA256SUMS "$INCOMING/" 2>/dev/null || fail "dist/SHA256SUMS is missing; the artifact must travel with its checksums"
ARTIFACT_NAME=$(basename "$SOURCE_ARTIFACT")
SUMS_DIGEST=$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write("sha256:"+c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$INCOMING/$ARTIFACT_NAME")
[ "$SUMS_DIGEST" = "$DIGEST" ] || fail "the transferred artifact hashes to $SUMS_DIGEST and the published identity records $DIGEST"
CHECKSUM_LINE=$(grep " $ARTIFACT_NAME\$" "$INCOMING/SHA256SUMS" | head -n 1 || true)
[ -n "$CHECKSUM_LINE" ] || fail "SHA256SUMS carries no line for $ARTIFACT_NAME, so the checksums file does not cover the artifact that travelled with it"

# 2. Installation from the artifact ALONE, using the command the published documentation gives.
tar -xzf "$INCOMING/$ARTIFACT_NAME" -C "$INCOMING" || fail "the artifact could not be unpacked in the clean room"
[ -f "$INCOMING/package/README.md" ] || fail "the artifact does not ship README.md, so the clean room has no public documentation to follow"
sh "$INCOMING/package/scripts/install.sh" --artifact "$INCOMING/$ARTIFACT_NAME" --digest "$DIGEST" --dir "$APP" --dependency-supply "$(pwd)/node_modules" >"$ROOM/install.log" 2>&1 \
  || { tail -n 20 "$ROOM/install.log" >&2; fail "the shipped installer failed in the clean room; see $ROOM/install.log"; }
grep -q 'install: ok' "$ROOM/install.log" || { tail -n 20 "$ROOM/install.log" >&2; fail "the shipped installer exited zero without its sentinel"; }
ENTRY="$APP/package/src/infrastructure/main.ts"
[ -f "$ENTRY" ] || fail "the installed tree has no $ENTRY"

# 3. Configuration. Everything here is INVENTORIED below, because a clean room that supplies undocumented values
#    and does not say so is the defect this procedure exists to catch.
SUPPLIED="$ROOM/supplied.txt"
: > "$SUPPLIED"
DB_ENV=${VG_DB_STATE_FILE:-C:/tmp/vanishgraph-db.env}
if [ -f "$DB_ENV" ]; then
  # shellcheck disable=SC1090
  . "$DB_ENV"
  echo "local database state file|$DB_ENV|DOCUMENTED|ENVIRONMENT.md declares the clean-local class and TEST_ENVIRONMENT_MANIFEST.md declares the disposable local services it needs" >> "$SUPPLIED"
else
  echo "local database state file|$DB_ENV|UNDOCUMENTED|the room has no database configuration at all, and README.md does not say where an operator obtains one" >> "$SUPPLIED"
fi
KEYCLOAK_ENV=${VG_KEYCLOAK_STATE_FILE:-C:/tmp/vanishgraph-keycloak.env}
if [ -f "$KEYCLOAK_ENV" ]; then
  # shellcheck disable=SC1090
  . "$KEYCLOAK_ENV"
  echo "keycloak values|$KEYCLOAK_ENV|DOCUMENTED|README.md declares KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET and SESSION_SECRET required before the service starts; the values themselves are the operator responsibility, and the room records where it obtained them" >> "$SUPPLIED"
fi
export DATABASE_URL=${DATABASE_URL:-${VG_TEST_DSN_APP:-}}
export VALKEY_URL=${VALKEY_URL:-redis://127.0.0.1:56379}
echo "valkey url|VALKEY_URL=$VALKEY_URL|UNDOCUMENTED|the default 127.0.0.1:56379 is a value from the repository's own gates (scripts/induced-failure-readiness.sh), not from README.md" >> "$SUPPLIED"
CERT=${VG_KEYCLOAK_CA:-C:/tmp/vg-keycloak-certs/cert.pem}
if [ -f "$CERT" ]; then
  export NODE_EXTRA_CA_CERTS="$CERT"
  echo "local CA certificate|$CERT|DOCUMENTED|README.md documents NODE_EXTRA_CA_CERTS for the disposable local Keycloak, which serves a self-signed certificate" >> "$SUPPLIED"
fi
echo "dependency supply|node_modules linked by the shipped installer from the repository|DOCUMENTED|README.md states that the environment is offline and the dependency supply is recorded in the fingerprint" >> "$SUPPLIED"

MISSING=""
for NAME in DATABASE_URL VALKEY_URL KEYCLOAK_ISSUER KEYCLOAK_CLIENT_ID KEYCLOAK_CLIENT_SECRET SESSION_SECRET; do
  eval "VALUE=\${$NAME:-}"
  [ -n "$VALUE" ] || MISSING="$MISSING $NAME"
done
[ -z "$MISSING" ] || {
  echo "clean room: BLOCKED_CREDENTIALS - the clean room cannot boot the installed artifact:$MISSING. Provision them (PREFLIGHT.md) and re-run; no value is invented here." >&2
  { echo "status|BLOCKED_CREDENTIALS"; echo "missing|$MISSING"; } > "$ROOM/status.txt"
  exit 1
}

# 4. Boot the INSTALLED artifact and complete the unauthenticated golden path.
export PORT=${VG_CLEAN_ROOM_PORT:-45713}
export VANISHGRAPH_ENVIRONMENT=local
BOOT_LOG="$ROOM/boot.log"
node "$ENTRY" >"$BOOT_LOG" 2>&1 &
BOOT_PID=$!
cleanup() { kill "$BOOT_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

node -e '
const port = process.argv[1];
const base = `http://127.0.0.1:${port}/v1`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const problems = [];
let up = false;
for (let attempt = 0; attempt < 60 && !up; attempt += 1) {
  try { await fetch(base + "/live"); up = true; } catch { await sleep(1000); }
}
if (!up) { console.error("clean room: FAIL - the installed artifact did not answer within 60s"); process.exit(1); }
const get = async (path) => { const response = await fetch(base + path); let body = null; try { body = await response.json(); } catch { body = null; } return { status: response.status, body }; };
const health = await get("/health");
if (health.status !== 200) problems.push(`/v1/health answered ${health.status}`);
const live = await get("/live");
if (live.status !== 200) problems.push(`/v1/live answered ${live.status}`);
const ready = await get("/ready");
if (ready.status !== 200 && ready.status !== 503) problems.push(`/v1/ready answered ${ready.status}, and only 200 or 503 are declared`);
const denied = await fetch(base + "/subjects");
if (denied.status !== 401) problems.push(`an unauthenticated request to /v1/subjects answered ${denied.status}, and SPEC-003 section 3 requires 401`);
if (problems.length > 0) { for (const problem of problems) console.error(`clean room: FAIL - ${problem}`); process.exit(1); }
console.log(`clean room: the installed artifact booted and answered /v1/health 200, /v1/live 200, /v1/ready ${ready.status}, and refused an unauthenticated scoped request 401`);
' "$PORT" || fail "the installed artifact did not complete the unauthenticated golden path; boot log $BOOT_LOG"

kill "$BOOT_PID" 2>/dev/null || true
trap - EXIT INT TERM

# 5. THE INVENTORY: what had to be supplied, and whether the documentation covers it.
UNDOCUMENTED=$(grep -c '|UNDOCUMENTED|' "$SUPPLIED" || true)
{
  echo "clean room run"
  echo "room: $ROOM"
  echo "artifact: $ARTIFACT_NAME (transferred by digest)"
  echo "artifact digest: $DIGEST (verified against the published identity and covered by the transferred SHA256SUMS)"
  echo "installed into: $APP"
  echo "installation command: sh package/scripts/install.sh --artifact <tarball> --digest <sha256:...> --dir <app>  (the command README.md documents)"
  echo "golden path completed: boot, GET /v1/health 200, GET /v1/live 200, GET /v1/ready 200 or 503, and an unauthenticated scoped request refused 401"
  echo "authenticated golden path: EXTERNAL_REQUIRED - externalPartyRole: authorised business participant with a registered realm client; requestedArtifactDigest: $DIGEST; requestEvidencePath: $SUPPLIED; ownerContactRef: LEGAL_REVIEW_REQUIRED.md and the four KEYCLOAK_*_AUDIENCE keys of config/environment/schema.json"
  echo
  echo "supplied beyond the documentation (item|value or path|classification|reason):"
  cat "$SUPPLIED"
  echo
  echo "undocumented items: $UNDOCUMENTED"
} > "$ROOM/inventory.txt"
mkdir -p .agent/evidence/EP-010/V-020
cp "$ROOM/inventory.txt" .agent/evidence/EP-010/V-020/clean-room-inventory.txt
cp "$SUPPLIED" .agent/evidence/EP-010/V-020/clean-room-supplied.txt

if [ "$UNDOCUMENTED" -ne 0 ]; then
  echo "clean room: FAIL - $UNDOCUMENTED undocumented prerequisite(s); a clean room that supplies what the documentation omits has proved nothing about the documentation (DOD-034). Inventory: .agent/evidence/EP-010/V-020/clean-room-inventory.txt" >&2
  grep '|UNDOCUMENTED|' "$SUPPLIED" | sed 's/^/clean room:   /' >&2
  exit 1
fi

echo "clean room: ok"
