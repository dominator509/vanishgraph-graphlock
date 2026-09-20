# Epoch history

Append-only. A new candidate adds a row; an existing row is never edited, because an epoch that can be
rewritten after results exist is not an epoch.

| epoch | pinned at | candidate | artifact digest | toolchain | source |
|---|---|---|---|---|---|
| FORGE-SPEC-1 | 2026-09-14T08:19:59Z (RECONSTRUCTED from the RUN_STATE.json values that predate this file) | ffb808f622add1ff2cfc2a5b7818f1a8714b5936 | not recorded (no artifact existed at that epoch) | not recorded | reconstructed, not measured |
| FORGE-SPEC-2 | 2026-09-20T00:47:46Z | 7d6ca2e317d799ce6cdfffa733c0fcbb9fd9f922 | sha256:faafc0d7f03da6f31d03e10c76aa56cce407ea8905733034a5a2b7f82cd5ad1c | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-2 | 2026-09-20T00:48:40Z | 7d6ca2e317d799ce6cdfffa733c0fcbb9fd9f922 | sha256:6f9b76a63e102b503ca51953bccf3569a429cadce01f555a4abec8bd1771498b | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |

## Why there are two FORGE-SPEC-2 rows, and which one is current

The **later row is current**: candidate `7d6ca2e3`, artifact digest
`sha256:6f9b76a63e102b503ca51953bccf3569a429cadce01f555a4abec8bd1771498b`.

The first row was pinned four minutes earlier against the identity EP-009 M7 had produced at commit `dabc6cd`.
That identity was **stale as soon as EP-010 M1 committed `COMMANDS.md` and `scripts/epoch-pin.sh`**, because both
are inside the package `files` allowlist and are therefore part of the artifact's source surface — the freshness
rule `scripts/artifact-identity.sh` enforces. Pinning an epoch to an artifact whose source surface no longer
matches the candidate would have made every artifact-bound result belong to a tree that does not produce it.

Nothing consumed the first row: no verification stage had run, no per-ID status existed, and `RUN_STATE.json`
carried no result. The correction therefore happened inside the only window in which it is legitimate, and it is
recorded here rather than made by editing the earlier row — the file stays append-only. The artifact was rebuilt
at `7d6ca2e3`, `sh scripts/artifact-identity.sh` printed `artifact identity: ok` with the recorded commit equal
to HEAD, and the epoch was pinned again.

**The rule this establishes for the rest of this node: an epoch is pinned after the surface it describes is
committed, not before.** If a later milestone changes the source surface, the artifact must be rebuilt before any
result is attributed to this epoch, or a new epoch row must be created.

| FORGE-SPEC-2 | 2026-09-20T01:03:01Z | df6556b548e5e5f535d7b7ecf815b5e27f426315 | sha256:5d775517fc1acb381a6067692237ae289a62202e43869e5bcb058b95a0c1f757 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-2 | 2026-09-20T01:45:56Z | 16fbab170130a421e86d4a71d2ffa3c909cd94c3 | sha256:dfd7ccd7aa8bd2b8864c75f1cc7c6927bcf6667f6c550e369a3460dbfbd39c2f | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
