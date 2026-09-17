# Mutation catalogue (DOD-018; EP-007 M4)

One controlled defect per critical feature, each with the file it changes and the test that must fail while it is
present. The mechanism is EP-002's and lives in `scripts/lib/mutations.ts` (the list) and `scripts/mutation-check.sh`
(the runner, which restores the file and verifies restoration by SHA-256 rather than by assumption).
`scripts/mutation-gate.sh` runs that mechanism and checks this catalogue against it, so a feature named here with no
mutation behind it fails the gate rather than reading as covered.

A mutation that does not change any observed verdict means the mapped test is **non-discriminating** and its pass proves
nothing — that is the whole point of this file, and it is why the list below carries the test each mutation must break.

## The domain mutations the mechanism executes (measured from `MUTATIONS` in `scripts/lib/mutations.ts`)

| Id | Critical feature | Mutation applied | File | Must be detected by |
|---|---|---|---|---|
| MUT-1 | Confidence range | range check replaced by a tautology | `src/domain/values.ts` | `tests/domain/values.test.ts` |
| MUT-2 | Confidence basis (VG-IDENT-003) | basis requirement removed | `src/domain/values.ts` | `tests/domain/values.test.ts` |
| MUT-3 | T14 independent observation (VG-VERIFY-001) | independence guard weakened to always satisfied | `src/domain/truth-state.ts` | `tests/domain/illegal-transitions.test.ts` |
| MUT-4 | Forbidden transition pairs (SPEC-001 §4.2) | forbidden-pair check disabled | `src/domain/state-machine.ts` | `tests/domain/state-machine.test.ts` |
| MUT-5 | Observation provenance (VG-VERIFY-003) | self-verification check removed from `VerificationObservation` | `src/domain/entities.ts` | `tests/domain/entities.test.ts` |
| MUT-6 | One effect per `IdempotencyKey` (VG-ACTION-001) | replay check disabled | `src/domain/commands.ts` | `tests/domain/commands.test.ts` |
| MUT-7 | Observation window (VG-VERIFY-002) | window check removed | `src/domain/invariants.ts` | `tests/domain/invariants.test.ts` |

## What is NOT mutated yet, and it is listed rather than implied

The mechanism covers the **domain** layer, which is where the state machine and its guards live. These critical features
have no controlled defect in the mechanism today, and each is therefore `UNVERIFIED` for mutation sensitivity — a pass
of its ordinary suite does not yet show that the suite observes the behaviour:

| Critical feature | Where it lives | Why it is not mutated yet |
|---|---|---|
| Tenant isolation (VG-TENANT-001/002) | `src/adapters/persistence/**`, RLS policies in `db/migrations/**` | a mutation here is a SCHEMA or privilege change, not a source edit: the mechanism mutates a file and reruns a test, and a controlled policy change would have to be applied and reverted against the live database |
| Execution-time authority (VG-AUTHZ-005) | `src/application/security/authority-service.ts` | no mutation defined; the integration suite (`tests/integration/authority-at-execution.test.ts`) would detect one, and defining it is the next step |
| Evidence immutability (VG-AUTHZ-017, VG-EVIDENCE-003) | `db/privileges.sql`, `src/adapters/persistence/**` | same reason as tenant isolation: the control is a privilege, not a line of code |
| Secret resolution refusal (VG-ERR-055) | `src/adapters/secrets/secret-resolver.ts` | no mutation defined |
| Webhook signature order (§6.1) | `src/application/security/webhook-gate.ts` | no mutation defined |
| SSRF target classification (VG-SEC-003) | `src/adapters/ssrf/target-classifier.ts` | no mutation defined |
| Coverage honesty (VG-DISC-002) | `src/http/routes/coverage.ts` | no mutation defined |

`scripts/mutation-gate.sh` fails when a row in the first table has no matching mutation in the mechanism, and prints the
second table's size as the remaining mutation surface rather than reporting the domain's seven as the whole catalogue.
