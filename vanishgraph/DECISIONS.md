# Decisions

New decisions require evidence, alternatives, risks, approval and invalidation.
A decision that changes the stack invalidates affected downstream evidence
(DOD-040); §4 records exactly what this change set invalidates.

## 1. Original decisions (retained unless amended)

| ADR | Decision | Status |
|---|---|---|
| ADR-001 | PostgreSQL is canonical. | **AMENDED by ADR-016** (Temporal dropped; see below). |
| ADR-002 | Source and search are separate effects. | Retained. |
| ADR-003 | Unclear write permission means `HUMAN_REQUIRED`, never "try harder". | Retained. |
| ADR-004 | Official provider transports only. | Retained. |
| ADR-005 | Production deployment is manual only. | Retained. |
| ADR-006 | Cloud selected by a preflight scored ADR. | Retained, still `OPEN`. |

## 2. Licence

### ADR-014 — Licence is Apache-2.0

**Decision.** VanishGraph is released under the Apache License 2.0 (`LICENSE`).

**Because.** A privacy-removal service makes security claims other people must rely
on, and adopters — including companies self-hosting it — need the explicit patent
grant Apache-2.0 §3 provides; MIT and BSD-3 do not give one. Apache-2.0 is also the
licence of the components already chosen (Keycloak, Playwright, Crawlee, SeaweedFS)
and is compatible with the rest (Valkey BSD-3, GlitchTip MIT), so the distribution
carries no conflicting obligations. It permits commercial self-hosting and hosted
operation without a separate grant, which is the point of an open-source privacy tool.

**Alternatives rejected.** MIT (no patent grant). AGPL-3.0 (would force source
disclosure on hosted operators, deterring the enterprise and agency adopters this
product needs, and is incompatible with nothing here but adds friction for no
privacy benefit). BUSL/SSPL (not open source; fails the stated goal).

**Consequences.** Per-file copyright notices are not required by Apache-2.0, but
modified files must carry change notices (§4b) and a `NOTICE` file must be preserved
where one is distributed. **The copyright holder name is not yet recorded — this
requires the owner's decision, and `NOTICE` currently carries a placeholder that
must be replaced before any public release.**

**Non-commercial sources remain forbidden.** `LICENSE_POLICY.md` forbids
Optery's directory and DrCaiola/optout (both CC BY-NC-SA) and all-rights-reserved
repositories. An open-source licence for *our* code does not grant rights to
*their* data; that restriction is unaffected by ADR-014.

## 3. Stack

The goal is optimal for this project's actual scope: a multi-tenant,
evidence-first privacy-removal service that must be **self-hostable by a small
team**, auditable by a security reviewer, and cheap to run. Every change below
removes an operational or security liability rather than adding a preference.

### ADR-016 — Replace Temporal with Postgres-native durable jobs

**Decision.** Durable workflow execution moves to Postgres-native job processing
(reference implementation: Graphile Worker), behind the `JobQueue` port. Temporal is
no longer required.

**Because.** Temporal is a second stateful cluster with its own datastore, server
tier, and worker fleet. For an open-source project intended to be self-hosted, that
is the single largest adoption barrier in the original stack, and it buys
orchestration this system does not need: the durable state machine already lives in
our domain and in PostgreSQL (`RequestCase`, the T1–T21 transition table, evidence,
idempotency keys). What the system genuinely requires is (a) delayed execution for
deadlines and multi-day observation windows, (b) retry with backoff on transient
failure, (c) at-most-once external effects, and (d) scheduled re-observation for
reappearance. A Postgres-backed queue provides all four.

**This is also a correctness improvement, not only a simplification.** A job is
enqueued **inside the same transaction** as the state transition that requires it.
A dual-write between application state and an external orchestrator cannot commit
half-way here, which removes an entire class of inconsistency rather than managing
it.

**Alternatives rejected.** Temporal (operational weight; see above). Building a
bespoke queue on `LISTEN/NOTIFY` alone (loses durability and backoff). Kafka/NATS
(another broker to run; no gain at this scale).

**Consequences.** No long-running multi-step orchestration DSL; workflow logic must
be expressed as explicit, resumable domain steps. This is acceptable because
resumability is already a design property of the state machine (SPEC-001 §10). A
Temporal adapter may be added later behind the same port for very large deployments;
it is not part of the reference build.

### ADR-007 — UI is a Vite + React SPA, not Next.js

**Decision.** The portals are a Vite + React single-page application using TanStack
Router and TanStack Query, served as static assets by the API process (or a CDN).
Next.js is no longer required.

**Because.** Every portal surface is behind authentication. Server-side rendering and
SEO therefore buy nothing, while Next.js costs a second server runtime, a
server/client component boundary, and a category of accidental data-exposure risk
when server-side data crosses into client components. For a product whose entire
premise is not leaking subject PII, a boundary that can move data to the browser by
mistake is the wrong architecture. A SPA with a single API origin is also far easier
to self-host (one process, one port), simpler to lock down with a strict CSP, and
easier to verify for WCAG 2.2 AA because there is no hydration/streaming variance.

**Alternatives rejected.** Next.js (above). Remix/React Router framework mode (server
runtime for no benefit here). Plain server-rendered templates (poor fit for the
interactive case timeline and review queue).

