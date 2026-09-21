# Change invalidation

Any production, dependency, schema, config, test-oracle or artifact change invalidates affected descendants.
# Change invalidation graph

Append-only. Written by sh scripts/epoch-pin.sh when the epoch rolls.

## 2026-09-20T01:47:40Z — FORGE-SPEC-2 -> FORGE-SPEC-3

- reason: the stage executor gained long-running, provider-entitlement, production-safety and dependency-edge classification after 103 statuses existed under FORGE-SPEC-2 (EP-010 M4(b)(c) and FALLBACK); the artifact surface changed, so the epoch rolls and the earlier rows are revoked
- candidate: e1e8fdcc0a9e9e93bcb3ee96047d6b6f6f2eaafc
- artifact digest: sha256:6c789950212646a91a28bd640f1ff772b1ca844190a56b8285a398dd892859f7
- changed surfaces (src, scripts, config, db, ui, package.json) between the previous candidate and HEAD:
  - (none detected)
- revoked: every status row recorded under FORGE-SPEC-2 is invalidated for this epoch; the rows are kept in
  .agent/verification/state/TEST_LEDGER.jsonl as history and are no longer counted by
  sh scripts/harness-accounting.sh, which counts the latest row per ID in the CURRENT epoch.
  - revoked rows under FORGE-SPEC-2: 165 covering 104 distinct id(s)
  - revoked by status: {"ERROR":8,"PARTIAL":120,"BLOCKED_PREREQUISITE":33,"BLOCKED_ENVIRONMENT":3,"DEFERRED_LONG_RUNNING":1}
  - PASS rows revoked (the ones that matter most): 0
- descendants to re-run: every stage owning a revoked id; sh scripts/harness-next.sh names the first one.

# Change invalidation graph

Append-only. Written by sh scripts/epoch-pin.sh when the epoch rolls.

## 2026-09-20T03:08:46Z — FORGE-SPEC-3 -> FORGE-SPEC-4

- reason: M5 added scripts/clean-room.sh and the live-fire implementation, and taught scripts/install.sh to install from an artifact and digest alone (a virgin clean room has no identity document); the artifact surface changed after 470 statuses existed under FORGE-SPEC-3, so the epoch rolls
- candidate: d3b142adc25586222faf690328325fd09966dc31
- artifact digest: sha256:6fe9573315f6fb4d559a7e47df0437b7caa49780f31567229a109e610a633cab
- changed surfaces (src, scripts, config, db, ui, package.json) between the previous candidate and HEAD:
  - (none detected)
- revoked: every status row recorded under FORGE-SPEC-3 is invalidated for this epoch; the rows are kept in
  .agent/verification/state/TEST_LEDGER.jsonl as history and are no longer counted by
  sh scripts/harness-accounting.sh, which counts the latest row per ID in the CURRENT epoch.
  - revoked rows under FORGE-SPEC-3: 470 covering 470 distinct id(s)
  - revoked by status: {"BLOCKED_PREREQUISITE":192,"PARTIAL":265,"BLOCKED_ENVIRONMENT":4,"BLOCKED_CREDENTIALS":7,"BLOCKED_SAFETY":1,"DEFERRED_LONG_RUNNING":1}
  - PASS rows revoked (the ones that matter most): 0
- descendants to re-run: every stage owning a revoked id; sh scripts/harness-next.sh names the first one.

# Change invalidation graph

Append-only. Written by sh scripts/epoch-pin.sh when the epoch rolls.

## 2026-09-20T04:31:33Z — FORGE-SPEC-4 -> FORGE-SPEC-5

- reason: M5 corrected the shipped installer dependency-supply handling (the clean room proved an artifact-installed package could not start) and added the per-epoch gate cache; the artifact surface changed after the full 484/484 accounting of FORGE-SPEC-4, so the epoch rolls and those statuses are revoked
- candidate: de22167eaf724cb35f1a4baf2d6cf989c48a0b0b
- artifact digest: sha256:870e934809b40cab7699d4018c7e071af7c8c47cf9ba48293c8437aeba86eef3
- changed surfaces (src, scripts, config, db, ui, package.json) between the previous candidate and HEAD:
  - (none detected)
