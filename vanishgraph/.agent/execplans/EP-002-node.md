NODE-META-BEGIN
ID: EP-002
DEPS: EP-001
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/gate-domain.sh
VERIFY_SENTINEL: gate-domain: ok
GREEN_TAG: green/EP-002
NODE-META-END

# EP-002 — Core Domain

## 1. Purpose / Big Picture

Complete the pure domain layer specified by SPEC-001: every value object from §2, the
entities from §3, the ports from §5, the commands from §6, the events from §7, the state
machine invariants SM-1…SM-6 from §4.3, and the acceptance conditions of SPEC-001 §8 —
all of it independently testable with no framework, no database, no network, and no model.

The end state is observable: `src/domain/**` imports only the standard library (proved by
an executable import-boundary test), every illegal transition in SPEC-001 §4.2 is refused
with a typed error and leaves state unchanged, every value object rejects invalid input,
and a **mutation** of a state-machine guard or a value-object boundary makes at least one
test fail (DOD-018). `sh scripts/gate-domain.sh` proves all of it in one run and prints
`gate-domain: ok`.

This node is **resume-oriented**. The domain layer is already partly built: four modules
and 94 passing tests exist and must be preserved, not rewritten. M1 measures exactly what
exists and produces the requirement→test map; later milestones add only what is missing.

## 2. Scope

In scope:

- The remaining value objects of SPEC-001 §2: opaque identifier value objects
  (`SubjectId`, `TenantId`, `CaseId`, `ExposureId`, `SourceId`, `RecipeId`, `ActionId`,
  `EvidenceId`), `ChannelPriority`, `Jurisdiction`, `LegalBasis`, `Money`, plus runtime
  membership guards for `TruthState`, `PermissionClass`, and `EgressClass`, so that
  "every value object rejects invalid input with a typed error" (SPEC-001 §8.1) is
  executably true.
- The entities of SPEC-001 §3 as immutable types with validating factories and the
  invariants from the spec's invariant column.
- The ports of SPEC-001 §5.1 as **declarations only**: the ten domain ports under `src/domain/ports/` and the `JobQueue` application port under `src/application/ports/`.
- The eleven domain commands of SPEC-001 §6 and the twenty-two domain events of §7.
- The state-machine invariants SM-1…SM-6 as executable assertions (SPEC-001 §4.3).
- The import-boundary test proving `domain` imports only the standard library
  (SPEC-001 §1, §8.5) with its own negative case.
- The mutation check (DOD-018): a mutated guard or boundary must be caught by a failing
  test, with automatic restoration and a byte-identical before/after digest.
- Unit tests for every illegal transition in SPEC-001 §4.2 and for value-object
  boundaries.
- `scripts/gate-domain.sh`, the node-level verify, including the collection guard, the
  mutation check, and a zero-skip assertion (DOD-006).

Out of scope: HTTP/API, persistence, adapters, infrastructure, UI, auth, telemetry,
deployment. Those are EP-003 onward. No port may acquire an implementation here.

## 3. Non-goals

- No implementation of any port. `src/domain/ports/index.ts` declares interfaces; adapters
  arrive in EP-004/EP-006/EP-008. A domain module that opens a socket, reads a file, or
  reads the clock directly is a defect this node exists to prevent.
- No database, migration, or SQL work (EP-003).
- No new runtime or dev dependency; the domain layer must stay standard-library-only so
  it remains testable in isolation (SPEC-001 §1).
- No rewrite of the existing modules or tests for style. `truth-state.ts`,
  `state-machine.ts`, `errors.ts`, and `state-machine.test.ts` are the frozen resume
  baseline; `values.ts` is extended by full-body replacement that preserves every
  existing export and behaviour, and `values.test.ts` is extended, never pruned.
- No test may be skipped, marked todo, quarantined, or deleted to obtain a green
  (DOD-006). No assertion may be weakened to accommodate new code (DOD-027).
- No fixture may be the sole proof of a claim: state transitions are proven by executed
  logic, and the mutation check proves the tests observe the behaviour they claim.
- No service-layer behaviour smuggled into the domain (no transaction handling, no
  retries, no I/O, no persistence concerns).
- No claim that `sh scripts/verify.sh` passes: its `integration` stage still fails loudly
  (EP-003 owns it), and the artifact stages cannot pass before EP-009.

## 4. Context and Orientation

**What already exists and is real** (measured at authoring time with
`node --test "tests/**/*.test.ts"`; re-measure in M1):

| Path | State |
|---|---|
| `src/domain/errors.ts` | 22 domain error classes; `DomainError` base with `code`, `classification`, `retryable`, opaque `details`; the OUTCOME / CANDIDATE_FAILURE / SYSTEM_ERROR distinction |
| `src/domain/truth-state.ts` | the eleven truth states, their non-collapse facts, the 24 transition facts, 24 named guards, the 21-row legal transition table T1–T21, and 6 forbidden pairs with reasons |
| `src/domain/state-machine.ts` | `applyTransition`, `applyInitialState`, `legalTransitionsFrom`, `availableTransitions`, `isTruthState`, `assertSingleState`, `noFacts`, `happyPathFacts` |
| `src/domain/values.ts` | `Confidence` (basis mandatory), `IdempotencyKey`, `EvidenceDigest`, `ObservationWindow`, `PermissionClass`, `EgressClass`, `DENY_BY_DEFAULT_EGRESS`, `requiresExplicitPolicy`, `permitsAutomatedWrite` |
| `tests/domain/state-machine.test.ts` | 71 tests: the eleven states, all 21 legal transitions, the forbidden pairs, the independent-observation guard, SM-1…SM-6, `availableTransitions` |
| `tests/domain/values.test.ts` | 23 tests: `Confidence` (incl. "a score with NO basis is unrepresentable"), `IdempotencyKey`, `EvidenceDigest`, `ObservationWindow`, `PermissionClass`, `EgressClass` |
| `scripts/import-boundary.sh` | real check over `src/domain/**`: relative and `node:*` specifiers permitted, anything else fails |
| measured suite | **94 tests, 94 pass, 0 fail, 0 skipped** via `node --test "tests/**/*.test.ts"` |

