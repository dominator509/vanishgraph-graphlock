#!/usr/bin/env sh
# Dependency and supply-chain audit stage. Sentinel: `dependency audit: ok`
#
# Replaces the pre-discovery loud-fail placeholder (EP-001 milestone M5).
#
# Checks, in order:
#   1. the dependency set is locked and exactly pinned (DOD-002, DOD-021);
#   2. there are no runtime dependencies, so the shipped surface has no third-party
#      runtime supply chain at all (LICENSE_POLICY.md);
#   3. the advisory scan runs against the registry, bounded in time;
#   4. a CycloneDX SBOM is emitted and hashed (DOD-025).
#
# An unreachable registry is a HARNESS error, not a pass and not a candidate failure
# (DOD-032, DOD-033). It never prints the sentinel.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail()  { echo "dependency audit: FAIL - $1" >&2; exit 1; }
error() { echo "dependency audit: ERROR - $1" >&2; exit 1; }

[ -f package.json ] || fail "package.json is missing"
[ -f package-lock.json ] || fail "package-lock.json is missing; the dependency set is not locked"
[ -d node_modules ] || fail "node_modules is missing; run npm ci"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0

# 1 + 2. Inventory, exact pinning, and absence of runtime dependencies.
node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const problems = [];
  const runtime = Object.keys(pkg.dependencies ?? {});
  if (runtime.length > 0) problems.push("runtime dependencies present: " + runtime.join(", "));
  for (const [name, spec] of Object.entries(pkg.devDependencies ?? {})) {
    if (!/^\d+\.\d+\.\d+$/.test(spec)) problems.push(`devDependency ${name} is not exact-pinned: ${spec}`);
  }
  if (problems.length > 0) {
    console.error("dependency audit: FAIL - " + problems.join("; "));
    process.exit(1);
  }
  const count = Object.keys(pkg.devDependencies ?? {}).length;
  console.log(`dependency audit: inventory ok (0 runtime dependencies; ${count} exact-pinned devDependencies)`);
' || exit 1

# 3. Advisory scan, bounded. A hanging registry must fail the gate, not stall it.
npm audit --audit-level=high --json >"$tmp/audit.json" 2>"$tmp/audit.err" &
audit_pid=$!
waited=0
while kill -0 "$audit_pid" 2>/dev/null; do
  if [ "$waited" -ge 60 ]; then
    kill "$audit_pid" 2>/dev/null || true
    error "npm audit did not complete within 60s (registry unreachable or hanging); this is a harness ERROR, not a pass; re-run with network access or in CI"
  fi
  sleep 1
  waited=$((waited + 1))
done
if wait "$audit_pid"; then
  echo "dependency audit: advisory scan clean at --audit-level=high"
else
  if grep -qE 'ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|ENETUNREACH' "$tmp/audit.err" 2>/dev/null; then
    error "npm registry unreachable; the advisory scan could not run: $(head -n 1 "$tmp/audit.err"); harness ERROR, not a pass (DOD-033)"
  fi
  echo "dependency audit: FAIL - advisories at or above the high threshold:" >&2
  cat "$tmp/audit.json" >&2 2>/dev/null || true
  exit 1
fi

# 4. SBOM, hashed.
mkdir -p .agent/evidence/dependency-audit
if npm sbom --sbom-format=cyclonedx >.agent/evidence/dependency-audit/sbom.cdx.json 2>"$tmp/sbom.err"; then
  [ -s .agent/evidence/dependency-audit/sbom.cdx.json ] || fail "npm sbom produced an empty document"
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' \
    .agent/evidence/dependency-audit/sbom.cdx.json || fail "the SBOM is not valid JSON"
  node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const digest = crypto.createHash("sha256")
      .update(fs.readFileSync(".agent/evidence/dependency-audit/sbom.cdx.json"))
      .digest("hex");
    fs.writeFileSync(".agent/evidence/dependency-audit/sbom.cdx.sha256", digest + "\n");
    console.log("dependency audit: sbom sha256 " + digest);
  '
else
  error "npm sbom failed: $(head -n 1 "$tmp/sbom.err" 2>/dev/null); harness ERROR, not a pass"
fi

echo "dependency audit: ok"
