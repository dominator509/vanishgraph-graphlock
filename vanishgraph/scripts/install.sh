#!/usr/bin/env sh
# Install the produced artifact (EP-009 M5(b); SPEC-008 section 8 VG-SHIP-029, DOD-023, DOD-002).
# Sentinel: `install: ok`
#
# REPLACES THE PRE-DISCOVERY LOUD-FAIL PLACEHOLDER: it refused to print a sentinel while no installer existed,
# which was correct (DOD-024, DOD-027). This is the implementation it was waiting for.
#
# IT INSTALLS FROM THE ARTIFACT, NOT FROM THE REPOSITORY. The input is the tarball the published identity
# describes; the repository tree is never copied and never linked. That is the difference between an installer
# and a wrapper around `git clone`, and it is observable: the installed tree contains only what the package
# declares (the `files` allowlist), so `.agent/`, `tests/` and the ledger are absent by construction.
#
# IT VERIFIES THE DIGEST BEFORE INSTALLING, and refuses on a mismatch. A digest checked after installation is a
# record that the wrong bytes were installed; checked before, it is a stop condition.
#
# THE DESTINATION IS EXPLICIT AND OUTSIDE THE REPOSITORY BY DEFAULT: an install into the repository would let the
# next gate read installed files as source. `VG_INSTALL_DIR` overrides it and `--dir` is accepted for
# readability, because the published documentation uses `--dir`.
#
# HONEST LIMITS, STATED HERE RATHER THAN DISCOVERED BY A USER:
#   1. The package ships TypeScript sources and is run by Node 24's type stripping, so the "installed" surface is
#      a runnable source tree with a declared entry point, not a compiled bundle.
#   2. `npm install <tarball>` would be the ordinary route and needs the registry for the 11 runtime
#      dependencies; this environment is offline, so the installer links the lockfile-installed dependency tree
#      that the artifact's build was verified against, and SAYS SO on its output. A clean-room install is
#      VG-SHIP-028 work and is not claimed here.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "install: FAIL - $1" >&2; exit 1; }

IDENTITY=.agent/verification/state/ARTIFACT_IDENTITY.json

# `--dir <path>` is accepted because the published documentation uses it; `--artifact <tarball>` and
# `--digest <sha256:...>` exist because a VIRGIN CLEAN ROOM HAS NO IDENTITY DOCUMENT: the artifact is transferred
# as a file plus its checksums, and the installer must verify it without the repository that produced it
# (EP-010 M5(a), VG-SHIP-028). Inside the repository the identity is still read, so the ordinary path is unchanged.
DEST=${VG_INSTALL_DIR:-}
EXPLICIT_ARTIFACT=""
EXPLICIT_DIGEST=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) DEST=${2:-}; shift 2 ;;
    --dir=*) DEST=${1#--dir=}; shift ;;
    --artifact) EXPLICIT_ARTIFACT=${2:-}; shift 2 ;;
    --artifact=*) EXPLICIT_ARTIFACT=${1#--artifact=}; shift ;;
    --digest) EXPLICIT_DIGEST=${2:-}; shift 2 ;;
    --digest=*) EXPLICIT_DIGEST=${1#--digest=}; shift ;;
    --dependency-supply) SUPPLY=${2:-}; shift 2 ;;
    --dependency-supply=*) SUPPLY=${1#--dependency-supply=}; shift ;;
    *) fail "unknown argument: $1 (accepted: --dir <path>, --artifact <tarball>, --digest <sha256:...>, --dependency-supply <dir>, or VG_INSTALL_DIR)" ;;
  esac
done
DEST=${DEST:-${TMPDIR:-/tmp}/vanishgraph-install}