- revoked: every status row recorded under FORGE-SPEC-4 is invalidated for this epoch; the rows are kept in
  .agent/verification/state/TEST_LEDGER.jsonl as history and are no longer counted by
  sh scripts/harness-accounting.sh, which counts the latest row per ID in the CURRENT epoch.
  - revoked rows under FORGE-SPEC-4: 484 covering 484 distinct id(s)
  - revoked by status: {"BLOCKED_PREREQUISITE":205,"PARTIAL":266,"BLOCKED_ENVIRONMENT":4,"BLOCKED_CREDENTIALS":7,"BLOCKED_SAFETY":1,"DEFERRED_LONG_RUNNING":1}
  - PASS rows revoked (the ones that matter most): 0
- descendants to re-run: every stage owning a revoked id; sh scripts/harness-next.sh names the first one.

# Change invalidation graph

Append-only. Written by sh scripts/epoch-pin.sh when the epoch rolls.

## 2026-09-20T04:33:09Z — FORGE-SPEC-5 -> FORGE-SPEC-6

- reason: the package files allowlist shipped the whole scripts/ directory, so every harness fix changed the artifact and invalidated product evidence; the distribution now ships scripts/install.sh and the product surface only, which is the correct boundary and breaks that loop
- candidate: 5db579e577db4f4b111d1fddcc7452cf27fb5d88
- artifact digest: sha256:c1cc7dfa562116a58534e0460b59ac12c32e6835be8872875eb65ed60488f23d
- changed surfaces (src, scripts, config, db, ui, package.json) between the previous candidate and HEAD:
  - (none detected)
- revoked: every status row recorded under FORGE-SPEC-5 is invalidated for this epoch; the rows are kept in
  .agent/verification/state/TEST_LEDGER.jsonl as history and are no longer counted by
  sh scripts/harness-accounting.sh, which counts the latest row per ID in the CURRENT epoch.
  - revoked rows under FORGE-SPEC-5: 12 covering 12 distinct id(s)
  - revoked by status: {"BLOCKED_PREREQUISITE":11,"PARTIAL":1}
  - PASS rows revoked (the ones that matter most): 0
- descendants to re-run: every stage owning a revoked id; sh scripts/harness-next.sh names the first one.

# Change invalidation graph

Append-only. Written by sh scripts/epoch-pin.sh when the epoch rolls.

## 2026-09-20T05:53:19Z — FORGE-SPEC-6 -> FORGE-SPEC-2

- reason: not stated
- candidate: 6f9dbbea4eb302da92e3e8736bf318bbacb1ff99
- artifact digest: sha256:c1cc7dfa562116a58534e0460b59ac12c32e6835be8872875eb65ed60488f23d
- changed surfaces (src, scripts, config, db, ui, package.json) between the previous candidate and HEAD:
  - (none detected)
- revoked: every status row recorded under FORGE-SPEC-6 is invalidated for this epoch; the rows are kept in
  .agent/verification/state/TEST_LEDGER.jsonl as history and are no longer counted by
  sh scripts/harness-accounting.sh, which counts the latest row per ID in the CURRENT epoch.
  - revoked rows under FORGE-SPEC-6: 1938 covering 484 distinct id(s)
  - revoked by status: {"BLOCKED_PREREQUISITE":820,"PARTIAL":1065,"BLOCKED_ENVIRONMENT":16,"BLOCKED_CREDENTIALS":28,"BLOCKED_SAFETY":4,"DEFERRED_LONG_RUNNING":5}
  - PASS rows revoked (the ones that matter most): 0
- descendants to re-run: every stage owning a revoked id; sh scripts/harness-next.sh names the first one.

