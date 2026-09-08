# SPEC-005 Auth and Permissions

Keycloak OIDC/OAuth2 with MFA and passkeys is the open-source-first identity boundary. Authorization is enforced at API, worker, database, object-store, cache, search, export, and MCP boundaries.

Roles are tenant member, subject owner, authorized operator, reviewer, and restricted support. Support access is just-in-time, reason-bound, time-bound, and audited. Guardian/minor flows default deny until counsel-approved authority evidence exists.

Acceptance includes revoked sessions, expired authority, cross-tenant IDs, operator overreach, object access, and asynchronous context propagation.