**What is missing relative to SPEC-001** (this node's work):

- §2: the eight opaque id value objects; `ChannelPriority`, `Jurisdiction`, `LegalBasis`,
  `Money`; runtime guards for `TruthState` / `PermissionClass` / `EgressClass`.
  `Confidence`, `IdempotencyKey`, `EvidenceDigest`, `ObservationWindow` already exist.
- §3: all 27 entities (none exist as types or factories).
- §5.1: the ten domain ports and the `JobQueue` application port (none declared). Declaring `JobQueue` here, not in EP-003, keeps port declaration in one node (SPEC-001 §5.1 rule 4).
- §6: the eleven domain commands (none exist).
- §7: the twenty-two domain events (none exist).
- §4.3: SM-1…SM-6 are asserted inside `state-machine.test.ts` for a few cases; the full
  invariant set as reusable, executable assertions does not exist.
- §4.2: the four *conditional* illegal-transition rules (ACKNOWLEDGED→VERIFIED_REMOVED
  without an observation; VERIFIED_REMOVED→VERIFIED_REMOVED by the acting path; any
  transition while authority is expired/revoked; any write while the recipe is
  stale/unsigned) are enforced by guards but have no dedicated negative test.
- §8.5: the import-boundary property exists as a shell gate but not as an executable
  test with its own negative case.
- §8.6: the mutation check does not exist.

**Two SPEC-001 inconsistencies this node resolves** (recorded here and in the ledger;
they are documentation defects, not code defects):

1. SPEC-001 §6 says `RecordControllerResponse` emits `HumanGateRaised`, but §7's event
   catalogue — the normative event list — contains `HumanRequired`, not `HumanGateRaised`.
   Resolution: emit `HumanRequired`. No `HumanGateRaised` event is created.
2. SPEC-001 §3.4 names a `MailPiece.provider` field and §3.5 a
   `ProviderTransportRun.provider` field, while SPEC-000 §4 lists `provider` as a
   forbidden synonym for `Source`. The entity name `ProviderTransportRun` is mandated by
   both SPEC-001 §3.5 and SPEC-002 §2's table list, so it stays. The ambiguous bare field
   name does not: both entities carry `transportName` in the domain (SQL column
   `transport_name`), documented as the SPEC-001 `provider` field meaning the postal or
   transport service, which is not a `Source`. This keeps a forbidden synonym from
   becoming a standalone identifier while preserving the mandated entity name.

**Vocabulary and shape discipline.** `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, and
`isolatedModules` are on. That means: no `enum`, no `namespace`, no constructor parameter
properties, `import type` for type-only imports, explicit `undefined` handling on indexed
access, and no assigning `undefined` to an optional property. TypeScript is executed
directly by Node ≥ 24 through native type stripping, so every construct used must be
erasable.

**Node verify choice, stated honestly.** The stub header declared
`VERIFY: sh scripts/verify.sh` / `verify: ok`; that is unreachable before EP-009 because
the last five stages are artifact-bound (master prompt §10, line 1357, fixes the full
fifteen-stage order), and EP-000/EP-001 already narrowed their node verifies for the same
reason. This node declares `VERIFY: sh scripts/gate-domain.sh` / `gate-domain: ok`. No
stage is removed, reordered, or exempted in `verify.sh`.

## 5. Files to Read First

- `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`,
  `.agent/EXECUTION_RULES.md`, `.agent/PLANS.md`
- `.agent/DONE_LAW.md` — DOD-001, DOD-006, DOD-007, DOD-008, DOD-010, DOD-018, DOD-019,
  DOD-024, DOD-025, DOD-026, DOD-027
- `.agent/specs/SPEC-000-product-scope.md` (§4 vocabulary, §5 truth model, §5.1
  non-collapse, §6 requirements, §9 acceptance oracle)
- `.agent/specs/SPEC-001-core-domain.md` (the whole file: §1 layer contract, §2 value
  objects, §3 entities, §4 state machine incl. §4.2 illegal transitions and §4.3
  invariants, §5 ports, §6 commands, §7 events, §8 acceptance)
- `.agent/specs/SPEC-006-errors.md` (error taxonomy and classification)
- `ARCHITECTURE.md` (code law), `TESTING.md`, `SECURITY.md`
- `.agent/execplans/EP-001-node.md` (the node this depends on: gate contract, sentinel
  discipline, manifest)
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/verification/HARNESS_LAWS.md`
- `.agent/checklists/implementation.md`, `.agent/checklists/validation.md`
- Existing code, read in full before extending: `src/domain/errors.ts`,
  `src/domain/truth-state.ts`, `src/domain/state-machine.ts`, `src/domain/values.ts`,
  `tests/domain/state-machine.test.ts`, `tests/domain/values.test.ts`
- Gates: `scripts/lint.sh`, `scripts/import-boundary.sh`, `scripts/test-unit.sh`,
  `scripts/test-collection-guard.sh`, `scripts/count-tests.mjs`, `scripts/verify.sh`
- `.agent/state/LEDGER.md`

## 6. Expected Changed Files

Paths are relative to the project root. This is the audit list; nothing else may change.

Created:

- `src/domain/identifiers.ts`
- `src/domain/entities.ts`
- `src/domain/events.ts`
- `src/domain/ports/index.ts`
- `src/domain/invariants.ts`
- `src/domain/commands.ts`
- `tests/domain/identifiers.test.ts`
- `tests/domain/entities.test.ts`
- `tests/domain/events.test.ts`
- `tests/domain/commands.test.ts`
- `tests/domain/invariants.test.ts`
- `tests/domain/illegal-transitions.test.ts`
- `tests/architecture/import-boundary.test.ts`
- `tests/domain/DOMAIN_TEST_MAP.csv` (requirement → test traceability for this node;
  EP-010 folds these rows into the canonical registry accounting)
- `scripts/mutation-check.sh`
- `scripts/lib/mutations.ts`
- `scripts/gate-domain.sh`
- `.agent/evidence/EP-002/**`

Modified:

- `src/domain/values.ts` (full-body replacement: every existing export preserved and
  extended)
- `tests/domain/values.test.ts` (append new value-object boundary describes; no existing
  test removed or changed)
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt` (one line per new suite)
- `tsconfig.json` (extend `include` with `scripts/**/*.ts` so `scripts/lib/mutations.ts`
  is typechecked by the same strict configuration as the domain code)
- `COMMANDS.md` (declare the new commands and their sentinels)
- `TESTING.md` (record the domain test commands, the mutation check, and the double
  boundary: ports may be doubled for isolation, never as final proof — DOD-010)
- `.agent/state/LEDGER.md`

Explicitly not changed: `src/domain/errors.ts`, `src/domain/truth-state.ts`,
`src/domain/state-machine.ts`, `tests/domain/state-machine.test.ts`,
`scripts/verify.sh` (stage order untouched), `RELEASE_GATE.json` (verdict stays
`INCONCLUSIVE`).

## 7. Interfaces and Contracts

**Layer contract (SPEC-001 §1, `ARCHITECTURE.md` code law).** `src/domain/**` may import
only the standard library (`node:*`) and relative domain modules. It must not import
`application`, `adapters`, `http`, `ui`, `mcp`, or `infrastructure`, and must not import
any third-party package. This is enforced by `scripts/import-boundary.sh` in `lint` and
by `tests/architecture/import-boundary.test.ts`, both of which must be able to fail.

**Domain ports (SPEC-001 §5).** The domain *declares* `Clock`, `IdGenerator`,
`EvidenceStore`, `SourceReader`, `ChannelWriter`, `IndependentObserver`,
`PolicyRepository`, `AuditSink`, `EgressGate`, `SecretResolver`. `ports.ts` contains
interfaces only: importing it at runtime must yield zero exports, which the test suite
asserts. `Clock` and `IdGenerator` exist so that observation windows and scheduled
re-observation are testable without sleeping and without network; using them is real
logic, not a mock of the code under test (DOD-010 permits doubles for isolation, never as
final proof).

**Commands (SPEC-001 §6).** Each command validates its preconditions, applies **exactly
one** transition through `applyTransition`/`applyInitialState` (never by assigning a
state), appends an `AuditEvent`, and returns the emitted domain events. No command
performs I/O; effects are declared through ports and executed by adapters in later nodes.
`ExecuteAction` is the only command with an external effect and therefore the only one
whose idempotency is enforced (`IdempotencyKey`, VG-ACTION-001).

**Events (SPEC-001 §7).** Immutable past-tense facts carrying `correlationId` and
`tenantId`. Payloads are restricted to opaque scalars (`string | number | boolean |
null`) and are rejected if they contain apparent PII. Events are the only channel by which
the application layer reacts to domain change; the domain never calls outward.

**State machine (SPEC-001 §4).** The table in `truth-state.ts` is the single source of
truth; the domain only evaluates it. Every transition produces the evidence named in
§4.1 or is refused. Any pair not in the table is illegal, and the six documented
forbidden pairs are refused with a reason rather than a generic error.
Non-collapse rules (SPEC-000 §5.1) hold as executable facts: `REQUEST_SUBMITTED` and
`ACKNOWLEDGED` never assert removal, `SEARCH_DELISTED` never asserts source deletion, and
`VERIFIED_REMOVED` requires an observation from a path distinct from the acting path.

**Truth-state vocabulary is reserved.** The eleven SPEC-000 §5 states are the only
terminal-status tokens. `DONE`, `COMPLETE`, `SUCCESS`, `REMOVED`, and ad-hoc synonyms are
rejected by `assertTruthState` and by tests. `HUMAN_REQUIRED` and `NOT_REMOVABLE` are
legitimate outcomes; classifying them as errors or failures is a defect.

**Vocabulary lock (SPEC-000 §4).** Canonical tokens only in identifiers, test names, and
event names: `ProtectedSubject`, `AuthorityGrant`, `Source`, `RemovalRecipe`,
`SourceRecord`, `Exposure`, `Confidence`, `PolicyDecision`, `RequestCase`,
`ExternalAction`, `IdempotencyKey`, `VerificationObservation`, `Reappearance`,
`EvidenceArtifact`, `Controller`, `HumanGate`, `DLP`. Forbidden synonyms must not appear
as identifiers; where a spec-mandated name contains one (`ProviderTransportRun`), it is
kept as the spec mandates and the bare field name is `transportName` (§4).

**Command lock.** Every command this node runs is declared in `COMMANDS.md` in the same
commit that introduces it.

**Honesty rules.** No permanent-deletion claims (the strongest removal state is
`VERIFIED_REMOVED`, scoped to one `Source` and one observation window); search and source
are separate effects; `HUMAN_REQUIRED` is not a failure; a green suite is never evidence
unless it can go red (hence the mutation check).

## 8. Milestones

Milestones are executed in order. Each ends with a real sentinel, a ledger append, and a
commit. On an unmet `EXPECT`, climb the 5.3 ladder; use the declared `FALLBACK` at rung 3;
never repeat the same fix twice; never weaken an assertion to pass.

### M1: Resume inventory and the domain requirement→test map

GOAL: A measured inventory states exactly which SPEC-001 items already exist, and
`tests/domain/DOMAIN_TEST_MAP.csv` maps every existing domain test to its requirement.

READ: `src/domain/*.ts`, `tests/domain/*.test.ts`, `.agent/specs/SPEC-001-core-domain.md`,
`.agent/specs/SPEC-000-product-scope.md` §6, `TESTING.md`, `CONTRIBUTING.md`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`.

CHANGE: `tests/domain/DOMAIN_TEST_MAP.csv` (create);
`.agent/evidence/EP-002/M1-baseline.txt` (create). No source change in this milestone.

CONTENT:

(a) Capture the baseline with real commands:

```sh
mkdir -p .agent/evidence/EP-002
{ echo "== files =="; git ls-files src/domain tests | sort; \
  echo "== suite =="; node --test "tests/**/*.test.ts" 2>&1 | tail -n 12; \
  echo "== lint =="; sh scripts/lint.sh; \
  echo "== per-file counts =="; for f in $(find tests -name '*.test.ts' | sort); do printf '%s ' "$f"; node --test --test-reporter=tap "$f" 2>/dev/null | grep -cE '^ *(ok|not ok) [0-9]+ - '; done; } 2>&1 | tee .agent/evidence/EP-002/M1-baseline.txt
```

(b) Create the traceability map. One row per requirement the domain layer can satisfy,
with the test that proves it. `status` is `PASS` only for a test that exists and passes in
this session; everything else is `PLANNED` (DOD-001, DOD-026). Fill the file with exactly
these rows, then append rows as later milestones add tests:

FILE: tests/domain/DOMAIN_TEST_MAP.csv   (CREATE)
```csv
requirement_id,spec_section,test_id,test_file,test_name,command,status
VG-IDENT-001,SPEC-001 3.1,T-VG-IDENT-001-01,tests/domain/entities.test.ts,a subject requires a valid AuthorityGrant,node --test "tests/**/*.test.ts",PLANNED
VG-IDENT-002,SPEC-001 3.1,T-VG-IDENT-002-01,tests/domain/entities.test.ts,an ambiguous alias is quarantined rather than attached,node --test "tests/**/*.test.ts",PLANNED
VG-IDENT-003,SPEC-001 2,T-VG-IDENT-003-01,tests/domain/values.test.ts,a score with NO basis is unrepresentable,node --test "tests/**/*.test.ts",PASS
VG-IDENT-004,SPEC-001 4.2,T-VG-IDENT-004-01,tests/domain/illegal-transitions.test.ts,DISCOVERED_CANDIDATE cannot jump to REQUEST_READY,node --test "tests/**/*.test.ts",PLANNED
VG-AUTHZ-001,SPEC-001 3.1,T-VG-AUTHZ-001-01,tests/domain/invariants.test.ts,an expired grant is refused at execution time,node --test "tests/**/*.test.ts",PLANNED
VG-AUTHZ-002,SPEC-001 3.1,T-VG-AUTHZ-002-01,tests/domain/entities.test.ts,an AGENT grant requires a signed instrument and evidence,node --test "tests/**/*.test.ts",PLANNED
VG-POLICY-001,SPEC-001 3.3,T-VG-POLICY-001-01,tests/domain/entities.test.ts,model output cannot author a jurisdiction policy,node --test "tests/**/*.test.ts",PLANNED
VG-POLICY-002,SPEC-001 3.3,T-VG-POLICY-002-01,tests/domain/invariants.test.ts,an incomplete PolicyDecision cannot reach REQUEST_READY,node --test "tests/**/*.test.ts",PLANNED
VG-POLICY-004,SPEC-001 3.1,T-VG-POLICY-004-01,tests/domain/invariants.test.ts,a minor subject cannot enter an automated write lane,node --test "tests/**/*.test.ts",PLANNED
VG-CHANNEL-001,SPEC-001 8,T-VG-CHANNEL-001-01,tests/domain/values.test.ts,a lower-priority channel needs every higher one recorded unavailable,node --test "tests/**/*.test.ts",PLANNED
VG-CHANNEL-002,SPEC-001 3.2,T-VG-CHANNEL-002-01,tests/domain/invariants.test.ts,WRITE_UNCLEAR forbids writes exactly like PROHIBITED,node --test "tests/**/*.test.ts",PLANNED
VG-CHANNEL-003,SPEC-001 3.2,T-VG-CHANNEL-003-01,tests/domain/invariants.test.ts,a stale or unsigned recipe cannot write,node --test "tests/**/*.test.ts",PLANNED
VG-ACTION-001,SPEC-001 3.4,T-VG-ACTION-001-01,tests/domain/commands.test.ts,one idempotency key yields one external effect,node --test "tests/**/*.test.ts",PLANNED
VG-ACTION-002,SPEC-001 3.4,T-VG-ACTION-002-01,tests/domain/commands.test.ts,an ambiguous effect reconciles instead of retrying,node --test "tests/**/*.test.ts",PLANNED
VG-ACTION-005,SPEC-001 3.4,T-VG-ACTION-005-01,tests/domain/invariants.test.ts,an exhausted effect budget refuses the action,node --test "tests/**/*.test.ts",PLANNED
VG-VERIFY-001,SPEC-001 4.2,T-VG-VERIFY-001-01,tests/domain/invariants.test.ts,an observation from the acting path is refused,node --test "tests/**/*.test.ts",PLANNED
VG-VERIFY-002,SPEC-001 4.1,T-VG-VERIFY-002-01,tests/domain/values.test.ts,the observation window must genuinely elapse,node --test "tests/**/*.test.ts",PASS
VG-VERIFY-003,SPEC-001 3.4,T-VG-VERIFY-003-01,tests/domain/invariants.test.ts,a method mismatch invalidates the observation,node --test "tests/**/*.test.ts",PLANNED
VG-VERIFY-004,SPEC-001 4.2,T-VG-VERIFY-004-01,tests/domain/illegal-transitions.test.ts,REQUEST_SUBMITTED cannot become VERIFIED_REMOVED,node --test "tests/**/*.test.ts",PASS
VG-REAPPEAR-001,SPEC-001 3.4,T-VG-REAPPEAR-001-01,tests/domain/entities.test.ts,Reappearance links to a prior VERIFIED_REMOVED,node --test "tests/**/*.test.ts",PLANNED
VG-EVIDENCE-001,SPEC-001 3.5,T-VG-EVIDENCE-001-01,tests/domain/values.test.ts,malformed digests are refused,node --test "tests/**/*.test.ts",PASS
VG-EVIDENCE-003,SPEC-001 3.5,T-VG-EVIDENCE-003-01,tests/domain/entities.test.ts,an audit event cannot carry apparent PII,node --test "tests/**/*.test.ts",PLANNED
VG-SEC-001,SPEC-001 3.2,T-VG-SEC-001-01,tests/domain/entities.test.ts,a tainted source record cannot direct an action,node --test "tests/**/*.test.ts",PLANNED
VG-EGRESS-001,SPEC-001 2,T-VG-EGRESS-001-01,tests/domain/values.test.ts,the four protected classes are deny-by-default,node --test "tests/**/*.test.ts",PASS
VG-REL-004,SPEC-001 1,T-VG-REL-004-01,tests/architecture/import-boundary.test.ts,the domain layer imports only the standard library,node --test "tests/**/*.test.ts",PLANNED
SPEC-001-4.2-all,SPEC-001 4.2,T-SPEC-001-4.2-all,tests/domain/illegal-transitions.test.ts,every documented illegal transition is refused with a typed error,node --test "tests/**/*.test.ts",PLANNED
SPEC-001-4.3-SM,SPEC-001 4.3,T-SPEC-001-4.3-SM,tests/domain/invariants.test.ts,SM-1 through SM-6 hold as executable assertions,node --test "tests/**/*.test.ts",PLANNED
SPEC-001-6-cmd,SPEC-001 6,T-SPEC-001-6-cmd,tests/domain/commands.test.ts,all eleven commands apply exactly one transition and audit it,node --test "tests/**/*.test.ts",PLANNED
SPEC-001-7-evt,SPEC-001 7,T-SPEC-001-7-evt,tests/domain/events.test.ts,all twenty-two events exist with correlationId and tenantId,node --test "tests/**/*.test.ts",PLANNED
SPEC-001-8.6,SPEC-001 8.6,T-SPEC-001-8.6,tests/domain/DOMAIN_TEST_MAP.csv,a mutated guard makes a test fail (DOD-018),sh scripts/mutation-check.sh,PLANNED
```

RUN:

```sh
mkdir -p .agent/evidence/EP-002
{ echo "== files =="; git ls-files src/domain tests | sort; \
  echo "== suite =="; node --test "tests/**/*.test.ts" 2>&1 | tail -n 12; \
  echo "== lint =="; sh scripts/lint.sh; \
  echo "== per-file counts =="; for f in $(find tests -name '*.test.ts' | sort); do printf '%s ' "$f"; node --test --test-reporter=tap "$f" 2>/dev/null | grep -cE '^ *(ok|not ok) [0-9]+ - '; done; } 2>&1 | tee .agent/evidence/EP-002/M1-baseline.txt
wc -l tests/domain/DOMAIN_TEST_MAP.csv
grep -c ',PASS$' tests/domain/DOMAIN_TEST_MAP.csv
```

EXPECT: `.agent/evidence/EP-002/M1-baseline.txt` contains the measured suite summary with
`pass` strictly greater than zero and `fail 0` (the authoring-time measurement was 94 pass
/ 0 fail / 0 skipped), and `lint: ok`; `wc -l` on the map prints `31` (one header plus 30
rows); the `,PASS$` count is `5` (the requirements already proven by the existing suite).
If the measured count differs, correct the map's `status` column to match measurement —
never the reverse.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-002 MILESTONE_PASS "M1 baseline measured; requirement-to-test map created"`

FALLBACK: if the per-file test count command misbehaves on this platform, replace it with
`node --test --test-reporter=junit <file>` parsed by the existing `scripts/count-tests.mjs`
— the same measurement through the harness that already works.

COMMIT: `git add -A && git commit -m "[EP-002][M1] measure domain baseline and map requirements to tests"`

### M2: Remaining value objects and runtime membership guards

GOAL: Every value object in SPEC-001 §2 exists, rejects invalid input with a typed error,
and compares by value.

READ: `.agent/specs/SPEC-001-core-domain.md` §2 and §8, `src/domain/values.ts`,
`src/domain/errors.ts`, `src/domain/truth-state.ts`, `tests/domain/values.test.ts`,
`tests/domain/DOMAIN_TEST_MAP.csv`.

CHANGE: `src/domain/identifiers.ts` (create); `src/domain/values.ts` (full-body
replacement); `tests/domain/identifiers.test.ts` (create); `tests/domain/values.test.ts`
(append new describes only); `.agent/verification/EXPECTED_TEST_MANIFEST.txt` (append the
new suite); `tests/domain/DOMAIN_TEST_MAP.csv` (update the value-object rows by
measurement).

CONTENT:

FILE: src/domain/identifiers.ts   (CREATE)
```ts
/**
 * Opaque identifier value objects (SPEC-001 §2).
 *
 * Capability identifiers (subject, tenant, case, exposure, source, recipe, action,
 * evidence) are opaque strings, never a raw PII value. That is not decoration: an
 * email address or a phone number must be *unrepresentable* as an identifier, so no
 * code path can promote a personal value into a primary key, a log field, or a metric
 * label (SPEC-001 §3 closing rule, VG-SEC-002).
 *
 * One class per kind means a CaseId cannot be passed where an ExposureId is expected:
 * cross-kind confusion is a compile error, not a runtime surprise.
 *
 * Construction of an invalid identifier throws InvalidValueObject (SPEC-006).
 */

import { InvalidValueObject } from './errors.ts';

/** The eight identifier kinds declared by SPEC-001 §2. */
export type IdKind =
  | 'SubjectId'
  | 'TenantId'
  | 'CaseId'
  | 'ExposureId'
  | 'SourceId'
  | 'RecipeId'
  | 'ActionId'
  | 'EvidenceId';

/** Canonical opaque-id shape: starts alphanumeric, then [A-Za-z0-9._:-], max 128. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A run of seven or more digits looks like a phone number or a government id. */
const LONG_DIGIT_RUN = /\d{7,}/;
/** An email address is PII, and must never be an identifier. */
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/;

export abstract class OpaqueId {
  readonly kind: IdKind;
  readonly value: string;

  protected constructor(kind: IdKind, value: string) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new InvalidValueObject(kind, 'must be a non-empty string');
    }
    if (value !== value.trim()) {
      throw new InvalidValueObject(kind, 'must not have surrounding whitespace');
    }
    if (!ID_PATTERN.test(value)) {
      throw new InvalidValueObject(
        kind,
        `must be an opaque identifier of at most 128 characters starting alphanumerically; received length ${value.length}`,
      );
    }
    if (EMAIL_LIKE.test(value) || LONG_DIGIT_RUN.test(value)) {
      throw new InvalidValueObject(
        kind,
        'must be an opaque identifier, never a raw PII value (SPEC-001 §2)',
      );
    }
    this.kind = kind;
    this.value = value;
  }

  equals(other: OpaqueId): boolean {
    return this.kind === other.kind && this.value === other.value;
  }

  toString(): string {
    return `${this.kind}:${this.value}`;
  }
}

export class SubjectId extends OpaqueId {
  constructor(value: string) {
    super('SubjectId', value);
  }
}

export class TenantId extends OpaqueId {
  constructor(value: string) {
    super('TenantId', value);
  }
}

export class CaseId extends OpaqueId {
  constructor(value: string) {
    super('CaseId', value);
  }
}

export class ExposureId extends OpaqueId {
  constructor(value: string) {
    super('ExposureId', value);
  }
}

export class SourceId extends OpaqueId {
  constructor(value: string) {
    super('SourceId', value);
  }
}

export class RecipeId extends OpaqueId {
  constructor(value: string) {
    super('RecipeId', value);
  }
}

export class ActionId extends OpaqueId {
  constructor(value: string) {
    super('ActionId', value);
  }
}

export class EvidenceId extends OpaqueId {
  constructor(value: string) {
    super('EvidenceId', value);
  }
}
```

FILE: src/domain/values.ts   (MODIFY — full-body replacement; every existing export preserved)
```ts
/**
 * Domain value objects (SPEC-001 §2).
 *
 * Immutable, self-validating, equality by value. Constructing an invalid value THROWS
 * rather than coercing: the point is to make unsafe states unrepresentable rather than
 * to validate later.
 *
 *   - `Confidence` cannot exist without a recorded basis (VG-IDENT-003).
 *   - `EvidenceDigest` cannot hold a malformed hash (VG-EVIDENCE-001).
 *   - `IdempotencyKey` cannot be blank, so "one key, one effect" has something real to
 *     bind to (VG-ACTION-001).
 *   - `Jurisdiction` cannot be lowercase or unqualified, and `LegalBasis` always names
 *     the policy version it came from, so a legal basis can never be free-floating
 *     model output (VG-POLICY-001).
 *   - `Money` is integer minor units only: no float arithmetic (SPEC-001 §2).
 */

import { InvalidValueObject } from './errors.ts';
import { ALL_TRUTH_STATES, type TruthState } from './truth-state.ts';

/** Calibrated match confidence in [0,1] with a mandatory recorded basis. */
export class Confidence {
  readonly value: number;
  readonly basis: readonly string[];

  constructor(value: number, basis: readonly string[]) {
    if (!Number.isFinite(value)) {
      throw new InvalidValueObject('Confidence', `value must be finite, got ${String(value)}`);
    }
    if (value < 0 || value > 1) {
      throw new InvalidValueObject('Confidence', `value must be within [0,1], got ${value}`);
    }
    if (!Array.isArray(basis) || basis.length === 0) {
      throw new InvalidValueObject(
        'Confidence',
        'basis is required; a score with no recorded basis is not evidence (VG-IDENT-003)',
      );
    }
    for (const reason of basis) {
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new InvalidValueObject('Confidence', 'basis entries must be non-empty strings');
      }
    }
    this.value = value;
    this.basis = Object.freeze([...basis]);
  }

  atLeast(threshold: number): boolean {
    return this.value >= threshold;
  }

  equals(other: Confidence): boolean {
    return (
      this.value === other.value &&
      this.basis.length === other.basis.length &&
      this.basis.every((b, i) => b === other.basis[i])
    );
  }
}

/** Stable key making one external effect happen at most once (VG-ACTION-001). */
export class IdempotencyKey {
  readonly value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidValueObject('IdempotencyKey', 'must be a non-empty string');
    }
    if (value !== value.trim()) {
      throw new InvalidValueObject(
        'IdempotencyKey',
        'must not have leading or trailing whitespace (keys are compared exactly)',
      );
    }
    if (value.length > 200) {
      throw new InvalidValueObject('IdempotencyKey', 'must be at most 200 characters');
    }
    this.value = value;
  }

  equals(other: IdempotencyKey): boolean {
    return this.value === other.value;
  }
}

/** SHA-256 content digest of an EvidenceArtifact (VG-EVIDENCE-001). */
export class EvidenceDigest {
  static readonly PATTERN = /^[0-9a-f]{64}$/;
  readonly value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || !EvidenceDigest.PATTERN.test(value)) {
      throw new InvalidValueObject(
        'EvidenceDigest',
        'must be 64 lowercase hexadecimal characters (SHA-256)',
      );
    }
    this.value = value;
  }

  equals(other: EvidenceDigest): boolean {
    return this.value === other.value;
  }
}

/** Minimum time that must elapse before a removal may be verified (VG-VERIFY-002). */
export class ObservationWindow {
  readonly durationMs: number;
  readonly method: string;

  constructor(durationMs: number, method: string) {
    if (!Number.isInteger(durationMs) || durationMs <= 0) {
      throw new InvalidValueObject(
        'ObservationWindow',
        `durationMs must be a positive integer, got ${String(durationMs)}`,
      );
    }
    if (typeof method !== 'string' || method.trim().length === 0) {
      throw new InvalidValueObject('ObservationWindow', 'method must be a non-empty string');
    }
    this.durationMs = durationMs;
    this.method = method;
  }

  hasElapsed(observedAtMs: number, startedAtMs: number): boolean {
    return observedAtMs - startedAtMs >= this.durationMs;
  }
}

/** Source write-permission classification (SPEC-002 permission_class). */
export type PermissionClass =
  | 'READ_ONLY'
  | 'WRITE_PERMITTED'
  | 'WRITE_UNCLEAR'
  | 'PROHIBITED';

export const PERMISSION_CLASSES = [
  'READ_ONLY',
  'WRITE_PERMITTED',
  'WRITE_UNCLEAR',
  'PROHIBITED',
] as const satisfies readonly PermissionClass[];

export function isPermissionClass(value: unknown): value is PermissionClass {
  return typeof value === 'string' && (PERMISSION_CLASSES as readonly string[]).includes(value);
}

export function assertPermissionClass(value: unknown): PermissionClass {
  if (!isPermissionClass(value)) {
    throw new InvalidValueObject(
      'PermissionClass',
      `must be one of ${PERMISSION_CLASSES.join(', ')}; received ${String(value)}`,
    );
  }
  return value;
}

/** Data egress classification (DATA_EGRESS_MATRIX.md, SPEC-002 egress_class). */
export type EgressClass =
  | 'NONE'
  | 'OPAQUE_ID'
  | 'CUSTOMER_PII'
  | 'HIGH_RISK_PII'
  | 'IDENTITY_DOCUMENT'
  | 'AUTH_SECRET';

export const EGRESS_CLASSES = [
  'NONE',
  'OPAQUE_ID',
  'CUSTOMER_PII',
  'HIGH_RISK_PII',
  'IDENTITY_DOCUMENT',
  'AUTH_SECRET',
] as const satisfies readonly EgressClass[];

export function isEgressClass(value: unknown): value is EgressClass {
  return typeof value === 'string' && (EGRESS_CLASSES as readonly string[]).includes(value);
}

export function assertEgressClass(value: unknown): EgressClass {
  if (!isEgressClass(value)) {
    throw new InvalidValueObject(
      'EgressClass',
      `must be one of ${EGRESS_CLASSES.join(', ')}; received ${String(value)}`,
    );
  }
  return value;
}

/**
 * Egress is deny-by-default for protected classes (VG-EGRESS-001). Only a caller that
 * can demonstrate a tenant policy decision may send these outward.
 */
export const DENY_BY_DEFAULT_EGRESS: readonly EgressClass[] = Object.freeze([
  'CUSTOMER_PII',
  'HIGH_RISK_PII',
  'IDENTITY_DOCUMENT',
  'AUTH_SECRET',
] as const);

export function requiresExplicitPolicy(egressClass: EgressClass): boolean {
  return DENY_BY_DEFAULT_EGRESS.includes(egressClass);
}

/**
 * Only WRITE_PERMITTED sources may be written to. WRITE_UNCLEAR is deliberately treated
 * exactly like PROHIBITED: an unclear permission is not a permission (VG-CHANNEL-002).
 */
export function permitsAutomatedWrite(permissionClass: PermissionClass): boolean {
  return permissionClass === 'WRITE_PERMITTED';
}

/** The eleven SPEC-000 §5 states are the only permitted status vocabulary (SPEC-000 §4). */
export function assertTruthState(value: unknown): TruthState {
  if (typeof value !== 'string' || !(ALL_TRUTH_STATES as readonly string[]).includes(value)) {
    throw new InvalidValueObject(
      'TruthState',
      `must be one of the eleven canonical truth states; received ${String(value)}. ` +
        'Ad-hoc statuses such as DONE, COMPLETE, SUCCESS or REMOVED are forbidden (SPEC-000 §4).',
    );
  }
  return value as TruthState;
}

/**
 * Channel priority model (SPEC-000 §8). 1 is the highest priority. A lower-priority
 * channel (a larger number) may be selected only when every higher-priority channel is
 * recorded as unavailable, unlawful, or gated, with a reason (VG-CHANNEL-001).
 */
export const CHANNEL_NAMES = [
  'OFFICIAL_SELF_SERVICE',
  'OFFICIAL_PRIVACY_CONTACT',
  'AUTHORIZED_AGENT',
  'GOVERNMENT_CHANNEL',
  'SEARCH_ENGINE_REMOVAL',
  'CERTIFIED_MAIL',
  'APPEAL_OR_REGULATOR',
  'NOT_REMOVABLE_OUTCOME',
] as const;

export type ChannelName = (typeof CHANNEL_NAMES)[number];

export class ChannelPriority {
  static readonly MIN = 1;
  static readonly MAX = 8;

  readonly value: number;

  constructor(value: number) {
    if (!Number.isInteger(value) || value < ChannelPriority.MIN || value > ChannelPriority.MAX) {
      throw new InvalidValueObject(
        'ChannelPriority',
        `must be an integer ${ChannelPriority.MIN}..${ChannelPriority.MAX} matching SPEC-000 §8; received ${String(value)}`,
      );
    }
    this.value = value;
  }

  channelName(): ChannelName {
    const name = CHANNEL_NAMES[this.value - 1];
    if (name === undefined) {
      throw new InvalidValueObject('ChannelPriority', `no channel at priority ${this.value}`);
    }
    return name;
  }

  equals(other: ChannelPriority): boolean {
    return this.value === other.value;
  }
}

export function priorityOf(channel: ChannelName): ChannelPriority {
  const index = (CHANNEL_NAMES as readonly string[]).indexOf(channel);
  if (index < 0) {
    throw new InvalidValueObject('ChannelName', `unknown channel ${channel}`);
  }
  return new ChannelPriority(index + 1);
}

/** Why a higher-priority channel could not be used. A bare "unavailable" is not enough. */
export type ChannelUnavailableKind = 'UNAVAILABLE' | 'UNLAWFUL' | 'GATED';

export interface ChannelOption {
  readonly channel: ChannelName;
  readonly unavailableKind: ChannelUnavailableKind | null;
  /** Required whenever `unavailableKind` is set: the recorded reason (VG-CHANNEL-001). */
  readonly unavailableReason: string | null;
}

/**
 * Select the highest-priority lawful channel and return it together with the rejected
 * alternatives, so the caller can record why each higher-priority channel was not used.
 * A malformed option set (an unavailable channel with no reason) is refused, and an
 * option set with no lawful channel is refused too: the honest outcome in that case is
 * NOT_REMOVABLE, never a forced write.
 */
export function selectChannel(options: readonly ChannelOption[]): ChannelOption {
  if (options.length === 0) {
    throw new InvalidValueObject('ChannelOption', 'at least one channel must be considered');
  }
  for (const option of options) {
    if (option.unavailableKind !== null) {
      if (option.unavailableReason === null || option.unavailableReason.trim().length === 0) {
        throw new InvalidValueObject(
          'ChannelOption',
          `channel ${option.channel} is marked ${option.unavailableKind} without a recorded reason (VG-CHANNEL-001)`,
        );
      }
    }
  }
  const available = options
    .filter((option) => option.unavailableKind === null)
    .sort((a, b) => priorityOf(a.channel).value - priorityOf(b.channel).value);
  const selected = available[0];
  if (selected === undefined) {
    throw new InvalidValueObject(
      'ChannelOption',
      'no lawful channel is available; the honest outcome is NOT_REMOVABLE, not a forced write',
    );
  }
  return selected;
}

export function rejectedChannels(
  options: readonly ChannelOption[],
  selected: ChannelOption,
): readonly ChannelOption[] {
  return options.filter(
    (option) => priorityOf(option.channel).value < priorityOf(selected.channel).value,
  );
}

/** ISO 3166-2 jurisdiction code, uppercase (SPEC-001 §2). */
export class Jurisdiction {
  static readonly PATTERN = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
  readonly value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || !Jurisdiction.PATTERN.test(value)) {
      throw new InvalidValueObject(
        'Jurisdiction',
        'must be an uppercase ISO 3166-2 code such as US or US-CA',
      );
    }
    this.value = value;
  }

  country(): string {
    return this.value.slice(0, 2);
  }

  equals(other: Jurisdiction): boolean {
    return this.value === other.value;
  }
}

/** A legal basis always names the policy version it came from (VG-POLICY-001). */
export class LegalBasis {
  static readonly PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
  readonly code: string;
  readonly policyVersion: number;

  constructor(code: string, policyVersion: number) {
    if (typeof code !== 'string' || !LegalBasis.PATTERN.test(code)) {
      throw new InvalidValueObject(
        'LegalBasis',
        'must be an uppercase token from versioned policy data, not free text or model output',
      );
    }
    if (!Number.isInteger(policyVersion) || policyVersion < 1) {
      throw new InvalidValueObject(
        'LegalBasis',
        `policyVersion must be a positive integer; received ${String(policyVersion)}`,
      );
    }
    this.code = code;
    this.policyVersion = policyVersion;
  }

  equals(other: LegalBasis): boolean {
    return this.code === other.code && this.policyVersion === other.policyVersion;
  }
}

/** Money in integer minor units. Float arithmetic is prohibited (SPEC-001 §2). */
export class Money {
  readonly minorUnits: number;
  readonly currency: string;

  constructor(minorUnits: number, currency: string) {
    if (!Number.isSafeInteger(minorUnits)) {
      throw new InvalidValueObject(
        'Money',
        `minorUnits must be a safe integer; received ${String(minorUnits)}`,
      );
    }
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidValueObject('Money', 'currency must be an ISO 4217 three-letter code');
    }
    this.minorUnits = minorUnits;
    this.currency = currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  multiply(factor: number): Money {
    if (!Number.isSafeInteger(factor)) {
      throw new InvalidValueObject(
        'Money',
        `factor must be an integer; received ${String(factor)} (no float arithmetic)`,
      );
    }
    return new Money(this.minorUnits * factor, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0;
  }

  equals(other: Money): boolean {
    return this.minorUnits === other.minorUnits && this.currency === other.currency;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new InvalidValueObject(
        'Money',
        `cannot combine ${this.currency} with ${other.currency}`,
      );
    }
  }
}

/**
 * Heuristic PII detector used by the domain to refuse to *record* apparent personal data
 * in audit payloads, event payloads, and repair capsules (VG-SEC-002, VG-EGRESS-002).
 * It guards against accidental capture; it is not a DLP engine. The DLP scrubber belongs
 * to the egress path (SPEC-007).
 */
export function containsApparentPii(value: string): boolean {
  if (typeof value !== 'string') return false;
  const emailLike = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const phoneLike = /(?:\+?\d[\s.-]?){7,}/;
  const ssnLike = /\b\d{3}-\d{2}-\d{4}\b/;
  return emailLike.test(value) || phoneLike.test(value) || ssnLike.test(value);
}
```

Then extend `tests/domain/values.test.ts`: add the new names to the existing import block
from `../../src/domain/values.ts` (`ChannelPriority`, `CHANNEL_NAMES`, `priorityOf`,
`selectChannel`, `rejectedChannels`, `Jurisdiction`, `LegalBasis`, `Money`,
`assertTruthState`, `assertPermissionClass`, `assertEgressClass`, `containsApparentPii`)
and to the `truth-state.ts` import (`ALL_TRUTH_STATES`), then append these blocks at the
end of the file. Exact anchor — the current final lines of the file:

```
  test('opaque ids and nothing-at-all do not require a policy decision', () => {
    assert.equal(requiresExplicitPolicy('OPAQUE_ID' satisfies EgressClass), false);
    assert.equal(requiresExplicitPolicy('NONE' satisfies EgressClass), false);
  });
});
```

FILE: tests/domain/values.test.ts   (MODIFY — append after the anchor above)
```ts
describe('ChannelPriority (VG-CHANNEL-001, SPEC-000 §8)', () => {
  test('priorities are exactly 1..8', () => {
    for (const bad of [0, 9, 1.5, Number.NaN, -1]) {
      assert.throws(() => new ChannelPriority(bad), InvalidValueObject);
    }
    assert.equal(new ChannelPriority(1).value, 1);
    assert.equal(new ChannelPriority(8).value, 8);
  });

  test('priority order matches SPEC-000 §8 exactly', () => {
    assert.equal(CHANNEL_NAMES.length, 8);
    assert.equal(new ChannelPriority(1).channelName(), 'OFFICIAL_SELF_SERVICE');
    assert.equal(new ChannelPriority(5).channelName(), 'SEARCH_ENGINE_REMOVAL');
    assert.equal(new ChannelPriority(8).channelName(), 'NOT_REMOVABLE_OUTCOME');
    assert.equal(priorityOf('CERTIFIED_MAIL').value, 6);
  });

  test('the highest-priority lawful channel is selected', () => {
    const options = [
      { channel: 'CERTIFIED_MAIL' as const, unavailableKind: null, unavailableReason: null },
      { channel: 'OFFICIAL_SELF_SERVICE' as const, unavailableKind: null, unavailableReason: null },
    ];
    const selected = selectChannel(options);
    assert.equal(selected.channel, 'OFFICIAL_SELF_SERVICE');
    assert.deepEqual(rejectedChannels(options, selected), []);
  });

  test('a lower-priority choice requires every higher one recorded with a reason', () => {
    assert.throws(
      () =>
        selectChannel([
          { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: 'GATED', unavailableReason: '   ' },
          { channel: 'CERTIFIED_MAIL', unavailableKind: null, unavailableReason: null },
        ]),
      InvalidValueObject,
    );
    const options = [
      {
        channel: 'OFFICIAL_SELF_SERVICE' as const,
        unavailableKind: 'GATED' as const,
        unavailableReason: 'HumanGate: identity verification required',
      },
      { channel: 'CERTIFIED_MAIL' as const, unavailableKind: null, unavailableReason: null },
    ];
    const selected = selectChannel(options);
    assert.equal(selected.channel, 'CERTIFIED_MAIL');
    assert.equal(rejectedChannels(options, selected).length, 1);
  });

  test('no available channel is a modelling error, not a forced write', () => {
    assert.throws(
      () =>
        selectChannel([
          {
            channel: 'OFFICIAL_SELF_SERVICE',
            unavailableKind: 'UNLAWFUL',
            unavailableReason: 'exempt public record',
          },
        ]),
      InvalidValueObject,
    );
  });
});

describe('Jurisdiction (SPEC-001 §2)', () => {
  test('uppercase ISO 3166-2 codes are accepted', () => {
    assert.equal(new Jurisdiction('US').country(), 'US');
    assert.equal(new Jurisdiction('US-CA').value, 'US-CA');
    assert.equal(new Jurisdiction('DE-BE').value, 'DE-BE');
  });

  test('lowercase, malformed, and empty codes are refused', () => {
    for (const bad of ['us', 'usa', 'U', 'US-', '-CA', '', '12']) {
      assert.throws(() => new Jurisdiction(bad), InvalidValueObject, `should refuse ${bad}`);
    }
  });
});

describe('LegalBasis (VG-POLICY-001)', () => {
  test('a basis always carries its policy version', () => {
    const basis = new LegalBasis('CCPA_DELETE', 7);
    assert.equal(basis.code, 'CCPA_DELETE');
    assert.equal(basis.policyVersion, 7);
  });

  test('free-text and unversioned bases are unrepresentable', () => {
    for (const bad of ['ccpa delete', 'ccpa', 'delete request', '']) {
      assert.throws(() => new LegalBasis(bad, 1), InvalidValueObject, `should refuse ${bad}`);
    }
    for (const badVersion of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => new LegalBasis('CCPA_DELETE', badVersion), InvalidValueObject);
    }
  });
});

describe('Money (SPEC-001 §2 — no float arithmetic)', () => {
  test('integer minor units are accepted and add exactly', () => {
    const a = new Money(1250, 'USD');
    assert.equal(a.add(new Money(750, 'USD')).minorUnits, 2000);
    assert.equal(a.multiply(3).minorUnits, 3750);
    assert.equal(a.isZero(), false);
    assert.equal(new Money(0, 'USD').isZero(), true);
  });

  test('float amounts, bad currencies, and mixed currencies are refused', () => {
    for (const bad of [12.5, Number.NaN, Number.POSITIVE_INFINITY, 0.1 + 0.2]) {
      assert.throws(() => new Money(bad, 'USD'), InvalidValueObject, `should refuse ${bad}`);
    }
    for (const badCurrency of ['usd', 'US', 'USDD', '']) {
      assert.throws(() => new Money(100, badCurrency), InvalidValueObject);
    }
    assert.throws(() => new Money(100, 'USD').add(new Money(100, 'EUR')), InvalidValueObject);
    assert.throws(() => new Money(100, 'USD').multiply(1.5), InvalidValueObject);
  });
});

describe('runtime membership guards (SPEC-001 §8.1)', () => {
  test('assertTruthState accepts exactly the eleven canonical states', () => {
    for (const state of ALL_TRUTH_STATES) {
      assert.equal(assertTruthState(state), state);
    }
  });

  test('assertTruthState refuses ad-hoc status vocabulary', () => {
    for (const bad of ['DONE', 'COMPLETE', 'SUCCESS', 'REMOVED', 'done', '', 42, null]) {
      assert.throws(
        () => assertTruthState(bad),
        InvalidValueObject,
        `should refuse ${String(bad)}`,
      );
    }
  });

  test('assertPermissionClass and assertEgressClass refuse unknown members', () => {
    assert.equal(assertPermissionClass('WRITE_UNCLEAR'), 'WRITE_UNCLEAR');
    assert.equal(assertEgressClass('HIGH_RISK_PII'), 'HIGH_RISK_PII');
    for (const bad of ['write_permitted', 'ALLOWED', '', undefined]) {
      assert.throws(() => assertPermissionClass(bad), InvalidValueObject);
      assert.throws(() => assertEgressClass(bad), InvalidValueObject);
    }
  });
});

describe('containsApparentPii (VG-SEC-002 guard)', () => {
  test('apparent personal data is detected', () => {
    assert.equal(containsApparentPii('jane.doe@example.com'), true);
    assert.equal(containsApparentPii('call +1 415 555 0123'), true);
    assert.equal(containsApparentPii('ssn 123-45-6789'), true);
  });

  test('opaque identifiers and ordinary text are not flagged', () => {
    assert.equal(containsApparentPii('subject-0001'), false);
    assert.equal(containsApparentPii('case-2026-000123'), false);
    assert.equal(containsApparentPii('REQUEST_SUBMITTED'), false);
  });
});
```

FILE: tests/domain/identifiers.test.ts   (CREATE)
```ts
/**
 * Opaque identifier value objects (SPEC-001 §2).
 *
 * The property under test is that an identifier cannot be, or contain, a raw personal
 * value; and that identifiers of different kinds are not interchangeable.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ActionId,
  CaseId,
  EvidenceId,
  ExposureId,
  RecipeId,
  SourceId,
  SubjectId,
  TenantId,
} from '../../src/domain/identifiers.ts';
import { InvalidValueObject } from '../../src/domain/errors.ts';

describe('opaque identifiers (SPEC-001 §2)', () => {
  test('all eight kinds accept a canonical opaque value', () => {
    assert.equal(new SubjectId('subject-0001').value, 'subject-0001');
    assert.equal(new TenantId('tenant_01').value, 'tenant_01');
    assert.equal(new CaseId('case:2026:0001').value, 'case:2026:0001');
    assert.equal(new ExposureId('exposure.7').value, 'exposure.7');
    assert.equal(new SourceId('source0001').value, 'source0001');
    assert.equal(new RecipeId('recipe-0001-v3').value, 'recipe-0001-v3');
    assert.equal(new ActionId('action-0001').value, 'action-0001');
    assert.equal(new EvidenceId('evidence-0001').value, 'evidence-0001');
  });

  test('a raw PII value is unrepresentable as an identifier', () => {
    assert.throws(() => new SubjectId('jane.doe@example.com'), InvalidValueObject);
    assert.throws(() => new SubjectId('+14155550123'), InvalidValueObject);
    assert.throws(() => new SubjectId('4155550123'), InvalidValueObject);
    assert.throws(() => new TenantId('123-45-6789'), InvalidValueObject);
  });

  test('empty, padded, over-long, and malformed values are refused', () => {
    for (const bad of ['', '   ', ' subject-1', 'subject-1 ', 'subject 1', '-leading', 'x'.repeat(129)]) {
      assert.throws(
        () => new SubjectId(bad),
        InvalidValueObject,
        `should refuse ${JSON.stringify(bad)}`,
      );
    }
  });

  test('equality is by kind and value, and cross-kind equality is false', () => {
    assert.ok(new SubjectId('a').equals(new SubjectId('a')));
    assert.equal(new SubjectId('a').equals(new SubjectId('b')), false);
    assert.equal(new SubjectId('a').equals(new SourceId('a')), false);
  });

  test('string form names the kind, so a log line cannot confuse two identifiers', () => {
    assert.equal(String(new CaseId('c1')), 'CaseId:c1');
  });
});
```

FILE: .agent/verification/EXPECTED_TEST_MANIFEST.txt   (MODIFY — append if absent)
```
tests/domain/identifiers.test.ts
```

RUN:

```sh
sh scripts/typecheck.sh
sh scripts/test-unit.sh
sh scripts/test-collection-guard.sh
node --test tests/domain/values.test.ts 2>&1 | tail -n 8
```

EXPECT: `typecheck: ok`; `test-unit: ok` with zero failures and a passing count strictly
greater than the M1 baseline (94 at authoring time); `test collection guard: ok` with its
JSON line showing `filesSeen` increased by one and `manifestChecked` matching the manifest
entries; the direct run of `values.test.ts` shows all pre-existing `Confidence`,
`IdempotencyKey`, `EvidenceDigest`, `ObservationWindow`, `PermissionClass`, and
`EgressClass` tests still present and passing.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-002 MILESTONE_PASS "M2 value objects complete; typecheck: ok; test-unit: ok"`

FALLBACK: if a new value object cannot satisfy an existing `values.ts` consumer without
changing that consumer, keep the consumer's behaviour and add the value object beside it
(a real, narrower implementation) rather than altering published domain semantics; record
the seam in the ledger and in `tests/domain/DOMAIN_TEST_MAP.csv`.

COMMIT: `git add -A && git commit -m "[EP-002][M2] remaining value objects and membership guards"`

### M3: Entities with their spec invariants

GOAL: All 27 SPEC-001 §3 entities exist as immutable types with validating factories, and
the spec's invariant column is enforced by real checks.

READ: `.agent/specs/SPEC-001-core-domain.md` §3 (all five aggregates),
`.agent/specs/SPEC-000-product-scope.md` §4 (vocabulary), `src/domain/identifiers.ts`,
`src/domain/values.ts`, `src/domain/errors.ts`, `src/domain/truth-state.ts`,
`tests/domain/values.test.ts`.

CHANGE: `src/domain/entities.ts` (create); `tests/domain/entities.test.ts` (create);
`.agent/verification/EXPECTED_TEST_MANIFEST.txt` (append the suite);
`tests/domain/DOMAIN_TEST_MAP.csv` (append the entity rows).

CONTENT:

FILE: src/domain/entities.ts   (CREATE)
```ts
/**
 * Domain entities (SPEC-001 §3).
 *
 * Every entity is an immutable value-shaped record created through a validating factory.
 * The factories exist so that the invariant column of SPEC-001 §3 is enforced at the only
 * moment it can be enforced cheaply: construction. A `ProtectedSubject` without a valid
 * `AuthorityGrant` is not a subject with a warning attached — it is unrepresentable.
 *
 * Everything here is pure: no I/O, no clock reads, no randomness, no persistence. Time is
 * always passed in, which is what makes observation windows and reappearance testable
 * without sleeping (SPEC-001 §5).
 *
 * Naming note (see EP-002 §4): SPEC-001 §3.4/§3.5 name a `provider` field, while
 * SPEC-000 §4 lists `provider` as a forbidden synonym for `Source`. The mandated entity
 * name `ProviderTransportRun` is kept; the ambiguous bare field is `transportName` (the
 * postal or transport service, which is not a `Source`).
 */

import {
  AuthorityExpired,
  AuthorityMissing,
  HumanGateRequired,
  InvalidValueObject,
} from './errors.ts';
import {
  ActionId,
  CaseId,
  EvidenceId,
  ExposureId,
  RecipeId,
  SourceId,
  SubjectId,
  TenantId,
} from './identifiers.ts';
import type { TruthState } from './truth-state.ts';
import {
  Confidence,
  EvidenceDigest,
  IdempotencyKey,
  Jurisdiction,
  LegalBasis,
  Money,
  containsApparentPii,
  permitsAutomatedWrite,
  type ChannelName,
  type EgressClass,
  type PermissionClass,
} from './values.ts';

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

function requireText(kind: string, field: string, value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidValueObject(kind, `${field} must be a non-empty string`);
  }
}

function requireExact(kind: string, field: string, value: string): void {
  requireText(kind, field, value);
  if (value !== value.trim()) {
    throw new InvalidValueObject(kind, `${field} must not have surrounding whitespace`);
  }
}

function requireOneOf<T extends string>(
  kind: string,
  field: string,
  value: string,
  allowed: readonly T[],
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InvalidValueObject(
      kind,
      `${field} must be one of ${allowed.join(', ')}; received ${String(value)}`,
    );
  }
  return value as T;
}

function freeze<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

// ---------------------------------------------------------------------------
// Identity aggregate (SPEC-001 §3.1)
// ---------------------------------------------------------------------------

