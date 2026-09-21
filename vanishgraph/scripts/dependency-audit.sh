#!/usr/bin/env sh
# Dependency and supply-chain audit stage. Sentinel: `dependency audit: ok`
#
# Replaces the pre-discovery loud-fail placeholder (EP-001 milestone M5).
#
# Checks, in order:
#   1. the whole dependency set is locked and exactly pinned (DOD-002, DOD-021);
#   2. every RUNTIME dependency carries the licence and provenance review LICENSE_POLICY.md requires - SPDX
#      identifier, locked revision, tarball URL, integrity hash, attribution, security review and a compatibility
#      verdict in config/licences/runtime-allowlist.json - and the review record is bound to the lockfile;
#   3. the CONSUMER INSTALLER surface still has no third-party runtime dependency at all;
#   4. the advisory scan runs against the registry, bounded in time;
#   5. a CycloneDX SBOM is emitted, hashed, and RECONCILED against the runtime dependency set (DOD-025, DOD-021).
#
# CORRECTED IN EP-010 M12 (Decision 1). This gate used to fail while ANY runtime dependency existed, citing
# LICENSE_POLICY.md. That policy does not require the ABSENCE of runtime dependencies: it requires each one to be
# pinned and to carry an SPDX identifier, provenance, attribution, a security review and a compatibility verdict -
# and its compatibility table lists MIT, which is the licence of all eleven runtime dependencies, as Permitted. The
# invariant was an invention of this script, no SPEC or DOD clause states it, and it made `verify: ok` unreachable
# for an ordinary Node/Fastify/PostgreSQL/React service. WHAT IS GIVEN UP IS STATED RATHER THAN DROPPED: the claim
# that the shipped APPLICATION has no third-party runtime supply chain is withdrawn; the claim that a consumer can
# run the installer with no third-party runtime dependency is KEPT and checked in step 3.
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
[ -f config/licences/runtime-allowlist.json ] || fail "config/licences/runtime-allowlist.json is missing; a runtime dependency without a recorded licence review is a release blocker (LICENSE_POLICY.md)"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0

# 1 + 2 + 3. Inventory, exact pinning, runtime licence review, installer surface.
cat >"$tmp/inventory.js" <<'ENDS_INVENTORY'
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const review = JSON.parse(fs.readFileSync("config/licences/runtime-allowlist.json", "utf8"));
const problems = [];

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const runtimeNames = Object.keys(pkg.dependencies ?? {});
const devNames = Object.keys(pkg.devDependencies ?? {});
const permitted = new Set(review.policyPermittedSpdx ?? []);
const forbidden = new Set(review.policyForbiddenSpdx ?? []);

// 1. Exact pinning, for runtime AND development dependencies alike.
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (!EXACT.test(spec)) problems.push(`runtime dependency ${name} is not exact-pinned: ${spec}`);
}
for (const [name, spec] of Object.entries(pkg.devDependencies ?? {})) {
  if (!EXACT.test(spec)) problems.push(`devDependency ${name} is not exact-pinned: ${spec}`);
}

// 2. Every runtime dependency carries a review BOUND TO THE LOCKFILE.
const reviewed = new Map((review.entries ?? []).map((entry) => [entry.name, entry]));
for (const name of runtimeNames) {
  const locked = lock.packages[`node_modules/${name}`];
  const entry = reviewed.get(name);
  if (locked === undefined) { problems.push(`runtime dependency ${name} is absent from package-lock.json`); continue; }
  if (entry === undefined) { problems.push(`runtime dependency ${name} has no licence/provenance review in config/licences/runtime-allowlist.json`); continue; }
  if (entry.version !== locked.version) problems.push(`${name}: the review covers ${entry.version} while the lockfile holds ${locked.version}; a review of a different revision is not a review`);
  if (locked.license !== undefined && entry.spdx !== locked.license) problems.push(`${name}: the review records SPDX ${entry.spdx} while the lockfile states ${locked.license}`);
  if (locked.integrity !== undefined && entry.integrity !== locked.integrity) problems.push(`${name}: the review records a different integrity hash than the lockfile; the review is not bound to the installed bytes`);
  if (locked.resolved !== undefined && entry.resolved !== locked.resolved) problems.push(`${name}: the review records a different tarball URL than the lockfile`);
  if (forbidden.has(entry.spdx)) problems.push(`${name}: ${entry.spdx} is FORBIDDEN by LICENSE_POLICY.md and may not be incorporated`);
  else if (!permitted.has(entry.spdx)) problems.push(`${name}: ${entry.spdx} is not in the permitted set of LICENSE_POLICY.md; an unreviewed licence is a release blocker`);
  for (const field of ["purpose", "compatibility", "attribution", "securityReview", "reviewedAt"]) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") problems.push(`${name}: the review records no ${field}`);
  }
}
// A review entry for a dependency that no longer exists is stale review debt, not noise.
for (const name of reviewed.keys()) {
  if (!runtimeNames.includes(name)) problems.push(`config/licences/runtime-allowlist.json reviews ${name}, which is no longer a runtime dependency; remove the entry deliberately`);
}

