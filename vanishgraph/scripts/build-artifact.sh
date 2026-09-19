#!/usr/bin/env sh
# Build the declared artifact formats (SPEC-008 §3/§7.2, EP-009 M1(b)). Sentinel: `artifact: built`
#
# WHAT IT PRODUCES, AND WHY EACH ONE EXISTS: see docs/release/supported-formats.md. Four formats, each
# with a digest: the `npm pack` tarball (the installable surface), a CycloneDX SBOM (the dependency
# closure), a provenance record (the §7.3 identity fields, WITH NO TIMESTAMP so the file itself is
# reproducible), and a checksums file covering every produced file.
#
# IT REFUSES TO BUILD FROM A DIRTY TREE. `git status --porcelain` must be empty: an artifact whose
# source tree contains uncommitted changes cannot be described by a commit SHA, and the §7.3 identity
# contract is exactly what makes an artifact-bound test meaningful (DOD-002, DOD-029).
#
# NOTHING IS SKIPPED TO REACH THE SENTINEL. Every declared format must exist and be non-empty, or the
# script exits non-zero without printing it. The OCI-image format is NOT produced here and is NOT
# claimed: docs/release/supported-formats.md records it BLOCKED_ON_IMPLEMENTATION with its reason.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

OUT=${VG_DIST_DIR:-dist}
mkdir -p "$OUT"

fail() { echo "artifact: FAIL - $1" >&2; exit 1; }
command -v node >/dev/null 2>&1 || fail "node is required but not found"
command -v npm >/dev/null 2>&1 || fail "npm is required but not found"
command -v git >/dev/null 2>&1 || fail "git is required but not found"

# THE CLEANLINESS CHECK IS ABOUT THE SOURCE, NOT ABOUT GENERATED FILES: this script writes dist/ and the
# identity file, so a tree that already contains them still has its SOURCE committed. Only the paths this
# build legitimately produces are filtered out, and nothing else.
DIRTY=$(git status --porcelain | grep -vE '(dist/|dist-repro-[ab]/|ARTIFACT_IDENTITY\.json$)' || true)
if [ -n "$DIRTY" ]; then
  echo "artifact: FAIL - the working tree is not clean, so the artifact could not be described by a commit SHA:" >&2
  printf '%s\n' "$DIRTY" | head -n 10 >&2
  exit 1
fi

COMMIT=$(git rev-parse HEAD)
VERSION=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("package.json","utf8")).version)')
NAME=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("package.json","utf8")).name)')
NODE_VERSION=$(node --version)
NPM_VERSION=$(npm --version)

rm -rf "$OUT"
mkdir -p "$OUT"

# 1. THE PACKAGE TARBALL.
npm pack --pack-destination "$OUT" >/dev/null 2>&1 || fail "npm pack failed"
TARBALL="$OUT/${NAME}-${VERSION}.tgz"
[ -s "$TARBALL" ] || fail "the tarball was not produced at $TARBALL"
[ "$(tar -tzf "$TARBALL" | wc -l)" -gt 0 ] || fail "the tarball is empty"

# 2. THE SBOM.
npm sbom --sbom-format cyclonedx >"$OUT/${NAME}-${VERSION}.cdx.json" 2>/dev/null || fail "npm sbom failed"
[ -s "$OUT/${NAME}-${VERSION}.cdx.json" ] || fail "the SBOM is empty"
node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); if(d.bomFormat!=="CycloneDX") { console.error("the SBOM is not CycloneDX"); process.exit(1);} if(!Array.isArray(d.components)||d.components.length===0){console.error("the SBOM carries no components");process.exit(1);}' "$OUT/${NAME}-${VERSION}.cdx.json" \
  || fail "the SBOM is not a usable CycloneDX document"