export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export type SubjectStatus = 'ACTIVE' | 'ARCHIVED' | 'ERASED';
export type AuthorityKind = 'SELF' | 'AGENT' | 'PARENT_GUARDIAN' | 'LEGAL_REPRESENTATIVE';

export interface Tenant {
  readonly id: TenantId;
  readonly name: string;
  /** One tenant is one isolation boundary; policy references are versioned data. */
  readonly status: TenantStatus;
  readonly policyRefs: readonly string[];
}

export interface AuthorityGrant {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly subjectId: SubjectId;
  readonly kind: AuthorityKind;
  readonly scope: readonly string[];
  readonly evidenceId: string | null;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly revokedAtMs: number | null;
  readonly signedInstrument: boolean;
}

export interface ProtectedSubject {
  readonly id: SubjectId;
  readonly tenantId: TenantId;
  /** Opaque label only: never a raw name (SPEC-001 §3 closing rule). */
  readonly displayRef: string;
  readonly jurisdiction: Jurisdiction;
  readonly isMinor: boolean;
  readonly status: SubjectStatus;
  readonly authorityGrantIds: readonly string[];
}

export interface Alias {
  readonly id: string;
  readonly tenantId: TenantId;
  /** `null` means quarantined: an ambiguous alias is never auto-attached (VG-IDENT-002). */
  readonly subjectId: string | null;
  readonly valueEncRef: string;
  readonly valueHmac: string;
  readonly provenance: string;
  readonly method: string;
  readonly quarantined: boolean;
  readonly addedAtMs: number;
}

export interface Identifier {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly subjectId: SubjectId;
  readonly kind: string;
  /** A storage reference to ciphertext, never the cleartext value. */
  readonly valueEncRef: string;
  readonly keyVersion: number;
  readonly provenance: string;
}

export interface LocationHistory {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly subjectId: SubjectId;
  readonly jurisdiction: Jurisdiction;
  readonly effectiveFromMs: number;
  readonly effectiveToMs: number | null;
  readonly provenance: string;
}

// ---------------------------------------------------------------------------
// Source aggregate (SPEC-001 §3.2)
// ---------------------------------------------------------------------------

export interface Source {
  readonly id: SourceId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly class: string;
  readonly jurisdiction: Jurisdiction | null;
  readonly permissionClass: PermissionClass;
  readonly permissionCheckedAtMs: number | null;
}

export interface SourceCatalogEntry {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sourceId: SourceId;
  readonly category: string;
  readonly coverageNotes: string;
  readonly provenance: string;
  readonly license: string;
}

export interface RemovalRecipe {
  readonly id: RecipeId;
  readonly tenantId: TenantId;
  readonly sourceId: SourceId;
  readonly version: number;
  readonly signature: string;
  readonly channel: ChannelName;
  readonly verificationMethod: string;
  readonly freshnessAtMs: number;
  readonly enabled: boolean;
}

export interface SourceRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sourceId: SourceId;
  readonly rawRef: string;
  readonly observedAtMs: number;
  readonly contentHash: EvidenceDigest;
  /** Untrusted remote content is tainted by default (VG-SEC-001). */
  readonly tainted: boolean;
}

export interface Exposure {
  readonly id: ExposureId;
  readonly tenantId: TenantId;
  readonly subjectId: SubjectId;
  readonly sourceRecordId: string;
  readonly confidence: Confidence;
  readonly truthState: TruthState;
  readonly caseId: string | null;
}

// ---------------------------------------------------------------------------
// Policy aggregate (SPEC-001 §3.3)
// ---------------------------------------------------------------------------

export type ControllerKind =
  | 'PLATFORM'
  | 'PUBLISHER'
  | 'REGISTRY'
  | 'GOVERNMENT_AGENCY'
  | 'OTHER_CONTROLLER';

/** Who authored a jurisdiction policy. Model output is not on the list (VG-POLICY-001). */
export type PolicyProvenance = 'COUNSEL_REVIEWED' | 'OPERATOR_ENTERED';

export interface JurisdictionPolicy {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly jurisdiction: Jurisdiction;
  readonly version: number;
  readonly effectiveFromMs: number;
  readonly effectiveToMs: number | null;
  readonly rules: readonly string[];
  readonly provenance: PolicyProvenance;
}

export interface PolicyDecision {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: string;
  readonly jurisdiction: Jurisdiction;
  readonly legalBasis: LegalBasis;
  readonly channel: ChannelName;
  readonly policyVersion: number;
  readonly reasons: readonly string[];
  readonly decidedAtMs: number;
}

export interface Controller {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly kind: ControllerKind;
  readonly jurisdiction: Jurisdiction | null;
  readonly contactRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// Action aggregate (SPEC-001 §3.4)
// ---------------------------------------------------------------------------

export type ExternalActionStatus = 'PREPARED' | 'SUBMITTED' | 'AMBIGUOUS' | 'REFUSED';
export type ObservationFinding = 'PRESENT' | 'ABSENT' | 'INCONCLUSIVE';
export type DeliveryStatus = 'NOT_SENT' | 'SENT' | 'DELIVERED' | 'RETURNED' | 'UNKNOWN';

export interface RequestCase {
  readonly id: CaseId;
  readonly tenantId: TenantId;
  readonly subjectId: SubjectId;
  readonly exposureId: ExposureId;
  readonly sourceId: SourceId;
  readonly authorityGrantId: string;
  readonly policyDecisionId: string | null;
  readonly truthState: TruthState;
}

export interface ExternalAction {
  readonly id: ActionId;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly channel: ChannelName;
  readonly idempotencyKey: IdempotencyKey;
  readonly attempt: number;
  readonly status: ExternalActionStatus;
  /** An ambiguous result must be reconciled, never blindly retried (VG-ACTION-002). */
  readonly ambiguous: boolean;
  readonly submittedAtMs: number | null;
}

export interface EmailThread {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly messageIds: readonly string[];
  readonly direction: 'OUTBOUND' | 'INBOUND';
  readonly receivedAtMs: number | null;
}

export interface MailPiece {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly templateVersion: number;
  readonly templateHash: EvidenceDigest;
  /** SPEC-001 §3.4 calls this field `provider`; see the naming note at the top. */
  readonly transportName: string;
  readonly trackingId: string | null;
  readonly deliveryStatus: DeliveryStatus;
}

export interface Deadline {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly kind: string;
  readonly dueAtMs: number;
  /** Derived from a policy version, never hard-coded (SPEC-001 §3.4). */
  readonly derivationRef: string;
  readonly satisfiedAtMs: number | null;
}

export interface ControllerResponse {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly kind: string;
  readonly bodyRef: string;
  readonly receivedAtMs: number;
  /** A claim, not an observation. It can never satisfy a removal (VG-VERIFY-004). */
  readonly claimedOutcome: TruthState | null;
}

export interface VerificationObservation {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly method: string;
  readonly observedAtMs: number;
  readonly actorIdentity: string;
  readonly actingIdentity: string;
  readonly finding: ObservationFinding;
  readonly evidenceId: EvidenceId;
}

export interface AppealEscalation {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly kind: string;
  readonly requiresHumanReview: boolean;
  readonly artifactIds: readonly string[];
}

export interface Reappearance {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly exposureId: ExposureId;
  /** The audit event that recorded the prior VERIFIED_REMOVED transition. */
  readonly priorRemovedEventId: string;
  readonly observedAtMs: number;
  readonly evidenceId: EvidenceId;
}

// ---------------------------------------------------------------------------
// Evidence, audit and operations (SPEC-001 §3.5)
// ---------------------------------------------------------------------------

export type RedactionState = 'NONE' | 'SCRUBBED' | 'DENIED';
export type AuthMode = 'OFFICIAL_API' | 'OFFICIAL_FORM' | 'OFFICIAL_MAIL';

export interface EvidenceArtifact {
  readonly id: EvidenceId;
  readonly tenantId: TenantId;
  readonly caseId: string | null;
  readonly kind: string;
  readonly digest: EvidenceDigest;
  readonly storageRef: string;
  readonly egressClass: EgressClass;
  readonly redactionState: RedactionState;
  readonly capturedAtMs: number;
}

export interface AuditEvent {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly actor: string;
  readonly action: string;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly correlationId: string;
  readonly atMs: number;
  /** Opaque scalars only; apparent PII is refused (VG-SEC-002). */
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ProviderTransportRun {
  readonly id: string;
  readonly tenantId: TenantId;
  /** SPEC-001 §3.5 calls this field `provider`; see the naming note at the top. */
  readonly transportName: string;
  readonly authMode: AuthMode;
  readonly egressClass: EgressClass;
  readonly startedAtMs: number;
  readonly outcome: string;
  readonly costRef: Money | null;
}

export interface RepairCapsule {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly fingerprint: string;
  /** DLP-scrubbed before egress: apparent PII is refused at construction (VG-EGRESS-002). */
  readonly sanitizedEvidence: string;
  readonly expected: string;
  readonly actual: string;
  readonly prRef: string | null;
}

// ---------------------------------------------------------------------------
// Factories: the invariant column of SPEC-001 §3, enforced at construction
// ---------------------------------------------------------------------------

export function createTenant(input: {
  id: TenantId;
  name: string;
  status: TenantStatus;
  policyRefs?: readonly string[];
}): Tenant {
  requireText('Tenant', 'name', input.name);
  return Object.freeze({
    id: input.id,
    name: input.name,
    status: requireOneOf('Tenant', 'status', input.status, ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const),
    policyRefs: freeze(input.policyRefs ?? []),
  });
}

export function createAuthorityGrant(input: {
  id: string;
  tenantId: TenantId;
  subjectId: SubjectId;
  kind: AuthorityKind;
  scope: readonly string[];
  evidenceId: string | null;
  issuedAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
  signedInstrument: boolean;
}): AuthorityGrant {
  requireExact('AuthorityGrant', 'id', input.id);
  const kind = requireOneOf('AuthorityGrant', 'kind', input.kind, [
    'SELF',
    'AGENT',
    'PARENT_GUARDIAN',
    'LEGAL_REPRESENTATIVE',
  ] as const);
  if (input.scope.length === 0) {
    throw new InvalidValueObject('AuthorityGrant', 'scope must contain at least one entry');
  }
  if (!Number.isInteger(input.issuedAtMs) || !Number.isInteger(input.expiresAtMs)) {
    throw new InvalidValueObject('AuthorityGrant', 'issuedAtMs and expiresAtMs must be integers');
  }
  if (input.expiresAtMs <= input.issuedAtMs) {
    throw new InvalidValueObject('AuthorityGrant', 'expiresAtMs must be after issuedAtMs');
  }
  // VG-AUTHZ-002: an authorized-agent action needs a signed instrument plus evidence.
  if (kind === 'AGENT' && (!input.signedInstrument || input.evidenceId === null)) {
    throw new InvalidValueObject(
      'AuthorityGrant',
      'kind AGENT requires a signed instrument and a linked EvidenceArtifact (VG-AUTHZ-002)',
    );
  }
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    kind,
    scope: freeze(input.scope),
    evidenceId: input.evidenceId,
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.expiresAtMs,
    revokedAtMs: input.revokedAtMs,
    signedInstrument: input.signedInstrument,
  });
}

/** VG-AUTHZ-001: an expired or revoked grant is refused at use. */
export function assertAuthorityUsableAt(grant: AuthorityGrant, atMs: number): void {
  if (grant.revokedAtMs !== null && grant.revokedAtMs <= atMs) {
    throw new AuthorityExpired(grant.id, String(atMs));
  }
  if (atMs >= grant.expiresAtMs) {
    throw new AuthorityExpired(grant.id, String(atMs));
  }
}

/** VG-IDENT-001: a subject cannot be created without a valid grant. */
export function createProtectedSubject(input: {
  id: SubjectId;
  tenantId: TenantId;
  displayRef: string;
  jurisdiction: Jurisdiction;
  isMinor: boolean;
  status: SubjectStatus;
  authority: AuthorityGrant;
  atMs: number;
}): ProtectedSubject {
  requireText('ProtectedSubject', 'displayRef', input.displayRef);
  if (containsApparentPii(input.displayRef)) {
    throw new InvalidValueObject(
      'ProtectedSubject',
      'displayRef must be an opaque label, never a raw name or contact value',
    );
  }
  if (input.authority.subjectId.value !== input.id.value) {
    throw new AuthorityMissing(input.id.value);
  }
  assertAuthorityUsableAt(input.authority, input.atMs);
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    displayRef: input.displayRef,
    jurisdiction: input.jurisdiction,
    isMinor: input.isMinor,
    status: requireOneOf('ProtectedSubject', 'status', input.status, [
      'ACTIVE',
      'ARCHIVED',
      'ERASED',
    ] as const),
    authorityGrantIds: freeze([input.authority.id]),
  });
}

/** VG-POLICY-004: a minor subject cannot enter an automated write lane. */
export function assertStrictLaneForMinor(subject: ProtectedSubject): void {
  if (subject.isMinor) {
    throw new HumanGateRequired(
      'minor subject requires review-required handling',
      'MINOR_REVIEW_LANE',
    );
  }
}

/** SPEC-002 §2: encrypted columns hold ciphertext references, never cleartext. */
function requireEncryptedRef(kind: string, value: string): void {
  requireText(kind, 'valueEncRef', value);
  if (!value.startsWith('enc:')) {
    throw new InvalidValueObject(
      kind,
      'valueEncRef must reference ciphertext (prefix "enc:"); raw PII must not enter the domain',
    );
  }
}

export function createAlias(input: {
  id: string;
  tenantId: TenantId;
  subjectId: string | null;
  valueEncRef: string;
  valueHmac: string;
  provenance: string;
  method: string;
  addedAtMs: number;
}): Alias {
  requireExact('Alias', 'id', input.id);
  requireText('Alias', 'valueHmac', input.valueHmac);
  requireText('Alias', 'provenance', input.provenance);
  requireText('Alias', 'method', input.method);
  requireEncryptedRef('Alias', input.valueEncRef);
  // VG-IDENT-002 / VG-DATA-012: quarantine is exactly the absence of a subject link.
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    valueEncRef: input.valueEncRef,
    valueHmac: input.valueHmac,
    provenance: input.provenance,
    method: input.method,
    quarantined: input.subjectId === null,
    addedAtMs: input.addedAtMs,
  });
}

export function createIdentifier(input: {
  id: string;
  tenantId: TenantId;
  subjectId: SubjectId;
  kind: string;
  valueEncRef: string;
  keyVersion: number;
  provenance: string;
}): Identifier {
  requireExact('Identifier', 'id', input.id);
  requireText('Identifier', 'kind', input.kind);
  requireText('Identifier', 'provenance', input.provenance);
  requireEncryptedRef('Identifier', input.valueEncRef);
  if (!Number.isInteger(input.keyVersion) || input.keyVersion < 1) {
    throw new InvalidValueObject(
      'Identifier',
      'keyVersion must be a positive integer so rotation does not rewrite history',
    );
  }
  return Object.freeze({ ...input });
}

export function createLocationHistory(input: {
  id: string;
  tenantId: TenantId;
  subjectId: SubjectId;
  jurisdiction: Jurisdiction;
  effectiveFromMs: number;
  effectiveToMs: number | null;
  provenance: string;
}): LocationHistory {
  requireExact('LocationHistory', 'id', input.id);
  requireText('LocationHistory', 'provenance', input.provenance);
  if (input.effectiveToMs !== null && input.effectiveToMs <= input.effectiveFromMs) {
    throw new InvalidValueObject(
      'LocationHistory',
      'effectiveToMs must be after effectiveFromMs when present',
    );
  }
  return Object.freeze({ ...input });
}

export function createSource(input: {
  id: SourceId;
  tenantId: TenantId;
  name: string;
  class: string;
  jurisdiction: Jurisdiction | null;
  permissionClass: PermissionClass;
  permissionCheckedAtMs: number | null;
}): Source {
  requireText('Source', 'name', input.name);
  requireText('Source', 'class', input.class);
  return Object.freeze({ ...input });
}

export function createSourceCatalogEntry(input: {
  id: string;
  tenantId: TenantId;
  sourceId: SourceId;
  category: string;
  coverageNotes: string;
  provenance: string;
  license: string;
}): SourceCatalogEntry {
  requireExact('SourceCatalogEntry', 'id', input.id);
  requireText('SourceCatalogEntry', 'category', input.category);
  requireText('SourceCatalogEntry', 'coverageNotes', input.coverageNotes);
  requireText('SourceCatalogEntry', 'provenance', input.provenance);
  // LICENSE_POLICY: a catalogue entry without a recorded licence is incomplete.
  requireText('SourceCatalogEntry', 'license', input.license);
  return Object.freeze({ ...input });
}

export function createRemovalRecipe(input: {
  id: RecipeId;
  tenantId: TenantId;
  sourceId: SourceId;
  version: number;
  signature: string;
  channel: ChannelName;
  verificationMethod: string;
  freshnessAtMs: number;
  enabled: boolean;
}): RemovalRecipe {
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new InvalidValueObject('RemovalRecipe', 'version must be a positive integer');
  }
  requireText('RemovalRecipe', 'signature', input.signature);
  requireText('RemovalRecipe', 'verificationMethod', input.verificationMethod);
  return Object.freeze({ ...input });
}

/** VG-CHANNEL-003: a recipe must be enabled, signed, and fresh in order to write. */
export function assertRecipeUsableAt(recipe: RemovalRecipe, atMs: number): void {
  if (!recipe.enabled) {
    throw new InvalidValueObject('RemovalRecipe', `recipe ${recipe.id.value} is disabled`);
  }
  if (typeof recipe.signature !== 'string' || recipe.signature.trim().length === 0) {
    throw new InvalidValueObject('RemovalRecipe', `recipe ${recipe.id.value} is unsigned`);
  }
  if (atMs > recipe.freshnessAtMs) {
    throw new InvalidValueObject(
      'RemovalRecipe',
      `recipe ${recipe.id.value} is stale (fresh as of ${recipe.freshnessAtMs}, now ${atMs})`,
    );
  }
}

export function createSourceRecord(input: {
  id: string;
  tenantId: TenantId;
  sourceId: SourceId;
  rawRef: string;
  observedAtMs: number;
  contentHash: EvidenceDigest;
  tainted: boolean;
}): SourceRecord {
  requireExact('SourceRecord', 'id', input.id);
  requireText('SourceRecord', 'rawRef', input.rawRef);
  if (!Number.isInteger(input.observedAtMs)) {
    throw new InvalidValueObject('SourceRecord', 'observedAtMs must be an integer');
  }
  return Object.freeze({ ...input });
}

/** VG-SEC-001: tainted remote content can never direct an action. */
export function assertUntainted(record: SourceRecord, action: string): void {
  if (record.tainted) {
    throw new InvalidValueObject(
      'SourceRecord',
      `tainted content cannot direct ${action} (VG-SEC-001)`,
    );
  }
}

export function createExposure(input: {
  id: ExposureId;
  tenantId: TenantId;
  subjectId: SubjectId;
  sourceRecordId: string;
  confidence: Confidence;
  truthState: TruthState;
  caseId: string | null;
}): Exposure {
  requireExact('Exposure', 'sourceRecordId', input.sourceRecordId);
  return Object.freeze({ ...input });
}

export function createJurisdictionPolicy(input: {
  id: string;
  tenantId: TenantId;
  jurisdiction: Jurisdiction;
  version: number;
  effectiveFromMs: number;
  effectiveToMs: number | null;
  rules: readonly string[];
  provenance: PolicyProvenance;
}): JurisdictionPolicy {
  requireExact('JurisdictionPolicy', 'id', input.id);
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new InvalidValueObject('JurisdictionPolicy', 'version must be a positive integer');
  }
  if (input.rules.length === 0) {
    throw new InvalidValueObject('JurisdictionPolicy', 'rules must not be empty');
  }
  // VG-POLICY-001: a model cannot author a legal basis, so it cannot author a policy.
  const provenance = requireOneOf('JurisdictionPolicy', 'provenance', input.provenance, [
    'COUNSEL_REVIEWED',
    'OPERATOR_ENTERED',
  ] as const);
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    jurisdiction: input.jurisdiction,
    version: input.version,
    effectiveFromMs: input.effectiveFromMs,
    effectiveToMs: input.effectiveToMs,
    rules: freeze(input.rules),
    provenance,
  });
}

/** VG-POLICY-002: all four fields are required before a case may progress. */
export function createPolicyDecision(input: {
  id: string;
  tenantId: TenantId;
  caseId: string;
  jurisdiction: Jurisdiction;
  legalBasis: LegalBasis;
  channel: ChannelName;
  policyVersion: number;
  reasons: readonly string[];
  decidedAtMs: number;
}): PolicyDecision {
  requireExact('PolicyDecision', 'id', input.id);
  requireExact('PolicyDecision', 'caseId', input.caseId);
  if (!Number.isInteger(input.policyVersion) || input.policyVersion < 1) {
    throw new InvalidValueObject('PolicyDecision', 'policyVersion must be a positive integer');
  }
  if (input.legalBasis.policyVersion !== input.policyVersion) {
    throw new InvalidValueObject(
      'PolicyDecision',
      'legalBasis.policyVersion must equal the decision policyVersion',
    );
  }
  return Object.freeze({ ...input, reasons: freeze(input.reasons) });
}

export function createController(input: {
  id: string;
  tenantId: TenantId;
  name: string;
  kind: ControllerKind;
  jurisdiction: Jurisdiction | null;
  contactRefs: readonly string[];
}): Controller {
  requireExact('Controller', 'id', input.id);
  requireText('Controller', 'name', input.name);
  return Object.freeze({ ...input, contactRefs: freeze(input.contactRefs) });
}

export function createRequestCase(input: {
  id: CaseId;
  tenantId: TenantId;
  subjectId: SubjectId;
  exposureId: ExposureId;
  sourceId: SourceId;
  authorityGrantId: string;
  policyDecisionId: string | null;
  truthState: TruthState;
}): RequestCase {
  requireExact('RequestCase', 'authorityGrantId', input.authorityGrantId);
  return Object.freeze({ ...input });
}

export function createExternalAction(input: {
  id: ActionId;
  tenantId: TenantId;
  caseId: CaseId;
  channel: ChannelName;
  idempotencyKey: IdempotencyKey;
  attempt: number;
  status: ExternalActionStatus;
  ambiguous: boolean;
  submittedAtMs: number | null;
}): ExternalAction {
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new InvalidValueObject('ExternalAction', 'attempt must be a positive integer');
  }
  const status = requireOneOf('ExternalAction', 'status', input.status, [
    'PREPARED',
    'SUBMITTED',
    'AMBIGUOUS',
    'REFUSED',
  ] as const);
  if (status === 'AMBIGUOUS' && !input.ambiguous) {
    throw new InvalidValueObject(
      'ExternalAction',
      'status AMBIGUOUS requires ambiguous = true so reconciliation is mandatory (VG-ACTION-002)',
    );
  }
  return Object.freeze({ ...input, status });
}

export function createEmailThread(input: {
  id: string;
  tenantId: TenantId;
  caseId: CaseId;
  messageIds: readonly string[];
  direction: 'OUTBOUND' | 'INBOUND';
  receivedAtMs: number | null;
}): EmailThread {
  requireExact('EmailThread', 'id', input.id);
  if (input.messageIds.length === 0) {
    throw new InvalidValueObject(
      'EmailThread',
      'messageIds must not be empty; threading is needed for deadline logic',
    );
  }
  return Object.freeze({ ...input, messageIds: freeze(input.messageIds) });
}

export function createMailPiece(input: {
  id: string;
  tenantId: TenantId;
  caseId: CaseId;
  templateVersion: number;
  templateHash: EvidenceDigest;
  transportName: string;
  trackingId: string | null;
  deliveryStatus: DeliveryStatus;
}): MailPiece {
  requireExact('MailPiece', 'id', input.id);
  if (!Number.isInteger(input.templateVersion) || input.templateVersion < 1) {
    throw new InvalidValueObject('MailPiece', 'templateVersion must be a positive integer');
  }
  requireText('MailPiece', 'transportName', input.transportName);
  return Object.freeze({ ...input });
}

/** VG-ACTION-004: without transport tracking, mail cannot reach ACKNOWLEDGED. */
export function mailCanReachAcknowledged(piece: MailPiece): boolean {
  return piece.trackingId !== null && piece.deliveryStatus !== 'NOT_SENT';
}

export function createDeadline(input: {
  id: string;
  tenantId: TenantId;
  caseId: CaseId;
  kind: string;
  dueAtMs: number;
  derivationRef: string;
  satisfiedAtMs: number | null;
}): Deadline {
  requireExact('Deadline', 'id', input.id);
  requireText('Deadline', 'kind', input.kind);
  if (!input.derivationRef.startsWith('policy:')) {
    throw new InvalidValueObject(
      'Deadline',
      'derivationRef must name the policy version the deadline derives from (for example policy:7); hard-coded deadlines are refused',
    );
  }
  return Object.freeze({ ...input });
}

export function createControllerResponse(input: {
  id: string;
  tenantId: TenantId;
  caseId: CaseId;
  kind: string;
  bodyRef: string;
  receivedAtMs: number;
  claimedOutcome: TruthState | null;
}): ControllerResponse {
  requireExact('ControllerResponse', 'id', input.id);
  requireText('ControllerResponse', 'kind', input.kind);
  requireExact('ControllerResponse', 'bodyRef', input.bodyRef);
  return Object.freeze({ ...input });
}

/**
 * VG-VERIFY-001 / VG-VERIFY-003 / VG-DATA-008: an observation is only valid when it
 * comes from a path distinct from the acting path and uses the recipe's method.
 */
export function createVerificationObservation(input: {
  id: string;
  tenantId: TenantId;
  caseId: CaseId;
  method: string;
  observedAtMs: number;
  actorIdentity: string;
  actingIdentity: string;
  finding: ObservationFinding;
  evidenceId: EvidenceId;
}): VerificationObservation {
  requireExact('VerificationObservation', 'id', input.id);
  requireText('VerificationObservation', 'method', input.method);
  requireExact('VerificationObservation', 'actorIdentity', input.actorIdentity);
  requireExact('VerificationObservation', 'actingIdentity', input.actingIdentity);
  if (input.actorIdentity === input.actingIdentity) {
    throw new InvalidValueObject(
      'VerificationObservation',
      'the acting path cannot verify itself; actorIdentity must differ from actingIdentity (VG-VERIFY-001)',
    );
  }
  const finding = requireOneOf('VerificationObservation', 'finding', input.finding, [
    'PRESENT',
    'ABSENT',
    'INCONCLUSIVE',
  ] as const);
  return Object.freeze({ ...input, finding });
}

export function createAppealEscalation(input: {
  id: string;
  tenantId: TenantId;
  caseId: CaseId;
  kind: string;
  requiresHumanReview: boolean;
  artifactIds: readonly string[];
}): AppealEscalation {
  requireExact('AppealEscalation', 'id', input.id);
  requireText('AppealEscalation', 'kind', input.kind);
  if (!input.requiresHumanReview) {
    throw new InvalidValueObject(
      'AppealEscalation',
      'an appeal or regulator packet always requires human or counsel review (SPEC-000 §8.7)',
    );
  }
  return Object.freeze({ ...input, artifactIds: freeze(input.artifactIds) });
}

/** VG-REAPPEAR-001: a first-ever discovery is never labelled Reappearance. */
export function createReappearance(input: {
  id: string;
  tenantId: TenantId;
  exposureId: ExposureId;
  priorRemovedEventId: string;
  priorState: TruthState;
  observedAtMs: number;
  evidenceId: EvidenceId;
}): Reappearance {
  requireExact('Reappearance', 'id', input.id);
  requireExact('Reappearance', 'priorRemovedEventId', input.priorRemovedEventId);
  if (input.priorState !== 'VERIFIED_REMOVED') {
    throw new InvalidValueObject(
      'Reappearance',
      `Reappearance requires a prior VERIFIED_REMOVED event; received ${input.priorState} (VG-REAPPEAR-001)`,
    );
  }
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    exposureId: input.exposureId,
    priorRemovedEventId: input.priorRemovedEventId,
    observedAtMs: input.observedAtMs,
    evidenceId: input.evidenceId,
  });
}

export function createEvidenceArtifact(input: {
  id: EvidenceId;
  tenantId: TenantId;
  caseId: string | null;
  kind: string;
  digest: EvidenceDigest;
  storageRef: string;
  egressClass: EgressClass;
  redactionState: RedactionState;
  capturedAtMs: number;
}): EvidenceArtifact {
  requireText('EvidenceArtifact', 'kind', input.kind);
  requireExact('EvidenceArtifact', 'storageRef', input.storageRef);
  return Object.freeze({ ...input });
}

/** VG-EVIDENCE-003 / VG-SEC-002: append-only events that carry no apparent PII. */
export function createAuditEvent(input: {
  id: string;
  tenantId: TenantId;
  actor: string;
  action: string;
  targetKind: string;
  targetId: string | null;
  correlationId: string;
  atMs: number;
  payload: Readonly<Record<string, string | number | boolean | null>>;
}): AuditEvent {
  requireExact('AuditEvent', 'id', input.id);
  requireExact('AuditEvent', 'actor', input.actor);
  requireExact('AuditEvent', 'action', input.action);
  requireExact('AuditEvent', 'targetKind', input.targetKind);
  requireExact('AuditEvent', 'correlationId', input.correlationId);
  for (const [key, value] of Object.entries(input.payload)) {
    if (typeof value === 'string' && containsApparentPii(value)) {
      throw new InvalidValueObject(
        'AuditEvent',
        `payload.${key} appears to contain personal data; audit payloads carry opaque identifiers only (VG-SEC-002)`,
      );
    }
  }
  return Object.freeze({ ...input, payload: Object.freeze({ ...input.payload }) });
}

