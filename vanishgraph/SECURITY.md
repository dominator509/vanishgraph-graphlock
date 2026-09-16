# Security

High-risk PII threat model: tenant breakout, takeover, fraudulent authority, SSRF, prompt injection, malicious web/PDF, stale recipes, duplicate writes, webhook replay, credential theft, browser escape, supply chain and admin overreach. Controls are OIDC/MFA, RLS, KMS encryption, short-lived identity, DLP, non-root browser pods, typed effect budgets, signed recipes/policies, audit, rate limits, secret/SBOM scans, safe migrations and immutable artifact identity.

## Discovered security facts (EP-006 M1)

The blanks in this document are `<PORTAL_AUD>`, `<SERVICE_AUD>`, `<MCP_AUD>`, `<REALM_ISSUER>` and `<STEP_UP_ACR>`.
They are filled from the client registration when a realm exists. **No realm is provisioned in this environment**, so
each blank is recorded as `BLOCKED_CREDENTIALS` with the probe command and its observed exit code rather than invented:
a plausible-looking audience string would make a misconfigured deployment look configured, and every token check
downstream would then validate against a value nobody registered.

| Probe | Observed exit | Output (verbatim) | Blanks it would fill |
|---|---|---|---|
| `sh scripts/probes/keycloak.sh` | 1 | `ERROR: KEYCLOAK_ISSUER is unset; see PREFLIGHT.md and .env.example; provision it then re-run; unblocked by EP-006` | `<REALM_ISSUER>`, `<PORTAL_AUD>`, `<SERVICE_AUD>`, `<MCP_AUD>`, `<STEP_UP_ACR>` — `BLOCKED_CREDENTIALS`: no realm provisioned; values to be filled from the client registration when `KEYCLOAK_*` is supplied |
| `sh scripts/probes/database_url.sh` | 1 | `ERROR: DATABASE_URL is unset; see PREFLIGHT.md and .env.example; provision it then re-run; unblocked by EP-003` | none (recorded for the RLS second layer) |
| `sh scripts/probes/valkey_url.sh` | 1 | `ERROR: VALKEY_URL is unset; see PREFLIGHT.md and .env.example; provision it then re-run; unblocked by EP-003` | none (recorded for replay protection) |
| `sh scripts/probes/cloud_identity.sh` | 1 | `ERROR: CLOUD_WORKLOAD_IDENTITY is unset; see PREFLIGHT.md and .env.example; provision it then re-run; unblocked by EP-009` | none (recorded for KMS) |
| `sh scripts/probes/local_model.sh` | 1 | `ERROR: LOCAL_MODEL_ENDPOINT is unset; see PREFLIGHT.md and .env.example; provision it then re-run; unblocked by EP-013` | none |

The exit codes above are the observed ones, recorded as `BLOCKED_CREDENTIALS` rather than as defects: an unprovisioned
environment is not a product failure, and the mechanism that reports it is the probe itself.
