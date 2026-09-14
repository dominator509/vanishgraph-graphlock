# Assumptions

## 1. Original assumptions

| assumption | risk | verification | status |
|---|---|---|---|
| Greenfield target | overwrite or drift | inspect target before EP-000 | **CONFIRMED** — target is a governance pack with no product code. Recorded in EP-000 §4 with the executed inventory. |
| Cloud provider unknown | deployment ADR may change | PREFLIGHT scored ADR | **OPEN** — ADR-006 unresolved. Blocks EP-009, not EP-000/EP-002. |
| No credentials supplied | live-fire gates blocked | run preflight after provisioning | **CONFIRMED OPEN** — `sh scripts/preflight.sh` reports DATABASE_URL, VALKEY_URL, S3_ENDPOINT, KEYCLOAK_ISSUER, LOCAL_MODEL_ENDPOINT and GITHUB_APP_ID unprovisioned. State: `BLOCKED_CREDENTIALS`. Blocks only dependent work. |
| Human UAT/manual AT/counsel/assessor unknown | GA cannot be GO | attach named external evidence | **OPEN** — no participants named. Caps any verdict at `CONDITIONAL_EXTERNAL_GATES` (DOD-039). |
| Provider terms volatile | unlawful automation risk | re-open official docs | **OPEN** — no provider terms revalidated in this session. |
| Working codename | trademark risk | clearance before public launch | **OPEN** — no clearance performed. |
| Licence choice | incompatible dependencies; unclear reuse rights | owner decision + compatibility review | **RESOLVED** — Apache-2.0 (`LICENSE`, ADR-014). |

## 2. Assumptions resolved during FORGE

| assumption | risk | verification | status |
|---|---|---|---|
| A second stateful cluster (Temporal) is required for durable execution | severe self-hosting barrier | ADR-016 analysis against the actual workload | **REJECTED** — replaced by a Postgres-native queue behind a `JobQueue` port; enqueue commits with the state transition. |
| Server-side rendering is needed for the portals | wrong architecture for a PII product | ADR-007: every surface is authenticated | **REJECTED** — replaced by a Vite + React SPA. |
| An ORM is the right data layer | cross-tenant breach from a mis-scoped `SET LOCAL app.tenant_id` | ADR-008 | **REJECTED** — Kysely plus SQL-first migrations. |

## 3. Corrections to earlier records (this section supersedes what it replaces)

### 3.1 The atomic-sources payload was NOT corrupt — it was CRLF corruption, and it is now FIXED

**A previous revision of this file stated that
`.agent/verification/atomic-security-sources.tar.gz.b64` was corrupt and would not be
repaired. That was wrong, and the error is corrected here.**

The measured facts:

- The payload is **intact**. The committed file had CRLF line endings — the git blob
  itself carried CR, not merely a Windows checkout — so `base64 -d` failed with
  `base64: invalid input` on **every** platform.
- With CR stripped it decodes to a valid gzip stream (magic `1f 8b`, 208 100 bytes)
  containing exactly the three expected files, and **all three SHA-256 sums hard-coded
  in `materialize-atomic-sources.sh` verify**.

The fix, verified by running `sh scripts/materialize-atomic-sources.sh`:

1. `.gitattributes` marks `*.b64 -text` (binary) so git never converts it, and pins
   `*.sh` and source/data files to LF — a CRLF shebang breaks `sh`, and `set -eu\r`
   is not `set -eu`.
2. The committed `.b64` was normalised to LF (284 770 → 281 119 bytes).
3. `materialize-atomic-sources.sh` now strips CR before decoding, so it is correct
   even if a CRLF copy reappears via a zip download or an editor.

Result: `atomic source library: ok`, and the three source files materialise with
matching digests. **This unblocks the 15 reconstructed Blockchain test bodies that
`HARNESS_LAWS.md` counts toward the 484-test accounting** — a blocker that had been
recorded as permanent was in fact a line-ending defect.

### 3.2 Two defects found while executing EP-003 M5, both fixed

