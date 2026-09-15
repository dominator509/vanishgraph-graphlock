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

**Correction to a claim I made in this same session, and the lesson it carries.** I briefly recorded a
*third* undeclared port here — `AuditSink` — on the strength of a search that returned no matches. The
search was `Select-String -Path 'src\**\*.ts' -Pattern 'AuditSink|INSERT INTO audit_event'`. **PowerShell's
`-Path 'src\**\*.ts'` does not recurse the way a glob reader expects, so it silently matched nothing, and
I read an empty result as evidence of absence.** `AuditSink` is declared, at
`src/domain/ports/index.ts:107`:

```ts
/** Append-only event sink (VG-EVIDENCE-003). */
export interface AuditSink {
  append(events: readonly AuditEvent[]): Promise<void>;
}
```

THE RULE THIS ESTABLISHES, and it applies to every search in this project: **a negative result is only
evidence if the search is shown to work.** The repository already demands negative controls for tests;
the same discipline is required for the searches that justify a claim about what does not exist. Every
"there is no X" statement in this file was produced by a search, and the searches that matter are worth
re-running with a positive control beside them.

Two accurate gaps in `AuditSink`'s case remain, and they are smaller than "undeclared":

1. **Placement.** It is declared INLINE in the barrel, and SPEC-001 §5.1 rule 1 requires "one file per
   port, inside a `ports/` directory, with `ports/index.ts` as the barrel". `KeyProvider` and
   `IdempotencyStore` were both moved to their own files for exactly this reason, and their file comments
   record the deviation as fixed. `AuditSink` was not. Fixed by EP-004 M6: it now lives in
   `src/domain/ports/audit-sink.ts` and is re-exported from the barrel.
2. **No ADAPTER implements it.** Ports are declared by EP-002 and implemented by the node that needs them
   (§5.1 rule 4), so an unimplemented port is expected rather than a defect — but it means **nothing in
   this codebase has ever written an `audit_event` row.** Verified with a working search: `INSERT INTO
   audit_event` matches nothing under `src/` (positive control: `IdempotencyStore` matches 17 times in the
   same tree). The only `audit_event` rows that exist are those `db/seed/prior_release.sql` inserts.
   Implemented by EP-004 M6 as `src/adapters/persistence/audit-sink.ts`.

**`AuthorityGrantRepository` remains an open gap.** No node has declared it and no code implements
it. It is recorded here rather than silently left out, and the node that first needs a persisted
authority grant — most likely EP-006, which owns the identity and authority surface — must declare it
before implementing it, exactly as EP-004 M5 declared `IdempotencyStore`.

### 3.13 SPEC-003 §5.3 requires fields that SPEC-002 §2's schema has no column for (three migrations added)

Executing EP-004 M6's §5.3 group (sources, catalogue entries, removal recipes) found that the contract
names request and response fields with nowhere to live. Each is traceable to a specification sentence;
what was missing was the storage those sentences presuppose. All three migrations are ADDITIVE and
NULLABLE, so no statement in SPEC-002 §2 is contradicted — SPEC-002 declared a subset of what the
contract needs.

| Field / rule | Required by | Column added | Migration |
|---|---|---|---|
| `controllerId` on the source DTO, and `422 CONTROLLER_NOT_FOUND` | SPEC-003 §5.3.1, §5.3.2 | `source.controller_id uuid REFERENCES controller(id)` | 0012 |
| `permissionEvidenceUrl`, `422 PERMISSION_EVIDENCE_REQUIRED` | SPEC-003 §5.3.2, §5.3.4 | `source.permission_evidence_url text` | 0012 |
| `freshnessState` / `permissionFresh`, defined against a **source-declared** window | SPEC-006 §5.3 row 7 | `source.permission_window_seconds integer` | 0012 |
| `409 SOURCE_ALREADY_DECLARED` | SPEC-003 §5.3.2 | `UNIQUE INDEX source_tenant_name_uniq (tenant_id, name)` | 0012 |
| `signingKeyRef`, `maxAttemptsPerWindow`, `windowSeconds` | SPEC-003 §5.3.7; VG-ACTION-005 | `removal_recipe.signing_key_ref`, `.max_attempts_per_window`, `.window_seconds` | 0012 |
| `disabledReason`, `enabledAt` | SPEC-003 §5.3.8, §5.3.10 | `removal_recipe.disabled_reason`, `.enabled_at` | 0012 |
| `If-Match` / ETag concurrency token on both write routes | SPEC-003 §2.7, §5.3.4, §5.3.10 | `source.row_version`, `removal_recipe.row_version` (NOT NULL DEFAULT 1) | 0012 |
| `409 CATALOG_ENTRY_DUPLICATE` | SPEC-003 §5.3.6 | `UNIQUE INDEX source_catalog_entry_source_category_uniq (source_id, category)` | 0013 |
| `disabled_reason` holding BOTH a system token and an operator's own reason | SPEC-003 §5.3.8, §5.3.10 | 0012's vocabulary CHECK **withdrawn** | 0014 |