/** ADR-004: official transports only. No scraping, cookie, or session-reuse modes. */
export function createProviderTransportRun(input: {
  id: string;
  tenantId: TenantId;
  transportName: string;
  authMode: AuthMode;
  egressClass: EgressClass;
  startedAtMs: number;
  outcome: string;
  costRef: Money | null;
}): ProviderTransportRun {
  requireExact('ProviderTransportRun', 'id', input.id);
  requireText('ProviderTransportRun', 'transportName', input.transportName);
  requireText('ProviderTransportRun', 'outcome', input.outcome);
  const authMode = requireOneOf('ProviderTransportRun', 'authMode', input.authMode, [
    'OFFICIAL_API',
    'OFFICIAL_FORM',
    'OFFICIAL_MAIL',
  ] as const);
  return Object.freeze({ ...input, authMode });
}

/** VG-EGRESS-002: a repair capsule is DLP-scrubbed before it can leave the boundary. */
export function createRepairCapsule(input: {
  id: string;
  tenantId: TenantId;
  fingerprint: string;
  sanitizedEvidence: string;
  expected: string;
  actual: string;
  prRef: string | null;
}): RepairCapsule {
  requireExact('RepairCapsule', 'id', input.id);
  requireExact('RepairCapsule', 'fingerprint', input.fingerprint);
  for (const field of ['sanitizedEvidence', 'expected', 'actual'] as const) {
    if (containsApparentPii(input[field])) {
      throw new InvalidValueObject(
        'RepairCapsule',
        `${field} still contains apparent personal data; scrub it before egress (VG-EGRESS-002)`,
      );
    }
  }
  return Object.freeze({ ...input });
}

/** VG-CHANNEL-002 helper kept next to the entity it constrains. */
export function sourceMayBeWritten(source: Source): boolean {
  return permitsAutomatedWrite(source.permissionClass);
}
```

FILE: tests/domain/entities.test.ts   (CREATE)
```ts
/**
 * Entity invariant tests (SPEC-001 §3).
 *
 * Each test asserts an invariant from the spec's own invariant column, using the real
 * factory: the point is that an invalid entity cannot be constructed at all.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAuthorityUsableAt,
  assertRecipeUsableAt,
  assertStrictLaneForMinor,
  assertUntainted,
  createAlias,
  createAppealEscalation,
  createAuditEvent,
  createAuthorityGrant,
  createControllerResponse,
  createDeadline,
  createEvidenceArtifact,
  createExposure,
  createExternalAction,
  createIdentifier,
  createJurisdictionPolicy,
  createMailPiece,
  createPolicyDecision,
  createProtectedSubject,
  createProviderTransportRun,
  createReappearance,
  createRemovalRecipe,
  createRepairCapsule,
  createSource,
  createSourceRecord,
  createVerificationObservation,
  mailCanReachAcknowledged,
  sourceMayBeWritten,
} from '../../src/domain/entities.ts';import {
  ActionId,
  CaseId,
  EvidenceId,
  ExposureId,
  RecipeId,
  SourceId,
  SubjectId,
  TenantId,
} from '../../src/domain/identifiers.ts';
import {
  Confidence,
  EvidenceDigest,
  IdempotencyKey,
  Jurisdiction,
  LegalBasis,
} from '../../src/domain/values.ts';
import {
  AuthorityExpired,
  HumanGateRequired,
  InvalidValueObject,
} from '../../src/domain/errors.ts';

const tenantId = new TenantId('tenant-0001');
const subjectId = new SubjectId('subject-0001');
const caseId = new CaseId('case-0001');
const sourceId = new SourceId('source-0001');
const digest = new EvidenceDigest('a'.repeat(64));
const jurisdiction = new Jurisdiction('US-CA');
const DAY = 86_400_000;

function selfGrant(
  overrides: Partial<Parameters<typeof createAuthorityGrant>[0]> = {},
): ReturnType<typeof createAuthorityGrant> {
  return createAuthorityGrant({
    id: 'grant-0001',
    tenantId,
    subjectId,
    kind: 'SELF',
    scope: ['discovery', 'self_service_write'],
    evidenceId: null,
    issuedAtMs: 0,
    expiresAtMs: 10 * DAY,
    revokedAtMs: null,
    signedInstrument: false,
    ...overrides,
  });
}

describe('Tenant and ProtectedSubject (VG-IDENT-001, VG-POLICY-004)', () => {
  test('a subject requires a matching, valid AuthorityGrant', () => {
    const subject = createProtectedSubject({
      id: subjectId,
      tenantId,
      displayRef: 'subject-ref-0001',
      jurisdiction,
      isMinor: false,
      status: 'ACTIVE',
      authority: selfGrant(),
      atMs: DAY,
    });
    assert.deepEqual([...subject.authorityGrantIds], ['grant-0001']);
  });

  test('a grant for another subject does not authorise this subject', () => {
    assert.throws(
      () =>
        createProtectedSubject({
          id: new SubjectId('subject-0002'),
          tenantId,
          displayRef: 'subject-ref-0002',
          jurisdiction,
          isMinor: false,
          status: 'ACTIVE',
          authority: selfGrant(),
          atMs: DAY,
        }),
      Error,
    );
  });

  test('an expired grant refuses subject creation (VG-AUTHZ-001)', () => {
    assert.throws(
      () =>
        createProtectedSubject({
          id: subjectId,
          tenantId,
          displayRef: 'subject-ref-0001',
          jurisdiction,
          isMinor: false,
          status: 'ACTIVE',
          authority: selfGrant({ expiresAtMs: DAY }),
          atMs: 2 * DAY,
        }),
      AuthorityExpired,
    );
  });

  test('a raw name is not an acceptable displayRef', () => {
    assert.throws(
      () =>
        createProtectedSubject({
          id: subjectId,
          tenantId,
          displayRef: 'jane.doe@example.com',
          jurisdiction,
          isMinor: false,
          status: 'ACTIVE',
          authority: selfGrant(),
          atMs: DAY,
        }),
      InvalidValueObject,
    );
  });

  test('a minor subject cannot enter an automated write lane (VG-POLICY-004)', () => {
    const minor = createProtectedSubject({
      id: subjectId,
      tenantId,
      displayRef: 'subject-ref-0003',
      jurisdiction,
      isMinor: true,
      status: 'ACTIVE',
      authority: selfGrant(),
      atMs: DAY,
    });
    assert.throws(() => assertStrictLaneForMinor(minor), HumanGateRequired);
  });
});

describe('AuthorityGrant (VG-AUTHZ-002)', () => {
  test('an AGENT grant requires a signed instrument and evidence', () => {
    assert.throws(
      () => selfGrant({ kind: 'AGENT', signedInstrument: false, evidenceId: null }),
      InvalidValueObject,
    );
    const signed = selfGrant({ kind: 'AGENT', signedInstrument: true, evidenceId: 'evidence-1' });
    assert.equal(signed.signedInstrument, true);
  });

  test('expiry must follow issuance and scope must be non-empty', () => {
    assert.throws(() => selfGrant({ issuedAtMs: 10, expiresAtMs: 10 }), InvalidValueObject);
    assert.throws(() => selfGrant({ scope: [] }), InvalidValueObject);
  });

  test('a revoked grant is refused even before it expires', () => {
    const revoked = selfGrant({ revokedAtMs: DAY });
    assert.throws(() => assertAuthorityUsableAt(revoked, 2 * DAY), AuthorityExpired);
    assert.equal(assertAuthorityUsableAt(revoked, DAY - 1), undefined);
  });
});

describe('Alias and Identifier (VG-IDENT-002, VG-SEC-002)', () => {
  test('quarantine is exactly the absence of a subject link', () => {
    const quarantined = createAlias({
      id: 'alias-1',
      tenantId,
      subjectId: null,
      valueEncRef: 'enc:alias/1',
      valueHmac: 'hmac-1',
      provenance: 'discovery:source-0001',
      method: 'exact-name',
      addedAtMs: DAY,
    });
    assert.equal(quarantined.quarantined, true);
    const attached = createAlias({
      id: 'alias-2',
      tenantId,
      subjectId: subjectId.value,
      valueEncRef: 'enc:alias/2',
      valueHmac: 'hmac-2',
      provenance: 'subject:self-declared',
      method: 'exact-name',
      addedAtMs: DAY,
    });
    assert.equal(attached.quarantined, false);
  });

  test('cleartext values cannot enter through the encrypted reference', () => {
    assert.throws(
      () =>
        createIdentifier({
          id: 'identifier-1',
          tenantId,
          subjectId,
          kind: 'EMAIL',
          valueEncRef: 'jane.doe@example.com',
          keyVersion: 1,
          provenance: 'subject:self-declared',
        }),
      InvalidValueObject,
    );
    const identifier = createIdentifier({
      id: 'identifier-2',
      tenantId,
      subjectId,
      kind: 'EMAIL',
      valueEncRef: 'enc:tenant-0001/identifier-2',
      keyVersion: 3,
      provenance: 'subject:self-declared',
    });
    assert.equal(identifier.keyVersion, 3);
  });
});

describe('Source, RemovalRecipe, SourceRecord (VG-CHANNEL-002/003, VG-SEC-001)', () => {
  test('WRITE_UNCLEAR and PROHIBITED both forbid writes', () => {
    const unclear = createSource({
      id: sourceId,
      tenantId,
      name: 'example-registry',
      class: 'REGISTRY',
      jurisdiction,
      permissionClass: 'WRITE_UNCLEAR',
      permissionCheckedAtMs: DAY,
    });
    assert.equal(sourceMayBeWritten(unclear), false);
    const permitted = createSource({
      id: sourceId,
      tenantId,
      name: 'example-registry',
      class: 'REGISTRY',
      jurisdiction,
      permissionClass: 'WRITE_PERMITTED',
      permissionCheckedAtMs: DAY,
    });
    assert.equal(sourceMayBeWritten(permitted), true);
  });

  test('a stale or disabled recipe cannot write (VG-CHANNEL-003)', () => {
    const recipe = createRemovalRecipe({
      id: new RecipeId('recipe-0001'),
      tenantId,
      sourceId,
      version: 3,
      signature: 'sig:abc',
      channel: 'OFFICIAL_SELF_SERVICE',
      verificationMethod: 'independent-fetch',
      freshnessAtMs: 10 * DAY,
      enabled: true,
    });
    assert.equal(assertRecipeUsableAt(recipe, DAY), undefined);
    assert.throws(() => assertRecipeUsableAt(recipe, 11 * DAY), InvalidValueObject);
    assert.throws(
      () => assertRecipeUsableAt({ ...recipe, enabled: false }, DAY),
      InvalidValueObject,
    );
  });

  test('tainted remote content cannot direct an action (VG-SEC-001)', () => {
    const record = createSourceRecord({
      id: 'record-1',
      tenantId,
      sourceId,
      rawRef: 'https://example.invalid/profile/1',
      observedAtMs: DAY,
      contentHash: digest,
      tainted: true,
    });
    assert.throws(() => assertUntainted(record, 'an external write'), InvalidValueObject);
    assert.equal(assertUntainted({ ...record, tainted: false }, 'a read'), undefined);
  });
});

describe('Exposure, policy and evidence (VG-IDENT-003, VG-POLICY-001/002, VG-EVIDENCE-001)', () => {
  test('an exposure always carries a confidence with a basis', () => {
    const exposure = createExposure({
      id: new ExposureId('exposure-1'),
      tenantId,
      subjectId,
      sourceRecordId: 'record-1',
      confidence: new Confidence(0.91, ['exact-name-match', 'state-match']),
      truthState: 'MATCH_CONFIRMED',
      caseId: null,
    });
    assert.equal(exposure.confidence.basis.length, 2);
  });

  test('a jurisdiction policy cannot be authored by model output (VG-POLICY-001)', () => {
    assert.throws(
      () =>
        createJurisdictionPolicy({
          id: 'policy-1',
          tenantId,
          jurisdiction,
          version: 1,
          effectiveFromMs: 0,
          effectiveToMs: null,
          rules: ['statutory-window:45d'],
          provenance: 'MODEL_OUTPUT' as never,
        }),
      InvalidValueObject,
    );
  });

  test('a PolicyDecision requires all four fields and a matching policy version', () => {
    const basis = new LegalBasis('CCPA_DELETE', 7);
    const decision = createPolicyDecision({
      id: 'decision-1',
      tenantId,
      caseId: caseId.value,
      jurisdiction,
      legalBasis: basis,
      channel: 'OFFICIAL_SELF_SERVICE',
      policyVersion: 7,
      reasons: ['consumer-request-right'],
      decidedAtMs: DAY,
    });
    assert.equal(decision.legalBasis.code, 'CCPA_DELETE');
    assert.throws(
      () =>
        createPolicyDecision({
          id: 'decision-2',
          tenantId,
          caseId: caseId.value,
          jurisdiction,
          legalBasis: basis,
          channel: 'OFFICIAL_SELF_SERVICE',
          policyVersion: 8,
          reasons: [],
          decidedAtMs: DAY,
        }),
      InvalidValueObject,
    );
  });

  test('an audit payload carrying apparent PII is refused (VG-SEC-002)', () => {
    assert.throws(
      () =>
        createAuditEvent({
          id: 'audit-1',
          tenantId,
          actor: 'domain-command',
          action: 'SubjectRegistered',
          targetKind: 'ProtectedSubject',
          targetId: subjectId.value,
          correlationId: 'corr-1',
          atMs: DAY,
          payload: { note: 'jane.doe@example.com' },
        }),
      InvalidValueObject,
    );
    const event = createAuditEvent({
      id: 'audit-2',
      tenantId,
      actor: 'domain-command',
      action: 'SubjectRegistered',
      targetKind: 'ProtectedSubject',
      targetId: subjectId.value,
      correlationId: 'corr-1',
      atMs: DAY,
      payload: { displayRef: 'subject-ref-0001' },
    });
    assert.equal(event.action, 'SubjectRegistered');
  });
});

describe('Action aggregate (VG-ACTION-001/002/004, VG-VERIFY-001/004, VG-REAPPEAR-001)', () => {
  test('an ExternalAction always names exactly one idempotency key', () => {
    const action = createExternalAction({
      id: new ActionId('action-1'),
      tenantId,
      caseId,
      channel: 'CERTIFIED_MAIL',
      idempotencyKey: new IdempotencyKey('case-0001:certified_mail:v1'),
      attempt: 1,
      status: 'SUBMITTED',
      ambiguous: false,
      submittedAtMs: DAY,
    });
    assert.equal(action.idempotencyKey.value, 'case-0001:certified_mail:v1');
  });

  test('an ambiguous status forces reconciliation', () => {
    assert.throws(
      () =>
        createExternalAction({
          id: new ActionId('action-2'),
          tenantId,
          caseId,
          channel: 'CERTIFIED_MAIL',
          idempotencyKey: new IdempotencyKey('k2'),
          attempt: 1,
          status: 'AMBIGUOUS',
          ambiguous: false,
          submittedAtMs: null,
        }),
      InvalidValueObject,
    );
  });

  test('mail without tracking cannot reach ACKNOWLEDGED (VG-ACTION-004)', () => {
    const piece = createMailPiece({
      id: 'mail-1',
      tenantId,
      caseId,
      templateVersion: 4,
      templateHash: digest,
      transportName: 'certified-mail-transport',
      trackingId: null,
      deliveryStatus: 'SENT',
    });
    assert.equal(mailCanReachAcknowledged(piece), false);
    assert.equal(mailCanReachAcknowledged({ ...piece, trackingId: 'track-1' }), true);
  });

  test('a deadline must derive from a policy version', () => {
    assert.throws(
      () =>
        createDeadline({
          id: 'deadline-1',
          tenantId,
          caseId,
          kind: 'STATUTORY_RESPONSE',
          dueAtMs: 45 * DAY,
          derivationRef: '45',
          satisfiedAtMs: null,
        }),
      InvalidValueObject,
    );
  });

  test('an appeal always requires human review', () => {
    assert.throws(
      () =>
        createAppealEscalation({
          id: 'appeal-1',
          tenantId,
          caseId,
          kind: 'REGULATOR_COMPLAINT',
          requiresHumanReview: false,
          artifactIds: [],
        }),
      InvalidValueObject,
    );
  });

  test('a controller response is a claim and carries no observation', () => {
    const response = createControllerResponse({
      id: 'response-1',
      tenantId,
      caseId,
      kind: 'EMAIL',
      bodyRef: 'enc:body/1',
      receivedAtMs: DAY,
      claimedOutcome: 'VERIFIED_REMOVED',
    });
    assert.equal(response.claimedOutcome, 'VERIFIED_REMOVED');
  });

  test('the acting path cannot verify itself (VG-VERIFY-001)', () => {
    assert.throws(
      () =>
        createVerificationObservation({
          id: 'observation-1',
          tenantId,
          caseId,
          method: 'independent-fetch',
          observedAtMs: 2 * DAY,
          actorIdentity: 'actor-a',
          actingIdentity: 'actor-a',
          finding: 'ABSENT',
          evidenceId: new EvidenceId('evidence-2'),
        }),
      InvalidValueObject,
    );
  });

  test('Reappearance requires a prior VERIFIED_REMOVED (VG-REAPPEAR-001)', () => {
    assert.throws(
      () =>
        createReappearance({
          id: 'reappearance-1',
          tenantId,
          exposureId: new ExposureId('exposure-1'),
          priorRemovedEventId: 'audit-9',
          priorState: 'ACKNOWLEDGED',
          observedAtMs: 3 * DAY,
          evidenceId: new EvidenceId('evidence-3'),
        }),
      InvalidValueObject,
    );
  });
});

describe('Operations entities (ADR-004, VG-EGRESS-002)', () => {
  test('only official transports are representable', () => {
    assert.throws(
      () =>
        createProviderTransportRun({
          id: 'run-1',
          tenantId,
          transportName: 'unofficial-transport',
          authMode: 'COOKIE_REUSE' as never,
          egressClass: 'NONE',
          startedAtMs: DAY,
          outcome: 'SUBMITTED',
          costRef: null,
        }),
      InvalidValueObject,
    );
  });

  test('a repair capsule refuses apparent PII before egress (VG-EGRESS-002)', () => {
    assert.throws(
      () =>
        createRepairCapsule({
          id: 'capsule-1',
          tenantId,
          fingerprint: 'fp-1',
          sanitizedEvidence: 'contact jane.doe@example.com failed',
          expected: 'submission accepted',
          actual: 'timeout',
          prRef: null,
        }),
      InvalidValueObject,
    );
  });

  test('an evidence artifact is content-addressed', () => {
    const artifact = createEvidenceArtifact({
      id: new EvidenceId('evidence-4'),
      tenantId,
      caseId: caseId.value,
      kind: 'SUBMISSION_RECEIPT',
      digest,
      storageRef: 's3://evidence/tenant-0001/evidence-4',
      egressClass: 'OPAQUE_ID',
      redactionState: 'SCRUBBED',
      capturedAtMs: DAY,
    });
    assert.equal(artifact.digest.value, digest.value);
  });
});
```

FILE: .agent/verification/EXPECTED_TEST_MANIFEST.txt   (MODIFY — append if absent)
```
tests/domain/entities.test.ts
```

FILE: tests/domain/DOMAIN_TEST_MAP.csv   (MODIFY — append the entity rows; set each status by measurement)
```csv
VG-IDENT-001,SPEC-001 3.1,T-VG-IDENT-001-01,tests/domain/entities.test.ts,a subject requires a matching valid AuthorityGrant,node --test "tests/**/*.test.ts",PASS
VG-IDENT-002,SPEC-001 3.1,T-VG-IDENT-002-01,tests/domain/entities.test.ts,quarantine is exactly the absence of a subject link,node --test "tests/**/*.test.ts",PASS
VG-IDENT-003,SPEC-001 2,T-VG-IDENT-003-01,tests/domain/entities.test.ts,an exposure always carries a confidence with a basis,node --test "tests/**/*.test.ts",PASS
VG-AUTHZ-001,SPEC-001 3.1,T-VG-AUTHZ-001-01,tests/domain/entities.test.ts,a revoked or expired grant is refused at use,node --test "tests/**/*.test.ts",PASS
VG-AUTHZ-002,SPEC-001 3.1,T-VG-AUTHZ-002-01,tests/domain/entities.test.ts,an AGENT grant requires a signed instrument and evidence,node --test "tests/**/*.test.ts",PASS
VG-POLICY-001,SPEC-001 3.3,T-VG-POLICY-001-01,tests/domain/entities.test.ts,model output cannot author a jurisdiction policy,node --test "tests/**/*.test.ts",PASS
VG-POLICY-002,SPEC-001 3.3,T-VG-POLICY-002-01,tests/domain/entities.test.ts,a PolicyDecision requires all four fields,node --test "tests/**/*.test.ts",PASS
VG-POLICY-004,SPEC-001 3.1,T-VG-POLICY-004-01,tests/domain/entities.test.ts,a minor subject cannot enter an automated write lane,node --test "tests/**/*.test.ts",PASS
VG-CHANNEL-002,SPEC-001 3.2,T-VG-CHANNEL-002-01,tests/domain/entities.test.ts,WRITE_UNCLEAR forbids writes exactly like PROHIBITED,node --test "tests/**/*.test.ts",PASS
VG-CHANNEL-003,SPEC-001 3.2,T-VG-CHANNEL-003-01,tests/domain/entities.test.ts,a stale or disabled recipe cannot write,node --test "tests/**/*.test.ts",PASS
VG-SEC-001,SPEC-001 3.2,T-VG-SEC-001-01,tests/domain/entities.test.ts,tainted remote content cannot direct an action,node --test "tests/**/*.test.ts",PASS
VG-SEC-002,SPEC-001 3.5,T-VG-SEC-002-01,tests/domain/entities.test.ts,an audit payload carrying apparent PII is refused,node --test "tests/**/*.test.ts",PASS
VG-ACTION-001,SPEC-001 3.4,T-VG-ACTION-001-01,tests/domain/entities.test.ts,an ExternalAction always names exactly one idempotency key,node --test "tests/**/*.test.ts",PASS
VG-ACTION-002,SPEC-001 3.4,T-VG-ACTION-002-01,tests/domain/entities.test.ts,an ambiguous status forces reconciliation,node --test "tests/**/*.test.ts",PASS
VG-ACTION-004,SPEC-001 3.4,T-VG-ACTION-004-01,tests/domain/entities.test.ts,mail without tracking cannot reach ACKNOWLEDGED,node --test "tests/**/*.test.ts",PASS
VG-VERIFY-001,SPEC-001 3.4,T-VG-VERIFY-001-01,tests/domain/entities.test.ts,the acting path cannot verify itself,node --test "tests/**/*.test.ts",PASS
VG-REAPPEAR-001,SPEC-001 3.4,T-VG-REAPPEAR-001-01,tests/domain/entities.test.ts,Reappearance requires a prior VERIFIED_REMOVED,node --test "tests/**/*.test.ts",PASS
VG-EVIDENCE-001,SPEC-001 3.5,T-VG-EVIDENCE-001-01,tests/domain/entities.test.ts,an evidence artifact is content-addressed,node --test "tests/**/*.test.ts",PASS
VG-EGRESS-002,SPEC-001 3.5,T-VG-EGRESS-002-01,tests/domain/entities.test.ts,a repair capsule refuses apparent PII before egress,node --test "tests/**/*.test.ts",PASS
ADR-004-transport,SPEC-001 3.5,T-ADR-004-transport,tests/domain/entities.test.ts,only official transports are representable,node --test "tests/**/*.test.ts",PASS
```

RUN:

```sh
sh scripts/typecheck.sh
sh scripts/test-unit.sh
sh scripts/test-collection-guard.sh
node --test tests/domain/entities.test.ts 2>&1 | tail -n 8
```

EXPECT: `typecheck: ok`; `test-unit: ok` with zero failures and the passing count strictly
greater than M2's; `test collection guard: ok` with `filesSeen` increased by one;
`entities.test.ts` reports zero failures and zero skipped tests.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-002 MILESTONE_PASS "M3 27 entities and their invariants; test-unit: ok"`

FALLBACK: if a spec invariant cannot be enforced in a factory without inventing data the
domain does not have (for example a uniqueness rule that is a database concern), enforce
it where it is enforceable — as a predicate exported beside the entity — and record the
split in `tests/domain/DOMAIN_TEST_MAP.csv` and the ledger. Never drop the invariant
silently, and never move it into a test-only helper.

COMMIT: `git add -A && git commit -m "[EP-002][M3] domain entities with spec invariants"`

### M4: Ports (declarations only) and the domain event catalogue

GOAL: The ten ports of SPEC-001 §5 are declared as interfaces with no implementation, and
all twenty-two events of §7 exist with their envelope enforced.

READ: `.agent/specs/SPEC-001-core-domain.md` §5 and §7, `ARCHITECTURE.md` (layer law),
`src/domain/entities.ts`, `src/domain/values.ts`, `src/domain/identifiers.ts`,
`.agent/DONE_LAW.md` (DOD-010).

CHANGE: `src/domain/ports/index.ts` (create); `src/application/ports/index.ts` and `src/application/ports/job-queue.ts` (create — the `JobQueue` port, SPEC-001 §5.1); `src/domain/events.ts` (create);
`tests/domain/events.test.ts` (create);
`.agent/verification/EXPECTED_TEST_MANIFEST.txt` (append the suite);
`COMMANDS.md` (no new command).

CONTENT:

FILE: src/domain/ports/index.ts   (CREATE — declarations only, no implementation)

FILE: src/application/ports/job-queue.ts   (CREATE — declarations only)
The single application-layer port. `enqueue(tx, job)` takes the CALLER'S transaction
handle, never a fresh connection, so a job is enqueued by the same transaction that
performed the state transition requiring it (ADR-016). Declaring it here rather than in
EP-003 keeps port declaration in one node (SPEC-001 §5.1 rule 4).
```ts
/**
 * Domain ports (SPEC-001 §5) — declarations only.
 *
 * The domain declares what it needs; infrastructure satisfies it. Nothing in this file
 * may acquire an implementation: an implementation here would put a socket, a database
 * driver, or a clock read inside the layer whose whole value is that it is pure.
 * `tests/domain/events.test.ts` asserts that importing this module yields zero runtime
 * exports.
 *
 * `Clock` and `IdGenerator` are ports rather than ambient calls so that observation
 * windows (VG-VERIFY-002) and scheduled re-observation (VG-REAPPEAR-001) are testable
 * without sleeping and without network.
 */

import type {
  ActionId,
  EvidenceId,
  IdKind,
  SourceId,
  TenantId,
} from './identifiers.ts';
import type {
  AuditEvent,
  JurisdictionPolicy,
  RemovalRecipe,
  SourceRecord,
} from './entities.ts';
import type {
  ChannelName,
  EgressClass,
  EvidenceDigest,
  IdempotencyKey,
  Jurisdiction,
} from './values.ts';

/** Injectable time. Enables deterministic window and reappearance tests. */
export interface Clock {
  nowMs(): number;
}

/** Opaque identifier creation, one kind at a time. */
export interface IdGenerator {
  next(kind: IdKind): string;
}

/** Content-addressed evidence storage with digest verification (VG-EVIDENCE-001). */
export interface EvidenceStore {
  put(content: Uint8Array, digest: EvidenceDigest): Promise<void>;
  get(digest: EvidenceDigest): Promise<Uint8Array>;
  /** True only when the stored bytes still hash to the digest. */
  verify(digest: EvidenceDigest): Promise<boolean>;
}

/** Read-only observation of a Source (VG-DISC-001). */
export interface SourceReader {
  read(sourceId: SourceId): Promise<readonly SourceRecord[]>;
}

export interface ChannelWriteRequest {
  readonly tenantId: TenantId;
  readonly actionId: ActionId;
  readonly recipe: RemovalRecipe;
  readonly channel: ChannelName;
  readonly idempotencyKey: IdempotencyKey;
  readonly payloadRef: string;
}

/** Exactly one external effect, or an honest ambiguity. Never a blind retry. */
export type ChannelWriteOutcome =
  | { readonly kind: 'ACCEPTED'; readonly receiptRef: string }
  | { readonly kind: 'REFUSED'; readonly reason: string }
  | { readonly kind: 'AMBIGUOUS'; readonly detail: string }
  | { readonly kind: 'HUMAN_GATE'; readonly gateKind: string; readonly reason: string };

export interface ChannelWriter {
  submit(request: ChannelWriteRequest): Promise<ChannelWriteOutcome>;
}

export interface ObserveRequest {
  readonly tenantId: TenantId;
  readonly caseId: string;
  readonly sourceId: SourceId;
  readonly method: string;
  /** The identity that performed the action. Must differ from the observer. */
  readonly actingIdentity: string;
}

export type ObservationOutcome =
  | { readonly kind: 'ABSENT'; readonly evidenceId: EvidenceId }
  | { readonly kind: 'PRESENT'; readonly evidenceId: EvidenceId }
  | { readonly kind: 'INCONCLUSIVE'; readonly reason: string };

/** Observation through a path distinct from the acting path (VG-VERIFY-001). */
export interface IndependentObserver {
  observe(request: ObserveRequest): Promise<ObservationOutcome>;
}

/** Versioned jurisdiction policy lookup (VG-POLICY-001). */
export interface PolicyRepository {
  policyInForce(
    jurisdiction: Jurisdiction,
    atMs: number,
  ): Promise<JurisdictionPolicy | undefined>;
}

/** Append-only event sink (VG-EVIDENCE-003). */
export interface AuditSink {
  append(events: readonly AuditEvent[]): Promise<void>;
}

export interface EgressRequest {
  readonly tenantId: TenantId;
  readonly destination: string;
  readonly egressClass: EgressClass;
  readonly payloadRef: string;
}

/** Classify and gate data before any egress. Deny-by-default (VG-EGRESS-001). */
export interface EgressGate {
  classify(payload: unknown): EgressClass;
  authorize(request: EgressRequest): Promise<boolean>;
}

/** Secret access without database persistence (VG-SEC-002). */
export interface SecretResolver {
  resolve(name: string): Promise<string>;
}
```