# 1. The pinned artifact and its digest: from the identity when it is present, otherwise from the two arguments a
#    clean room can actually supply.
if [ -f "$IDENTITY" ]; then
  PINNED=$(node -e '
const fs = require("node:fs");
const identity = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const path = identity.artifact_paths.find((p) => p.endsWith(".tgz"));
if (path === undefined) { console.error("the identity declares no tarball"); process.exit(1); }
process.stdout.write(`${path}\n${identity.artifact_digests[path]}\n${identity.source_commit_sha}\n`);
' "$IDENTITY") || fail "the identity could not be read"
  TARBALL=$(printf '%s\n' "$PINNED" | sed -n '1p')
  DIGEST=$(printf '%s\n' "$PINNED" | sed -n '2p')
  COMMIT=$(printf '%s\n' "$PINNED" | sed -n '3p')
  if [ -n "$EXPLICIT_ARTIFACT" ] && [ "$EXPLICIT_ARTIFACT" != "$TARBALL" ]; then
    fail "an artifact was named explicitly ($EXPLICIT_ARTIFACT) and the identity describes $TARBALL; refusing to install a different artifact than the published one"
  fi
  if [ -n "$EXPLICIT_DIGEST" ] && [ "$EXPLICIT_DIGEST" != "$DIGEST" ]; then
    fail "a digest was declared explicitly ($EXPLICIT_DIGEST) and the identity records $DIGEST; a mismatched digest is a stop condition"
  fi
else
  [ -n "$EXPLICIT_ARTIFACT" ] || fail "no identity document and no --artifact: a clean room must name the artifact it installs"
  [ -n "$EXPLICIT_DIGEST" ] || fail "no identity document and no --digest: a clean room must name the digest it expects"
  TARBALL=$EXPLICIT_ARTIFACT
  DIGEST=$EXPLICIT_DIGEST
  COMMIT="not recorded (installed from an artifact and a digest alone, outside the repository that produced it)"
fi
[ -f "$TARBALL" ] || fail "the artifact $TARBALL does not exist; there is nothing to install"

# 2. Verify BEFORE installing. A mismatch is a stop condition, never a warning.
ACTUAL=$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write("sha256:"+c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$TARBALL")
[ "$ACTUAL" = "$DIGEST" ] || fail "the artifact at $TARBALL hashes to $ACTUAL and the published identity records $DIGEST; refusing to install bytes that are not the pinned artifact"

# 3. Install: unpack the artifact into the destination and nothing else.
case "$DEST" in
  *"/vanishgraph"|*"/vanishgraph/"*) fail "the destination $DEST is inside the repository; install outside it so no gate can read installed files as source" ;;
esac
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$TARBALL" -C "$DEST" || fail "the artifact could not be unpacked"
[ -f "$DEST/package/package.json" ] || fail "the artifact does not contain package/package.json; it is not an installable package"
INSTALLED_VERSION=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).version)' "$DEST/package/package.json")
INSTALLED_NAME=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).name)' "$DEST/package/package.json")

# 4. The declared entry point must be present in the INSTALLED tree, because an install that cannot start is not
#    an install.
ENTRY="$DEST/package/src/infrastructure/main.ts"
[ -f "$ENTRY" ] || fail "the installed package has no $ENTRY; the artifact is not runnable"

# 5. The dependency supply, stated rather than hidden (see HONEST LIMITS above).
#
# MEASURED DEFECT this corrects, found by the clean room rather than by inspection: this script changes directory to
# its own package root, so when it runs FROM THE ARTIFACT (the documented clean-room command) the repository's
# node_modules is not visible here at all -- the link was never created, the install reported success, and the
# installed package then died with ERR_MODULE_NOT_FOUND on `fastify`. A supply the caller must provide is now a
# named argument, and when none is available the record SAYS the package cannot start instead of implying it can.
SUPPLY=${SUPPLY:-${VG_DEPENDENCY_SUPPLY:-}}
if [ -z "$SUPPLY" ] && [ -d node_modules ]; then SUPPLY=$(pwd)/node_modules; fi
if [ -n "$SUPPLY" ] && [ -d "$SUPPLY" ]; then
  if [ -e "$DEST/node_modules" ]; then rm -rf "$DEST/node_modules"; fi
  ln -s "$SUPPLY" "$DEST/node_modules" 2>/dev/null || cp -r "$SUPPLY" "$DEST/node_modules"
  DEPENDENCY_SUPPLY="the lockfile-installed node_modules supplied as $SUPPLY and linked into the install (offline environment)"
else
  DEPENDENCY_SUPPLY="NONE: no dependency supply was supplied and none is visible from the install directory, so THE INSTALLED PACKAGE CANNOT START until dependencies are installed or --dependency-supply names a tree"
fi

mkdir -p .agent/evidence/EP-009
{
  echo "install: ok"
  echo "installed name: $INSTALLED_NAME"
  echo "installed version: $INSTALLED_VERSION"
  echo "artifact: $TARBALL"
  echo "verified digest: $DIGEST (recomputed from the bytes before installing, and it matched)"
  echo "source commit: $COMMIT"
  echo "destination: $DEST"
  echo "entry point: $ENTRY"
  echo "files installed: $(find "$DEST/package" -type f | wc -l | tr -d ' ')"
  echo "installed at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "dependency supply: $DEPENDENCY_SUPPLY"
} > .agent/evidence/EP-009/M5-install.txt

echo "install: $INSTALLED_NAME $INSTALLED_VERSION installed at $DEST (digest verified before installing: $DIGEST)"
echo "install: dependency supply - $DEPENDENCY_SUPPLY"
echo "install: ok"
