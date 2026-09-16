# Next action

**EP-006 (auth/security node) is closed.** `graph-next.sh` names **EP-007**.

## What EP-006 verified, exactly — and what it does not claim

The credential-free security controls and their negative cases pass, and — because EP-003 provisioned PostgreSQL — the
database-backed halves that the plan recorded as `BLOCKED_CREDENTIALS` also RAN: cross-tenant denial by both layers over
one fixture set, authority verified inside the write transaction including a revocation committed by a second
connection, and evidence immutability at the privilege, route and rule levels.

`sh scripts/gate-security.sh` → `gate-security: ok`; `sh scripts/security-check.sh` → `security check: ok`;
`sh scripts/secret-scan.sh` → `secret scan: ok` (666 files, 0 findings); `test-unit: ok` (1074 tests);
`test-integration: ok` (360 tests across 31 manifest files).

**THE HONEST STATEMENT: this does NOT mean the platform is secure, hardened, MFA-enforced, RLS-protected, compliant or
production ready.** No realm exists, no managed KMS exists, no durable counter exists, and no human has reviewed
anything. `RELEASE_GATE.json` remains `INCONCLUSIVE`/`FORGE_ONLY`. Do not change it.

## The accounting, as filed in `.agent/verification/state/TEST_LEDGER.jsonl`

57 rows for this node's IDs: **45 `PASS`**, **1 `PARTIAL`**, **9 `BLOCKED_CREDENTIALS`**, **2 `EXTERNAL_REQUIRED`**.

* `PARTIAL` is **VG-AUTHZ-009**: the suspension half is executed (recorded under VG-AUTHZ-012 and against a real row) and
  the review-lane half is not — the ID is cited in no file under `src/` or `tests/`, so nothing asserts that a contested
  grant moves the subject to `HUMAN_REQUIRED`.
* `BLOCKED_CREDENTIALS` rows name their probe and its measured exit code (all `1`, captured in
  `.agent/evidence/EP-006/M10-blocked-probes.txt`): the Keycloak realm's MFA policy, refresh rotation,
  sender-constrained tokens, global sign-out and administrative revocation (`KEYCLOAK_ISSUER`); durable rate-limit and
  replay counters (`VALKEY_URL`); managed-KMS resolution (`CLOUD_WORKLOAD_IDENTITY`, ADR-006 still OPEN); and IAL3
  verification by a vendor under contract.
* `EXTERNAL_REQUIRED` rows are counsel review (SPEC-005 §11) and human UAT plus assistive-technology validation
  (DOD-039). An automated tool, an agent or the implementer cannot satisfy, impersonate or substitute for either, and no
  sign-off exists.

## Defects this node found and fixed, and one it recorded instead of half-fixing

1. **The runtime role could mutate the evidence store.** `db/privileges.sql` granted `UPDATE, DELETE` on every table to
   `vg_app` and revoked only `audit_event`/`schema_migration`. Measured before the fix:
   `has_table_privilege('vg_app','evidence_artifact','DELETE')` returned `true` and an `UPDATE` exited 0. Revoked; the
   owner keeps the capability because SPEC-002 §5's retention subsystem is the named path that removes evidence.
2. **`authority_grant` had no column for three facts the execution-time check reads** (`contested_at`,
   `cooling_off_until`, `notice_artifact_id`), so a contested grant would have passed the check after a restart.
   Migration `0034` adds them; `src/adapters/persistence/authority-repository.ts` is written and driven by real rows.
3. **Four citations to requirement IDs that exist in no specification** — `VG-SCOPE-020` (8 files), `VG-UI-090…093`
   (2 files), `VG-AUTHZ-024` (this node's own suite) and `VG-DATA-013/015` (an applied migration). Every mutable
   occurrence is corrected; the three inside applied migrations cannot be (DOD-040 checksum immutability) and are named
   with their reason in `tests/architecture/requirement-ids.test.ts`, which now enforces the lookup across the tree.
4. **The collection guard's preserved failure evidence named no test**, and the verification refresh did not cover
   `tests/integration/**` or `tests/security/**`, so those suites ran while the ledger carried no row for them. Both
   fixed, and `test_id` is now unique per test rather than per test *name*.

**Recorded, NOT fixed — a cross-tenant REFERENCE is permitted by the schema.** RLS constrains the row's tenant, not the
tenant of the row it references. Measured: a grant in tenant Q naming tenant P's `protected_subject` was accepted.
Measured scope: **0** tenant-scoped tables carry a `(tenant_id, id)` key, so a composite foreign key is not expressible
today, and **47** foreign keys cross the tenant boundary. This does not violate VG-TENANT-001 as written (its oracle is a
cross-tenant *read* returning zero rows, which holds), but it is narrower than "every row is tenant-scoped". The fix is
composite keys plus 47 composite FKs — a data-model change, not a security-node edit. Evidence:
`.agent/evidence/EP-006/M10-cross-tenant-reference.txt`; reasoning: `ASSUMPTIONS.md` §3.56 part 4.

## The provisioning actions that unblock the credential-dependent rows

Each is an environment action rather than code, and none is simulated anywhere.

1. **`KEYCLOAK_ISSUER`** (+ `KEYCLOAK_CLIENT_ID`/`SECRET`) — point the service at a real provider. Unblocks the five
   realm rows and the live-login halves of VG-AUTH-020/021/026.
2. **`VALKEY_URL`** — provision the coordination store for the durable rate-limit and replay counters.
3. **`CLOUD_WORKLOAD_IDENTITY`** and a managed KMS (ADR-006) — unblocks wrapped-key production and secret resolution.
4. **`DATABASE_URL`** as a deployment variable — the gates and stages provision PostgreSQL and pass the DSNs explicitly;
   the environment-configured boot path has never been exercised.
5. **`S3_*`** and an `EvidenceStore` — unblocks §5.12.1 upload, §5.12.3 download and §5.12.4's computed digest check.

## What EP-006 leaves open for later nodes

* **No notification transport**: §5.2.1 refuses to mint an `AGENT` grant at all, so no enrollment notice has ever
  reached a subject (VG-AUTH-032's delivery half).
* **No retention subsystem**: nothing deletes evidence, so "removed only by the retention subsystem" describes an
  intended path rather than an executed one.
* **`src/adapters/oidc/jwks.ts` calls the platform `fetch` directly** and is not routed through the SSRF guard — a
  one-entry capped exception, recorded rather than hidden.
* **No recipe verification key set** (ADR-006 open), so a signed recipe has never been verified end to end.
* **`scripts/test-migrations.sh` does not exist**, so `db/UPGRADE_MATRIX.md`'s rows remain UNPROVEN and the integration
  stage says so on every run.
* **CI has never run here**, so image-layer and log-layer secret scanning and every CI-only check are unverified.
