# Assumptions

## 1. Original assumptions

| assumption | risk | verification | status |
|---|---|---|---|
| Greenfield target | overwrite or drift | inspect target before EP-000 | **CONFIRMED** — target is a governance pack with no product code. Recorded in EP-000 §4 with the executed inventory. |
| Cloud provider unknown | deployment ADR may change | PREFLIGHT scored ADR | **OPEN** — ADR-006 unresolved. Blocks EP-009, not EP-000/EP-002. |
| No credentials supplied | live-fire gates blocked | run preflight after provisioning | **CONFIRMED OPEN** — `sh scripts/preflight.sh` reports DATABASE_URL, VALKEY_URL, S3_ENDPOINT, KEYCLOAK_ISSUER, LOCAL_MODEL_ENDPOINT and GITHUB_APP_ID unprovisioned. State: `BLOCKED_CREDENTIALS`. Blocks only dependent work (integration, E2E, live-fire, deploy). |
| Human UAT/manual AT/counsel/assessor unknown | GA cannot be GO | attach named external evidence | **OPEN** — no participants named. Caps any verdict at `CONDITIONAL_EXTERNAL_GATES` (DOD-039). |
| Provider terms volatile | unlawful automation risk | re-open official docs | **OPEN** — no provider terms revalidated in this session. PREFLIGHT.md requires revalidation before any provider write path is enabled. |
| Working codename | trademark risk | clearance before public launch | **OPEN** — no clearance performed. |
| Licence choice | incompatible dependencies; unclear reuse rights | owner decision + compatibility review | **RESOLVED** — Apache-2.0 (`LICENSE`, ADR-014). Compatible with every component in the stack. Non-commercial third-party data remains forbidden (`LICENSE_POLICY.md`). |

## 2. Assumptions resolved during FORGE

| assumption | risk | verification | status |
|---|---|---|---|
| A second stateful cluster (Temporal) is required for durable execution | severe self-hosting barrier for an open-source project | ADR-016 analysis against the actual workload: delayed jobs, retries, at-most-once effects, scheduled re-observation | **REJECTED** — replaced by a Postgres-native queue behind a `JobQueue` port. Job enqueue commits in the same transaction as the state transition, which removes a dual-write inconsistency class rather than managing it. `TEMPORAL_ADDRESS` removed from `PREFLIGHT.md`, `.env.example` and `scripts/preflight.sh`; `scripts/probes/temporal_address.sh` deleted. |
| Server-side rendering is needed for the portals | wrong architecture for a PII product | ADR-007 analysis: every surface is authenticated, so SSR/SEO buys nothing, while a server/client boundary adds a way to move subject PII to the browser by mistake | **REJECTED** — replaced by a Vite + React SPA with TanStack Router and TanStack Query. |
| An ORM is the right data layer | cross-tenant PII breach from a mis-scoped `SET LOCAL app.tenant_id` | ADR-008: RLS requires transaction-scoped session settings, and ORMs that own the connection make that easy to get wrong | **REJECTED** — Kysely (typed SQL, explicit transaction) plus SQL-first migrations, because policies and triggers cannot be expressed through a schema DSL. |

## 3. Assumptions added during EP-000 discovery

| assumption | risk | verification | status |
|---|---|---|---|
| Node's native TypeScript type stripping is sufficient for the domain layer | build/runtime divergence | `tsc --noEmit` under `erasableSyntaxOnly` + `node --test` against `.ts` sources | **CONFIRMED** — 94 tests execute directly against TypeScript sources; `erasableSyntaxOnly` makes non-erasable syntax a build error, so tested and shipped code are the same code. |
| `node:test`'s JUnit reporter attributes each test case to a file | collection accounting cannot be verified per suite | inspected real reporter output | **CONFIRMED** — each `<testcase>` carries a `file` attribute. The TAP reporter does **not**, which is why JUnit is used. |
| A test file that declares no tests is distinguishable from a real test | an emptied suite could pass silently | measured reporter behaviour: an emptied file emits one `<testcase>` whose `name` is the file path | **CONFIRMED** with a **documented limitation** — see §4. |
| Python 3.14 can run the pack validators | pack validation unavailable | `python3 scripts/validate-generated-pack.py .` | **CONFIRMED** — returns `generated pack validation: ok`. |
| The domain layer survives a stack change | stack churn invalidates domain evidence | ADR-016/ADR-007 were applied and the domain was re-tested | **CONFIRMED** — the domain and its 94 tests needed no change, because the code law forbids the domain importing anything but the standard library. This is the concrete payoff of that law. |

## 4. Known limitations recorded honestly (not resolved)

1. **Empty `describe` blocks are not detected by the collection guard.** Node reports a
   test file containing `describe('x', () => {})` and no tests as one passing test whose
   name is the suite title, which is indistinguishable from a real test by name alone.
   The guard *does* catch: a glob matching no files, a test file declaring no tests at
   all (its name is the file path), an emptied suite listed in
   `EXPECTED_TEST_MANIFEST.txt`, and any failing test. This residual gap is recorded
   rather than papered over.
2. **`materialize-atomic-sources.sh` fails with `base64: invalid input`.** The embedded
   `.agent/verification/atomic-security-sources.tar.gz.b64` payload is corrupt. This
   blocks materialising the 15 reconstructed Blockchain test bodies that
   `HARNESS_LAWS.md` counts toward the 484. Not repaired, because repairing it would
   require fabricating test source bodies.
3. **`.gitignore` previously excluded `.agent/evidence/`**, contradicting DOD-025 and
   preventing `validate-generated-pack.py` from seeing evidence on a fresh clone.
   Corrected in EP-000 M5.
4. **Every remaining unimplemented gate is a loud-fail placeholder.** `verify.sh`
   currently stops at `format-check`. That is the correct, honest state: the gates that
   exist genuinely pass, and the ones that do not exist genuinely fail.
5. **EP-005 was converted to the Vite + React stack by scripted transformation**, not
   authored fresh against it. The 21 substitutions covered the route tree, config files
   and dependency references, and the file now contains no Next.js or App Router
   reference. The plan's substance (truth-state presentation contract, coverage
   honesty, accessibility, anti-dark-pattern rules) was stack-agnostic and was retained
   unchanged. **It has not had a full human or agent review pass since the
   transformation**, and should get one before an executor follows it.
6. **`LICENSE`/`NOTICE` carry a copyright placeholder.** Apache-2.0 §4(d) requires the
   holder to be named. This is an owner decision (`DECISIONS.md` §5) and must be set
   before any public release.

## 5. Verification state at the time of writing

- `src/domain/**` — real, with 94 executing tests, all passing.
- Real gates: `preflight.sh`, `gate-toolchain.sh`, `import-boundary.sh`, `typecheck.sh`,
  `lint.sh`, `test-unit.sh`, `test-collection-guard.sh`, `build.sh`.
- Loud-fail placeholders: everything else, by design.
- `sh scripts/verify.sh` stops at `format-check`.
- Ship verdict: `INCONCLUSIVE`. DOD: 5 PASS, 12 PARTIAL, 24 NOT_STARTED,
  1 EXTERNAL_REQUIRED out of 42. The 484-ID accounting has not begun.
