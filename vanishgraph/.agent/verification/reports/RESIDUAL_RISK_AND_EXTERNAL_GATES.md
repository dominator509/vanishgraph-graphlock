# Residual risk and external gates

Every mandatory gate of SPEC-008 section 9 for candidate `d94e8647af174968d8453d7aa88bf2152d0d34f7` and artifact `sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47`. **An agent can never satisfy one of these gates** (DOD-039): only the named participant can, by producing a named, scoped, dated sign-off. While any is open the verdict cannot exceed `CONDITIONAL_EXTERNAL_GATES` (VG-SHIP-030).

| gate | status | participant role | digest to sign | request evidence | requested at | owner contact |
|---|---|---|---|---|---|---|
| human UAT of the golden path | **EXTERNAL_REQUIRED** | Named authorised business participant | `sha256:6fe9573315f6fb4d559a7e47df0437b7caa49780f31567229a109e610a633cab` | `.agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-20T03:29:35Z | SPEC-008 section 9; this repository's owner |
| manual assistive-technology validation at WCAG 2.2 AA | **EXTERNAL_REQUIRED** | Named assistive-technology practitioner | `sha256:6fe9573315f6fb4d559a7e47df0437b7caa49780f31567229a109e610a633cab` | `.agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-20T03:29:35Z | SPEC-008 section 9 |
| legal and compliance review of jurisdictions, agent evidence, templates and claims | **EXTERNAL_REQUIRED** | Qualified counsel | `sha256:6fe9573315f6fb4d559a7e47df0437b7caa49780f31567229a109e610a633cab` | `LEGAL_REVIEW_REQUIRED.md and .agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-20T03:29:35Z | LEGAL_REVIEW_REQUIRED.md |
| hardware, HSM or accredited assessment where applicable | **EXTERNAL_REQUIRED** | Accredited assessor | `sha256:6fe9573315f6fb4d559a7e47df0437b7caa49780f31567229a109e610a633cab` | `.agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-20T03:29:35Z | ADR-006 (no managed KMS exists) and .agent/verification/CAPABILITY_MATRIX.md |
| production deployment authorization | **EXTERNAL_REQUIRED** | Authorised operator (manual only) | `sha256:6fe9573315f6fb4d559a7e47df0437b7caa49780f31567229a109e610a633cab` | `deploy/production/README.md and .agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-20T03:29:35Z | deploy/production/README.md; VG-SCOPE-009 |

## Residual risk carried by this verdict

- **VERIFY-NOT-OK** — sh scripts/verify.sh did not print verify: ok; the stage it reached last was dependency-audit, and its failure is a release blocker rather than a note (evidence: `.agent/evidence/EP-010/ship-gate-FORGE-SPEC-8/verify.log`; next action: resolve the failing verify.sh stage recorded above and re-run the ship gate)
- **DOD-DOD-019** — clause DOD-019 does not pass: reality gate: reality-gate.sh exited 1 WITHOUT its sentinel; the three prose hits recorded in EP-009 remain the gate's only findings (evidence: `.agent/evidence/EP-010/DOD/DOD-019.json`; next action: Any unexplained hit is a release blocker or the affected claim is explicitly marked incomplete.)
- **EXTERNAL-GATES-UNSIGNED** — 5 of 5 mandatory external gate(s) are unsigned; while any is open the verdict cannot exceed CONDITIONAL_EXTERNAL_GATES (VG-SHIP-030) (evidence: `.agent/evidence/EP-010/V-021/external-gates.jsonl`; next action: obtain the named participant's sign-off for each gate; an agent can never satisfy one (DOD-039))
- **NO-PASSING-ID** — not one of the 484 ids carries PASS, so no behaviour was verified end to end through its real entry point (evidence: `.agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv`; next action: execute the ids in an authorised agentic runner and record PASS only where the oracle and a negative case ran)

## What is not claimed

- No outcome was verified end to end: 0 of 484 ids carry PASS.
- No deployment occurred, in staging or production.
- The artifact is unsigned (ADR-006 open) and no container image exists.
- The verdict is not rounded: it is exactly one of the four tokens, and it is `NO_GO`.