Two decisions inside this are choices rather than quotes, and are recorded as such:

* **`(tenant_id, name)` is the natural key for a source.** SPEC-002 declares no natural key, so
  `SOURCE_ALREADY_DECLARED` was undecidable without one: a check-then-insert lets two concurrent
  declarations both succeed. The key is the one §5.3.2's request body supplies.
* **`(source_id, category)` is the natural key for a catalogue entry**, for the same reason and with the
  same consequence if omitted.

**Deviation from EP-004 M6's instruction, stated explicitly.** M6 says: "Do not invent a schema in this
node; that is EP-003's audit list and this node's diff would violate §6." That instruction is in M6's
"Blocked work, stated honestly" section and addresses the case where EP-003 is *unstarted* — "EP-003 is
largely unstarted, so no schema, migration, or RLS policy exists". That condition does not hold: EP-003
is DONE (tag `green/EP-003`) and delivered 11 migrations and FORCE RLS on 30 tables. What is present is
a **spec-vs-spec coverage gap** (SPEC-003 §5.3's contract vs SPEC-002 §2's DDL), which is a different
problem needing a different remedy. The alternative was to implement ten routes that silently discard
seven contractual fields, which is the "software that appears to work" failure state AGENTS.md names.
The columns were therefore added, additively, in EP-004 — and every one of them is cited above.

