#!/usr/bin/env sh
# EP-005 UI/client node gate.
#
# SCOPE, STATED HONESTLY: this gate verifies what can be verified without a provisioned browser runtime or a
# provisioned database: that the UI type-checks, that the layer import boundary holds, that the emitted route manifest
# equals the SPEC-004 declared route set, and that the credential-free contract suites pass. It does NOT verify
# lived-use accessibility, and it does NOT verify real-data flows. It says so in its own output on every run and never
# reports those as passing.
#
# A NOTE ON WHAT CHANGED FROM THE PLAN'S SKETCH, recorded rather than silently applied: the sketch named
# `ui/src/copy/truth-state.ts` and `ui/src/route-manifest.json` as its precondition files. The second exists from this
# milestone; the first arrives in M2 (the canonical truth-state module and the copy gate), so requiring it here would
# make this gate fail on the milestone that CREATES the foundation. The precondition is therefore the manifest only,
# and M2 extends this file to require the copy module when it lands — an edit in the milestone that owns the file.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "gate-ui: FAIL - node is required but not found" >&2; exit 1; }

[ -f ui/src/route-manifest.json ] || { echo "gate-ui: FAIL - route manifest is missing; run npm run build:web" >&2; exit 1; }
# THE CANONICAL TRUTH-STATE MAPPING, required from M2 onward. The plan's sketch required it in M1, when M1 was the
# milestone that would CREATE it; requiring a file in the milestone that creates it makes that milestone fail. M2 owns
# the file and adds the precondition here.
[ -f ui/src/copy/truth-state.ts ] || { echo "gate-ui: FAIL - the canonical truth-state mapping is missing" >&2; exit 1; }
# THE COVERAGE RENDERER, required from M3 onward. The contract suite proves the rendering rules by RENDERING this
# component, so a missing file fails there too; requiring it here as well means the failure names the file rather than
# surfacing as a module-not-found inside the harness.
[ -f ui/src/components/coverage/CoveragePanel.tsx ] || { echo "gate-ui: FAIL - the coverage renderer is missing" >&2; exit 1; }
[ -d ui/src/routes ] || { echo "gate-ui: FAIL - the route directory is missing" >&2; exit 1; }

npx --no-install tsc -p tsconfig.ui.json --noEmit || { echo "gate-ui: FAIL - UI typecheck failed" >&2; exit 1; }
# THE BROWSER SUITES ARE TYPECHECKED HERE, WITH THE DOM LIB, because they run in a browser and the root project has no
# DOM lib on purpose (see tsconfig.ui-tests.json). A Playwright spec that no gate type-checks is a spec whose selectors
# and API calls are only checked by running it.
npx --no-install tsc -p tsconfig.ui-tests.json --noEmit || { echo "gate-ui: FAIL - browser-suite typecheck failed" >&2; exit 1; }
sh scripts/import-boundary.sh || { echo "gate-ui: FAIL - layer import boundary violated" >&2; exit 1; }

node --test "tests/contract/**/*.test.ts" || { echo "gate-ui: FAIL - UI contract suites failed" >&2; exit 1; }

# THE COPY RULES ARE PART OF THIS NODE'S VERIFICATION (VG-UI-080…083), run here as well as by their own command so a
# vocabulary regression fails the node gate rather than only the standalone gate an author might not run.
sh scripts/copy-lint-gate.sh || { echo "gate-ui: FAIL - the copy-lint/vocabulary gate failed" >&2; exit 1; }

# THE MANIFEST MUST MATCH THE TREE, and the equality against SPEC-004 is asserted by the contract suite above; this
# re-emits it so a STALE committed file is caught here rather than by a reviewer reading a diff.
node scripts/emit-route-manifest.ts >/dev/null
if ! git diff --quiet -- ui/src/route-manifest.json; then
  echo "gate-ui: FAIL - ui/src/route-manifest.json is stale; run npm run build:web and commit it" >&2
  exit 1
fi

echo "gate-ui: UNVERIFIED-BY-THIS-GATE:"
echo "  - the browser suites themselves: this gate typechecks tests/ui/** and runs the credential-free contract suites, but it does NOT launch a browser. The browser stage is 'sh scripts/test-e2e.sh' with its own sentinel, and as of M4 it passes 28 tests against the built artefact (states, keyboard, axe over every declared route, reduced motion)."
echo "  - manual assistive-technology validation (VG-UI-064, DOD-039): EXTERNAL_REQUIRED, human participants only; automation cannot satisfy or substitute for this gate"
echo "  - real-data flows: BLOCKED_CREDENTIALS (DATABASE_URL, KEYCLOAK_ISSUER) and BLOCKED_PREREQUISITE (EP-003, EP-004)"

echo "gate-ui: ok"
