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
| FORGE-SPEC-3 | 2026-09-20T01:47:39Z | e1e8fdcc0a9e9e93bcb3ee96047d6b6f6f2eaafc | sha256:6c789950212646a91a28bd640f1ff772b1ca844190a56b8285a398dd892859f7 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-4 | 2026-09-20T03:08:46Z | d3b142adc25586222faf690328325fd09966dc31 | sha256:6fe9573315f6fb4d559a7e47df0437b7caa49780f31567229a109e610a633cab | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-5 | 2026-09-20T04:31:33Z | de22167eaf724cb35f1a4baf2d6cf989c48a0b0b | sha256:870e934809b40cab7699d4018c7e071af7c8c47cf9ba48293c8437aeba86eef3 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-6 | 2026-09-20T04:33:08Z | 5db579e577db4f4b111d1fddcc7452cf27fb5d88 | sha256:c1cc7dfa562116a58534e0460b59ac12c32e6835be8872875eb65ed60488f23d | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-2 | 2026-09-20T05:53:19Z | 6f9dbbea4eb302da92e3e8736bf318bbacb1ff99 | sha256:c1cc7dfa562116a58534e0460b59ac12c32e6835be8872875eb65ed60488f23d | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-2 | 2026-09-20T06:03:40Z | 6f9dbbea4eb302da92e3e8736bf318bbacb1ff99 | sha256:c1cc7dfa562116a58534e0460b59ac12c32e6835be8872875eb65ed60488f23d | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-7 | 2026-09-20T06:21:34Z | 3e83dfde2891db682a4bb4307c92e8042a6b99e5 | sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-7 | 2026-09-20T06:38:50Z | 256c7558b84da764f704717d768a0967b7a2aca7 | sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-7 | 2026-09-20T06:46:46Z | 256c7558b84da764f704717d768a0967b7a2aca7 | sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-7 | 2026-09-20T07:02:03Z | 256c7558b84da764f704717d768a0967b7a2aca7 | sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-8 | 2026-09-20T19:51:15Z | d94e8647af174968d8453d7aa88bf2152d0d34f7 | sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-8 | 2026-09-20T20:54:32Z | d94e8647af174968d8453d7aa88bf2152d0d34f7 | sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-8 | 2026-09-20T21:09:11Z | d94e8647af174968d8453d7aa88bf2152d0d34f7 | sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-9 | 2026-09-21T01:25:28Z | b70162f20bad97f60147e951cb5b9951be116486 | sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-9 | 2026-09-21T02:07:16Z | b70162f20bad97f60147e951cb5b9951be116486 | sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-9 | 2026-09-21T03:30:14Z | c01c388fa6821b621facb066e04aae2a98c7a36a | sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-9 | 2026-09-21T05:59:39Z | 6f3a8951eedd36b0c6699d1fdb821c6abce48652 | sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-10 | 2026-09-21T06:34:58Z | 1e6c59a7acc0aa06ac47ac82bc6bb5d576803d23 | sha256:81215aafb76e0c19306b24c7ef01447249a609d3182a35111f4bae85f2273d47 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-10 | 2026-09-21T07:22:32Z | 1e6c59a7acc0aa06ac47ac82bc6bb5d576803d23 | sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-10 | 2026-09-21T09:40:21Z | 1e6c59a7acc0aa06ac47ac82bc6bb5d576803d23 | sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-10 | 2026-09-21T10:19:31Z | 1e6c59a7acc0aa06ac47ac82bc6bb5d576803d23 | sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-11 | 2026-09-21T11:52:09Z | 9f9764591a0ec1d2df6da6c6dce7db54fba9934d | sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-11 | 2026-09-21T12:28:12Z | 9f9764591a0ec1d2df6da6c6dce7db54fba9934d | sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-11 | 2026-09-21T12:48:35Z | 8b8cd15b0b05994a1271e43f13f3a44ce86b5c2f | sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-12 | 2026-09-21T18:00:51Z | 7751571791ed7cf6ba1b375b875b6b1350571353 | sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-12 | 2026-09-21T18:21:29Z | 7751571791ed7cf6ba1b375b875b6b1350571353 | sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
| FORGE-SPEC-12 | 2026-09-21T18:43:52Z | 7751571791ed7cf6ba1b375b875b6b1350571353 | sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57 | node v24.14.1, npm 11.11.0 | measured by sh scripts/epoch-pin.sh |