FILE: src/domain/events.ts   (CREATE)
```ts
/**
 * Domain events (SPEC-001 §7).
 *
 * Immutable facts, past tense, carrying `correlationId` and `tenantId`. They are the only
 * channel by which the application layer reacts to domain change; the domain never calls
 * outward.
 *
 * Payloads are restricted to opaque scalars and are refused when they appear to contain
 * personal data. That restriction is the reason an event can be logged, counted, and
 * replayed safely: there is nothing in it to leak (VG-SEC-002, VG-EGRESS-002).
 */

import { InvalidValueObject } from './errors.ts';
import type { TenantId } from './identifiers.ts';
import { containsApparentPii } from './values.ts';

/** The twenty-two events of SPEC-001 §7, in spec order. */
export const DOMAIN_EVENT_NAMES = [
  'SubjectRegistered',
  'AuthorityGranted',
  'AuthorityRevoked',
  'AliasAttached',
  'AliasQuarantined',
  'SourceRecordObserved',
  'MatchConfirmed',
  'MatchDisproved',
  'PolicyResolved',
  'RequestReady',
  'ActionSubmitted',
  'ActionAmbiguous',
  'Acknowledged',
  'Refused',
  'HumanRequired',
  'VerifiedRemoved',
  'VerificationFailed',
  'Reappeared',
  'NotRemovable',
  'SearchDelisted',
  'EvidenceStored',
  'BudgetExceeded',
] as const;

export type DomainEventName = (typeof DOMAIN_EVENT_NAMES)[number];

/** Opaque scalars only: no nested objects, no arrays, no raw records. */
export type EventPayloadValue = string | number | boolean | null;

export interface DomainEvent {
  readonly eventId: string;
  readonly name: DomainEventName;
  readonly tenantId: TenantId;
  readonly correlationId: string;
  readonly occurredAtMs: number;
  readonly payload: Readonly<Record<string, EventPayloadValue>>;
}

export function isDomainEventName(value: unknown): value is DomainEventName {
  return typeof value === 'string' && (DOMAIN_EVENT_NAMES as readonly string[]).includes(value);
}

export function domainEvent(input: {
  eventId: string;
  name: DomainEventName;
  tenantId: TenantId;
  correlationId: string;
  occurredAtMs: number;
  payload?: Readonly<Record<string, EventPayloadValue>>;
}): DomainEvent {
  if (!isDomainEventName(input.name)) {
    throw new InvalidValueObject(
      'DomainEvent',
      `name must be one of the twenty-two SPEC-001 §7 events; received ${String(input.name)}`,
    );
  }
  if (typeof input.eventId !== 'string' || input.eventId.trim().length === 0) {
    throw new InvalidValueObject('DomainEvent', 'eventId must be a non-empty string');
  }
  if (typeof input.correlationId !== 'string' || input.correlationId.trim().length === 0) {
    throw new InvalidValueObject(
      'DomainEvent',
      'correlationId is required; an event that cannot be correlated cannot be operated (VG-OBS-001)',
    );
  }
  if (!Number.isInteger(input.occurredAtMs)) {
    throw new InvalidValueObject('DomainEvent', 'occurredAtMs must be an integer');
  }
  const payload = input.payload ?? {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' && containsApparentPii(value)) {
      throw new InvalidValueObject(
        'DomainEvent',
        `payload.${key} appears to contain personal data; events carry opaque identifiers only (VG-SEC-002)`,
      );
    }
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new InvalidValueObject(
        'DomainEvent',
        `payload.${key} must be an opaque scalar; nested structures are refused`,
      );
    }
  }
  return Object.freeze({
    eventId: input.eventId,
    name: input.name,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    occurredAtMs: input.occurredAtMs,
    payload: Object.freeze({ ...payload }),
  });
}
```

FILE: tests/domain/events.test.ts   (CREATE)
```ts
/**
 * Event catalogue tests (SPEC-001 §7) and the ports declaration test (SPEC-001 §5).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as ports from '../../src/domain/ports/index.ts';
import {
  DOMAIN_EVENT_NAMES,
  domainEvent,
  isDomainEventName,
} from '../../src/domain/events.ts';
import { TenantId } from '../../src/domain/identifiers.ts';
import { InvalidValueObject } from '../../src/domain/errors.ts';

const tenantId = new TenantId('tenant-0001');

describe('domain event catalogue (SPEC-001 §7)', () => {
  test('exactly the twenty-two documented events exist', () => {
    assert.equal(DOMAIN_EVENT_NAMES.length, 22);
    assert.deepEqual(
      [...DOMAIN_EVENT_NAMES].sort(),
      [
        'Acknowledged',
        'ActionAmbiguous',
        'ActionSubmitted',
        'AliasAttached',
        'AliasQuarantined',
        'AuthorityGranted',
        'AuthorityRevoked',
        'BudgetExceeded',
        'EvidenceStored',
        'HumanRequired',
        'MatchConfirmed',
        'MatchDisproved',
        'NotRemovable',
        'PolicyResolved',
        'Reappeared',
        'Refused',
        'RequestReady',
        'SearchDelisted',
        'SourceRecordObserved',
        'SubjectRegistered',
        'VerificationFailed',
        'VerifiedRemoved',
      ].sort(),
    );
  });

  test('every name is a past-tense fact and no name is an ad-hoc success word', () => {
    for (const name of DOMAIN_EVENT_NAMES) {
      assert.match(name, /^[A-Z][A-Za-z]+$/, `${name} must be a past-tense event name`);
      assert.ok(!['Success', 'Done', 'Complete', 'Removed'].includes(name));
    }
  });

  test('membership guard refuses non-events', () => {
    assert.equal(isDomainEventName('VerifiedRemoved'), true);
    assert.equal(isDomainEventName('verifiedRemoved'), false);
    assert.equal(isDomainEventName('Success'), false);
    assert.equal(isDomainEventName(42), false);
  });
});

describe('event envelope (VG-OBS-001, VG-SEC-002)', () => {
  test('an event carries correlationId, tenantId and a timestamp', () => {
    const event = domainEvent({
      eventId: 'event-1',
      name: 'VerifiedRemoved',
      tenantId,
      correlationId: 'corr-1',
      occurredAtMs: 1_000,
      payload: { caseId: 'case-0001', transitionId: 'T14' },
    });
    assert.equal(event.correlationId, 'corr-1');
    assert.equal(event.tenantId.value, 'tenant-0001');
    assert.equal(event.payload['transitionId'], 'T14');
  });

  test('a missing correlationId is refused', () => {
    assert.throws(
      () =>
        domainEvent({
          eventId: 'event-2',
          name: 'RequestReady',
          tenantId,
          correlationId: '   ',
          occurredAtMs: 1_000,
        }),
      InvalidValueObject,
    );
  });

  test('a payload containing apparent PII is refused', () => {
    assert.throws(
      () =>
        domainEvent({
          eventId: 'event-3',
          name: 'MatchConfirmed',
          tenantId,
          correlationId: 'corr-1',
          occurredAtMs: 1_000,
          payload: { basis: 'jane.doe@example.com' },
        }),
      InvalidValueObject,
    );
  });

  test('a non-scalar payload value is refused', () => {
    assert.throws(
      () =>
        domainEvent({
          eventId: 'event-4',
          name: 'MatchConfirmed',
          tenantId,
          correlationId: 'corr-1',
          occurredAtMs: 1_000,
          payload: { nested: { a: 1 } as never },
        }),
      InvalidValueObject,
    );
  });
});

describe('domain ports are declarations only (SPEC-001 §5)', () => {
  test('importing ports.ts yields no runtime exports', () => {
    assert.deepEqual(Object.keys(ports), []);
  });
});
```

FILE: .agent/verification/EXPECTED_TEST_MANIFEST.txt   (MODIFY — append if absent)
```
tests/domain/events.test.ts
```

RUN:

```sh
sh scripts/typecheck.sh
sh scripts/test-unit.sh
sh scripts/test-collection-guard.sh
```

EXPECT: `typecheck: ok`; `test-unit: ok` with zero failures; `test collection guard: ok`
with `filesSeen` increased by one and zero skipped tests.

EVIDENCE: `sh scripts/ledger.append`-equivalent: `sh scripts/ledger.sh append <AGENT_ID> EP-002 MILESTONE_PASS "M4 ports declared with zero runtime exports; event catalogue complete"`

FALLBACK: if `Object.keys(ports)` cannot be empty because a helper value is genuinely
needed (for example a default retry policy constant), move that value out of `ports.ts`
into its own module and keep `ports.ts` declarations-only — the invariant matters more
than the file's convenience.

COMMIT: `git add -A && git commit -m "[EP-002][M4] domain ports and event catalogue"`

### M5: Domain commands — exactly one transition each, audited

GOAL: All eleven SPEC-001 §6 commands exist as pure functions that validate
preconditions, apply exactly one transition, and emit the declared events plus an audit
event.

READ: `.agent/specs/SPEC-001-core-domain.md` §4.1, §4.2, §6, §7;
`src/domain/state-machine.ts`, `src/domain/truth-state.ts`, `src/domain/entities.ts`,
`src/domain/events.ts`, `src/domain/ports/index.ts`, `tests/domain/state-machine.test.ts`.

CHANGE: `src/domain/commands.ts` (create); `tests/domain/commands.test.ts` (create);
`tests/domain/DOMAIN_TEST_MAP.csv` (append the command rows);
`.agent/verification/EXPECTED_TEST_MANIFEST.txt` (append the suite);
`COMMANDS.md` (no new command).

CONTENT:

A note on one spec gap, recorded rather than papered over: SPEC-001 §6 lists eleven
commands, and none of them owns transition **T21** (`MATCH_CONFIRMED` →
`SEARCH_DELISTED`). T21 therefore remains reachable only through the state-machine API
(`applyTransition`) until a spec revision names its owning command. This is recorded in
`tests/domain/DOMAIN_TEST_MAP.csv` and the ledger; no twelfth command is invented.

FILE: src/domain/commands.ts   (CREATE)
```ts
/**
 * Domain commands (SPEC-001 §6).
 *
 * Each command validates its preconditions, applies EXACTLY ONE transition through
 * `applyTransition`/`applyInitialState`, and returns the emitted events plus an
 * `AuditEvent` (SM-2). No command assigns a truth state directly (SM-6), performs I/O,
 * reads a clock, or generates randomness: everything it needs is passed in, which is what
 * makes the whole layer testable without infrastructure.
 *
 * Refusal is a first-class result, not an exception everywhere it is a legitimate product
 * answer: `RecordVerification` returning a refusal (state unchanged, `VerificationFailed`
 * emitted) is the honest outcome when the observation is not independent or the window
 * has not elapsed. Guard violations that indicate a programming error still throw typed
 * domain errors.
 */

import {
  BudgetExceeded,
  GuardNotSatisfied,
  IdempotencyConflict,
  IllegalTransition,
} from './errors.ts';
import {
  applyInitialState,
  applyTransition,
  legalTransitionsFrom,
  noFacts,
} from './state-machine.ts';
import {
  TRUTH_STATE_FACTS,
  type TransitionFacts,
  type TransitionId,
  type TruthState,
} from './truth-state.ts';
import {
  assertAuthorityUsableAt,
  assertRecipeUsableAt,
  sourceMayBeWritten,
  type Alias,
  type AuditEvent,
  type AuthorityGrant,
  type ControllerResponse,
  type ExternalAction,
  type JurisdictionPolicy,
  type PolicyDecision,
  type ProtectedSubject,
  type RemovalRecipe,
  type Source,
  type SourceRecord,
  type VerificationObservation,
  createAuditEvent,
} from './entities.ts';
import {
  domainEvent,
  type DomainEvent,
  type DomainEventName,
  type EventPayloadValue,
} from './events.ts';
import type { TenantId } from './identifiers.ts';
import {
  selectChannel,
  type ChannelOption,
  type ObservationWindow,
} from './values.ts';

export type DomainCommandName =
  | 'RegisterSubject'
  | 'AttachAlias'
  | 'RecordSourceRecord'
  | 'AssessMatch'
  | 'ResolvePolicy'
  | 'PrepareRequest'
  | 'ExecuteAction'
  | 'RecordControllerResponse'
  | 'RecordVerification'
  | 'DetectReappearance'
  | 'RequestHumanGate';

/**
 * The events each command may emit. Nothing outside this map may be emitted by a command,
 * which is what makes the event stream auditable against SPEC-001 §7.
 */
export const COMMAND_EVENTS: Readonly<Record<DomainCommandName, readonly DomainEventName[]>> =
  Object.freeze({
    RegisterSubject: ['SubjectRegistered'],
    AttachAlias: ['AliasAttached', 'AliasQuarantined'],
    RecordSourceRecord: ['SourceRecordObserved'],
    AssessMatch: ['MatchConfirmed', 'MatchDisproved'],
    ResolvePolicy: ['PolicyResolved'],
    PrepareRequest: ['RequestReady', 'NotRemovable', 'HumanRequired'],
    ExecuteAction: ['ActionSubmitted', 'ActionAmbiguous', 'BudgetExceeded', 'HumanRequired'],
    RecordControllerResponse: ['Acknowledged', 'HumanRequired', 'Refused'],
    RecordVerification: ['VerifiedRemoved', 'VerificationFailed'],
    DetectReappearance: ['Reappeared'],
    RequestHumanGate: ['HumanRequired'],
  });

export interface CommandContext {
  readonly tenantId: TenantId;
  readonly correlationId: string;
  readonly nowMs: number;
}

export interface CommandResult {
  readonly command: DomainCommandName;
  readonly tenantId: TenantId;
  readonly correlationId: string;
  readonly events: readonly DomainEvent[];
  readonly audit: AuditEvent;
  /** SM-5: HUMAN_REQUIRED and NOT_REMOVABLE are legitimate outcomes, not failures. */
  readonly isLegitimateOutcome: boolean;
  readonly createdIds: Readonly<Record<string, string>>;
}

export interface TransitionCommandResult extends CommandResult {
  readonly from: TruthState | null;
  readonly to: TruthState;
  readonly transitionId: TransitionId;
  readonly evidence: string;
}

export interface RefusalResult extends CommandResult {
  readonly refused: true;
  readonly currentTruthState: TruthState;
  readonly refusalReason: string;
  readonly guard: string;
}

const ACTOR = 'domain-command';

function legitimateOutcome(state: TruthState): boolean {
  const facts = TRUTH_STATE_FACTS[state];
  return facts.isLegitimateOutcome;
}

function buildAudit(
  ctx: CommandContext,
  command: DomainCommandName,
  targetKind: string,
  targetId: string | null,
  payload: Readonly<Record<string, EventPayloadValue>>,
): AuditEvent {
  return createAuditEvent({
    id: `${command}:${ctx.correlationId}:${ctx.nowMs}`,
    tenantId: ctx.tenantId,
    actor: ACTOR,
    action: command,
    targetKind,
    targetId,
    correlationId: ctx.correlationId,
    atMs: ctx.nowMs,
    payload: { command, ...payload },
  });
}

function buildEvents(
  ctx: CommandContext,
  names: readonly DomainEventName[],
  payload: Readonly<Record<string, EventPayloadValue>>,
): readonly DomainEvent[] {
  return Object.freeze(
    names.map((name) =>
      domainEvent({
        eventId: `${name}:${ctx.correlationId}:${ctx.nowMs}`,
        name,
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
        occurredAtMs: ctx.nowMs,
        payload,
      }),
    ),
  );
}

interface TransitionArgs {
  readonly ctx: CommandContext;
  readonly command: DomainCommandName;
  readonly caseId: string;
  readonly from: TruthState | null;
  readonly to: TruthState;
  readonly facts: TransitionFacts;
  readonly eventNames: readonly DomainEventName[];
  readonly payload: Readonly<Record<string, EventPayloadValue>>;
  /** Extra audit-only fields (for example a human-readable gate reason). */
  readonly auditExtra?: Readonly<Record<string, EventPayloadValue>>;
  readonly createdIds?: Readonly<Record<string, string>>;
}

function transition(args: TransitionArgs): TransitionCommandResult {
  const applied =
    args.from === null
      ? applyInitialState(args.to, args.facts)
      : applyTransition(args.from, args.to, args.facts);
  return Object.freeze({
    command: args.command,
    tenantId: args.ctx.tenantId,
    correlationId: args.ctx.correlationId,
    from: applied.from,
    to: applied.to,
    transitionId: applied.id,
    evidence: applied.evidence,
    events: buildEvents(args.ctx, args.eventNames, args.payload),
    audit: buildAudit(args.ctx, args.command, 'RequestCase', args.caseId, {
      ...args.payload,
      ...(args.auditExtra ?? {}),
    }),
    isLegitimateOutcome: legitimateOutcome(applied.to),
    createdIds: Object.freeze({ ...(args.createdIds ?? {}) }),
  });
}

interface RefusalArgs {
  readonly ctx: CommandContext;
  readonly command: DomainCommandName;
  readonly caseId: string;
  readonly currentTruthState: TruthState;
  readonly refusalReason: string;
  readonly guard: string;
  readonly eventNames: readonly DomainEventName[];
  readonly payload: Readonly<Record<string, EventPayloadValue>>;
}

function refusal(args: RefusalArgs): RefusalResult {
  return Object.freeze({
    command: args.command,
    tenantId: args.ctx.tenantId,
    correlationId: args.ctx.correlationId,
    events: buildEvents(args.ctx, args.eventNames, args.payload),
    audit: buildAudit(args.ctx, args.command, 'RequestCase', args.caseId, args.payload),
    isLegitimateOutcome: legitimateOutcome(args.currentTruthState),
    createdIds: Object.freeze({}),
    refused: true,
    currentTruthState: args.currentTruthState,
    refusalReason: args.refusalReason,
    guard: args.guard,
  });
}

// ---------------------------------------------------------------------------
// RegisterSubject, AttachAlias, RecordSourceRecord
// ---------------------------------------------------------------------------

/** VG-IDENT-001: no subject without a verified, unexpired AuthorityGrant. */
export function registerSubject(
  ctx: CommandContext,
  input: { readonly subject: ProtectedSubject; readonly grant: AuthorityGrant },
): CommandResult {
  assertAuthorityUsableAt(input.grant, ctx.nowMs);
  if (input.grant.subjectId.value !== input.subject.id.value) {
    throw new GuardNotSatisfied('RegisterSubject', 'grant subject must match the subject');
  }
  const payload = { subjectId: input.subject.id.value, authorityGrantId: input.grant.id };
  return Object.freeze({
    command: 'RegisterSubject',
    tenantId: ctx.tenantId,
    correlationId: ctx.correlationId,
    events: buildEvents(ctx, COMMAND_EVENTS.RegisterSubject, payload),
    audit: buildAudit(ctx, 'RegisterSubject', 'ProtectedSubject', input.subject.id.value, payload),
    isLegitimateOutcome: true,
    createdIds: Object.freeze({ subjectId: input.subject.id.value, authorityGrantId: input.grant.id }),
  });
}

/** VG-IDENT-002: an ambiguous alias is quarantined, never auto-attached. */
export function attachAlias(
  ctx: CommandContext,
  input: { readonly alias: Alias; readonly ambiguous: boolean },
): CommandResult {
  const quarantined = input.ambiguous || input.alias.quarantined;
  const names: readonly DomainEventName[] = quarantined
    ? COMMAND_EVENTS.AttachAlias.filter((name) => name === 'AliasQuarantined')
    : COMMAND_EVENTS.AttachAlias.filter((name) => name === 'AliasAttached');
  const payload = {
    aliasId: input.alias.id,
    quarantined,
    reason: input.ambiguous ? 'ambiguous-match-two-subjects' : null,
  };
  return Object.freeze({
    command: 'AttachAlias',
    tenantId: ctx.tenantId,
    correlationId: ctx.correlationId,
    events: buildEvents(ctx, names, payload),
    audit: buildAudit(ctx, 'AttachAlias', 'Alias', input.alias.id, payload),
    isLegitimateOutcome: true,
    createdIds: Object.freeze({ aliasId: input.alias.id }),
  });
}

/** T1: a candidate exists only when a permitted read path observed the record. */
export function recordSourceRecord(
  ctx: CommandContext,
  input: { readonly record: SourceRecord; readonly permittedReadPath: boolean },
): TransitionCommandResult {
  const payload = {
    sourceRecordId: input.record.id,
    sourceId: input.record.sourceId.value,
    tainted: input.record.tainted,
  };
  return transition({
    ctx,
    command: 'RecordSourceRecord',
    caseId: input.record.id,
    from: null,
    to: 'DISCOVERED_CANDIDATE',
    facts: noFacts({ sourceRecordObserved: input.permittedReadPath }),
    eventNames: COMMAND_EVENTS.RecordSourceRecord,
    payload,
    createdIds: { sourceRecordId: input.record.id },
  });
}

// ---------------------------------------------------------------------------
// AssessMatch, ResolvePolicy
// ---------------------------------------------------------------------------

export interface MatchAssessment {
  readonly caseId: string;
  readonly from: TruthState;
  readonly matched: boolean;
  readonly confidenceAtThreshold: boolean;
  readonly confidenceBasisRecorded: boolean;
  readonly humanApproved: boolean;
  readonly disproofRecorded: boolean;
}

/** T3 (match confirmed) or T4 (match disproved → VERIFIED_NOT_PRESENT). */
export function assessMatch(
  ctx: CommandContext,
  input: MatchAssessment,
): TransitionCommandResult {
  if (input.matched) {
    return transition({
      ctx,
      command: 'AssessMatch',
      caseId: input.caseId,
      from: input.from,
      to: 'MATCH_CONFIRMED',
      facts: noFacts({
        confidenceAtThreshold: input.confidenceAtThreshold,
        confidenceBasisRecorded: input.confidenceBasisRecorded,
        humanApprovedMatch: input.humanApproved,
      }),
      eventNames: ['MatchConfirmed'],
      payload: { caseId: input.caseId, humanApproved: input.humanApproved },
    });
  }
  return transition({
    ctx,
    command: 'AssessMatch',
    caseId: input.caseId,
    from: input.from,
    to: 'VERIFIED_NOT_PRESENT',
    facts: noFacts({ subjectMatchDisproved: input.disproofRecorded }),
    eventNames: ['MatchDisproved'],
    payload: { caseId: input.caseId, disproofRecorded: input.disproofRecorded },
  });
}

/** VG-POLICY-001/002: a legal basis must exist in the policy version in force. */
export function assertPolicyInForce(
  policy: JurisdictionPolicy,
  decision: PolicyDecision,
  atMs: number,
): true {
  if (!policy.jurisdiction.equals(decision.jurisdiction)) {
    throw new GuardNotSatisfied('ResolvePolicy', 'policy jurisdiction must match the decision');
  }
  if (policy.version !== decision.policyVersion) {
    throw new GuardNotSatisfied(
      'ResolvePolicy',
      `policy version ${policy.version} is not the decision version ${decision.policyVersion}`,
    );
  }
  if (atMs < policy.effectiveFromMs || (policy.effectiveToMs !== null && atMs >= policy.effectiveToMs)) {
    throw new GuardNotSatisfied(
      'ResolvePolicy',
      `policy version ${policy.version} is not in force at ${atMs}`,
    );
  }
  if (!policy.rules.includes(decision.legalBasis.code)) {
    throw new GuardNotSatisfied(
      'ResolvePolicy',
      `legal basis ${decision.legalBasis.code} does not exist in policy version ${policy.version} (VG-POLICY-001)`,
    );
  }
  return true;
}

export function resolvePolicy(
  ctx: CommandContext,
  input: {
    readonly caseId: string;
    readonly decision: PolicyDecision;
    readonly policy: JurisdictionPolicy;
  },
): CommandResult {
  assertPolicyInForce(input.policy, input.decision, ctx.nowMs);
  const payload = {
    caseId: input.caseId,
    jurisdiction: input.decision.jurisdiction.value,
    legalBasis: input.decision.legalBasis.code,
    channel: input.decision.channel,
    policyVersion: input.decision.policyVersion,
  };
  return Object.freeze({
    command: 'ResolvePolicy',
    tenantId: ctx.tenantId,
    correlationId: ctx.correlationId,
    events: buildEvents(ctx, COMMAND_EVENTS.ResolvePolicy, payload),
    audit: buildAudit(ctx, 'ResolvePolicy', 'PolicyDecision', input.decision.id, payload),
    isLegitimateOutcome: true,
    createdIds: Object.freeze({ policyDecisionId: input.decision.id }),
  });
}

// ---------------------------------------------------------------------------
// PrepareRequest
// ---------------------------------------------------------------------------

export interface PrepareRequestInput {
  readonly caseId: string;
  readonly from: 'MATCH_CONFIRMED' | 'REAPPEARED';
  readonly authority: AuthorityGrant;
  readonly decision: PolicyDecision;
  readonly policy: JurisdictionPolicy;
  readonly recipe: RemovalRecipe;
  readonly source: Source;
  readonly channelOptions: readonly ChannelOption[];
  readonly exemptionRecorded: boolean;
  readonly humanGate: { readonly gateKind: string; readonly reason: string } | null;
}

/**
 * T5/T18 (REQUEST_READY), T6/T19 (NOT_REMOVABLE), T7 (HUMAN_REQUIRED) for a confirmed
 * match. Authority, policy and recipe are re-asserted at this moment, not remembered.
 */
export function prepareRequest(
  ctx: CommandContext,
  input: PrepareRequestInput,
): TransitionCommandResult {
  assertAuthorityUsableAt(input.authority, ctx.nowMs);
  assertRecipeUsableAt(input.recipe, ctx.nowMs);
  assertPolicyInForce(input.policy, input.decision, ctx.nowMs);

  const unavailable: ChannelOption[] = [];
  for (const option of input.channelOptions) {
    if (option.unavailableKind !== null) unavailable.push(option);
  }
  let channelPermitted = false;
  let selected: ChannelOption | null = null;
  try {
    selected = selectChannel(input.channelOptions);
    channelPermitted =
      selected.channel !== 'NOT_REMOVABLE_OUTCOME' && sourceMayBeWritten(input.source);
  } catch {
    channelPermitted = false;
  }

  const payload = {
    caseId: input.caseId,
    authorityGrantId: input.authority.id,
    policyDecisionId: input.decision.id,
    recipeId: input.recipe.id.value,
    channel: selected === null ? null : selected.channel,
    channelsConsidered: input.channelOptions.length,
    channelsUnavailable: unavailable.length,
  };

  const guardFacts = {
    authorityValid: true,
    policyDecisionComplete: true,
    recipeSignedAndFresh: true,
    channelPermitted,
    freshAuthorityPolicyRecipe: input.from === 'REAPPEARED',
  };

  if (input.humanGate !== null) {
    return transition({
      ctx,
      command: 'PrepareRequest',
      caseId: input.caseId,
      from: input.from,
      to: 'HUMAN_REQUIRED',
      facts: noFacts({ ...guardFacts, humanGateDetected: true }),
      eventNames: ['HumanRequired'],
      payload: { ...payload, gateKind: input.humanGate.gateKind },
    });
  }
  if (!channelPermitted) {
    const to: TruthState = 'NOT_REMOVABLE';
    return transition({
      ctx,
      command: 'PrepareRequest',
      caseId: input.caseId,
      from: input.from,
      to,
      facts: noFacts({ ...guardFacts, exemptionRecorded: true }),
      eventNames: ['NotRemovable'],
      payload: { ...payload, basis: input.exemptionRecorded ? 'exemption-recorded' : 'no-lawful-writable-channel' },
    });
  }
  return transition({
    ctx,
    command: 'PrepareRequest',
    caseId: input.caseId,
    from: input.from,
    to: 'REQUEST_READY',
    facts: noFacts(guardFacts),
    eventNames: ['RequestReady'],
    payload,
  });
}

// ---------------------------------------------------------------------------
// ExecuteAction
// ---------------------------------------------------------------------------

export interface ExecuteActionInput {
  readonly caseId: string;
  readonly action: ExternalAction;
  readonly existingIdempotencyKeys: readonly string[];
  readonly budgetAvailable: boolean;
  readonly outcome:
    | { readonly kind: 'ACCEPTED'; readonly receiptRef: string }
    | { readonly kind: 'REFUSED'; readonly reason: string }
    | { readonly kind: 'AMBIGUOUS'; readonly detail: string }
    | { readonly kind: 'HUMAN_GATE'; readonly gateKind: string; readonly reason: string };
}

/**
 * T8 with VG-ACTION-001 (one key, one effect), VG-ACTION-002 (ambiguity reconciles),
 * VG-ACTION-005 (effect budget) and T9 (a gate found at execution time).
 */
export function executeAction(
  ctx: CommandContext,
  input: ExecuteActionInput,
): TransitionCommandResult | RefusalResult {
  if (input.existingIdempotencyKeys.includes(input.action.idempotencyKey.value)) {
    throw new IdempotencyConflict(input.action.idempotencyKey.value, input.action.id);
  }
  const payload = {
    caseId: input.caseId,
    actionId: input.action.id.value,
    channel: input.action.channel,
    attempt: input.action.attempt,
    outcome: input.outcome.kind,
  };
  if (!input.budgetAvailable) {
    return refusal({
      ctx,
      command: 'ExecuteAction',
      caseId: input.caseId,
      currentTruthState: 'REQUEST_READY',
      refusalReason: 'effect budget exhausted for this subject, source and window (VG-ACTION-005)',
      guard: 'budgetAvailable',
      eventNames: ['BudgetExceeded'],
      payload,
    });
  }
  const facts = noFacts({
    authorityValid: true,
    idempotencyKeyAssigned: true,
    budgetAvailable: true,
    recipeSignedAndFresh: true,
    channelPermitted: true,
    humanGateDetected: input.outcome.kind === 'HUMAN_GATE',
  });
  if (input.outcome.kind === 'HUMAN_GATE') {
    return transition({
      ctx,
      command: 'ExecuteAction',
      caseId: input.caseId,
      from: 'REQUEST_READY',
      to: 'HUMAN_REQUIRED',
      facts,
      eventNames: ['HumanRequired'],
      payload: { ...payload, gateKind: input.outcome.gateKind },
    });
  }
  const eventNames: readonly DomainEventName[] =
    input.outcome.kind === 'AMBIGUOUS'
      ? ['ActionSubmitted', 'ActionAmbiguous']
      : ['ActionSubmitted'];
  return transition({
    ctx,
    command: 'ExecuteAction',
    caseId: input.caseId,
    from: 'REQUEST_READY',
    to: 'REQUEST_SUBMITTED',
    facts,
    eventNames,
    payload,
    createdIds: { actionId: input.action.id.value },
  });
}

// ---------------------------------------------------------------------------
// RecordControllerResponse
// ---------------------------------------------------------------------------

export interface ControllerResponseInput {
  readonly caseId: string;
  readonly from: 'REQUEST_SUBMITTED';
  readonly response: ControllerResponse;
  readonly outcome: 'ACKNOWLEDGED' | 'HUMAN_GATE' | 'REFUSED';
  readonly lawfulRefusalFinal: boolean;
}

/**
 * T11/T12/T13. A controller response is a claim, never an observation: this command can
 * reach ACKNOWLEDGED, and can never reach VERIFIED_REMOVED (VG-VERIFY-004).
 */
export function recordControllerResponse(
  ctx: CommandContext,
  input: ControllerResponseInput,
): TransitionCommandResult {
  const payload = {
    caseId: input.caseId,
    responseId: input.response.id,
    kind: input.response.kind,
  };
  if (input.outcome === 'HUMAN_GATE') {
    return transition({
      ctx,
      command: 'RecordControllerResponse',
      caseId: input.caseId,
      from: input.from,
      to: 'HUMAN_REQUIRED',
      facts: noFacts({ humanGateDetected: true }),
      eventNames: ['HumanRequired'],
      payload,
    });
  }
  if (input.outcome === 'REFUSED') {
    return transition({
      ctx,
      command: 'RecordControllerResponse',
      caseId: input.caseId,
      from: input.from,
      to: 'NOT_REMOVABLE',
      facts: noFacts({ exemptionRecorded: true, lawfulRefusalFinal: input.lawfulRefusalFinal }),
      eventNames: ['Refused', 'NotRemovable'],
      payload,
    });
  }
  return transition({
    ctx,
    command: 'RecordControllerResponse',
    caseId: input.caseId,
    from: input.from,
    to: 'ACKNOWLEDGED',
    facts: noFacts({ controllerResponded: true }),
    eventNames: ['Acknowledged'],
    payload,
  });
}

// ---------------------------------------------------------------------------
// RecordVerification
// ---------------------------------------------------------------------------

export interface VerificationInput {
  readonly caseId: string;
  readonly from: 'ACKNOWLEDGED';
  readonly observation: VerificationObservation;
  readonly window: ObservationWindow;
  readonly actionAtMs: number;
  readonly recipeVerificationMethod: string;
  readonly recordAbsent: boolean;
}

/**
 * T14, or an honest refusal. Both outcomes are real: a refused verification leaves the
 * case at ACKNOWLEDGED and emits VerificationFailed (VG-VERIFY-004 — a failed
 * verification never regresses into a success state).
 */
export function recordVerification(
  ctx: CommandContext,
  input: VerificationInput,
): TransitionCommandResult | RefusalResult {
  const payload = {
    caseId: input.caseId,
    observationId: input.observation.id,
    method: input.observation.method,
    finding: input.observation.finding,
  };
  const facts = noFacts({
    independentObservation: input.observation.actorIdentity !== input.observation.actingIdentity,
    observationWindowMet: input.window.hasElapsed(input.observation.observedAtMs, input.actionAtMs),
    verificationMethodMatches: input.observation.method === input.recipeVerificationMethod,
    recordAbsent: input.recordAbsent && input.observation.finding === 'ABSENT',
  });
  const satisfied =
    facts.independentObservation &&
    facts.observationWindowMet &&
    facts.verificationMethodMatches &&
    facts.recordAbsent;
  if (!satisfied) {
    return refusal({
      ctx,
      command: 'RecordVerification',
      caseId: input.caseId,
      currentTruthState: input.from,
      refusalReason:
        'the observation does not satisfy T14 (independence, window, method and absence must all hold)',
      guard: 'T14',
      eventNames: ['VerificationFailed'],
      payload,
    });
  }
  return transition({
    ctx,
    command: 'RecordVerification',
    caseId: input.caseId,
    from: input.from,
    to: 'VERIFIED_REMOVED',
    facts,
    eventNames: ['VerifiedRemoved'],
    payload,
    createdIds: { evidenceId: input.observation.evidenceId.value },
  });
}

// ---------------------------------------------------------------------------
// DetectReappearance, RequestHumanGate
// ---------------------------------------------------------------------------

/** T17 (from VERIFIED_REMOVED) or T20 (from SEARCH_DELISTED) (VG-REAPPEAR-001). */
export function detectReappearance(
  ctx: CommandContext,
  input: {
    readonly caseId: string;
    readonly from: 'VERIFIED_REMOVED' | 'SEARCH_DELISTED';
    readonly priorRemovedEventId: string;
    readonly recordPresentAgain: boolean;
  },
): TransitionCommandResult {
  return transition({
    ctx,
    command: 'DetectReappearance',
    caseId: input.caseId,
    from: input.from,
    to: 'REAPPEARED',
    facts: noFacts({ recordPresentAgain: input.recordPresentAgain }),
    eventNames: ['Reappeared'],
    payload: { caseId: input.caseId, priorRemovedEventId: input.priorRemovedEventId },
  });
}

/** Any transition into HUMAN_REQUIRED that the state machine permits from `from`. */
export function requestHumanGate(
  ctx: CommandContext,
  input: {
    readonly caseId: string;
    readonly from: TruthState;
    readonly gateKind: string;
    /** Human-readable detail. Recorded in the audit event, PII-checked there. */
    readonly reason: string;
  },
): TransitionCommandResult {
  const spec = legalTransitionsFrom(input.from).find((s) => s.to === 'HUMAN_REQUIRED');
  if (spec === undefined) {
    throw new IllegalTransition(
      input.from,
      'HUMAN_REQUIRED',
      `no HUMAN_REQUIRED transition exists from ${input.from} (SPEC-001 4.1)`,
    );
  }
  return transition({
    ctx,
    command: 'RequestHumanGate',
    caseId: input.caseId,
    from: input.from,
    to: 'HUMAN_REQUIRED',
    facts: noFacts({ humanGateDetected: true }),
    eventNames: ['HumanRequired'],
    payload: { caseId: input.caseId, gateKind: input.gateKind },
    auditExtra: { reason: input.reason },
  });
}
```

