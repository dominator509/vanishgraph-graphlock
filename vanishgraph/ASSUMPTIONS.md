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

### 3.19-bis `COMMANDS.md` names the wrong interpreter for the RLS generator

*(Numbering collision, recorded rather than silently renumbered: this heading was also written `3.19`, and
both it and the §3.19 above are referenced by no other document, so the earlier one keeps its number and
the later one is suffixed. See §3.26.)*

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

### 3.23 §5.13's deadlines: three specification readings chosen, and one output-format discrepancy

Implementing §5.13 (migration 0016, 3 routes) required three readings the specification does not settle. Each
is recorded here as a CHOICE with its reasoning, not presented as a specification requirement.

| Question SPEC-003 leaves open | Reading taken | Why |
|---|---|---|
| §5.13.1 requires "every deadline names the policy version and rule code it was derived from", but never says which record supplies them | the case's own `PolicyDecision`: `policyVersion` ← `policy_version`, `ruleCode` ← `legal_basis` | It is the only source of versioned policy data already bound to the case, it needs no new column, and a second policy lookup could disagree with the decision the case was actually authorised under. VG-POLICY-001's rules ARE legal-basis tokens — the seeded policy's `rules` array is `['CCPA_DELETE']`. A test mutates the decision and asserts `derivedFrom` follows, so the value is proven to come from data rather than hard-coded |
| §5.13.1's `state` admits `WAIVED`, and no route waives a deadline | `state` is DERIVED on every read, and `WAIVED` is unreachable | Three of the four values change with the clock, so a stored copy would go wrong without anyone writing to it. Producing `WAIVED` needs a waiver fact no specification defines; the derivation is asserted never to return it across a grid of inputs, so an invented waiver would fail a test rather than appear silently |
| §5.13.2's `source` versus SPEC-001 §3.4's `Deadline.source` | a NEW column `derivation_input`, while `derivation_ref` keeps its `policy:%` meaning | EP-003's mapping table (`.agent/execplans/EP-003-node.md:130`) already spends the word `source` on "the policy version this deadline derives from". §5.13.2's `source` is a different fact — the out-of-band INPUT the date came from — so one word does not get two meanings in one table, and neither delivered constraint needed relaxing |

**The output-format discrepancy, recorded rather than smoothed over.** SPEC-003's examples show
`policyVersion: "2026-01-15"` in §5.6.4, §5.13.1 and elsewhere, while `jurisdiction_policy.version` and
`policy_decision.policy_version` are **`integer`** (migration 0004) and no specification states the version's
type or format — SPEC-001 §3.3 gives `JurisdictionPolicy` a bare `version` field. §5.13 only REPORTS the
version, so rendering the stored number as a string (`"1"`) satisfies the field's type and contradicts nothing;
a caller comparing against the example's date shape will see `"1"` and should know why. **§5.6 is different
and remains blocked**: §5.6.1 takes `policyVersion` as an INPUT that must be matched against the stored
version, and `"2026-01-15"` cannot be matched to `1` without either changing the API or adding a second
version concept to the schema.

**§5.13.2's `DEADLINE_SOURCE_REQUIRED` uses a closed set of ONE** (`CONTROLLER_STATED_DATE`), because it is
the only token any specification names. The alternative — accepting any string — would store a source token
the response then reports and no specification defines. Same reasoning as 0015's review-state CHECK.

### 3.24 Two of my own test files collided on one fixture table, in three distinct ways

`tests/db/deadline-provenance.test.ts` and `tests/db/appeal-escalations.test.ts` both operate on the seeded
case's `deadline` rows, and `node --test` runs the files in PARALLEL. Three separate defects, each fixed, and
the third is the one that took longest to see:

1. **The deadline suite created `APPEAL_WINDOW` rows that the appeal suite deletes.** The appeal suite scopes
   its fixture surgery to `kind = 'APPEAL_WINDOW'` on the seeded case — it must be able to assert "this case has
   no appeal window" for its `APPEAL_WINDOW_CLOSED` tests — and the deadline suite's default created exactly
   that kind. Fixed by giving the deadline suite a default kind (`MAIL_RESPONSE`) that the other file never
   touches: a suite that needs a shared table must pick the part of it nobody else owns.

