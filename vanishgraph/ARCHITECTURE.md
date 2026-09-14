# Architecture

VanishGraph is a multi-tenant, evidence-first privacy-removal service. This file is
the **authoritative stack record**. Decisions and their rationale live in
`DECISIONS.md`; where this file and an ExecPlan disagree, this file wins, and the
ExecPlan is defective.

## 1. System shape

```
                    ┌──────────────────────────────────────────┐
   Subject portal   │  Vite + React SPA  (static assets)       │
   Ops console      │  TanStack Router + Query + Zod           │
   Tenant admin     └───────────────────┬──────────────────────┘
   Auditor view                         │ HTTPS, OIDC bearer
                                        ▼
                    ┌──────────────────────────────────────────┐
                    │  Fastify API  (Node 24, TypeScript)      │
                    │  Zod validation · RLS session · OIDC     │
                    └───────┬───────────────────────┬──────────┘
                            │                       │
              domain ◄──────┤                       ├──────► MCP gateway
        (stdlib only)       │                       │        (least privilege)
                            ▼                       ▼
        ┌───────────────────────────────┐   ┌──────────────────────────┐
        │ PostgreSQL 17                 │   │ Valkey                   │
        │  · canonical state + RLS      │   │  · rate limit            │
        │  · durable job queue          │   │  · coordination          │
        │  · append-only audit          │   │  (never source of truth) │
        │  · pgvector (similarity)      │   └──────────────────────────┘
        └───────────┬───────────────────┘
                    │
        ┌───────────▼───────────┐   ┌──────────────────────────────────┐
        │ Worker fleet          │   │ S3-compatible object storage     │
        │  · Playwright+Crawlee │   │  · encrypted evidence artifacts  │
        │  · non-root, isolated │   └──────────────────────────────────┘
        │  · egress restricted  │
        └───────────────────────┘
                    │
        ┌───────────▼───────────────────────────────────────────────────┐
        │ OpenTelemetry → Prometheus → GlitchTip   (DLP-scrubbed egress) │
        └───────────────────────────────────────────────────────────────┘
```

## 2. Code law (binding)

| Layer | May import | Must not import |
|---|---|---|
| `domain` | **standard library only** | application, adapters, infrastructure, frameworks |
| `application` | domain | adapters, infrastructure, HTTP, DB drivers |
| `adapters` | domain, application ports | concrete infrastructure composition |
| `http` / `ui` / `mcp` | application contracts | domain internals, adapters directly |
| `infrastructure` | everything (composition root) | — |

Lower layers never import higher layers. This is enforced by
`scripts/import-boundary.sh` as a hard gate, not a convention.

The payoff is concrete: when the stack changed (ADR-016, ADR-007), the domain layer
and its 94 tests were **unaffected**, because the domain never referenced Temporal or
Next.js. That is what the code law buys.

## 3. Invariants

`SEARCH_HIT` is not `SUBJECT_MATCH`. `REQUEST_SUBMITTED` is not `REMOVED`. Controller
acknowledgment is not independent verification. Source removal and search delisting
are separate effects. Every write has authority, policy, recipe, idempotency and
reconciliation. Stale recipes cannot write. Remote content is untrusted. Every claim
maps to a requirement, test, artifact and evidence.

## 4. Locked stack

Pinned exact versions; `package-lock.json` is committed (DOD-002, VG-SHIP-027).