# Change invalidation graph

Append-only. Written by sh scripts/epoch-pin.sh when the epoch rolls.

## 2026-09-20T06:21:35Z — FORGE-SPEC-2 -> FORGE-SPEC-7

- reason: the ship gate first step revealed that scripts/epoch-pin.sh defaulted its epoch id to FORGE-SPEC-2, so the pin rolled the epoch backwards from FORGE-SPEC-6 and revoked the 484/484 accounting; the default is removed and the epoch rolls forward so the repaired run has one clean epoch
- candidate: 3e83dfde2891db682a4bb4307c92e8042a6b99e5
- artifact digest: sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47
- changed surfaces (src, scripts, config, db, ui, package.json) between the previous candidate and HEAD:
  - (none detected)
- revoked: every status row recorded under FORGE-SPEC-2 is invalidated for this epoch; the rows are kept in
  .agent/verification/state/TEST_LEDGER.jsonl as history and are no longer counted by
  sh scripts/harness-accounting.sh, which counts the latest row per ID in the CURRENT epoch.
  - revoked rows under FORGE-SPEC-2: 170 covering 109 distinct id(s)
  - revoked by status: {"ERROR":8,"PARTIAL":121,"BLOCKED_PREREQUISITE":37,"BLOCKED_ENVIRONMENT":3,"DEFERRED_LONG_RUNNING":1}
  - PASS rows revoked (the ones that matter most): 0
- descendants to re-run: every stage owning a revoked id; sh scripts/harness-next.sh names the first one.

# Change invalidation graph

Append-only. Written by sh scripts/epoch-pin.sh when the epoch rolls.

## 2026-09-20T19:51:16Z — FORGE-SPEC-7 -> FORGE-SPEC-8

- reason: EP-010 M9 POST-RUN: the gitignore anchoring fix added 93 tracked files (recovered UI source imported by a tracked test, and the evidence logs RELEASE_GATE.json cites); tracked-file surfaces (applicability, gate-foundation, secret-scan) therefore changed after FORGE-SPEC-7 results existed, so the epoch ROLLS rather than being renamed
- candidate: d94e8647af174968d8453d7aa88bf2152d0d34f7
- artifact digest: sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47
- changed surfaces (src, scripts, config, db, ui, package.json) between the previous candidate and HEAD:
  - (none detected)
- revoked: every status row recorded under FORGE-SPEC-7 is invalidated for this epoch; the rows are kept in
  .agent/verification/state/TEST_LEDGER.jsonl as history and are no longer counted by
  sh scripts/harness-accounting.sh, which counts the latest row per ID in the CURRENT epoch.
  - revoked rows under FORGE-SPEC-7: 484 covering 484 distinct id(s)
  - revoked by status: {"BLOCKED_PREREQUISITE":205,"PARTIAL":266,"BLOCKED_ENVIRONMENT":4,"BLOCKED_CREDENTIALS":7,"BLOCKED_SAFETY":1,"DEFERRED_LONG_RUNNING":1}
  - PASS rows revoked (the ones that matter most): 0
- descendants to re-run: every stage owning a revoked id; sh scripts/harness-next.sh names the first one.

# Change invalidation graph

Append-only. Written by sh scripts/epoch-pin.sh when the epoch rolls.

## 2026-09-21T01:25:28Z — FORGE-SPEC-8 -> FORGE-SPEC-9

- reason: EP-010 M10: importing the EP-000 evidence (23 tracked files under .agent/evidence/EP-000) changes the tracked-file surface while FORGE-SPEC-8 results exist, so the epoch ROLLS rather than being renamed; the product artifact is untouched by the import
- candidate: b70162f20bad97f60147e951cb5b9951be116486
- artifact digest: sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47
- changed surfaces (src, scripts, config, db, ui, package.json) between the previous candidate and HEAD:
  - (none detected)