// 3. The consumer installer surface: no third-party runtime module may be required to install.
const installer = "scripts/install.sh";
if (!fs.existsSync(installer)) problems.push(`${installer} is missing; the consumer-facing installer is the surface that must stay dependency-free`);
else {
  const text = fs.readFileSync(installer, "utf8");
  const specifiers = [...text.matchAll(/(?:require\(|from\s+|import\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
  const thirdParty = specifiers.filter((specifier) => !specifier.startsWith("node:"));
  if (thirdParty.length > 0) problems.push(`${installer} requires third-party module(s): ${thirdParty.join(", ")}; the installer must run on the Node standard library alone`);
  if (!(pkg.files ?? []).some((entry) => entry.startsWith("scripts/install.sh"))) problems.push(`package.json does not ship ${installer}`);
}

if (problems.length > 0) {
  console.error("dependency audit: FAIL - " + problems.join("; "));
  process.exit(1);
}
console.log(`dependency audit: inventory ok (${runtimeNames.length} runtime dependencies, each exact-pinned, licence-reviewed and bound to its lockfile integrity; ${devNames.length} exact-pinned devDependencies; installer surface third-party runtime imports: 0)`);
console.log(`dependency audit: runtime licence review read from config/licences/runtime-allowlist.json (reviewed ${review.reviewedAt ?? "(undated)"} by ${review.reviewer ?? "(unnamed)"}); what is NOT enforced here: the absence of runtime dependencies, withdrawn in EP-010 M12 because LICENSE_POLICY.md requires review, not absence`);
ENDS_INVENTORY
node "$tmp/inventory.js" || exit 1

# 4. Advisory scan, bounded. A hanging registry must fail the gate, not stall it.
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

# 5. SBOM, hashed, and reconciled against the runtime dependency set.
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

# 5b. Reconciliation: LICENSE_POLICY.md requires the SBOM to reconcile against the lockfile, so every runtime
#     dependency must appear in the SBOM at the locked version. A mismatch is a supply-chain finding, not a note.
cat >"$tmp/reconcile.js" <<'ENDS_RECONCILE'
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const sbom = JSON.parse(fs.readFileSync(".agent/evidence/dependency-audit/sbom.cdx.json", "utf8"));
const components = new Map((sbom.components ?? []).map((component) => [component.name, component.version]));
const problems = [];
let matched = 0;
for (const name of Object.keys(pkg.dependencies ?? {})) {
  const locked = lock.packages[`node_modules/${name}`]?.version;
  const inSbom = components.get(name);
  if (inSbom === undefined) problems.push(`${name}@${locked} is absent from the SBOM`);
  else if (inSbom !== locked) problems.push(`${name}: SBOM holds ${inSbom} while the lockfile holds ${locked}`);
  else matched += 1;
}
if (problems.length > 0) {
  console.error("dependency audit: FAIL - the SBOM does not reconcile with the lockfile: " + problems.join("; "));
  process.exit(1);
}
console.log(`dependency audit: sbom reconciles with the lockfile (${matched} runtime component(s) matched at their locked versions)`);
ENDS_RECONCILE
node "$tmp/reconcile.js" || exit 1

echo "dependency audit: ok"
