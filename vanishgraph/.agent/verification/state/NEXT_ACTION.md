# Next action

**EP-004 (API/service node) is closed.** `graph-next.sh` names **EP-005** — the portal node.

## Three provisioning actions unblock the credential-dependent rows

These are the only things standing between the current state and a fully verified API node. Each is an environment
action, not code, and none of them is simulated anywhere in this repository.

1. **`DATABASE_URL`** — export the PostgreSQL DSN (`sh scripts/db-provision.sh` writes it to the state file outside the
   repository). PostgreSQL IS provisioned and reachable and the database suites run against it; what is unset is the
   exported VARIABLE the probes read. Unblocks the `BLOCKED_CREDENTIALS` rows whose probe is
   `sh scripts/probes/database_url.sh`.
2. **`VALKEY_URL`** — provision the coordination store. Until then the webhook replay binding in production is the
   durable FILE store (append-only, exclusive lock), which is proven, while the Valkey binding has never been
   exercised against a real store. Probe: `sh scripts/probes/valkey_url.sh`.
3. **`KEYCLOAK_ISSUER`** — point the service at a real identity provider. Token validation is proven against locally
   signed tokens; that is a different claim from a real IdP, and the row says so. Probe: `sh scripts/probes/keycloak.sh`.

## What EP-004 verified, exactly

`sh scripts/gate-api.sh` → `gate-api: ok`; the credential-free contract suite; the black-box acceptance suite with
runtime canaries; the vocabulary gate (`copy lint gate: ok`); unit and integration suites. **Every registry route has
a handler**, and **six routes cannot perform their declared effect** — each refuses and names the missing dependency:

| Route | Blocked by |
|---|---|
| `POST /v1/discovery-runs`, `GET /v1/discovery-runs`, `GET /v1/discovery-runs/{id}` | no specification defines `DiscoveryRun` |
| `POST /v1/evidence-artifacts` | no multipart parser and no `EvidenceStore` |
| `GET /v1/evidence-artifacts/{id}/content` | no `EvidenceStore`, and the port as declared cannot isolate tenants |
| `POST /v1/evidence-artifacts/{id}/integrity-checks` | no `EvidenceStore` |
| `POST /v1/subjects/{subjectId}/identifiers` | no durable key provider (ADR-006 open) |

The honest statement of this node: **the credential-free contract and black-box acceptance suites pass; the
credential-dependent rows are `BLOCKED_CREDENTIALS` on the named variables; six routes are `BLOCKED_PREREQUISITE` on
named missing dependencies.** "EP-004 complete" does not mean the API works — it means every route has a handler, every
claim has executed evidence, and every gap is recorded where a reader will find it.

## What EP-005 inherits

The UI node consumes the same gate for its copy rules (`sh scripts/copy-lint-gate.sh`, VG-UI-080…083) and the OpenAPI
document at `.agent/evidence/openapi.json`. Two inherited debts are named in `ASSUMPTIONS.md`: every hand-parsed write
route except §5.1.1 still IGNORES an undeclared body field (§3.45 item 1), and the `KeyProvider` port cannot encrypt a
value at all, so §5.1.7 has no path to its effect (§3.37 item 3).
