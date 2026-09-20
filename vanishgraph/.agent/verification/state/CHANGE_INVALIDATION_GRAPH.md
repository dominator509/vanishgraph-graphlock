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

