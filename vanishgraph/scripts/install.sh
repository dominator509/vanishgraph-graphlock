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
[ -f "$IDENTITY" ] || fail "$IDENTITY is missing; run sh scripts/build-artifact.sh first"

# `--dir <path>` is accepted because the published documentation uses it; the variable wins if both are given.
DEST=${VG_INSTALL_DIR:-}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) DEST=${2:-}; shift 2 ;;
    --dir=*) DEST=${1#--dir=}; shift ;;
    *) fail "unknown argument: $1 (accepted: --dir <path>, or VG_INSTALL_DIR)" ;;
  esac
done
DEST=${DEST:-${TMPDIR:-/tmp}/vanishgraph-install}

# 1. The pinned artifact and its digest, from the identity document.
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
if [ -d node_modules ]; then
  mkdir -p "$DEST/dependency-supply"
  # A junction/symlink keeps the lockfile-installed tree as the supply without copying it; the installed source
  # resolves `fastify`, `pg` and the rest exactly as the verified artifact did.
  if [ -e "$DEST/node_modules" ]; then rm -rf "$DEST/node_modules"; fi
  ln -s "$(pwd)/node_modules" "$DEST/node_modules" 2>/dev/null || cp -r node_modules "$DEST/node_modules"
  DEPENDENCY_SUPPLY="the lockfile-installed node_modules of this repository, linked into the install (offline environment)"
else
  DEPENDENCY_SUPPLY="none: node_modules is absent, so the installed package cannot start until dependencies are installed"
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