The reason is deliberately carried in the **audit** payload rather than the event payload:
`createAuditEvent` refuses payload values that appear to contain personal data, so a
free-text human note cannot smuggle PII into the audit stream, while the event stream stays
a fixed, opaque scalar shape that can be correlated and counted safely (VG-SEC-002).

FILE: tests/domain/commands.test.ts   (CREATE)
```ts
/**
 * Domain command tests (SPEC-001 §6, §7).
 *
 * Each command is asserted to apply exactly one transition, emit only events declared for
 * it, and produce an audit event. Refusals are asserted to leave the state untouched.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMAND_EVENTS,
  assertPolicyInForce,
  assessMatch,
  attachAlias,
  detectReappearance,
  executeAction,
  prepareRequest,
  recordControllerResponse,
  recordSourceRecord,
  recordVerification,
  registerSubject,
  requestHumanGate,
  resolvePolicy,
  type CommandResult,
  type RefusalResult,
  type TransitionCommandResult,
} from '../../src/domain/commands.ts';
import { createAuditEvent, createAuthorityGrant, createControllerResponse, createExternalAction, createJurisdictionPolicy, createPolicyDecision, createRemovalRecipe, createSource, createSourceRecord, createVerificationObservation, createAlias, createProtectedSubject, type ExternalAction } from '../../src/domain/entities.ts';
import { DOMAIN_EVENT_NAMES } from '../../src/domain/events.ts';
import {
  ActionId,
  CaseId,
  EvidenceId,
  RecipeId,
  SourceId,
  SubjectId,
  TenantId,
} from '../../src/domain/identifiers.ts';
import {
  EvidenceDigest,
  IdempotencyKey,
  Jurisdiction,
  LegalBasis,
  ObservationWindow,
} from '../../src/domain/values.ts';
import {
  AuthorityExpired,
  IdempotencyConflict,
  IllegalTransition,
  InvalidValueObject,
} from '../../src/domain/errors.ts';

const tenantId = new TenantId('tenant-0001');
const subjectId = new SubjectId('subject-0001');
const caseId = new CaseId('case-0001');
const sourceId = new SourceId('source-0001');
const digest = new EvidenceDigest('b'.repeat(64));
const jurisdiction = new Jurisdiction('US-CA');
const DAY = 86_400_000;
const ctx = { tenantId, correlationId: 'corr-0001', nowMs: 5 * DAY };

function grant(overrides: Record<string, unknown> = {}) {
  return createAuthorityGrant({
    id: 'grant-0001',
    tenantId,
    subjectId,
    kind: 'SELF',
    scope: ['discovery', 'self_service_write'],
    evidenceId: null,
    issuedAtMs: 0,
    expiresAtMs: 100 * DAY,
    revokedAtMs: null,
    signedInstrument: false,
    ...overrides,
  });
}

function subject(authority = grant()) {
  return createProtectedSubject({
    id: subjectId,
    tenantId,
    displayRef: 'subject-ref-0001',
    jurisdiction,
    isMinor: false,
    status: 'ACTIVE',
    authority,
    atMs: DAY,
  });
}

function policy() {
  return createJurisdictionPolicy({
    id: 'policy-1',
    tenantId,
    jurisdiction,
    version: 7,
    effectiveFromMs: 0,
    effectiveToMs: null,
    rules: ['CCPA_DELETE'],
    provenance: 'COUNSEL_REVIEWED',
  });
}

function decision() {
  return createPolicyDecision({
    id: 'decision-1',
    tenantId,
    caseId: caseId.value,
    jurisdiction,
    legalBasis: new LegalBasis('CCPA_DELETE', 7),
    channel: 'OFFICIAL_SELF_SERVICE',
    policyVersion: 7,
    reasons: ['consumer-request-right'],
    decidedAtMs: DAY,
  });
}

function recipe(overrides: Record<string, unknown> = {}) {
  return createRemovalRecipe({
    id: new RecipeId('recipe-0001'),
    tenantId,
    sourceId,
    version: 3,
    signature: 'sig:abc',
    channel: 'OFFICIAL_SELF_SERVICE',
    verificationMethod: 'independent-fetch',
    freshnessAtMs: 30 * DAY,
    enabled: true,
    ...overrides,
  });
}

function source(permissionClass: 'WRITE_PERMITTED' | 'WRITE_UNCLEAR' = 'WRITE_PERMITTED') {
  return createSource({
    id: sourceId,
    tenantId,
    name: 'example-registry',
    class: 'REGISTRY',
    jurisdiction,
    permissionClass,
    permissionCheckedAtMs: DAY,
  });
}

function action(overrides: Record<string, unknown> = {}): ExternalAction {
  return createExternalAction({
    id: new ActionId('action-0001'),
    tenantId,
    caseId,
    channel: 'OFFICIAL_SELF_SERVICE',
    idempotencyKey: new IdempotencyKey('case-0001:self_service:v1'),
    attempt: 1,
    status: 'SUBMITTED',
    ambiguous: false,
    submittedAtMs: ctx.nowMs,
    ...overrides,
  });
}

function prepared(): TransitionCommandResult {
  const result = prepareRequest(ctx, {
    caseId: caseId.value,
    from: 'MATCH_CONFIRMED',
    authority: grant(),
    decision: decision(),
    policy: policy(),
    recipe: recipe(),
    source: source(),
    channelOptions: [
      { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: null, unavailableReason: null },
    ],
    exemptionRecorded: false,
    humanGate: null,
  });
  return result;
}

describe('every command emits only declared events (SPEC-001 §6, §7)', () => {
  test('the command→event map is a subset of the canonical event catalogue', () => {
    for (const [command, names] of Object.entries(COMMAND_EVENTS)) {
      assert.ok(names.length > 0, `${command} must emit something`);
      for (const name of names) {
        assert.ok(
          (DOMAIN_EVENT_NAMES as readonly string[]).includes(name),
          `${command} declares undeclared event ${name}`,
        );
      }
    }
  });
});

describe('RegisterSubject and AttachAlias (VG-IDENT-001/002)', () => {
  test('a registered subject emits SubjectRegistered and an audit event', () => {
    const result = registerSubject(ctx, { subject: subject(), grant: grant() });
    assert.deepEqual(
      result.events.map((e) => e.name),
      ['SubjectRegistered'],
    );
    assert.equal(result.audit.action, 'RegisterSubject');
    assert.equal(result.audit.correlationId, 'corr-0001');
    assert.equal(result.isLegitimateOutcome, true);
  });

  test('registration with an expired grant is refused (VG-AUTHZ-001)', () => {
    assert.throws(
      () =>
        registerSubject(ctx, {
          subject: subject(grant({ expiresAtMs: DAY })),
          grant: grant({ expiresAtMs: DAY }),
        }),
      AuthorityExpired,
    );
  });

  test('an ambiguous alias is quarantined, never attached', () => {
    const alias = createAlias({
      id: 'alias-1',
      tenantId,
      subjectId: null,
      valueEncRef: 'enc:alias/1',
      valueHmac: 'hmac-1',
      provenance: 'discovery:source-0001',
      method: 'exact-name',
      addedAtMs: DAY,
    });
    const result = attachAlias(ctx, { alias, ambiguous: true });
    assert.deepEqual(
      result.events.map((e) => e.name),
      ['AliasQuarantined'],
    );
    assert.equal(result.events[0]?.payload['quarantined'], true);
  });
});

describe('RecordSourceRecord and AssessMatch (T1, T3, T4)', () => {
  test('T1 requires a permitted read path', () => {
    const record = createSourceRecord({
      id: 'record-1',
      tenantId,
      sourceId,
      rawRef: 'https://example.invalid/profile/1',
      observedAtMs: DAY,
      contentHash: digest,
      tainted: false,
    });
    const result = recordSourceRecord(ctx, { record, permittedReadPath: true });
    assert.equal(result.transitionId, 'T1');
    assert.equal(result.to, 'DISCOVERED_CANDIDATE');
    assert.throws(
      () => recordSourceRecord(ctx, { record, permittedReadPath: false }),
      Error,
    );
  });

  test('T3 needs a basis and either the threshold or a human approval', () => {
    const base = {
      caseId: caseId.value,
      from: 'DISCOVERED_CANDIDATE' as const,
      matched: true,
      confidenceAtThreshold: false,
      confidenceBasisRecorded: true,
      humanApproved: false,
      disproofRecorded: false,
    };
    assert.throws(() => assessMatch(ctx, base), Error);
    const approved = assessMatch(ctx, { ...base, humanApproved: true });
    assert.equal(approved.to, 'MATCH_CONFIRMED');
    assert.equal(approved.events[0]?.name, 'MatchConfirmed');
  });

  test('T4 records a disproof as VERIFIED_NOT_PRESENT, never as a removal', () => {
    const result = assessMatch(ctx, {
      caseId: caseId.value,
      from: 'DISCOVERED_CANDIDATE',
      matched: false,
      confidenceAtThreshold: false,
      confidenceBasisRecorded: false,
      humanApproved: false,
      disproofRecorded: true,
    });
    assert.equal(result.to, 'VERIFIED_NOT_PRESENT');
    assert.equal(result.events[0]?.name, 'MatchDisproved');
    assert.equal(result.isLegitimateOutcome, true);
  });
});

describe('ResolvePolicy and PrepareRequest (VG-POLICY-001/002, T5, T6, T7)', () => {
  test('a legal basis absent from the policy version in force is refused', () => {
    assert.throws(
      () => assertPolicyInForce(policy(), decision(), ctx.nowMs),
      Error,
    );
    const wrongVersion = createJurisdictionPolicy({
      id: 'policy-2',
      tenantId,
      jurisdiction,
      version: 8,
      effectiveFromMs: 0,
      effectiveToMs: null,
      rules: ['CCPA_DELETE'],
      provenance: 'COUNSEL_REVIEWED',
    });
    assert.throws(() => assertPolicyInForce(wrongVersion, decision(), ctx.nowMs), Error);
    const resolved = resolvePolicy(ctx, { caseId: caseId.value, decision: decision(), policy: policy() });
    assert.deepEqual(
      resolved.events.map((e) => e.name),
      ['PolicyResolved'],
    );
  });

  test('T5 reaches REQUEST_READY only with authority, policy, recipe and channel', () => {
    const result = prepared();
    assert.equal(result.transitionId, 'T5');
    assert.equal(result.to, 'REQUEST_READY');
    assert.equal(result.events[0]?.name, 'RequestReady');
    assert.equal(result.isLegitimateOutcome, false);
  });

  test('a stale recipe cannot reach REQUEST_READY (VG-CHANNEL-003)', () => {
    assert.throws(
      () =>
        prepareRequest(ctx, {
          caseId: caseId.value,
          from: 'MATCH_CONFIRMED',
          authority: grant(),
          decision: decision(),
          policy: policy(),
          recipe: recipe({ freshnessAtMs: DAY }),
          source: source(),
          channelOptions: [
            { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: null, unavailableReason: null },
          ],
          exemptionRecorded: false,
          humanGate: null,
        }),
      InvalidValueObject,
    );
  });

  test('WRITE_UNCLEAR produces NOT_REMOVABLE, never a write (VG-CHANNEL-002)', () => {
    const result = prepareRequest(ctx, {
      caseId: caseId.value,
      from: 'MATCH_CONFIRMED',
      authority: grant(),
      decision: decision(),
      policy: policy(),
      recipe: recipe(),
      source: source('WRITE_UNCLEAR'),
      channelOptions: [
        { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: null, unavailableReason: null },
      ],
      exemptionRecorded: false,
      humanGate: null,
    });
    assert.equal(result.to, 'NOT_REMOVABLE');
    assert.equal(result.events[0]?.name, 'NotRemovable');
    assert.equal(result.isLegitimateOutcome, true);
  });

  test('a human gate produces HUMAN_REQUIRED (T7), not a failure', () => {
    const result = prepareRequest(ctx, {
      caseId: caseId.value,
      from: 'MATCH_CONFIRMED',
      authority: grant(),
      decision: decision(),
      policy: policy(),
      recipe: recipe(),
      source: source(),
      channelOptions: [
        { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: 'GATED', unavailableReason: 'identity' },
      ],
      exemptionRecorded: false,
      humanGate: { gateKind: 'IDENTITY_VERIFICATION', reason: 'self-service requires proof' },
    });
    assert.equal(result.transitionId, 'T7');
    assert.equal(result.to, 'HUMAN_REQUIRED');
    assert.equal(result.isLegitimateOutcome, true);
  });

  test('T18 from REAPPEARED needs fresh authority, policy and recipe', () => {
    const result = prepareRequest(ctx, {
      caseId: caseId.value,
      from: 'REAPPEARED',
      authority: grant(),
      decision: decision(),
      policy: policy(),
      recipe: recipe(),
      source: source(),
      channelOptions: [
        { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: null, unavailableReason: null },
      ],
      exemptionRecorded: false,
      humanGate: null,
    });
    assert.equal(result.transitionId, 'T18');
    assert.equal(result.to, 'REQUEST_READY');
  });
});

describe('ExecuteAction (VG-ACTION-001/002/005, T8, T9)', () => {
  test('T8 submits exactly once and emits ActionSubmitted', () => {
    const result = executeAction(ctx, {
      caseId: caseId.value,
      action: action(),
      existingIdempotencyKeys: [],
      budgetAvailable: true,
      outcome: { kind: 'ACCEPTED', receiptRef: 'receipt-1' },
    }) as TransitionCommandResult;
    assert.equal(result.transitionId, 'T8');
    assert.equal(result.to, 'REQUEST_SUBMITTED');
    assert.deepEqual(
      result.events.map((e) => e.name),
      ['ActionSubmitted'],
    );
    assert.equal(result.to === 'VERIFIED_REMOVED', false);
  });

  test('a replayed key is refused, so one key yields one effect', () => {
    assert.throws(
      () =>
        executeAction(ctx, {
          caseId: caseId.value,
          action: action(),
          existingIdempotencyKeys: ['case-0001:self_service:v1'],
          budgetAvailable: true,
          outcome: { kind: 'ACCEPTED', receiptRef: 'receipt-1' },
        }),
      IdempotencyConflict,
    );
  });

  test('an ambiguous outcome reconciles instead of silently retrying', () => {
    const result = executeAction(ctx, {
      caseId: caseId.value,
      action: action({ status: 'AMBIGUOUS', ambiguous: true }),
      existingIdempotencyKeys: [],
      budgetAvailable: true,
      outcome: { kind: 'AMBIGUOUS', detail: 'timeout after send' },
    }) as TransitionCommandResult;
    assert.deepEqual(
      result.events.map((e) => e.name),
      ['ActionSubmitted', 'ActionAmbiguous'],
    );
  });

  test('an exhausted budget refuses the write and emits BudgetExceeded', () => {
    const result = executeAction(ctx, {
      caseId: caseId.value,
      action: action(),
      existingIdempotencyKeys: [],
      budgetAvailable: false,
      outcome: { kind: 'ACCEPTED', receiptRef: 'receipt-1' },
    }) as RefusalResult;
    assert.equal(result.refused, true);
    assert.equal(result.currentTruthState, 'REQUEST_READY');
    assert.deepEqual(
      result.events.map((e) => e.name),
      ['BudgetExceeded'],
    );
  });
});

describe('RecordControllerResponse and RecordVerification (T11, T14, VG-VERIFY-004)', () => {
  test('T11 acknowledges a claim and never asserts removal', () => {
    const response = createControllerResponse({
      id: 'response-1',
      tenantId,
      caseId,
      kind: 'EMAIL',
      bodyRef: 'enc:body/1',
      receivedAtMs: ctx.nowMs,
      claimedOutcome: 'VERIFIED_REMOVED',
    });
    const result = recordControllerResponse(ctx, {
      caseId: caseId.value,
      from: 'REQUEST_SUBMITTED',
      response,
      outcome: 'ACKNOWLEDGED',
      lawfulRefusalFinal: false,
    });
    assert.equal(result.to, 'ACKNOWLEDGED');
    assert.equal(result.to === 'VERIFIED_REMOVED', false);
    assert.equal(result.isLegitimateOutcome, false);
  });

  test('T14 requires independence, the window, the method and absence', () => {
    const observation = createVerificationObservation({
      id: 'observation-1',
      tenantId,
      caseId,
      method: 'independent-fetch',
      observedAtMs: 6 * DAY,
      actorIdentity: 'observer-a',
      actingIdentity: 'actor-a',
      finding: 'ABSENT',
      evidenceId: new EvidenceId('evidence-1'),
    });
    const base = {
      caseId: caseId.value,
      from: 'ACKNOWLEDGED' as const,
      observation,
      window: new ObservationWindow(DAY, 'independent-fetch'),
      actionAtMs: 5 * DAY,
      recipeVerificationMethod: 'independent-fetch',
      recordAbsent: true,
    };
    const verified = recordVerification(ctx, base) as TransitionCommandResult;
    assert.equal(verified.transitionId, 'T14');
    assert.equal(verified.to, 'VERIFIED_REMOVED');
    assert.equal(verified.isLegitimateOutcome, true);

    const tooEarly = recordVerification(ctx, { ...base, actionAtMs: 6 * DAY - 1 }) as RefusalResult;
    assert.equal(tooEarly.refused, true);
    assert.equal(tooEarly.currentTruthState, 'ACKNOWLEDGED');
    assert.deepEqual(
      tooEarly.events.map((e) => e.name),
      ['VerificationFailed'],
    );

    const wrongMethod = recordVerification(ctx, {
      ...base,
      recipeVerificationMethod: 'source-api',
    }) as RefusalResult;
    assert.equal(wrongMethod.refused, true);
  });

  test('a controller claim cannot verify anything', () => {
    const claim = createControllerResponse({
      id: 'response-2',
      tenantId,
      caseId,
      kind: 'EMAIL',
      bodyRef: 'enc:body/2',
      receivedAtMs: ctx.nowMs,
      claimedOutcome: 'VERIFIED_REMOVED',
    });
    // The verifying command accepts only a VerificationObservation, so a claim is not
    // even representable as verification input.
    assert.throws(
      () =>
        recordVerification(ctx, {
          caseId: caseId.value,
          from: 'ACKNOWLEDGED',
          observation: claim as never,
          window: new ObservationWindow(DAY, 'independent-fetch'),
          actionAtMs: 0,
          recipeVerificationMethod: 'independent-fetch',
          recordAbsent: true,
        }),
      Error,
    );
  });
});

describe('DetectReappearance and RequestHumanGate (T17, T20, HUMAN_REQUIRED)', () => {
  test('T17 links a reappearance to the prior removal event', () => {
    const result = detectReappearance(ctx, {
      caseId: caseId.value,
      from: 'VERIFIED_REMOVED',
      priorRemovedEventId: 'VerifiedRemoved:corr-0001:432000000',
      recordPresentAgain: true,
    });
    assert.equal(result.transitionId, 'T17');
    assert.equal(result.to, 'REAPPEARED');
    assert.equal(result.events[0]?.payload['priorRemovedEventId'], 'VerifiedRemoved:corr-0001:432000000');
  });

  test('T20 treats a returning search result as REAPPEARED, not as source removal', () => {
    const result = detectReappearance(ctx, {
      caseId: caseId.value,
      from: 'SEARCH_DELISTED',
      priorRemovedEventId: 'VerifiedRemoved:corr-0001:432000000',
      recordPresentAgain: true,
    });
    assert.equal(result.transitionId, 'T20');
    assert.equal(result.to, 'REAPPEARED');
  });

  test('a human gate is raised from every state that permits it', () => {
    for (const from of ['MATCH_CONFIRMED', 'REQUEST_READY', 'REQUEST_SUBMITTED', 'ACKNOWLEDGED'] as const) {
      const result = requestHumanGate(ctx, {
        caseId: caseId.value,
        from,
        gateKind: 'IDENTITY_VERIFICATION',
        reason: 'human step required',
      });
      assert.equal(result.to, 'HUMAN_REQUIRED');
      assert.equal(result.isLegitimateOutcome, true);
    }
    assert.throws(
      () =>
        requestHumanGate(ctx, {
          caseId: caseId.value,
          from: 'VERIFIED_NOT_PRESENT',
          gateKind: 'IDENTITY_VERIFICATION',
          reason: 'not permitted from a terminal-for-now state',
        }),
      IllegalTransition,
    );
  });
});

describe('command results are auditable facts (SM-2)', () => {
  test('every command result carries an audit event with the correlation id', () => {
    const results: CommandResult[] = [
      registerSubject(ctx, { subject: subject(), grant: grant() }),
      prepared(),
      detectReappearance(ctx, {
        caseId: caseId.value,
        from: 'VERIFIED_REMOVED',
        priorRemovedEventId: 'audit-1',
        recordPresentAgain: true,
      }),
    ];
    for (const result of results) {
      assert.equal(result.audit.correlationId, ctx.correlationId);
      assert.equal(result.audit.tenantId.value, tenantId.value);
      assert.ok(result.audit.id.length > 0);
      assert.equal(createAuditEvent({ ...result.audit }).action, result.audit.action);
    }
  });
});
```

FILE: .agent/verification/EXPECTED_TEST_MANIFEST.txt   (MODIFY — append if absent)
```
tests/domain/commands.test.ts
```

RUN:

```sh
sh scripts/typecheck.sh
sh scripts/test-unit.sh
sh scripts/test-collection-guard.sh
```

EXPECT: `typecheck: ok`; `test-unit: ok` with zero failures, zero skipped, and a passing
count strictly greater than M4's; `test collection guard: ok` with `filesSeen` increased by
one.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-002 MILESTONE_PASS "M5 eleven domain commands; one transition each; test-unit: ok"`

FALLBACK: if a command cannot resolve a transition from the legal table for a legitimate
input (the T21 gap above is the known case), do not add an unlisted transition: emit the
audit event, return a `RefusalResult` naming the gap, and record it in the ledger and
`tests/domain/DOMAIN_TEST_MAP.csv` as `SPEC_GAP`. Inventing a transition would break the
closed-table property that every other guarantee depends on.

COMMIT: `git add -A && git commit -m "[EP-002][M5] domain commands with guarded transitions"`

### M6: Invariants SM-1…SM-6 and every documented illegal transition

GOAL: SM-1…SM-6 exist as reusable assertions, and all ten rows of SPEC-001 §4.2 are proven
refused with a typed error while state stays unchanged.

READ: `.agent/specs/SPEC-001-core-domain.md` §4.2 and §4.3,
`src/domain/state-machine.ts`, `src/domain/truth-state.ts`, `src/domain/entities.ts`,
`src/domain/commands.ts`, `tests/domain/state-machine.test.ts` (the existing SM assertions
must keep passing unchanged).

CHANGE: `src/domain/invariants.ts` (create); `tests/domain/invariants.test.ts` (create);
`tests/domain/illegal-transitions.test.ts` (create);
`.agent/verification/EXPECTED_TEST_MANIFEST.txt` (append both suites);
`tests/domain/DOMAIN_TEST_MAP.csv` (append rows).

CONTENT:

FILE: src/domain/invariants.ts   (CREATE)
```ts
/**
 * State-machine invariants SM-1…SM-6 (SPEC-001 §4.3) and the cross-entity rules that are
 * not expressible as a single value-object or entity check.
 *
 * These are the assertions the application and adapter layers call. Keeping them here —
 * rather than inline in handlers — is what stops a later layer from re-deriving a
 * weakened version of the same rule.
 */