**Consequences.** Public marketing pages, if any, must be a separate static site and
must not carry claims stronger than the evidence (`PRODUCTION_READINESS.md`).
Accessibility work targets a single rendering path, which reduces the risk of
hydration-specific AT failures.

### ADR-008 — Data access is Kysely plus SQL-first migrations

**Decision.** `Kysely` for typed queries; `node-pg-migrate` for migrations written as
SQL.

**Because.** Tenant isolation depends on `SET LOCAL app.tenant_id` being scoped to the
correct transaction (SPEC-002 §3). Data layers that own the connection or hide the
transaction make that easy to get wrong, and getting it wrong is a cross-tenant PII
breach. Kysely is a typed SQL builder, not an ORM: it keeps SQL explicit and
reviewable, which is what a schema containing RLS policies, constraint triggers, and
append-only rules demands. Raw SQL migrations are required because policies and
triggers cannot be expressed through a schema DSL.

**Alternatives rejected.** Prisma (hides SQL, ships its own engine binary, and makes
transaction-scoped session settings awkward). Drizzle (capable, but codegen-heavy for
a schema this exposed to review).

### ADR-009 — Zod at every boundary

**Decision.** All external input (HTTP, webhook, config, env) is validated with Zod
schemas shared between API and UI.

**Because.** TS-native, no codegen, and the parse failures map directly onto the
SPEC-006 error taxonomy. Shared schemas mean the UI cannot drift from the API contract.

### ADR-010 — Testcontainers for real-dependency tests

**Decision.** Integration tests run against real PostgreSQL, Valkey, and S3-compatible
storage provisioned by Testcontainers, torn down per run.

**Because.** DOD-009 forbids substitutes in integration claims and DOD-005 requires a
known-baseline environment with teardown proof. Docker is available in the build
environment. This is what makes the RLS cross-tenant negative tests (VG-DATA-002/003)
real rather than simulated.

### ADR-011 — pgvector in the existing PostgreSQL

**Decision.** Identity-similarity search uses the `pgvector` extension in the same
database.

**Because.** It avoids a second datastore for a bounded need. Bounded similarity only
(no unbounded embedding store), and vectors are derived data, never authoritative.

### ADR-012 — Keycloak as the reference identity provider, OIDC-generic

**Decision.** Keycloak is the reference IdP. The application depends only on OIDC
discovery, token claims and MFA assertions.

**Because.** For a privacy product, boring and audited beats lighter and newer.
Apache-2.0, mature WebAuthn/MFA, and license-compatible. The specification models
OIDC generically (SPEC-005 §1), so Zitadel, Authentik or a managed OIDC provider
remain drop-in alternatives; Keycloak is simply the tested default.

### ADR-013 — S3 API with SeaweedFS as the self-hosted default

**Decision.** Evidence objects are stored through the S3 API. SeaweedFS (Apache-2.0) is
the reference self-hosted implementation; managed S3 is used in production.

**Because.** Keeps self-hosting cheap without changing the port or the code path.

### ADR-015 — Valkey is a cache, never a source of truth

**Decision.** Valkey is used for rate limiting, coordination and short-lived caching
only. No durable state, and no state whose loss changes an outcome.

**Because.** Losing the cache must degrade performance, never correctness. This keeps
the minimal self-hosted deployment to PostgreSQL plus object storage if an operator
chooses to run without Valkey.

### Retained unchanged

Fastify for the API. PostgreSQL with RLS as the isolation boundary. Playwright +
Crawlee in isolated non-root containers for browser work. OpenTelemetry + Prometheus
+ GlitchTip for telemetry. TypeScript end to end on Node 24 (native type stripping,
`node:test`), so the domain layer needs no runtime dependency.

## 4. Invalidation from this change set (DOD-040)

| Affected | Action |
|---|---|
| Domain layer and its 94 tests | **Unaffected.** The domain imports only the standard library; it never referenced Temporal or Next.js. This is the payoff of the code law. |
| Spec text naming Temporal as required | Amended: SPEC-001 §5 ports and SPEC-002 §7 now name the `JobQueue` port and Postgres-native scheduling. |
| Spec text naming Next.js | Amended: SPEC-004 and ARCHITECTURE.md name Vite + React. |
| ExecPlans EP-000 … EP-010 | **Regenerated** against this stack. Prior versions naming Temporal/Next.js are superseded. |
| Verification subgraph V-000…V-021 | Not yet executed, so nothing to invalidate. Evidence created before the change: none beyond the domain suite. |

## 5. Open decisions requiring the owner

1. **Copyright holder name for `LICENSE`/`NOTICE`.** Required before public release.
2. **Trademark clearance** for the "VanishGraph" name (`ASSUMPTIONS.md`, still open).
3. **Cloud/KMS selection** (ADR-006) — blocks EP-009, and blocks encryption work in EP-003.
4. **Counsel review** of jurisdictions, authorized-agent evidence, minor handling and
   product claims (`LEGAL_REVIEW_REQUIRED.md`). An open-source licence does not reduce
   this obligation; publishing the software does not make its operators' legal duties
   disappear.
