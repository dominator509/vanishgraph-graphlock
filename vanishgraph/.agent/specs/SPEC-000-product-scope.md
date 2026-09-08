# SPEC-000 Product Scope

Status: BLUEPRINT_ONLY. This specification defines VanishGraph behavior; it is not application implementation.

## Requirements
- R-SCOPE-001: protect only a verified subject or a person with documented authority.
- R-SCOPE-002: distinguish discovery, request, controller acknowledgement, source verification, search delisting, and reappearance.
- R-SCOPE-003: report measured coverage and uncertainty; never claim universal or permanent erasure.
- R-SCOPE-004: external writes require current policy, authority, recipe permission, idempotency, and audit evidence.

## Non-goals
No stalking, arbitrary third-party dossiers, access-control bypass, CAPTCHA solving, false legal claims, or production deployment from this pack.

## Acceptance
Each requirement maps to a live-fire proof, negative case, persistence/restart case, and evidence path in FUNCTIONAL_PROOF_MATRIX.csv.