**A. `withTenantSql` leaks its `set_config` echo as a result row.** Measured, not
theorised: `withTenantSql` opens with `SELECT set_config('app.tenant_id', ...)`, and in
an unaligned tuples-only psql session that statement emits its own return value as the
**first** result row. Five of the seven isolation tests initially failed with
`actual: '11111111-1111-4111-8111-111111111111', expected: '1'` — every caller's real
rows were shifted by one. The fix is in `tests/db/harness.ts`: `asTenant` drops the
echo row **only when it exactly equals the tenant id just set**, because a blanket
"drop the first row" would silently swallow a genuine first row.

**B. The collection guard's default glob swept in the service-dependent suite.** Once
EP-003 M5 added `tests/db/**`, the guard's default `tests/**/*.test.ts` collected the
database suite into the **unit** guard. Measured with the DSNs unset, simulating a clean
checkout: `test collection guard: FAIL - 7 test(s) failed`. That is precisely the error
DOD-032 forbids — a harness limitation reported as a product failure — and it made the
unit gate unrunnable without PostgreSQL. The default glob is now the same explicit pure
suite roots that `scripts/test-unit.sh` runs, so the guard and the stage it guards cannot
disagree about what "the unit suite" means. Verified: with no database the unit guard
reports `{"tests":302,"fail":0,...,"verdict":"OK"}`.

**C. The execplan's boolean comparison would have passed vacuously.** EP-003 M5's code
compared `relrowsecurity::text` against `'t'`, but libpq renders a boolean selected in a
tuples-only session as `true`/`false`. Measured against the real database, every one of
the 26 tables reported `true`. The suite now accepts either rendering and treats any
unrecognised value as **not** true, so an unexpected rendering fails the test rather than
passing it.

Both defects were found by running the tests, not by reading them. Neither was present in
`main` before this milestone.

### 3.3 The isolation tests were shown to have teeth (negative controls)

A passing isolation test that would also pass against an unprotected database is worse
than no test, so two negative controls were run against the **throwaway**
`vanishgraph_failure` database — never the main fixture:

| Sabotage | Result |
|---|---|
| `ALTER TABLE protected_subject NO FORCE ROW LEVEL SECURITY` | FAIL, `unprotected tables: [["protected_subject","true","false","1"]]` |
| `DROP POLICY …; CREATE POLICY … USING (true) WITH CHECK (true)` | FAIL, `unprotected tables: [["protected_subject","true","false","1"]]` and `FORCE RLS applies to the owner too` |

The main fixture was verified un-sabotaged afterwards
(`protected_subject | relrowsecurity=true | relforcerowsecurity=true`) and the suite is
green against it (7/7).

### 3.4 The domain `TenantId` could not represent a UUID (a real spec-vs-code defect)

Found while executing EP-003 M6, and it is the most significant defect of the node.

`OpaqueId`'s PII heuristic `LONG_DIGIT_RUN = /\d{7,}/` rejected
`11111111-1111-4111-8111-111111111111`, because the UUID's leading 8-hex-digit group is a
seven-plus digit run. **SPEC-002 §1 declares every table's `id` and `tenant_id` as `uuid`**,
so the domain's `TenantId` could not represent the tenants the schema stores. Every domain
test used `tenant-0001`, which passes, so the gap was never exercised: it surfaced only when
the Postgres-backed job-queue suite passed a real tenant id and construction threw.

The fix exempts a **canonical UUID shape** from the digit-run heuristic only. The email and
SSN checks still apply to every identifier, UUID or not. Verified by probe — accepted:
`11111111-…`, `22222222-…`, `aaaaaaaa-…`, `0f8fad5b-…`, `tenant-0001`, `tenant_01`;
still rejected: `123-45-6789`, `user@example.com`, `+15551234567`, `5551234567`,
`123456789`, `12345678`. Regression tests were added to `tests/domain/identifiers.test.ts`,
including the boundary case that a seven-hex-digit leading group is **not** a UUID (eight are
required) and so keeps facing the heuristic.

A second, related trap was fixed in the adapter: `OpaqueId.toString()` renders as
`TenantId:<uuid>` for log legibility, so `String(tenantId)` produced
`invalid input syntax for type uuid: "TenantId:1111…"`. The wire form of an identifier is
`.value`, never its diagnostic form.

### 3.5 The job queue's transactional property was shown to have teeth

