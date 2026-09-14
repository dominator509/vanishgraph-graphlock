2026-09-08T00:00:00Z | forge | - | RUN_INIT | blueprint generated
2026-09-14T03:41:17Z | forge | EP-000 | GATE_HARDENING | removed 34 unconditional false-green sentinels; placeholder gates now exit 1; verify.sh enforces spec line 1357 stage order
2026-09-14T04:22:16Z | forge | EP-000 | FORGE_SPECS_COMPLETE | SPEC-000..008 authored from 155-byte stubs; vocabulary lock, 11 truth states, VG-* requirement catalogue with oracles and negative cases
2026-09-14T04:22:17Z | forge | EP-000 | FORGE_EXECPLANS | EP-000,001,004,005,006,007,008,009,010 authored to Section 11 grammar (14 sections, 9 milestone keywords); EP-002,EP-003 still pending
2026-09-14T04:22:18Z | forge | EP-000 | M1 | toolchain locked; package-lock.json committed; exact-pinned devDependencies
2026-09-14T04:22:18Z | forge | EP-000 | M2 | test-unit: ok; test collection guard: ok; 94 tests
2026-09-14T04:22:19Z | forge | EP-000 | M3 | typecheck: ok; import boundary: ok; lint: ok; build: ok
2026-09-14T04:22:20Z | forge | EP-000 | M4 | gate-toolchain: ok
2026-09-14T04:22:20Z | forge | EP-000 | M5 | preflight: ok; generated pack validation: ok
2026-09-14T05:33:27Z | forge | EP-000 | FORGE_EXECPLANS_COMPLETE | all 11 execplans authored: 91 milestones, 14 sections each, all grammar keywords present, zero boxes checked
2026-09-14T05:33:27Z | forge | EP-000 | STACK_FINALISED | ADR-014 Apache-2.0; ADR-016 Temporal removed for Postgres-native jobs; ADR-007 Vite+React replaces Next.js; TEMPORAL_ADDRESS removed from preflight surface
2026-09-14T06:08:43Z | forge | EP-000 | NODE_DONE | EP-000 complete: gate-toolchain: ok; candidate 9d6406d5e083d2d1e11e00f7c44f2fae6f10978e
2026-09-14T06:10:55Z | forge | EP-001 | MILESTONE_PASS | M1 lockfile tracked; test-unit: ok; test collection guard: ok
2026-09-14T06:12:27Z | forge | EP-001 | MILESTONE_PASS | M2 format-check: ok; CRLF normalized to LF
2026-09-14T06:15:32Z | forge | EP-001 | MILESTONE_PASS | M3 env validation: ok; REQUIRED credentials unprovisioned => BLOCKED_CREDENTIALS
2026-09-14T06:26:08Z | forge | EP-001 | MILESTONE_PASS | M4 harness self-tests green (173 tests); zero-collection proof automated in gate-foundation per FALLBACK
2026-09-14T06:30:19Z | forge | EP-001 | MILESTONE_PASS | M5 reality gate: ok (negative proofs verified); dependency audit: ok (registry reachable; advisory scan clean; sbom sha256 e114f426bb4f562247f933231410aa5c0fc428e6e00fd9006e9740bbfe13096a)
2026-09-14T06:35:31Z | forge | EP-001 | MILESTONE_PASS | M6 local gate sequence green (12 sentinels in order); ci.yml committed; workflow run NOT_EXECUTED_LOCALLY
2026-09-14T06:39:51Z | forge | EP-001 | MILESTONE_PASS | M7 gate-foundation: ok
2026-09-14T06:44:45Z | forge | EP-001 | NODE_DONE | EP-001 complete: gate-foundation: ok; candidate a1d4827b131a0e1ac1ec475ffe6a505d963489c8
2026-09-14T06:51:45Z | forge | EP-001 | EVIDENCE_INDEX_FIXED | M8 index reclassified: 5 stable digests verified durable across a rebuild; 4 run transcripts marked volatile instead of being falsely hashed
2026-09-14T06:57:49Z | forge | EP-001 | LEDGER_STATUS_FIXED | closure made sticky; a later non-NODE_DONE event no longer reopens a closed node
2026-09-14T06:58:11Z | operator | EP-001 | REOPEN | test of deliberate reopen
2026-09-14T06:58:12Z | forge | EP-001 | NODE_DONE | EP-001 complete: gate-foundation: ok (re-closed after deliberate reopen test)
2026-09-14T07:05:40Z | forge | EP-002 | MILESTONE_PASS | M1 baseline measured (177 pass / 0 fail); requirement-to-test map created (31 lines, 5 PASS)
2026-09-14T07:15:16Z | forge | EP-002 | MILESTONE_PASS | M2 value objects complete; typecheck: ok; test-unit: ok (198 pass); two regex gaps found by failing tests and fixed
2026-09-14T07:24:14Z | forge | EP-002 | MILESTONE_PASS | M3 entities complete (27 types, validating factories); typecheck: ok; test-unit: ok (226 pass); two mutations detected and restored
2026-09-14T07:36:03Z | forge | EP-002 | MILESTONE_PASS | M4 ports declared with zero runtime exports; event catalogue complete (22 events); test-unit: ok (234 pass)
2026-09-14T07:47:19Z | forge | EP-002 | MILESTONE_PASS | M5 eleven domain commands (one transition each, audited); typecheck: ok; test-unit: ok (258 pass)
2026-09-14T07:58:26Z | forge | EP-002 | MILESTONE_PASS | M6 invariants SM-1..SM-6 and all documented illegal transitions; typecheck: ok; test-unit: ok (287 pass)
2026-09-14T08:03:50Z | forge | EP-002 | MILESTONE_PASS | M7 import-boundary test with negative case; automated DOD-018 mutation gate (7/7 detected, restore verified); test-unit: ok (292 pass)
2026-09-14T08:14:29Z | forge | EP-002 | MILESTONE_PASS | M8 gate-domain: ok (294 tests, 0 skipped, 57 traceability rows, mutation check, verify.sh progression)
2026-09-14T08:19:33Z | forge | EP-002 | NODE_DONE | EP-002 complete: gate-domain: ok; candidate ffb808f622add1ff2cfc2a5b7818f1a8714b5936
2026-09-14T08:19:33Z | forge | EP-002 | KNOWN_GAPS | unproven: SPEC-001 section 6 names no command owning transition T21 (MATCH_CONFIRMED -> SEARCH_DELISTED), so T21 is reachable only through the state-machine API; no other SPEC-001 item is unproven at the domain layer
2026-09-14T08:19:59Z | forge | EP-002 | NODE_CLOSE_RECORD | EP-002 closed: 3 of 11 nodes; graph advances to EP-003
2026-09-14T08:45:06Z | forge | EP-003 | MILESTONE_PASS | M1 db provision: ok (Docker postgres:16, 2 roles NOBYPASSRLS, 4 databases); db teardown: ok with proof
2026-09-14T09:16:16Z | forge | EP-003 | MILESTONE_PASS | M2 isolation list (26 tables), RLS generator, migration runner; 0001 applied to empty DB; migrate: ok; checksum immutability proven
2026-09-14T09:29:08Z | forge | EP-003 | MILESTONE_PASS | M2 reality-gate rule 3 scope corrected (7 false positives resolved by narrowing the rule, allow-list empty by design); full gate suite 0 failures
2026-09-14T09:44:48Z | forge | EP-003 | MILESTONE_PASS | M3 schema 0002-0005; rls generation: ok (26 tables, drift 0); rls coverage: ok (26 enabled+forced+policied); append-only audit proven
2026-09-14T10:17:29Z | forge | EP-003 | MILESTONE_PASS | M4 0006/0007 applied; rls coverage: ok; checksum drift detected and cleared; multi-tenant deferred-trigger defect found and fixed
2026-09-14T10:28:24Z | forge | EP-003 | MILESTONE_PASS | M5 cross-tenant negative tests pass against real PostgreSQL (VG-DATA-001..003); 7/7 db tests, unit guard green with no database, 2 sabotage controls caught
2026-09-14T10:48:43Z | forge | EP-003 | MILESTONE_PASS | M6 job queue: transactional enqueue, rollback leaves no job
2026-09-14T11:17:14Z | forge | EP-003 | MILESTONE_PASS | M7 envelope encryption; retention from policy; crypto-shred verified; 4 pre-existing vacuous array CHECK constraints repaired in 0010
2026-09-14T11:42:02Z | forge | EP-003 | MILESTONE_PASS | M8 backup drill: restore re-applies erasure, RLS and audit intact; 8/8 post-conditions; PITR BLOCKED_CREDENTIALS
2026-09-14T12:25:01Z | forge | EP-003 | NODE_DONE | EP-003 complete: gate-data: ok; candidate c6ebacc7acd5f175407ea70c421a0734969674a7
2026-09-14T12:25:01Z | forge | EP-003 | NODE_CLOSE_RECORD | EP-003 closed: 4 of 11 nodes; graph advances to EP-004
2026-09-14T13:13:05Z | forge | EP-004 | MILESTONE_PASS | M1 gate-api: ok; import boundary: ok (3 rules); 333 unit tests 0 fail; DATABASE_URL/VALKEY_URL/KEYCLOAK_ISSUER BLOCKED_CREDENTIALS
2026-09-14T13:29:54Z | forge | EP-004 | MILESTONE_PASS | M2 error envelope and code registry parity: ok; 4 spec defects + 2 impl defects found and recorded; 40 contract tests, 351 unit tests
2026-09-14T13:51:17Z | forge | EP-004 | MILESTONE_PASS | M3 token validation and tenant resolution: ok; KEYCLOAK_ISSUER BLOCKED_CREDENTIALS; 85 contract tests; stale camelCase plan text corrected against SPEC-003 R-1
2026-09-14T14:02:14Z | forge | EP-004 | MILESTONE_PASS | M4 cursor pagination and strict query parsing: ok; 144 contract tests; id tiebreaker implemented per FALLBACK
2026-09-14T14:47:17Z | forge | EP-004 | MILESTONE_PASS | M5 idempotency semantics: ok; idempotency store integration BLOCKED_CREDENTIALS DATABASE_URL; durable store proven against real PostgreSQL
2026-09-14T15:16:13Z | forge | EP-004 | MILESTONE_NOTE | M6 in progress: tenant runner + real readiness probe land; /v1/ready 200 ready with a real query (44ms) and 503 not_ready with no leak when the database is down; 78 route handlers NOT yet done