import {
  BudgetExceeded,
  EgressDenied,
  GuardNotSatisfied,
  HumanGateRequired,
  IdempotencyConflict,
  IllegalTransition,
  ObservationNotIndependent,
  ObservationWindowNotMet,
  PolicyUnresolved,
  TaintedContentRejected,
  VerificationMethodMismatch,
} from './errors.ts';
import {
  assertAuthorityUsableAt,
  assertRecipeUsableAt,
  sourceMayBeWritten,
  type AuthorityGrant,
  type ControllerResponse,
  type Exposure,
  type PolicyDecision,
  type ProtectedSubject,
  type RemovalRecipe,
  type Source,
  type SourceRecord,
  type VerificationObservation,
} from './entities.ts';
import { TRUTH_STATE_FACTS, type TransitionFacts, type TransitionId, type TruthState } from './truth-state.ts';
import { legalTransitionsFrom } from './state-machine.ts';
import {
  requiresExplicitPolicy,
  type EgressClass,
  type ObservationWindow,
} from './values.ts';

/** SM-1: exactly one current truth state per exposure at any time. */
export function assertSingleCurrentTruthState(states: readonly TruthState[]): void {
  if (states.length !== 1) {
    throw new IllegalTransition(
      states.join('|') || '(none)',
      '(single)',
      `SM-1 violated: expected exactly one current truth state, got ${states.length}`,
    );
  }
}

/** SM-2: every transition appends an audit event. */
export function assertAuditAppended(auditEventIds: readonly string[], transitionId: TransitionId): void {
  if (auditEventIds.length === 0) {
    throw new IllegalTransition('(none)', transitionId, 'SM-2 violated: transition without an audit event');
  }
}

/** SM-3: every transition carries the evidence named in SPEC-001 §4.1. */
export function assertTransitionEvidence(
  transitionId: TransitionId,
  declaredEvidence: string,
  producedEvidenceRefs: readonly string[],
): void {
  if (producedEvidenceRefs.length === 0) {
    throw new GuardNotSatisfied(
      transitionId,
      `SM-3 violated: ${transitionId} requires the evidence "${declaredEvidence}"`,
    );
  }
}

/** SM-4: terminal-for-now states remain re-observable. */
export function assertReobservable(state: TruthState): void {
  const facts = TRUTH_STATE_FACTS[state];
  if (facts.terminalForNow && legalTransitionsFrom(state).length === 0) {
    throw new IllegalTransition(
      state,
      '(re-observation)',
      'SM-4 violated: a terminal-for-now state must remain re-observable',
    );
  }
}

/**
 * SM-5: HUMAN_REQUIRED is not a failure and must not decrement success metrics
 * (VG-OBS-002). Returns the classification the metrics layer must use.
 */
export function classifyTruthState(state: TruthState): 'OUTCOME' | 'PROGRESS' | 'IN_FLIGHT' {
  const facts = TRUTH_STATE_FACTS[state];
  if (facts.assertsVerifiedRemoval || facts.assertsSearchDelisting) return 'OUTCOME';
  if (facts.isLegitimateOutcome) return 'OUTCOME';
  if (facts.neverCountsAsProgress) return 'IN_FLIGHT';
  return 'PROGRESS';
}

/** SM-6: only a domain command may transition state. */
export function assertStateChangedByCommand(source: string): void {
  if (source !== 'domain-command') {
    throw new IllegalTransition(
      '(direct)',
      '(any)',
      `SM-6 violated: truth state may only change through a domain command, not through ${source}`,
    );
  }
}

/** VG-IDENT-001: a subject needs at least one valid grant. */
export function assertSubjectHasAuthority(
  subject: ProtectedSubject,
  grants: readonly AuthorityGrant[],
  atMs: number,
): void {
  const usable = grants.filter(
    (grant) => grant.subjectId.value === subject.id.value && isAuthorityUsableAt(grant, atMs),
  );
  if (usable.length === 0) {
    throw new GuardNotSatisfied('VG-IDENT-001', 'ProtectedSubject requires a valid AuthorityGrant');
  }
}

export function isAuthorityUsableAt(grant: AuthorityGrant, atMs: number): boolean {
  try {
    assertAuthorityUsableAt(grant, atMs);
    return true;
  } catch {
    return false;
  }
}

/** VG-POLICY-002: all four fields before a case may pass REQUEST_READY. */
export function assertPolicyDecisionComplete(decision: PolicyDecision): void {
  if (!decision.jurisdiction || !decision.legalBasis || !decision.channel) {
    throw new PolicyUnresolved('jurisdiction, legalBasis or channel');
  }
  if (!Number.isInteger(decision.policyVersion) || decision.policyVersion < 1) {
    throw new PolicyUnresolved('policyVersion');
  }
}

/** VG-CHANNEL-002 + VG-CHANNEL-003: writability of a source and a recipe together. */
export function assertChannelMayWrite(source: Source, recipe: RemovalRecipe, atMs: number): void {
  if (!sourceMayBeWritten(source)) {
    throw new GuardNotSatisfied(
      'VG-CHANNEL-002',
      `Source ${source.id.value} permission class ${source.permissionClass} forbids automated writes`,
    );
  }
  assertRecipeUsableAt(recipe, atMs);
}

/** VG-SEC-001: tainted content cannot direct an action. */
export function assertContentMayDirectAction(record: SourceRecord, action: string): void {
  if (record.tainted) {
    throw new TaintedContentRejected(`${action} requested by tainted SourceRecord ${record.id}`);
  }
}

/** VG-VERIFY-001: the acting path cannot verify itself. */
export function assertIndependentObservation(observation: VerificationObservation): void {
  if (observation.actorIdentity === observation.actingIdentity) {
    throw new ObservationNotIndependent(observation.actingIdentity);
  }
}

/** VG-VERIFY-002: the required window must genuinely elapse. */
export function assertObservationWindowMet(
  window: ObservationWindow,
  observedAtMs: number,
  actionAtMs: number,
): void {
  if (!window.hasElapsed(observedAtMs, actionAtMs)) {
    throw new ObservationWindowNotMet(window.durationMs, observedAtMs - actionAtMs);
  }
}

/** VG-VERIFY-003: the observation must use the recipe's declared method. */
export function assertVerificationMethodMatches(
  recipe: RemovalRecipe,
  observation: VerificationObservation,
): void {
  if (recipe.verificationMethod !== observation.method) {
    throw new VerificationMethodMismatch(recipe.verificationMethod, observation.method);
  }
}

/**
 * VG-VERIFY-004: a controller claim is not an observation and can never satisfy a
 * removal. This function exists so that calling code has an explicit, named refusal
 * rather than an implicit assumption.
 */
export function assertNotControllerClaim(response: ControllerResponse): never {
  throw new GuardNotSatisfied(
    'VG-VERIFY-004',
    `ControllerResponse ${response.id} is a claim, not a VerificationObservation`,
  );
}

/** VG-POLICY-004: a minor subject cannot enter an automated write lane. */
export function assertWriteLaneAllowedForSubject(subject: ProtectedSubject): void {
  if (subject.isMinor) {
    throw new HumanGateRequired(
      'minor subject requires review-required handling (VG-POLICY-004)',
      'MINOR_REVIEW_LANE',
    );
  }
}

/** VG-EGRESS-001: deny-by-default egress for protected classes. */
export function assertEgressAllowed(egressClass: EgressClass, tenantPolicyAllows: boolean, destination: string): void {
  if (requiresExplicitPolicy(egressClass) && !tenantPolicyAllows) {
    throw new EgressDenied(egressClass, destination);
  }
}

/** VG-ACTION-005: effect budgets bound volume per subject, source and window. */
export function assertEffectBudget(scope: string, used: number, limit: number): void {
  if (used >= limit) {
    throw new BudgetExceeded(scope, limit);
  }
}

/** VG-ACTION-001: one key, one external effect. */
export function assertIdempotencyKeyUnused(key: string, existingKeys: readonly string[]): void {
  if (existingKeys.includes(key)) {
    throw new IdempotencyConflict(key, '(existing ExternalAction)');
  }
}

/** SM-3 helper: the evidence named by a transition must be present in the fact set. */
export function assertFactsCarryEvidence(facts: TransitionFacts, transitionId: TransitionId): void {
  const anyFact = Object.values(facts).some((value) => value === true);
  if (!anyFact) {
    throw new GuardNotSatisfied(
      transitionId,
      'SM-3 violated: no evidence-bearing fact is present for this transition',
    );
  }
}
```

FILE: tests/domain/invariants.test.ts   (CREATE)
```ts
/**
 * Invariant tests (SPEC-001 §4.3 and the cross-entity rules).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAuditAppended,
  assertChannelMayWrite,
  assertContentMayDirectAction,
  assertEffectBudget,
  assertEgressAllowed,
  assertFactsCarryEvidence,
  assertIdempotencyKeyUnused,
  assertIndependentObservation,
  assertNotControllerClaim,
  assertObservationWindowMet,
  assertPolicyDecisionComplete,
  assertReobservable,
  assertSingleCurrentTruthState,
  assertStateChangedByCommand,
  assertSubjectHasAuthority,
  assertTransitionEvidence,
  assertVerificationMethodMatches,
  assertWriteLaneAllowedForSubject,
  classifyTruthState,
  isAuthorityUsableAt,
} from '../../src/domain/invariants.ts';
import {
  createAuthorityGrant,
  createControllerResponse,
  createPolicyDecision,
  createProtectedSubject,
  createRemovalRecipe,
  createSource,
  createSourceRecord,
  createVerificationObservation,
} from '../../src/domain/entities.ts';
import {
  CaseId,
  EvidenceId,
  RecipeId,
  SourceId,
  SubjectId,
  TenantId,
} from '../../src/domain/identifiers.ts';
import {
  EvidenceDigest,
  Jurisdiction,
  LegalBasis,
  ObservationWindow,
} from '../../src/domain/values.ts';
import { noFacts } from '../../src/domain/state-machine.ts';
import {
  BudgetExceeded,
  EgressDenied,
  GuardNotSatisfied,
  HumanGateRequired,
  IdempotencyConflict,
  IllegalTransition,
  ObservationNotIndependent,
  ObservationWindowNotMet,
  PolicyUnresolved,
  TaintedContentRejected,
  VerificationMethodMismatch,
} from '../../src/domain/errors.ts';

const tenantId = new TenantId('tenant-0001');
const subjectId = new SubjectId('subject-0001');
const caseId = new CaseId('case-0001');
const sourceId = new SourceId('source-0001');
const digest = new EvidenceDigest('c'.repeat(64));
const jurisdiction = new Jurisdiction('US-CA');
const DAY = 86_400_000;

function grant(overrides: Record<string, unknown> = {}) {
  return createAuthorityGrant({
    id: 'grant-0001',
    tenantId,
    subjectId,
    kind: 'SELF',
    scope: ['self_service_write'],
    evidenceId: null,
    issuedAtMs: 0,
    expiresAtMs: 100 * DAY,
    revokedAtMs: null,
    signedInstrument: false,
    ...overrides,
  });
}

function recipe(overrides: Record<string, unknown> = {}) {
  return createRemovalRecipe({
    id: new RecipeId('recipe-0001'),
    tenantId,
    sourceId,
    version: 1,
    signature: 'sig:abc',
    channel: 'OFFICIAL_SELF_SERVICE',
    verificationMethod: 'independent-fetch',
    freshnessAtMs: 30 * DAY,
    enabled: true,
    ...overrides,
  });
}

function source(permissionClass: 'WRITE_PERMITTED' | 'WRITE_UNCLEAR') {
  return createSource({
    id: sourceId,
    tenantId,
    name: 'example-registry',
    class: 'REGISTRY',
    jurisdiction,
    permissionClass,
    permissionCheckedAtMs: DAY,
  });
}

function observation(overrides: Record<string, unknown> = {}) {
  return createVerificationObservation({
    id: 'observation-1',
    tenantId,
    caseId,
    method: 'independent-fetch',
    observedAtMs: 2 * DAY,
    actorIdentity: 'observer-a',
    actingIdentity: 'actor-a',
    finding: 'ABSENT',
    evidenceId: new EvidenceId('evidence-1'),
    ...overrides,
  });
}

describe('SM-1 .. SM-6 (SPEC-001 §4.3)', () => {
  test('SM-1: exactly one current truth state', () => {
    assert.equal(assertSingleCurrentTruthState(['REQUEST_READY']), undefined);
    assert.throws(() => assertSingleCurrentTruthState([]), IllegalTransition);
    assert.throws(
      () => assertSingleCurrentTruthState(['REQUEST_READY', 'VERIFIED_REMOVED']),
      IllegalTransition,
    );
  });

  test('SM-2: a transition without an audit event is refused', () => {
    assert.equal(assertAuditAppended(['audit-1'], 'T8'), undefined);
    assert.throws(() => assertAuditAppended([], 'T8'), IllegalTransition);
  });

  test('SM-3: a transition without its evidence is refused', () => {
    assert.equal(assertTransitionEvidence('T14', 'VerificationObservation', ['evidence-1']), undefined);
    assert.throws(
      () => assertTransitionEvidence('T14', 'VerificationObservation', []),
      GuardNotSatisfied,
    );
    assert.throws(() => assertFactsCarryEvidence(noFacts(), 'T8'), GuardNotSatisfied);
    assert.equal(assertFactsCarryEvidence(noFacts({ recordAbsent: true }), 'T14'), undefined);
  });

  test('SM-4: terminal-for-now states stay re-observable', () => {
    for (const state of ['VERIFIED_REMOVED', 'VERIFIED_NOT_PRESENT', 'NOT_REMOVABLE'] as const) {
      assert.equal(assertReobservable(state), undefined);
    }
  });

  test('SM-5: HUMAN_REQUIRED and NOT_REMOVABLE are outcomes, never failures', () => {
    assert.equal(classifyTruthState('HUMAN_REQUIRED'), 'OUTCOME');
    assert.equal(classifyTruthState('NOT_REMOVABLE'), 'OUTCOME');
    assert.equal(classifyTruthState('VERIFIED_REMOVED'), 'OUTCOME');
    assert.equal(classifyTruthState('REQUEST_SUBMITTED'), 'IN_FLIGHT');
    assert.equal(classifyTruthState('ACKNOWLEDGED'), 'IN_FLIGHT');
    assert.equal(classifyTruthState('REQUEST_READY'), 'PROGRESS');
  });

  test('SM-6: only a domain command may change state', () => {
    assert.equal(assertStateChangedByCommand('domain-command'), undefined);
    for (const source of ['http-handler', 'adapter', 'model-output']) {
      assert.throws(() => assertStateChangedByCommand(source), IllegalTransition);
    }
  });
});

describe('authority, subject and channel rules', () => {
  test('VG-IDENT-001: a subject with no usable grant is refused', () => {
    const subject = createProtectedSubject({
      id: subjectId,
      tenantId,
      displayRef: 'subject-ref-0001',
      jurisdiction,
      isMinor: false,
      status: 'ACTIVE',
      authority: grant(),
      atMs: DAY,
    });
    assert.equal(assertSubjectHasAuthority(subject, [grant()], DAY), undefined);
    assert.throws(() => assertSubjectHasAuthority(subject, [], DAY), GuardNotSatisfied);
    assert.throws(
      () => assertSubjectHasAuthority(subject, [grant({ expiresAtMs: DAY })], 2 * DAY),
      GuardNotSatisfied,
    );
    assert.equal(isAuthorityUsableAt(grant(), DAY), true);
    assert.equal(isAuthorityUsableAt(grant({ revokedAtMs: DAY }), 2 * DAY), false);
  });

  test('VG-POLICY-002: an incomplete decision is refused', () => {
    const complete = createPolicyDecision({
      id: 'decision-1',
      tenantId,
      caseId: caseId.value,
      jurisdiction,
      legalBasis: new LegalBasis('CCPA_DELETE', 1),
      channel: 'OFFICIAL_SELF_SERVICE',
      policyVersion: 1,
      reasons: [],
      decidedAtMs: DAY,
    });
    assert.equal(assertPolicyDecisionComplete(complete), undefined);
    assert.throws(
      () => assertPolicyDecisionComplete({ ...complete, policyVersion: 0 }),
      PolicyUnresolved,
    );
  });

  test('VG-CHANNEL-002/003: unclear permission or stale recipe cannot write', () => {
    assert.equal(assertChannelMayWrite(source('WRITE_PERMITTED'), recipe(), DAY), undefined);
    assert.throws(
      () => assertChannelMayWrite(source('WRITE_UNCLEAR'), recipe(), DAY),
      GuardNotSatisfied,
    );
    assert.throws(
      () => assertChannelMayWrite(source('WRITE_PERMITTED'), recipe({ freshnessAtMs: DAY }), 2 * DAY),
      Error,
    );
  });

  test('VG-SEC-001: tainted content cannot direct an action', () => {
    const tainted = createSourceRecord({
      id: 'record-1',
      tenantId,
      sourceId,
      rawRef: 'https://example.invalid/1',
      observedAtMs: DAY,
      contentHash: digest,
      tainted: true,
    });
    assert.throws(() => assertContentMayDirectAction(tainted, 'an external write'), TaintedContentRejected);
    assert.equal(assertContentMayDirectAction({ ...tainted, tainted: false }, 'a read'), undefined);
  });

  test('VG-POLICY-004: a minor subject is routed to review', () => {
    const minor = createProtectedSubject({
      id: subjectId,
      tenantId,
      displayRef: 'subject-ref-0002',
      jurisdiction,
      isMinor: true,
      status: 'ACTIVE',
      authority: grant(),
      atMs: DAY,
    });
    assert.throws(() => assertWriteLaneAllowedForSubject(minor), HumanGateRequired);
  });
});

describe('verification, egress, budget and idempotency rules', () => {
  test('VG-VERIFY-001/002/003: independence, window and method are all required', () => {
    assert.equal(assertIndependentObservation(observation()), undefined);
    // The entity factory refuses self-verification at construction, so the invariant is
    // asserted against a structurally identical record to prove the assertion itself.
    assert.throws(
      () => assertIndependentObservation({ ...observation(), actingIdentity: 'observer-a' }),
      ObservationNotIndependent,
    );

    const window = new ObservationWindow(DAY, 'independent-fetch');
    assert.equal(assertObservationWindowMet(window, 2 * DAY, DAY), undefined);
    assert.throws(
      () => assertObservationWindowMet(window, DAY + 1, DAY),
      ObservationWindowNotMet,
    );

    assert.equal(assertVerificationMethodMatches(recipe(), observation()), undefined);
    assert.throws(
      () => assertVerificationMethodMatches(recipe(), observation({ method: 'source-api' })),
      VerificationMethodMismatch,
    );
  });

  test('VG-VERIFY-004: a controller claim is not an observation', () => {
    const claim = createControllerResponse({
      id: 'response-1',
      tenantId,
      caseId,
      kind: 'EMAIL',
      bodyRef: 'enc:body/1',
      receivedAtMs: DAY,
      claimedOutcome: 'VERIFIED_REMOVED',
    });
    assert.throws(() => assertNotControllerClaim(claim), GuardNotSatisfied);
  });

  test('VG-EGRESS-001: protected classes are denied without an explicit policy', () => {
    assert.throws(
      () => assertEgressAllowed('CUSTOMER_PII', false, 'telemetry'),
      EgressDenied,
    );
    assert.equal(assertEgressAllowed('CUSTOMER_PII', true, 'telemetry'), undefined);
    assert.equal(assertEgressAllowed('OPAQUE_ID', false, 'telemetry'), undefined);
  });

  test('VG-ACTION-005 and VG-ACTION-001: budget and key rules', () => {
    assert.equal(assertEffectBudget('subject-0001/source-0001/30d', 2, 5), undefined);
    assert.throws(() => assertEffectBudget('subject-0001/source-0001/30d', 5, 5), BudgetExceeded);
    assert.equal(assertIdempotencyKeyUnused('k1', ['k2']), undefined);
    assert.throws(() => assertIdempotencyKeyUnused('k1', ['k1']), IdempotencyConflict);
  });
});
```

FILE: tests/domain/illegal-transitions.test.ts   (CREATE)
```ts
/**
 * Every documented illegal transition (SPEC-001 §4.2) is refused with a typed error, and
 * state is left unchanged.
 *
 * The first six rows are the documented forbidden pairs; the remaining rows are the
 * conditional rules the spec lists in the same table (no observation, the acting path
 * verifying itself, expired authority, stale recipe).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyTransition, noFacts, happyPathFacts } from '../../src/domain/state-machine.ts';
import type { TruthState } from '../../src/domain/truth-state.ts';
import { prepareRequest } from '../../src/domain/commands.ts';
import {
  createAuthorityGrant,
  createJurisdictionPolicy,
  createPolicyDecision,
  createRemovalRecipe,
  createSource,
  createVerificationObservation,
} from '../../src/domain/entities.ts';
import { CaseId, EvidenceId, RecipeId, SourceId, SubjectId, TenantId } from '../../src/domain/identifiers.ts';
import { Jurisdiction, LegalBasis } from '../../src/domain/values.ts';
import {
  AuthorityExpired,
  IllegalTransition,
  InvalidValueObject,
  ObservationNotIndependent,
} from '../../src/domain/errors.ts';

const tenantId = new TenantId('tenant-0001');
const subjectId = new SubjectId('subject-0001');
const caseId = new CaseId('case-0001');
const sourceId = new SourceId('source-0001');
const jurisdiction = new Jurisdiction('US-CA');
const DAY = 86_400_000;
const ctx = { tenantId, correlationId: 'corr-1', nowMs: 5 * DAY };

/** Apply a transition to a mutable state holder so "state unchanged" is observable. */
function attempt(state: { current: TruthState }, to: TruthState, facts = happyPathFacts()) {
  try {
    const result = applyTransition(state.current, to, facts);
    state.current = result.to;
    return result;
  } catch (error) {
    return error as Error;
  }
}

describe('SPEC-001 §4.2 — documented forbidden pairs', () => {
  const forbiddenPairs: readonly (readonly [TruthState, TruthState, string])[] = [
    ['REQUEST_SUBMITTED', 'VERIFIED_REMOVED', 'removal theater'],
    ['REQUEST_READY', 'VERIFIED_REMOVED', 'no action was taken'],
    ['MATCH_CONFIRMED', 'REQUEST_SUBMITTED', 'skips the authority and policy gate'],
    ['DISCOVERED_CANDIDATE', 'REQUEST_READY', 'skips identity confirmation'],
    ['SEARCH_DELISTED', 'VERIFIED_REMOVED', 'collapses search and source effects'],
    ['VERIFIED_NOT_PRESENT', 'VERIFIED_REMOVED', 'nothing was removed'],
  ];

  for (const [from, to, why] of forbiddenPairs) {
    test(`${from} -> ${to} is refused (${why}) and leaves state unchanged`, () => {
      const state = { current: from };
      const result = attempt(state, to);
      assert.ok(result instanceof IllegalTransition, `expected IllegalTransition, got ${String(result)}`);
      assert.equal(state.current, from, 'state must be unchanged after a refusal');
    });
  }

  test('every forbidden pair is in the documented forbidden table', () => {
    // The state machine checks forbidden pairs before the legal table, so the reason
    // names the real danger rather than a generic "no such transition".
    const state = { current: 'REQUEST_SUBMITTED' as TruthState };
    const error = attempt(state, 'VERIFIED_REMOVED') as IllegalTransition;
    assert.match(error.message, /removal theater/);
    assert.equal(error.code, 'ILLEGAL_TRANSITION');
  });
});

describe('SPEC-001 §4.2 — conditional rules', () => {
  test('ACKNOWLEDGED -> VERIFIED_REMOVED without an independent observation is refused', () => {
    const state = { current: 'ACKNOWLEDGED' as TruthState };
    const error = attempt(state, 'VERIFIED_REMOVED', happyPathFacts({ independentObservation: false }));
    assert.ok(error instanceof ObservationNotIndependent);
    assert.equal(state.current, 'ACKNOWLEDGED');
  });

  test('the acting path cannot verify its own effect (VG-VERIFY-001)', () => {
    const observation = createVerificationObservation({
      id: 'observation-1',
      tenantId,
      caseId,
      method: 'independent-fetch',
      observedAtMs: 6 * DAY,
      actorIdentity: 'observer-a',
      actingIdentity: 'actor-a',
      finding: 'ABSENT',
      evidenceId: new EvidenceId('evidence-1'),
    });
    assert.equal(observation.actorIdentity === observation.actingIdentity, false);
    // The factory refuses self-verification outright...
    assert.throws(
      () =>
        createVerificationObservation({
          ...observation,
          actorIdentity: 'actor-a',
          actingIdentity: 'actor-a',
        }),
      InvalidValueObject,
    );
    // ...and the machine refuses the transition when independence is missing.
    const state = { current: 'ACKNOWLEDGED' as TruthState };
    const error = attempt(
      state,
      'VERIFIED_REMOVED',
      happyPathFacts({ independentObservation: false }),
    );
    assert.ok(error instanceof ObservationNotIndependent);
    assert.equal(state.current, 'ACKNOWLEDGED');
  });

  test('no transition is permitted while authority is expired or revoked (VG-AUTHZ-001)', () => {
    const expired = createAuthorityGrant({
      id: 'grant-expired',
      tenantId,
      subjectId,
      kind: 'SELF',
      scope: ['self_service_write'],
      evidenceId: null,
      issuedAtMs: 0,
      expiresAtMs: DAY,
      revokedAtMs: null,
      signedInstrument: false,
    });
    const policy = createJurisdictionPolicy({
      id: 'policy-1',
      tenantId,
      jurisdiction,
      version: 1,
      effectiveFromMs: 0,
      effectiveToMs: null,
      rules: ['CCPA_DELETE'],
      provenance: 'COUNSEL_REVIEWED',
    });
    const decision = createPolicyDecision({
      id: 'decision-1',
      tenantId,
      caseId: caseId.value,
      jurisdiction,
      legalBasis: new LegalBasis('CCPA_DELETE', 1),
      channel: 'OFFICIAL_SELF_SERVICE',
      policyVersion: 1,
      reasons: [],
      decidedAtMs: DAY,
    });
    const recipe = createRemovalRecipe({
      id: new RecipeId('recipe-0001'),
      tenantId,
      sourceId,
      version: 1,
      signature: 'sig:abc',
      channel: 'OFFICIAL_SELF_SERVICE',
      verificationMethod: 'independent-fetch',
      freshnessAtMs: 30 * DAY,
      enabled: true,
    });
    const source = createSource({
      id: sourceId,
      tenantId,
      name: 'example-registry',
      class: 'REGISTRY',
      jurisdiction,
      permissionClass: 'WRITE_PERMITTED',
      permissionCheckedAtMs: DAY,
    });
    const state = { current: 'MATCH_CONFIRMED' as TruthState };
    assert.throws(
      () =>
        prepareRequest(ctx, {
          caseId: caseId.value,
          from: 'MATCH_CONFIRMED',
          authority: expired,
          decision,
          policy,
          recipe,
          source,
          channelOptions: [
            { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: null, unavailableReason: null },
          ],
          exemptionRecorded: false,
          humanGate: null,
        }),
      AuthorityExpired,
    );
    assert.equal(state.current, 'MATCH_CONFIRMED');
  });

  test('no write transition while the recipe is stale or unsigned (VG-CHANNEL-003)', () => {
    const authority = createAuthorityGrant({
      id: 'grant-1',
      tenantId,
      subjectId,
      kind: 'SELF',
      scope: ['self_service_write'],
      evidenceId: null,
      issuedAtMs: 0,
      expiresAtMs: 100 * DAY,
      revokedAtMs: null,
      signedInstrument: false,
    });
    const policy = createJurisdictionPolicy({
      id: 'policy-1',
      tenantId,
      jurisdiction,
      version: 1,
      effectiveFromMs: 0,
      effectiveToMs: null,
      rules: ['CCPA_DELETE'],
      provenance: 'COUNSEL_REVIEWED',
    });
    const decision = createPolicyDecision({
      id: 'decision-1',
      tenantId,
      caseId: caseId.value,
      jurisdiction,
      legalBasis: new LegalBasis('CCPA_DELETE', 1),
      channel: 'OFFICIAL_SELF_SERVICE',
      policyVersion: 1,
      reasons: [],
      decidedAtMs: DAY,
    });
    const source = createSource({
      id: sourceId,
      tenantId,
      name: 'example-registry',
      class: 'REGISTRY',
      jurisdiction,
      permissionClass: 'WRITE_PERMITTED',
      permissionCheckedAtMs: DAY,
    });
    const stale = createRemovalRecipe({
      id: new RecipeId('recipe-0002'),
      tenantId,
      sourceId,
      version: 1,
      signature: 'sig:abc',
      channel: 'OFFICIAL_SELF_SERVICE',
      verificationMethod: 'independent-fetch',
      freshnessAtMs: DAY,
      enabled: true,
    });
    assert.throws(
      () =>
        prepareRequest(ctx, {
          caseId: caseId.value,
          from: 'MATCH_CONFIRMED',
          authority,
          decision,
          policy,
          recipe: stale,
          source,
          channelOptions: [
            { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: null, unavailableReason: null },
          ],
          exemptionRecorded: false,
          humanGate: null,
        }),
      InvalidValueObject,
    );
  });

  test('a write transition cannot be reached from a state that does not permit it', () => {
    const state = { current: 'DISCOVERED_CANDIDATE' as TruthState };
    const error = attempt(state, 'REQUEST_SUBMITTED');
    assert.ok(error instanceof IllegalTransition);
    assert.equal(state.current, 'DISCOVERED_CANDIDATE');
  });

  test('approval wording never substitutes for evidence', () => {
    // "Approved" is not a truth state and must not be assignable.
    const state = { current: 'REQUEST_SUBMITTED' as TruthState };
    const error = attempt(state, 'APPROVED' as TruthState);
    assert.ok(error instanceof IllegalTransition);
    assert.equal(state.current, 'REQUEST_SUBMITTED');
  });

  test('the substantive guards of the illegal table hold in the legal table too', () => {
    // sanity: T14 is legal only with every guard satisfied — the difference between a
    // forbidden pair and a satisfied guard must be observable.
    const ok = applyTransition('ACKNOWLEDGED', 'VERIFIED_REMOVED', happyPathFacts());
    assert.equal(ok.id, 'T14');
    const refused = attempt(
      { current: 'ACKNOWLEDGED' },
      'VERIFIED_REMOVED',
      noFacts({ recordAbsent: true }),
    );
    assert.ok(refused instanceof Error);
  });
});
```

FILE: .agent/verification/EXPECTED_TEST_MANIFEST.txt   (MODIFY — append if absent)
```
tests/domain/invariants.test.ts
tests/domain/illegal-transitions.test.ts
```

RUN:

```sh
sh scripts/typecheck.sh
sh scripts/test-unit.sh
sh scripts/test-collection-guard.sh
```

EXPECT: `typecheck: ok`; `test-unit: ok` with zero failures and zero skipped;
`test collection guard: ok` with `filesSeen` increased by two; the existing
`tests/domain/state-machine.test.ts` assertions unchanged and passing.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-002 MILESTONE_PASS "M6 SM-1..SM-6 and all SPEC-001 4.2 rows; test-unit: ok"`

