#!/usr/bin/env sh
# artifact identity -- verifies the §7.3 artifact identity against the bytes on disk.
#
# Implemented command (declared in COMMANDS.md): sh scripts/artifact-identity.sh
#
# SPEC BASIS: 6Layer-MasterPrompt-v3.1-GRAPHLOCK-FAILURE-PROOF.md, Section 10
# "Scripts", line 1357: placeholder scripts never pass silently. A script that
# prints a success sentinel without running the real check is a fabrication
# defect under DOD-024 (failure masking) and DOD-027 (fabricated success).
#
# ORIGINAL DEFECT (corrected here): this script previously printed a success sentinel unconditionally, with
# no check of any kind. It was then replaced by a loud-fail guard, because no artifact identity existed yet.
# An identity now exists (EP-009 M1), so the guard is replaced by the real check -- but a missing identity
# still FAILS (see the check below): absence must never pass quietly.
#
# WHAT IT VERIFIES, AND WHY EACH FIELD IS CHECKED RATHER THAN TRUSTED:
#   * every §7.3 field is POPULATED -- a missing field means a downstream stage cannot bind to the artifact
#     (DOD-004);
#   * every recorded artifact path EXISTS, is non-empty, and every recorded digest RESOLVES: recomputed from
#     the bytes on disk and compared with what the identity claims. A digest that is merely written down is a
#     claim; a digest that resolves is evidence;
#   * the SOURCE SURFACE -- every path the artifact is built from, derived from the package.json `files`
#     allowlist plus package.json itself -- is IDENTICAL between the recorded source commit, HEAD, and the
#     working tree. A plain "commit equals HEAD" test would be wrong in both directions: it would fail for the
#     ledger and evidence commits that legitimately move HEAD without touching the artifact, and it would pass
#     for a tree whose sources changed under an unchanged HEAD. Comparing the surface is what actually catches
#     a STALE identity -- an artifact described by a commit that no longer produces it;
#   * the states that are NOT ok -- an unsigned artifact and the absent OCI image -- are REPORTED, not turned
#     into a failure of this script, because they are recorded states with named next actions. The script
#     refuses to describe them as complete, and prints them as facts on its own output.
#
# THE CHECK LIVES IN A HEREDOC, NOT IN AN INLINE `node -e '...'`: an inline script is quoted by the shell, and
# an apostrophe anywhere in its own comments terminates that quoting and silently corrupts the program (this
# happened three times in this repository). A quoted heredoc is copied verbatim, so apostrophes and backticks
# in the program text cannot reach the shell at all.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

IDENTITY=.agent/verification/state/ARTIFACT_IDENTITY.json
fail() { echo "artifact identity: FAIL - $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "node is required but not found"
[ -f "$IDENTITY" ] || fail "$IDENTITY is missing; run sh scripts/build-artifact.sh first (an absent identity is never a pass)"

CHECK=$(mktemp) || fail "could not create a temporary file for the check"
trap 'rm -f "$CHECK"' EXIT INT TERM

cat >"$CHECK" <<'ENDS_ARTIFACT_IDENTITY_CHECK'
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");
const [identityPath] = process.argv.slice(2);
const problems = [];
const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
const isEmpty = (value) => value === undefined || value === null
  || (typeof value === "string" && value.trim() === "")
  || (Array.isArray(value) && value.length === 0)
  || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);