# 3. PROVENANCE, DETERMINISTIC BY CONSTRUCTION (no timestamp, no hostname, no path).
node -e '
const fs = require("node:fs");
const [out, commit, version, nodeVersion, npmVersion, name] = process.argv.slice(1);
const provenance = {
  artifact: name,
  version,
  source_commit: commit,
  builder: { tool: "node", version: nodeVersion },
  package_manager: { tool: "npm", version: npmVersion },
  build_command: "sh scripts/build-artifact.sh",
  formats: [
    { format: "PACKAGE_TARBALL", path: `dist/${name}-${version}.tgz` },
    { format: "SBOM_CYCLONEDX", path: `dist/${name}-${version}.cdx.json` },
    { format: "PROVENANCE", path: "dist/provenance.json" },
    { format: "CHECKSUMS", path: "dist/SHA256SUMS" }
  ],
  oci_image: { status: "BLOCKED_ON_IMPLEMENTATION", reason: "the repository contains no container build definition; see docs/release/supported-formats.md" }
};
fs.writeFileSync(out, `${JSON.stringify(provenance, null, 2)}\n`);
' "$OUT/provenance.json" "$COMMIT" "$VERSION" "$NODE_VERSION" "$NPM_VERSION" "$NAME"

# 4. CHECKSUMS OVER EVERY PRODUCED FILE except the checksum file itself.
( cd "$OUT" && rm -f SHA256SUMS && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | while IFS= read -r file; do
    node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$file"
    printf '  %s\n' "$file"
  done > SHA256SUMS )
[ -s "$OUT/SHA256SUMS" ] || fail "the checksums file is empty"

# THE §7.3 IDENTITY, WRITTEN FROM WHAT WAS ACTUALLY PRODUCED.
node -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const [out, tarball, sbom, commit, nodeVersion, npmVersion] = process.argv.slice(1);
const digest = (p) => `sha256:${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`;
const identity = {
  source_commit_sha: commit,
  base_revision: commit,
  lockfile_digests: { "package-lock.json": digest("package-lock.json") },
  builder_identity: { tool: "node", version: nodeVersion, package_manager: `npm@${npmVersion}` },
  build_command: "sh scripts/build-artifact.sh",
  artifact_paths: [tarball, sbom, "dist/provenance.json", "dist/SHA256SUMS"],
  artifact_digests: { [tarball]: digest(tarball), [sbom]: digest(sbom), "dist/provenance.json": digest("dist/provenance.json"), "dist/SHA256SUMS": digest("dist/SHA256SUMS") },
  sbom_reference: sbom,
  provenance_reference: "dist/provenance.json",
  signature: { status: "EXTERNAL_REQUIRED", reason: "no signing key or managed KMS exists in this environment (ADR-006 open); an unsigned artifact is recorded as unsigned rather than represented as signed" },
  oci_image: { status: "BLOCKED_ON_IMPLEMENTATION", reason: "no container build definition exists in this repository" },
  downstream_test_bindings: [],
  recorded_at_round: "EP-009 M1"
};
fs.writeFileSync(out, `${JSON.stringify(identity, null, 2)}\n`);
' "$OUT/ARTIFACT_IDENTITY.json" "$TARBALL" "$OUT/${NAME}-${VERSION}.cdx.json" "$COMMIT" "$NODE_VERSION" "$NPM_VERSION"

# THE PUBLISHED IDENTITY IS WRITTEN ONLY BY A CANONICAL BUILD. This was a measured defect, not a precaution: the
# reproducibility check builds twice into ${TMPDIR}/vg-repro-<pid>/{a,b}, and because those scratch builds ran
# from this same tree they each overwrote .agent/verification/state/ARTIFACT_IDENTITY.json with an identity whose
# artifact paths were scratch files that the run then deleted. The published identity described artifacts that no
# longer existed, and sh scripts/artifact-identity.sh caught exactly that. A scratch build now keeps its identity
# inside its own output directory and cannot publish.
if [ "$OUT" = "dist" ]; then
  mkdir -p .agent/verification/state
  cp "$OUT/ARTIFACT_IDENTITY.json" .agent/verification/state/ARTIFACT_IDENTITY.json
  echo "artifact: identity published to .agent/verification/state/ARTIFACT_IDENTITY.json"
else
  echo "artifact: identity kept inside $OUT (a scratch build does not publish, so the canonical identity stands)"
fi

for f in "$TARBALL" "$OUT/${NAME}-${VERSION}.cdx.json" "$OUT/provenance.json" "$OUT/SHA256SUMS"; do
  [ -s "$f" ] || fail "a declared format is missing or empty: $f"
done

echo "artifact: built ($(find "$OUT" -type f | wc -l | tr -d ' ') file(s) under $OUT; identity in $OUT/ARTIFACT_IDENTITY.json)"