EP-003 M6's central claim is that a rolled-back transition leaves no job row — the property
ADR-016 exists to protect. A test for it that passes vacuously would be worthless, so a
negative control was run: `runTransaction` was temporarily changed to ignore the rollback
request. The suite then failed with
`a rolled-back transition must leave NO job row; a job that survives its transition is the
dual-write bug`, and passed again (12/12) once restored.

Also measured during M6: the queue insert was initially refused with
`new row violates row-level security policy for table "job"`, because FORCE RLS applies to
the table owner too and the transaction had no `app.tenant_id`. That refusal is correct
behaviour; `runTransaction` now sets the tenant transaction-locally as the first statement.

### 3.6 Four CHECK constraints were vacuously satisfied on an empty array (a real defect)

Found while executing EP-003 M7, and it affects **already-committed** migrations 0002, 0004
and 0005.

Four constraints were written as `array_length(col, 1) >= 1`. Measured in this repository's
own PostgreSQL:

```sql
SELECT array_length(ARRAY[]::integer[], 1);        -- NULL, not 0
SELECT array_length(ARRAY[]::integer[], 1) >= 1;   -- NULL, not false
```

A CHECK constraint **passes** when its expression is NULL. So each of these constraints
accepted an empty array — the exact case it existed to forbid. Proven by inserting into the
live database: `jurisdiction_policy.rules = ARRAY[]` and `authority_grant.scope = ARRAY[]`
were both **accepted**, so `VG-POLICY-001` and `VG-AUTHZ-001` were not actually enforced at
the database layer.

- `jurisdiction_policy.rules` (0004) — a policy with no legal basis was representable
- `authority_grant.scope` (0002) — a grant authorising nothing was representable
- `email_thread.message_ids` (0005)
- `erasure_tombstone.shredded_key_versions` (0009, fixed there before it was committed)

`cardinality()` returns 0 for an empty array and is the correct function. Repaired additively
in migration `0010_repair_vacuous_array_checks.sql`, because 0002/0004/0005 are committed and
checksummed and editing them in place would make every existing database report drift (MIG-5).
Migration 0010 verifies its own repair against `pg_constraint` and proves the repaired
constraint refuses an empty array before it commits.

**NOT affected, verified rather than assumed:** `exposure.exposure_confidence_basis_check`
uses `jsonb_array_length`, which returns 0 for `[]`, so `> 0` genuinely fires. "Fixing" it
would have been a pointless change to a correct constraint.

### 3.7 Two test-design defects that made suites pass only once (both fixed)

Both were found by running the suites repeatedly, not by reading them.

1. **Fixed subject ids and a counter-based jurisdiction made the retention suite
   non-repeatable.** Tombstones are append-only and unique per `(tenant, subject)`, and
   `jurisdiction_policy` is unique per `(tenant, jurisdiction, version)`, while a module-level
   counter resets on every `node --test` invocation. The second run therefore failed with
   unique-constraint violations.
2. **The first fix was itself wrong, and measurably so.** It derived ids from
   `Date.now().toString(36)` truncated to 7 characters. Base36 timestamps vary in their **last**
   characters, so runs minutes apart produced ids differing in only the final 2–3 digits: three
   consecutive runs failed 3, then 4, then 0 tests. Real entropy (`randomUUID()`) was required.
   Verified by four consecutive runs: 14/14 pass each time.

A third design point worth recording: the shred test asserts unrecoverability while the
ciphertext row is **still physically present**, which is what distinguishes crypto-shredding
from row deletion. It passes because the DEK is gone, not because the data is gone.

### 3.8 M7's honest scope limit: no production KMS exists

ADR-006 (cloud/KMS selection) is **OPEN**, so `src/adapters/crypto/managed-kms-key-provider.ts`
is `BLOCKED_CREDENTIALS` and throws on every operation. The local file-backed provider holds its
KEK on the same filesystem as the data it protects; it exists so the encryption, rotation and
shred **mechanics** can be exercised against real PostgreSQL, and it must never be selected in
production (VG-SCOPE-020). Its class name says so, and a test asserts the managed adapter refuses
rather than pretending. No test in this node is evidence about a production KMS.

### 3.9 The backup drill's own pass/fail logic was inverted (caught by running it)