// The field list is written here rather than derived from the file, because a file cannot be trusted to
// declare what it is missing.
for (const field of ["source_commit_sha", "base_revision", "lockfile_digests", "builder_identity", "build_command", "artifact_paths", "artifact_digests", "sbom_reference", "provenance_reference"]) {
  if (isEmpty(identity[field])) problems.push(`the §7.3 field ${field} is missing or empty`);
}
for (const label of ["sbom_reference", "provenance_reference"]) {
  const value = identity[label];
  if (typeof value === "string" && value.trim() !== "" && !fs.existsSync(value)) problems.push(`${label} points at ${value}, which does not exist`);
}
for (const path of identity.artifact_paths || []) {
  if (!fs.existsSync(path)) problems.push(`artifact path ${path} does not exist`);
  else if (fs.statSync(path).size === 0) problems.push(`artifact path ${path} is empty`);
}
const digestOf = (p) => "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
let resolved = 0;
for (const [path, claimed] of Object.entries(identity.artifact_digests || {})) {
  if (!fs.existsSync(path)) { problems.push(`a digest is recorded for ${path}, which does not exist`); continue; }
  const actual = digestOf(path);
  if (actual !== claimed) problems.push(`the digest recorded for ${path} DOES NOT RESOLVE: recorded ${claimed}, recomputed ${actual}`);
  else resolved += 1;
}
for (const [path, claimed] of Object.entries(identity.lockfile_digests || {})) {
  if (!fs.existsSync(path)) { problems.push(`a lockfile digest is recorded for ${path}, which does not exist`); continue; }
  const actual = digestOf(path);
  if (actual !== claimed) problems.push(`the lockfile digest for ${path} does not resolve: recorded ${claimed}, recomputed ${actual}`);
  else resolved += 1;
}

// ANCESTRY RATHER THAN EQUALITY, AND NO SHELL METACHARACTERS: child_process.execSync runs through cmd.exe on
// Windows, where ^ is the escape character -- an earlier version of this check used git cat-file -e <sha>^{commit}
// and cmd.exe silently ate the ^, so the check reported "not a commit" for a commit that plainly existed. A
// wrong check that fails loudly is still a wrong check.
const head = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
try { execSync(`git merge-base --is-ancestor ${identity.source_commit_sha} HEAD`); }
catch { problems.push(`source_commit_sha ${identity.source_commit_sha} is not an ancestor commit of HEAD (${head}) in this repository`); }

// THE SOURCE SURFACE IS DERIVED, NOT LISTED: the package.json files allowlist decides what enters the
// package, and package.json is always part of it, so a change to the surface definition is itself a surface
// change and cannot silently shrink this comparison.
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const surface = [...(pkg.files || []).map((p) => p.replace(/\/$/, "")), "package.json"];
const git = (args) => execSync(`git ${args}`, { encoding: "utf8" }).trim();
const changed = git(`diff --name-only ${identity.source_commit_sha} HEAD -- ${surface.join(" ")}`);
if (changed !== "") problems.push(`the source surface changed after the artifact was built (${identity.source_commit_sha} -> ${head}): ${changed.split("\n").join(", ")} -- the identity is STALE and the artifact must be rebuilt`);
const dirty = git(`status --porcelain -- ${surface.join(" ")}`);
if (dirty !== "") problems.push(`the working tree has uncommitted changes under the source surface, so the artifact does not describe what is on disk: ${dirty.split("\n").join(", ")}`);

const builder = identity.builder_identity || {};
console.log(`identity: commit ${identity.source_commit_sha} (HEAD ${head}), builder ${builder.tool || "?"} ${builder.version || "?"}, ${(identity.artifact_paths || []).length} artifact path(s), ${resolved} digest(s) RESOLVED from the bytes on disk, source surface ${surface.length} path(s) identical`);
console.log(`build command: ${identity.build_command}`);
console.log(`reproducibility: ${(identity.reproducibility || {}).verdict || "NOT RECORDED"}${(identity.reproducibility || {}).tarball_containers_identical === false ? " (container bytes differ; the reconciliation is recorded in the same file)" : ""}`);
// THE STATES THAT ARE NOT OK ARE PRINTED, NOT HIDDEN, AND NOT DRESSED AS COMPLETE.
console.log(`signature: ${(identity.signature || {}).status || "NOT RECORDED"} - ${(identity.signature || {}).reason || ""}`);
console.log(`oci image: ${(identity.oci_image || {}).status || "NOT RECORDED"} - ${(identity.oci_image || {}).reason || ""}`);
console.log(`downstream test bindings: ${(identity.downstream_test_bindings || []).length} recorded (a stage that is not bound to this digest is not artifact-bound)`);
if (problems.length > 0) {
  console.log("problems:");
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log("verdict: OK (every field populated, every digest resolved, source surface identical to the recorded commit and to the working tree)");
ENDS_ARTIFACT_IDENTITY_CHECK

node "$CHECK" "$IDENTITY" || fail "the artifact identity did not validate; see the problems above"

echo "artifact identity: ok"
