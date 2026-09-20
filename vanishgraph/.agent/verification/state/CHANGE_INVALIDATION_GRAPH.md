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

