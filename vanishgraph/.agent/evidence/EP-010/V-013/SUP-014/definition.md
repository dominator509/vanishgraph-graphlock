## SUP-014 Multi-Tenant Isolation & Noisy-Neighbor Verification

- **Method.** Prove cross-tenant denial at BOTH layers: the service-layer matrix, and row-level security against a
  real database, with counts showing no state change and no external effect.
- **Commands.** `sh scripts/test-integration.sh`
- **Oracle.** The integration sentinel with zero failures, including the cross-tenant two-layer suite.
- **Negative case.** NOT DECLARED as a gate control; the suite contains executed cross-tenant refusal cases, but no
  planted-fault control is declared for the gate.
- **Completion gate.** DOD-010, VG-AUTH-022, VG-TENANT-001/002.