The M8 drill reported its post-conditions through a `check` helper that tested for `"1"` as
success. POSIX exit statuses are the opposite: **zero means success**. So every genuinely
passing check printed `FAIL` and — far worse — a genuine failure would have printed `PASS`.

This was not a cosmetic bug. It was caught only because the drill printed `FAIL` next to
values that were obviously healthy (`tombstones=1 (pre-disaster=1)`, `0 unprotected`), which
prompted a direct test of the helper rather than a re-read of it. A drill whose verdict is
inverted is worse than no drill, because it converts a severity-1 finding into a green line.

A second defect in the same helper: `check "name" "$?" "detail"` looks correct but is not.
With `set -e` active, a **failing** `[ ... ]` — exactly the case the drill exists to report —
aborts the script before `check` runs. The drill printed four `PASS` lines and exited silently
instead of reporting a failure. Both are now handled by an `expect` helper that evaluates the
condition under `set +e` and forwards the real status.

### 3.10 Two drill probes measured the wrong thing

1. **The cross-tenant probe ran as the superuser.** A superuser bypasses row-level security by
   definition, so it returned 1 where `vg_app` returned 0 — it measured the prober's privilege,
   not the isolation under test. Had this been reported without checking, it would have
   manufactured a cross-tenant leak finding out of nothing. The probe now runs as `vg_app`, and
   asserts both halves: cross-tenant rows are 0 **and** the tenant's own rows are still visible,
   because a probe that can see nothing would also "prove" isolation.
2. **The "erased PII unrecoverable" check was vacuous.** The drill shredded a key row that had
   never been created, so it reported `shredded=0 recoverable=0` — which reads as a pass on the
   recoverable half while proving nothing about the shred. The seed now creates real wrapped key
   material first, and the check reports `shredded=1 recoverable=0`.

### 3.11 The drill was shown to have teeth (negative controls)

| Sabotage | Result |
|---|---|
| Erasure marks the key SHREDDED but does not empty the wrapped bytes | Refused by the M7 `tenant_key_shredded_is_empty` constraint before the drill could proceed — a second layer of defence working |
| Erasure never shreds at all (key stays ACTIVE) | `FAIL restore did NOT resurrect erased PII: rows with recoverable key material=1`, exit 1, with the severity-1 message |

The second control also retroactively demonstrates why §3.9 mattered: before the fix, that
failure would have been printed as a pass.

### 3.12 Two spec-named domain ports were never declared by the node that owns port declaration

SPEC-001 §5.1 lists thirteen ports and their locations. Eleven were declared by EP-002, the node that
owns port declaration (§5.1 rule 4). Two were not:

| Port | Spec location | State |
|---|---|---|
| `IdempotencyStore` | `src/domain/ports/` | Declared by EP-004 M5, because at-most-once is a domain invariant (VG-ACTION-001) |
| `AuthorityGrantRepository` | `src/domain/ports/` | **STILL UNDECLARED** |

EP-002's execplan never mentions either name, so this was an omission rather than a deliberate
deferral. `IdempotencyStore` is now declared once, in the node that first needed it, which is the
best available outcome now that EP-002 is closed.

**`AuthorityGrantRepository` remains an open gap.** No node has declared it and no code implements
it. It is recorded here rather than silently left out, and the node that first needs a persisted
authority grant — most likely EP-006, which owns the identity and authority surface — must declare it
before implementing it, exactly as EP-004 M5 declared `IdempotencyStore`.

## 4. Known limitations recorded honestly (not resolved)

1. **Empty `describe` blocks are not detected by the collection guard.** Node reports a
   file containing only `describe('x', () => {})` as one passing test whose name is the
   suite title, indistinguishable from a real test by name. The guard *does* catch a
   glob matching no files, a file declaring no tests at all, an emptied manifest suite,
   and any failing test.
2. **EP-005 was converted to the Vite + React stack by scripted transformation**, then
   covered by the consistency review below. It was not authored fresh against that
   stack.
3. **`LICENSE`/`NOTICE` carry a copyright placeholder.** Apache-2.0 §4(d) requires the
   holder to be named. Owner decision (`DECISIONS.md` §5).