FALLBACK: if an invariant cannot be asserted without infrastructure (for example the
database-level half of VG-EVIDENCE-003), assert the domain-reachable half here and record
the database half as owned by EP-003 in `tests/domain/DOMAIN_TEST_MAP.csv`; never claim the
unasserted half.

COMMIT: `git add -A && git commit -m "[EP-002][M6] invariants and illegal-transition proofs"`

### M7: Import-boundary test and the DOD-018 mutation check

GOAL: An executable test proves the domain imports only the standard library with its own
negative case, and a real mutation of a guard makes a real test fail and is then restored
byte-identically.

READ: `scripts/import-boundary.sh` (the independent shell implementation),
`ARCHITECTURE.md` (code law), `.agent/DONE_LAW.md` (DOD-018),
`.agent/specs/SPEC-001-core-domain.md` §1 and §8.5/§8.6, `src/domain/values.ts`,
`src/domain/state-machine.ts`, `src/domain/entities.ts`, `src/domain/commands.ts`,
`src/domain/invariants.ts`, `tests/domain/DOMAIN_TEST_MAP.csv`.

CHANGE: `tests/architecture/import-boundary.test.ts` (create);
`scripts/lib/mutations.ts` (create); `scripts/mutation-check.sh` (create);
`tsconfig.json` (extend `include` to `["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"]`
so the mutation harness is typechecked);
`COMMANDS.md` (declare `sh scripts/mutation-check.sh` and its sentinel);
`.agent/verification/EXPECTED_TEST_MANIFEST.txt` (append the architecture suite).

CONTENT:

FILE: tests/architecture/import-boundary.test.ts   (CREATE)
```ts
/**
 * Import-boundary test (SPEC-001 §1, §8.5; ARCHITECTURE.md code law).
 *
 * `scripts/import-boundary.sh` enforces this in `lint`; this test enforces it in the unit
 * suite, from an independent implementation, and proves the checker can fail on a
 * deliberate violation. The negative case is the point: a boundary test that cannot go
 * red proves nothing (DOD-018).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DOMAIN_DIR = join(ROOT, 'src', 'domain');

const IMPORT_PATTERNS = [
  /\bfrom\s+'([^']+)'/g,
  /\bfrom\s+"([^"]+)"/g,
  /\bimport\s+'([^']+)'/g,
  /\bimport\s+"([^"]+)"/g,
];

/** Extract every module specifier from a source string. */
export function moduleSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.add(specifier);
    }
  }
  return [...found];
}

/** A specifier is permitted in the domain layer when it is relative or a node builtin. */
export function isPermittedInDomain(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('node:');
}

export function violationsIn(files: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, source] of files) {
    for (const specifier of moduleSpecifiers(source)) {
      if (!isPermittedInDomain(specifier)) violations.push(`${path}: ${specifier}`);
    }
  }
  return violations;
}

function readDomainFiles(dir: string, prefix = ''): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const relative = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) {
      for (const [path, source] of readDomainFiles(full, relative)) files.set(path, source);
    } else if (entry.endsWith('.ts')) {
      files.set(`src/domain/${relative}`, readFileSync(full, 'utf8'));
    }
  }
  return files;
}

describe('domain import boundary (SPEC-001 §1)', () => {
  test('the domain layer imports only the standard library', () => {
    const files = readDomainFiles(DOMAIN_DIR);
    assert.ok(files.size >= 7, `expected the domain layer to have files, saw ${files.size}`);
    assert.deepEqual(violationsIn(files), []);
  });

  test('the checker detects a real violation (negative case)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-boundary-'));
    try {
      const offending = join(dir, 'offending.ts');
      writeFileSync(offending, "import { z } from 'zod';\nexport const x = z;\n");
      const files = new Map([[offending, readFileSync(offending, 'utf8')]]);
      const violations = violationsIn(files);
      assert.equal(violations.length, 1);
      assert.match(violations[0] ?? '', /zod/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a framework, ORM, HTTP client or model SDK specifier is refused', () => {
    for (const specifier of ['fastify', 'pg', 'undici', '@prisma/client', 'openai', 'zod']) {
      assert.equal(isPermittedInDomain(specifier), false, `${specifier} must be refused`);
    }
    for (const specifier of ['./values.ts', '../domain/values.ts', 'node:crypto', 'node:test']) {
      assert.equal(isPermittedInDomain(specifier), true, `${specifier} must be permitted`);
    }
  });
});
```

FILE: scripts/lib/mutations.ts   (CREATE)
```ts
/**
 * Mutation registry for the DOD-018 check.
 *
 * Each entry is a controlled defect applied to a real source file. The harness requires
 * that at least one real test FAILS while the mutation is present, and that the file is
 * restored byte-identically afterwards. A suite that stays green under a mutation is not
 * observing the behaviour it claims to protect.
 *
 * Anchors are exact source text: if an anchor stops matching, the mutation is reported as
 * a harness ERROR rather than silently skipping the check (DOD-024, DOD-033).
 */

export interface Mutation {
  readonly id: string;
  readonly file: string;
  readonly description: string;
  readonly find: string;
  readonly replace: string;
  readonly testFile: string;
}

export const MUTATIONS: readonly Mutation[] = Object.freeze([
  {
    id: 'MUT-1',
    file: 'src/domain/values.ts',
    description: 'Confidence range check replaced by a tautology',
    find: 'if (value < 0 || value > 1) {',
    replace: 'if (false) {',
    testFile: 'tests/domain/values.test.ts',
  },
  {
    id: 'MUT-2',
    file: 'src/domain/values.ts',
    description: 'Confidence basis requirement removed',
    find: 'if (!Array.isArray(basis) || basis.length === 0) {',
    replace: 'if (false) {',
    testFile: 'tests/domain/values.test.ts',
  },
  {
    id: 'MUT-3',
    file: 'src/domain/truth-state.ts',
    description: 'T14 independence guard weakened to always satisfied',
    find: "independentObservation: { description: 'independent observation', satisfiedBy: (f: TransitionFacts) => f.independentObservation },",
    replace: "independentObservation: { description: 'independent observation', satisfiedBy: () => true },",
    testFile: 'tests/domain/state-machine.test.ts',
  },
  {
    id: 'MUT-4',
    file: 'src/domain/state-machine.ts',
    description: 'forbidden-pair check disabled',
    find: 'const forbidden = forbiddenReason(from, to);\n  if (forbidden !== undefined) {',
    replace: 'const forbidden = forbiddenReason(from, to);\n  if (false && forbidden !== undefined) {',
    testFile: 'tests/domain/state-machine.test.ts',
  },
  {
    id: 'MUT-5',
    file: 'src/domain/entities.ts',
    description: 'self-verification check removed from VerificationObservation',
    find: 'if (input.actorIdentity === input.actingIdentity) {',
    replace: 'if (false) {',
    testFile: 'tests/domain/entities.test.ts',
  },
  {
    id: 'MUT-6',
    file: 'src/domain/commands.ts',
    description: 'idempotency-key replay check disabled',
    find: 'if (input.existingIdempotencyKeys.includes(input.action.idempotencyKey.value)) {',
    replace: 'if (false) {',
    testFile: 'tests/domain/commands.test.ts',
  },
  {
    id: 'MUT-7',
    file: 'src/domain/invariants.ts',
    description: 'observation-window check removed',
    find: 'if (!window.hasElapsed(observedAtMs, actionAtMs)) {',
    replace: 'if (false) {',
    testFile: 'tests/domain/invariants.test.ts',
  },
]);
```

FILE: scripts/mutation-check.sh   (CREATE)
```sh
#!/usr/bin/env sh
# Mutation check (DOD-018). Sentinel: `mutation check: ok`
#
# A permanently green test may not observe the behaviour it claims to protect. This gate
# introduces one controlled defect per critical domain feature, requires a real test to
# fail, restores the file, and requires the suite to go green again.
#
# Restoration is verified by SHA-256, not by assumption: if the digest does not match the
# pre-mutation value, the gate fails loudly and the tree is left for a human to inspect.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

mkdir -p .agent/evidence/mutation

if ! node scripts/lib/mutations.ts 2>&1 | tee .agent/evidence/mutation/run.txt; then
  echo "mutation check: FAIL - the mutation harness reported a failure; see .agent/evidence/mutation/run.txt" >&2
  exit 1
fi

grep -q 'mutations: all detected' .agent/evidence/mutation/run.txt \
  || { echo "mutation check: FAIL - the harness did not report 'mutations: all detected'" >&2; exit 1; }

grep -q 'restore: verified' .agent/evidence/mutation/run.txt \
  || { echo "mutation check: FAIL - restoration was not verified byte-identically" >&2; exit 1; }

if ! git diff --quiet -- src/domain; then
  echo "mutation check: FAIL - src/domain is dirty after the mutation run; a mutation was not restored" >&2
  git --no-pager diff --stat -- src/domain >&2
  exit 1
fi

echo "mutation check: ok"
```

Note: `scripts/lib/mutations.ts` is both a module and a runnable program. Its CLI entry
point (guarded by `import.meta.main`-style detection, implemented as a comparison of
`process.argv[1]` with the module path) applies each mutation, runs the named test file
with `node --test`, requires a non-zero exit, restores the original bytes, verifies the
SHA-256, and finally runs the full suite; it prints `mutations: all detected` and
`restore: verified` on success. Add that runner to the same file, below the registry:

FILE: scripts/lib/mutations.ts   (APPEND the runner to the file above)
```ts
// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function runTests(testFile: string): { status: number | null; output: string } {
  const result = spawnSync('node', ['--test', testFile], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

export function runMutationCheck(): number {
  let failures = 0;
  for (const mutation of MUTATIONS) {
    const original = readFileSync(mutation.file, 'utf8');
    const originalDigest = sha256(original);
    if (!original.includes(mutation.find)) {
      console.error(
        `mutations: ERROR - anchor for ${mutation.id} not found in ${mutation.file}; ` +
          'the mutation must be re-anchored, never skipped (DOD-033)',
      );
      return 1;
    }
    const mutated = original.replace(mutation.find, mutation.replace);
    writeFileSync(mutation.file, mutated);
    let detected = false;
    try {
      const run = runTests(mutation.testFile);
      detected = run.status !== 0;
      console.log(
        `mutations: ${mutation.id} ${detected ? 'DETECTED' : 'MISSED'} - ${mutation.description} ` +
          `(${mutation.testFile} exit ${String(run.status)})`,
      );
      if (!detected) {
        console.error(run.output.split('\n').slice(-20).join('\n'));
      }
    } finally {
      writeFileSync(mutation.file, original);
      if (sha256(readFileSync(mutation.file, 'utf8')) !== originalDigest) {
        console.error(`mutations: ERROR - ${mutation.file} was not restored byte-identically`);
        return 1;
      }
    }
    if (!detected) failures += 1;
  }
  if (failures > 0) {
    console.error(`mutations: ${failures} mutation(s) were not detected by any test`);
    return 1;
  }
  console.log('mutations: all detected');
  console.log('restore: verified');
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].replace(/\\/g, '/').endsWith('scripts/lib/mutations.ts');

if (invokedDirectly) {
  process.exit(runMutationCheck());
}
```

Declare the command in `COMMANDS.md`:

FILE: COMMANDS.md   (MODIFY — append to the gate block)
```
`sh scripts/mutation-check.sh` (mutation check: ok);
```

FILE: .agent/verification/EXPECTED_TEST_MANIFEST.txt   (MODIFY — append if absent)
```
tests/architecture/import-boundary.test.ts
```

RUN:

```sh
sh -n scripts/mutation-check.sh
sh scripts/typecheck.sh
sh scripts/test-unit.sh
sh scripts/mutation-check.sh
git status --porcelain=v1
```

EXPECT: `sh -n` exits 0 silently; `typecheck: ok`; `test-unit: ok` including the
architecture suite; `sh scripts/mutation-check.sh` prints one `mutations: <ID> DETECTED`
line per registry entry, then `mutations: all detected`, `restore: verified`, and
`mutation check: ok` as the final line, exiting 0; `git status --porcelain=v1` shows the
mutation-check script and the new test files as the only changes — `src/domain` is
unmodified (`git diff --quiet -- src/domain` exits 0).

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-002 MILESTONE_PASS "M7 import boundary test with negative case; mutation check: ok (7 mutations detected)"`

FALLBACK: if patching the source tree in place is unacceptable in a given environment,
apply each mutation to a temporary copy of the file and run the test against the copy via
a temporary `tsconfig` path alias — the assertion set is identical (mutated code must fail
a real test) and restoration becomes trivial; never replace the mutation check with a
static assertion that the guard text exists.

COMMIT: `git add -A && git commit -m "[EP-002][M7] import-boundary test and DOD-018 mutation check"`

### M8: Node gate `scripts/gate-domain.sh`

GOAL: One command proves the whole domain node — typecheck, import boundary, lint, unit,
collection guard, zero skips, complete traceability, the mutation check, and the unchanged
`verify.sh` progression.

READ: `scripts/gate-toolchain.sh` and `scripts/gate-foundation.sh` (style and contract),
`scripts/mutation-check.sh`, `.agent/verification/EXPECTED_TEST_MANIFEST.txt`,
`tests/domain/DOMAIN_TEST_MAP.csv`, `scripts/verify.sh`, `.agent/DONE_LAW.md`
(DOD-006, DOD-007, DOD-018, DOD-024, DOD-025), `COMMANDS.md`.

CHANGE: `scripts/gate-domain.sh` (create); `COMMANDS.md` (declare it and its sentinel);
`.agent/evidence/EP-002/verify-progression.txt` (written by the gate).

CONTENT:

FILE: scripts/gate-domain.sh   (CREATE — node-level VERIFY for EP-002)
```sh
#!/usr/bin/env sh
# EP-002 node gate. Sentinel: `gate-domain: ok`
#
# Proves the domain node by running every real gate and requiring its exact sentinel, plus
# four properties a green suite cannot prove on its own:
#
#   * zero skipped or todo tests (DOD-006 — a skip is a silent blind spot);
#   * the domain file set is exactly the audited set (no unaccounted domain module);
#   * the requirement→test map has no PLANNED rows left (DOD-001);
#   * the mutation check actually detects controlled defects (DOD-018).
#
# `verify.sh` keeps its full fifteen-stage order (master prompt §10, line 1357). After this
# node it still stops at `integration`, which EP-003 implements; nothing here removes,
# reorders, or exempts a stage.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "gate-domain: FAIL - $1" >&2; exit 1; }

mkdir -p .agent/evidence/EP-002
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0

# require_sentinel <sentinel> <command...>
require_sentinel() {
  sentinel=$1
  shift
  if ! out=$("$@" 2>&1); then
    echo "gate-domain: FAIL - command failed: $*" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  printf '%s\n' "$out"
  printf '%s\n' "$out" | grep -qxF "$sentinel" \
    || fail "expected sentinel '$sentinel' as the last line of: $*"
}

for f in scripts/mutation-check.sh scripts/gate-domain.sh; do
  sh -n "$f" || fail "sh -n failed for $f"
done

require_sentinel 'typecheck: ok' sh scripts/typecheck.sh
require_sentinel 'import boundary: ok' sh scripts/import-boundary.sh
require_sentinel 'lint: ok' sh scripts/lint.sh
require_sentinel 'test-unit: ok' sh scripts/test-unit.sh
require_sentinel 'test collection guard: ok' sh scripts/test-collection-guard.sh

# Zero-skip assertion (DOD-006). The collection guard reports skips as a note; a domain
# node must not close with any.
if ! node --test --test-reporter=junit "tests/**/*.test.ts" >"$tmp/domain-junit.xml" 2>"$tmp/domain-junit.err"; then
  echo "gate-domain: FAIL - the domain suite failed" >&2
  tail -n 40 "$tmp/domain-junit.err" >&2
  exit 1
fi
if grep -q '<skipped' "$tmp/domain-junit.xml"; then
  echo "gate-domain: FAIL - the domain suite contains skipped tests; DOD-006 requires an approved time-bounded waiver per skip" >&2
  grep -o 'name="[^"]*"' "$tmp/domain-junit.xml" | head -n 10 >&2
  exit 1
fi
collected=$(grep -c '<testcase' "$tmp/domain-junit.xml" || true)
[ "$collected" -gt 0 ] || fail "zero tests collected (DOD-007)"
echo "gate-domain: $collected domain tests collected, 0 skipped, 0 todo"

# The expected-test manifest must point at files that exist.
while IFS= read -r entry; do
  case "$entry" in ''|'#'*) continue ;; esac
  [ -f "$entry" ] || fail "manifest entry ${entry} does not exist"
done < .agent/verification/EXPECTED_TEST_MANIFEST.txt

# The domain file set is exactly the audited set. A new domain module must be added here
# deliberately, with its spec basis, rather than appearing silently.
expected=$(printf '%s\n' \
  src/domain/commands.ts \
  src/domain/entities.ts \
  src/domain/errors.ts \
  src/domain/events.ts \
  src/domain/identifiers.ts \
  src/domain/invariants.ts \
  src/domain/ports/index.ts \
  src/domain/state-machine.ts \
  src/domain/truth-state.ts \
  src/domain/values.ts | sort)
actual=$(find src/domain -type f -name '*.ts' | sort)
if [ "$actual" != "$expected" ]; then
  echo "gate-domain: FAIL - the domain file set is not the audited set:" >&2
  printf '%s\n' "$actual" >&2
  echo "Update the EP-002 audit list, the node gate, and the requirement map deliberately." >&2
  exit 1
fi

# Traceability completeness (DOD-001): no unmeasured rows.
if grep -q ',PLANNED$' tests/domain/DOMAIN_TEST_MAP.csv; then
  echo "gate-domain: FAIL - DOMAIN_TEST_MAP.csv still contains PLANNED rows:" >&2
  grep -n ',PLANNED$' tests/domain/DOMAIN_TEST_MAP.csv >&2
  exit 1
fi
printf 'gate-domain: traceability rows: %s\n' "$(($(wc -l < tests/domain/DOMAIN_TEST_MAP.csv) - 1))"

require_sentinel 'mutation check: ok' sh scripts/mutation-check.sh

# verify.sh progression: the five implemented stages pass, integration still fails loudly,
# and `verify: ok` never appears.
progression=.agent/evidence/EP-002/verify-progression.txt
if sh scripts/verify.sh >"$progression" 2>&1; then
  fail "verify.sh exited 0 although artifact-bound stages are unimplemented; that is a fabrication (DOD-027)"
fi
grep -q 'test-unit: ok' "$progression" || fail "verify.sh did not pass the unit stage"
grep -q 'ERROR: integration tests is an unimplemented placeholder' "$progression" \
  || fail "the integration stage must still fail loudly; see $progression"
if grep -qx 'verify: ok' "$progression"; then
  fail "verify.sh printed verify: ok while stages are unimplemented (DOD-024)"
fi
echo "gate-domain: verify.sh progression ok (unit green, integration loud-fails, no verify: ok)"

echo "gate-domain: ok"
```

Declare it in `COMMANDS.md`:

FILE: COMMANDS.md   (MODIFY — extend the node-gate line added by EP-001)
```
`sh scripts/gate-domain.sh` (gate-domain: ok, node EP-002);
```

RUN:

```sh
sh -n scripts/gate-domain.sh
sh scripts/gate-domain.sh
tail -n 3 .agent/evidence/EP-002/verify-progression.txt
```

EXPECT: `sh -n` exits 0 silently; `sh scripts/gate-domain.sh` prints every sub-gate's
sentinel, the `gate-domain: <n> domain tests collected, 0 skipped, 0 todo` line, the
traceability row count, the mutation lines, the progression line, and `gate-domain: ok` as
the final line, exiting 0.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-002 MILESTONE_PASS "M8 gate-domain: ok"`

FALLBACK: if the exact-file-set assertion blocks legitimate later work in a way that
cannot be resolved inside this node, replace it with a subset assertion (every file in
`src/domain` must be import-boundary clean and covered by the map) and record the change in
the ledger — never drop the import-boundary coverage itself.

COMMIT: `git add -A && git commit -m "[EP-002][M8] domain node gate"`

### M9: Node close-out

GOAL: The node is closed with a green node gate, a hashed evidence index, a `NODE_DONE`
ledger event, and a green tag — or it stays open with no tag.

READ: `.agent/DONE_LAW.md` (DOD-025, DOD-026, DOD-029, DOD-042),
`.agent/specs/SPEC-008-production-readiness.md` (§11, §13),
`.agent/verification/state/RELEASE_GATE.json`, `.agent/state/LEDGER.md`,
`tests/domain/DOMAIN_TEST_MAP.csv`.

CHANGE: `.agent/state/LEDGER.md` (events), `.agent/evidence/EP-002/**` (index and hashes).
`RELEASE_GATE.json` is **not** changed: the verdict remains `INCONCLUSIVE`.

CONTENT:

Generate the evidence index with a real command (never by hand):

```sh
mkdir -p .agent/evidence/EP-002
: > .agent/evidence/EP-002/INDEX.txt
find .agent/evidence/EP-002 .agent/evidence/mutation -type f ! -name INDEX.txt | sort | while IFS= read -r f; do
  digest=$(node -e 'const c=require("node:crypto"),fs=require("node:fs");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$f")
  printf '%s  %s\n' "$digest" "$f" >> .agent/evidence/EP-002/INDEX.txt
done
wc -l < .agent/evidence/EP-002/INDEX.txt
```

Before appending `NODE_DONE`, confirm that every milestone has a `MILESTONE_PASS` event
whose text names a sentinel observed in this session, and record in the ledger which
SPEC-001 items remain unproven (the T21 command gap, and anything the map still marks
`SPEC_GAP`).

RUN:

```sh
sh scripts/gate-domain.sh
sh scripts/ledger.sh append <AGENT_ID> EP-002 NODE_DONE "EP-002 complete: gate-domain: ok"
git tag green/EP-002
git log --oneline -1
sh scripts/ledger.sh status EP-002
```

EXPECT: `gate-domain: ok`; the ledger tail contains the `EP-002 | NODE_DONE` line;
`sh scripts/ledger.sh status EP-002` prints `DONE`; `git tag` lists `green/EP-002`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-002 NODE_DONE "EP-002 complete: gate-domain: ok"`

FALLBACK: none needed — closing is a ledger append plus a tag, and a failing gate simply
leaves the node open and untagged.

COMMIT: `git add -A && git commit -m "[EP-002][M9] close core domain node"`

## 9. Validation and Acceptance

Node-level acceptance. Every criterion needs executed evidence from this session; anything
else is `INCOMPLETE` (SPEC-000 §9.1, DOD-026).

| # | Criterion | Required evidence | DOD |
|---|---|---|---|
| B1 | Every SPEC-001 §2 value object exists and rejects invalid input with a typed error, including the eight opaque id kinds, `ChannelPriority`, `Jurisdiction`, `LegalBasis`, `Money`, and the `TruthState`/`PermissionClass`/`EgressClass` membership guards. | `test-unit: ok`; the `values.test.ts` and `identifiers.test.ts` suites reported in the collection guard; boundary cases for 0/1, empty basis, digest length/hex case, priority 0/9, lowercase jurisdiction, unversioned basis, float money | DOD-008 |
| B2 | All 27 SPEC-001 §3 entities exist with their invariant column enforced at construction. | `entities.test.ts` suite; each invariant row in the spec mapped to a test in `DOMAIN_TEST_MAP.csv` | DOD-001, DOD-008 |
| B3 | The ten SPEC-001 §5 ports are declared and nothing is implemented in the domain. | `events.test.ts` assertion that importing `ports.ts` yields zero runtime exports; `import boundary: ok` | DOD-010 |
| B4 | All eleven SPEC-001 §6 commands apply exactly one transition, emit only declared events, and produce an audit event. | `commands.test.ts`; `COMMAND_EVENTS` subset assertion | DOD-001, DOD-008 |
| B5 | All twenty-two SPEC-001 §7 events exist with `correlationId` and `tenantId`, and payloads carry no apparent PII. | `events.test.ts` catalogue and payload assertions | DOD-008 |
| B6 | Every legal transition T1–T21 succeeds with its guard satisfied, and every row of §4.2 is refused with a typed error leaving state unchanged. | existing `state-machine.test.ts` (unchanged) plus `illegal-transitions.test.ts` | DOD-008, DOD-018 |
| B7 | SM-1…SM-6 hold as executable assertions, including SM-5 (`HUMAN_REQUIRED` and `NOT_REMOVABLE` classify as outcomes, never failures). | `invariants.test.ts`; `classifyTruthState` assertions | DOD-008 |
| B8 | The import-boundary test proves the domain imports only the standard library and can fail on a deliberate violation. | `tests/architecture/import-boundary.test.ts`, including its negative case | DOD-008, DOD-018 |
| B9 | A mutation of a guard or boundary makes a real test fail, and every mutated file is restored byte-identically. | `mutation check: ok`; the seven `mutations: <ID> DETECTED` lines; `git diff --quiet -- src/domain` | DOD-018 |
| B10 | No test is skipped, todo, or removed; the collection guard fails on zero collection and the manifest names every suite. | `gate-domain.sh` zero-skip output; `test collection guard: ok` | DOD-006, DOD-007 |
| B11 | Requirement→test traceability exists for every domain-satisfiable requirement with no `PLANNED` rows left at close-out. | `tests/domain/DOMAIN_TEST_MAP.csv` plus the gate's traceability assertion | DOD-001 |
| B12 | `scripts/gate-domain.sh` prints `gate-domain: ok`; ledger holds `MILESTONE_PASS` for M1–M8 and `NODE_DONE`; tag `green/EP-002` exists. | ledger tail, `git tag` | DOD-025, DOD-026 |

**Known gaps this node must NOT paper over** (recorded as they are, in the map and the
ledger):

- **T21 has no owning command** in SPEC-001 §6. It is reachable only through
  `applyTransition` until the spec names its command. Status: `SPEC_GAP`.
- The domain cannot prove database-level guarantees (`audit_event` immutability, RLS,
  constraint triggers). Those belong to EP-003; this node claims only the domain half
  (VG-EVIDENCE-003's append-only *record* semantics, not the storage rule).
- No encryption, KMS, or key rotation is implemented or claimed here: `Identifier`
  enforces *ciphertext references*, which is a domain shape, not a cryptographic control.
  SPEC-002 §4/§9 keeps KMS selection `BLOCKED_CREDENTIALS` until PREFLIGHT is satisfied.
- `verify: ok` is not printed and not claimed. After this node `verify.sh` still stops at
  `integration`.

## 10. Idempotence and Recovery

Re-entering this node cold:

1. Read `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`,
   `.agent/state/LEDGER.md`, then this file's §11 Progress.
2. `sh scripts/ledger.sh status EP-002` and `sh scripts/ledger.sh tail 30`; resume at the
   first milestone with no `MILESTONE_PASS` event.
3. Re-verify the previous milestone's sentinel before continuing (cached green is not
   green): re-run the exact gate named in that milestone's `EXPECT`.
4. Re-measure before assuming: `node --test "tests/**/*.test.ts" | tail -n 12` and
   `sh scripts/lint.sh`. A parallel agent or an earlier partial run may have advanced the
   tree.

Idempotence properties:

- M1's map is created once; if it exists, merge by measurement rather than overwriting
  (never lower a status without recording why).
- M2 and M3 replace whole file bodies (`values.ts`, `identifiers.ts`, `entities.ts`) —
  re-running is a byte-identical rewrite.
- Appended describes in `values.test.ts` and appended manifest lines are guarded:
  `grep -c 'ChannelPriority (VG-CHANNEL-001' tests/domain/values.test.ts` and
  `grep -c 'identifiers.test.ts' .agent/verification/EXPECTED_TEST_MANIFEST.txt` must be
  `1` before appending again.
- The mutation check restores every file it touches and verifies the SHA-256; if a run is
  interrupted, `git diff --quiet -- src/domain` must be checked before continuing, and
  `git checkout -- src/domain` restores the committed state.

Recovery:

- Nothing in this node is destructive: no database, no history rewrite, no deletion of
  tests or evidence. The only in-place edits are the mutation harness's own temporary
  patches, which are digest-verified on restore.
- If a milestone fails all six attempts, emit the 5.7 structured `NODE_BLOCKED` report into
  §12 rather than improvising (exact blocker, commands and outputs, hypotheses tried, rungs
  climbed, smallest human decision, recommended default).
- If a legitimately required transition has no command (the T21 case), record `SPEC_GAP`
  and continue: a missing command is not a licence to invent a transition.

## 11. Progress

- [ ] M1: Resume inventory and the domain requirement→test map
- [ ] M2: Remaining value objects and runtime membership guards
- [ ] M3: Entities with their spec invariants
- [ ] M4: Ports (declarations only) and the domain event catalogue
- [ ] M5: Domain commands — exactly one transition each, audited
- [ ] M6: Invariants SM-1…SM-6 and every documented illegal transition
- [ ] M7: Import-boundary test and the DOD-018 mutation check
- [ ] M8: Node gate `scripts/gate-domain.sh`
- [ ] M9: Node close-out

## 12. Surprises & Discoveries

<!-- Append only observed, dated findings, each with the exact command that produced it. -->

## 13. Decision Log

<!-- Append dated decisions with rationale and status; record scope deviations here, never silently. -->

## 14. Outcomes & Retrospective

<!-- Filled in only after the node closes, with real observed evidence and honest limitations. -->


