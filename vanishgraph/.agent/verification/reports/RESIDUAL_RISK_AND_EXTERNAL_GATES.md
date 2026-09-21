# Residual risk and external gates

Every mandatory gate of SPEC-008 section 9 for candidate `9f9764591a0ec1d2df6da6c6dce7db54fba9934d` and artifact `sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46`. **An agent can never satisfy one of these gates** (DOD-039): only the named participant can, by producing a named, scoped, dated sign-off. While any is open the verdict cannot exceed `CONDITIONAL_EXTERNAL_GATES` (VG-SHIP-030).

| gate | status | participant role | digest to sign | request evidence | requested at | owner contact |
|---|---|---|---|---|---|---|
| human UAT of the golden path | **EXTERNAL_REQUIRED** | Named authorised business participant | `sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47` | `.agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-21T05:58:59Z | SPEC-008 section 9; this repository's owner |
| manual assistive-technology validation at WCAG 2.2 AA | **EXTERNAL_REQUIRED** | Named assistive-technology practitioner | `sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47` | `.agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-21T05:58:59Z | SPEC-008 section 9 |
| legal and compliance review of jurisdictions, agent evidence, templates and claims | **EXTERNAL_REQUIRED** | Qualified counsel | `sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47` | `LEGAL_REVIEW_REQUIRED.md and .agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-21T05:58:59Z | LEGAL_REVIEW_REQUIRED.md |
| hardware, HSM or accredited assessment where applicable | **EXTERNAL_REQUIRED** | Accredited assessor | `sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47` | `.agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-21T05:58:59Z | ADR-006 (no managed KMS exists) and .agent/verification/CAPABILITY_MATRIX.md |
| production deployment authorization | **EXTERNAL_REQUIRED** | Authorised operator (manual only) | `sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47` | `deploy/production/README.md and .agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-21T05:58:59Z | deploy/production/README.md; VG-SCOPE-009 |

## Residual risk carried by this verdict

- **VERIFY-NOT-OK** — sh scripts/verify.sh did not print verify: ok; the stage it reached last was smoke, and its failure is a release blocker rather than a note (evidence: `.agent/evidence/EP-010/ship-gate-FORGE-SPEC-11/verify.log`; next action: resolve the failing verify.sh stage recorded above and re-run the ship gate)
- **EXTERNAL-GATES-UNSIGNED** — 5 of 5 mandatory external gate(s) are unsigned; while any is open the verdict cannot exceed CONDITIONAL_EXTERNAL_GATES (VG-SHIP-030) (evidence: `.agent/evidence/EP-010/V-021/external-gates.jsonl`; next action: obtain the named participant's sign-off for each gate; an agent can never satisfy one (DOD-039))

## What is not claimed

- No outcome was verified end to end: 15 of 484 ids carry PASS.
- No deployment occurred, in staging or production.
- The artifact is unsigned (ADR-006 open) and no container image exists.
- The verdict is not rounded: it is exactly one of the four tokens, and it is `NO_GO`.