4. **Every unimplemented gate is still a loud-fail placeholder.** `verify.sh` passes
   preflight, lint, format-check, typecheck, unit and the collection guard; it stops at
   `integration`, which EP-003 has not yet implemented (`test-integration.sh` is still a
   loud-fail placeholder). `verify: ok` is unreachable until EP-009/EP-010. That is the
   correct honest state, and `gate-domain` asserts it: the integration stage must still
   fail loudly and `verify: ok` must never appear.
5. **`dist/` contains build output from an earlier run.** It is not consumed by the
   database gates, but it can make a stale compiled file look current. A future node
   should confirm `build.sh` regenerates it and that nothing imports it.

## 5. Consistency review of the 11 ExecPlans (executed)

A cross-node review was run, comparing dependency chain, gates, audit lists,
provisioning surface, port placement and test paths. Findings and fixes:

| # | Finding | Impact if unfixed | Fix |
|---|---|---|---|
| 1 | `test-integration.sh` declared "unblocked by EP-002", but EP-002 is Core Domain with no infrastructure; EP-003 implements it. | An executor would either invent database tests in EP-002 or leave the stage unimplemented. | Placeholder unblock node corrected to EP-003. |
| 2 | `test-collection-guard.sh` hard-coded both the glob and the manifest, and **overwrote** any incoming `VG_EXPECTED_MANIFEST`. | EP-003 M5 could not work as written: the integration suite would have been checked against the unit manifest and unit glob. | Guard parameterised on `VG_TEST_GLOB` and `VG_EXPECTED_MANIFEST`. Verified in both directions, and EP-003's own verification grep (`grep -c 'VG_TEST_GLOB:-'`) now returns 1. |
| 3 | `test-unit.sh` globbed `tests/**/*.test.ts`, sweeping in database, blackbox, e2e and live-fire suites. | The unit stage would fail on a clean checkout, presenting a harness limitation as a product failure (DOD-032 violation). | Unit stage excludes every service-dependent root; convention table added to `TESTING.md`. Verified: 94 tests still run and pass. |
| 4 | Ports were placed inconsistently: `src/domain/ports.ts`, `src/domain/ports/`, and `src/application/ports/` for domain-owned concepts (`IdempotencyStore`, `AuthorityGrantRepository`, `SecretResolver`). | Two nodes would declare the same port in different layers, or a domain rule would depend on an application-layer declaration. | Normative rule added to SPEC-001 §5.1 ("a port lives in the layer that owns the concept"); EP-002 now declares all ports once, EP-003 implements rather than re-declares, EP-004/EP-006 port paths corrected. |
| 5 | `JobQueue` was declared nowhere in EP-002 and introduced mid-chain by EP-003. | Port declaration scattered across nodes, so the queue's contract would be defined by its implementer. | EP-002 declares `src/application/ports/job-queue.ts`; EP-003 implements the adapter. |
| 6 | EP-007 created a second mutation system (`mutation-gate.sh`) without referencing EP-002's (`mutation-check.sh`, `lib/mutations.ts`). | The same guard could be proven and unproven at once by two mechanisms. | EP-007 now imports EP-002's mechanism; rule recorded in `TESTING.md`. |
| 7 | Node gates were named inconsistently: `ep004-gate.sh` / `ep004 api gate: ok` against `gate-<purpose>.sh` / `gate-<purpose>: ok` everywhere else. | Cross-node references pointed at names that did not follow the convention, and sentinels contained spaces. | Renamed to `gate-api.sh`, `gate-ui.sh`, `gate-security.sh` with matching sentinels; all cross-references updated. |
| 8 | The atomic-sources payload was recorded as permanently corrupt. | 15 test bodies and part of the 484 accounting would have been written off as unobtainable. | Root cause found (CRLF), fixed, and verified — see §3.1. |

Verified clean and requiring no change: the dependency chain matches `.agent/GRAPH.md`
for all 11 nodes; every node lists `COMMANDS.md` in its audit list; `verify: ok` is
disclaimed by every node and claimed exactly once, inside EP-010's ship gate; all 11
have 14 sections, all nine milestone keywords matching their milestone count, and zero
checked progress boxes (91 milestones total).

**Not covered by this review:** the *technical correctness* of each plan's proposed
implementation, and whether the specifications themselves are internally consistent.
This review checked cross-node consistency only.
