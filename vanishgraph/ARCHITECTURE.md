# Architecture

Next.js/React portals call Fastify APIs; PostgreSQL is canonical with RLS; Temporal owns durable workflows; Valkey coordinates; encrypted S3 evidence; isolated non-root Crawlee/Playwright workers; Keycloak OIDC/MFA; MCP least-privilege gateway; OTel/Prometheus/GlitchTip DLP-safe telemetry.

Code law: domain imports only standard library; application imports domain; adapters implement ports; HTTP/UI/MCP call application contracts; infrastructure composes implementations. Lower layers never import higher layers.

Invariants: SEARCH_HIT is not SUBJECT_MATCH; REQUEST_SUBMITTED is not REMOVED; controller acknowledgment is not independent verification; source and search are separate; every write has authority, policy, recipe, idempotency and reconciliation; stale recipes cannot write; remote content is untrusted; every claim maps to requirement, test, artifact and evidence.
