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
4. **Every unimplemented gate is still a loud-fail placeholder.** `verify.sh` stops at
   `format-check`. That is the correct honest state.

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