Migration 0014 withdraws 0012's `disabled_reason` CHECK rather than widening it: the column carries a
closed SYSTEM vocabulary (VG-CHANNEL-002's auto-disable) **and** an operator's own reason from §5.3.10,
whose documented example (`PERMISSION_REFRESHED`) the CHECK would have rejected with `23514` — a 500 on
a legitimate request. The closed half moved to a TypeScript union in the adapter, where those values are
produced; the open half is bounded at the route.

`db/tenant-scoped-tables.txt` is unchanged: no table was added, and `check-rls-coverage.sh` still
reports 30 tenant-scoped tables enabled, forced and policied.

### 3.14 The recipe signature's signed payload is not specified anywhere (a construction was chosen)

SPEC-003 §5.3.7 requires the API to "verify the signature before accepting the row" (VG-CHANNEL-003,
VG-API-028) and never states **what is signed**. A verifier must define the bytes, or it cannot verify
anything. The construction in `src/adapters/persistence/sources.ts#canonicalRecipePayload` is:

* a JSON object with a **fixed, alphabetical field order** and no whitespace, so a signature cannot
  verify against a differently-ordered but semantically identical body;
* `signature` excluded (a signature cannot cover itself); `sourceId` **included** so a signature cannot
  be replayed onto another source's version; `version` **excluded** because the server assigns it under
  a lock after verification, which would make the payload uncomputable by a caller who guessed wrong;
* the algorithm read from the KEY, never from the request, because a caller-supplied `alg` is how
  `alg: none` and algorithm-confusion attacks arrive.

**This is an assumption, not a specification requirement**, and it is a wire-visible one: an integrator
cannot produce a valid signature without it. It is exported (`canonicalRecipePayload`) and used by the
persistence suite, so the rule has exactly one definition. The specification should state the payload;
until it does, this is the recorded choice.

Relatedly: **no production recipe signing key exists.** ADR-006 (KMS selection) is OPEN, so
`RECIPE_VERIFICATION_KEYS` is unset in every deployment and `POST /v1/sources/{sourceId}/recipes`
refuses with `503 DEPENDENCY_UNAVAILABLE` naming the unconfigured reference. That is deliberate and
fail-closed: a recipe the system cannot verify is never stored. It is **not** a claim that signature
verification works in production — the persistence suite proves it works against a locally generated
Ed25519 key pair, and nothing more.

### 3.15 Two modules declared different `IdempotencyRequirement` unions, and one route was not claiming keys

Found while wiring `requirementFor` to the registry in EP-004 M6:

| Defect | Consequence if it had shipped |
|---|---|
| `src/http/openapi/registry.ts` declared `required \| optional \| none`; `src/http/plugins/idempotency.ts` declared `required \| required-if-effect \| optional` | The two types do not overlap on `'none'`. Wiring the registry to the plugin did not typecheck. A cast would have made every `'none'` route (the four public health routes) fall through to the **required** branch, so `/v1/health`, `/v1/ready`, `/v1/live` and `/v1/startup` would have answered `400 IDEMPOTENCY_KEY_REQUIRED` — taking liveness and readiness down for every caller presenting no key. |
| `src/infrastructure/main.ts` passed `requirementFor: () => undefined` | No route ever claimed a key. Every effect-bearing route ran with idempotency effectively **OFF** while its registry entry said `required`, and the handler looked correct. This is the same defect `beginHandler` had already fixed for step-up, in the same file, one milestone earlier. |

`'none'` is **not** a SPEC-003 §4.1 token — §4.1 names Required, Required-if-effect and Optional. It is
the registry's way of saying "this route does not participate in idempotency at all", which is the truth
for the health routes; `optional` would have echoed a supplied key and advertised a mechanism that does
nothing there. The plugin now understands it.

### 3.16 `DETAILS_ALLOWLIST` had no key for the ETag §2.7 requires in a 412 body

SPEC-003 §2.7: "a stale value is `412 PRECONDITION_FAILED` with the current ETag in the body". The
`details` allowlist in `src/http/errors/code-registry.ts` had no entry for it, and SPEC-006 H-13
restricts `details` keys to that allowlist. `currentEtag` was added, citing §2.7, and its value is the
same string the response's own `ETag` header carries — so it discloses nothing a caller could not
already read. Recorded because the allowlist is a closed set and adding to it is a contract change.

### 3.17 `DiscoveryRun` is defined by NO specification, so SPEC-003 §5.4 cannot be built without inventing a data model

SPEC-003 §5.4 declares five routes over a `DiscoveryRun` aggregate — its lifecycle `ACCEPTED`, `RUNNING`,
`COMPLETED`, `COMPLETED_PARTIAL`, `FAILED`, `HUMAN_REQUIRED`, its declared-surface and budget shapes, and
a coverage report naming each skipped source and why. Searched:

| Where an aggregate would be defined | Result |
|---|---|
| SPEC-001 (core domain) — entity catalogue §3, port table §5.1 | **No occurrence of `Discovery` or `DiscoveryRun` at all.** No entity, no value object, no port, no lifecycle. |
| SPEC-002 (data model) §2 DDL and §3 RLS inventory | **No occurrence of `discovery` or `candidate`** as a table, column or aggregate. The only match is the word `DISCOVERED_CANDIDATE` inside an enum list. |
| `db/migrations/*.sql` (the delivered schema, 14 migrations) | **No `discovery_run` table.** 33 live tables, enumerated from `information_schema`, and none of them is a discovery run. |
| `db/tenant-scoped-tables.txt` | Not listed. |

So the ONLY definition of this aggregate is SPEC-003 §5.4's own prose and example response bodies. That
is materially different from §5.3, and the difference decides the action:

* **§5.3** — SPEC-002 named the tables (`source`, `source_catalog_entry`, `removal_recipe`) and most of
  their columns; SPEC-003 §5.3 named the additional fields. Materialising those columns adds storage for
  names the specifications already use. Done, in migrations 0012/0013/0014.
* **§5.4** — nothing names a table, a column, a lifecycle or a port. Building it means DESIGNING a
  persistence model and a run lifecycle: how a run's progress is recorded, what a "skipped source with
  reason" row is, whether coverage is stored or derived, how the same-subject×source in-flight conflict
  is detected. Every one of those would be this node's invention presented as an implementation of a
  specification that does not exist.

**Recorded as `BLOCKED_PREREQUISITE` (specification, not environment).** The prerequisite is a SPEC-001
entity + SPEC-002 table definition for `DiscoveryRun` (and its per-source outcome rows), or a SPEC-003
amendment that delegates the model explicitly. This is the condition EP-004 M6 anticipates when it says
to "stop at `NODE_BLOCKED` for this milestone with the two blocking references named, and record the
exact prerequisite" — and unlike §5.3, here there is no specification sentence to cite for each choice,
so the fail-closed reading is the correct one. **These five routes are not implemented**, and this
record is why.

### 3.18 CORRECTION: the transition spine DOES have a home — and the real gap is an undeclared `AuditSink` port

**This section retracts a claim I published earlier in the same session.** I recorded §5.4–§5.16 as
`NODE_BLOCKED — BLOCKED_PREREQUISITE (specification)` on the ground that "every state-changing route
returns a `transitionId`, and no specification defines a transition record". The first half is true; the
conclusion was wrong, and the evidence that refutes it was in the repository the whole time.

**What I searched for, and what I should have searched for.** I searched for a TABLE named after the
concept (`CREATE TABLE transition…`) and, finding none anywhere, concluded there was no home for
transition facts. I never asked the question the graph's own plan had already answered: *where did the
node that owns the schema decide transition facts go?* EP-003's execplan, `.agent/execplans/EP-003-node.md`
line 132, states it in a column-mapping table:

> | `Reappearance.priorRemovedEventId` | `prior_removed_event_id` | resolved to `audit_event(id)`:
> **SPEC-002 defines no separate transition table, and `audit_event` is the append-only record of the
> T14 transition** |

and the seed data it specifies writes the transition fact INTO that record
(`EP-003-node.md:2182`):

> `INSERT INTO audit_event (…) VALUES ('11111111-…', 'domain-command', 'RequestReady', 'RequestCase',
> '7777…', '1111…', '{"transitionId":"T5"}'::jsonb)`

So the design is: **an `AuditEvent` IS the transition record, with the transition code and its facts in
`audit_event.payload`.** SPEC-001 §4.3 SM-2 ("no state change may be committed without its `AuditEvent`")
and SM-3 (a transition must carry its declared evidence) are the same statement from the invariant side.
The domain already produces exactly this: every `CommandResult` carries `transitionId` (the `T<n>` code —
`TransitionId` is declared as a code union in `src/domain/truth-state.ts:155`), `from`, `to`, `evidence`
and a complete `audit: AuditEvent`.

**What was actually missing: the append path, not the port.** `AuditSink` IS declared — inline in
`src/domain/ports/index.ts` until EP-004 M6 moved it to its own file (§3.12 records both the placement fix
and the unreliable search that briefly made me claim the port was missing). What had never existed was an
IMPLEMENTATION, and therefore any `audit_event` write at all: `INSERT INTO audit_event` matched nothing
under `src/` (verified with a working search — positive control: `IdempotencyStore` matches 17 times in
the same tree), and the only audit rows in existence were the ones `db/seed/prior_release.sql` inserts.

**That gap is now FIXED and verified.** EP-004 M6 implemented
`src/adapters/persistence/audit-sink.ts` and proved it with `tests/db/audit-sink.test.ts` (13 tests, real
PostgreSQL): an append is readable back with every SPEC-001 field intact; **a rolled-back state change
leaves NO audit row** — the SM-2 property, and the one that distinguishes this design from the forbidden
"commit state and log later", asserted beside a committed-append control so it cannot pass vacuously; a
non-UUID correlation id or target id is refused rather than substituted; a nested payload value is
refused; a cross-tenant batch is refused; tenant B cannot read tenant A's audit rows while A can; and
UPDATE/DELETE on a row are no-ops. This is the first audit write path the project has ever had.

**The remaining gap is sharper than "no table exists", and it is a three-way specification conflict:**

| Citation | What it fixes |
|---|---|
| SPEC-001:96 | `AuditEvent` = `id, tenantId, actor, action, target, at, correlationId` — **no transition code, no from/to truth state**, and no `payload` field at all |
| SPEC-001:155 (SM-2) | "Every transition appends an `AuditEvent`" — the audit row IS where a transition is recorded, but its declared fields cannot carry what §5.5.5 asks a reader to see |
| SPEC-002:26-27 | "`jsonb` is permitted only for recorded bases and provider payloads — **never for values needing integrity (state, authority, digests)**" |
| SPEC-003 §5.5.5 | requires per transition: `transitionCode` (`T3`), `fromTruthState`, `toTruthState`, `actorIdentity`, `command`, `evidenceArtifactIds[]`, `correlationId` |

A transition's `from`/`to` truth states ARE state values needing integrity, so **`audit_event.payload` is
the one place SPEC-002 §1 rules out** — and it is exactly the place `EP-003-node.md:132` chose ("`audit_event`
is the append-only record of the [T14] transition") and `EP-003-node.md:2182`'s seed demonstrates
(`'{"transitionId":"T5"}'::jsonb`). So the housing is not merely absent from the DDL: **the housing the plan
selected is the one the data-model specification forbids, and neither specification supplies an
alternative.**

**Consequence, stated precisely.** Now that the append exists, most of §5.5–§5.14's reads and its state
changes are implementable. What is NOT implementable is anything that must READ BACK a transition's code or
its from/to states: §5.5.5, §5.7.3's `lastTransition`, §5.7.6's `TRANSITION` timeline entries, and the
`transitionId`/`transitionCode` fields in the success bodies of §5.5.3, §5.5.4, §5.7.4, §5.7.5, §5.8.2,
§5.8.3, §5.9.1, §5.10.1 and §5.11.1. Producing those means putting integrity-bearing state into `jsonb`,
which SPEC-002 §1 forbids. `src/adapters/persistence/audit-sink.ts` deliberately contains **no
`transitionPayload` helper** and says so where one would naturally sit, so a later node cannot
reintroduce the forbidden shape by accident.

**`verify: ok` and `RELEASE_GATE.json` remain unchanged, and the 27 implemented routes are unaffected.**

### 3.19 EP-004 M6's remaining routes: what IS genuinely undefined, after the correction above

**The finding, stated precisely.** The blockers are narrower than I first claimed and fall into three
classes: (1) **one** aggregate no specification defines at all (`DiscoveryRun`, §5.4 — see §3.17);
(2) one **specification conflict** about where transition facts may be stored (§3.18), which blocks the
transition-reading routes rather than the state changes; and (3) ordinary additive columns and records
whose owning node has not yet been identified. Only class (1) is a complete absence.

**The transition record is NOT missing — see §3.18.** `AuditEvent` IS the transition record, per EP-003's
own decision at `.agent/execplans/EP-003-node.md:132` and the seed at `EP-003-node.md:2182`; the append
path now exists and is verified. What SPEC-002 §1 forbids is storing the transition's STATE in that
record's `jsonb` payload, which is the only place the plan put it. The per-group list below reflects that:
entries that named "transition table" as their prerequisite are struck through and replaced with what
actually remains.

**Per-group prerequisites, each verified against the live schema:**

| Group | Routes | What actually does not exist |
|---|---|---|
| §5.4 discovery runs | 5 | A `DiscoveryRun` aggregate. `Discovery`/`DiscoveryRun` appear **nowhere** in SPEC-001, and `discovery`/`candidate` nowhere in SPEC-002 as a table or column. Only SPEC-003 §5.4's prose defines it. **Genuinely undefined.** |
| §5.5 exposures | 5 | Read routes implementable. The `transitionId`/`transitionCode` in 5.5.3/5.5.4's success bodies and all of 5.5.5 need transition facts READ BACK, which SPEC-002 §1 forbids storing in `jsonb` (§3.18). `truthStateChangedAt` for 5.5.2 is derivable from `updated_at` (trigger in `0006`). |
| §5.6 policy decisions | 4 | `policy_decision.exemption_evaluation`; `jurisdiction_policy.policy_checksum` — two additive columns. |
| §5.7 cases | 6 | Read routes implementable except `lastTransition`/timeline. 5.7.1/5.7.4/5.7.5 need transition facts read back (§3.18); 5.7.5 also needs a HumanGate record — `human_gate` has 9 mentions in EP-002's and EP-004's plans, so those must be read before judging it undefined. |
| §5.8 external actions | 6 | A reconciliation record and a readback record (5.8.3, 5.8.4). `reconciliation` has 19 mentions across six execplans, and EP-007/EP-008 name `readback`, so ownership needs reading before judging. |
| §5.9 controller responses | 3 | 5.9.2/5.9.3 implementable; 5.9.1 returns `transitionCode`, which needs transition facts read back (§3.18). |
| §5.10 verification observations | 3 | 5.10.2/5.10.3 implementable; 5.10.1 returns `transitionCode` (§3.18). |
| §5.11 reappearances | 3 | 5.11.2/5.11.3 implementable; 5.11.1 returns `transitionCode` (§3.18). |
| §5.12 evidence artifacts | 5 | An integrity-check record (5.12.4); 5.12.1/5.12.3 need the object store, which is `BLOCKED_CREDENTIALS` (S3_*). |
| §5.13 deadlines | 3 | No blocker found; implementable with additive columns |
| §5.14 appeal escalations | 3 | No blocker found; implementable with additive columns |
| §5.15 audit events | 2 | `audit_event` has no `actor_kind`, no `outcome`, no `request_id`, no `refusal_code`, no `traceparent`. The domain's `AuditEvent.actor` is a flat `string` with no kind, and §5.15's `actor.kind` vocabulary (`HUMAN\|SERVICE\|SYSTEM`) is defined only inside SPEC-003's example body. `outcome` **is** defined — SPEC-007 §4/§5 lists `SUCCEEDED, REFUSED, FAILED, AMBIGUOUS, GATED` — but no domain object or column carries it. |
| §5.16 coverage reports, metrics | 3 | A coverage-report aggregate — no table; and coverage itself is produced by the undiscoverable discovery runs |
| §5 / webhooks (EP-004 M7) | 3 | A `webhook_binding` table — absent, though `WEBHOOK_BINDING_NOT_FOUND` is in the error registry |

**Why this is not the same as §5.3, and why the action differs.** For §5.3, SPEC-002 named the tables and
the specs named every missing column, so migrations 0012–0014 materialised names that already existed in
the specifications. Here there is no name to materialise: a table with columns `actor_kind`, `outcome`,
`request_id`, `refusal_code`, `traceparent` would be *designed by this node* and presented as an
implementation of a contract, and the transition table would be the audit spine of the entire system —
SPEC-001 SM-2/SM-3 make an audit record mandatory for every transition, so its shape decides what the
system can prove.

**Two of the gaps are CONTRADICTIONS, not omissions, so no additive migration can fix them.** A survey
of every request/response field in §5.4–§5.16 against the delivered schema found ~29 fields with no
plausible column. Six of the most consequential were verified by hand against the migration text, and
two of those are cases where an existing column CANNOT hold the contract's value whatever is added:

| # | Contradiction | Verified at |
|---|---|---|
| 1 | SPEC-003 §5.6.1/§5.6.4/§5.13.1 carry a **date-string** `policyVersion` (`"2026-01-15"`) that the request must match and the response must echo, while the delivered schema stores versions as **integers** in both `jurisdiction_policy.version` and `policy_decision.policy_version`, under `UNIQUE (tenant_id, jurisdiction, version)`. There is no additive fix: a second date column would be a second version concept, and the two would disagree about which version is in force. | `0004_policy_and_action.sql:28,58` |
| 2 | SPEC-003 §5.9.1's `claimedOutcome` vocabulary is `DELETED`/`NOT_DELETED`/`UNSPECIFIED`, and `controller_response.claimed_outcome` is typed **`truth_state`** — the enum of the eleven canonical states, which contains none of those three tokens. The column's own comment reads "claimed_outcome is a CLAIM. Nothing in this schema may move a case to a [truth state]" while the type IS a truth state. This is the collapse VG-VERIFY-004 forbids, built into the schema. | `0004_policy_and_action.sql:122,131` |

Three further type/CHECK mismatches were verified and are fixable only by widening a constraint, which
changes the semantics of a delivered column: `external_action.status` cannot store the contract's
`FAILED` (`CHECK (status IN ('PREPARED','SUBMITTED','AMBIGUOUS','REFUSED'))`, `0004:76`);
`mail_piece.delivery_status` cannot store `ACCEPTED` or `IN_TRANSIT` (`0004:103-104`);
`evidence_artifact.redaction_state` cannot store `UNREDACTED` or `DLP_SCRUBBED` (`0005:12`). And
`deadline.derivation_ref` is `CHECK (derivation_ref LIKE 'policy:%')` (`0004:117`), so §5.13.2's
`source: "CONTROLLER_STATED_DATE"` is **unrepresentable by construction** — that column exists to prove
a deadline derives from a policy version, which is the opposite of an out-of-band controller-stated date.

The remaining ~23 gaps are ordinary missing columns (`source_record.discovery_run_id` and
`.assessment_state`; `request_case.recipe_id`; `external_action.recipe_id`/`.recipe_version`; path
identifiers on `verification_observation`; `reappearance.observation_method`; evidence FKs on
`controller_response` and `deadline`; `deadline.satisfied_by`; `audit_event.actor_kind`/`.outcome`/
`.request_id`/`.refusal_code`/`.traceparent`), plus the seven missing tables above.

**Action taken, per M6's own instruction** ("stop at `NODE_BLOCKED` for this milestone with the two
blocking references named, and record the exact prerequisite"): §5.4–§5.16 are recorded
`NODE_BLOCKED — BLOCKED_PREREQUISITE (specification)`, and **the 51 routes are not implemented**. The 27
routes that are implemented (§5.1, §5.2, §5.3, §5.17) are complete, verified against real PostgreSQL, and
unaffected.

**The prerequisite, stated so it can be actioned:** SPEC-002 §2 must be extended from 12 declared tables
to the full set the contract needs — at minimum a transition-history table (carrying transition code,
from/to truth state, command, actor, correlation id and evidence ids), a discovery-run aggregate with
per-source outcomes, a human-gate record, a reconciliation record, a readback record, an integrity-check
record, a coverage-report record, a webhook-binding table, and the actor-kind/outcome/request-id columns
on `audit_event`. Alternatively SPEC-003 §5.4–§5.16 should be reduced to the surface the domain model can
actually express. **Neither is a code change in this repository, which is why this node cannot make it.**

### 3.19 `COMMANDS.md` names the wrong interpreter for the RLS generator

`COMMANDS.md` line 184 declares `sh scripts/generate-rls.ts --write|--check`. `scripts/generate-rls.ts`
is TypeScript run by Node's native type stripping; `sh` interprets it as shell, and because the file
begins with `/**` the shell expands `/*` as a glob and then executes the matched path — observed as
`/LICENSE.txt: line 2: syntax error`. The gates call it correctly (`node scripts/generate-rls.ts
--check`, in `gate-data.sh`), so nothing is broken; the documentation is. **Not fixed in this node**,
because `COMMANDS.md` is a binding declaration and correcting it is a separate deliberate change.

### 3.20 The verification ledger was NOT recording the contract suites, and carried 27 unattributable PASS rows

Found while checking two scripts that disagreed about how many tests exist (`test-unit` reported 500,
`refresh-verification-state` reported 411). Both numbers were right for their own suite sets; the
difference exposed a defect in the DOD evidence machinery.

**Defect 1 — `tests/contract/**` was in neither glob list.** `scripts/refresh-verification-state.ts`
derives `TEST_LEDGER.jsonl` and every `DOD_STATUS.jsonl` evidence string from the suites it runs, and its
two glob lists named `tests/domain/**`, `tests/harness/**`, `tests/architecture/**` and `tests/db/**` —
never `tests/contract/**`.

Measured consequence: `TEST_LEDGER.jsonl` contained **zero** rows whose suite began `tests/contract/`.
The entire contract root — 189 tests including `token-validation` (33), `tenant-resolution` (12),
`idempotency` (28), `error-mapping-parity` (16), `error-envelope`, `route-registry`,
`filter-strictness`, `pagination` and `source-routes` — **could not influence `DOD_STATUS.jsonl`**. A
regression in token validation or in tenant binding would have left every DOD row exactly as it was.

Fixed: the root is added to both lists. It is pure (specification files, `node:*`, relative imports), so
it needs no database and belongs in the non-`--with-db` set. The ledger went from 411 rows across 19
suites to **600 rows across 28 suites**, and the DOD summary did **not** change
(7 PASS / 14 PARTIAL / 20 NOT_STARTED / 1 EXTERNAL_REQUIRED of 42) — the new coverage confirmed existing
statuses rather than upgrading any, which is the outcome that matters for honesty.

**Defect 2 — 27 unattributable `PASS` rows survived every refresh.** Each was
`{"test_id":"UNIT-","suite":"","name":"","status":"PASS","evidence_path":"tests/"}`, recorded under an
earlier epoch. The preserve rule keeps any row whose suite was not re-run, and an empty suite is never in
`suitesSeen`, so they were kept in perpetuity and inflated the ledger's pass count. They named no suite,
no test and no file, so nothing could ever re-verify or refute them.

Fixed: a row naming no suite is no longer preserved. The distinction is the point — a row naming a suite
is a claim that can be RE-VERIFIED next run, which is why preserving it is honest; a row naming nothing
is an unfalsifiable claim, and a ledger of observed results is exactly the wrong place for one. The
ledger is now 600 rows, **0 unattributed**.

Both are the same class of defect as a gate that stops checking: evidence kept being produced, and its
scope quietly stopped covering part of the system.

### 3.21 The first audit append exposed a flaky test that asserted on a GLOBAL row count

`test-integration` failed once and then passed on re-run. The failure was a single test —
`postgres-runner.test.ts`'s "the audit table is append-only through the runner too" — with
`AssertionError: audit rows must survive an UPDATE and DELETE through the runner`. Root cause:

```ts
const before = asTenant(ownerDsn(), TENANT_A, 'SELECT count(*)::text FROM audit_event;');
// …UPDATE all rows, DELETE all rows, through the runner…
const after  = asTenant(ownerDsn(), TENANT_A, 'SELECT count(*)::text FROM audit_event;');
assert.equal(after[0], before[0], 'audit rows must survive an UPDATE and DELETE through the runner');
```

**A global row count is a SHARED FIXTURE, and asserting on one is really asserting about every other test
running beside it.** `node --test` runs the database files in parallel, so the moment
`tests/db/audit-sink.test.ts` began appending real audit rows the count grew mid-test and the assertion
failed — intermittently, and with a message that named the wrong cause. It had held until now only
because **nothing in this project had ever appended an audit row**, so the count was stable by accident
rather than by design. This is the same coupling that made the `Run`-suffixed fixture names necessary in
§3.7, in a different guise.

Fixed by asserting what VG-DATA-004 actually means, which is also STRONGER than before:

| Assertion | Before | After |
|---|---|---|
| the DELETE removed nothing | `after === before` — breaks under any concurrent append | `after >= before` together with `before > 0`; a working DELETE takes the count to 0 so it is still caught, and an empty table can no longer make the check vacuous |
| the UPDATE changed nothing | `assert.equal(tampered.status, 0)` — asserted the COUNTING QUERY RAN, so it would pass even if every row had been rewritten | `count(actor = 'tampered-by-runner') === 0` |

**A second lesson, about reading a test report.** I first read the transcript's outer `✖` line
(`✖ the tenant-scoped runner and the raw-owner path agree about the fixture`) as a second failing test and
began investigating a concurrency problem with `protected_subject`. It is the SUITE-level marker that a
child failed; the fixture test itself printed `✔` one line above. The fixture was verified intact
afterwards (1 subject per tenant; references `subject-ref-alpha` / `subject-ref-beta`), so that
investigation was unnecessary — but the check that resolved it is worth repeating: read the child lines,
not the parent summary.

Verified by three consecutive full runs of `tests/db/**`: **147 tests, 147 pass, 0 fail**, exit 0 each time.

### 3.22 The §5.14 suite failed as a whole while passing alone: three defects in one new test file

`tests/db/appeal-escalations.test.ts` passed 12/12 on its own and made `test-integration` fail **8 tests**.
Three separate causes, all in the new file, and the third is the one that explains the confusing symptom.

**1. `IDEMPOTENCY_KEY_REUSE`: the suite passed exactly once.** Keys were built from a counter
(`appeal-db-key-000001`, …) that restarts at 1 in every process, while `http_idempotency` retains a
completed key for 24 hours. The second run presented keys the first run had used — with a DIFFERENT body,
because the helper mints a fresh `artifactIds` UUID per call — and the store refused them exactly as
SPEC-003 §4.3 requires. **This is `ASSUMPTIONS.md` §3.7's defect class repeated**, and it explains the
symptom precisely: `test-integration` runs the suite TWICE per invocation (once through the collection
guard, once directly), so the guard's run failed and the run after it passed on identical code. Fixed with
a per-run random suffix. Verified: three consecutive standalone runs at 12/12.

**2. A cleanup whose result was ignored left state behind, making the suite order-dependent.** The
`APPEAL_WINDOW` tests inserted a `deadline` row and deleted it with an `exec` whose return value nobody
checked. Two such rows survived across runs, and a third test asserted "the fixture must have no appeal
window, or this test proves nothing" — so it failed because of a previous run, not because of the code
under test. Fixed by clearing at the START of each window test, running as the OWNER, and ASSERTING both
the delete and the resulting count. The tests now assert their own premise instead of inheriting it.

**3. `column "artifact_ids" is of type uuid[] but expression is of type text[]` — a 500 that silent
logging hid.** `appeal_escalation.artifact_ids` is `uuid[]`, not `text[]`. The route reported
`INTERNAL_ERROR` because a query error class the handler does not map becomes a 500, and the test suite's
`logLevel: 'silent'` meant the cause had to be recovered by calling the adapter directly. Two lessons:
**`information_schema.columns.data_type` reports only `ARRAY` for any array** — the element type is in
`udt_name`, so the earlier column inventory could not have caught this; and a new route's first
integration failure is worth isolating through the adapter, because the envelope is deliberately opaque.

**A methodological note on the order I found these.** I diagnosed 3 first (by calling the adapter
directly), fixed it, and the suite went to 12/12 — so I nearly concluded the integration failure was
caused by the deadline leftovers alone. Running the suite TWICE, which is what `test-integration` actually
does, is what exposed cause 1. A suite that passes when run once after a fix has not been shown to pass
twice, and this project's database suites are invoked twice per gate invocation.

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
| 9 | A §5.3 handler read the current ETag with a token holding only `vg.sources.write`. The `GET` was refused `403`, `headers['etag']` was `undefined`, and `If-Match: undefined` was correctly rejected `412`. | A real concurrency refusal appearing two steps from its cause; the test looked like a bug in the precondition logic. | A `currentEtag()` helper that ASSERTS the read returned `200` with a well-formed token, so a scope mistake fails at the read — see §3.13's suite. |
| 10 | Two modules declared different `IdempotencyRequirement` unions, and the composition root passed `requirementFor: () => undefined`. | Every effect-bearing route ran with idempotency OFF while the registry said `required`; wiring it through would have made the public health routes demand a key. | Recorded in §3.15; the plugin now understands the registry's `'none'` and the composition root reads the registry. |

Verified clean and requiring no change: the dependency chain matches `.agent/GRAPH.md`
for all 11 nodes; every node lists `COMMANDS.md` in its audit list; `verify: ok` is
disclaimed by every node and claimed exactly once, inside EP-010's ship gate; all 11
have 14 sections, all nine milestone keywords matching their milestone count, and zero
checked progress boxes (91 milestones total).

**Not covered by this review:** the *technical correctness* of each plan's proposed
implementation, and whether the specifications themselves are internally consistent.
This review checked cross-node consistency only.
