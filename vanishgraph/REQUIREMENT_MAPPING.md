# Requirement Mapping

- `src/discovery.py` implements EP-000 binding / LIVE-FIRE-PROOF-01 subject-bound discovery.
- `tests/e2e/test_ep000_discovery.py` provides the E2E-001 acceptance oracle covering the happy path, boundary/failure case (no subject provided), and persistence read-back verification.
