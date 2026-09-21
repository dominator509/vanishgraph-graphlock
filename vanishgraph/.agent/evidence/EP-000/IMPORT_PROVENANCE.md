# EP-000 evidence import provenance (EP-010 M10)

These files did NOT previously exist anywhere on `main`. `main` had no `.agent/evidence/EP-000/`
directory at all, while EP-000 is a CLOSED node with a `green/EP-000` tag and ledger rows, and
`scripts/validate-generated-pack.py` reads `.agent/evidence/<NODE>/anti_gaming_review.json`. The evidence
existed on exactly one ref: the archive branch `green/EP-000-30304772572033627` at tip `1aba23e93b7b31f5e6dd3a78f2435b2bae6e6df8`
(3 commits, 2026-09-10/11: `4ae5c4e`, `c6da0f0`, `1aba23e`).

## What was imported, from where, and its verified digest

Source selection is PER FILE: the tip is preferred, and a file the tip deleted is taken from `4ae5c4e`, the
newest commit that still contains it. The tip commit `1aba23e` deleted ten of these files; they are imported
from `4ae5c4e` deliberately and are labelled as such below rather than silently omitted.

| file | source | bytes | digest of the bytes git stores | digest check |
|---|---|---|---|---|
| `EP-000-completion-report.md` | 4ae5c4e `4ae5c4e9` | 671 | `sha256:104f52a64d9b3920770b5414dc215a54b93ea48521e5c8f4677d0c42b8646de6` | VERIFIED against its sidecar |
| `EP-000-completion-report.md.sha256` | 4ae5c4e `4ae5c4e9` | 117 | `sha256:a627359fbdd0b1f71d532531c17fb36357ea3b03b303bd5f90f5ac17e81006aa` | sidecar (digest of its artifact, checked below) |
| `acceptance_oracle_fail.txt` | 4ae5c4e `4ae5c4e9` | 772 | `sha256:583e94f7f90597888e22d6b770c592ee15709d36e78f84efd4f837f7bbd605d2` | VERIFIED against its sidecar |
| `acceptance_oracle_fail.txt.sha256` | 4ae5c4e `4ae5c4e9` | 116 | `sha256:95c8055f2e7d095902489ee37c45bd61567949c0252977977541ae578d23d7e0` | sidecar (digest of its artifact, checked below) |
| `acceptance_oracle_pass.txt` | 4ae5c4e `4ae5c4e9` | 98 | `sha256:bf622474643f5a95309d94ccebf2ba48af1fcbd33e7046d2c0e16c5027519d70` | VERIFIED against its sidecar |
| `acceptance_oracle_pass.txt.sha256` | 4ae5c4e `4ae5c4e9` | 116 | `sha256:c51a140cb064b3b25f1f972a7a6c47cd35fb766f55be5e3a05c9342acac73f0a` | sidecar (digest of its artifact, checked below) |
| `anti-gaming.txt` | tip `1aba23e9` | 25746 | `sha256:a977a0c7ea5316c84d5bbc968ecb83004d57cd9a37b0a91ad4b4029d71014d7b` | VERIFIED against its sidecar |
| `anti-gaming.txt.sha256` | tip `1aba23e9` | 105 | `sha256:302cfe464500590d4bbf502e2502ac7b963d45ea202b61f52bd5c19955622615` | sidecar (digest of its artifact, checked below) |
| `anti_gaming_review.json` | tip `1aba23e9` | 184 | `sha256:129386f3682640e2112a9cfefdd3caa4572b90ecd977f543bd240d044e3327d7` | no sidecar exists (a review record, not a hashed artifact) |
| `graph-next.txt` | 4ae5c4e `4ae5c4e9` | 12 | `sha256:8a420211edc4053c7d73a6e35c6ae629782c3ab5d586691f5226b3eb1b4fb3c2` | VERIFIED against its sidecar |
| `graph-next.txt.sha256` | 4ae5c4e `4ae5c4e9` | 104 | `sha256:0f23141e5e51d03bc60ef4038879ea494ae62a2e70a5ce02cedd7643fed75440` | sidecar (digest of its artifact, checked below) |
| `oracle_fail.log` | tip `1aba23e9` | 212 | `sha256:4bf54e4e40be8ffcfb578ef57785e6dca1ae117e2bd0d173a9a9b59d00e340ff` | VERIFIED against its sidecar |
| `oracle_fail.log.sha256` | tip `1aba23e9` | 105 | `sha256:eab36a1b836303da4cbfa61e769851422219fdc8bdda8f75feb4b8002aea4884` | sidecar (digest of its artifact, checked below) |
| `oracle_pass.log` | tip `1aba23e9` | 104 | `sha256:339f1cfed8a308dd29aa811d9b0ef766861e7d69efd0ab9d7adfe0b7658515e4` | VERIFIED against its sidecar |
| `oracle_pass.log.sha256` | tip `1aba23e9` | 105 | `sha256:32254724364eec133cffc4a5d5cd39bbe90d1e8152afb779138b39d92caada6e` | sidecar (digest of its artifact, checked below) |
| `preflight.txt` | 4ae5c4e `4ae5c4e9` | 14 | `sha256:4b050ab9bee6556958069ceaf34866ba5925245248a5be94d1ea72bc7a6400a3` | VERIFIED against its sidecar |
| `preflight.txt.sha256` | 4ae5c4e `4ae5c4e9` | 103 | `sha256:3b86fd4c164eea5bcb162e3a7531603aa72aaa7865137dccab822371526c36b4` | sidecar (digest of its artifact, checked below) |
| `prod-readiness.txt` | tip `1aba23e9` | 32 | `sha256:43a4d58bc6a4f4fc58450990a1372ba7b6136b8b679f3c35eeb63d105f1ea2c1` | VERIFIED against its sidecar |
| `prod-readiness.txt.sha256` | tip `1aba23e9` | 108 | `sha256:72c1eae646684b7c8b20139c16b4d1a91ec2035e0a8f5d837f6ec82d46391e38` | sidecar (digest of its artifact, checked below) |
| `validate-pack.txt` | tip `1aba23e9` | 173 | `sha256:f1bd9644b8ab05a5f51fbb4393dac2995fa999665f36ab8a0125595548d6f58d` | VERIFIED against its sidecar |
| `validate-pack.txt.sha256` | tip `1aba23e9` | 107 | `sha256:8dc55dca2d27fd785fdb143069da6983da28caf9db209b8c77df05a8cf892210` | sidecar (digest of its artifact, checked below) |
| `verify.txt` | tip `1aba23e9` | 11 | `sha256:f9dbd6cd26c2dadaa394d6b1d08656079c2991ae6d15e7999e54bba31148f460` | VERIFIED against its sidecar |
| `verify.txt.sha256` | tip `1aba23e9` | 100 | `sha256:2f09925d1a335673857878cb9641f28f23f0b77a6cfeb9ac92538057b0cbd85d` | sidecar (digest of its artifact, checked below) |