- revoked: every status row recorded under FORGE-SPEC-8 is invalidated for this epoch; the rows are kept in
  .agent/verification/state/TEST_LEDGER.jsonl as history and are no longer counted by
  sh scripts/harness-accounting.sh, which counts the latest row per ID in the CURRENT epoch.
  - revoked rows under FORGE-SPEC-8: 484 covering 484 distinct id(s)
  - revoked by status: {"BLOCKED_PREREQUISITE":205,"PARTIAL":266,"BLOCKED_ENVIRONMENT":4,"BLOCKED_CREDENTIALS":7,"BLOCKED_SAFETY":1,"DEFERRED_LONG_RUNNING":1}
  - PASS rows revoked (the ones that matter most): 0
- descendants to re-run: every stage owning a revoked id; sh scripts/harness-next.sh names the first one.

# Change invalidation graph

Append-only. Written by sh scripts/epoch-pin.sh when the epoch rolls.

## 2026-09-21T06:34:59Z — FORGE-SPEC-9 -> FORGE-SPEC-10

- reason: EP-010 M12: the shipped surface changed (new config/licences/runtime-allowlist.json, reworded src comments and user-visible validator message, OBSERVABILITY.md and COMMANDS.md), so FORGE-SPEC-9 results are revoked and the artifact must be rebuilt rather than carried forward
- candidate: 1e6c59a7acc0aa06ac47ac82bc6bb5d576803d23
- artifact digest: sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47
- changed surfaces (src, scripts, config, db, ui, package.json) between the previous candidate and HEAD:
  - (none detected)
- revoked: every status row recorded under FORGE-SPEC-9 is invalidated for this epoch; the rows are kept in
  .agent/verification/state/TEST_LEDGER.jsonl as history and are no longer counted by
  sh scripts/harness-accounting.sh, which counts the latest row per ID in the CURRENT epoch.
  - revoked rows under FORGE-SPEC-9: 484 covering 484 distinct id(s)
  - revoked by status: {"BLOCKED_PREREQUISITE":205,"PARTIAL":266,"BLOCKED_ENVIRONMENT":4,"BLOCKED_CREDENTIALS":7,"BLOCKED_SAFETY":1,"DEFERRED_LONG_RUNNING":1}
  - PASS rows revoked (the ones that matter most): 0
- descendants to re-run: every stage owning a revoked id; sh scripts/harness-next.sh names the first one.

# Change invalidation graph

Append-only. Written by sh scripts/epoch-pin.sh when the epoch rolls.

## 2026-09-21T11:52:10Z — FORGE-SPEC-10 -> FORGE-SPEC-11

- reason: EP-010 M13: the executor classification rules changed (SPEC-006 section 4.1 repository-mapped execution, declared negative controls, and the fifteen SUP per-ID definitions replacing a 231-byte summary), so statuses produced under the previous rules are revoked and every stage re-runs; the shipped artifact surface is unchanged
- candidate: 9f9764591a0ec1d2df6da6c6dce7db54fba9934d
- artifact digest: sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46
- changed surfaces (src, scripts, config, db, ui, package.json) between the previous candidate and HEAD:
  - (none detected)
- revoked: every status row recorded under FORGE-SPEC-10 is invalidated for this epoch; the rows are kept in
  .agent/verification/state/TEST_LEDGER.jsonl as history and are no longer counted by
  sh scripts/harness-accounting.sh, which counts the latest row per ID in the CURRENT epoch.
  - revoked rows under FORGE-SPEC-10: 541 covering 484 distinct id(s)
  - revoked by status: {"BLOCKED_PREREQUISITE":215,"PARTIAL":310,"BLOCKED_ENVIRONMENT":6,"BLOCKED_CREDENTIALS":7,"BLOCKED_SAFETY":1,"DEFERRED_LONG_RUNNING":1,"PASS":1}
  - PASS rows revoked (the ones that matter most): 1
- descendants to re-run: every stage owning a revoked id; sh scripts/harness-next.sh names the first one.

