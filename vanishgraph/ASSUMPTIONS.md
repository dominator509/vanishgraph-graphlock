# Assumptions

| assumption | risk | verification | status |
|---|---|---|---|
| Greenfield target | overwrite or drift | inspect target before EP-000 | **CONFIRMED** — target is a governance pack with no product code. Recorded in EP-000 §4 with the executed inventory. |
| Cloud provider unknown | deployment ADR may change | PREFLIGHT scored ADR | **OPEN** — ADR-006 unresolved. Blocks EP-009, not EP-000/EP-002. |
| No credentials supplied | live-fire gates blocked | run preflight after provisioning | **CONFIRMED OPEN** — `sh scripts/preflight.sh` reports DATABASE_URL, TEMPORAL_ADDRESS, VALKEY_URL, S3_ENDPOINT, KEYCLOAK_ISSUER, LOCAL_MODEL_ENDPOINT, GITHUB_APP_ID all unprovisioned. State: `BLOCKED_CREDENTIALS`. Blocks only dependent work (integration, E2E, live-fire, deploy). |
| Human UAT/manual AT/counsel/assessor unknown | GA cannot be GO | attach named external evidence | **OPEN** — no participants named. Caps any verdict at `CONDITIONAL_EXTERNAL_GATES` (DOD-039). |
| Provider terms volatile | unlawful automation risk | re-open official docs | **OPEN** — no provider terms revalidated in this session. PREFLIGHT.md requires revalidation before any provider write path is enabled. |
| Working codename | trademark risk | clearance before public launch | **OPEN** — no clearance performed. |

## Assumptions added during EP-000 discovery

| assumption | risk | verification | status |
|---|---|---|---|
| Node's native TypeScript type stripping is sufficient for the domain layer | build/runtime divergence | `tsc --noEmit` under `erasableSyntaxOnly` + `node --test` against `.ts` sources | **CONFIRMED** — 94 tests execute directly against TypeScript sources; `erasableSyntaxOnly` makes non-erasable syntax a build error, so tested and shipped code are the same code. |
| `node:test`'s JUnit reporter attributes each test case to a file | collection accounting cannot be verified per suite | inspected real reporter output | **CONFIRMED** — each `<testcase>` carries a `file` attribute. The TAP reporter does **not**, which is why JUnit is used. |
| A test file that declares no tests is distinguishable from a real test | an emptied suite could pass silently | measured reporter behaviour: an emptied file emits one `<testcase>` whose `name` is the file path | **CONFIRMED** with a **documented limitation** — see below. |
| Python 3.14 can run the pack validators | pack validation unavailable | `python3 scripts/validate-generated-pack.py .` | **CONFIRMED** — returns `generated pack validation: ok`. |

## Known limitations recorded honestly (not resolved)

1. **Empty `describe` blocks are not detected by the collection guard.** Node reports
   a test file containing `describe('x', () => {})` and no tests as one passing test
   whose name is the suite title, which is indistinguishable from a real test by name
   alone. The guard *does* catch: a glob matching no files, a test file declaring no
   tests at all (its name is the file path), an emptied suite listed in
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
   currently stops at `format-check`. That is the correct, honest state: the gates
   that exist genuinely pass, and the ones that do not exist genuinely fail.
