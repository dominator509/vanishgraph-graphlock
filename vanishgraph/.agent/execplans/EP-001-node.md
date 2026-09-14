NODE-META-BEGIN
ID: EP-001
DEPS: EP-000
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/gate-foundation.sh
VERIFY_SENTINEL: gate-foundation: ok
GREEN_TAG: green/EP-001
NODE-META-END

# EP-001 — Foundation

## 1. Purpose / Big Picture

Make the repository's foundation real and *falsifiable*: one locked dependency set,
one working unit-test entry point, real static/format/environment/supply-chain gates
in place of loud-fail placeholders, a CI workflow that can actually go red, and a
node gate (`scripts/gate-foundation.sh`) that proves all of it in one run.

The end state is concrete and observable: `sh scripts/verify.sh` advances through
`preflight`, `lint`, `format-check`, `typecheck` and `unit`, and stops at the first
stage whose real implementation genuinely does not exist yet (`integration`), with
the mandated loud-fail `ERROR:` line and **no** `verify: ok`. This node is
foundation only: it makes every gate honest, not the product complete.

This node is **resume-oriented**. EP-000 was executed in part before this plan was
authored, so several foundation artifacts already exist. Every milestone below
starts with an executed confirmation of what is already true and creates only what
is missing. A cold executor must never re-create real work, and must never assume
work that has not been executed.

## 2. Scope

In scope:

- Package manager confirmed as `npm` with a **committed** `package-lock.json`, exact
  pinned devDependencies, `engines.node >= 24`, ESM (`"type": "module"`) and the
  existing strict `tsconfig.json` confirmed rather than re-created (DOD-002).
- The declared unit-test entry point fixed so it actually runs (`node --test tests/`
  does not work on this platform — see §4).
- Real `lint`, `typecheck`, `unit`, `build`, `test-collection-guard` gates confirmed
  or completed, and the two EP-001-labelled placeholders replaced with real gates:
  `format-check.sh`, `dependency-audit.sh`, `reality-gate.sh`.
- A test-collection guard that **fails when zero tests are collected** (DOD-007),
  proven by a negative self-test, plus an expected-suite manifest.
- A baseline CI workflow at the repository root that runs the real gates with no
  `continue-on-error`, no `|| true`, and no ignored exit codes (DOD-024).
- `.gitignore` confirmed to keep credentials out and evidence in.
- Environment validation driven by the `PREFLIGHT.md` table, reporting missing
  credentials as `BLOCKED_CREDENTIALS` (dependent work only), never as a silent pass.
- Harness self-tests: real unit tests that assert the gate scripts can fail.
- `scripts/gate-foundation.sh`, the node-level verify for this node, including the
  `verify.sh` stage-progression proof.

Out of scope (see §3): the domain layer (EP-002), persistence (EP-003), any
application/API/UI work, any credential provisioning, any deployment.

## 3. Non-goals

- No domain, application, adapter, HTTP, UI, or persistence implementation. EP-002
  and EP-003 own those; a foundation node that grows domain code is a scope breach.
- No new runtime dependency, no dependency swap, no package-manager change away from
  the committed lockfile, no reformatting beyond line-ending normalization (§M2).
- No credential provisioning, no cloud/KMS/Keycloak/Temporal/Valkey/object-store
  setup, no `.env` creation. Missing credentials stay `BLOCKED_CREDENTIALS`.
- **No claim that `sh scripts/verify.sh` passes.** It cannot pass in this node, and
  printing `verify: ok` before the artifact stages exist would be a fabrication
  defect (DOD-024, DOD-027, VG-SHIP-033).
- No production deployment (VG-SCOPE-009, manual only).
- No gate weakening: no stage removed from `verify.sh`, no stage reordered, no
  sentinel printed from a path that performed no check, no manifest entry deleted to
  make the collection guard pass.
- No unrelated cleanup, renaming, or reorganization of pack-authored documents.

## 4. Context and Orientation

Read this before touching anything; it is the state as measured when this plan was
authored, and every claim in it is re-checked in M1.

**Layout.** The git repository root is the parent directory (`C:\dev\vanishgraph-graphlock`,
remote `dominator509/vanishgraph-graphlock`); the project root is `vanishgraph/`. All
commands in `COMMANDS.md` and all scripts run from the **project root** (`vanishgraph/`);
every script does `cd "$(dirname "$0")/.."`. GitHub Actions only reads workflows from the
**repository** root, so the CI file lives at `../.github/workflows/ci.yml` relative to the
project root and every step sets `working-directory: vanishgraph`.

**Toolchain measured in this environment** (`node --version` etc.):

| Tool | Version |
|---|---|
| node | v24.14.1 |
| npm | 11.11.0 |
| git | 2.55.0.windows.2 |
| docker (client and reachable daemon) | 29.7.2 |
| psql | 16.14 |
| python3 | 3.14.4 |

TypeScript 5.9.3 and `@types/node` 24.10.1 are pinned exactly as devDependencies;
there are no runtime dependencies. Node ≥ 24 strips TypeScript types natively, which is
why the domain layer needs no build step to be tested.

**What already exists and is real** (confirmed by execution at authoring time; re-confirm
in M1 — a parallel agent may have advanced it):

