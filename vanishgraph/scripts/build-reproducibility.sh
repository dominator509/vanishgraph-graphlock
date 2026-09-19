#!/usr/bin/env sh
# Reproducibility of the declared artifact formats (SPEC-008 §3, DOD-003; EP-009 M1(c)). Sentinel: `artifact reproducible: ok`
#
# WHAT IT DOES: builds the declared formats TWICE into two separate output directories and requires them to
# agree. §7.2's rule, quoted in docs/release/supported-formats.md, is "byte-identical (or digest-identical,
# for formats with a documented non-determinism and a recorded reconciliation)".
#
# THE NON-DETERMINISM WAS MEASURED BEFORE THIS SCRIPT WAS WRITTEN, NOT ASSUMED: two `npm pack` runs over the
# same clean tree produced DIFFERENT container digests (AF06A7ACDBDFDE4C vs C28B7D726E771DC1), because a tar
# archive records file mtimes in its headers. So this script compares WHAT THE FORMAT CONTAINS and records the
# container-level difference as a reconciliation rather than pretending the containers are identical:
#
#   * the TARBALL is compared by CONTENT MANIFEST — the sorted entry list with a SHA-256 per entry — which is
#     the property a consumer depends on;
#   * the SBOM is compared after removing its volatile fields (a CycloneDX serial number and metadata
#     timestamp are identifiers OF a run, not content OF the dependency closure);
#   * PROVENANCE and CHECKSUMS are compared BYTE FOR BYTE, which is why the provenance record carries no
#     timestamp at all.
#
# THE RECONCILIATION IS RECORDED, NOT HIDDEN: the two container digests and the reason they differ are
# written into ARTIFACT_IDENTITY.json under `reproducibility`, and the sentinel is printed only when every
# comparison above matched. A format that cannot be made to match is removed from the declared set with a
# recorded rationale rather than left in it.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "artifact reproducible: FAIL - $1" >&2; exit 1; }
[ -f scripts/build-artifact.sh ] || fail "scripts/build-artifact.sh is missing"

# A CLEAN TREE IS REQUIRED FOR THE SAME REASON THE BUILD REQUIRES ONE: two builds of the same SOURCE, not two
# builds of two trees that happen to be adjacent in time.
[ -z "$(git status --porcelain)" ] || fail "the working tree is not clean, so the two builds would not be builds of the same source"

rm -rf dist-repro-a dist-repro-b
VG_DIST_DIR=dist-repro-a sh scripts/build-artifact.sh >/dev/null || fail "the first build failed"
VG_DIST_DIR=dist-repro-b sh scripts/build-artifact.sh >/dev/null || fail "the second build failed"

VERSION=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("package.json","utf8")).version)')
NAME=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("package.json","utf8")).name)')

# 1. THE TARBALL BY CONTENT MANIFEST.
for dir in dist-repro-a dist-repro-b; do
  rm -rf "$dir/extracted"
  mkdir -p "$dir/extracted"
  tar -xzf "$dir/${NAME}-${VERSION}.tgz" -C "$dir/extracted" || fail "could not extract $dir/${NAME}-${VERSION}.tgz"
  ( cd "$dir/extracted" && find . -type f | sed 's|^\./||' | sort | while IFS= read -r file; do
      node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$file"
      printf '  %s\n' "$file"
    done > "../content-manifest.txt" )
  [ -s "$dir/content-manifest.txt" ] || fail "$dir produced no content manifest"
done
cmp -s dist-repro-a/content-manifest.txt dist-repro-b/content-manifest.txt \
  || fail "the two tarballs contain DIFFERENT FILES; that is a content difference, not archive metadata"

# 2. THE SBOM AFTER REMOVING THE FIELDS THAT IDENTIFY A RUN RATHER THAN A DEPENDENCY CLOSURE.
node -e '
const fs = require("node:fs");
const [a, b] = process.argv.slice(1);
const canonical = (p) => {
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  delete d.serialNumber;
  if (d.metadata) delete d.metadata.timestamp;
  return JSON.stringify(d);
};
const one = canonical(a); const two = canonical(b);
if (one !== two) { console.error("the SBOM dependency closure differs between the two builds"); process.exit(1); }
process.stdout.write("sbom-identical\n");
' "dist-repro-a/${NAME}-${VERSION}.cdx.json" "dist-repro-b/${NAME}-${VERSION}.cdx.json" >/dev/null || fail "the SBOM is not reproducible"

# 3. PROVENANCE AND CHECKSUMS BYTE FOR BYTE.
cmp -s dist-repro-a/provenance.json dist-repro-b/provenance.json || fail "provenance.json differs between the two builds, and it carries no timestamp, so it must not"
cmp -s dist-repro-a/SHA256SUMS dist-repro-b/SHA256SUMS || fail "SHA256SUMS differs between the two builds"

DIGEST_A=$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "dist-repro-a/${NAME}-${VERSION}.tgz")
DIGEST_B=$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "dist-repro-b/${NAME}-${VERSION}.tgz")
ENTRIES_A=$(wc -l <dist-repro-a/content-manifest.txt | tr -d ' ')

# THE RECONCILIATION IS WRITTEN INTO THE IDENTITY FILE, so a reader of the artifact's identity sees BOTH the
# container digests AND why they may differ, instead of a single digest presented as "the" build.
node -e '
const fs = require("node:fs");
const [path, digestA, digestB, entries] = process.argv.slice(1);
const identity = JSON.parse(fs.readFileSync(path, "utf8"));
identity.reproducibility = {
  verdict: "CONTENT_IDENTICAL",
  content_manifest_entries: Number(entries),
  tarball_container_digests: { first_build: `sha256:${digestA}`, second_build: `sha256:${digestB}` },
  tarball_containers_identical: digestA === digestB,
  reconciliation: digestA === digestB ? "none needed: the two tarball containers are byte-identical" : "the two tarball CONTAINERS differ because a tar archive records file mtimes in its headers; the two CONTENT MANIFESTS are identical, which is the property a consumer depends on, and the difference is recorded here rather than presented as reproducibility of the container bytes",
  byte_identical_formats: ["dist/provenance.json", "dist/SHA256SUMS"],
  canonicalized_formats: [{ path: "dist/vanishgraph-<version>.cdx.json", removed_fields: ["serialNumber", "metadata.timestamp"] }],
  checked_at: "EP-009 M1"
};
fs.writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`);
' .agent/verification/state/ARTIFACT_IDENTITY.json "$DIGEST_A" "$DIGEST_B" "$ENTRIES_A"

rm -rf dist-repro-a dist-repro-b
echo "artifact reproducible: ok (content manifests identical over $(printf '%s' "$ENTRIES_A") entries; provenance and checksums byte-identical; container digests recorded with their reconciliation)"
