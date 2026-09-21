# Residual risk and external gates

Every mandatory gate of SPEC-008 section 9 for candidate `7751571791ed7cf6ba1b375b875b6b1350571353` and artifact `sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57`. **An agent can never satisfy one of these gates** (DOD-039): only the named participant can, by producing a named, scoped, dated sign-off. While any is open the verdict cannot exceed `CONDITIONAL_EXTERNAL_GATES` (VG-SHIP-030).

| gate | status | participant role | digest to sign | request evidence | requested at | owner contact |
|---|---|---|---|---|---|---|
| human UAT of the golden path | **EXTERNAL_REQUIRED** | Named authorised business participant | `sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57` | `.agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-21T18:32:44Z | SPEC-008 section 9; this repository's owner |
| manual assistive-technology validation at WCAG 2.2 AA | **EXTERNAL_REQUIRED** | Named assistive-technology practitioner | `sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57` | `.agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-21T18:32:44Z | SPEC-008 section 9 |
| legal and compliance review of jurisdictions, agent evidence, templates and claims | **EXTERNAL_REQUIRED** | Qualified counsel | `sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57` | `LEGAL_REVIEW_REQUIRED.md and .agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-21T18:32:44Z | LEGAL_REVIEW_REQUIRED.md |
| hardware, HSM or accredited assessment where applicable | **EXTERNAL_REQUIRED** | Accredited assessor | `sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57` | `.agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-21T18:32:44Z | ADR-006 (no managed KMS exists) and .agent/verification/CAPABILITY_MATRIX.md |
| production deployment authorization | **EXTERNAL_REQUIRED** | Authorised operator (manual only) | `sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57` | `deploy/production/README.md and .agent/evidence/EP-010/V-021/external-gates.jsonl` | 2026-09-21T18:32:44Z | deploy/production/README.md; VG-SCOPE-009 |

## Residual risk carried by this verdict

- **VERIFY-NOT-OK** — sh scripts/verify.sh did not print verify: ok; the stage it reached last was live-fire, and its failure is a release blocker rather than a note (evidence: `.agent/evidence/EP-010/ship-gate-FORGE-SPEC-12/verify.log`; next action: resolve the failing verify.sh stage recorded above and re-run the ship gate)
- **EXTERNAL-GATES-UNSIGNED** — 5 of 5 mandatory external gate(s) are unsigned; while any is open the verdict cannot exceed CONDITIONAL_EXTERNAL_GATES (VG-SHIP-030) (evidence: `.agent/evidence/EP-010/V-021/external-gates.jsonl`; next action: obtain the named participant's sign-off for each gate; an agent can never satisfy one (DOD-039))

## What is not claimed

- No outcome was verified end to end: 15 of 484 ids carry PASS.
- No deployment occurred, in staging or production.
- The artifact is unsigned (ADR-006 open) and no container image exists.
- The verdict is not rounded: it is exactly one of the four tokens, and it is `NO_GO`.