- `package.json` (`type: module`, `engines.node >= 24`, exact-pinned devDeps),
  `package-lock.json`, `tsconfig.json` (strict, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`,
  `allowImportingTsExtensions`), `tsconfig.build.json`.
- Real gates: `scripts/preflight.sh` (`preflight: ok`), `scripts/typecheck.sh`
  (`typecheck: ok`), `scripts/import-boundary.sh` (`import boundary: ok`),
  `scripts/lint.sh` (`lint: ok`), `scripts/test-unit.sh` (`test-unit: ok`),
  `scripts/test-collection-guard.sh` + `scripts/count-tests.mjs`
  (`test collection guard: ok`, JUnit input), `scripts/build.sh` (`build: ok`),
  `scripts/gate-toolchain.sh` (`gate-toolchain: ok`),
  `.agent/verification/EXPECTED_TEST_MANIFEST.txt`.
- `src/domain/{errors,truth-state,state-machine,values}.ts` and
  `tests/domain/{state-machine,values}.test.ts`; `node --test "tests/**/*.test.ts"`
  collects **94 passing tests, 0 failures, 0 skipped**; `sh scripts/build.sh`,
  `sh scripts/test-collection-guard.sh` and `sh scripts/gate-toolchain.sh` all exit 0.
- `.gitignore` already ignores `node_modules/`, `dist/`, `.env`, `.env.*`, `*.pem`,
  `*.key`, logs — and deliberately does **not** ignore `.agent/evidence/` (DOD-025).

**What is broken or still a placeholder** (verified by execution, not by reading):

1. `package.json` → `"test:unit": "node --test tests/"` **fails** with
   `MODULE_NOT_FOUND` on this platform: Node treats the directory argument as a module
   path. `sh scripts/test-unit.sh` uses the working form
   `node --test "tests/**/*.test.ts"`. The declared npm script and the real command
   disagree, so `npm run test:unit` is a false entry point today.
2. `sh scripts/verify.sh` currently runs `preflight: ok`, then `lint: ok`
   (`typecheck: ok`, `import boundary: ok`), then **fails at stage `format-check`** with
   `ERROR: format check is an unimplemented placeholder; replaced during EP-000 discovery milestone M1; see .agent/execplans/EP-000-node.md; unblocked by EP-001`.
   It therefore never reaches `typecheck`, `unit`, `integration`, …, and never prints
   `verify: ok`. `scripts/verify.sh` requires the **full fifteen-stage order** fixed by
   the master prompt (§10 Scripts, line 1357): preflight, lint, format-check, typecheck,
   unit, integration, security-check, dependency-audit, reality-gate,
   test-collection-guard, build, artifact-identity, artifact-bound smoke, artifact-bound
   E2E, artifact-bound live-fire. The last five stages require a built artifact
   (EP-009/EP-010), so no node before then can honestly print `verify: ok`.
3. Loud-fail placeholders whose own text names EP-001 as the unblocking node:
   `scripts/format-check.sh`, `scripts/dependency-audit.sh`, `scripts/reality-gate.sh`.
   (`scripts/security-check.sh` names EP-006; `test-integration.sh` names EP-002 but the
   real dependency is PostgreSQL from EP-003 — see §7; `artifact-identity.sh`/`smoke-test.sh`
   name EP-009; `test-e2e.sh` EP-005; `live-fire.sh` EP-010.)
4. `COMMANDS.md` declares seven commands while the graph actually runs the fifteen
   `verify.sh` stages plus the individual gates. Undeclared commands are a governance
   defect under the pack's command lock, so this node reconciles the registry.
5. Five files carry CRLF line endings (`scripts/ledger.sh`, `scripts/graph-next.sh`,
   `scripts/anti-gaming-scan.py`, `scripts/materialize-atomic-sources.sh`,
   `scripts/validate-generated-pack.py`), which a real format gate must either fix or
   explicitly exempt. This plan fixes them (content-preserving).
6. No CI workflow exists at the repository root at authoring time.
7. `node --test` exits **0** when a glob collects zero tests (measured:
   `--test-reporter=junit` emits `<testsuites>` with zero `<testcase>` elements and exit
   status 0). That is precisely why the collection guard must fail on zero collection
   (DOD-007) instead of trusting the runner's exit code.

**Node verify choice, stated honestly.** The stub header for every node declared
`VERIFY: sh scripts/verify.sh` / `VERIFY_SENTINEL: verify: ok`. That is unreachable
before EP-009 (artifact-bound stages) and keeping it would pressure an executor to fake a
green. EP-000 already narrowed its own node verify to `sh scripts/gate-toolchain.sh` for
the same reason. This node therefore declares `VERIFY: sh scripts/gate-foundation.sh` /
`gate-foundation: ok`, and M7 makes that gate *assert the real progression of
`verify.sh`* — that the five implemented stages pass and that the first unimplemented
stage fails loudly. Nothing is removed from `verify.sh`; the stage order is untouched.

## 5. Files to Read First

Governance and law (read in full before the first edit):

- `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`
- `.agent/EXECUTION_RULES.md`, `.agent/PLANS.md`
- `.agent/DONE_LAW.md` — especially DOD-002, DOD-005, DOD-006, DOD-007, DOD-018,
  DOD-021, DOD-024, DOD-025, DOD-026, DOD-027, DOD-033
- `.agent/execplans/EP-000-node.md` (the node this one depends on)

Specifications and project documents:

- `.agent/specs/SPEC-000-product-scope.md` (§4 vocabulary lock, §9 acceptance oracle)
- `.agent/specs/SPEC-008-production-readiness.md` (§3 epochs, §10 no-masking, §13 status)
- `.agent/specs/SPEC-001-core-domain.md` (§1 layer contract — the law `lint` enforces)
- `PREFLIGHT.md`, `ENVIRONMENT.md`, `TESTING.md`, `SECURITY.md`, `ARCHITECTURE.md`
- `PRODUCTION_READINESS.md`, `RELEASE.md`, `ROLLBACK.md`, `LICENSE_POLICY.md`

Harness and verification:

- `.agent/verification/HARNESS_LAWS.md`, `.agent/verification/CAPABILITY_MATRIX.md`
- `.agent/verification/TEST_ENVIRONMENT_MANIFEST.md`
- `.agent/verification/DOD_REGISTRY.csv`, `.agent/verification/EXPECTED_TEST_MANIFEST.txt`
- `.agent/reality-patterns`, `.agent/reality-allow`
- `.agent/checklists/agent-readiness.md`, `.agent/checklists/preflight.md`,
  `.agent/checklists/implementation.md`, `.agent/checklists/validation.md`

State:

- `.agent/state/LEDGER.md`, `.agent/verification/state/RUN_STATE.json`,
  `.agent/verification/state/RELEASE_GATE.json`

Code and gates (read every one before editing any of them):

- `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore`
- `scripts/verify.sh`, `scripts/lib/loud-fail.sh`, `scripts/ledger.sh`, `scripts/graph-next.sh`
- `scripts/preflight.sh`, `scripts/lint.sh`, `scripts/format-check.sh`,
  `scripts/typecheck.sh`, `scripts/test-unit.sh`, `scripts/test-collection-guard.sh`,
  `scripts/count-tests.mjs`, `scripts/import-boundary.sh`, `scripts/build.sh`,
  `scripts/dependency-audit.sh`, `scripts/reality-gate.sh`, `scripts/gate-toolchain.sh`
- `src/domain/*.ts`, `tests/domain/*.test.ts`

## 6. Expected Changed Files

Paths are relative to the project root (`vanishgraph/`) unless marked
*(repository root)*. This list is the audit list: **nothing else may change.** Any other
diff is a scope violation and must be reverted, not rationalized.

Created:

- `scripts/validate-env.sh`
- `scripts/gate-foundation.sh`
- `tests/harness/gate-scripts.test.ts`
- `../.github/workflows/ci.yml` *(repository root)*
- `.agent/evidence/EP-001/**` (evidence transcripts, digests, evidence index)
- `.agent/evidence/dependency-audit/**` (SBOM and its digest)

Modified (replacing a loud-fail placeholder or reconciling declared state):

- `scripts/format-check.sh` (placeholder → real gate)
- `scripts/reality-gate.sh` (placeholder → real gate)
- `scripts/dependency-audit.sh` (placeholder → real gate)
- `scripts/test-collection-guard.sh` (add the `VG_TEST_GLOB` override used by the
  zero-collection negative self-test; no other behaviour change)
- `package.json` (`test:unit` corrected; `format-check`, `reality-gate`,
  `dependency-audit`, `gate-foundation` npm entry points aligned with the shell gates)
- `COMMANDS.md` (every gate command and its sentinel declared)
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt` (new suite added)
- `ENVIRONMENT.md` (locked toolchain and package-manager record)
- `TESTING.md` (real test commands, DOD-007 and DOD-018 hooks, double boundaries)
- `ARCHITECTURE.md` (only if the locked toolchain table is absent; otherwise unchanged)
- `.agent/state/LEDGER.md` (ledger events appended by `scripts/ledger.sh`)
- Line-ending normalization only: `scripts/ledger.sh`, `scripts/graph-next.sh`,
  `scripts/anti-gaming-scan.py`, `scripts/materialize-atomic-sources.sh`,
  `scripts/validate-generated-pack.py`
- `.gitignore` (only if a required entry from M2 is missing)

Explicitly not changed: `scripts/verify.sh` (no stage added, removed, or reordered),
`RELEASE_GATE.json` (verdict stays `INCONCLUSIVE`), `.agent/GRAPH.md`,
`.agent/LOOPS.md`, `.env.example` (unless M3 proves a genuine PREFLIGHT mismatch, which
is then recorded as a finding).

## 7. Interfaces and Contracts

Vocabulary (SPEC-000 §4) is binding for every identifier, log line, metric name, ledger
entry, and test name. Canonical tokens only: `ProtectedSubject`, `AuthorityGrant`,
`Source`, `RemovalRecipe`, `SourceRecord`, `Exposure`, `Confidence`, `PolicyDecision`,
`RequestCase`, `ExternalAction`, `IdempotencyKey`, `VerificationObservation`,
`Reappearance`, `EvidenceArtifact`, `Controller`, `HumanGate`, `DLP`. Forbidden synonyms
(`client`, `target`, `victim`, `user_profile`, `consent`, `permission`, `approval`,
`site`, `vendor`, `provider`, `scraper`, `bot`, `automation`, `hit`, `listing`, `result`,
`lead`, `match`, `finding`, `compromise`, `score`, `probability`, `certainty`, `ruling`,
`verdict`, `ticket`, `job`, `task`, `request`, `submission`, `dedupe_key`, `nonce`,
`check`, `recheck`, `confirmation`, `relapse`, `regression`, `attachment`, `file`,
`screenshot`, `broker`, `company`, `entity`, `blocker`, `captcha_wall`, `sanitizer`,
`cleaner`) must not appear as identifiers in code, scripts, or gate output. Gate *prose*
may describe them when explaining a rule.

Truth states are reserved: the eleven SPEC-000 §5 states are the only terminal-status
vocabulary. `DONE`, `COMPLETE`, `SUCCESS`, `REMOVED` are prohibited as statuses;
`HUMAN_REQUIRED` and `NOT_REMOVABLE` are legitimate outcomes, not failures.

Gate-script contract (master prompt §10, line 1357), which every script in this node
must satisfy:

- `#!/usr/bin/env sh`, `set -eu`, POSIX-clean (`sh -n` passes, no bashisms), run from
  the project root via `cd "$(dirname "$0")/.."`.
- `export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive`.
- Print the exact sentinel **only** on genuine success, as the last line, and exit 0.
  On failure: a specific message on stderr, exit non-zero, and **no** sentinel.
- Distinguish a candidate FAIL from a harness ERROR in the message text (DOD-032).
  Unavailable network, missing credentials, or an unprovisioned service are harness
  conditions (`ERROR`, `BLOCKED_*`), never passes and never candidate failures.
- Placeholder scripts keep the mandated loud-fail signature and never pass silently
  (VG-SHIP-033). Only a milestone that implements a real check replaces one.

Command lock: every command this node runs must be declared in `COMMANDS.md`. A
milestone that introduces a command updates `COMMANDS.md` in the same commit, and names
that fact in `CHANGE`. `COMMANDS.md` stays the single registry; no undocumented helper
invocation may be load-bearing. `RUN` entries that are pure discovery (`git status`,
`node --version`, `find`, `grep`, `awk`) are observations, not gates, and do not need
registry entries; every gate command does.

Node-verify contract: `sh scripts/gate-foundation.sh` prints `gate-foundation: ok` only
when every sub-gate prints its own sentinel, the collection guard's zero-collection
negative self-test fails as required, `sh scripts/verify.sh` is proven to advance through
`preflight`/`lint`/`format-check`/`typecheck`/`unit`, and `verify: ok` provably does not
appear. `gate-foundation.sh` must not print `verify: ok` and must not claim any stage it
did not run.

Honesty rules carried into every milestone: no permanent-deletion claims; search
(`SEARCH_DELISTED`) and source removal are separate effects; `HUMAN_REQUIRED` is a
legitimate outcome, not a failure; no result may be reported that was not produced in
this session by an executed command.

## 8. Milestones

Each milestone is completed in order: read, change only the listed paths, run the listed
commands, compare against `EXPECT`, append the ledger event, commit. If `EXPECT` is not
met, climb the 5.3 ladder (targeted fix → diagnosis → the declared `FALLBACK` → rollback
→ the 5.7 structured block). Never repeat the same fix twice; never weaken a gate to get
a pass; never reuse a previous session's sentinel as this session's evidence.

### M1: Resume inventory, package manager and commit-locked dependencies

GOAL: An executed inventory states exactly which EP-000 foundation artifacts exist, and
`npm run test:unit` becomes a working entry point backed by the committed lockfile.

READ: `AGENTS.md`, `COMMANDS.md`, `.agent/execplans/EP-000-node.md`, `.agent/DONE_LAW.md`
(DOD-002, DOD-007, DOD-021, DOD-024), `package.json`, `package-lock.json`, `tsconfig.json`,
`tsconfig.build.json`, `ENVIRONMENT.md`, `.agent/state/LEDGER.md`.

CHANGE: `package.json`; `COMMANDS.md` (add the toolchain-command block); `ENVIRONMENT.md`;
`.agent/evidence/EP-001/` (inventory transcript). Nothing else.

CONTENT:

(a) Run the discovery commands first and paste their real output into
`.agent/evidence/EP-001/M1-inventory.txt` (create the directory with `mkdir -p`):

```sh
git rev-parse --show-toplevel
git status --porcelain=v1
node --version; npm --version; git --version; docker --version; psql --version; python3 --version
git ls-files --error-unmatch package-lock.json && echo "lockfile: TRACKED"
node -e "const c=require('node:crypto'),f=require('node:fs');console.log('lockfile sha256:',c.createHash('sha256').update(f.readFileSync('package-lock.json')).digest('hex'))"
ls -1 scripts/*.sh scripts/*.mjs | sort
sh scripts/ledger.sh status EP-000
```

(b) Replace `package.json` with exactly this body (the only behavioural change is the
corrected `test:unit` command and the added gate entry points; the dependency set stays
exactly pinned, and `<OBSERVED_NPM_VERSION>` is filled from `npm --version` in (a)):

FILE: package.json   (MODIFY — full replacement)
```json
{
  "name": "vanishgraph",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "VanishGraph Privacy Removal OS - evidence-first, multi-tenant privacy removal service. See PROJECT_BRIEF.md and .agent/specs/SPEC-000-product-scope.md.",
  "engines": {
    "node": ">=24.0.0"
  },
  "packageManager": "npm@<OBSERVED_NPM_VERSION>",
  "scripts": {
    "typecheck": "sh scripts/typecheck.sh",
    "lint": "sh scripts/lint.sh",
    "format-check": "sh scripts/format-check.sh",
    "build": "sh scripts/build.sh",
    "test:unit": "node --test \"tests/**/*.test.ts\"",
    "test:collection-guard": "sh scripts/test-collection-guard.sh",
    "reality-gate": "sh scripts/reality-gate.sh",
    "dependency-audit": "sh scripts/dependency-audit.sh",
    "gate:foundation": "sh scripts/gate-foundation.sh",
    "verify": "sh scripts/verify.sh"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "@types/node": "24.10.1"
  }
}
```

(c) Append this block to the end of `COMMANDS.md` (anchored edit: take the current last
line, which ends with `Coding agents must not invent commands.`, and add the block after
it; verify with `grep -c 'npm ci' COMMANDS.md` returning at least `1`):

FILE: COMMANDS.md   (MODIFY — append only, keep the existing header and text)
```
Toolchain (Node >= 24, npm, from the project root): `npm ci`; `npm run test:unit`;
`npm run gate:foundation`. These are the only package-manager entry points; the gates
themselves are the `sh scripts/*.sh` commands above.
```

RUN:

```sh
mkdir -p .agent/evidence/EP-001
{ git rev-parse --show-toplevel; git status --porcelain=v1; node --version; npm --version; \
  git --version; docker --version; psql --version; python3 --version; \
  git ls-files --error-unmatch package-lock.json && echo "lockfile: TRACKED"; \
  node -e "const c=require('node:crypto'),f=require('node:fs');console.log('lockfile sha256:',c.createHash('sha256').update(f.readFileSync('package-lock.json')).digest('hex'))"; \
  ls -1 scripts/*.sh scripts/*.mjs | sort; sh scripts/ledger.sh status EP-000; } 2>&1 | tee .agent/evidence/EP-001/M1-inventory.txt
sh scripts/test-unit.sh
npm run test:unit
sh scripts/test-collection-guard.sh
git status --porcelain=v1
```

EXPECT: `.agent/evidence/EP-001/M1-inventory.txt` exists and contains `lockfile: TRACKED`
and a `lockfile sha256: <64 hex>` line; `sh scripts/test-unit.sh` prints `test-unit: ok`
last and exits 0; `npm run test:unit` exits 0 and its summary shows `pass` with a count
greater than zero (the authoring-time measurement was 94; the number may only grow); `sh
scripts/test-collection-guard.sh` prints `test collection guard: ok` last and its JSON
line reports `"tests":<n>` with `n > 0` and `"fail":0`; `git status --porcelain=v1` lists
only paths from §6.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-001 MILESTONE_PASS "M1 lockfile tracked; test-unit: ok; test collection guard: ok"`

FALLBACK: if `npm ci` is required as local proof and the registry is unreachable, do not
fake it — record `BLOCKED_NETWORK` for the local install, keep the lockfile-committed and
`npm ls --depth=0` checks, and let M6's CI job (where the registry is reachable) provide
the clean-install evidence DOD-002 requires.

COMMIT: `git add -A && git commit -m "[EP-001][M1] confirm locked npm toolchain and fix the declared unit command"`

### M2: Real format gate and line-ending normalization

GOAL: `sh scripts/format-check.sh` performs a real, failing-capable format check and the
five CRLF files are normalized to LF with no content change.

READ: `scripts/format-check.sh`, `scripts/lib/loud-fail.sh`, `.gitignore`,
`scripts/verify.sh` (stage order), `.agent/DONE_LAW.md` (DOD-021, DOD-024, DOD-027),
`COMMANDS.md`.

CHANGE: `scripts/format-check.sh` (replacement); `scripts/ledger.sh`,
`scripts/graph-next.sh`, `scripts/anti-gaming-scan.py`,
`scripts/materialize-atomic-sources.sh`, `scripts/validate-generated-pack.py`
(line endings only); `COMMANDS.md` (declare the command and sentinel).

CONTENT:

FILE: scripts/format-check.sh   (REPLACE the loud-fail placeholder with this complete body)
```sh
#!/usr/bin/env sh
# Format check stage. Sentinel: `format-check: ok`
#
# Replaces the pre-discovery loud-fail placeholder (EP-001 milestone M2).
#
# Scope: files this project authors. Pack-authored narrative documents and the
# vendored verification source library are out of scope, and are listed explicitly
# below so the exclusion set cannot grow silently.
#
# The check is deliberately dependency-free: the repository's only devDependencies
# are typescript and @types/node, and adding a formatter would add supply-chain
# surface for a property that is checkable with POSIX tools. It fails on: CRLF line
# endings, a UTF-8 BOM, trailing whitespace, tab indentation in source, a missing
# final newline, and JSON files that do not parse.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "format-check: FAIL - $1" >&2; exit 1; }

[ -d src ] || fail "src/ is missing"
[ -d tests ] || fail "tests/ is missing"
[ -d scripts ] || fail "scripts/ is missing"

# Files in scope: everything this project authors plus the root JSON configuration.
files=$(find src tests scripts -type f \( -name '*.ts' -o -name '*.mjs' -o -name '*.sh' -o -name '*.py' \) -print | sort)
for j in *.json; do
  [ -f "$j" ] && files="${files}
${j}"
done
[ -n "$files" ] || fail "the format scope matched no files; the check would be vacuous"

cr=$(printf '\r')
tab=$(printf '\t')
violations=""

for f in $files; do
  [ -f "$f" ] || continue
  case "$f" in
    # Byte-stable inputs are exempt from whitespace normalization only. They remain
    # in scope for the JSON parse check (not applicable) and for CRLF detection.
    node_modules/*|dist/*) continue ;;
  esac
  if [ "$(head -c 3 "$f" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ]; then
    violations="${violations}  - ${f}: UTF-8 BOM present
"
  fi
  if grep -q "$cr" "$f" 2>/dev/null; then
    violations="${violations}  - ${f}: CRLF line ending (normalize to LF)
"
  fi
  if grep -q '[[:space:]]$' "$f" 2>/dev/null; then
    violations="${violations}  - ${f}: trailing whitespace
"
  fi
  if grep -q "$tab" "$f" 2>/dev/null; then
    violations="${violations}  - ${f}: tab character (this project indents with spaces)
"
  fi
  if [ -n "$(tail -c 1 "$f")" ]; then
    violations="${violations}  - ${f}: missing final newline
"
  fi
done

if [ -n "$violations" ]; then
  echo "format-check: FAIL - formatting violations:" >&2
  printf '%s' "$violations" >&2
  echo "Fix the files listed above. Do not add them to an exemption list to obtain a pass (DOD-027)." >&2
  exit 1
fi

# JSON configuration must parse. This catches a truncated or hand-edited lockfile,
# which would otherwise fail much later inside npm with a confusing message.
for j in *.json; do
  [ -f "$j" ] || continue
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$j" \
    || fail "${j} is not valid JSON"
done

echo "format-check: ok"
```

Then normalize the five CRLF files. This rewrite preserves file mode and changes only
line endings:

```sh
for f in scripts/ledger.sh scripts/graph-next.sh scripts/anti-gaming-scan.py \
         scripts/materialize-atomic-sources.sh scripts/validate-generated-pack.py; do
  tr -d '\r' < "$f" > "$f.lf"
  cat "$f.lf" > "$f"
  rm -f "$f.lf"
done
```

And declare the command in `COMMANDS.md` by appending to the same toolchain block:

FILE: COMMANDS.md   (MODIFY — append one line to the block added in M1)
```
Gate commands and sentinels: `sh scripts/preflight.sh` (preflight: ok);
`sh scripts/typecheck.sh` (typecheck: ok); `sh scripts/import-boundary.sh`
(import boundary: ok); `sh scripts/lint.sh` (lint: ok); `sh scripts/format-check.sh`
(format-check: ok); `sh scripts/test-unit.sh` (test-unit: ok);
`sh scripts/test-collection-guard.sh` (test collection guard: ok);
`sh scripts/build.sh` (build: ok); `sh scripts/gate-toolchain.sh` (gate-toolchain: ok);
`sh scripts/dependency-audit.sh` (dependency audit: ok);
`sh scripts/reality-gate.sh` (reality gate: ok).
```

RUN:

```sh
node -e "const fs=require('node:fs');for(const f of process.argv.slice(1)){const b=fs.readFileSync(f);fs.writeFileSync(f,Buffer.from(b.toString('utf8').replace(/\r\n/g,'\n'),'utf8'));}" scripts/ledger.sh scripts/graph-next.sh scripts/anti-gaming-scan.py scripts/materialize-atomic-sources.sh scripts/validate-generated-pack.py
git diff --stat
git diff --ignore-cr-at-eol --stat
sh scripts/format-check.sh
sh scripts/graph-next.sh
sh scripts/ledger.sh tail 3
```

EXPECT: `git diff --ignore-cr-at-eol --stat` prints **nothing** (only line endings
changed); `sh scripts/format-check.sh` prints `format-check: ok` last and exits 0;
`sh scripts/graph-next.sh` still prints `NEXT <ID>` or `ALL_DONE`; `sh scripts/ledger.sh
tail 3` still prints the ledger tail.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-001 MILESTONE_PASS "M2 format-check: ok; CRLF normalized to LF"`

FALLBACK: if a CRLF file turns out to require CRLF (for example a Windows-only fixture),
give it an explicit exemption with a `# CRLF-EXEMPT: <reason>` comment inside
`format-check.sh`, record the exemption in the ledger, and never disable the CRLF rule
globally. If the owner prefers a formatter over the dependency-free check, add pinned
`prettier` to `devDependencies` and make `format-check.sh` run `npx --no-install
prettier --check src tests scripts` — a real gate, never a stub.

COMMIT: `git add -A && git commit -m "[EP-001][M2] real format gate and LF normalization"`

### M3: Environment validation against PREFLIGHT.md

GOAL: One command proves that `.env.example`, the `PREFLIGHT.md` table, and the process
environment agree, that no credential value is committed, and that unprovisioned
credentials are classified `BLOCKED_CREDENTIALS` rather than passing silently.

READ: `PREFLIGHT.md`, `.env.example`, `scripts/preflight.sh`, `scripts/lib/loud-fail.sh`,
`.agent/specs/SPEC-008-production-readiness.md` (§9 external gates), `.agent/DONE_LAW.md`
(DOD-026, DOD-032, DOD-033), `.agent/verification/CAPABILITY_MATRIX.md`, `COMMANDS.md`.

CHANGE: `scripts/validate-env.sh` (create); `COMMANDS.md` (declare it); 
`.agent/evidence/EP-001/M3-preflight-table.txt` (discovery output).

CONTENT:

Discover the declared table first (paste the output into the evidence file; it is also
the input contract for the script):

```sh
awk -F'|' '/^PREFLIGHT-TABLE-BEGIN$/{i=1;next} /^PREFLIGHT-TABLE-END$/{i=0} i&&NF{gsub(/[ \t]+$/,"",$1);print $1"|"$2"|"$3}' PREFLIGHT.md
```

FILE: scripts/validate-env.sh   (CREATE)
```sh
#!/usr/bin/env sh
# Environment validation against PREFLIGHT.md. Sentinel: `env validation: ok`
#
# The PREFLIGHT table is the declared credential contract. This gate makes three
# things machine-checkable:
#   1. every declared variable is documented in .env.example, and nothing stale is;
#   2. no credential VALUE is committed (.env.example holds only the placeholder);
#   3. a variable set to the literal placeholder PROVISION_ME is NOT provisioned.
#
# Per PREFLIGHT.md, "Missing credentials block only dependent work": absent REQUIRED
# credentials are reported as BLOCKED_CREDENTIALS and do not fail this gate. A broken
# contract (undocumented, stale, or committed-value) does fail it, because that is a
# real defect rather than an unprovisioned environment.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "env validation: FAIL - $1" >&2; exit 1; }

[ -f PREFLIGHT.md ] || fail "PREFLIGHT.md is missing; there is no declared credential contract"
[ -f .env.example ] || fail ".env.example is missing"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0

awk -F'|' '
  /^PREFLIGHT-TABLE-BEGIN$/ { inside = 1; next }
  /^PREFLIGHT-TABLE-END$/   { inside = 0; next }
  inside && NF {
    name = $1; lane = $2
    gsub(/^[ \t]+|[ \t]+$/, "", name)
    gsub(/^[ \t]+|[ \t]+$/, "", lane)
    if (name != "") print name "|" lane
  }
' PREFLIGHT.md > "$tmp/declared"

[ -s "$tmp/declared" ] || fail "no variables could be parsed from the PREFLIGHT.md table"

declared=$(wc -l < "$tmp/declared" | tr -d ' ')
required=$(awk -F'|' '$2 == "REQUIRED" { n++ } END { print n + 0 }' "$tmp/declared")
optional=$(awk -F'|' '$2 == "OPTIONAL" { n++ } END { print n + 0 }' "$tmp/declared")
[ "$required" -gt 0 ] || fail "the PREFLIGHT table declares no REQUIRED variables; refusing to validate a vacuous contract"

# 1. Documented: every declared variable appears in .env.example.
missing=""
while IFS='|' read -r name lane; do
  grep -q "^${name}=" .env.example || missing="${missing}  - ${name} (${lane})
"
done < "$tmp/declared"
if [ -n "$missing" ]; then
  echo "env validation: FAIL - declared in PREFLIGHT.md but absent from .env.example:" >&2
  printf '%s' "$missing" >&2
  exit 1
fi

# 2. Not stale: every .env.example key is declared in PREFLIGHT.md.
stale=""
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  name=${line%%=*}
  grep -q "^${name}|" "$tmp/declared" || stale="${stale}  - ${name}
"
done < .env.example
if [ -n "$stale" ]; then
  echo "env validation: FAIL - present in .env.example but undeclared in PREFLIGHT.md:" >&2
  printf '%s' "$stale" >&2
  exit 1
fi

# 3. No committed credential value: every assignment must be the placeholder.
committed=$(grep -vE '^[[:space:]]*(#|$)' .env.example | grep -vE '=PROVISION_ME$' || true)
if [ -n "$committed" ]; then
  echo "env validation: FAIL - .env.example contains a value that is not the PROVISION_ME placeholder (VG-SEC-002):" >&2
  printf '%s\n' "$committed" | sed 's/=.*/=<redacted>/' >&2
  exit 1
fi

# 4. A placeholder in the environment is not a provisioned credential.
placeholder=""
unprovisioned=""
while IFS='|' read -r name lane; do
  eval "value=\${${name}:-}"
  if [ "$value" = "PROVISION_ME" ]; then
    placeholder="${placeholder}  - ${name}
"
  elif [ -z "$value" ] && [ "$lane" = "REQUIRED" ]; then
    unprovisioned="${unprovisioned}  - ${name}
"
  fi
done < "$tmp/declared"

if [ -n "$placeholder" ]; then
  echo "env validation: FAIL - these variables are set to the literal placeholder PROVISION_ME; that is not a provisioned credential:" >&2
  printf '%s' "$placeholder" >&2
  exit 1
fi

printf 'env validation: PREFLIGHT.md declares %s variables (%s REQUIRED, %s OPTIONAL); .env.example matches\n' \
  "$declared" "$required" "$optional"
if [ -n "$unprovisioned" ]; then
  echo "env validation: NOTICE - unprovisioned REQUIRED credentials; state BLOCKED_CREDENTIALS, blocking only their dependent work (DOD-032):" >&2
  printf '%s' "$unprovisioned" >&2
  echo "env validation: see PREFLIGHT.md and .env.example; provision then re-run." >&2
fi

echo "env validation: ok"
```

Declare it in `COMMANDS.md` by appending to the gate block:

FILE: COMMANDS.md   (MODIFY — append one line to the gate block added in M2)
```
`sh scripts/validate-env.sh` (env validation: ok);
```

RUN:

```sh
mkdir -p .agent/evidence/EP-001
awk -F'|' '/^PREFLIGHT-TABLE-BEGIN$/{i=1;next} /^PREFLIGHT-TABLE-END$/{i=0} i&&NF{gsub(/[ \t]+$/,"",$1);print $1"|"$2"|"$3}' PREFLIGHT.md | tee .agent/evidence/EP-001/M3-preflight-table.txt
sh -n scripts/validate-env.sh
sh scripts/validate-env.sh
DATABASE_URL=PROVISION_ME sh scripts/validate-env.sh; echo "negative-case exit: $?"
```

EXPECT: the discovery output lists every variable in the `PREFLIGHT.md` table (25 rows at
authoring time: 19 `REQUIRED`, 6 `OPTIONAL`); `sh -n` prints nothing and exits 0;
`sh scripts/validate-env.sh` prints the `env validation: PREFLIGHT.md declares …` line
followed by the `NOTICE` block naming the unprovisioned REQUIRED credentials, then
`env validation: ok` as the last line, exiting 0; the negative case prints
`env validation: FAIL - these variables are set to the literal placeholder PROVISION_ME`
and exits non-zero with **no** sentinel.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-001 MILESTONE_PASS "M3 env validation: ok; REQUIRED credentials unprovisioned => BLOCKED_CREDENTIALS"`

FALLBACK: if `awk` table parsing proves unreliable across platforms, move the parse into
a pinned Node helper (`node -e` reading `PREFLIGHT.md` between the two markers) inside the
same script — a real parser, never a hard-coded variable list, because a hard-coded list
would silently stop tracking the contract.

COMMIT: `git add -A && git commit -m "[EP-001][M3] validate environment against the PREFLIGHT contract"`

### M4: Harness self-tests and the expected-suite manifest

GOAL: Real unit tests assert that the gate scripts can fail, that the collection guard
refuses a zero-collection run, and that the mandated `verify.sh` stage order is intact.

READ: `scripts/count-tests.mjs`, `scripts/test-collection-guard.sh`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `scripts/verify.sh`,
`scripts/lib/loud-fail.sh`, `tests/domain/values.test.ts` (import and style reference),
`tsconfig.json`, `.agent/DONE_LAW.md` (DOD-006, DOD-007, DOD-018, DOD-024).

CHANGE: `tests/harness/gate-scripts.test.ts` (create);
`.agent/verification/EXPECTED_TEST_MANIFEST.txt` (append the new suite);
`scripts/test-collection-guard.sh` (add the `VG_TEST_GLOB` override only).

CONTENT:

First the anchored edit in `scripts/test-collection-guard.sh` — exact old text:

```
node --test --test-reporter=junit "tests/**/*.test.ts" \
```

exact new text:

```
node --test --test-reporter=junit "${VG_TEST_GLOB:-tests/**/*.test.ts}" \
```

Verification grep (must print `1`): `grep -c 'VG_TEST_GLOB' scripts/test-collection-guard.sh`

Rationale recorded in the same commit: the override exists so the zero-collection
negative proof is executable against an empty directory. It changes no default
behaviour; with `VG_TEST_GLOB` unset the command is byte-identical in effect.

FILE: tests/harness/gate-scripts.test.ts   (CREATE)
```ts
/**
 * Harness self-tests: the gates must be able to fail.
 *
 * A green gate proves nothing unless the gate can go red. These tests run the real
 * gate scripts and assert on their real exit status and real output. They are the
 * regression guard for the failure mode this repository was generated with: scripts
 * that printed success sentinels unconditionally (DOD-024, DOD-027).
 *
 * Child processes are run with output redirected to a file and stdio inherited,
 * never through a pipe: that keeps the harness portable to confined environments
 * where piped stdio is unavailable, and it leaves a raw log on disk (DOD-025).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

interface RunResult {
  readonly status: number | null;
  readonly output: string;
}

/** Run a shell command line in the project root, capturing output through a file. */
function runLine(commandLine: string): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'vg-harness-'));
  const outFile = join(dir, 'output.txt');
  writeFileSync(outFile, '');
  const result = spawnSync('sh', ['-c', `${commandLine} > "${outFile}" 2>&1`], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 180_000,
  });
  const output = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, output };
}

function scriptFiles(): string[] {
  return readdirSync(join(ROOT, 'scripts'))
    .filter((name) => name.endsWith('.sh'))
    .map((name) => `scripts/${name}`)
    .sort();
}

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

describe('every shell gate is POSIX-parseable', () => {
  for (const file of scriptFiles()) {
    test(`${file} passes sh -n`, () => {
      const result = runLine(`sh -n ${file}`);
      assert.equal(result.status, 0, `${file} failed sh -n:\n${result.output}`);
    });
  }
});

describe('no script prints a success sentinel from a fake path', () => {
  // A script is hollow when it prints a "…: ok" sentinel but its only executable
  // statements are printing. That is the exact fabrication pattern this pack was
  // generated with, so it is asserted structurally as well as behaviourally.
  const controlOnly =
    /^\s*(#!|set\s|export\s|cd\s|echo\s|printf\s|fi\s*$|done\s*$|esac\s*$|else\s*$|\}\s*$|then\s*$|do\s*$|case\s|;;)/;

  for (const file of scriptFiles()) {
    const body = read(file);
    if (!/^\s*echo\s+"[^"]*: ok"/m.test(body)) continue;
    test(`${file} performs real work before its sentinel`, () => {
      const statements = body
        .split('\n')
        .filter((line) => line.trim() !== '' && !controlOnly.test(line));
      assert.ok(
        statements.length > 0,
        `${file} prints a success sentinel but executes no check (DOD-024, DOD-027)`,
      );
    });
  }
});

describe('loud-fail placeholders fail loudly (VG-SHIP-033)', () => {
  const placeholders = scriptFiles().filter((file) => read(file).includes('vg_loud_fail'));
  // While any placeholder remains in the repository this list is non-empty; a node
  // that implements a gate removes it from the list by implementing it for real.
  for (const file of placeholders) {
    test(`${file} exits non-zero with the mandated ERROR signature and no sentinel`, () => {
      const result = runLine(`sh ${file}`);
      assert.notEqual(result.status, 0, `${file} must not exit 0 while unimplemented`);
      assert.match(
        result.output,
        /ERROR: .* is an unimplemented placeholder; replaced during EP-000 discovery milestone M1/,
        `${file} must fail with the mandated message, got:\n${result.output}`,
      );
      assert.doesNotMatch(
        result.output,
        /: ok\s*$/m,
        `${file} printed a success sentinel while unimplemented:\n${result.output}`,
      );
    });
  }
});

describe('test collection guard (DOD-007)', () => {
  test('the current suite collects a non-zero number of tests and passes', () => {
    const result = runLine('sh scripts/test-collection-guard.sh');
    assert.equal(result.status, 0, `collection guard failed:\n${result.output}`);
    assert.match(result.output, /test collection guard: ok/);
    const summary = result.output.split('\n').find((line) => line.startsWith('{"tests"'));
    assert.ok(summary, `no JSON summary in:\n${result.output}`);
    const parsed = JSON.parse(summary) as { tests: number; fail: number; verdict: string };
    assert.ok(parsed.tests > 0, 'zero tests collected must never pass (DOD-007)');
    assert.equal(parsed.fail, 0);
    assert.equal(parsed.verdict, 'OK');
  });

  test('an empty collection FAILS and prints no sentinel', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'vg-empty-'));
    try {
      const result = runLine(
        `VG_TEST_GLOB="${emptyDir}/**/*.test.ts" sh scripts/test-collection-guard.sh`,
      );
      assert.notEqual(result.status, 0, 'a zero-collection run must fail (DOD-007)');
      assert.match(result.output, /zero tests were collected/);
      assert.doesNotMatch(result.output, /test collection guard: ok/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('verify.sh stage order is the mandated fifteen stages (line 1357)', () => {
  test('stage names appear once each, in order', () => {
    const body = read('scripts/verify.sh');
    const block = body.split('STAGES="')[1]?.split('"')[0] ?? '';
    const names = block
      .split('\n')
      .map((line) => line.split(':')[0]?.trim() ?? '')
      .filter((name) => name.length > 0);
    assert.deepEqual(names, [
      'preflight',
      'lint',
      'format-check',
      'typecheck',
      'unit',
      'integration',
      'security-check',
      'dependency-audit',
      'reality-gate',
      'test-collection-guard',
      'build',
      'artifact-identity',
      'smoke',
      'e2e',
      'live-fire',
    ]);
  });

  test('no stage is exempted and no failure is masked', () => {
    const body = read('scripts/verify.sh');
    assert.doesNotMatch(body, /continue-on-error|\|\|\s*true|set\s\+e/);
    assert.match(body, /sh "scripts\/\$script"/);
  });
});

describe('PREFLIGHT contract and .env.example agree (independent parse)', () => {
  // This is a second, independent implementation of the check in
  // scripts/validate-env.sh. Two implementations disagreeing is itself a finding.
  const declared = new Set(
    read('PREFLIGHT.md')
      .split('PREFLIGHT-TABLE-BEGIN')[1]
      ?.split('PREFLIGHT-TABLE-END')[0]
      ?.split('\n')
      .map((line) => line.split('|')[0]?.trim() ?? '')
      .filter((name) => name.length > 0) ?? [],
  );
  const documented = new Set(
    read('.env.example')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.split('=')[0] ?? ''),
  );

  test('the table declares at least one REQUIRED credential', () => {
    assert.ok(declared.size > 0, 'PREFLIGHT.md declares no variables');
  });

  test('every declared variable is documented', () => {
    const missing = [...declared].filter((name) => !documented.has(name));
    assert.deepEqual(missing, [], `undeclared in .env.example: ${missing.join(', ')}`);
  });

  test('no stale entries in .env.example', () => {
    const stale = [...documented].filter((name) => !declared.has(name));
    assert.deepEqual(stale, [], `stale in .env.example: ${stale.join(', ')}`);
  });

  test('.env.example holds no value other than the placeholder (VG-SEC-002)', () => {
    const offending = read('.env.example')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .filter((line) => !line.endsWith('=PROVISION_ME'));
    assert.deepEqual(offending, []);
  });
});

describe('repository hygiene', () => {
  test('the lockfile is tracked by git (DOD-002)', () => {
    const result = runLine('git ls-files --error-unmatch package-lock.json');
    assert.equal(result.status, 0, 'package-lock.json is not tracked');
  });

  test('zero runtime dependencies and exact-pinned devDependencies', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
    for (const [name, spec] of Object.entries(pkg.devDependencies ?? {})) {
      assert.match(spec, /^\d+\.\d+\.\d+$/, `${name} is not exact-pinned: ${spec}`);
    }
  });

  test('.gitignore keeps credentials out and evidence in (DOD-025, VG-SEC-002)', () => {
    const ignore = read('.gitignore');
    for (const required of ['node_modules/', 'dist/', '.env', '.env.*', '!.env.example']) {
      assert.ok(ignore.includes(required), `.gitignore must contain ${required}`);
    }
    assert.doesNotMatch(ignore, /^\.agent\/evidence\/?$/m, '.agent/evidence/ must be committed');
  });
});

describe('implemented gates really pass', () => {
  for (const [file, sentinel] of [
    ['scripts/format-check.sh', 'format-check: ok'],
    ['scripts/reality-gate.sh', 'reality gate: ok'],
    ['scripts/import-boundary.sh', 'import boundary: ok'],
  ] as const) {
    test(`${file} prints ${sentinel}`, () => {
      const result = runLine(`sh ${file}`);
      assert.equal(result.status, 0, `${file} failed:\n${result.output}`);
      assert.match(result.output, new RegExp(`${sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`));
    });
  }
});
```

Append the new suite to the manifest (anchored edit — insert after the existing last
line `tests/domain/values.test.ts`):

FILE: .agent/verification/EXPECTED_TEST_MANIFEST.txt   (MODIFY — append only)
```
tests/harness/gate-scripts.test.ts
```

RUN:

```sh
sh -n tests/harness/gate-scripts.test.ts 2>/dev/null || true
sh scripts/typecheck.sh
sh scripts/test-unit.sh
sh scripts/test-collection-guard.sh
```

EXPECT: `typecheck: ok`; `test-unit: ok` with a passing count strictly greater than the
M1 baseline and zero failures; `test collection guard: ok` with its JSON line showing
`filesSeen` increased by one and `manifestChecked` matching the manifest line count.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-001 MILESTONE_PASS "M4 harness self-tests green; zero-collection negative proof automated"`

FALLBACK: if a confined environment forbids spawning `sh` from a test process at all, keep
the structural assertions (parse, sentinel-hollow scan, stage order, manifest, hygiene)
in the suite, move the behavioural spawn assertions into `scripts/gate-foundation.sh`
(which already runs them), and record the platform limitation explicitly in the ledger —
never delete an assertion and never mark the suite as skipped without a waiver (DOD-006).

COMMIT: `git add -A && git commit -m "[EP-001][M4] harness self-tests and zero-collection proof"`

### M5: Replace the EP-001-labelled placeholders: dependency audit and reality gate

GOAL: `sh scripts/dependency-audit.sh` and `sh scripts/reality-gate.sh` are real gates
that can fail, and neither prints a sentinel when its real check could not run.

READ: `scripts/dependency-audit.sh`, `scripts/reality-gate.sh`, `scripts/lib/loud-fail.sh`,
`.agent/reality-patterns`, `.agent/reality-allow`, `LICENSE_POLICY.md`, `SECURITY.md`,
`.agent/DONE_LAW.md` (DOD-019, DOD-020, DOD-021, DOD-024, DOD-032, DOD-033),
`.agent/verification/CAPABILITY_MATRIX.md`.

CHANGE: `scripts/dependency-audit.sh` (replacement), `scripts/reality-gate.sh`
(replacement), `COMMANDS.md` (declare both), `.agent/evidence/dependency-audit/**`.

CONTENT:

FILE: scripts/dependency-audit.sh   (REPLACE the loud-fail placeholder)
```sh
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
```

FILE: scripts/reality-gate.sh   (REPLACE the loud-fail placeholder)
```sh
#!/usr/bin/env sh
# Reality gate: no simulated, unfinished, or placeholder behaviour in production paths.
#
# Sentinel: `reality gate: ok`
#
# Replaces the pre-discovery loud-fail placeholder (EP-001 milestone M5).
#
# Implements DOD-019 (placeholder/stub/fake/unfinished scans over production paths) and
# the production-path half of DOD-020 (no simulated adapter selected in production).
# Patterns come from .agent/reality-patterns. A hit is permitted only by an explicit
# path:line entry in .agent/reality-allow, which is a reviewed decision, never a
# wildcard.
#
# Scope: src/** is the production path set. Tests, scripts, and pack documents are not
# production paths. As src/ grows, this gate covers the new code automatically.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "reality gate: FAIL - $1" >&2; exit 1; }

[ -d src ] || fail "src/ is missing"
[ -f .agent/reality-patterns ] || fail ".agent/reality-patterns is missing; the pattern contract is undefined"
[ -f .agent/reality-allow ] || fail ".agent/reality-allow is missing; there is no allow-list contract"

hits=""

# 1. Declared lexical patterns.
while IFS= read -r pattern; do
  case "$pattern" in ''|'#'*) continue ;; esac
  found=$(grep -rniE -- "$pattern" src 2>/dev/null || true)
  [ -z "$found" ] || hits="${hits}${found}
"
done < .agent/reality-patterns

# 2. Production paths must not contain simulated adapters. Test doubles live in tests/.
simulated=$(find src -type f \( -iname '*mock*' -o -iname '*fake*' -o -iname '*stub*' \
  -o -iname '*demo*' -o -iname '*sample*' -o -iname '*.simulation.*' \) -print 2>/dev/null | sort || true)
[ -z "$simulated" ] || hits="${hits}${simulated}
"

# 3. Production paths must not print a gate sentinel or an unconditional success.
sentinel_like=$(grep -rnE "console\.(log|info)\([^)]*: ok" src 2>/dev/null || true)
[ -z "$sentinel_like" ] || hits="${hits}${sentinel_like}
"

if [ -n "$hits" ]; then
  unallowed=""
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    case "$hit" in
      *:*) file=${hit%%:*}; rest=${hit#*:}; line=${rest%%:*} ;;
      *)   file=$hit; line=0 ;;
    esac
    if ! grep -qE "^${file}:${line}([[:space:]]|$)" .agent/reality-allow; then
      unallowed="${unallowed}  - ${hit}
"
    fi
  done <<EOF
$hits
EOF
  if [ -n "$unallowed" ]; then
    echo "reality gate: FAIL - placeholder, simulated, or unfinished behaviour in production paths:" >&2
    printf '%s' "$unallowed" >&2
    echo "Replace the behaviour with a real implementation, or add a reviewed path:line" >&2
    echo "entry to .agent/reality-allow with a reason. Never blanket-allow (DOD-019, DOD-027)." >&2
    exit 1
  fi
  echo "reality gate: NOTICE - hits present and individually allowed by .agent/reality-allow" >&2
fi

echo "reality gate: ok"
```

Declare both in `COMMANDS.md` (append to the gate block):

FILE: COMMANDS.md   (MODIFY — append to the gate block)
```
`sh scripts/dependency-audit.sh` (dependency audit: ok);
`sh scripts/reality-gate.sh` (reality gate: ok).
```

RUN:

```sh
sh -n scripts/dependency-audit.sh
sh -n scripts/reality-gate.sh
sh scripts/reality-gate.sh
sh scripts/dependency-audit.sh; echo "dependency-audit exit: $?"
grep -rn 'vg_loud_fail' scripts/*.sh
```

EXPECT: both `sh -n` calls exit 0 silently; `reality gate: ok` as the last line of the
reality gate; then **either** `dependency audit: ok` (registry reachable) **or** exactly
`dependency audit: ERROR - npm audit did not complete within 60s (registry unreachable or hanging); this is a harness ERROR, not a pass; re-run with network access or in CI`
(or the `npm registry unreachable` variant) with exit 1 and **no** sentinel. Record which
of the two occurred in the M5 evidence line; an offline result is `BLOCKED_NETWORK`, never
a pass. `grep -rn 'vg_loud_fail' scripts/*.sh` must no longer list
`dependency-audit.sh` or `reality-gate.sh`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-001 MILESTONE_PASS "M5 reality gate: ok; dependency audit: ok (or BLOCKED_NETWORK with the exact ERROR line)"`

FALLBACK: for the reality gate — if the declared patterns prove too noisy on real code,
keep the two structural scans (simulated-adapter files, sentinel-like output) and narrow
the lexical scan to `src/**/*.ts` production files; never replace the gate with a
blanket allow-list entry. For the dependency audit — if the registry is unreachable in the
executing environment, keep the deterministic inventory and SBOM checks local and let the
advisory scan run in CI, with the local run recording `BLOCKED_NETWORK` and printing no
sentinel; if `npm sbom` is unavailable in the installed npm, emit the SBOM from
`package-lock.json` with a pinned Node script instead — a real SBOM, never a stub file.

COMMIT: `git add -A && git commit -m "[EP-001][M5] real dependency audit and reality gate"`

### M6: Baseline CI that can go red

GOAL: A committed CI workflow runs the real gates on a clean checkout, with no failure
masking, and the same sequence is proven locally in the same order.

READ: `.agent/specs/SPEC-008-production-readiness.md` (§8 clean room, §10 no-masking),
`.agent/DONE_LAW.md` (DOD-002, DOD-005, DOD-021, DOD-024), `ARCHITECTURE.md` (§ layout),
`COMMANDS.md`, `scripts/verify.sh`.

CHANGE: `../.github/workflows/ci.yml` (create, or replace an existing partial workflow) —
**repository root**; `.agent/evidence/EP-001/M6-local-sequence.txt`.

CONTENT:

The workflow lives at the repository root because GitHub Actions reads only
`<repository root>/.github/workflows/`. Every step sets `working-directory: vanishgraph`
because the project root is the subdirectory. If a workflow already exists, replace it
with this body and record the diff in the ledger rather than adding a second workflow.

FILE: ../.github/workflows/ci.yml   (CREATE at the repository root, or REPLACE)
```yaml
# Baseline CI (EP-001). Every step is a real command that can fail.
#
# There is deliberately no continue-on-error, no `|| true`, and no ignored exit code:
# DOD-024 forbids masking failures, and a CI file that cannot go red is a false green
# (AGENTS.md: "Software that appears to work is a failure state").
#
# The project root is the `vanishgraph` subdirectory of this repository, so every step
# sets working-directory. Gate sentinels are asserted by the gates themselves; CI adds
# the clean-checkout install (DOD-002) that no local run can prove.
name: ci

on:
  push:
    branches: ['**']
  pull_request:

permissions:
  contents: read

jobs:
  foundation:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
          cache-dependency-path: vanishgraph/package-lock.json

      - name: Clean install from the committed lockfile (DOD-002)
        working-directory: vanishgraph
        run: npm ci --no-audit --no-fund

      - name: Preflight
        working-directory: vanishgraph
        run: sh scripts/preflight.sh

      - name: Lint (typecheck + domain import boundary)
        working-directory: vanishgraph
        run: sh scripts/lint.sh

      - name: Format check
        working-directory: vanishgraph
        run: sh scripts/format-check.sh

      - name: Environment contract
        working-directory: vanishgraph
        run: sh scripts/validate-env.sh

      - name: Unit tests
        working-directory: vanishgraph
        run: sh scripts/test-unit.sh

      - name: Test collection guard (DOD-007)
        working-directory: vanishgraph
        run: sh scripts/test-collection-guard.sh

      - name: Reality gate (DOD-019)
        working-directory: vanishgraph
        run: sh scripts/reality-gate.sh

      - name: Build
        working-directory: vanishgraph
        run: sh scripts/build.sh

      - name: Dependency audit and SBOM (DOD-021)
        working-directory: vanishgraph
        run: sh scripts/dependency-audit.sh

      - name: Toolchain gate
        working-directory: vanishgraph
        run: sh scripts/gate-toolchain.sh

      - name: Foundation gate
        working-directory: vanishgraph
        run: sh scripts/gate-foundation.sh

      - name: Pack validation
        working-directory: vanishgraph
        run: python3 scripts/validate-generated-pack.py .

      - name: Upload gate evidence
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: gate-evidence
          path: |
            vanishgraph/.agent/evidence/**
            vanishgraph/dist/**
          if-no-files-found: warn
          retention-days: 14
```

Note the ordering constraint that must not be "fixed": `gate-foundation` runs **after**
the individual gates so a failure is attributed to the specific gate, and the pack
validator runs last. `if: always()` on the evidence upload is an artifact upload, not a
test step, and does not mask a failure (the job still fails).

Local execution of the same sequence, in the same order, as the local equivalent of the
workflow (this is what `.agent/evidence/EP-001/M6-local-sequence.txt` must contain):

```sh
{ sh scripts/preflight.sh && sh scripts/lint.sh && sh scripts/format-check.sh \
  && sh scripts/validate-env.sh && sh scripts/test-unit.sh \
  && sh scripts/test-collection-guard.sh && sh scripts/reality-gate.sh \
  && sh scripts/build.sh && sh scripts/gate-toolchain.sh \
  && python3 scripts/validate-generated-pack.py .; } 2>&1 | tee .agent/evidence/EP-001/M6-local-sequence.txt
```

RUN:

```sh
mkdir -p .agent/evidence/EP-001
test -f ../.github/workflows/ci.yml && echo "ci.yml present"
grep -cE 'continue-on-error|\|\| true|set \+e' ../.github/workflows/ci.yml || echo "masking: none"
grep -c 'working-directory: vanishgraph' ../.github/workflows/ci.yml
{ sh scripts/preflight.sh && sh scripts/lint.sh && sh scripts/format-check.sh \
  && sh scripts/validate-env.sh && sh scripts/test-unit.sh \
  && sh scripts/test-collection-guard.sh && sh scripts/reality-gate.sh \
  && sh scripts/build.sh && sh scripts/gate-toolchain.sh \
  && python3 scripts/validate-generated-pack.py .; } 2>&1 | tee .agent/evidence/EP-001/M6-local-sequence.txt
git status --porcelain=v1
```

EXPECT: `ci.yml present`; the masking grep prints `0` (or `masking: none`); the
`working-directory` count is at least `12` (one per step that runs in the project root);
`.agent/evidence/EP-001/M6-local-sequence.txt` contains, in order, `preflight: ok`,
`typecheck: ok`, `import boundary: ok`, `lint: ok`, `format-check: ok`,
`env validation: ok`, `test-unit: ok`, `test collection guard: ok`, `reality gate: ok`,
`build: ok`, `gate-toolchain: ok`, and the pack validator's success line.

**Do not claim the CI workflow itself passed.** Its first real run happens on push; the
run URL and conclusion are the evidence, and until then the workflow status in this
node's records is `NOT_EXECUTED_LOCALLY`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-001 MILESTONE_PASS "M6 local gate sequence green; ci.yml committed; workflow run NOT_EXECUTED_LOCALLY"`

FALLBACK: if GitHub Actions cannot run for this repository (permissions, billing, or an
org policy), add `scripts/ci-local.sh` containing exactly the local sequence above,
declare it in `COMMANDS.md`, and record the external limitation as `EXTERNAL_REQUIRED`
with the reason — never remove the workflow file, and never claim a CI run that did not
happen.

COMMIT: `git add -A && git commit -m "[EP-001][M6] baseline CI with no failure masking"`

### M7: Node gate `scripts/gate-foundation.sh` and the verify.sh progression proof

GOAL: One command proves the whole foundation — every sub-gate sentinel, the
zero-collection negative proof, and that `verify.sh` advances through the five
implemented stages and fails loudly at the first unimplemented one.

READ: `scripts/verify.sh`, `scripts/gate-toolchain.sh` (style reference),
`scripts/test-collection-guard.sh`, `scripts/format-check.sh`, `scripts/validate-env.sh`,
`scripts/build.sh`, `scripts/reality-gate.sh`, `COMMANDS.md`, `.agent/DONE_LAW.md`
(DOD-007, DOD-024, DOD-025, DOD-027), `.agent/specs/SPEC-008-production-readiness.md` §10.

CHANGE: `scripts/gate-foundation.sh` (create); `COMMANDS.md` (declare it and its
sentinel); `.agent/evidence/EP-001/verify-progression.txt` (created by the gate itself).

CONTENT:

FILE: scripts/gate-foundation.sh   (CREATE — node-level VERIFY for EP-001)
```sh
#!/usr/bin/env sh
# EP-001 node gate. Sentinel: `gate-foundation: ok`
#
# This is the node-level verify for EP-001. It proves the foundation by running every
# real gate and requiring its exact sentinel, and by proving two negative properties
# that a green suite cannot prove on its own:
#
#   * the collection guard FAILS on an empty collection (DOD-007);
#   * sh scripts/verify.sh advances through the implemented stages and stops at the
#     first unimplemented one with the mandated loud-fail ERROR line, and provably
#     does NOT print `verify: ok`.
#
# `verify.sh` itself keeps the full fifteen-stage order mandated by the master prompt
# (section 10 Scripts, line 1357). Nothing here removes, reorders, or exempts a stage;
# the last five stages require a built artifact (EP-009/EP-010), which is exactly why
# this node's verify is a node-scoped gate and not `verify: ok`.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "gate-foundation: FAIL - $1" >&2; exit 1; }

mkdir -p .agent/evidence/EP-001
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0

# require_sentinel <sentinel> <command...>
require_sentinel() {
  sentinel=$1
  shift
  if ! out=$("$@" 2>&1); then
    echo "gate-foundation: FAIL - command failed: $*" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  printf '%s\n' "$out"
  printf '%s\n' "$out" | grep -qxF "$sentinel" \
    || fail "expected sentinel '$sentinel' as the last line of: $*"
}

# 1. Toolchain and locked dependency state.
command -v node >/dev/null 2>&1 || fail "node is required but not found"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || fail "node >= 24 is required, found $(node --version)"
[ -f package-lock.json ] || fail "package-lock.json is missing; the dependency set is not locked"
[ -d node_modules ] || fail "node_modules is missing; run npm ci"

# 2. Every shell script is POSIX-parseable.
for f in $(find scripts -type f -name '*.sh' | sort); do
  sh -n "$f" || fail "sh -n failed for $f"
done
echo "gate-foundation: sh -n ok for $(find scripts -type f -name '*.sh' | wc -l | tr -d ' ') scripts"

# 3. No script prints a success sentinel from a path that performs no check.
hollow=""
for f in $(find scripts -type f -name '*.sh' | sort); do
  case "$f" in */lib/*) continue ;; esac
  grep -qE '^[[:space:]]*echo[[:space:]]+"[^"]*: ok"' "$f" || continue
  statements=$(grep -vE '^[[:space:]]*(#|$)' "$f" \
    | grep -vE '^#!' \
    | grep -vE '^[[:space:]]*set[[:space:]]' \
    | grep -vE '^[[:space:]]*export[[:space:]]' \
    | grep -vE '^[[:space:]]*cd[[:space:]]' \
    | grep -vE '^[[:space:]]*(echo|printf)[[:space:]]' \
    | grep -vE '^[[:space:]]*(fi|done|esac|else|\}|then|do)[[:space:]]*$' || true)
  [ -n "$statements" ] || hollow="${hollow}  - ${f}
"
done
[ -z "$hollow" ] || {
  echo "gate-foundation: FAIL - scripts that print a success sentinel but do no work:" >&2
  printf '%s' "$hollow" >&2
  exit 1
}

# 4. Working tree hygiene: dist/ and node_modules/ are not tracked, evidence is.
node -e '
  const { spawnSync } = require("node:child_process");
  const tracked = spawnSync("git", ["ls-files"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).stdout ?? "";
  const bad = tracked.split("\n").filter((p) => p.startsWith("node_modules/") || p.startsWith("dist/"));
  if (bad.length > 0) {
    console.error("gate-foundation: FAIL - build or dependency output is tracked: " + bad.slice(0, 5).join(", "));
    process.exit(1);
  }
' || exit 1

# 5. Every real gate, with its exact sentinel.
require_sentinel 'preflight: ok'               sh scripts/preflight.sh
require_sentinel 'typecheck: ok'               sh scripts/typecheck.sh
require_sentinel 'import boundary: ok'         sh scripts/import-boundary.sh
require_sentinel 'lint: ok'                    sh scripts/lint.sh
require_sentinel 'format-check: ok'            sh scripts/format-check.sh
require_sentinel 'env validation: ok'          sh scripts/validate-env.sh
require_sentinel 'test-unit: ok'               sh scripts/test-unit.sh
require_sentinel 'reality gate: ok'            sh scripts/reality-gate.sh
require_sentinel 'build: ok'                   sh scripts/build.sh
[ -s .agent/evidence/build/domain-artifact.sha256 ] \
  || fail "build.sh printed its sentinel but produced no artifact digest"

# 6. Collection guard: positive result, then the negative proof (DOD-007).
require_sentinel 'test collection guard: ok' sh scripts/test-collection-guard.sh

empty_dir=$(mktemp -d)
if VG_TEST_GLOB="${empty_dir}/**/*.test.ts" sh scripts/test-collection-guard.sh \
     >"$tmp/empty-guard.txt" 2>&1; then
  fail "the collection guard exited 0 on an empty collection (DOD-007 violated)"
fi
grep -q 'zero tests were collected' "$tmp/empty-guard.txt" \
  || fail "the empty-collection failure used an unexpected message; see $tmp/empty-guard.txt"
grep -q 'test collection guard: ok' "$tmp/empty-guard.txt" \
  && fail "the collection guard printed its sentinel on a failed run"
echo "gate-foundation: zero-collection negative proof ok"

# 7. verify.sh progression proof. Non-zero exit is REQUIRED here.
progression=.agent/evidence/EP-001/verify-progression.txt
if sh scripts/verify.sh >"$progression" 2>&1; then
  fail "verify.sh exited 0 although artifact-bound stages are unimplemented; a pass here is a fabrication (DOD-027)"
fi
grep -q 'verify: running stage preflight' "$progression"   || fail "verify.sh did not reach preflight"
grep -q 'verify: running stage unit' "$progression"        || fail "verify.sh did not reach the unit stage"
grep -q 'preflight: ok' "$progression"                     || fail "preflight sentinel missing from the verify transcript"
grep -q 'lint: ok' "$progression"                          || fail "lint sentinel missing from the verify transcript"
grep -q 'format-check: ok' "$progression"                  || fail "format-check sentinel missing from the verify transcript"
grep -q 'typecheck: ok' "$progression"                     || fail "typecheck sentinel missing from the verify transcript"
grep -q 'test-unit: ok' "$progression"                     || fail "test-unit sentinel missing from the verify transcript"
grep -q 'verify: running stage integration' "$progression" || fail "verify.sh did not reach the integration stage"
grep -q 'ERROR: integration tests is an unimplemented placeholder' "$progression" \
  || fail "the first unimplemented stage did not fail loudly with the mandated signature"
if grep -qx 'verify: ok' "$progression"; then
  fail "verify.sh printed its success sentinel while stages are unimplemented (DOD-024)"
fi
echo "gate-foundation: verify.sh progression ok (5 stages green, integration loud-fails, no verify: ok)"

echo "gate-foundation: ok"
```

Declare it in `COMMANDS.md`:

FILE: COMMANDS.md   (MODIFY — append a node-gate line)
```
Node gates: `sh scripts/gate-toolchain.sh` (gate-toolchain: ok, node EP-000);
`sh scripts/gate-foundation.sh` (gate-foundation: ok, node EP-001). Later nodes add
`gate-domain: ok` (EP-002) and `gate-data: ok` (EP-003) the same way.
```

RUN:

```sh
sh -n scripts/gate-foundation.sh
sh scripts/gate-foundation.sh
tail -n 3 .agent/evidence/EP-001/verify-progression.txt
```

EXPECT: `sh -n` exits 0 silently; `sh scripts/gate-foundation.sh` prints each sub-gate's
output, the lines `gate-foundation: zero-collection negative proof ok` and
`gate-foundation: verify.sh progression ok (5 stages green, integration loud-fails, no verify: ok)`,
and `gate-foundation: ok` as the final line, exiting 0. The tail of the progression
transcript shows the `integration` stage line and the placeholder `ERROR:` line.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-001 MILESTONE_PASS "M7 gate-foundation: ok"`

FALLBACK: if asserting the progression with several `grep` calls proves brittle across
shells, replace step 7's assertions with a single pinned `node -e` check over the same
transcript file that asserts the same ordered list of lines — the assertion set stays
identical, only the mechanism changes.

COMMIT: `git add -A && git commit -m "[EP-001][M7] node gate with verify.sh progression proof"`

### M8: Node close-out

GOAL: The node is closed with a green node gate, an evidence index of hashes, a
`NODE_DONE` ledger event, and a green tag — or it stays open, with no tag.

READ: `.agent/DONE_LAW.md` (DOD-025, DOD-026, DOD-029, DOD-042),
`.agent/specs/SPEC-008-production-readiness.md` (§11 evidence preservation, §13 status),
`.agent/verification/state/RELEASE_GATE.json`, `.agent/verification/state/RUN_STATE.json`,
`.agent/state/LEDGER.md`.

CHANGE: `.agent/state/LEDGER.md` (events), `.agent/evidence/EP-001/**` (evidence index and
hashes). Nothing else. `RELEASE_GATE.json` is **not** changed: the verdict remains
`INCONCLUSIVE` because no artifact, no verification subgraph, and no external gates exist.

CONTENT:

Write `.agent/evidence/EP-001/INDEX.txt` with one line per evidence artifact:
`<sha256>  <path>  <one-line description>`, generated by a real command (never by hand):

```sh
mkdir -p .agent/evidence/EP-001
: > .agent/evidence/EP-001/INDEX.txt
find .agent/evidence/EP-001 .agent/evidence/build .agent/evidence/dependency-audit -type f ! -name INDEX.txt | sort | while IFS= read -r f; do
  digest=$(node -e 'const c=require("node:crypto"),fs=require("node:fs");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$f")
  printf '%s  %s\n' "$digest" "$f" >> .agent/evidence/EP-001/INDEX.txt
done
wc -l < .agent/evidence/EP-001/INDEX.txt
```

Close-out is permitted **only** when every milestone above has a `MILESTONE_PASS` event
whose text carries a sentinel that was actually observed in this session.

RUN:

```sh
sh scripts/gate-foundation.sh
sh scripts/ledger.sh append <AGENT_ID> EP-001 NODE_DONE "EP-001 complete: gate-foundation: ok"
git tag green/EP-001
git log --oneline -1
sh scripts/ledger.sh status EP-001
```

EXPECT: `gate-foundation: ok`; the ledger tail contains the `EP-001 | NODE_DONE` line;
`sh scripts/ledger.sh status EP-001` prints `DONE`; `git tag` lists `green/EP-001`;
`git log --oneline -1` shows the close-out commit.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-001 NODE_DONE "EP-001 complete: gate-foundation: ok"`

FALLBACK: none needed — closing is a ledger append plus a tag, and if the gate fails the
node simply stays open and is not tagged.

COMMIT: `git add -A && git commit -m "[EP-001][M8] close foundation node"`

## 9. Validation and Acceptance

Node-level acceptance. Each item names the exact evidence required; a criterion without
executed evidence is `INCOMPLETE`, never `PASS` (SPEC-000 §9.1).

| # | Criterion | Required evidence | DOD |
|---|---|---|---|
| A1 | `npm` is the confirmed package manager, `package-lock.json` is committed and tracked, devDependencies are exactly pinned, and there are zero runtime dependencies. | `git ls-files --error-unmatch package-lock.json`; lockfile sha256; `package.json` inventory check output | DOD-002, DOD-021 |
| A2 | ESM and the strict `tsconfig.json` are confirmed present and `tsc --noEmit` passes. | `typecheck: ok` in the verify transcript | DOD-002, DOD-021 |
| A3 | Real `lint`, `typecheck`, `unit`, `build`, `format-check`, `test-collection-guard` gates replace every EP-001-labelled placeholder, and each prints its sentinel only on success. | `gate-foundation.sh` transcript showing each sentinel; `grep -rn 'vg_loud_fail' scripts/*.sh` no longer listing format-check/dependency-audit/reality-gate | DOD-019, DOD-024, DOD-027 |
| A4 | The collection guard fails when zero tests are collected, proven by an executed negative case; `node --test` alone exits 0 in that situation (measured), which is why the guard exists. | The `zero-collection negative proof ok` line and the captured `zero tests were collected` message | DOD-007 |
| A5 | `sh scripts/verify.sh` runs the full fifteen-stage order, advances through `preflight`, `lint`, `format-check`, `typecheck`, `unit`, and fails loudly at `integration` with the mandated `ERROR:` signature and no `verify: ok`. | `.agent/evidence/EP-001/verify-progression.txt` | DOD-024, DOD-025 |
| A6 | A baseline CI workflow exists at the repository root, runs the real gates, and contains no `continue-on-error`, `|| true`, or `set +e`. | `ci.yml` content plus the masking grep output; workflow run status recorded as `NOT_EXECUTED_LOCALLY` until pushed | DOD-002, DOD-005, DOD-024 |
| A7 | `.gitignore` keeps credentials and build output out and evidence in; no build or dependency output is tracked. | hygiene assertions in `gate-foundation.sh`; `.gitignore` content | DOD-025 |
| A8 | Environment validation is driven by the `PREFLIGHT.md` table, rejects committed credential values and the literal `PROVISION_ME`, and reports unprovisioned REQUIRED credentials as `BLOCKED_CREDENTIALS` without failing. | `env validation: ok` plus the `NOTICE` block | DOD-026, DOD-032, DOD-033 |
| A9 | Harness self-tests pass: gate scripts parse, no script prints a sentinel from a hollow path, placeholders fail loudly, the guard's zero-collection proof is automated, and the `verify.sh` stage order is asserted against line 1357. | `test-unit: ok` with the new suite in the collection-guard manifest output | DOD-006, DOD-018, DOD-024 |
| A10 | Every command this node runs is declared in `COMMANDS.md` with its sentinel. | `COMMANDS.md` content diff | command lock (§7) |
| A11 | The node gate prints `gate-foundation: ok`, the ledger holds `MILESTONE_PASS` for M1–M7 and `NODE_DONE` for EP-001, and the tag `green/EP-001` exists. | ledger tail, `git tag` | DOD-025, DOD-026 |

**What this node must never claim.** Not `verify: ok`. Not a passing CI workflow run
before one actually happened. Not a clean install if the registry was unreachable (that
is `BLOCKED_NETWORK`). Not that the product works: no API, no UI, no persistence exists
yet. Not `GO`: the ship verdict remains `INCONCLUSIVE` (SPEC-008 §13).

**Honest status of the fifteen `verify.sh` stages after this node** (a factual table, not
a claim of completion):

| Stage | State after EP-001 |
|---|---|
| preflight | implemented, passes |
| lint | implemented, passes (typecheck + domain import boundary) |
| format-check | implemented by this node, passes |
| typecheck | implemented, passes |
| unit | implemented, passes |
| integration | **placeholder** — fails loudly; real PostgreSQL integration arrives in EP-003 |
| security-check | placeholder (labels EP-006) |
| dependency-audit | implemented by this node; needs a reachable registry, otherwise `BLOCKED_NETWORK` |
| reality-gate | implemented by this node |
| test-collection-guard | implemented, passes |
| build | implemented (domain-layer artifact only; the production artifact arrives in EP-009) |
| artifact-identity | placeholder (EP-009) |
| smoke | placeholder (EP-009) |
| e2e | placeholder (EP-005) |
| live-fire | placeholder (EP-010) |

Consequence: `sh scripts/verify.sh` cannot print `verify: ok` in this node, by
construction. That is the correct state, not a defect of this plan.

## 10. Idempotence and Recovery

Re-entering this node cold:

1. Read `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`, then
   `.agent/state/LEDGER.md` and this file's §11 Progress.
2. Run `sh scripts/ledger.sh status EP-001` and `sh scripts/ledger.sh tail 30`. Resume at
   the first milestone with no `MILESTONE_PASS` event.
3. **Re-verify the previous milestone's sentinel before continuing.** Cached green is not
   green (VG-SHIP-006): re-run the specific gate named in that milestone's `EXPECT`.
4. Re-run the discovery block in M1 before assuming the repository state described in §4;
   a parallel agent or an earlier partial run may have advanced or reverted it.

Idempotence properties of each milestone:

- M1 rewrites `package.json` and appends a block to `COMMANDS.md`. Re-running must not
  duplicate the block: check with `grep -c 'npm ci' COMMANDS.md` and skip the append if it
  is already present.
- M2's line-ending normalization is idempotent (`tr -d '\r'` on LF input is a no-op) and
  content-preserving; re-running produces no diff.
- M3 creates one script and appends one line to `COMMANDS.md`; guard the append the same
  way as M1.
- M4 appends one manifest line and one test file; re-running must not duplicate the
  manifest entry (`grep -c 'gate-scripts.test.ts'`).
- M5–M7 replace or create whole files; re-running is a byte-identical rewrite.
- M8 appends ledger events. Appending `NODE_DONE` twice is a governance defect: check
  `sh scripts/ledger.sh status EP-001` first and do not re-tag an existing tag
  (`git tag -l green/EP-001`).

Recovery:

- No milestone is destructive to data or history: nothing drops a database, force-pushes,
  rewrites history, or deletes evidence.
- `dist/` is a build output and is gitignored; `rm -rf dist && sh scripts/build.sh`
  rebuilds it identically.
- Temporary directories created by gates (`mktemp -d`) are removed by `trap ... 0` on
  every exit path, including failure.
- If `npm ci` or `npm install` leaves a suspect tree, remove `node_modules` and reinstall
  from the committed lockfile; never commit a regenerated lockfile without a recorded
  reason and a new candidate epoch note (DOD-040).
- If a milestone fails all six attempts, do not improvise: emit the 5.7 structured
  `NODE_BLOCKED` report (exact blocker, commands, outputs, exit codes, hypotheses tried,
  rungs climbed, smallest human decision, recommended default) and append it to §12.

## 11. Progress

- [ ] M1: Resume inventory, package manager and commit-locked dependencies
- [ ] M2: Real format gate and line-ending normalization
- [ ] M3: Environment validation against PREFLIGHT.md
- [ ] M4: Harness self-tests and the expected-suite manifest
- [ ] M5: Replace the EP-001-labelled placeholders: dependency audit and reality gate
- [ ] M6: Baseline CI that can go red
- [ ] M7: Node gate `scripts/gate-foundation.sh` and the verify.sh progression proof
- [ ] M8: Node close-out

## 12. Surprises & Discoveries

<!-- Append only observed, dated findings, each with the exact command that produced it. -->

## 13. Decision Log

<!-- Append dated decisions with rationale and status; record scope deviations here, never silently. -->

## 14. Outcomes & Retrospective

<!-- Filled in only after the node closes, with real observed evidence and honest limitations. -->