Totals: 23 file(s) imported; 11 artifact(s) VERIFIED against their own `.sha256` sidecar;
0 mismatch; 1 file(s) carry no sidecar because they are review records rather than hashed artifacts.

## How the verification was done, including a method error that was caught and corrected

The first attempt hashed the output of `git archive`, which applies end-of-line conversion, and reported
SIX MISMATCHES. That verdict was an artefact of the method and not a defect in the evidence: the bytes on
disk after an export are not the bytes the repository stores. Re-verified with git plumbing
(`git cat-file blob`), every sidecar matches its artifact exactly under the raw-blob convention, with no
CRLF or LF conversion needed. The corrected result is the table above; the false alarm is recorded here
because a digest check that is wrong in the accusing direction is as damaging as one that misses a fault.

## What was deliberately NOT imported

* `src/discovery.py`, `tests/e2e/test_ep000_discovery.py`, `tests/e2e/__pycache__/*.pyc` and
  `REQUIREMENT_MAPPING.md` - the abandoned Python-era EP-000 implementation, which the tip commit itself
  deleted. Reviving a second, contradicting implementation inside `main` would change what the repository
  means and would be read by the applicability and pack checks.
* `pre_commit_instructions.sh` (repository root; its entire content is the stub line
  `"Pre-commit instructions logic."`), also deleted by the tip commit.
* `.python-version`, `rust-toolchain.toml`, `TOOLCHAIN_PINS.md` and `INTEGRATION_MATRIX.md`, which the tip
  still carries but which are abandoned-era project files rather than EP-000 evidence.

Because the import path is exactly `vanishgraph/.agent/evidence/EP-000`, that exclusion is structural: the import could not have brought
those files in even by accident.

## Effect on the record

The import changes the TRACKED FILE SURFACE, so it revokes the current epoch's results and the epoch rolls,
with the reason recorded in `.agent/verification/state/CHANGE_INVALIDATION_GRAPH.md`, and the full
verification ladder and the ship gate are re-run rather than carried over. The product artifact is untouched:
no file under this directory is shipped in the package.