2. **An unscoped `DELETE` in the appeal suite reached another file's data.** `DELETE … WHERE case_id = … AND
   kind = 'APPEAL_WINDOW'` looked correct in isolation and deleted the deadline suite's rows mid-test. Now
   scoped to the `derivation_ref = 'policy:test'` marker this suite writes, so leftovers from its OWN earlier
   runs are still cleared while rows belonging to another file are not.

3. **An absolute-count assertion reported the collision as an unexplained `2 !== 1`.** `addAppealWindow`
   asserted the table held exactly one appeal window, which a single leftover row from an earlier run made
   false — and the failure message was true but silent about which row the extra one was. It now asserts a
   DELTA: the count before the insert plus one. A helper is responsible for its own insert landing, not for
   the total contents of a shared table.

**What worked as designed:** the appeal suite's premise assertion
(`anyAppealWindows() === 0`, "the case must have no appeal window for this test to mean anything") failed
LOUDLY with `1 !== 0` when a leftover row existed, instead of letting the test pass for a reason it did not
control or surface as a confusing `APPEAL_WINDOW_CLOSED`. That assertion was added one round earlier for
exactly this, and it is what identified defect 3's cause. This is the same shared-fixture class as §3.21's
global audit count and §3.22's idempotency keys, and the general rule is now stated three times: **a test may
only assert on state it created or explicitly cleared.**

Verified after the fixes: two consecutive `test-collection-guard` runs and two consecutive `test-integration`
invocations, all at 170 tests, 0 failures.

### 3.25 An HTTP pagination walk was IMPOSSIBLE for every collection route, and §5.15's audit fields

Two findings from implementing §5.15 (migration 0017, 2 routes).

**The pagination defect — found only by walking pages over HTTP against a real table.** `parseQuery` treated
`limit` and `cursor` as FILTER members, because each route's schema spreads `PAGINATION` into `parameters` and
the parser then walked every declared parameter. Two consequences, the second fatal:

1. `page.filter` echoed the caller's `limit` and `cursor`, so the applied filter was not a filter.
2. **A cursor could never validate on the next request.** A caller binds a cursor to
   `filterHashOf(parsed.filter)`, and a continuation request carries `cursor` in its raw query — so page 2
   hashed a DIFFERENT filter from the one page 1 minted against, and every continuation failed with
   `400 INVALID_CURSOR`. Measured: the two parsed filters differed by exactly the `cursor` member.

So **pagination over HTTP was impossible for every collection route** — §5.1, §5.3, §5.4, §5.11, §5.16 and
every future one — and it went unnoticed because the suites that walk many pages drive the cursor HELPERS
directly, while each route was only ever fetched one page at a time. It surfaced the first time a suite
paginated through a route: §5.15's audit walk, with `limit=1` over five events sharing one instant.

Fixed by skipping the two controls in the parameter loop, and pinned at the parser level by a test asserting
that the normalised filter contains neither — a cheap, deterministic regression test for a defect whose route
level symptom needs a database. `limit` is still applied; it is skipped from the FILTER, not ignored.

**§5.15's five extra fields.** SPEC-001:96 gives `AuditEvent` seven fields; §5.15.1 reports those plus
`actor.kind`, `requestId`, `outcome`, `refusalCode` and `traceparent`. They are stored as columns (0017) and
supplied by the APPEND path as request metadata rather than added to the domain entity, because three of them
are transport facts — the request's id, its W3C trace context, and how it was refused — and the entity's value
is that it is pure. Two readings are recorded as choices: `outcome` is checked against **SPEC-007 §285's five
tokens** (`SUCCEEDED, REFUSED, FAILED, AMBIGUOUS, GATED`) rather than §5.15.1's two, because that is the
normative source and the narrower example is a subset; and **`actor.kind`'s vocabulary has NO normative source
anywhere** — `HUMAN|SERVICE|SYSTEM` appears only inside §5.15.1's example body — so its CHECK is built from an
example, and every append today records the default `SERVICE` because the actor is the constant
`domain-command`.

**Two registry rows had no enforcement at all.** `TIME_RANGE_REQUIRED` and `TIME_RANGE_TOO_WIDE` were
enumerated in SPEC-003 §8.2 and present in the registry, and **no code path threw either** until §5.15.1's
requirements were declared on `AUDIT_EVENTS_QUERY` as `requireTimeRange`/`maxSpanDays`. Both are now produced
by the parser, so the refusal cannot drift from the route's declaration.

**A recurring mechanical cost, recorded as a follow-up.** Adding one required port to `ServerDependencies` has
now forced edits at ~10 construction sites in four consecutive rounds (§5.3, §5.14, §5.13, §5.15), twice
including a per-file import insertion. The right fix is a single `testServerDependencies(overrides)` builder in
`tests/contract/server-support.ts` so a new port costs ONE edit. It is not done here because migrating ten
call sites late in a round would be a large diff in tests this round cannot fully re-verify; it is recorded so
the next round does it deliberately rather than discovering the churn again.

### 3.26 §5.10/§5.11's four read routes, and a keyset defect that made a paginated walk return a row twice

Four routes implemented from SPEC-003 §5.10.2, §5.10.3, §5.11.2, §5.11.3, taking coverage from **35 to 39
of 78**. Migration `0018_observation_paths.sql` is additive for the same reason as `0012`–`0017`: SPEC-003's
bodies name fields SPEC-002 §2's schema has no column for. Five findings, each measured.

**1. `finding`'s column vocabulary and its API vocabulary are DIFFERENT, and nothing mapped between them.**
`verification_observation.finding` is `CHECK (finding IN ('PRESENT','ABSENT','INCONCLUSIVE'))`; §5.10.2's
wire DTO reports `RECORD_PRESENT | RECORD_ABSENT | INDETERMINATE`. My first fixtures wrote the API tokens
into the column and the insert was refused by the constraint — which is how the mismatch was found. The
mapping is now a declared, frozen `FINDING_TO_API` table with a `toApiFinding()` that THROWS on an unmapped
value. It throws deliberately: the shape `?? 'INDETERMINATE'` would have converted a future schema drift
into a plausible wire answer, and "no record" is exactly the answer an operator must not receive by
accident.

**2. `REAPPEARANCES_QUERY` had drifted from §5.11.2 before the route existed.** The filter schema declared
fields §5.11.2 does not accept, and `sortFields` did not include `observedAt`. Found by diffing the
declaration against the spec body rather than by a failing test — no test could fail, because the route had
no handler. Corrected to §5.11.2's own list: `subjectId`, `sourceId`, `reEntryState`,
`sortFields: ['observedAt']`, `defaultSort: 'observedAt:desc'`, `timeFilterable: true`.

**3. A KEYSET CURSOR REPEATED THE ROW THAT MINTED IT — a driver-precision defect, not a query defect.**
`pg` returns a `timestamptz` as a JS `Date`, which has MILLISECOND precision, while PostgreSQL stores
MICROSECONDS. A cursor minted from a row at `…:00.123456` therefore carried `…:00.123Z`, and page 2's
predicate `observed_at > '…:00.123'` was **TRUE for that very row** — it came back on the next page. At a
different boundary the same mismatch SKIPS a row instead of repeating it. Fixed by applying
`date_trunc('milliseconds', …)` to BOTH the comparison and the `ORDER BY`, so the ordering key is exactly
what a cursor can carry and ordering and pagination cannot disagree; rows inside one millisecond are
separated by the `id` tiebreaker, which is what it is for.

It was found by the §5.11.2 HTTP walk in `tests/db/observation-reads.test.ts`, and it survived every
earlier suite for a structural reason worth recording: the existing pagination tests drive the cursor
HELPERS over synthetic rows whose timestamps are already millisecond-aligned, so the truncation was a
no-op in every one of them. The test now asserts that each row is seen **exactly once** across the walk,
not merely that each page is non-empty. **The identical defect was present in `subjects.ts`** (the §5.1
location-history collection) and is fixed the same way in the same commit.

Two adapters were checked and deliberately NOT changed, with the reason recorded rather than assumed:
`audit-queries.ts` orders on `audit_event.at`, which the append path writes from an integer millisecond
value, so the stored value is ms-exact today; and `sources.ts` orders on `name` (text) with
`permission_checked_at` written from a caller-supplied ms value. Neither is lossless BY CONSTRUCTION the way
the fixed pair is, so if a future node writes either with sub-millisecond precision the defect returns. This
is recorded as an open hazard, not as a proof of correctness.

**4. The coverage number has a measured instrument, and I quoted it loosely before using it.** The count in
this section comes from running the declared `node scripts/route-coverage.ts`, which asks the built server
what paths it registered and diffs that against the registry: `39 of 78`, with the 39 missing grouped by §5
group. An ad-hoc recount I ran first — a regex over each module's `*_ROUTE_TEMPLATES` array — reported 26 and
was wrong, because `audit.ts` declares its array on a single line and the regex counted 0 of its 2 entries.
The lesson is the same shape as §3.12's: **an instrument that silently undercounts produces a number that
reads as a measurement.** Use the declared script; if a count is quoted, say what produced it.

**5. `ASSUMPTIONS.md` itself carried a duplicate section number.** Two headings were both `3.19`. Nothing
references either, so the earlier one keeps its number and the later is now `3.19-bis` with the collision
stated in place. A record whose section numbers collide cannot be cited reliably.

### 3.27 The transition spine: a typed home for what SPEC-003 §5.5.5 must read back — and four defects it exposed

**The conflict, and the resolution taken.** §3.18 recorded a three-way specification conflict: SPEC-001:96 gives
`AuditEvent` seven fields with no transition code and no from/to state, SPEC-002:26-27 forbids `jsonb` for
"values needing integrity (state, authority, digests)", and SPEC-003 §5.5.5 requires exactly those facts. The
blocked set was every route that must READ a transition back: §5.5.5, §5.7.3's `lastTransition`, §5.7.6's
timeline, and the `transitionId`/`transitionCode` fields in nine write bodies.

**Migration `0019` adds four TYPE'd columns and one foreign key to `audit_event`** — `transition_code`,
`from_truth_state`, `to_truth_state`, `evidence_artifact_ids` (each `uuid[]`, CHECKed non-empty) and `case_id`.
Recorded here as a reading, with what it does and does not rest on:

  * It **keeps EP-003's own decision** (`.agent/execplans/EP-003-node.md:132`): `audit_event` IS the append-only
    record of a transition. No second table is invented, so nothing about the audit spine's identity changes.
  * It **satisfies SPEC-002 §1 rather than working around it**: the states are stored in the existing
    `truth_state` enum — "truth states use a dedicated enum of exactly the eleven SPEC-000 §5 values" — and
    `jsonb` keeps its permitted use for recorded bases and provider payloads.
  * It **inherits two properties a new table would have had to re-earn**: the `CREATE RULE … DO INSTEAD
    NOTHING` append-only rules and the FORCE RLS `tenant_isolation` policy already apply to the row, so a
    transition fact cannot be rewritten, deleted, or read across a tenant. `db/tenant-scoped-tables.txt` is
    unchanged and `check-rls-coverage` still passes.
  * **The residual risk, stated:** if the specification owner prefers a separate transition aggregate, the
    read model is behind ONE port (`src/application/contracts/transition-queries.ts`), so the change is
    contained to that adapter and one migration that copies the columns out.

**`case_id` IS NOT `target_id`, and collapsing them loses history.** The seed states the convention for
`target_kind`/`target_id` (`db/seed/prior_release.sql:57`): T5 is recorded against `RequestCase`, T8 against
`ExternalAction`, a registration against `ProtectedSubject` — the target is WHAT WAS ACTED ON. But §5.7.3 and
§5.7.6 read a CASE, and a T8 whose target is an external action would be missing from them if a case's
transitions were found by `target_kind = 'RequestCase'`. So the case is a separate typed FK, and an exposure's
history unions its own transitions with those of the cases derived from it through `request_case.exposure_id`.

**A one-event-per-transition rule, enforced.** The append path REFUSES a transition supplied with a batch of
more than one audit event: writing the same transition code onto several rows would make one state change
appear as several in §5.5.5, which is the read a reviewer uses to check legality against SPEC-001 §4.1.

**Four defects this work exposed, all fixed:**

| # | Defect | Evidence it was real |
|---|---|---|
| 1 | **The audit sink refused the service's OWN correlation ids.** `installCorrelation` mints `randomUUID().replace(/-/g,'')` (32 hex, no dashes) and honours a W3C `traceparent`'s trace id, while the sink required a canonical UUID — so the FIRST write route to append an audit row answered `500 INTERNAL_ERROR`. Every effect-bearing route would have done the same. | `AuditUnavailableError: correlationId "22ecea…" is not a UUID`, reproduced end-to-end through `app.inject` before the fix. The two forms are the same 128 bits, so the sink now stores the canonical rendering and still refuses any other shape. |
| 2 | **The seeded `confidence_basis` could not be rendered by the contract that reads it.** The fixture wrote `["exact-name-match","state-match"]` — bare strings — while §5.5.1's `confidence.basis` is `{feature, weight}` objects (and §5.5.3's request requires both). SPEC-002 constrains only that the array is non-empty, so the row was schema-valid and contract-unrenderable: the §5.5.1 list answered 500 for anything holding it. | The strict reader refuses instead of inventing a weight (VG-IDENT-003), and `tests/db/exposure-transitions.test.ts` pins that refusal with the malformed row. The fixture now uses the contract's shape, and a live-database alignment was applied because provisioning is idempotent and does not re-seed. |
| 3 | **Migration `0020`'s backfill could not see a single row.** `exposure` carries FORCE RLS, which applies to the table OWNER, so `UPDATE … FROM source_record` under the migrator ran with `app.tenant_id` unset — `tenant_id = NULL` is not true, so no rows matched and the following `SET NOT NULL` failed with "contains null values". | The failure itself. Fixed with a per-tenant `set_config` loop inside a `DO` block, and `set_config('app.tenant_id','',true)` afterwards so a later statement in the same migration cannot run with the last tenant's scope. |
| 4 | **Migration `0020` then forbade the project's own fixture.** It added the two observation instants NOT NULL with no DEFAULT, and `db/seed/prior_release.sql` inserts an exposure without naming them: a fresh provision would have failed at the seed. The live database hid it because provisioning is idempotent. | Reasoned from the seed text and fixed in `0021` (`SET DEFAULT now()`), because a migration that is applied is immutable (DOD-040). |
| 5 | **The state file `C:\tmp\vanishgraph-db.env` grew to 2 MB, and every gate that sourced it died with `Argument list too long`.** `provision.ts` writes `export VG_DB_STATE_FILE=${JSON.stringify(path)}`, which is CORRECT for its consumer — a POSIX `sh` dot-source unescapes `"C:\\tmp\\…"` back to one separator. The corruption came from a PowerShell loader that copied the raw double-quoted value back into the process environment: the next provisioning round trip re-escaped it, and because Windows accepts repeated separators the SAME file kept being rewritten with twice as many backslashes each time. | `line 4 is 2097201 chars`; measured after `sh scripts/test-unit.sh` began failing with `/c/Program Files/nodejs/node: Argument list too long`. The file's line 4 is restored, and the loader in this session now unescapes `\\` and pins the path literally. **The general lesson is the one already recorded in §3.26:** a tool that parses another tool's output must be shown to round-trip it, and this file is written for `sh`, not for a regex. |

**Fixture discipline, one more time (§3.24's class, third occurrence).** The first version of this suite built its
worlds inside the SEEDED tenant A, and three other db suites assert that tenant A has exactly one seeded subject
(`postgres-runner.test.ts:321`, `rls.test.ts:101`, `route-catalogue.test.ts:127`) — so five tests in other files
failed the first time this suite ran inside `test-integration`. The suite now creates two tenants of its own per
run, which is also what makes its isolation assertions independent of the seed. Removing the residue required a
scoped cleanup whose first attempt matched the SEED's own `subject-ref-alpha` — refused by
`request_case_exposure_id_fkey`, i.e. the schema stopping a cleanup from eating the fixture every other suite
depends on — and whose second attempt hit `authority_grant_subject_id_fkey` by deleting a subject before its
grant. Both refusals are recorded because they are the argument for keeping fixtures marked and scoped rather
than globbed.

**The instrument was overstating coverage, and that is corrected too.** `scripts/route-coverage.ts` counted
REGISTERED handlers, and five of the routes counted as implemented refuse every request with an unconditional
`503 DEPENDENCY_UNAVAILABLE` (§5.1.1 creation, §5.1.4 update, §5.1.7 identifier capture, §5.2.1 authority
minting, §5.2.3 revocation). The script now prints both numbers — registered and "has a handler that is not an
unconditional refusal" — and names the refusals, so the honest figure is **44 registered / 39 working of 78**.
Earlier rounds' claims that "§5.1 and §5.2 are implemented and verified" were true of the ROUTES' boundary
behaviour and false as coverage; the correction stands in the ledger too.

### 3.28 What EP-004 M6 still cannot do, after the transition spine landed

With transitions readable, the remaining blockers are narrower and each is named with what is missing:

| Group | Routes | What is still missing |
|---|---|---|
| §5.4 discovery runs | 5 | `DiscoveryRun` is defined by no specification (§3.17). Unchanged. |
| §5.6 policy decisions | 4 | `policy_decision.exemption_evaluation` and `jurisdiction_policy.policy_checksum` are additive columns. **`policyVersion` remains a CONTRADICTION**: the contract carries a date string, the schema stores integers (§3.19-bis's table). §5.6.1 takes it as INPUT that must be matched, so it needs an owner decision, not a migration. |
| §5.7 cases | 6 | Read routes implementable now; §5.7.5 also needs a HumanGate record, and 5.7.4/5.7.5 need the guarded-transition wiring. |
| §5.8 external actions | 6 | A reconciliation record and a readback record (5.8.3, 5.8.4). |
| §5.9 controller responses | 3 | `controller_response.claimed_outcome` is typed `truth_state` while the contract's tokens are `DELETED|NOT_DELETED|UNSPECIFIED` (§3.19-bis). 5.9.2/5.9.3 are otherwise implementable. |
| §5.10.1, §5.11.1 | 2 | Now implementable: both return `transitionCode`, and the spine answers it. |
| §5.12 evidence artifacts | 5 | An integrity-check record; object storage is `BLOCKED_CREDENTIALS` (S3_*). |
| §5.16 coverage reports | 3 | A coverage-report aggregate, and coverage is produced by the undiscoverable discovery runs. |
| EP-004 M7 webhooks | 3 | A `webhook_binding` table; the replay store needs `VALKEY_URL`, for which M7 declares a durable-file fallback. |

### 3.29 The §5.7 case group: one schema conflict, one shared pagination defect, and two declared implementation choices

**§5.7 implemented (6 routes: 5.7.1–5.7.6).** Migration `0022` adds `request_case.recipe_id`, the `human_gate`
table (SPEC-001 names `HumanGate` as a canonical entity; no specification gives it a field list, so the columns
are exactly what §5.7.5's request and response require) and a partial unique index that makes "one LIVE case per
subject × source × exposure" a database rule rather than a handler convention. Migration `0023` is the conflict
below. Route coverage is measured, not assumed: `node scripts/route-coverage.ts` → **50 registered / 45 working
of 78**.

**1. A CONTRADICTION between the contract and the schema, resolved by widening the schema.**
§5.7.1's request body names a `policyDecisionId` at the moment it CREATES the case, and its refusal list
includes `422 POLICY_DECISION_INCOMPLETE`. SPEC-002 §2 declares `policy_decision.case_id uuid NOT NULL`, so
under the delivered schema every decision already belongs to a case — a decision offered at creation could only
belong to a case that does not exist yet. Either §5.7.1 is unimplementable, or a decision may exist before its
case does. `0023` drops that NOT NULL and recreates the foreign key `DEFERRABLE` (matching
`request_case.policy_decision_id`'s existing deferred FK), so a decision can be resolved and then bound by the
same transaction that creates the case. **Why this side moved:** it changes the meaning of no stored value — a
decision with `case_id IS NULL` is simply unbound — whereas the alternative (accepting a decision that belongs
to a DIFFERENT case) would put a case and a decision together that the policy engine never resolved as a pair,
which is the association VG-POLICY-001/002 exist to keep truthful. `tests/db/case-lifecycle.test.ts` asserts a
bound decision offered for another exposure is refused `POLICY_DECISION_INCOMPLETE`.

**2. A SHARED PAGINATION DEFECT: a time-filterable collection could not be paginated at all.** §2.6 gives
`from`/`to` an optional default (the last 30 days) on time-filterable routes, and the default is resolved
against the clock at parse time. A cursor is bound to a hash of the normalised filter, so page 1 and page 2
normalised to windows a few milliseconds apart, hashed differently, and **every continuation failed
`400 INVALID_CURSOR`** — for §5.5.1, §5.7.2, §5.11.2 and §5.4.2. It was invisible because every existing walk
test passes an explicit `from`/`to`, which is the one case where the default never moves; it surfaced the first
time a walk omitted the range (`tests/db/case-lifecycle.test.ts`). Fixed by carrying the window IN the cursor:
`peekCursor` verifies the signature and returns the payload before the bindings can be checked, `parseQuery`
inherits the missing side(s), and the minted cursor records the applied window — so a walk keeps the window it
started with instead of one that slides under it (which would also drop rows that aged out mid-walk). The
regression test drives two DIFFERENT clocks through the parser and the cursor, which is what makes it
deterministic rather than flaky in the direction of passing.

**2b. And the fix's first version broke page ONE, which is the same defect class one level down.** Storing the
window as two RFC 3339 strings pushed a real `/v1/reappearances` cursor past `MAX_CURSOR_BYTES` (512), so
`encodeCursor` REFUSED TO EMIT IT and the first page answered `400 INVALID_CURSOR` with no cursor in the
request — the file's own warning ("a cursor the server produces but its own decoder rejects is a pagination
that stops on page one") realised exactly. The window is epoch milliseconds now (13 characters, and the filter's
precision is milliseconds anyway) and the bound is 1024, and `tests/contract/pagination.test.ts` asserts that a
minted cursor fits the bound the decoder enforces, so the two cannot drift apart again.

**3. `guardsEvaluated.recipeSigned` GATES the transition, and it is a verification rather than a presence.**
§5.7.4 reports six guards. The domain's `prepareRequest` treats "enabled, signature present, fresh" as
`recipeSignedAndFresh` — its `assertRecipeUsableAt` has no key map and cannot verify anything — so reporting the
verification honestly beside a transition that ignored it would have let a case reach `REQUEST_READY` on a
recipe nobody verified. The port refuses `GUARD_FAILED recipeSignedAndFresh` when verification fails, which
means **a deployment with no verification key (ADR-006 OPEN) cannot prepare a request at all**. That is the
honest posture — VG-CHANNEL-003 says an unverified recipe may not authorise a write, and §5.3.7 already refuses
to CREATE such a recipe — and `tests/db/case-lifecycle.test.ts` proves both directions with a real Ed25519 key
pair: verified ⇒ T5, key map empty ⇒ refused with the row untouched.

**4. Two declared implementation choices, named as choices.** (a) **Human-gate routing has NO specification
source**: §5.7.5's response carries `humanQueue` and `serviceLevelDueAt`, its request supplies neither, and no
table of queues exists anywhere. `HUMAN_GATE_ROUTING` maps the seven gate kinds to a queue and a service level,
and both are STORED ON THE GATE ROW so a later change cannot rewrite what an earlier gate was told. The queue
depends on `gateKind` alone, so a caller cannot route its own gate to a faster queue. (b) **Case creation has no
domain command**: SPEC-001 §6 lists eleven commands and none creates a `RequestCase`, and §5.7.1 says creation
"never advances" the truth state — so the audit row is written with `action = 'CreateRequestCase'` (a constant
declared in the adapter) and `transition_code IS NULL`, which the spine's all-or-nothing CHECK requires.

**5. Two smaller readings, and one self-inflicted lesson.** `guardsEvaluated.recipeFresh`/`channelPermitted`/
`budgetAvailable` are computed from rows (the recipe's `freshness_at`, the source's `permission_class` and the
decision's channel, and the recipe's `max_attempts_per_window`/`window_seconds` window over `external_action`);
`request_case.recipe_id` is NULLABLE because cases written before `0022` genuinely have no recipe recorded. And
the lesson: my first fixture built its worlds with a jurisdiction of `US-C<run><hex>` — fourteen characters —
which the fixture's own SQL accepted and `new Jurisdiction(...)` refused inside the command, surfacing as a
`500 INTERNAL_ERROR` on the first PATCH. A domain value object validating a fixture field is the schema doing
its job; the fixture now uses a valid code and distinguishes worlds by policy VERSION.

### 3.30 §5.10.1 and §5.11.1: the two remaining observation writes, and four things they exposed

**§5.10 and §5.11 are now COMPLETE (6 routes).** Coverage measured: `52 registered / 47 working of 78`. Migration
`0024` adds `reappearance.content_hash`; the two writes run the domain commands (`recordVerification`,
`detectReappearance`) and the ports compute every guard fact from rows.

**1. `reappearance.content_hash` did not exist.** §5.11.1's request carries a `contentHash` and the delivered
table had no column for it. It matters: the digest of the content observed AGAIN is what distinguishes the same
record coming back from a different record at the same URL — the distinction VG-REAPPEAR-002 turns on. `0024`
adds it with the same shape and CHECK as `source_record.content_hash` (0003:47), NULLABLE because rows written
before it recorded no digest. The route requires it, so `tests/db/observation-writes.test.ts` asserts the stored
value equals what was submitted.

**2. `detectReappearance` named a CASE for a transition that moves an EXPOSURE.** T17/T20 move the state of the
thing observed again — the exposure, which is what §5.11.1's response reports (`exposureId`, `priorTruthState`,
`truthState`) — and a case need not exist at all: T21 reaches `SEARCH_DELISTED` from `MATCH_CONFIRMED` before any
case is created. The command's input is now `{exposureId, caseId: string | null, …}`, its audit row's target is
the exposure, and the payload records the case only when there is one. The three domain tests that called it were
updated, which is the honest cost of correcting a signature rather than working around it.

**3. The window and the independence check are COMPUTED, never taken from the caller.** §5.10.1's request carries
`windowSatisfied: {requiredSeconds, elapsedSeconds, met}`. `requiredSeconds` is the caller's REQUIREMENT and is
read; `elapsedSeconds` and `met` are recomputed from the observation instant against the action's instant, and
the caller's values are ignored — a control a caller can waive with a boolean is not a control, the same rule
§5.14's `requiresHumanReview` follows. Independence is checked against the ACTING identity and instant read from
the case's `T8` audit row, not from the request: the request supplies the observer's identity and the acting
PATH, and the row is what says who acted and when. When no `T8` row exists, independence cannot be attested and
the request is refused `OBSERVATION_PATH_NOT_INDEPENDENT` rather than assumed.

**4. Three smaller things, each recorded where it was found.** (a) `DETAILS_ALLOWLIST` had no keys for
`requiredSeconds`, `elapsedSeconds`, `required` or `supplied`, which §5.10.1's two refusal bodies name verbatim —
the same gap §3.16 records for `currentEtag`. (b) `tests/contract/error-mapping-parity.test.ts`'s
forbidden-token rule flagged `PRIOR_REMOVED_EVENT_NOT_FOUND` for containing `REMOVED`, although SPEC-003 §5.11.1
is where that code comes from and `REMOVED` there is part of the term "prior removed event"; the rule now
exempts that ONE code and asserts the exemption is genuinely declared in §8.2, so a new code with a forbidden
token still fails. (c) A NON-TRANSITION audit row cannot carry `case_id`: migration 0019's all-or-nothing CHECK
ties `case_id` to transition facts, so a refusal is linked to its case by `target_kind`/`target_id` — which is the
convention the seed uses, and which a first version of the test got wrong by querying `case_id` and finding the
fixture's own `T8` row instead of the refusal. Stated here as a property of the schema rather than fixed, because
the CHECK's job is the integrity of transition facts and `target_id` already links the row.

### 3.31 §5.9: a claim that cannot be a truth state, and the transition the TABLE chooses

**§5.9 implemented (3 routes).** Coverage measured: `55 registered / 50 working of 78`. Migration `0025` adds the
fields §5.9 requires and corrects a claim made in its first draft.

**1. `controller_response.claimed_outcome` cannot hold the contract's vocabulary.** The column is typed
`truth_state` — the enum of the eleven canonical states — while §5.9.1's `claimedOutcome` is
`DELETED | NOT_DELETED | UNSPECIFIED`, none of which is one of them. Its own comment says "claimed_outcome is a
CLAIM. Nothing in this schema may move a case to a [truth state]" while its TYPE is a truth state, so the column
could only ever store the collapse VG-VERIFY-004 forbids. `0025` adds `claimed_outcome_token` with a CHECK for the
three tokens; **the delivered column is left in place and stays NULL**, because a truth state there would assert
the very thing the field must not assert. `tests/db/controller-responses.test.ts` asserts both: the token is
stored, and `claimed_outcome::text` is NULL.

**2. THE TRANSITION CODE IS THE TABLE'S DECISION, NOT THE PROSE'S.** §5.9.1 says a REFUSAL "drives T15" and a
`NO_RESPONSE_TIMEOUT` "drives T13". That is true of the state each is normally recorded from: from
`ACKNOWLEDGED`, `→ NOT_REMOVABLE` is T15 (guard `lawfulRefusalFinal`); from `REQUEST_SUBMITTED` it is **T13**
(guard `exemptionRecorded`). Both kinds therefore produce a code DIFFERENT from the one the prose names whenever
the case is not yet acknowledged. MEASURED: my first test asserted T15 from `REQUEST_SUBMITTED` and got T13 — the
expectation was wrong, not the code. The port documents the mapping as kind → TARGET STATE, leaves the code to
SPEC-001 §4.1, and reports only what the machine produced.

**3. A timeout records its own basis; a refusal must be given one.** §5.9.1 requires a lawful recorded
`refusalBasis` for a `REFUSAL`, and a `NO_RESPONSE_TIMEOUT` "with the timeout basis recorded" — the timeout IS
the basis, and demanding one from the caller would ask them to explain an absence that is the explanation.
MEASURED: an earlier version required a basis for both and answered `422 REFUSAL_BASIS_REQUIRED` to a timeout.

**4. `EMAIL_THREAD_DUPLICATE` IS THE STRONGEST GUARANTEE THIS SHAPE ALLOWS, STATED RATHER THAN IMPLIED.** A
duplicate is a thread sharing a message id with an existing one, so the rule is an array-overlap (`&&`) check
inside the caller's transaction. No unique constraint can express "no two rows may share an array element", so
unlike §5.7's one-live-case rule this one CANNOT be pushed into the schema; `0025` adds the GIN index that keeps
the lookup bounded and says in the same comment that the index does not make the rule atomic.

**5. `deadlineDerived` is always `null`, and §5.9.3 is why.** "Recording a thread MAY derive a `Deadline` from
the applicable policy version; the API never hard-codes a deadline duration." No specification or table declares
a controller-response window — `jurisdiction_policy.rules` is a list of rule CODES, not durations — so there is
nothing to derive, and inventing a duration is exactly what that sentence forbids. The field is present and null
rather than omitted, so a client can tell "no deadline was derived" from "the field is missing".

**6. A CLAIMED DEFECT I HAD TO RETRACT BEFORE IT SHIPPED.** The first draft of `0025` also "repaired"
`email_thread.message_ids`, asserting a fifth instance of the vacuous-array class §3.6 records
(`array_length(…, 1) >= 1` passing for `'{}'`). Applying it failed with "constraint does not exist", and reading
`0010_repair_vacuous_array_checks.sql:37-39` showed it was ALREADY repaired there with `cardinality()`. The claim
was inferred from the original `CREATE TABLE` instead of checked against the current schema — the same failure of
method as §3.12's negative search, and the lesson is the same: **a claimed defect is evidence only after the
schema as it stands has been read, not after the first migration that mentions the table.**

**7. The test-wiring churn is now the FIRST task of the next round, with a number.** Adding one required port to
`ServerDependencies` has forced edits at 12–16 sites in EIGHT consecutive rounds (§5.3, §5.14, §5.13, §5.15,
§5.10/§5.11, §5.5, §5.7, §5.9). §3.25 recorded the debt and deferred it; deferring it a third time would be the
choice to keep paying it. Next round: `testServerDependencies(overrides)` in `tests/contract/server-support.ts`,
with every call site converted, so a new port costs ONE edit.

### 3.32 §5.8: a route that cannot perform its effect, three database rules that corrected me, and an instrument that lied

**§5.8 implemented (6 routes).** Coverage measured: `61 registered / 56 working of 78`. Migrations `0026`
(`reconciliation`, `readback`, action recipe/template columns, mail-piece evidence columns) and `0027`
(`external_action.status` widened, `.acting_path_id` added).

**1. §5.8.2 EVALUATES EVERY GUARD AND THEN REFUSES THE EFFECT, AND THAT IS THE HONEST STATE OF THIS
REPOSITORY.** No channel transport exists — no provider adapter, no certified-mail API, no SMTP binding — so a
real submission answers `503 DEPENDENCY_UNAVAILABLE` naming the channel, and the `dryRun` path §5.8.2 defines
("guard evaluation and payload validation are performed and reported, and no external effect is produced and no
state changes") is implemented in full and answers `200`. The guards are evaluated BEFORE the transport refusal
so a request that is illegal on its own terms gets its own code. **This route, and only this one, remains
unable to do what its name says**; the other five are complete. Claiming otherwise would be the one failure
VG-ACTION-001 exists to prevent, and the test asserts refusal AND dry-run TOGETHER so neither can regress alone.

**2. THE EGRESS FIELD ALLOWLIST HAS NO NORMATIVE SOURCE, SO IT IS A DECLARED SET.** `DATA_EGRESS_MATRIX.md`
states the rule ("default deny for `CUSTOMER_PII`, `HIGH_RISK_PII`, `IDENTITY_DOCUMENT` and `AUTH_SECRET`; use
opaque IDs, local models and redaction first") and enumerates no field names. `EGRESS_FIELD_ALLOWLIST` in the
adapter is therefore a CHOICE — the smallest set that can express §5.8.2's own example — and everything else is
`422 PAYLOAD_FIELD_NOT_ALLOWLISTED`, the fail-closed direction the matrix asks for. The NAME is allowlisted, not
the value: an allowlisted field carrying something that looks like an address is refused too.

**3. THREE THINGS THE DATABASE KNEW AND I DID NOT.** (a) `external_action.status` admitted only
`PREPARED | SUBMITTED | AMBIGUOUS | REFUSED`, so §5.8.3's `actionOutcome: "FAILED"` was unrepresentable — `0027`
WIDENS the CHECK rather than replacing any token, because rows written under the old vocabulary must stay
writable-by-repair. (b) Nothing recorded WHICH PATH ACTED, so §5.8.4's "refuse an observation path that is the
same path as the acting path" had nothing to compare against; `0027` adds `acting_path_id`, and an action whose
path is not recorded reports `independenceCheckedAgainst: null` rather than claiming an independence nobody
verified. (c) **`external_action_check` refused my first INDETERMINATE reconciliation**: the rule is
`CHECK (status <> 'AMBIGUOUS' OR ambiguous)` — "an ambiguous result must be reconcilable, never silent"
(VG-ACTION-002) — and my branch cleared `ambiguous` while leaving the outcome unknown. The constraint was right:
an INDETERMINATE finding has NOT established what happened, so the action stays ambiguous and re-reconcilable,
and what gets recorded is the escalation.

**4. A LIST CURSOR BUILT FROM A NULLABLE COLUMN.** Both new list routes ordered by `created_at` and minted their
cursor from `submittedAt` / `sentAt` — both nullable — so a cursor for an action that was prepared but never
submitted (or a mail piece that was never sent) carried an empty string and page 2 failed with a database error
inside a `500`. MEASURED on the mail-piece walk, whose pieces have no `sent_at` at all. The rows now carry an
explicit `cursorValue` populated from the ORDERING key, stripped before the body is sent.

**5. A LIST ROUTE INFERRED ITS RESOURCE'S EXISTENCE FROM A NON-EMPTY LIST.** Both list routes checked the case
by asking whether it had actions, so an existing case with no actions answered `404` — the opposite of the rule
that an empty list is a true statement about a resource that exists (SPEC-006 H-9). The port gained
`caseExists`, asserted directly.

**6. THE COVERAGE INSTRUMENT MISLABELLED A WORKING ROUTE, AND A FALSE STUB IS AS DISHONEST AS A FALSE SUCCESS.**
`scripts/route-coverage.ts` calls a handler a stub when it refuses with `DEPENDENCY_UNAVAILABLE` and shows no
success path, and it only recognised `reply.code(2…)` — while §5.8.2 returns its status through the idempotency
wrapper as `{ status: 200 | 201 }`. The route was reported as an unconditional refusal when its dry run
succeeds. The detector now recognises a returned `status: 2xx` literal too, and §5.8.2 counts as working with the
five genuine stubs still named.

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
