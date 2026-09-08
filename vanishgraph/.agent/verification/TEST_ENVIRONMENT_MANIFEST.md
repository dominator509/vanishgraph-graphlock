# Test Environment Manifest

Status: BLUEPRINT_ONLY; no application runtime or production environment was created.

| Environment | Identity | Required dependencies | State |
|---|---|---|---|
| clean-local | disposable checkout | pinned tools, Postgres, Temporal, Valkey, browser | NOT_PROVISIONED |
| staging | managed US cloud, separate account | Kubernetes, KMS, object store, managed Postgres, browser pool | NOT_PROVISIONED |
| production | manual only | signed artifact and all external approvals | UNAUTHORIZED |

Every future run records candidate SHA, artifact digest, tool versions, image digests, environment fingerprint, teardown proof, and evidence hashes.