| Concern | Choice | Licence | Why this one |
|---|---|---|---|
| Language / runtime | TypeScript 5.9 on Node 24 (native type stripping) | Apache-2.0 / MIT | One language end to end; the domain runs directly as `.ts` with no build step and no runtime dependency |
| API | Fastify 5 | MIT | Fast, schema-first, minimal surface |
| Validation | Zod | MIT | TS-native, shared by API and UI, failures map to SPEC-006 codes |
| Data access | Kysely | MIT | Typed SQL, not an ORM: keeps SQL reviewable and the transaction explicit, which RLS session scoping requires |
| Database | PostgreSQL 17 + RLS + `pgvector` | PostgreSQL Licence | Canonical state, isolation boundary, job queue, audit and similarity in one engine |
| Migrations | node-pg-migrate (SQL-first) | MIT | Policies, triggers and constraint rules cannot be expressed through a schema DSL |
| Durable jobs | Postgres-native queue (Graphile Worker) | MIT | Removes a second stateful cluster; enqueue commits atomically with the state transition (ADR-016) |
| Cache / coordination | Valkey | BSD-3-Clause | Rate limiting and coordination only; never a source of truth (ADR-015) |
| Object storage | S3 API; SeaweedFS reference | Apache-2.0 | Cheap self-hosting without changing the code path |
| Identity | Keycloak (OIDC-generic) | Apache-2.0 | Mature MFA/WebAuthn; specs depend only on OIDC discovery and claims |
| UI | Vite + React + TanStack Router/Query | MIT | Authenticated SPA: no SSR benefit, no server/client data-leak boundary (ADR-007) |
| Browser automation | Playwright + Crawlee | Apache-2.0 | Best-in-class, licence-clean, isolated non-root containers |
| Telemetry | OpenTelemetry + Prometheus + GlitchTip | Apache-2.0 / MIT | Open, self-hostable, Sentry-compatible |
| Unit tests | `node:test` (JUnit reporter) | MIT | No dependency; JUnit attributes each case to a file, which TAP does not |
| Integration tests | Testcontainers | MIT | Real PostgreSQL/Valkey/S3 with teardown proof (DOD-005, DOD-009) |
| Project licence | **Apache-2.0** | — | Patent grant matters for a security product; compatible with every component above (ADR-014) |

**Domain runtime dependencies: none.** Enforced by gate.

### Deliberately not used

- **Temporal** — a second stateful cluster for orchestration the domain already
  provides (ADR-016). May return later behind the `JobQueue` port.
- **Next.js** — a server runtime and a server/client boundary for an entirely
  authenticated product (ADR-007).
- **An ORM that owns connections** (Prisma and similar) — makes transaction-scoped
  `SET LOCAL app.tenant_id` error-prone, and getting that wrong is a cross-tenant
  PII breach (ADR-008).
- **Stealth/CAPTCHA-solving tooling, cookie or session reuse, undocumented
  endpoints** — prohibited by `TOS_AUTOMATION_MATRIX.md` and SPEC-000 §3.
- **Non-commercial licensed data** (CC BY-NC-SA directories, all-rights-reserved
  repositories) — `LICENSE_POLICY.md`. An open-source project licence grants no
  rights to third-party data.

## 5. Gate architecture

Every gate script: `#!/usr/bin/env sh`, `set -eu`, POSIX-clean (`sh -n` passes), runs
from repo root, exports the mandated environment, **prints its sentinel only on
genuine success**, and exits non-zero on failure.

Two load-bearing properties:

1. **Placeholders fail loudly.** An unimplemented stage exits non-zero with the
   mandated `ERROR:` signature and prints no sentinel.
2. **A gate that cannot fail is a defect.** `scripts/gate-toolchain.sh` mechanically
   rejects any script that prints a success sentinel without performing a check.

`scripts/verify.sh` enforces the fifteen-stage order fixed by the master prompt and
stops at the first failure. A verification-stage command may exit 0 when accounting
completed even if candidate tests recorded FAIL; the final release gate must exit
non-zero for `NO_GO` and `INCONCLUSIVE`.

## 6. Layer inventory (current, honest)

| Layer | Path | State |
|---|---|---|
| domain | `src/domain/` | **Present.** Value objects, typed errors, the eleven truth states, the closed T1–T21 transition table, guard engine. 94 executing tests pass. |
| application | `src/application/` | Not created — EP-004 |
| adapters | `src/adapters/` | Not created — EP-003/EP-004 |
| http | `src/http/` | Not created — EP-004 |
| ui | `ui/` | Not created — EP-005 |
| workers | `src/workers/` | Not created — EP-003/EP-007 |
| infrastructure | composition root | Not created — EP-009 |

The product does not exist. Only the domain core is real. See
`PRODUCTION_READINESS.md`; the verdict is `INCONCLUSIVE`.

## 7. Deployment expectation

Two supported profiles, both first-class:

- **Minimal self-host** — one Node process (API + static UI), PostgreSQL, S3-compatible
  storage. Valkey optional (ADR-015), Keycloak or any OIDC provider, workers optional
  until discovery is enabled. This profile is why Temporal was removed.
- **Production** — separate API and worker pools, managed PostgreSQL with PITR,
  managed S3 with KMS envelope encryption, Keycloak with MFA enforced, container
  images pinned by digest, and OTel export.

Production deployment is **manual only** and explicitly unauthorised (ADR-005,
VG-SCOPE-009).
