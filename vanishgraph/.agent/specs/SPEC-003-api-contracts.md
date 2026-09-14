# SPEC-003 — HTTP API Contracts for the Fastify Service Layer

Status: SPECIFICATION (normative). Supersedes the 155-byte stub of this path.
Depends on: SPEC-000 (vocabulary lock, truth model, acceptance oracle),
SPEC-001 (domain entities, closed state machine T1–T21, commands, events).
Cross-references: SPEC-005 (authentication and permissions), SPEC-006 (error
taxonomy), SPEC-007 (observability and egress classes), SPEC-002 (persistence).

**Authority.** SPEC-000 is the oracle. Where this file, any route table, any
schema, any handler comment, or any model output contradicts SPEC-000, SPEC-000
wins and this file is defective (DOD-027). Where this file contradicts SPEC-001,
SPEC-001 wins and this file is defective. This document is a specification of an
intended contract. **Nothing in this file is a claim that any route exists, is
implemented, or has been exercised.** No endpoint described here is implemented or
tested as of this revision; no test result, coverage number, or live-fire outcome
is asserted or implied by any row below.

Requirement-ID scheme: `VG-API-<NNN>`. IDs are permanent and are never reused,
renumbered, or deleted (SPEC-000 header). Every ID carries exactly one acceptance
oracle and exactly one required negative case. `VG-API-*` IDs are new to this
file and do not restate, weaken, or supersede any `VG-SCOPE-*`, `VG-IDENT-*`,
`VG-DISC-*`, `VG-AUTHZ-*`, `VG-POLICY-*`, `VG-CHANNEL-*`, `VG-ACTION-*`,
`VG-VERIFY-*`, `VG-REAPPEAR-*`, `VG-EVIDENCE-*`, `VG-TENANT-*`, `VG-EGRESS-*`,
`VG-SEC-*`, `VG-OPS-*`, `VG-OBS-*`, or `VG-REL-*` requirement. `VG-API-*` rows
bind the *service boundary only*; they are satisfied only when the underlying
`VG-*` requirement they serve is also satisfied on its own oracle.

---

## 1. Purpose and layer position

This specification defines the HTTP contract of the Fastify service layer for the
Next.js portals and the MCP/agent gateway. Per `ARCHITECTURE.md` code law and
SPEC-001 §1, the HTTP layer calls **application contracts only**: it must not
import domain internals or adapters directly. A route handler validates input,
resolves the caller's tenant, roles, and scopes, dispatches exactly one application
command or query, maps the result to a DTO, and returns. A route handler may
**never** set a truth state, write a state field, or call a model to decide a
legal question (SPEC-001 §4.3 SM-6, VG-POLICY-001).

Two consequences bind every route in §5 and every webhook in §6:

1. A route that transitions state maps to exactly one SPEC-001 §6 domain command,
   and the guard list of the corresponding SPEC-001 §4.1 transition is enforced
   before any persistence. A route that would require a transition *not* listed in
   SPEC-001 §4.1 is not specified here and must be refused with
   `ILLEGAL_TRANSITION` (SPEC-001 §4.2).
2. A route response may only report `truthState` values from the eleven SPEC-000
   §5 states. No route accepts a truth state as request input. Truth state is an
   outcome of a guarded command, never a settable field (§7.3).

---

## 2. API conventions

### 2.1 Base path and versioning

- Base path: **`/v1`**. All routes in §4 are absolute paths from the API origin.
- The major version is a **path segment** and is the only versioning mechanism.
  There is no `Accept`-header version negotiation and no unversioned alias route.
- Additive, backward-compatible change (new optional request field, new response
  field, new route, new enum member on a *non-truth-state* enum) keeps `/v1`.
- Breaking change (removing or renaming a field, changing a status code, changing
  a required field, adding a member to a closed enum, altering idempotency or
  replay behavior) requires `/v2`. Both majors may run concurrently during a
  documented migration window; the window length is an operations decision and
  is recorded in `OPERATIONS.md`, not here.
- **Truth-state vocabulary is closed at `/v1` and is never a candidate for
  additive change.** A twelfth truth state is a SPEC-000 change, which
  invalidates downstream evidence (VG-REL-004), not a `/v1` or `/v2` API change.
- Internal/admin-only surfaces, if any, are separate services with separate
  manifests and are **not** reachable under `/v1` (§10).

### 2.2 Content types

| Direction | Rule |
|---|---|
| Request body | `application/json; charset=utf-8`, except §5.12.1 evidence upload which is `multipart/form-data`. |
| Response body | `application/json; charset=utf-8`, except §5.12.3 evidence content download which is the stored artifact media type with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. |
| Webhook ingress | `application/json` only. Any other media type is `415 UNSUPPORTED_MEDIA_TYPE`. |
| Unsupported media type | `415` with error code `UNSUPPORTED_MEDIA_TYPE`. |
| Field naming | `camelCase` (matches SPEC-001 entity field names verbatim). |
| Timestamps | RFC 3339 / ISO 8601 UTC with explicit `Z` and millisecond precision, e.g. `2026-02-04T09:31:22.104Z`. |
| Durations and windows | Integer seconds with a unit suffix in the field name (`observationWindowSeconds`, `minObservationWindowSeconds`). |
| Money | Minor units plus ISO 4217 currency (`{"amountMinor": 1280, "currency": "USD"}`), never a float (SPEC-001 §2 `Money`). |
| IDs | Opaque URL-safe strings. Raw PII is never an ID (SPEC-001 §3 note). |
| Digest | 64 lowercase hex characters (`EvidenceDigest`, SPEC-001 §2). |

### 2.3 Required request headers

| Header | Required on | Semantics |
|---|---|---|
| `Authorization` | every route except §5.17 health/readiness/liveness/startup and §6 webhook ingress | `Bearer <OIDC access token>` (§3). |
| `X-Request-Id` | every route | Caller-generated opaque ID, 8–128 chars, `[A-Za-z0-9._:-]` only. Echoed verbatim in the response and in every audit row for the operation. If absent or malformed the API generates one; it never rejects the request for this header alone. |
| `Idempotency-Key` | every state-changing route marked **Required** or **Required-if-effect** in §4 (§4) | See §4. |
| `If-Match` | every state-mutating route on an existing case or exposure case-scoped resource | Optimistic concurrency token (§2.7). |
| `Content-Type` | any route with a body | §2.2. |

### 2.4 Correlation and tenant propagation

- The API derives the tenant binding **only** from the validated `tenant_id` access-token claim
  (§3.2). A `tenantId`/`tenant_id` in a body, query string, or path is never authoritative,
  and any route that would accept one is a defect.
- Two spellings exist for the same opaque value and both are deliberate: the **token claim** is
  `tenant_id` (SPEC-005 IDP-4, snake_case, owned by the identity provider) and the
  **log/trace/metric attribute** is `tenantId` (SPEC-007 §5.3). Request and response **body**
  fields are `camelCase` per §2.2 and never carry the tenant at all.
- The API sets the PostgreSQL session variable used by RLS from the validated
  token (`SET LOCAL app.tenant_id = <tenantId>`) inside the request transaction.
  This is the SPEC-000 VG-TENANT-001 mechanism; the HTTP layer does not
  re-implement tenant filtering in application code as its only defense
  (VG-TENANT-002).
- `correlationId`: the API assigns one per request from the W3C `traceparent`
  header when present and well-formed, otherwise it generates one. `correlationId`
  and `X-Request-Id` are distinct: `correlationId` is the trace/audit join key
  across discovery → action → verification (VG-OBS-001); `X-Request-Id` is the
  caller's own identifier for one HTTP call. Both appear in every `AuditEvent`
  (SPEC-001 §3.5) and in every error body (§8).
- `traceparent` is accepted and propagated. It is never trusted for
  authorization, tenant resolution, or sampling policy.

### 2.5 Pagination — cursor only

- Every collection route returns `{"data": [...], "page": {...}}`.
- Query parameters: `limit` (integer, 1–100, default 25) and `cursor` (opaque).
- There is **no** `offset` parameter on any route. Offset pagination over
  append-only evidence is not offered because it cannot be made stable.
- `page.nextCursor` is `null` on the last page. Clients must not construct,
  decode, or persist a cursor as a stable identifier.
- A cursor is opaque, tenant-bound, and HMAC-signed by the API. Presenting a
  cursor issued for a different tenant, route, filter set, or sort order is
  rejected with `400 INVALID_CURSOR`. A cursor is confirmation-of-nothing: it
  carries no PII and no truth state.
- `page` object shape: `{"limit": 25, "nextCursor": "…", "hasMore": true,
  "sort": "observedAt:desc", "filter": {…echoed normalized filter…}}`.

### 2.6 Filtering and sorting

- Filters are explicit query parameters listed per route. Unknown query
  parameters are rejected with `400 UNKNOWN_QUERY_PARAMETER` (strict parsing) so
  that a typo cannot silently widen a result set.
- Multi-value filters are comma-separated and OR within a parameter, AND across
  parameters. At most 20 values per parameter; more is `400 FILTER_TOO_BROAD`.
- Time-range filters are `from`/`to` (inclusive lower, exclusive upper), RFC 3339.
  A missing range on a time-filterable collection defaults to the last 30 days
  and the response `page.filter` echoes the applied default, so an accidental
  wide scan cannot present itself as a narrow one.
- `truthState` filtering accepts only SPEC-000 §5 tokens; an unknown token is
  `400 INVALID_TRUTH_STATE`, never silently ignored.
- Sorting: `sort=<field>:<asc|desc>`, one field only, from the route's
  documented allowlist. Default sort per route is stated in §4. Sort fields are
  never raw PII and never a free-text match input (SPEC-001 §3 note).
- Free-text search is not offered on any `/v1` route. Name/alias search is
  modelled as `aliasValueHash` exact-match filtering on §5.1.2, so that a search
  box cannot become a subject-enumeration oracle (VG-SCOPE-001, VG-SCOPE-002).

### 2.7 Rate limits, ETag, and concurrency

- Limits are enforced per `(tenantId, subject)` where a subject is implied, and
  per `(tenantId, sourceId)` for discovery — the per-source conservative limit of
  VG-DISC-003 is enforced **client-side by this API before dispatch**, so an
  over-budget call is refused rather than silently overrun.
- Every response carries `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset` (delta-seconds). A refused call is
  `429 RATE_LIMITED` with `Retry-After` (seconds) and no state change.
- Effect budgets are separate from rate limits and are authoritative in the
  domain (VG-ACTION-005). Exceeding an effect budget is `409` with
  `EFFECT_BUDGET_EXCEEDED` and an `AuditEvent`; it is never retried silently by
  the API.
- ETag: state-mutating case-scoped routes and evidence metadata reads return
  `ETag: "<truthState>:<updatedAtEpochMillis>"`. Mutations require `If-Match`; a
  missing header is `428 PRECONDITION_REQUIRED`, a stale value is
  `412 PRECONDITION_FAILED` with the current ETag in the body. ETag is
  **per-resource optimistic concurrency**, not a substitute for `truthState`
  guards: a fresh ETag with an illegal transition is still
  `409 ILLEGAL_TRANSITION`.
- Two concurrent requests carrying the same `If-Match` value: exactly one
  succeeds; the other receives `412`. The loser must re-read, re-evaluate the
  guard set, and re-issue — it must not blind-retry (VG-ACTION-002).

---

## 3. Authentication and authorization at the API boundary

### 3.1 Delegation to SPEC-005

Identity-provider configuration, session model, MFA policy, human roles, the
`AuthorityGrant` kind/evidence table, identity-verification levels (`IAL0`–`IAL3`),
step-up policy, secret handling, and the full role × resource authorization matrix
are defined in **SPEC-005** and are **not redefined here**. This section specifies
only what the HTTP layer must do with an already-issued token, and what it must
refuse. Where SPEC-005 and this section disagree on an authentication mechanism,
SPEC-005 governs and this section is defective; where they disagree about an HTTP
status code or response field, this file governs the wire and SPEC-005 governs the
policy behind it.

This document adopts SPEC-005 §2's role names verbatim: `SUBJECT_USER`,
`GUARDIAN`, `OPERATOR`, `TENANT_ADMIN`, `AUDITOR`, `SUPPORT`, `COUNSEL_REVIEWER`.
No other role token is recognised by `/v1`.

### 3.2 What the API enforces

1. **Bearer only.** Keycloak OIDC access tokens validated against the realm JWKS
   with signature, `iss`, `aud`, `exp`, `nbf`, and `azp` checked. Query-string
   tokens, cookies, `X-Api-Key` headers, and `Authorization: Basic` are not
   accepted on any `/v1` route.
2. **Required claims** (SPEC-005 IDP-4, adopted verbatim): `sub` (the human
   operator — never a `ProtectedSubject`), `iss`, `aud`, `exp`, `tenant_id`,
   `roles[]`, `subject_ref`, `auth_level`. SPEC-005's claim names are the contract;
   the API reads `tenant_id`, `roles`, `subject_ref`, and `auth_level` and does not
   invent parallel camelCase claims. A token missing `tenant_id` is rejected
   outright and **there is no "all tenants" token** (SPEC-005 IDP-4). A token
   missing `roles` is `401 TOKEN_INVALID_CLAIMS` — never treated as an empty role
   set, because "absent means none" and "absent means unverified" are different
   failures and only one of them is safe.
3. **Audience binding.** Portal tokens, service/workload tokens, and MCP tool
   tokens carry distinct `aud` values. A token presented to the wrong audience is
   `401 TOKEN_AUDIENCE_MISMATCH`. This is what keeps an MCP token from being
   replayed against a portal route (§9).
4. **Tenant scoping.** `tenant_id` comes from the token only. Every query executes
   under RLS with that tenant: the API sets
   `SET LOCAL app.tenant_id = <tenant_id>` inside the request transaction, which is
   exactly the `current_setting('app.tenant_id', true)` mechanism of SPEC-002 §6.
   A request naming a resource owned by another tenant receives
   **`404 RESOURCE_NOT_FOUND`**, byte-identical to a genuinely absent resource, not
   `403` (SPEC-005 §9 `VG-AUTH-017`, SPEC-006 H-9, VG-TENANT-001).
5. **Defense in depth.** Service-layer authorization and RLS both run (SPEC-005
   ROLE-1, VG-TENANT-002). Either one alone rejecting the call is not sufficient
   evidence; the connection role is not the table owner and lacks `BYPASSRLS`
   (SPEC-002 RLS-4).
6. **Two authorization inputs, both required.** A route authorizes on (a) the
   caller's SPEC-005 role membership per the SPEC-005 §5 matrix and (b) the scope
   strings of §3.3, which further constrain *what kind of act* is permitted and
   carry the effect-bearing distinction. Both are evaluated; a role membership
   never by itself authorizes an external effect (SPEC-005 `VG-AUTHZ-015`), and a
   scope never by itself authorizes a role-gated resource. MCP/agent tokens hold
   the machine scope subset of §3.3 rather than a human role.
7. **Step-up.** Sensitive operations require re-authentication within 5 minutes
   per SPEC-005 §6. Where a route is marked *step-up* in §4, the API requires
   `auth_level` to be the level SPEC-005 §6 requires for that operation and the
   token's authentication time to be within the 5-minute window; otherwise
   `403 STEP_UP_REQUIRED`. A stale step-up is refused, never silently downgraded
   (SPEC-005 `VG-AUTH-005`, `VG-AUTH-026`). Step-up is required for:
   `AuthorityGrant` mint/expand (5.2.1), `AuthorityGrant` revocation (5.2.3),
   external action execution (5.8.2), certified-mail generation (5.8.2 with
   `channel: "CERTIFIED_MAIL"`), escalation creation (5.14.1), identifier reveal
   (5.1.6/5.1.8 `includeValue=true`), evidence content download (5.12.3), and
   source/recipe changes (5.3.4, 5.3.7, 5.3.10).
8. **Separation of duties.** `TENANT_ADMIN` may not approve its own
   `AuthorityGrant` (SPEC-005 `VG-AUTHZ-016`); the API refuses with
   `403 SEPARATION_OF_DUTIES` and routes to a second authorized human or counsel.
   Impersonation of a `SUBJECT_USER` is prohibited (SPEC-005 ROLE-3): no header,
   query parameter, or claim grants it, and none exists.
9. **Machine identity.** Service-to-service calls use short-lived workload
   identities (SPEC-005 IDP-5). A machine token carries no human `sub`, must carry
   an explicit role or scope set (never `*`), and must not hold
   `vg.authority.write`, `vg.policy.write`, `vg.appeal.write`, `vg.actions.execute`,
   `vg.audit.read`, `vg.pii.reveal`, or `vg.evidence.read_content`. A wildcard
   scope value is `401 TOKEN_SCOPE_WILDCARD_FORBIDDEN`.
10. **Identity-verification gating.** SPEC-005 §4 (`IAL0`–`IAL3`) governs which
    actions a subject-attributed request may take. The API surfaces the recorded
    level and the required level; a request below the required level is refused
    `403 IDENTITY_LEVEL_INSUFFICIENT` and no write-producing state becomes
    reachable (SPEC-005 `VG-AUTH-001`). Which level a given jurisdiction, channel,
    or subject class requires is a `PolicyDecision` question, and for unresolved
    cases a **counsel-review** question (`LEGAL_REVIEW_REQUIRED.md`).

### 3.3 Scope vocabulary (closed)

Scopes are a `/v1` capability vocabulary that sits alongside the SPEC-005 role
matrix. They are lowercase, dotted, and fixed at `/v1`. Adding a scope is
additive; removing or renaming one is a breaking change (§2.1). Every scope is
**narrower than or equal to** the SPEC-005 role grants that can carry it, and no
scope may be used to widen a role.

| Scope | Permits | Roles that may carry it (SPEC-005 §2) |
|---|---|---|
| `vg.subjects.read` | Read `ProtectedSubject`, `Alias`, `Identifier` (masked), `LocationHistory`. | `SUBJECT_USER` (own), `GUARDIAN` (minor), `OPERATOR`, `TENANT_ADMIN`, `AUDITOR`, `COUNSEL_REVIEWER`, `SUPPORT` |
| `vg.subjects.write` | Create and update subjects, aliases, identifiers, location history. | `SUBJECT_USER` (self), `GUARDIAN` (minor), `TENANT_ADMIN` |
| `vg.authority.read` | Read `AuthorityGrant`. | `TENANT_ADMIN`, `AUDITOR`, `COUNSEL_REVIEWER`, `OPERATOR` |
| `vg.authority.write` | Create and revoke `AuthorityGrant`. | `TENANT_ADMIN` (revocation; mint subject to separation of duties), `SUBJECT_USER` (revoke own), `GUARDIAN` (revoke minor's) |
| `vg.sources.read` | Read `Source`, `SourceCatalogEntry`, `RemovalRecipe` metadata. | `OPERATOR`, `TENANT_ADMIN`, `AUDITOR`, `COUNSEL_REVIEWER` |
| `vg.sources.write` | Write `Source` and `SourceCatalogEntry`. | `TENANT_ADMIN` |
| `vg.recipes.write` | Write `RemovalRecipe` draft versions and enable/disable them. | `TENANT_ADMIN` (signed only) |
| `vg.discovery.read` | Read discovery runs and `SourceRecord`. | `SUBJECT_USER` (own), `GUARDIAN` (minor), `OPERATOR`, `TENANT_ADMIN`, `AUDITOR` |
| `vg.discovery.run` | Start a discovery run. Read-only by default (VG-DISC-001). | `SUBJECT_USER` (self, at or above SPEC-005 IAL1), `GUARDIAN` (minor), `OPERATOR`, `TENANT_ADMIN` |
| `vg.exposures.read` | Read `Exposure` and `SourceRecord`–subject assessment state. | `SUBJECT_USER` (own), `GUARDIAN` (minor), `OPERATOR`, `TENANT_ADMIN`, `AUDITOR`, `COUNSEL_REVIEWER` |
| `vg.exposures.assess` | Submit a match assessment (T3/T4). | `OPERATOR`, `TENANT_ADMIN` |
| `vg.policy.read` | Read `PolicyDecision` and jurisdiction policy versions. | `OPERATOR`, `TENANT_ADMIN`, `AUDITOR`, `COUNSEL_REVIEWER` |
| `vg.policy.write` | Request `PolicyDecision` resolution (versioned data only). | `TENANT_ADMIN` (data-only; the API authors no legal basis) |
| `vg.cases.read` | Read `RequestCase`, `Deadline`, `ControllerResponse`. | `SUBJECT_USER` (own), `GUARDIAN` (minor), `OPERATOR`, `TENANT_ADMIN`, `AUDITOR`, `COUNSEL_REVIEWER`, `SUPPORT` |
| `vg.cases.write` | Create and update `RequestCase` (non-effect fields). | `OPERATOR`, `TENANT_ADMIN` |
| `vg.actions.execute` | Execute an `ExternalAction` (write to the outside world). | `OPERATOR`, `TENANT_ADMIN` (both gated by `VG-AUTHZ-015`: grant + decision + recipe + budget) |
| `vg.actions.read` | Read `ExternalAction`, `MailPiece`, `EmailThread`, readback state. | `OPERATOR`, `TENANT_ADMIN`, `AUDITOR`, `COUNSEL_REVIEWER` |
| `vg.observations.write` | Record `VerificationObservation` and `Reappearance`. | `OPERATOR`, `TENANT_ADMIN` |
| `vg.observations.read` | Read `VerificationObservation` and `Reappearance`. | `OPERATOR`, `TENANT_ADMIN`, `AUDITOR`, `COUNSEL_REVIEWER` |
| `vg.evidence.read` | Read `EvidenceArtifact` metadata. | `SUBJECT_USER` (own), `GUARDIAN` (minor), `OPERATOR`, `TENANT_ADMIN`, `AUDITOR`, `COUNSEL_REVIEWER` |
| `vg.evidence.read_content` | Download artifact content (also requires step-up). | `OPERATOR`, `TENANT_ADMIN`, `AUDITOR`, `COUNSEL_REVIEWER` |
| `vg.evidence.write` | Upload `EvidenceArtifact` and link it. | `OPERATOR`, `TENANT_ADMIN` |
| `vg.appeal.write` | Create an `AppealEscalation` (also requires step-up). | `COUNSEL_REVIEWER` |
| `vg.audit.read` | Query the append-only `AuditEvent` stream. | `AUDITOR`, `OPERATOR` (case-scoped), `TENANT_ADMIN`, `SUBJECT_USER` (own), `GUARDIAN` (minor) |
| `vg.coverage.read` | Read coverage reports and removal-effectiveness metrics. | `OPERATOR`, `TENANT_ADMIN`, `AUDITOR` |
| `vg.pii.reveal` | Receive unmasked identifier values (also requires step-up). | No standing role; granted explicitly per SPEC-005 §2 `SUPPORT` rules and never to a machine token |

**`vg.webhooks.ingest` is deliberately absent from this table.** It is not a
caller-issued scope: webhook ingress is authenticated by signature and capability
token (§6), not by a bearer scope, and no token may carry a scope that would let a
caller forge ingress.

Authorization is evaluated as: **(a)** the route's required role set per SPEC-005
§5 **and (b)** the route's required scopes from this table **and (c)** the
`AuthorityGrant` scope and expiry re-asserted at execution time inside the
transaction (SPEC-005 `VG-AUTHZ-004`/`VG-AUTHZ-005`) **and (d)** the SPEC-001 §4.1
guard list for the transition, evaluated against live state. All four must pass.
A stale token whose role set was valid when issued but no longer matches tenant
entitlement is rejected by the application-layer entitlement check, and that
rejection is audited.

---

## 4. Idempotency semantics

### 4.1 Which routes require an `Idempotency-Key`

Every state-changing route whose execution can produce an external effect
(VG-ACTION-001) requires the header: **all of §5.8**. Every other state-changing
route requires it when the request is retryable from the caller's perspective
(create/upload/ingest routes) and accepts it optionally on transitions that are
already guarded by resource state. The §4 catalogue states this per route as
**Required**, **Required-if-effect**, or **Optional**. A route marked Required
that arrives without the header is `400 IDEMPOTENCY_KEY_REQUIRED` and produces no
state change.

### 4.2 Key properties

- An `IdempotencyKey` is a caller-chosen opaque string, 16–255 chars,
  `[A-Za-z0-9._:-]`. It is stable across retries of the same intended effect and
  unique per intended effect (SPEC-001 §2).
- Scope of uniqueness: `(tenantId, method, routeTemplate, idempotencyKey)`.
  Reusing a key on a different route is a different key — and a caller that does
  so is not protected, so clients must derive keys per effect.
- The API stores, for a completed key: the response status, the response body,
  the SHA-256 fingerprint of the canonicalized request body (and, for multipart
  uploads, the artifact digest), the resulting resource ID, `traceparent`, and
  `completedAt`.
- Retention: 24 hours by default, never shorter than the longest retry window the
  documented client uses. A key whose stored record has expired is a new request;
  for §5.8 that is safe only because the *domain* `IdempotencyKey` on the
  `ExternalAction` (SPEC-001 §3.4) is the durable one and outlives the HTTP
  record.

### 4.3 Response behavior

| Case | Status | Body | Effect |
|---|---|---|---|
| First request, completes | The route's documented success status (201/200/204) | Normal success DTO | Effect occurs once. |
| Replay, same key, identical body fingerprint, original completed | The **original** stored status | The **original** stored body | No new effect. Response includes `Idempotency-Replayed: true`. |
| Same key, **different** body fingerprint | `409` | `{"code": "IDEMPOTENCY_KEY_REUSE", "idempotencyKey": "…", "originalResourceId": "…", "detail": "key bound to a different request body"}` | No new effect. Audited. |
| Same key, first request still in flight | `409` | `{"code": "IDEMPOTENCY_IN_FLIGHT", "retryAfterSeconds": 5}` plus `Retry-After: 5` | No second effect. The caller must wait and replay. |
| Key reused after the stored record expired, for a §5.8 route whose domain `ExternalAction` already exists | `200` | The existing `ExternalAction` DTO with `idempotencyReplayed: true` | No new effect; resolved from the domain record, not the cached response. |
| Key absent on a Required route | `400` | `IDEMPOTENCY_KEY_REQUIRED` | No state change. |
| Key malformed | `400` | `IDEMPOTENCY_KEY_MALFORMED` | No state change. |
| Key present on a route where it adds no protection | Ignored, logged | Normal response | Header echoed as `Idempotency-Key-Echo` for diagnosis only. |

### 4.4 Non-promotion rule

A replayed response is **not** evidence of a new external effect, and must never
be counted as one. Any metric, coverage report, or export that counts
`ExternalAction` rows must count distinct `(caseId, idempotencyKey)` pairs, and
must not count HTTP 2xx responses. A replayed `201` from §5.8.2 is by definition
one effect, not two.

### 4.5 Ambiguity is not idempotency

A timeout, connection reset, or non-answer from an external channel produces an
**ambiguous** `ExternalAction`, not a failure and not a success (VG-ACTION-002).
The API's response in that case is `202` with the `AMBIGUOUS_EXTERNAL_EFFECT`
reconciliation body (SPEC-006 §6.1):
`{"externalActionId":"xac_01H…","actionOutcome":"AMBIGUOUS","reconciliationRequired":true,"reconciliationId":"rdc_01H…","truthStateChanged":false,"correlationId":"…"}`,
and reconciliation is performed via §5.8.3. `truthStateChanged: false` is
mandatory on this response: the case's truth state is unchanged, and the caller is
told so explicitly rather than left to infer it. The API must never translate an
ambiguous outcome into either a retry or a `REQUEST_SUBMITTED` claim.

---

## 5. Route catalogue

### 5.0 Reading this catalogue

Each row states: **method**, **path**, **purpose**, **required scope** (plus role
or step-up where applicable), **request shape** with real field names, **success
status**, **response shape**, **error codes** (in addition to the universal set
in §8.4), **idempotency requirement**, and the **VG- requirement served**.

Universal to every route and therefore not repeated: `401` for a missing/invalid
token, `403 INSUFFICIENT_SCOPE` for a missing scope, `403 STEP_UP_REQUIRED` where
step-up applies, `404 RESOURCE_NOT_FOUND` for absent-or-other-tenant resources,
`429 RATE_LIMITED`, `500 INTERNAL_ERROR`, `503 DEPENDENCY_UNAVAILABLE`. Every
204 response has no body. Every list route supports §2.5/§2.6 unless stated.

Two codes recur in the tables below and are worth stating once:

- `422 EVIDENCE_NOT_FOUND` is the **referenced-artifact** failure: a request body
  named an `evidenceArtifactId` that does not resolve, or resolves outside the
  tenant. It is a body-validation failure (`422`), not the path-level absence
  that `404 RESOURCE_NOT_FOUND` reports.
- `422` codes are body/guard semantics; `409` codes are resource-state conflicts.
  §8.2 states the boundary.
Route group headings name the owning SPEC-001 aggregate.

**No route accepts a truth state as input.** Where a response carries
`truthState`, it is read-only output produced by a domain command.

### 5.1 Subjects, aliases, identifiers

| # | Route |
|---|---|
| 5.1.1 | `POST /v1/subjects` |
| 5.1.2 | `GET /v1/subjects` |
| 5.1.3 | `GET /v1/subjects/{subjectId}` |
| 5.1.4 | `PATCH /v1/subjects/{subjectId}` |
| 5.1.5 | `POST /v1/subjects/{subjectId}/aliases` |
| 5.1.6 | `GET /v1/subjects/{subjectId}/aliases` |
| 5.1.7 | `POST /v1/subjects/{subjectId}/identifiers` |
| 5.1.8 | `GET /v1/subjects/{subjectId}/identifiers` |
| 5.1.9 | `GET /v1/subjects/{subjectId}/location-history` |
| 5.1.10 | `POST /v1/subjects/{subjectId}/location-history` |

**5.1.1 `POST /v1/subjects`** — create a `ProtectedSubject`. Serves VG-IDENT-001,
VG-AUTHZ-001, VG-POLICY-004.
Scope `vg.subjects.write` + step-up. Idempotency **Required**.
Request:
`{"displayRef": "SUBJ-2026-00042", "jurisdiction": "US-CA", "isMinor": false, "authorityGrant": {"kind": "SELF", "scope": ["REMOVAL_REQUEST"], "evidenceArtifactId": "evd_01H…", "expiresAt": "2027-02-04T00:00:00.000Z"}}`
Success `201`:
`{"subjectId": "sub_01H…", "displayRef": "SUBJ-2026-00042", "jurisdiction": "US-CA", "isMinor": false, "authorityGrantId": "agr_01H…", "createdAt": "…", "strictLane": false}`
Errors: `422 AUTHORITY_GRANT_INVALID` (missing/expired/forged grant — §11.4 VG-API-023 requires no subject row to be created), `422 AUTHORITY_EVIDENCE_REQUIRED` (`kind: "AGENT"` without a stored signed instrument, VG-AUTHZ-002), `422 AUTHORITY_WINDOW_INVALID`, `403 IDENTITY_LEVEL_INSUFFICIENT` (below the SPEC-005 §4 level the policy requires), `403 SEPARATION_OF_DUTIES` (self-mint by the admin who would own it — §11.2 VG-API-017), `422 SCHEMA_VALIDATION_FAILED`. Accepts `Idempotency-Key`; a replay returns the original `201` body with `Idempotency-Replayed: true`.

**5.1.2 `GET /v1/subjects`** — list subjects for the token's tenant.
Scope `vg.subjects.read`. Idempotency **Optional** (read).
Query: `limit`, `cursor`, `sort` ∈ `createdAt|displayRef` (default `createdAt:desc`), `jurisdiction`, `isMinor`, `authorityState` ∈ `VALID|EXPIRED|REVOKED|NONE`.
Success `200`: `{"data":[{"subjectId":"sub_01H…","displayRef":"SUBJ-2026-00042","jurisdiction":"US-CA","isMinor":false,"authorityState":"VALID","caseCount":3,"createdAt":"…","updatedAt":"…"}],"page":{…}}`.
No alias values, no identifier values, no raw PII (§7.1). Errors: `400 INVALID_CURSOR`, `400 UNKNOWN_QUERY_PARAMETER`, `400 FILTER_TOO_BROAD`.

**5.1.3 `GET /v1/subjects/{subjectId}`** — subject detail.
Scope `vg.subjects.read`. Idempotency **Optional**.
Success `200`: the 5.1.2 row plus `aliasesCount`, `identifiersCount`, `openCaseCount`, `authorityGrants` (IDs and states only), `locationHistory` summaries.
Errors: `404 RESOURCE_NOT_FOUND`.
Returns `ETag`.

**5.1.4 `PATCH /v1/subjects/{subjectId}`** — update mutable subject fields.
Scope `vg.subjects.write`. Idempotency **Required**.
Requires `If-Match`. Request: any subset of `{"displayRef": "…", "isMinor": true, "contactPreference": {"channel": "EMAIL", "contactRefId": "cref_01H…"}}`.
`jurisdiction` is **not** patchable here: a jurisdiction change invalidates existing `PolicyDecision` rows (VG-POLICY-002) and must go through §5.1.10 plus a fresh decision, so the route refuses it with `422 FIELD_NOT_PATCHABLE`.
Setting `isMinor: true` moves the subject to the review-required lane and returns `strictLane: true` (VG-POLICY-004).
Success `200`: updated subject DTO. Errors: `412 PRECONDITION_FAILED`, `428 PRECONDITION_REQUIRED`, `422 FIELD_NOT_PATCHABLE`, `409 STRICT_LANE_CONFLICT` (a minor subject with an in-flight automated write lane), `422 SCHEMA_VALIDATION_FAILED`.

**5.1.5 `POST /v1/subjects/{subjectId}/aliases`** — attach an `Alias`.
Scope `vg.subjects.write`. Idempotency **Required**.
Request: `{"value": "…", "provenance": "AUTHORITY_INSTRUMENT", "method": "MANUAL_REVIEW", "evidenceArtifactId": "evd_01H…"}`.
Success `201`: `{"aliasId":"als_01H…","subjectId":"sub_01H…","valueMasked":"J*** D**","provenance":"…","method":"…","addedAt":"…","quarantined":false}`.
Success `202`: when the alias matches more than one subject, the alias is **quarantined, not auto-attached** (VG-IDENT-002): `{"aliasId":"als_01H…","quarantined":true,"quarantineReason":"AMBIGUOUS_MULTI_SUBJECT","candidateSubjectIds":["sub_…","sub_…"]}`.
Errors: `409 ALIAS_ALREADY_ATTACHED` (same value already attached to this subject), `422 EVIDENCE_NOT_FOUND`, `422 SCHEMA_VALIDATION_FAILED`.

**5.1.6 `GET /v1/subjects/{subjectId}/aliases`** — list aliases, masked by default.
Scope `vg.subjects.read`. Idempotency **Optional**.
Query: `quarantined` (bool), `provenance`, `includeValue` (bool, default `false`; requires `vg.pii.reveal` + step-up).
Success `200`: `{"data":[{"aliasId":"als_01H…","valueMasked":"J*** D**","provenance":"…","method":"…","addedAt":"…","quarantined":false}]}`, or `value` in place of `valueMasked` when `includeValue=true` and the scope is held. Errors: `403 INSUFFICIENT_SCOPE` for `includeValue` without `vg.pii.reveal`, `403 STEP_UP_REQUIRED`.

**5.1.7 `POST /v1/subjects/{subjectId}/identifiers`** — create an encrypted `Identifier`.
Scope `vg.subjects.write` + step-up. Idempotency **Required**.
Request: `{"kind": "EMAIL|PHONE|GOV_ID|ADDRESS|USERNAME", "value": "…", "provenance": "SUBJECT_SUPPLIED"}`.
Success `201`: `{"identifierId":"idn_01H…","kind":"EMAIL","valueMasked":"j***@e***.com","keyRef":"kms:tenant-…","createdAt":"…"}`.
The plaintext `value` is written through the encryption adapter, is **never** returned, **never** logged, and never enters an `AuditEvent` field (SPEC-001 §3 note, VG-SEC-002).
Errors: `422 IDENTIFIER_KIND_UNSUPPORTED`, `422 SCHEMA_VALIDATION_FAILED`, `409 IDENTIFIER_ALREADY_PRESENT`.

**5.1.8 `GET /v1/subjects/{subjectId}/identifiers`** — list identifiers, masked.
Scope `vg.subjects.read` (`vg.pii.reveal` + step-up for `includeValue=true`). Idempotency **Optional**.
Success `200`: `{"data":[{"identifierId":"idn_01H…","kind":"EMAIL","valueMasked":"j***@e***.com","provenance":"…","createdAt":"…"}]}`.
Errors: `403 INSUFFICIENT_SCOPE`, `403 STEP_UP_REQUIRED`.

**5.1.9 `GET /v1/subjects/{subjectId}/location-history`** — read `LocationHistory`.
Scope `vg.subjects.read`. Idempotency **Optional**. Success `200` list of `{"locationHistoryId":"…","jurisdiction":"US-CA","from":"…","to":"…","provenance":"…"}`.

**5.1.10 `POST /v1/subjects/{subjectId}/location-history`** — append a jurisdiction interval (the input to jurisdiction policy resolution).
Scope `vg.subjects.write`. Idempotency **Required**.
Request: `{"jurisdiction": "US-CA", "from": "2024-06-01T00:00:00.000Z", "to": null, "provenance": "SUBJECT_SUPPLIED", "evidenceArtifactId": "evd_01H…"}`.
Success `201`. Errors: `422 JURISDICTION_UNRESOLVED` (no policy row resolves for this jurisdiction — SPEC-001 §2 `Jurisdiction`), `422 OVERLAPPING_INTERVAL`, `422 SCHEMA_VALIDATION_FAILED`.

### 5.2 Authority grants

| # | Route |
|---|---|
| 5.2.1 | `POST /v1/subjects/{subjectId}/authority-grants` |
| 5.2.2 | `GET /v1/subjects/{subjectId}/authority-grants` |
| 5.2.3 | `POST /v1/authority-grants/{authorityGrantId}/revocations` |

**5.2.1 `POST /v1/subjects/{subjectId}/authority-grants`** — add an `AuthorityGrant`. Serves VG-AUTHZ-001, VG-AUTHZ-002, VG-IDENT-001.
Scope `vg.authority.write` + step-up. Idempotency **Required**.
Request: `{"kind":"SELF|AGENT|PARENT_GUARDIAN|LEGAL_REPRESENTATIVE","scope":["EXTERNAL_ACTION","SEARCH_DELISTING","MAIL_CORRESPONDENCE"],"identityLevel":"IAL2","evidenceArtifactId":"evd_01H…","issuedAt":"2026-02-04T00:00:00.000Z","expiresAt":"2027-02-04T00:00:00.000Z"}`
`kind` values and their required evidence are **SPEC-005 §3's table verbatim**: `SELF` (completed identity verification at the required level), `AGENT` (signed authorization instrument + agent identity verification + recorded scope), `PARENT_GUARDIAN` (evidence of relationship + minor status determination), `LEGAL_REPRESENTATIVE` (court instrument, counsel-reviewed before activation). `identityLevel` is a SPEC-005 §4 token (`IAL0`–`IAL3`).
Success `201`: `{"authorityGrantId":"agr_01H…","subjectId":"sub_01H…","kind":"AGENT","scope":["EXTERNAL_ACTION"],"identityLevel":"IAL2","evidenceArtifactId":"evd_01H…","evidenceDigest":"9f2c…","issuedAt":"…","expiresAt":"…","revokedAt":null,"validNow":true,"noticeSentAt":"…"}`
`noticeSentAt` is required non-null for `AGENT` grants: SPEC-005 `VG-AUTHZ-014` requires notice to the subject's verified contact channel on agent enrollment, so a grant with no recorded notice fails acceptance (SPEC-005 `VG-AUTH-032`).
Errors: `422 AUTHORITY_EVIDENCE_REQUIRED` (`AGENT`, `PARENT_GUARDIAN`, or `LEGAL_REPRESENTATIVE` without the SPEC-005 §3 evidence — VG-AUTHZ-002), `422 AUTHORITY_SCOPE_UNKNOWN`, `422 AUTHORITY_WINDOW_INVALID` (`expiresAt` ≤ `issuedAt` or already past), `422 AUTHORITY_KIND_UNSUPPORTED`, `403 IDENTITY_LEVEL_INSUFFICIENT`, `422 EVIDENCE_NOT_FOUND`, `403 STEP_UP_REQUIRED`, `403 SEPARATION_OF_DUTIES` (SPEC-005 `VG-AUTHZ-016`), `422 SCHEMA_VALIDATION_FAILED`.
Note: `scope` values are an application-controlled enum; the API assigns no legal meaning to them. Whether a given `scope` is sufficient for a given channel in a given jurisdiction is a `PolicyDecision` question (SPEC-000 §8, VG-POLICY-001) and, for unresolved jurisdictions, a **counsel-review** question recorded in `LEGAL_REVIEW_REQUIRED.md`. Whether a given `kind` and evidence set is legally sufficient for authorized-agent action is likewise **counsel-review** territory (SPEC-005 §11), not an API determination.

**5.2.2 `GET /v1/subjects/{subjectId}/authority-grants`** — list grants with validity state.
Scope `vg.authority.read`. Idempotency **Optional**.
Query: `state` ∈ `VALID|EXPIRED|REVOKED` (default: all), `kind`.
Success `200`: `{"data":[{"authorityGrantId":"agr_01H…","kind":"AGENT","scope":[…],"evidenceArtifactId":"evd_01H…","issuedAt":"…","expiresAt":"…","revokedAt":null,"state":"VALID","daysUntilExpiry":364}]},"page":{…}}`.
`state` here is an authorization-validity classification, **not** a truth state; it never substitutes for `truthState` on an exposure or case.

**5.2.3 `POST /v1/authority-grants/{authorityGrantId}/revocations`** — revoke a grant.
Scope `vg.authority.write` + step-up. Idempotency **Required**.
Request: `{"reason":"SUBJECT_WITHDREW","evidenceArtifactId":"evd_01H…","note":"…"}`
Success `201`: `{"authorityGrantId":"agr_01H…","revokedAt":"…","reason":"SUBJECT_WITHDREW"}`.
Revocation takes effect for **in-flight** work at the next execution-time assertion (SPEC-001 §4.2 last rows, VG-AUTHZ-001): a `RequestCase` whose grant is revoked cannot execute an `ExternalAction` and moves to `HUMAN_REQUIRED` via T9/T12 or to `NOT_REMOVABLE` via T10 with recorded basis. Revocation never rewrites history: existing `ExternalAction` rows and their evidence are retained (VG-REAPPEAR-002).
Errors: `409 AUTHORITY_ALREADY_REVOKED`, `404 RESOURCE_NOT_FOUND`, `422 SCHEMA_VALIDATION_FAILED`.

### 5.3 Sources, catalogue, recipes

| # | Route |
|---|---|
| 5.3.1 | `GET /v1/sources` |
| 5.3.2 | `POST /v1/sources` |
| 5.3.3 | `GET /v1/sources/{sourceId}` |
| 5.3.4 | `PATCH /v1/sources/{sourceId}/permission-class` |
| 5.3.5 | `GET /v1/sources/{sourceId}/catalog-entries` |
| 5.3.6 | `POST /v1/sources/{sourceId}/catalog-entries` |
| 5.3.7 | `POST /v1/sources/{sourceId}/recipes` |
| 5.3.8 | `GET /v1/sources/{sourceId}/recipes` |
| 5.3.9 | `GET /v1/recipes/{recipeId}` |
| 5.3.10 | `POST /v1/recipes/{recipeId}/enablement` |

**5.3.1 `GET /v1/sources`** — read the declared `Source` catalogue.
Scope `vg.sources.read`. Idempotency **Optional**.
Query: `class`, `jurisdiction`, `permissionClass` ∈ `READ_ONLY|WRITE_PERMITTED|WRITE_UNCLEAR|PROHIBITED`, `sort` ∈ `name|freshnessAt` (default `name:asc`).
Success `200`: `{"data":[{"sourceId":"src_01H…","name":"…","class":"PEOPLE_SEARCH","jurisdiction":"US","permissionClass":"WRITE_UNCLEAR","freshnessAt":"…","freshnessState":"STALE","writesEnabled":false,"controllerId":"ctl_01H…"}],"page":{…}}`.
`writesEnabled` is derived: `false` unless `permissionClass = WRITE_PERMITTED` **and** freshness is current **and** at least one recipe is signed, fresh, and enabled (VG-CHANNEL-002, VG-CHANNEL-003). `WRITE_UNCLEAR` ⇒ `writesEnabled: false`, always, with no override (ADR-003).

**5.3.2 `POST /v1/sources`** — declare a `Source`.
Scope `vg.sources.write`. Idempotency **Required**.
Request: `{"name":"…","class":"…","jurisdiction":"US","controllerId":"ctl_01H…","permissionClass":"READ_ONLY","permissionEvidenceUrl":"https://…","permissionCheckedAt":"…"}`
Success `201`. Errors: `409 SOURCE_ALREADY_DECLARED`, `422 PERMISSION_EVIDENCE_REQUIRED` (a `WRITE_PERMITTED` declaration without current official-permission evidence), `422 CONTROLLER_NOT_FOUND`, `422 SCHEMA_VALIDATION_FAILED`.
A `WRITE_PERMITTED` declaration is a **data** assertion about an official permission record; the API does not adjudicate its legal sufficiency. Whether a given source's terms permit automation is a counsel-review question (TOS_AUTOMATION_MATRIX, `LEGAL_REVIEW_REQUIRED.md`).

**5.3.3 `GET /v1/sources/{sourceId}`** — source detail incl. permission and recipe readiness.
Scope `vg.sources.read`. Idempotency **Optional**. Success `200`, returns `ETag`.
Errors: `404 RESOURCE_NOT_FOUND`.

**5.3.4 `PATCH /v1/sources/{sourceId}/permission-class`** — record a permission/TOS class change or freshness refresh.
Scope `vg.sources.write`. Idempotency **Required**. Requires `If-Match`.
Request: `{"permissionClass":"WRITE_UNCLEAR","permissionEvidenceUrl":"…","permissionCheckedAt":"…","reason":"TERMS_REVISED"}`
Success `200`: source DTO plus `{"autoDisabledRecipeIds":["rcp_…","rcp_…"]}` — downgrading or un-refreshing permission **auto-disables** affected recipes (VG-CHANNEL-002), and disabling is never silent.
Errors: `412 PRECONDITION_FAILED`, `422 PERMISSION_EVIDENCE_REQUIRED`, `422 SCHEMA_VALIDATION_FAILED`.
Lowering a class is always allowed. Raising it to `WRITE_PERMITTED` requires evidence and is audited; it never re-enables a recipe by itself.

**5.3.5 `GET /v1/sources/{sourceId}/catalog-entries`** — read `SourceCatalogEntry` rows, including coverage notes.
Scope `vg.sources.read`. Idempotency **Optional**.
Success `200`: `{"data":[{"catalogEntryId":"sce_01H…","sourceId":"src_01H…","category":"…","coverageNotes":"…","provenance":"…","license":"…","declaredAt":"…"}]}`.
`coverageNotes` is required and non-empty: a catalogue entry that cannot state what it does and does not cover is `422 CATALOG_NOTES_REQUIRED` on write (VG-DISC-002).

**5.3.6 `POST /v1/sources/{sourceId}/catalog-entries`** — add a `SourceCatalogEntry`.
Scope `vg.sources.write`. Idempotency **Required**.
Request: `{"category":"…","coverageNotes":"…","provenance":"…","license":"…"}`
Success `201`. Errors: `422 CATALOG_NOTES_REQUIRED`, `409 CATALOG_ENTRY_DUPLICATE`, `422 LICENSE_UNRECORDED` (LICENSE_POLICY), `422 SCHEMA_VALIDATION_FAILED`.

**5.3.7 `POST /v1/sources/{sourceId}/recipes`** — create a new `RemovalRecipe` version.
Scope `vg.recipes.write`. Idempotency **Required**.
Request: `{"channel":"OFFICIAL_SELF_SERVICE","verificationMethod":"INDEPENDENT_FETCH_DIFFERENT_EGRESS","signature":"base64url…","signingKeyRef":"kms:recipe-…","freshnessAt":"2026-02-04T00:00:00.000Z","maxAttemptsPerWindow":1,"windowSeconds":86400}`
Success `201`: `{"recipeId":"rcp_01H…","sourceId":"src_01H…","version":4,"channel":"OFFICIAL_SELF_SERVICE","verificationMethod":"…","signatureVerified":true,"enabled":false,"freshnessAt":"…","createdAt":"…"}`
A new recipe version is created **disabled**; enabling is a separate guarded call (5.3.10). The API verifies the signature before accepting the row (VG-CHANNEL-003) and refuses to store a recipe it cannot verify.
Errors: `422 RECIPE_SIGNATURE_INVALID`, `422 RECIPE_VERIFICATION_METHOD_REQUIRED`, `422 RECIPE_CHANNEL_UNKNOWN`, `409 RECIPE_VERSION_CONFLICT`, `422 SCHEMA_VALIDATION_FAILED`.

**5.3.8 `GET /v1/sources/{sourceId}/recipes`** — list recipe versions.
Scope `vg.sources.read`. Idempotency **Optional**.
Query: `enabled` (bool), `fresh` (bool), `sort` ∈ `version|freshnessAt` (default `version:desc`).
Success `200`: `{"data":[{"recipeId":"rcp_01H…","version":4,"channel":"…","verificationMethod":"…","signatureVerified":true,"enabled":false,"freshnessAt":"…","staleness":"STALE","disabledReason":"PERMISSION_UNCLEAR"}]}`.
Recipes are never deleted; superseded versions remain readable so historical actions remain explainable (VG-REAPPEAR-002).

**5.3.9 `GET /v1/recipes/{recipeId}`** — recipe detail.
Scope `vg.sources.read`. Idempotency **Optional**. Success `200`, returns `ETag`. Errors: `404 RESOURCE_NOT_FOUND`.

**5.3.10 `POST /v1/recipes/{recipeId}/enablement`** — enable or disable a recipe version.
Scope `vg.recipes.write`. Idempotency **Required**. Requires `If-Match`.
Request: `{"enabled": true, "reason": "PERMISSION_REFRESHED"}`
Success `200`: `{"recipeId":"rcp_01H…","enabled":true,"enabledAt":"…","guardEvaluation":{"signatureVerified":true,"fresh":true,"permissionClass":"WRITE_PERMITTED","permissionFresh":true}}`.
Enablement is refused unless **every** guard in `guardEvaluation` passes; a `false` anywhere is `409 RECIPE_GUARD_FAILED` with the failing guard named, and `enabled` stays `false` (VG-CHANNEL-002, VG-CHANNEL-003).
Errors: `409 RECIPE_GUARD_FAILED`, `412 PRECONDITION_FAILED`, `428 PRECONDITION_REQUIRED`, `422 SCHEMA_VALIDATION_FAILED`.

### 5.4 Discovery runs and source records

| # | Route |
|---|---|
| 5.4.1 | `POST /v1/discovery-runs` |
| 5.4.2 | `GET /v1/discovery-runs` |
| 5.4.3 | `GET /v1/discovery-runs/{discoveryRunId}` |
| 5.4.4 | `GET /v1/subjects/{subjectId}/candidate-records` |
| 5.4.5 | `GET /v1/source-records/{sourceRecordId}` |

**5.4.1 `POST /v1/discovery-runs`** — start a read-only discovery run over a declared surface.
Scope `vg.discovery.run`. Idempotency **Required**.
Request: `{"subjectId":"sub_01H…","sourceIds":["src_01H…","src_01H…"],"catalogEntryIds":["sce_01H…"],"mode":"READ_ONLY","rateLimitPerSourcePerMinute":6,"requestedAt":"2026-02-04T09:00:00.000Z"}`
`mode` accepts `READ_ONLY` only. Any other value is `422 DISCOVERY_MODE_FORBIDDEN` — discovery actors hold no write capability (VG-DISC-001).
Success `202`: `{"discoveryRunId":"drn_01H…","requestedAt":"…","declaredSurface":{"sourceIds":[…],"sourcesTotal":12},"budget":{"maxRecordsPerSource":500},"runState":"ACCEPTED"}`.
Errors: `422 SOURCE_NOT_PERMITTED_FOR_READ` (`PROHIBITED` class), `422 RATE_LIMIT_POLICY_MISSING`, `409 DISCOVERY_RUN_IN_FLIGHT` (same subject × source pair), `422 SUBJECT_AUTHORITY_INVALID`, `422 SCHEMA_VALIDATION_FAILED`.
A run that reaches a `HumanGate` produces a `HUMAN_REQUIRED` outcome record for that source and stops there. The API exposes no route that accepts a gate-solver result, token, or cookie, and no route accepts one as a field value (§10).

**5.4.2 `GET /v1/discovery-runs`** — list runs.
Scope `vg.discovery.read`. Idempotency **Optional**.
Query: `subjectId`, `sourceId`, `runState`, `from`, `to`, `sort` ∈ `requestedAt|completedAt` (default `requestedAt:desc`).
Success `200` list of run summaries including `coverageSummary` counts.

**5.4.3 `GET /v1/discovery-runs/{discoveryRunId}`** — run detail with its coverage report.
Scope `vg.discovery.read`. Idempotency **Optional**.
Success `200`:
`{"discoveryRunId":"drn_01H…","runState":"COMPLETED_PARTIAL","requestedAt":"…","completedAt":"…","coverage":{"sourcesDeclared":12,"sourcesAttempted":9,"sourcesSucceeded":8,"sourcesSkipped":[{"sourceId":"src_…","reason":"RATE_LIMITED"},{"sourceId":"src_…","reason":"HUMAN_REQUIRED"},{"sourceId":"src_…","reason":"SOURCE_ERROR"}],"coverageBounds":{"complete":false,"checkedFraction":0.75}},"sourceRecordIds":[…]}`
`runState` values are `ACCEPTED`, `RUNNING`, `COMPLETED`, `COMPLETED_PARTIAL`, `FAILED`, `HUMAN_REQUIRED`. These are run-lifecycle states, **not** truth states, and the response never reports one in a `truthState` field.
Errors: `404 RESOURCE_NOT_FOUND`.

**5.4.4 `GET /v1/subjects/{subjectId}/candidate-records`** — `SourceRecord` rows observed for this subject's runs, before or during assessment.
Scope `vg.exposures.read`. Idempotency **Optional**.
Query: `sourceId`, `assessmentState` ∈ `UNASSESSED|MATCH_CONFIRMED|MATCH_DISPROVED|QUARANTINED`, `from`, `to`, `sort` ∈ `observedAt|contentHash` (default `observedAt:desc`).
Success `200`:
`{"data":[{"sourceRecordId":"srd_01H…","sourceId":"src_01H…","observedAt":"…","contentHash":"…","taint":"UNTAINTED|TAINTED","rawRefMasked":"https://…/p/***","assessmentState":"UNASSESSED","exposureId":null}],"page":{…},"coverage":{"applies":true,"sourcesAttempted":9,"sourcesTotal":12,"complete":false}}`
This route returns **candidate records**, never exposures, and never a matched-subject assertion. `SEARCH_HIT` is never treated as `SUBJECT_MATCH` (VG-IDENT-004): a record from a search-engine class source can appear here only with `assessmentState: "UNASSESSED"` and cannot carry an `exposureId`.
Coverage bounds are mandatory in `coverage` whenever the listing is a discovery-derived result set: a partial run cannot present as "no exposure found" unqualified (VG-DISC-002, SPEC-000 §7.1/§7.4).

**5.4.5 `GET /v1/source-records/{sourceRecordId}`** — one record's metadata and taint provenance.
Scope `vg.discovery.read`. Idempotency **Optional**.
Success `200`: `{"sourceRecordId":"srd_01H…","sourceId":"…","observedAt":"…","contentHash":"…","taint":"TAINTED","taintReason":"UNTRUSTED_REMOTE_CONTENT","rawRef":"https://…","discoveryRunId":"drn_01H…","assessmentState":"UNASSESSED"}`.
`taint` is reported, never hidden: tainted remote content cannot direct actions (VG-SEC-001) and the API surfaces the taint so a portal cannot present tainted content as trusted.
Errors: `404 RESOURCE_NOT_FOUND`.

### 5.5 Exposures and match assessment

| # | Route |
|---|---|
| 5.5.1 | `GET /v1/exposures` |
| 5.5.2 | `GET /v1/exposures/{exposureId}` |
| 5.5.3 | `POST /v1/exposures/{exposureId}/match-assessments` |
| 5.5.4 | `POST /v1/exposures/{exposureId}/disproofs` |
| 5.5.5 | `GET /v1/exposures/{exposureId}/transitions` |

**5.5.1 `GET /v1/exposures`** — list exposures.
Scope `vg.exposures.read`. Idempotency **Optional**.
Query: `subjectId`, `sourceId`, `truthState` (SPEC-000 §5 tokens only), `minConfidence`, `from`, `to`, `sort` ∈ `observedAt|confidence|truthState` (default `observedAt:desc`).
Success `200`:
`{"data":[{"exposureId":"exp_01H…","subjectRef":"sub_01H…","sourceId":"src_01H…","sourceRecordId":"srd_01H…","truthState":"MATCH_CONFIRMED","confidence":{"value":0.91,"basis":[{"feature":"NAME_EXACT","weight":0.4},{"feature":"ADDRESS_MATCH","weight":0.31},{"feature":"AGE_BAND_MATCH","weight":0.2}]},"caseRef":"cas_01H…","firstObservedAt":"…","lastObservedAt":"…"}],"page":{…}}`
`confidence` is always the object, never a bare number: a score without `basis` is unrepresentable (SPEC-001 §2, VG-IDENT-003).
Errors: `400 INVALID_TRUTH_STATE`, `400 INVALID_CURSOR`, `400 FILTER_TOO_BROAD`.

**5.5.2 `GET /v1/exposures/{exposureId}`** — exposure detail.
Scope `vg.exposures.read`. Idempotency **Optional**.
Success `200`: the 5.5.1 row plus `policyDecision` summary, `recipeReadiness`, `deadlines`, `reappearanceOf` (prior removed event ID or `null`), the `externalActions` summary, and `truthState` with `truthStateChangedAt`.
Errors: `404 RESOURCE_NOT_FOUND`. Returns `ETag`.
`truthState` is returned as the exact SPEC-000 §5 token, never renamed, localized, or collapsed (§7.3).

**5.5.3 `POST /v1/exposures/{exposureId}/match-assessments`** — submit a scored assessment; drives T3 (`MATCH_CONFIRMED`) or, on an inconclusive score, leaves the exposure at `DISCOVERED_CANDIDATE` with the assessment recorded.
Scope `vg.exposures.assess`. Idempotency **Required**. Requires `If-Match`.
Request: `{"confidence":{"value":0.91,"basis":[{"feature":"NAME_EXACT","weight":0.4},{"feature":"ADDRESS_MATCH","weight":0.31},{"feature":"AGE_BAND_MATCH","weight":0.2}]},"method":"FEATURE_SET_V1","evidenceArtifactId":"evd_01H…","humanReviewed":false}`
Success `200`: `{"exposureId":"exp_01H…","truthState":"MATCH_CONFIRMED","confidence":{…},"transitionId":"TR-01H…","policyThresholdApplied":0.85}`
Success `200` (below threshold): `{"exposureId":"exp_01H…","truthState":"DISCOVERED_CANDIDATE","confidence":{…},"assessmentRecorded":true,"belowThreshold":true}` — no transition occurred and the response says so plainly.
Errors: `422 CONFIDENCE_BASIS_REQUIRED` (a score with no basis fails validation, VG-IDENT-003), `422 CONFIDENCE_OUT_OF_RANGE`, `409 ILLEGAL_TRANSITION` (exposure not in `DISCOVERED_CANDIDATE`), `422 EVIDENCE_NOT_FOUND`, `409 IDENTITY_CLASS_MISMATCH` (a search-engine-class source record cannot enter a removal path, VG-IDENT-004), `412 PRECONDITION_FAILED`, `428 PRECONDITION_REQUIRED`, `422 SCHEMA_VALIDATION_FAILED`.

**5.5.4 `POST /v1/exposures/{exposureId}/disproofs`** — record an assessment that disproved the subject match; drives T4 to `VERIFIED_NOT_PRESENT`.
Scope `vg.exposures.assess`. Idempotency **Required**. Requires `If-Match`.
Request: `{"disproofBasis":"DIFFERENT_MIDDLE_NAME|DIFFERENT_ADDRESS_REGION|DIFFERENT_AGE_BAND|SUBJECT_CONFIRMED_UNRELATED","evidenceArtifactId":"evd_01H…","scanComplete":true,"coverageBounds":{"sourcesAttempted":9,"sourcesTotal":12}}`
Success `200`: `{"exposureId":"exp_01H…","truthState":"VERIFIED_NOT_PRESENT","coverageBounds":{…},"transitionId":"TR-01H…"}`
If `scanComplete` is `false` or coverage is partial, the request is refused with `422 COVERAGE_BOUNDS_REQUIRED`: absence may not be reported from an incomplete scan (VG-DISC-002, SPEC-000 §5.1).
Errors: `422 COVERAGE_BOUNDS_REQUIRED`, `409 ILLEGAL_TRANSITION`, `412 PRECONDITION_FAILED`, `422 SCHEMA_VALIDATION_FAILED`. Nothing was removed, so this route can never produce or imply a removal outcome (SPEC-001 §4.2).

**5.5.5 `GET /v1/exposures/{exposureId}/transitions`** — the append-only transition history for this exposure.
Scope `vg.exposures.read`. Idempotency **Optional**.
Success `200`: `{"data":[{"transitionId":"TR-01H…","transitionCode":"T3","fromTruthState":"DISCOVERED_CANDIDATE","toTruthState":"MATCH_CONFIRMED","occurredAt":"…","actorIdentity":"…","command":"AssessMatch","evidenceArtifactIds":["evd_01H…"],"correlationId":"…"}]}`
`transitionCode` refers to the SPEC-001 §4.1 table row, so a reader can check legality without inference.

### 5.6 Policy decisions

| # | Route |
|---|---|
| 5.6.1 | `POST /v1/cases/{caseId}/policy-decisions` |
| 5.6.2 | `GET /v1/cases/{caseId}/policy-decisions` |
| 5.6.3 | `GET /v1/policy-decisions/{policyDecisionId}` |
| 5.6.4 | `GET /v1/jurisdiction-policies` |

**5.6.1 `POST /v1/cases/{caseId}/policy-decisions`** — request a `PolicyDecision` resolution.
Scope `vg.policy.write`. Idempotency **Required**. Requires `If-Match`.
Request: `{"jurisdiction":"US-CA","requestedChannel":"OFFICIAL_SELF_SERVICE","policyVersion":"2026-01-15","channelAlternativesConsidered":[{"channel":"PRIVACY_EMAIL","unavailable":true,"reason":"NO_PUBLISHED_CONTACT"},{"channel":"CENTRALIZED_GOVERNMENT","unavailable":true,"reason":"SUBJECT_NOT_ELIGIBLE"}]}`
Success `201`:
`{"policyDecisionId":"pdc_01H…","caseId":"cas_01H…","jurisdiction":"US-CA","legalBasis":"CCPA_CPRA_DELETE","channel":"OFFICIAL_SELF_SERVICE","policyVersion":"2026-01-15","reasons":[{"code":"CHANNEL_PRIORITY_1_AVAILABLE","detail":"…"}],"exemptionEvaluation":{"evaluated":true,"exempt":false,"checks":[{"check":"PUBLIC_RECORD","result":"NOT_EXEMPT"},{"check":"FCRA","result":"NOT_EXEMPT"}]},"decidedAt":"…"}`
**Every one of `jurisdiction`, `legalBasis`, `channel`, `policyVersion` is present in the response, always** (VG-POLICY-002). A request that cannot be resolved to a complete decision is refused, never partially recorded.
Refusals, each leaving the case at `MATCH_CONFIRMED`:
- `422 LEGAL_BASIS_NOT_IN_POLICY_VERSION` — the requested or model-suggested basis has no matching policy row (VG-POLICY-001). The API additionally rejects any request body containing a `legalBasis` field the caller asserts rather than references: `422 LEGAL_BASIS_NOT_AUTHORABLE` (VG-POLICY-001).
- `422 CHANNEL_PRIORITY_VIOLATION` — a lower-priority channel requested while a lawful higher-priority channel (§8) is available and not recorded as unavailable with a reason (VG-CHANNEL-001).
- `409 POLICY_VERSION_SUPERSEDED` — the named `policyVersion` is no longer in force; the caller must re-request against the version in force.
- `422 JURISDICTION_UNRESOLVED`, `409 CASE_AUTHORITY_INVALID`, `412 PRECONDITION_FAILED`, `422 SCHEMA_VALIDATION_FAILED`.
- For a minor subject, resolution for any automated write channel is refused with `422 STRICT_LANE_REQUIRED` (VG-POLICY-004).
- Where the resolved basis requires a legal determination this system does not own, the decision is `NOT_REMOVABLE` with the basis recorded rather than asserted; the API never states a legal conclusion of its own (§11).

**5.6.2 `GET /v1/cases/{caseId}/policy-decisions`** — list decisions for a case, newest first, all versions retained.
Scope `vg.policy.read`. Idempotency **Optional**. Success `200` list. Errors: `404 RESOURCE_NOT_FOUND`.

**5.6.3 `GET /v1/policy-decisions/{policyDecisionId}`** — one decision with its full reason list.
Scope `vg.policy.read`. Idempotency **Optional**. Success `200`. Errors: `404 RESOURCE_NOT_FOUND`.

**5.6.4 `GET /v1/jurisdiction-policies`** — read jurisdiction policy versions (versioned data, not prompts).
Scope `vg.policy.read`. Idempotency **Optional**.
Query: `jurisdiction`, `inForceOn` (RFC 3339 date), `includeSuperseded` (bool, default `false`).
Success `200`: `{"data":[{"policyVersion":"2026-01-15","jurisdiction":"US-CA","effectiveFrom":"2026-01-15T00:00:00.000Z","effectiveTo":null,"inForce":true,"ruleCount":14,"policyChecksum":"…"}],"page":{…}}`
This route is **read-only with no write counterpart on `/v1`.** Policy data is authored through an out-of-band, human-reviewed change process with its own review and evidence; there is no route by which an API caller or a model can author a jurisdiction rule or a legal basis (VG-POLICY-001, §10).

### 5.7 Cases

| # | Route |
|---|---|
| 5.7.1 | `POST /v1/cases` |
| 5.7.2 | `GET /v1/cases` |
| 5.7.3 | `GET /v1/cases/{caseId}` |
| 5.7.4 | `PATCH /v1/cases/{caseId}` |
| 5.7.5 | `POST /v1/cases/{caseId}/human-gates` |
| 5.7.6 | `GET /v1/cases/{caseId}/timeline` |

**5.7.1 `POST /v1/cases`** — create the durable `RequestCase` for one subject × source × exposure.
Scope `vg.cases.write`. Idempotency **Required**.
Request: `{"subjectId":"sub_01H…","exposureId":"exp_01H…","sourceId":"src_01H…","authorityGrantId":"agr_01H…","policyDecisionId":"pdc_01H…","recipeId":"rcp_01H…"}`
Success `201`: `{"caseId":"cas_01H…","subjectId":"…","exposureId":"…","sourceId":"…","truthState":"MATCH_CONFIRMED","authorityGrantId":"…","policyDecisionId":"…","recipeId":"…","createdAt":"…","deadlines":[]}`
A case is created at the exposure's current truth state; creation never advances it. `truthState: "REQUEST_READY"` is reachable only through 5.7.4 (T5).
Errors: `409 CASE_ALREADY_EXISTS` (same subject × source × exposure with a live case), `409 CASE_EXPOSURE_STATE_MISMATCH`, `422 AUTHORITY_GRANT_SCOPE_INSUFFICIENT`, `422 POLICY_DECISION_INCOMPLETE` (missing any of VG-POLICY-002's four fields), `422 RECIPE_NOT_ENABLED`, `422 SCHEMA_VALIDATION_FAILED`.

**5.7.2 `GET /v1/cases`** — list cases.
Scope `vg.cases.read`. Idempotency **Optional**.
Query: `subjectId`, `sourceId`, `truthState`, `channel`, `authorityGrantState`, `from`, `to`, `sort` ∈ `createdAt|updatedAt|truthState` (default `updatedAt:desc`).
Success `200`:
`{"data":[{"caseId":"cas_01H…","subjectRef":"sub_01H…","sourceId":"src_01H…","exposureId":"exp_01H…","truthState":"REQUEST_SUBMITTED","channel":"OFFICIAL_SELF_SERVICE","actionCount":1,"verificationCount":0,"nextDeadline":{"deadlineId":"ddl_01H…","kind":"CONTROLLER_RESPONSE","dueAt":"…","state":"OPEN"},"updatedAt":"…"}],"page":{…}}`
`actionCount` is a count of `ExternalAction` rows, and the field is named for what it counts. No field here counts "removals". `truthState` is returned verbatim.

**5.7.3 `GET /v1/cases/{caseId}`** — case detail.
Scope `vg.cases.read`. Idempotency **Optional**.
Success `200`: the 5.7.2 row plus `truthStateChangedAt`, `lastTransition` (with `transitionCode`), `evidenceArtifactIds`, `controllerResponses` summary, `verificationObservations` summary, and the `externalActions` summary. Returns `ETag`.
Errors: `404 RESOURCE_NOT_FOUND`.

**5.7.4 `PATCH /v1/cases/{caseId}`** — guarded case update. This route carries the non-effect transitions and must not be confused with §5.8 execution.
Scope `vg.cases.write`. Idempotency **Required**. Requires `If-Match`.
Request: `{"requestedTruthState":"REQUEST_READY|NOT_REMOVABLE|HUMAN_REQUIRED","reason":{"code":"…","detail":"…"},"evidenceArtifactIds":["evd_01H…"]}`
`requestedTruthState` is a *request for a guarded transition*, not a state assignment. It is accepted only for the transitions the case's current state legally permits (T5/T6/T7/T9/T10/T13/T15/T16/T19 as applicable), and each is evaluated with its SPEC-001 §4.1 guard list inside the transaction.
Success `200`: `{"caseId":"cas_01H…","truthState":"REQUEST_READY","transitionCode":"T5","guardsEvaluated":{"authorityValid":true,"policyDecisionComplete":true,"recipeSigned":true,"recipeFresh":true,"channelPermitted":true,"budgetAvailable":true},"transitionId":"TR-01H…"}`
Errors: `409 ILLEGAL_TRANSITION` (any transition outside SPEC-001 §4.1 — the response names `fromTruthState` and the refused `toTruthState` and leaves state unchanged), `422 GUARD_FAILED` with the failing guard named, `422 TRANSITION_NOT_ROUTEABLE` (e.g. a request naming `REQUEST_SUBMITTED`, `VERIFIED_REMOVED`, `ACKNOWLEDGED`, `SEARCH_DELISTED`, `REAPPEARED`, or `DISCOVERED_CANDIDATE` as the target, each of which is reachable only through its own effect or observation route), `422 EVIDENCE_REQUIRED`, `412 PRECONDITION_FAILED`, `428 PRECONDITION_REQUIRED`, `422 SCHEMA_VALIDATION_FAILED`.
`REQUEST_SUBMITTED` is **not** requestable here: it is produced only by §5.8.2 execution (T8).

**5.7.5 `POST /v1/cases/{caseId}/human-gates`** — record a `HumanGate` and drive a `HUMAN_REQUIRED` transition (T7/T9/T12/T16).
Scope `vg.cases.write`. Idempotency **Required**. Requires `If-Match`.
Request: `{"gateKind":"CAPTCHA|OTP|IDENTITY_DOCUMENT_UPLOAD|PHONE_VERIFICATION|LEGAL_REVIEW|PROVIDER_MANUAL_STEP|AUTHORITY_DEFECT","detectedAt":"…","evidenceArtifactId":"evd_01H…","attemptedBypass":false}`
Success `200`: `{"caseId":"cas_01H…","truthState":"HUMAN_REQUIRED","transitionCode":"T9","gateId":"hgt_01H…","humanQueue":"…","serviceLevelDueAt":"…"}`
`HUMAN_REQUIRED` is a first-class result, not a failure: it is returned with `200` and must not decrement any success metric (SPEC-001 §4.3 SM-5, VG-OBS-002).
Errors: `422 BYPASS_ATTEMPT_REFUSED` (any truthy bypass attempt, or any body containing a bypass artefact — see §10; the request is refused and audited, no solver is invoked, VG-DISC-004), `409 ILLEGAL_TRANSITION`, `412 PRECONDITION_FAILED`, `422 SCHEMA_VALIDATION_FAILED`.

**5.7.6 `GET /v1/cases/{caseId}/timeline`** — merged, chronological, append-only view of the case.
Scope `vg.cases.read`. Idempotency **Optional**.
Success `200`: `{"data":[{"at":"…","kind":"EXTERNAL_ACTION|CONTROLLER_RESPONSE|VERIFICATION_OBSERVATION|TRANSITION|EVIDENCE_ARTIFACT|DEADLINE|REAPPEARANCE|HUMAN_GATE","refId":"…","truthStateAfter":"…","summary":"…","correlationId":"…"}]}`
The timeline is derived from append-only rows; it has no update or delete counterpart on any route (VG-EVIDENCE-003).

### 5.8 External actions

| # | Route |
|---|---|
| 5.8.1 | `GET /v1/cases/{caseId}/external-actions` |
| 5.8.2 | `POST /v1/cases/{caseId}/external-actions` |
| 5.8.3 | `POST /v1/external-actions/{externalActionId}/reconciliations` |
| 5.8.4 | `POST /v1/external-actions/{externalActionId}/readback` |
| 5.8.5 | `GET /v1/external-actions/{externalActionId}` |
| 5.8.6 | `GET /v1/cases/{caseId}/mail-pieces` |

**5.8.1 `GET /v1/cases/{caseId}/external-actions`** — list actions for a case.
Scope `vg.actions.read`. Idempotency **Optional**.
Success `200`: `{"data":[{"externalActionId":"xac_01H…","caseId":"cas_01H…","channel":"CERTIFIED_MAIL","recipeId":"rcp_01H…","recipeVersion":4,"attempt":1,"actionOutcome":"SUBMITTED|AMBIGUOUS|REFUSED|FAILED","idempotencyKeyFingerprint":"…","submittedAt":"…","readbackState":"PENDING|CONFIRMED|CONTRADICTED","mailPieceId":"mlp_01H…"}],"page":{…}}`
`idempotencyKeyFingerprint` is a one-way digest, not the key itself, so a list response cannot be used to replay or forge a key.

**5.8.2 `POST /v1/cases/{caseId}/external-actions`** — execute one `ExternalAction`; drives T8 to `REQUEST_SUBMITTED` on a confirmed acceptance.
Scope `vg.actions.execute` + step-up. Idempotency **Required-if-effect** — and in practice **Required**: this is the route that writes to the outside world, so it is the VG-ACTION-001 route.
Request:
`{"channel":"OFFICIAL_SELF_SERVICE","recipeId":"rcp_01H…","recipeVersion":4,"authorityGrantId":"agr_01H…","policyDecisionId":"pdc_01H…","idempotencyKey":"eff-2026-02-04-sub-42-src-118","templateRef":{"templateVersion":"v7","templateHash":"a91f…"},"payloadFields":{"subjectDisplayRef":"SUBJ-2026-00042"},"dryRun":false}`
`payloadFields` is an allowlist-validated map of non-PII reference fields, validated against the DPA/field allowlist before egress (DATA_EGRESS_MATRIX, VG-EGRESS-001). Raw PII is passed through encrypted `Identifier` references resolved inside the channel adapter, never through this request body.
Success `201` (channel accepted — HTTP 2xx, mail accepted, email queued): `{"externalActionId":"xac_01H…","caseId":"cas_01H…","truthState":"REQUEST_SUBMITTED","transitionCode":"T8","channel":"OFFICIAL_SELF_SERVICE","recipeVersion":4,"submittedAt":"…","readbackRequired":true,"idempotencyReplayed":false}`
Success `202` (ambiguous): `{"externalActionId":"xac_01H…","actionOutcome":"AMBIGUOUS","reconciliationRequired":true,"reconciliationDeadline":"…"}` — no truth-state transition occurred and the response says which state the case remains in.
Success `200` with `{"dryRun":true,…}` when `dryRun` is `true`: guard evaluation and payload validation are performed and reported, and **no external effect is produced and no state changes**. A dry run is not a submission and cannot be reported as one.
Errors:
- `409 ILLEGAL_TRANSITION` — case not in `REQUEST_READY` (in particular, `MATCH_CONFIRMED` → `REQUEST_SUBMITTED` is explicitly illegal, SPEC-001 §4.2).
- `409 AUTHORITY_INVALID` / `409 AUTHORITY_EXPIRED` / `409 AUTHORITY_REVOKED` — the SPEC-001 §4.2 rule that any write with expired or revoked authority is refused, re-asserted at execution time, not merely at case creation (VG-AUTHZ-001).
- `409 RECIPE_STALE` / `409 RECIPE_UNSIGNED` / `409 RECIPE_DISABLED` (VG-CHANNEL-003), `409 SOURCE_PERMISSION_UNCLEAR` / `409 SOURCE_PERMISSION_STALE` (VG-CHANNEL-002).
- `409 CHANNEL_PRIORITY_VIOLATION` (VG-CHANNEL-001) — the request must carry a `policyDecision` whose `channel` matches; a body naming a different channel than the decision is refused rather than silently overridden, and any unused higher-priority channel must be recorded as unavailable with a reason.
- `409 EFFECT_BUDGET_EXCEEDED` with `{"budget":{"dimension":"SUBJECT|SOURCE|SUBJECT_SOURCE_WINDOW","limit":5,"used":5,"windowSeconds":86400}}` and an audit row (VG-ACTION-005).
- `400 IDEMPOTENCY_KEY_REQUIRED`, `409 IDEMPOTENCY_KEY_REUSE`, `409 IDEMPOTENCY_IN_FLIGHT` (§4).
- `422 STRICT_LANE_REQUIRED` for a minor subject (VG-POLICY-004), `422 HUMAN_GATE_OPEN` (an unresolved `HumanGate` on the case), `422 PAYLOAD_FIELD_NOT_ALLOWLISTED` (VG-EGRESS-001), `422 TEMPLATE_HASH_REQUIRED` for `CERTIFIED_MAIL` (VG-ACTION-004), `412 PRECONDITION_FAILED`, `428 PRECONDITION_REQUIRED`, `422 SCHEMA_VALIDATION_FAILED`.

**5.8.3 `POST /v1/external-actions/{externalActionId}/reconciliations`** — reconcile an ambiguous action (VG-ACTION-002, T-none: reconciliation never invents a transition).
Scope `vg.actions.execute`. Idempotency **Required**.
Request: `{"reconciliationMethod":"PROVIDER_API_LOOKUP|MAIL_TRACKING_LOOKUP|CONTROLLER_CONTACT_CONFIRMATION","observedAt":"…","finding":"EFFECT_CONFIRMED|EFFECT_ABSENT|INDETERMINATE","evidenceArtifactId":"evd_01H…","note":"…"}`
Success `200`:
- `finding: "EFFECT_CONFIRMED"` ⇒ `{"externalActionId":"xac_01H…","actionOutcome":"SUBMITTED","caseId":"cas_01H…","truthState":"REQUEST_SUBMITTED","transitionCode":"T8","readbackRequired":true}` — reconciliation confirms the action happened; a **new** readback is still required, and this route does not itself verify removal.
- `finding: "EFFECT_ABSENT"` ⇒ `{"externalActionId":"xac_01H…","actionOutcome":"FAILED","caseId":"cas_01H…","truthStateUnchanged":"REQUEST_SUBMITTED","divergenceRecorded":true,"reissueAllowed":true,"requiresNewIdempotencyKey":true}` — a reissue requires a **new** `IdempotencyKey`. **No truth state regresses**: SPEC-001 §4.1 has no reverse transition, and the API does not invent one. If the case had already reached `REQUEST_SUBMITTED` on a channel acceptance that the reconciliation now contradicts, the divergence is recorded as an audit row and surfaced for review; the case does not silently return to `REQUEST_READY`, and no state outside the closed `T1`–`T21` set is ever produced (SPEC-001 §4.2).
- `finding: "INDETERMINATE"` ⇒ `{"externalActionId":"xac_01H…","actionOutcome":"AMBIGUOUS","escalatedTo":"HUMAN_REQUIRED"}` with the case driven to `HUMAN_REQUIRED` via T9/T12 where the current state permits it.
Errors: `409 ACTION_NOT_AMBIGUOUS` (nothing to reconcile), `409 ILLEGAL_TRANSITION`, `422 EVIDENCE_NOT_FOUND`, `422 SCHEMA_VALIDATION_FAILED`.
The API exposes **no** endpoint that re-sends a failed or ambiguous action on the caller's behalf. Retry is a caller decision with a new key, made visible in the audit trail.

**5.8.4 `POST /v1/external-actions/{externalActionId}/readback`** — request independent readback of the effect via a distinct observation path.
Scope `vg.actions.execute`. Idempotency **Required**.
Request: `{"observationMethod":"PROVIDER_API|INDEPENDENT_FETCH_DIFFERENT_EGRESS|SECOND_CONTROLLER_CHANNEL","requestedAt":"…"}`
Success `202`: `{"externalActionId":"xac_01H…","readbackState":"PENDING","observationMethod":"…","readbackRequestId":"rdb_01H…"}`
The API refuses an observation path that is the same path or identity as the acting path, with `422 OBSERVATION_PATH_NOT_INDEPENDENT` (VG-ACTION-003, VG-VERIFY-001). Readback is a request for evidence, never evidence itself; it never sets a truth state on its own.

**5.8.5 `GET /v1/external-actions/{externalActionId}`** — action detail.
Scope `vg.actions.read`. Idempotency **Optional**.
Success `200`: the 5.8.1 row plus `recipeSnapshot` (`recipeId`, `version`, `signatureVerifiedAt`, `verificationMethod`), `templateSnapshot`, `readbackState` with `readbackAt` and `readbackEvidenceArtifactId`, `ambiguity` detail, and `mailPiece` when the channel is certified mail. Returns `ETag`.
Errors: `404 RESOURCE_NOT_FOUND`.

**5.8.6 `GET /v1/cases/{caseId}/mail-pieces`** — list `MailPiece` rows with template hash and delivery evidence.
Scope `vg.actions.read`. Idempotency **Optional**.
Success `200`: `{"data":[{"mailPieceId":"mlp_01H…","caseId":"cas_01H…","templateVersion":"v7","templateHash":"a91f…","provider":"…","trackingId":"…","deliveryStatus":"ACCEPTED|IN_TRANSIT|DELIVERED|RETURNED|UNKNOWN","deliveryEvidenceArtifactId":"evd_01H…","sentAt":"…"}],"page":{…}}`
A `MailPiece` with no `trackingId` or no `deliveryEvidenceArtifactId` is reported with `deliveryStatus: "UNKNOWN"` and cannot be used to reach `ACKNOWLEDGED` via mail (VG-ACTION-004); the API does not synthesize a delivery status.

### 5.9 Controller responses

| # | Route |
|---|---|
| 5.9.1 | `POST /v1/cases/{caseId}/controller-responses` |
| 5.9.2 | `GET /v1/cases/{caseId}/controller-responses` |
| 5.9.3 | `POST /v1/cases/{caseId}/email-threads` |

**5.9.1 `POST /v1/cases/{caseId}/controller-responses`** — record a `ControllerResponse`; drives T11 (`ACKNOWLEDGED`), T12 (`HUMAN_REQUIRED`), or T13 (`NOT_REMOVABLE`).Scope `vg.cases.write`. Idempotency **Required**. Requires `If-Match`.
Request: `{"responseKind":"ACKNOWLEDGEMENT|REFUSAL|CONTROLLER_DEMANDS_IDENTITY|CONTROLLER_DEMANDS_AUTHORITY|PARTIAL_ACTION|CLAIMED_DELETION|NO_RESPONSE_TIMEOUT","claimedOutcome":"DELETED|NOT_DELETED|UNSPECIFIED","bodyRef":"eml_01H…","receivedAt":"…","evidenceArtifactId":"evd_01H…","refusalBasis":"…"}`
Success `200`: `{"controllerResponseId":"crp_01H…","caseId":"cas_01H…","truthState":"ACKNOWLEDGED","transitionCode":"T11","claimedOutcome":"DELETED","claimedOutcomeIsObservation":false,"verificationRequired":true}`
**A `ControllerResponse` is a claim, not an observation** (SPEC-001 §3.4, VG-VERIFY-004). `claimedOutcome: "DELETED"` moves the case to `ACKNOWLEDGED` and **never** to `VERIFIED_REMOVED`. `ACKNOWLEDGED` never satisfies a removal acceptance criterion (SPEC-000 §5.1), and the response carries `claimedOutcomeIsObservation: false` so no consumer can collapse the two.
`responseKind: "REFUSAL"` with a lawful recorded `refusalBasis` drives T15 to `NOT_REMOVABLE`; `responseKind: "NO_RESPONSE_TIMEOUT"` drives T13 to `NOT_REMOVABLE` with the timeout basis recorded, and is reported as a first-class outcome, not hidden (SPEC-000 §7.6).
`responseKind: "CONTROLLER_DEMANDS_IDENTITY"` and `"CONTROLLER_DEMANDS_AUTHORITY"` route to T12 (`HUMAN_REQUIRED`): the controller is demanding a human or legal step, and the demand is recorded as a gate, not satisfied by the system.
`responseKind: "REFUSAL"` with a lawful recorded `refusalBasis` drives T15 to `NOT_REMOVABLE`; `responseKind: "NO_RESPONSE_TIMEOUT"` drives T13 to `NOT_REMOVABLE` with the timeout basis recorded, and is reported as a first-class outcome, not hidden (SPEC-000 §7.6).
Errors: `422 REFUSAL_BASIS_REQUIRED`, `422 CLAIMED_OUTCOME_UNSUPPORTED`, `409 ILLEGAL_TRANSITION` (e.g. from `REQUEST_READY`, where no action occurred), `422 HUMAN_STEP_REQUIRED` when the response demands an identity or legal step and the case state cannot accept the T12 transition, `412 PRECONDITION_FAILED`, `428 PRECONDITION_REQUIRED`, `422 SCHEMA_VALIDATION_FAILED`.

**5.9.2 `GET /v1/cases/{caseId}/controller-responses`** — list responses, newest first, all retained.
Scope `vg.cases.read`. Idempotency **Optional**. Success `200` list with `claimedOutcomeIsObservation: false` on every row.

**5.9.3 `POST /v1/cases/{caseId}/email-threads`** — attach an `EmailThread` record for deadline and threading purposes.
Scope `vg.cases.write`. Idempotency **Required**.
Request: `{"direction":"OUTBOUND|INBOUND","messageIds":["<…@…>"],"receivedAt":"…","bodyRef":"eml_01H…","subjectHash":"…"}`
Success `201`: `{"emailThreadId":"emt_01H…","caseId":"cas_01H…","direction":"INBOUND","messageIds":[…],"receivedAt":"…","deadlineDerived":{"deadlineId":"ddl_01H…","kind":"CONTROLLER_RESPONSE","dueAt":"…"}}`
Recording a thread may derive a `Deadline` from the applicable policy version; the API never hard-codes a deadline duration (SPEC-001 §3.4 `Deadline`).
Errors: `409 EMAIL_THREAD_DUPLICATE`, `422 MESSAGE_ID_MALFORMED`, `422 SCHEMA_VALIDATION_FAILED`.

### 5.10 Verification observations

| # | Route |
|---|---|
| 5.10.1 | `POST /v1/cases/{caseId}/verification-observations` |
| 5.10.2 | `GET /v1/cases/{caseId}/verification-observations` |
| 5.10.3 | `GET /v1/verification-observations/{verificationObservationId}` |

**5.10.1 `POST /v1/cases/{caseId}/verification-observations`** — record an independent re-observation; drives T14 (`VERIFIED_REMOVED`) when every guard holds, otherwise refuses.
Scope `vg.observations.write`. Idempotency **Required**. Requires `If-Match`.
Request:
`{"observationMethod":"INDEPENDENT_FETCH_DIFFERENT_EGRESS","actorIdentity":"observer-svc-…","observationPathId":"path_02","actingPathId":"path_01","observedAt":"…","finding":"RECORD_ABSENT|RECORD_PRESENT|INDETERMINATE","evidenceArtifactId":"evd_01H…","windowSatisfied":{"requiredSeconds":604800,"elapsedSeconds":691200,"met":true}}`
Success `200`: `{"verificationObservationId":"vob_01H…","caseId":"cas_01H…","truthState":"VERIFIED_REMOVED","transitionCode":"T14","observationMethod":"…","actingPathId":"path_01","observationPathId":"path_02","windowSatisfied":{…},"verificationLagSeconds":691200,"evidenceArtifactId":"evd_01H…"}`
Success `200` with `finding: "RECORD_PRESENT"`: `{"verificationObservationId":"vob_01H…","finding":"RECORD_PRESENT","caseId":"cas_01H…","truthStateAfter":"ACKNOWLEDGED","transitionCode":null,"verificationFailed":true,"reappearanceSuspected":false}` — a failed verification does **not** regress to a success state and does not invent a new one; the case stays honestly where it is (VG-VERIFY-004).
Refusals, each leaving state unchanged:
- `422 OBSERVATION_PATH_NOT_INDEPENDENT` — same path, same session, or same identity as the acting path (VG-VERIFY-001). Same-session, same-client self-report is insufficient by construction.
- `422 OBSERVATION_WINDOW_NOT_MET` with `{"requiredSeconds":…,"elapsedSeconds":…}` — the same-second recheck is refused (VG-VERIFY-002).
- `422 OBSERVATION_METHOD_MISMATCH` with `{"required":"…","supplied":"…"}` — the recipe declares its verification method and the observation must match (VG-VERIFY-003).
- `409 ILLEGAL_TRANSITION` — `REQUEST_SUBMITTED` → `VERIFIED_REMOVED` and `VERIFIED_NOT_PRESENT` → `VERIFIED_REMOVED` are explicitly illegal (SPEC-001 §4.2), and a re-observation by the acting path can never produce `VERIFIED_REMOVED` → `VERIFIED_REMOVED`.
- `422 COVERAGE_BOUNDS_REQUIRED` when `finding: "RECORD_ABSENT"` is asserted from a partial scan; absence from partial coverage is reported with bounds or refused (SPEC-000 §5.1).
- `412 PRECONDITION_FAILED`, `428 PRECONDITION_REQUIRED`, `422 EVIDENCE_NOT_FOUND`, `422 SCHEMA_VALIDATION_FAILED`.

**5.10.2 `GET /v1/cases/{caseId}/verification-observations`** — list observations, newest first, retained forever.
Scope `vg.observations.read`. Idempotency **Optional**. Success `200` list.

**5.10.3 `GET /v1/verification-observations/{verificationObservationId}`** — one observation with its independence attestation.
Scope `vg.observations.read`. Idempotency **Optional**.
Success `200`: the observation plus `independence: {"actingPathId":"path_01","observationPathId":"path_02","distinct":true,"actorDistinct":true}`.
Errors: `404 RESOURCE_NOT_FOUND`.

### 5.11 Reappearances

| # | Route |
|---|---|
| 5.11.1 | `POST /v1/exposures/{exposureId}/reappearances` |
| 5.11.2 | `GET /v1/reappearances` |
| 5.11.3 | `GET /v1/exposures/{exposureId}/reappearances` |

**5.11.1 `POST /v1/exposures/{exposureId}/reappearances`** — record a `Reappearance`; drives T17 (`VERIFIED_REMOVED` → `REAPPEARED`) or T20 (`SEARCH_DELISTED` → `REAPPEARED`).
Scope `vg.observations.write`. Idempotency **Required**. Requires `If-Match`.
Request: `{"priorRemovedEventId":"TR-01H…","observedAt":"…","observationMethod":"SCHEDULED_RE_OBSERVATION","contentHash":"…","evidenceArtifactId":"evd_01H…"}`
Success `201`: `{"reappearanceId":"rap_01H…","exposureId":"exp_01H…","priorRemovedEventId":"TR-01H…","priorTruthState":"VERIFIED_REMOVED","truthState":"REAPPEARED","transitionCode":"T17","observedAt":"…","reentry":{"requiresFreshAuthority":true,"requiresFreshPolicyDecision":true,"requiresFreshRecipe":true,"preservesPriorEvidence":true}}`
Errors: `409 REAPPEARANCE_WITHOUT_PRIOR_REMOVAL` — a first-ever discovery is **never** labelled `REAPPEARED` (VG-REAPPEAR-001); the response names the observed state so the caller learns the truth rather than the label. `409 ILLEGAL_TRANSITION`, `422 PRIOR_REMOVED_EVENT_NOT_FOUND`, `422 EVIDENCE_NOT_FOUND`, `412 PRECONDITION_FAILED`, `422 SCHEMA_VALIDATION_FAILED`.
Re-entry is never a reopening of the old attempt: the response states that fresh authority, a fresh `PolicyDecision`, and a fresh recipe are required, and the subsequent action is a **new** `ExternalAction` with a **new** `IdempotencyKey` and preserved prior evidence (VG-REAPPEAR-002, SPEC-001 §4.1 T18).

**5.11.2 `GET /v1/reappearances`** — tenant-wide reappearance list for monitoring.
Scope `vg.observations.read`. Idempotency **Optional**.
Query: `subjectId`, `sourceId`, `from`, `to`, `reEntryState` ∈ `PENDING_REENTRY|REENTERED|NOT_REMOVABLE`, `sort` ∈ `observedAt` (default `observedAt:desc`).
Success `200` list with `priorRemovedEventId` and `reentry` on every row.

**5.11.3 `GET /v1/exposures/{exposureId}/reappearances`** — reappearance history for one exposure.
Scope `vg.observations.read`. Idempotency **Optional**. Success `200` list, oldest first, including the linked prior `VERIFIED_REMOVED` event for each.

### 5.12 Evidence artifacts

| # | Route |
|---|---|
| 5.12.1 | `POST /v1/evidence-artifacts` |
| 5.12.2 | `GET /v1/evidence-artifacts/{evidenceArtifactId}` |
| 5.12.3 | `GET /v1/evidence-artifacts/{evidenceArtifactId}/content` |
| 5.12.4 | `POST /v1/evidence-artifacts/{evidenceArtifactId}/integrity-checks` |
| 5.12.5 | `GET /v1/cases/{caseId}/evidence-artifacts` |

**5.12.1 `POST /v1/evidence-artifacts`** — upload an immutable, content-addressed `EvidenceArtifact`.
Scope `vg.evidence.write`. Idempotency **Required**. Content type `multipart/form-data`.
Parts: `kind` (`SOURCE_SNAPSHOT|CONTROLLER_CORRESPONDENCE|MAIL_RECEIPT|AUTHORITY_INSTRUMENT|SCAN_OUTPUT|READBACK_PROOF|HUMAN_GATE_CAPTURE`), `caseId` (optional), `capturedAt` (RFC 3339), `redactionState` (`UNREDACTED|DLP_SCRUBBED`), `file` (the content, ≤ 25 MiB, allowed media types are an allowlist), and `digest` (the caller's SHA-256 of the file bytes).
Success `201`: `{"evidenceArtifactId":"evd_01H…","digest":"9f2c…","digestVerified":true,"kind":"…","storageRef":"s3://…/…","capturedAt":"…","redactionState":"…","sizeBytes":184320,"immutable":true,"linkedCaseIds":["cas_01H…"]}`
The API recomputes SHA-256 over the received bytes and compares to the supplied `digest`; a mismatch is `422 EVIDENCE_DIGEST_MISMATCH` and **no artifact row is created**. This is the content-addressing of VG-EVIDENCE-001, enforced at the boundary rather than trusted from the caller.
Errors: `422 EVIDENCE_DIGEST_MISMATCH`, `422 EVIDENCE_DIGEST_MALFORMED`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `422 EVIDENCE_KIND_UNSUPPORTED`, `422 REDACTION_STATE_REQUIRED`, `422 EVIDENCE_NOT_FOUND` (when the optional `caseId` does not resolve), `422 SCHEMA_VALIDATION_FAILED`.

**5.12.2 `GET /v1/evidence-artifacts/{evidenceArtifactId}`** — artifact metadata (never content).
Scope `vg.evidence.read`. Idempotency **Optional**.
Success `200`: the 5.12.1 row plus `linkedTraceability` (`requirementIds`, `caseIds`, `transitionIds`) resolving requirement → case → artifact → digest (VG-EVIDENCE-002). Returns `ETag`.
Errors: `404 RESOURCE_NOT_FOUND`.

**5.12.3 `GET /v1/evidence-artifacts/{evidenceArtifactId}/content`** — download artifact bytes.
Scope `vg.evidence.read_content` + step-up. Idempotency **Optional**.
Success `200`: binary body, `Content-Type` from the stored metadata, `Content-Disposition: attachment; filename="<artifactKind>-<evidenceArtifactId>"`, `X-Content-Type-Options: nosniff`, and `Digest: sha-256=<hex>`. The digest is returned so the caller can verify independently; the API reads the bytes through the `EvidenceStore` port and verifies the digest on read (VG-EVIDENCE-001).
Every download emits an `AuditEvent` with actor, artifact ID, and `X-Request-Id`. Download is **not** available on any bulk, zip, multi-artifact, or "export all" route — no such route exists (§10).
Errors: `403 STEP_UP_REQUIRED`, `403 INSUFFICIENT_SCOPE`, `409 EVIDENCE_INTEGRITY_FAILURE` (recomputed digest ≠ stored digest: the read fails loudly and the artifact is quarantined for review rather than served), `404 RESOURCE_NOT_FOUND`, `410 EVIDENCE_EXPIRED_RETENTION` (retention policy elapsed; the metadata row remains with its digest and an explicit `contentExpired: true` flag rather than a silent 404).

**5.12.4 `POST /v1/evidence-artifacts/{evidenceArtifactId}/integrity-checks`** — request a fresh digest verification.
Scope `vg.evidence.read`. Idempotency **Required**.
Success `200`: `{"evidenceArtifactId":"evd_01H…","storedDigest":"9f2c…","recomputedDigest":"9f2c…","integrityState":"VERIFIED|FAILED","checkedAt":"…"}`
Errors: `409 EVIDENCE_INTEGRITY_FAILURE` with both digests in the body. Artifacts are immutable: there is no update, replace, or delete route for artifact content (VG-EVIDENCE-001).

**5.12.5 `GET /v1/cases/{caseId}/evidence-artifacts`** — list artifacts bound to a case.
Scope `vg.evidence.read`. Idempotency **Optional**.
Success `200` list with `digest`, `kind`, `capturedAt`, `redactionState`, and never a content body.

### 5.13 Deadlines

| # | Route |
|---|---|
| 5.13.1 | `GET /v1/cases/{caseId}/deadlines` |
| 5.13.2 | `POST /v1/cases/{caseId}/deadlines` |
| 5.13.3 | `POST /v1/deadlines/{deadlineId}/satisfaction` |

**5.13.1 `GET /v1/cases/{caseId}/deadlines`** — list deadlines with their policy provenance.
Scope `vg.cases.read`. Idempotency **Optional**.
Success `200`: `{"data":[{"deadlineId":"ddl_01H…","caseId":"cas_01H…","kind":"CONTROLLER_RESPONSE|APPEAL_WINDOW|VERIFICATION_WINDOW|MAIL_RESPONSE|REGULATOR_ESCALATION","dueAt":"…","derivedFrom":{"policyVersion":"2026-01-15","ruleCode":"…"},"state":"OPEN|SATISFIED|BREACHED|WAIVED","satisfiedAt":null,"overdueSeconds":0}]}`
Every deadline names the policy version and rule code it was derived from: deadlines are derived from versioned data, never hard-coded (SPEC-001 §3.4, VG-POLICY-001).

**5.13.2 `POST /v1/cases/{caseId}/deadlines`** — record a deadline that arose out-of-band (e.g. a controller-stated date).
Scope `vg.cases.write`. Idempotency **Required**. Requires `If-Match`.
Request: `{"kind":"APPEAL_WINDOW","dueAt":"…","source":"CONTROLLER_STATED_DATE","evidenceArtifactId":"evd_01H…"}`
Success `201`. Errors: `422 DEADLINE_SOURCE_REQUIRED`, `422 DEADLINE_IN_PAST`, `422 EVIDENCE_NOT_FOUND`, `422 SCHEMA_VALIDATION_FAILED`.

**5.13.3 `POST /v1/deadlines/{deadlineId}/satisfaction`** — mark a deadline satisfied.
Scope `vg.cases.write`. Idempotency **Required**.
Request: `{"satisfiedAt":"…","satisfiedBy":"…","evidenceArtifactId":"evd_01H…"}`
Success `200`: `{"deadlineId":"ddl_01H…","state":"SATISFIED","satisfiedAt":"…"}`
Errors: `409 DEADLINE_ALREADY_SATISFIED`, `422 EVIDENCE_NOT_FOUND`, `422 SCHEMA_VALIDATION_FAILED`.
Satisfying a deadline is not a removal outcome and produces no truth-state change by itself.

### 5.14 Appeals and escalations

| # | Route |
|---|---|
| 5.14.1 | `POST /v1/cases/{caseId}/appeal-escalations` |
| 5.14.2 | `GET /v1/cases/{caseId}/appeal-escalations` |
| 5.14.3 | `GET /v1/appeal-escalations/{appealEscalationId}` |

**5.14.1 `POST /v1/cases/{caseId}/appeal-escalations`** — create an `AppealEscalation`. Serves SPEC-000 §8 priority 7 / VG-CHANNEL-001.
Scope `vg.appeal.write` + step-up. Idempotency **Required**. Requires `If-Match`.
Request: `{"kind":"CONTROLLER_APPEAL|REGULATOR_COMPLAINT|ATTORNEY_LETTER|PROVIDER_ESCALATION","requiresHumanReview":true,"artifactIds":["evd_01H…","evd_01H…"],"templateVersion":"v3","templateHash":"…","recipientControllerId":"ctl_01H…"}`
Success `201`: `{"appealEscalationId":"apl_01H…","caseId":"cas_01H…","kind":"REGULATOR_COMPLAINT","requiresHumanReview":true,"reviewState":"PENDING_COUNSEL_REVIEW","artifactIds":[…],"createdAt":"…","externalEffect":false}`
`externalEffect: false` on creation: creating the record does not send anything. Any sending is a separate `ExternalAction` through §5.8.2 with its own `IdempotencyKey`.
Appeal and escalation content is **counsel-review territory**, not an API decision. The API records `requiresHumanReview: true` and a `PENDING_COUNSEL_REVIEW` review state, and refuses to treat a request as sendable while that state is pending. Legal sufficiency of an escalation, its citations, and the applicable regulator and timeline are **counsel-review** questions recorded in `LEGAL_REVIEW_REQUIRED.md`; the API asserts no legal conclusion and the system must not generate an unsupported legal claim or threat (VG-SCOPE-005).
Errors: `422 HUMAN_REVIEW_REQUIRED` when `requiresHumanReview: false` is supplied for a kind that mandates review, `422 ARTIFACT_REQUIRED` (zero artifacts), `422 TEMPLATE_HASH_REQUIRED`, `409 APPEAL_WINDOW_CLOSED`, `412 PRECONDITION_FAILED`, `422 SCHEMA_VALIDATION_FAILED`.

**5.14.2 `GET /v1/cases/{caseId}/appeal-escalations`** — list escalations with review state.
Scope `vg.cases.read`. Idempotency **Optional**. Success `200` list.

**5.14.3 `GET /v1/appeal-escalations/{appealEscalationId}`** — one escalation.
Scope `vg.cases.read`. Idempotency **Optional**. Success `200`. Errors: `404 RESOURCE_NOT_FOUND`.

### 5.15 Audit query

| # | Route |
|---|---|
| 5.15.1 | `GET /v1/audit-events` |
| 5.15.2 | `GET /v1/audit-events/{auditEventId}` |

**5.15.1 `GET /v1/audit-events`** — query the append-only `AuditEvent` stream.
Scope `vg.audit.read` (role `vg_auditor` or explicit grant). Idempotency **Optional**.
Query: `actor`, `action`, `targetKind`, `targetId`, `correlationId`, `from`, `to` (**required** on this route: an unbounded audit scan is refused with `400 TIME_RANGE_REQUIRED`; maximum span 90 days), `sort` ∈ `at` (default `at:desc`).
Success `200`: `{"data":[{"auditEventId":"aud_01H…","tenantId":"tnt_01H…","actor":{"kind":"HUMAN|SERVICE|SYSTEM","actorId":"…"},"action":"ExecuteAction","target":{"kind":"RequestCase","id":"cas_01H…"},"at":"…","correlationId":"…","requestId":"…","outcome":"SUCCEEDED|REFUSED","refusalCode":null,"traceparent":"…"}],"page":{…}}`
`actor.actorId` is an opaque identifier. Audit payloads never contain raw PII, identifier values, secrets, tokens, signature material, or request bodies (VG-SEC-002, §8.3).
Errors: `400 TIME_RANGE_REQUIRED`, `400 TIME_RANGE_TOO_WIDE`, `403 INSUFFICIENT_SCOPE`, `400 INVALID_CURSOR`.
There is **no** `POST`, `PATCH`, `PUT`, or `DELETE` audit route anywhere on `/v1`: the append-only property is enforced by the absence of a mutation surface as well as by storage (VG-EVIDENCE-003).

**5.15.2 `GET /v1/audit-events/{auditEventId}`** — one audit event.
Scope `vg.audit.read`. Idempotency **Optional**. Success `200`. Errors: `404 RESOURCE_NOT_FOUND`.

### 5.16 Coverage reports and removal-effectiveness metrics

| # | Route |
|---|---|
| 5.16.1 | `GET /v1/coverage-reports` |
| 5.16.2 | `GET /v1/coverage-reports/{coverageReportId}` |
| 5.16.3 | `GET /v1/metrics/removal-effectiveness` |

**5.16.1 `GET /v1/coverage-reports`** — list coverage reports over a declared catalogue.
Scope `vg.coverage.read`. Idempotency **Optional**.
Query: `subjectId`, `discoveryRunId`, `from`, `to`, `sort` ∈ `generatedAt` (default `generatedAt:desc`).
Success `200` list of report summaries, each carrying `sourcesTotal`, `sourcesAttempted`, `sourcesSucceeded`, `uncheckedRemainderCount`.

**5.16.2 `GET /v1/coverage-reports/{coverageReportId}`** — full coverage report naming what was **not** checked.
Scope `vg.coverage.read`. Idempotency **Optional**.
Success `200`:
`{"coverageReportId":"cvr_01H…","generatedAt":"…","scope":{"subjectId":"sub_01H…","catalogueId":"…"},"sourcesTotal":118,"sourcesAttempted":74,"sourcesSucceeded":69,"sourcesSkipped":[{"sourceId":"src_…","sourceName":"…","reason":"RATE_LIMITED|HUMAN_REQUIRED|PROHIBITED|NOT_IN_CATALOGUE|SOURCE_ERROR|ROBOTS_DISALLOWED"}],"uncheckedRemainder":[{"sourceId":"src_…","sourceName":"…"}],"checkedFraction":0.585,"complete":false,"caveats":["PARTIAL_COVERAGE_ABSENCE_NOT_ESTABLISHED"]}`
`uncheckedRemainder` is a **required, non-empty-when-partial** field. A partial report cannot state or imply "no exposure found" (VG-DISC-002, SPEC-000 §7.1). A percentage is always returned with `sourcesTotal` beside it; a percentage without a denominator is a defect (SPEC-000 §7.4).
Errors: `404 RESOURCE_NOT_FOUND`.

**5.16.3 `GET /v1/metrics/removal-effectiveness`** — the primary metric, with numerator, denominator, interval, and confidence interval.
Scope `vg.coverage.read`. Idempotency **Optional**.
Query: `from`, `to` (**required**), `subjectId` (optional), `sourceId` (optional), `groupBy` ∈ `none|source|jurisdiction|channel`.
Success `200`:
`{"interval":{"from":"2026-01-01T00:00:00.000Z","to":"2026-02-01T00:00:00.000Z"},"overall":{"verifiedRemovedNumerator":412,"eligibleConfirmedMatchDenominator":1170,"ratio":0.3521,"confidenceInterval":{"level":0.95,"low":0.3251,"high":0.3795},"denominatorDefinedAs":"exposures at MATCH_CONFIRMED or beyond within the interval that were eligible for a lawful channel"},"excludedFromNumerator":{"acknowledged":180,"requestSubmitted":96,"searchDelisted":64,"notRemovable":118,"humanRequired":57,"ambiguous":12},"caveats":["ACKNOWLEDGED_IS_NOT_REMOVAL","SEARCH_DELISTED_IS_NOT_SOURCE_DELETION","HUMAN_REQUIRED_IS_NOT_FAILURE"]}`
Rules this route enforces, all binding:
- The metric is **independently verified removals ÷ eligible confirmed matches**, with the denominator and interval named (VG-OBS-002).
- `acknowledged`, `requestSubmitted`, and `searchDelisted` appear in `excludedFromNumerator` and never in the numerator (SPEC-000 §5.1, §7.3).
- `notRemovable` and `humanRequired` are disclosed in the same response and are not omitted to improve the apparent rate (SPEC-000 §7.6, SPEC-001 SM-5).
- There is **no** field named `removed`, `permanentDeletion`, `successRate`, or `requestsSent` in this response or any other response on `/v1` (§10, §7.3).
- `ratio` is returned only together with its numerator and denominator; a caller that wants the raw counts has them.
Errors: `400 TIME_RANGE_REQUIRED`, `400 INVALID_GROUP_BY`, `400 TIME_RANGE_TOO_WIDE`.

### 5.17 Health, readiness, liveness, startup

| # | Route |
|---|---|
| 5.17.1 | `GET /v1/health` |
| 5.17.2 | `GET /v1/ready` |
| 5.17.3 | `GET /v1/live` |
| 5.17.4 | `GET /v1/startup` |

These four routes require **no** bearer token and are the only such routes. They expose no tenant data, no counts of tenant rows, and no version of any dependency beyond a coarse name. `/v1/startup` is added here at the request of SPEC-007 §11, which owns the startup semantics and adopts this file's paths and `dependencyState` vocabulary; the route table above is the ownership record, so SPEC-007 does not define a competing path.

**5.17.1 `GET /v1/health`** — aggregate dependency state.
Success `200` (all required dependencies reachable) or `503` (any required dependency unreachable).
Body: `{"dependencyState":"HEALTHY|DEGRADED|UNHEALTHY","checkedAt":"…","service":"vanishgraph-api","apiVersion":"v1","dependencies":[{"name":"postgresql","reachable":true,"latencyMs":3},{"name":"valkey","reachable":true,"latencyMs":1},{"name":"temporal","reachable":true,"latencyMs":7},{"name":"object-store","reachable":true,"latencyMs":11},{"name":"keycloak-jwks","reachable":true,"cacheAgeSeconds":42}],"degraded":[]}`
The `service` value is the `service.name` resource attribute fixed by SPEC-007 (`vanishgraph-api`). The state field is named `dependencyState`, not `status`: it is a dependency-health classification and must never be confused with a truth state.

**5.17.2 `GET /v1/ready`** — readiness for traffic. Owned by SPEC-007 §7 for its full per-check body; this file fixes the path and the two vocabulary fields.
Success `200` with `{"dependencyState":"READY","checkedAt":"…","failedChecks":[]}`; `503` with `{"dependencyState":"NOT_READY","failedChecks":[{"name":"postgresql","reason":"CONNECTION_REFUSED","state":"FAIL"}]}` when a **required** dependency fails. Readiness reflects real dependency state; it must not return `200` from a static handler, a cached value, or a startup-time snapshot, and a static `200` while a dependency is down fails acceptance (VG-OPS-001, SPEC-007 `VG-OBS-025`). Dependency names are this section's vocabulary (`postgresql`, `valkey`, `temporal`, `object-store`, `keycloak-jwks`), with `provider-transport` added by SPEC-007 §7.2.

**5.17.3 `GET /v1/live`** — process liveness only.
Success `200` with `{"dependencyState":"ALIVE","startedAt":"…","uptimeSeconds":12345}`. Liveness performs no dependency I/O: it must not touch the database, Valkey, Temporal, the object store, Keycloak, or any provider transport, must not authenticate, and must not return non-`200` because a downstream dependency is slow or down (SPEC-007 `VG-OBS-023`).

**5.17.4 `GET /v1/startup`** — startup completion: migration applied, configuration and secrets resolved, resource attributes resolved.
Success `200` with `{"dependencyState":"STARTED","checkedAt":"…","configurationResolved":true,"migrationApplied":true,"resourceAttributesResolved":true}`; `503` with `{"dependencyState":"NOT_STARTED","failedChecks":[{"name":"configuration","state":"FAIL"}]}` before initialization completes. Startup must not report started before resource attributes and configuration resolve, because doing so would emit unattributed telemetry (SPEC-007 §7.1).
This route is cluster-internal in deployment terms and is **not** an authenticated tenant-scoped route; it exposes no tenant data. The Prometheus scrape endpoint is `GET /metrics` at the origin root, outside `/v1`, and is cluster-internal only — it is not part of the public API surface (SPEC-007 §7.1).

---

## 6. Webhook ingress contracts

Webhook ingress is the only unauthenticated-by-bearer write surface. It is authenticated by signature, replay-protected, and idempotent. All four properties are required, and each is separately verifiable (VG-SEC-004).

| # | Route |
|---|---|
| 6.1 | `POST /v1/webhooks/controller-callbacks/{controllerCallbackToken}` |
| 6.2 | `POST /v1/webhooks/provider-callbacks/{providerKeyId}` |
| 6.3 | `POST /v1/webhooks/mail-tracking/{mailProviderKeyId}` |

### 6.1 Signature scheme

Every webhook request must carry all of:

| Header | Rule |
|---|---|
| `X-VG-Key-Id` | Provider key identifier. Must resolve to a currently trusted key. Unknown or retired key ⇒ `401 WEBHOOK_KEY_UNKNOWN`. |
| `X-VG-Timestamp` | Unix epoch seconds (integer). Absent, unparseable, or outside ±300 s of server time ⇒ `401 WEBHOOK_TIMESTAMP_OUT_OF_WINDOW`. |
| `X-VG-Nonce` | 16–128 chars `[A-Za-z0-9._:-]`, unique per delivery attempt. Absent or malformed ⇒ `400 WEBHOOK_NONCE_MISSING`. |
| `X-VG-Signature` | `v1=<lowercase hex>`, HMAC-SHA256 over `"<timestamp>.<nonce>.<raw request body bytes>"` with the provider's shared secret resolved through the `SecretResolver` port. |
| `X-VG-Event-Id` | Provider-assigned stable event identifier. Required for idempotent processing. |

Verification order is fixed: resolve key → check timestamp window → check nonce → verify HMAC over the **raw** bytes (before any JSON parsing or normalization) → check that `X-VG-Event-Id` is present and well-formed. A failure at any step returns the mapped error and **no** state change. Signature comparison is constant-time. The raw body is capped at 256 KiB; larger is `413 PAYLOAD_TOO_LARGE` and the body is discarded unparsed. A missing or malformed `X-VG-Event-Id` is `400 MISSING_REQUIRED_HEADER`: without a stable event identity the ingress cannot promise idempotent processing, so it refuses rather than guessing.

### 6.2 Replay protection

- Server time window: ±300 seconds (`X-VG-Timestamp`). Outside it: `401 WEBHOOK_TIMESTAMP_OUT_OF_WINDOW`.
- Nonce and event ID are both recorded in the coordination store (Valkey) with a TTL of 3600 s, keyed `(providerKeyId, nonce)` and `(providerKeyId, eventId)`.
- A repeated nonce is `409 WEBHOOK_NONCE_REPLAY` with **no** state change. The replay is rejected **once**, deterministically, not merely de-duplicated after the fact (VG-SEC-004 negative case).
- A repeated event ID is not an error: it is an idempotent delivery and returns the **stored original response** with `200` and `X-VG-Webhook-Replayed: true`. Nonce and event ID are both required because nonce catches re-delivery of the same signed bytes while event ID catches a provider that re-sends the same logical event with a fresh nonce and timestamp.
- A replay that beats the nonce store (e.g. store unavailable) fails **closed**: `503 DEPENDENCY_UNAVAILABLE`, never "accept and dedupe later".

### 6.3 Processing semantics

- A webhook **never** sets a truth state directly. Each ingress verifies, records an `AuditEvent`, and dispatches exactly one domain command (SPEC-001 §6): `RecordControllerResponse` for 6.1, and for 6.2/6.3 it records transport and delivery facts that may later inform a readback or a `ControllerResponse` but are not themselves observations.
- **A provider delivery callback is not a `VerificationObservation`.** Delivery evidence supports `ACKNOWLEDGED`/`MailPiece` state (VG-ACTION-004); it can never satisfy T14. Only §5.10.1 records verification, and only with an independent path and method match.
- Webhook bodies are **tainted input** (VG-SEC-001). Free text from a webhook is stored as evidence with `taint: "TAINTED"` and can never select a channel, author a legal basis, alter a recipe, or trigger an `ExternalAction`. Any field in a webhook body that attempts to name a channel, legal basis, truth state, budget, or idempotency key is ignored and its presence is audited as `IGNORED_CONTROL_FIELD`.
- Webhook payloads are size-capped (256 KiB), content-type restricted, schema-validated after signature verification, and never persisted raw into an application table: the raw bytes go to encrypted artifact storage and the table holds a `bodyRef` plus digest (`ControllerResponse.bodyRef`, SPEC-001 §3.4).

**6.1 `POST /v1/webhooks/controller-callbacks/{controllerCallbackToken}`** — controller/provider callback for a `ControllerResponse`.
The path token is an opaque, single-purpose capability resolved to one `(tenantId, caseId, controllerId)` binding, rotated and revocable per controller; it is not a bearer credential and confers no scope. Serves VG-SEC-004, VG-VERIFY-004.
Request body (after verification):
`{"eventId":"evt_…","caseId":"cas_01H…","responseKind":"ACKNOWLEDGEMENT|REFUSAL|CONTROLLER_DEMANDS_IDENTITY|CONTROLLER_DEMANDS_AUTHORITY|PARTIAL_ACTION|CLAIMED_DELETION","claimedOutcome":"DELETED|NOT_DELETED|UNSPECIFIED","receivedAt":"…","bodyRef":"eml_01H…","controllerReference":"…"}`
Success `202`: `{"accepted":true,"controllerResponseId":"crp_01H…","caseId":"cas_01H…","truthStateAfter":"ACKNOWLEDGED","claimedOutcomeIsObservation":false,"verificationRequired":true}`
Errors: `401 WEBHOOK_SIGNATURE_INVALID`, `401 WEBHOOK_KEY_UNKNOWN`, `401 WEBHOOK_TIMESTAMP_OUT_OF_WINDOW`, `409 WEBHOOK_NONCE_REPLAY`, `400 WEBHOOK_NONCE_MISSING`, `404 WEBHOOK_BINDING_NOT_FOUND` (unknown or revoked path token), `409 WEBHOOK_CASE_STATE_CONFLICT` (a response arriving for a case whose state cannot accept one — recorded as an audit row and **not** applied as a transition), `422 SCHEMA_VALIDATION_FAILED`, `413 PAYLOAD_TOO_LARGE`, `503 DEPENDENCY_UNAVAILABLE`.
A `claimedOutcome: "DELETED"` here produces `ACKNOWLEDGED`. It does **not** produce `VERIFIED_REMOVED`, and the response states `claimedOutcomeIsObservation: false` so no downstream consumer can collapse the two (SPEC-000 §5.1, VG-VERIFY-004).

**6.2 `POST /v1/webhooks/provider-callbacks/{providerKeyId}`** — provider transport callback (form submission acknowledgment, portal status change).
Serves VG-SEC-004, VG-ACTION-002, VG-ACTION-003.
Request body: `{"eventId":"evt_…","providerTransportRunId":"ptr_01H…","externalActionId":"xac_01H…","providerEventKind":"SUBMISSION_ACCEPTED|SUBMISSION_REJECTED|STATUS_CHANGED|RATE_LIMITED","providerReference":"…","observedAt":"…","rawBodyRef":"evd_01H…"}`
Success `202`: `{"accepted":true,"providerTransportRunId":"ptr_01H…","recordedAs":"PROVIDER_TRANSPORT_FACT","truthStateChanged":false}`
`providerTransportRunId` references a SPEC-001 §3.5 `ProviderTransportRun` — the official-transport record (ADR-004). `truthStateChanged` is always `false` for this route. A `SUBMISSION_ACCEPTED` callback is the provider's own report and cannot satisfy independent readback (VG-ACTION-003): readback still requires §5.8.4 and a subsequent §5.10.1 observation.
Errors: `401 WEBHOOK_SIGNATURE_INVALID`, `401 WEBHOOK_KEY_UNKNOWN`, `401 WEBHOOK_TIMESTAMP_OUT_OF_WINDOW`, `409 WEBHOOK_NONCE_REPLAY`, `400 WEBHOOK_NONCE_MISSING`, `404 WEBHOOK_BINDING_NOT_FOUND` (unknown or revoked path token), `409 WEBHOOK_ACTION_NOT_FOUND`, `409 WEBHOOK_PROVIDER_RUN_MISMATCH`, `409 WEBHOOK_CASE_STATE_CONFLICT` (a provider fact arriving for a case state that cannot accept it — recorded as an audit row and **not** applied as a transition), `422 SCHEMA_VALIDATION_FAILED`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `503 DEPENDENCY_UNAVAILABLE`.

**6.3 `POST /v1/webhooks/mail-tracking/{mailProviderKeyId}`** — mail tracking and delivery events for a `MailPiece`.
Serves VG-SEC-004, VG-ACTION-004.
Request body: `{"eventId":"evt_…","trackingId":"…","mailPieceId":"mlp_01H…","deliveryStatus":"ACCEPTED|IN_TRANSIT|DELIVERED|RETURNED|UNKNOWN","occurredAt":"…","providerEvidenceHash":"…","rawBodyRef":"evd_01H…"}`
Success `202`: `{"accepted":true,"mailPieceId":"mlp_01H…","deliveryStatus":"DELIVERED","truthStateChanged":false}`
A delivery event updates `MailPiece.deliveryStatus` and its evidence. It cannot move a case to `ACKNOWLEDGED` on its own: delivery is a transport fact, and VG-ACTION-004 requires template version, template hash, tracking, and delivery evidence to be preserved together, while acknowledgment requires a `ControllerResponse` (T11).
Errors: `401 WEBHOOK_SIGNATURE_INVALID`, `401 WEBHOOK_KEY_UNKNOWN`, `401 WEBHOOK_TIMESTAMP_OUT_OF_WINDOW`, `409 WEBHOOK_NONCE_REPLAY`, `400 WEBHOOK_NONCE_MISSING`, `404 WEBHOOK_BINDING_NOT_FOUND` (unknown or retired provider key binding), `409 WEBHOOK_MAIL_PIECE_NOT_FOUND`, `422 DELIVERY_STATUS_UNKNOWN`, `422 SCHEMA_VALIDATION_FAILED`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `503 DEPENDENCY_UNAVAILABLE`.

### 6.4 Webhook non-goals

No webhook route accepts an upload of executable content, a template, a recipe, a channel selection, a legal basis, or a budget value. No webhook route can create an `AuthorityGrant`, enable a `RemovalRecipe`, or execute an `ExternalAction`. A webhook body is data about the outside world, never instruction to this system (VG-SEC-001).

---

## 7. Read-model and DTO rules

### 7.1 No raw PII in list responses by default

- Every collection route returns masked or opaque values only: `valueMasked` (`j***@e***.com`), `rawRefMasked`, `subjectRef` (opaque ID), `displayRef` (operator-chosen reference, not a natural-person name).
- A route returns an unmasked value only when its scope table explicitly permits it (`vg.pii.reveal` plus step-up) and the request sets `includeValue=true` on the specific single-subject route. There is no list route that returns unmasked identifier values, under any scope.
- `Identifier` plaintext never appears in a response, a log line, a metric label, an `AuditEvent`, a trace attribute, or an error body. This is VG-SEC-002 applied at the response boundary: a secret-shaped value that reaches a client is a leak whether or not it was "the" secret.
- Exports: none exist (§10). A caller that needs data in bulk uses the paginated list routes under its tenant, with every page independently authorized and audited.

### 7.2 Identifier opacity

- All IDs in responses are opaque. SPEC-002 §4 fixes the storage representation as `uuid PRIMARY KEY DEFAULT gen_random_uuid()` on every table, so a `/v1` identifier is a UUID in lowercase canonical form. The mnemonic prefixes used illustratively in §5 (`sub_`, `agr_`, `als_`, `idn_`, `src_`, `sce_`, `rcp_`, `drn_`, `srd_`, `exp_`, `pdc_`, `ctl_`, `cas_`, `xac_`, `mlp_`, `emt_`, `ddl_`, `crp_`, `vob_`, `rap_`, `evd_`, `apl_`, `hgt_`, `aud_`) are **not** part of the `/v1` contract and are a documentation convenience only; the canonical value is the underlying UUID from the `IdGenerator` port. A response must not embed any value that is not the opaque ID itself.
- `displayRef` is tenant-chosen and must not be a natural-person name; it exists so operators have a stable handle without putting PII in URLs, logs, or metric labels (SPEC-001 §3 note: raw PII is never a primary key, a log field, or a metric label).
- No route accepts a raw PII value as a path parameter, query parameter, or sort field.

### 7.3 Truth state is passed through, never collapsed or renamed

This is the SPEC-000 §5.1 non-collapse rule expressed as an API-surface rule:

| Rule | API form |
|---|---|
| `REQUEST_SUBMITTED` is never rendered as "removed" | Response field is `truthState: "REQUEST_SUBMITTED"`. No boolean, label, badge, or derived field named `removed`, `isRemoved`, `removalConfirmed`, `deleted`, or `success` appears in any response. |
| `ACKNOWLEDGED` never satisfies a removal acceptance criterion | `ControllerResponse` rows carry `claimedOutcomeIsObservation: false`; `GET /v1/metrics/removal-effectiveness` lists `acknowledged` under `excludedFromNumerator`. |
| `SEARCH_DELISTED` never increments the source-removal metric | `SEARCH_DELISTED` is its own `truthState` value; the metric's `excludedFromNumerator.searchDelisted` accounts for it separately. |
| `VERIFIED_REMOVED` requires a distinct-path observation | §5.10.1 refuses `OBSERVATION_PATH_NOT_INDEPENDENT`; §5.11.1 links the prior removed event. |
| `VERIFIED_NOT_PRESENT` requires in-scope coverage | §5.5.4 and §5.10.1 refuse `COVERAGE_BOUNDS_REQUIRED` without bounds. |
| No ad-hoc statuses | The API's only lifecycle enum for exposure and case is the eleven-state `TruthState`. Filtering rejects unknown tokens (`400 INVALID_TRUTH_STATE`). |

Additional naming rules that bind the DTOs:

- The word `success` appears in **no** response field name, no query parameter, and no path segment on `/v1`. Where §5.15.1 reports an audit outcome it uses `outcome: "SUCCEEDED" | "REFUSED"`, which describes the *command dispatch*, not a removal.
- The word `request` appears in no route path or field name as a standalone noun. The durable unit of work is `RequestCase` with field `caseId`; the outside write is `ExternalAction` with field `externalActionId`.
- **Two sanctioned exceptions, both HTTP-layer and neither domain-bearing.** `X-Request-Id` and the error-envelope field `requestId` are the standard HTTP call-tracing names; they identify one HTTP invocation, carry no domain meaning, and are not a synonym for `RequestCase` or `ExternalAction`. `GET /v1/audit-events` reports both `correlationId` and `requestId` for exactly that tracing purpose. The vocabulary gate of VG-API-068 must allow these two tokens by exact name and reject any other `request*` identifier.
- `SourceRecord` rows are never returned under a key named `hit`, `listing`, `result`, or `lead`.
- `Source` is keyed `sourceId` and never `vendorId`/`providerId`/`siteId`. Where a transport vendor is meant (e.g. the mail provider in §5.8.6) the field is `provider` on `MailPiece` — the canonical entity's own field name, not a synonym for `Source`.
- `RemovalRecipe` is keyed `recipeId` and never `scraperId`/`botId`/`scriptId`.
- `ProtectedSubject` is keyed `subjectId` and never `targetId`/`clientId`/`profileId`.
- A route that would expose a legal conclusion returns a `PolicyDecision` reference plus its `legalBasis` token from versioned policy data, and never free-form legal prose authored by the system. Where a determination is not owned by this system, the response carries `requiresCounselReview: true` and the case records `HUMAN_REQUIRED` or `NOT_REMOVABLE` with its basis (SPEC-000 §11, `LEGAL_REVIEW_REQUIRED.md`).

### 7.4 Coverage and metric DTO rules

- Any DTO carrying a count derived from discovery carries `sourcesTotal` and `sourcesAttempted` beside it, and `uncheckedRemainder` when partial (SPEC-000 §7.1).
- Any ratio carries its numerator and denominator (SPEC-000 §7.4).
- `Confidence` is always the object with `basis` (SPEC-000 §7.5, SPEC-001 §2).
- `NOT_REMOVABLE` and `HUMAN_REQUIRED` counts are present in every effectiveness DTO and are never omitted (SPEC-000 §7.6).

---

## 8. Error response envelope

### 8.1 Envelope

Every non-2xx response has this body, and only this body:

```json
{
  "error": {
    "code": "ILLEGAL_TRANSITION",
    "message": "The requested state change is not permitted from the current state.",
    "requestId": "req_01H…",
    "correlationId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "retryable": false,
    "occurredAt": "2026-02-04T09:31:22.104Z",
    "details": {
      "fromTruthState": "ACKNOWLEDGED",
      "toTruthState": "VERIFIED_REMOVED",
      "transitionCode": null,
      "ruleRef": "SPEC-001:4.2:ACKNOWLEDGED->VERIFIED_REMOVED"
    }
  }
}
```

- `code` is the stable machine-readable contract. `message` is human-facing and may change; clients must never branch on it.
- `message` is a **fixed, non-interpolated template string per `code`** (SPEC-006 §6.2 H-3). It contains no identifier, subject value, URL, or provider text. All dynamic, non-PII context goes in `details`.
- `retryable` mirrors the `retryable` static metadata of the error's class (SPEC-006 §5.3) and agrees with `Retry-After` when one is present (SPEC-006 H-11). A client must never retry a `retryable: false` response, and must never blind-retry an effect-bearing route regardless (§4.5).
- `details` is optional, code-specific, and schema-validated per code. It contains identifiers, enum tokens, guard names, counts, and `ruleRef` — never a request body, never a field value from a PII-bearing field, never a stack trace, never an upstream provider response body verbatim.
- `requestId` and `correlationId` are always present so a support conversation can join to an audit row without exchanging PII.
- The envelope has exactly one top-level key, `error`. An empty or absent body on a non-2xx response is a contract defect (SPEC-006 H-1).
- The `202` reconciliation response of §5.8.2 is the `AMBIGUOUS_EXTERNAL_EFFECT` shape, not the error envelope: it carries `externalActionId`, `actionOutcome`, `reconciliationRequired`, `reconciliationId`, `truthStateChanged: false`, and `correlationId` (SPEC-006 §6.1).

### 8.2 HTTP status mapping

| Status | Used for | Representative codes |
|---|---|---|
| `400` | Malformed request, missing required header/parameter, opaque-value validation | `SCHEMA_VALIDATION_FAILED` (syntax), `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_MALFORMED`, `INVALID_CURSOR`, `INVALID_SORT_FIELD`, `UNKNOWN_QUERY_PARAMETER`, `INVALID_TRUTH_STATE`, `INVALID_GROUP_BY`, `TIME_RANGE_REQUIRED`, `TIME_RANGE_TOO_WIDE`, `FILTER_TOO_BROAD`, `WEBHOOK_NONCE_MISSING`, `MISSING_REQUIRED_HEADER` |
| `401` | Missing, malformed, expired, or unverifiable token; webhook signature failure | `TOKEN_MISSING`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `TOKEN_INVALID_CLAIMS`, `TOKEN_AUDIENCE_MISMATCH`, `TOKEN_SCOPE_WILDCARD_FORBIDDEN`, `WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_KEY_UNKNOWN`, `WEBHOOK_TIMESTAMP_OUT_OF_WINDOW` |
| `403` | Authenticated but not permitted | `INSUFFICIENT_SCOPE`, `INSUFFICIENT_ROLE`, `STEP_UP_REQUIRED`, `SEPARATION_OF_DUTIES`, `IDENTITY_LEVEL_INSUFFICIENT`, `EGRESS_DENIED` (domain-only; the `EgressGate` refused the payload class, SPEC-006 §5.3 class 14, `DATA_EGRESS_MATRIX`) |
| `404` | Resource absent **or** owned by another tenant | `RESOURCE_NOT_FOUND`, `WEBHOOK_BINDING_NOT_FOUND` |
| `409` | Conflict with current resource state or a prior request | `ILLEGAL_TRANSITION`, `IDEMPOTENCY_KEY_REUSE`, `IDEMPOTENCY_IN_FLIGHT`, `EFFECT_BUDGET_EXCEEDED`, `AUTHORITY_INVALID`, `AUTHORITY_EXPIRED`, `AUTHORITY_REVOKED`, `AUTHORITY_ALREADY_REVOKED`, `RECIPE_STALE`, `RECIPE_UNSIGNED`, `RECIPE_DISABLED`, `RECIPE_GUARD_FAILED`, `RECIPE_VERSION_CONFLICT`, `SOURCE_PERMISSION_UNCLEAR`, `SOURCE_PERMISSION_STALE`, `SOURCE_ALREADY_DECLARED`, `CATALOG_ENTRY_DUPLICATE`, `CHANNEL_PRIORITY_VIOLATION`, `POLICY_VERSION_SUPERSEDED`, `CASE_AUTHORITY_INVALID`, `REAPPEARANCE_WITHOUT_PRIOR_REMOVAL`, `CASE_ALREADY_EXISTS`, `CASE_EXPOSURE_STATE_MISMATCH`, `ALIAS_ALREADY_ATTACHED`, `IDENTIFIER_ALREADY_PRESENT`, `EMAIL_THREAD_DUPLICATE`, `DEADLINE_ALREADY_SATISFIED`, `APPEAL_WINDOW_CLOSED`, `STRICT_LANE_CONFLICT`, `DISCOVERY_RUN_IN_FLIGHT`, `ACTION_NOT_AMBIGUOUS`, `EVIDENCE_INTEGRITY_FAILURE`, `IDENTITY_CLASS_MISMATCH`, `WEBHOOK_NONCE_REPLAY`, `WEBHOOK_CASE_STATE_CONFLICT`, `WEBHOOK_ACTION_NOT_FOUND`, `WEBHOOK_PROVIDER_RUN_MISMATCH`, `WEBHOOK_MAIL_PIECE_NOT_FOUND`, `NO_LAWFUL_BASIS` (domain-only; an explicit refusal spelling of the `NOT_REMOVABLE` outcome, which is normally a `200` outcome body — SPEC-006 §5.3 class 6) |
| `410` | Content retention elapsed while metadata remains | `EVIDENCE_EXPIRED_RETENTION` |
| `412` | `If-Match` precondition failed | `PRECONDITION_FAILED` |
| `413` | Body too large | `PAYLOAD_TOO_LARGE` |
| `415` | Unsupported media type | `UNSUPPORTED_MEDIA_TYPE` |
| `422` | Well-formed request that fails a semantic or guard validation | `SCHEMA_VALIDATION_FAILED` (semantic), `CONFIDENCE_BASIS_REQUIRED`, `CONFIDENCE_OUT_OF_RANGE`, `COVERAGE_BOUNDS_REQUIRED`, `OBSERVATION_PATH_NOT_INDEPENDENT`, `OBSERVATION_WINDOW_NOT_MET`, `OBSERVATION_METHOD_MISMATCH`, `LEGAL_BASIS_NOT_IN_POLICY_VERSION`, `LEGAL_BASIS_NOT_AUTHORABLE`, `JURISDICTION_UNRESOLVED`, `EVIDENCE_DIGEST_MISMATCH`, `EVIDENCE_DIGEST_MALFORMED`, `EVIDENCE_REQUIRED`, `EVIDENCE_NOT_FOUND`, `EVIDENCE_KIND_UNSUPPORTED`, `REDACTION_STATE_REQUIRED`, `CASE_NOT_FOUND`, `AUTHORITY_EVIDENCE_REQUIRED`, `AUTHORITY_GRANT_INVALID`, `AUTHORITY_GRANT_SCOPE_INSUFFICIENT`, `AUTHORITY_SCOPE_UNKNOWN`, `AUTHORITY_KIND_UNSUPPORTED`, `AUTHORITY_WINDOW_INVALID`, `GUARD_FAILED`, `TRANSITION_NOT_ROUTEABLE`, `FIELD_NOT_PATCHABLE`, `STRICT_LANE_REQUIRED`, `MINOR_STRICT_LANE`, `BYPASS_ATTEMPT_REFUSED`, `HUMAN_GATE_OPEN`, `HUMAN_STEP_REQUIRED`, `HUMAN_REVIEW_REQUIRED`, `ARTIFACT_REQUIRED`, `PAYLOAD_FIELD_NOT_ALLOWLISTED`, `TEMPLATE_HASH_REQUIRED`, `DISCOVERY_MODE_FORBIDDEN`, `SOURCE_NOT_PERMITTED_FOR_READ`, `RATE_LIMIT_POLICY_MISSING`, `CATALOG_NOTES_REQUIRED`, `LICENSE_UNRECORDED`, `CONTROLLER_NOT_FOUND`, `PERMISSION_EVIDENCE_REQUIRED`, `RECIPE_SIGNATURE_INVALID`, `RECIPE_VERIFICATION_METHOD_REQUIRED`, `RECIPE_CHANNEL_UNKNOWN`, `POLICY_DECISION_INCOMPLETE`, `RECIPE_NOT_ENABLED`, `IDENTIFIER_KIND_UNSUPPORTED`, `PRIOR_REMOVED_EVENT_NOT_FOUND`, `OVERLAPPING_INTERVAL`, `DEADLINE_SOURCE_REQUIRED`, `DEADLINE_IN_PAST`, `MESSAGE_ID_MALFORMED`, `CLAIMED_OUTCOME_UNSUPPORTED`, `REFUSAL_BASIS_REQUIRED`, `DELIVERY_STATUS_UNKNOWN`, `TAINTED_CONTENT_REJECTED` (domain-only; tainted or model-produced content reached a decision or write path, or attempted to select a channel — SPEC-006 §5.3 class 13, VG-SEC-001) |
| `428` | `If-Match` required and absent | `PRECONDITION_REQUIRED` |
| `429` | Rate limit or per-source discovery limit exceeded | `RATE_LIMITED` |
| `500` | Unexpected server fault | `INTERNAL_ERROR` |
| `503` | Required dependency unavailable; webhook replay store unavailable | `DEPENDENCY_UNAVAILABLE` |

**409 versus 422.** `409` means *the resource's current state makes this request impossible right now* (an illegal transition, a stale recipe, an exhausted budget, a conflicting prior request). `422` means *the request itself is semantically invalid or a required input is absent* (no basis on a confidence, no evidence artifact, no coverage bounds). `412`/`428` concern the concurrency token only and never replace a state or guard check.

### 8.3 No PII, secrets, or internals in error bodies

- Error `message` and `details` never contain: identifier plaintext, alias values, subject names, addresses, email addresses, phone numbers, document images or their OCR text, access tokens, refresh tokens, `IdempotencyKey` values, signature material, shared secrets, database connection strings, SQL statements, internal host names or IP addresses, upstream `Set-Cookie` values, or a stack trace.
- Provider error text is mapped to a code and logged (DLP-scrubbed) rather than echoed. A caller that needs provider detail receives a `providerReference` opaque ID it can use with support.
- Error bodies are constructed from an allowlist template per code, so an unexpected exception cannot serialize its own message into the response. This is the response-boundary expression of VG-SEC-002, and it is verified by a canary test rather than by review.
- An error body that would be more informative with a PII value is instead less informative. There is no debug mode on a deployed `/v1` that changes this; diagnostics are obtained from DLP-scrubbed telemetry (VG-EGRESS-002).

### 8.4 Error-code registry, and ownership versus SPEC-006

Error codes are `SCREAMING_SNAKE_CASE` and stable. **SPEC-006 (error taxonomy)
owns the taxonomy; this file owns the wire.** The division is:

- **Wire codes and statuses — SPEC-003 owns.** The code set and code→status
  mapping in §8.1/§8.2 are the `/v1` contract. SPEC-006 §6 adopts them verbatim
  for every code this file enumerates. Adding a code requires a row here **and**
  the corresponding SPEC-006 entry in the same change; renaming or removing a code
  this file enumerates is a breaking `/v1` change (§2.1) and requires an ADR. The
  two files must never list different statuses for the same code; the contract test
  compares them and fails on divergence.
- **Domain classes and audit/telemetry codes — SPEC-006 owns.** SPEC-006 §5.3
  declares the static `class`/`category`/`severity`/`retryable` metadata per error
  class, and its domain-only codes (`NO_LAWFUL_BASIS`, `TAINTED_CONTENT_REJECTED`,
  `EGRESS_DENIED`, and `AMBIGUOUS_EXTERNAL_EFFECT`) are adopted here in §8.2 so
  that no domain code lacks a wire spelling. Domain-only codes are audit- and
  telemetry-bearing; they must not be re-spelled on the wire.
- **The interfaces agree on one behaviour.** `IllegalTransition` (SPEC-001 §4)
  maps to HTTP `409 ILLEGAL_TRANSITION` with the state unchanged and the refusal
  audited; SPEC-006 class 1 and this file state the same thing.
- **Both files are point-in-time.** SPEC-006 registers the reconciliation as a
  reviewed point-in-time adoption and notes that a change to §8.1/§8.2 here
  invalidates its §6.2 mapping and its mapping tests, exactly as VG-REL-004
  invalidates dependent evidence. Any future edit to this section therefore
  requires a matching SPEC-006 change and a rerun of the mapping contract test.

---

## 9. MCP and agent-facing surface

The MCP gateway is a **client** of the same `/v1` contract. It has no privileged route, no separate data path, and no scope beyond what its token carries. This section states the constraints that bind that surface; the tool registry itself is specified elsewhere.

### 9.1 Least privilege and typed tools

- Every MCP-exposed tool maps to exactly one route in §5 and carries that route's scope requirement. A tool may **narrow** the route (by pinning fields or forbidding a whole operation) and may never widen it.
- A tool is declared with an explicit input schema and an explicit output schema; the input schema is **validated before dispatch**, and an input that fails validation never reaches the application layer. A free-form "call any endpoint" tool, a raw HTTP passthrough tool, and a shell tool are prohibited.
- Write-capable tools are a small, explicitly enumerated subset: at most `assess-match`, `record-verification-observation`, `record-reappearance`, `record-human-gate`, and `upload-evidence-artifact`. Each is marked as effect-bearing, and each requires an `IdempotencyKey` supplied by the orchestration layer, not generated by the model.
- The MCP token carries a distinct `aud` from portal tokens and must carry an explicit scope list, never `*` (§3.2 item 7). MCP tokens must not hold `vg.policy.write`, `vg.authority.write`, `vg.appeal.write`, `vg.actions.execute`, `vg.audit.read`, or `vg.pii.reveal`.

### 9.2 The model cannot author a legal basis or a write

Binding, not advisory:

1. **No tool exists** that accepts a `legalBasis`, a `jurisdiction` rule, a policy version, or a channel-priority override as model-authored input. `POST /v1/cases/{caseId}/policy-decisions` resolves a decision from versioned data; it rejects a caller-asserted `legalBasis` with `422 LEGAL_BASIS_NOT_AUTHORABLE` (VG-POLICY-001).
2. **No effect without an existing `PolicyDecision`.** §5.8.2 requires `policyDecisionId` and `recipeId`; the domain refuses T8 without them (SPEC-001 §4.1 T5/T8). A model output cannot create a `PolicyDecision`, an `AuthorityGrant`, or an enabled `RemovalRecipe` — no MCP-exposed tool exists for any of the three.
3. **Model output cannot select a channel.** Channel selection is recorded in the `PolicyDecision`. A tool call whose payload attempts to override the decided channel is refused with `409 CHANNEL_PRIORITY_VIOLATION` (VG-CHANNEL-001).
4. **Model output is untrusted content.** Any model-produced string that reaches a write path is treated as data: it can populate a template field inside the allowlist, and it can never populate a control field. This is VG-SEC-001 applied to the model itself, on the same footing as a fetched page.
5. **A recommendation is labelled as a recommendation.** Where the system surfaces a model-suggested channel or basis to a human, the DTO carries `origin: "MODEL_SUGGESTION"` and `requiresHumanReview: true`, and the suggestion is inert until a `PolicyDecision` exists.
6. **No autonomous production deployment or policy change.** Consistent with VG-SCOPE-009, no tool exposes deployment, migration, policy authoring, recipe signing, or kill-switch removal.

### 9.3 Effect budgets

- Every effect-bearing tool call is subject to: a **per-token budget** (calls per window), a **per-subject budget**, a **per-source budget**, and the domain's per-subject/source/window write budget (VG-ACTION-005). The domain budget is authoritative; the gateway budget is an additional ceiling, never a substitute.
- Exhausting any budget yields `409 EFFECT_BUDGET_EXCEEDED` with the exhausted dimension, its limit, its usage, and its window. There is no "override budget" tool and no route parameter that raises a budget.
- Every effect-bearing tool call emits an `AuditEvent` naming the token identity, the tool, the target, the idempotency key fingerprint, and the budget consumed. A budget refusal is itself audited.
- The gateway refuses to retry an effect-bearing call on the caller's behalf. Retry is an orchestration decision with a new effect identity, and it is visible.

### 9.4 Agent-surface non-goals

No MCP tool exposes: bulk subject listing beyond an authorized page, unmasked identifier values, evidence content download, audit query, coverage or metric export, webhook verification material, or any route under §10. An agent cannot escalate its own scope, and no tool accepts a scope, role, tenant, or audience parameter.

---

## 10. Explicit API non-goals

These are prohibited at the contract level. Adding any of them is a release blocker and a DOD-027 contradiction with SPEC-000.

1. **No bulk PII export.** No `/v1` route streams, zips, archives, or returns in one response more than one subject's unmasked identifier values, and no route returns any unmasked identifier value in a list. No "download all", "export subjects", "data dump", "takeout", or CSV/NDJSON bulk endpoint exists. There is no route that returns raw `SourceRecord` content bodies. PII sale, resale, brokerage, and enrichment are out of scope (VG-SCOPE-007); a bulk export route would be the mechanism by which that prohibition is violated, so the mechanism is absent.
2. **No cross-tenant administration route.** Every route executes under the token's tenant with RLS. There is no route accepting a `tenantId` parameter, no "all tenants" mode, no impersonation header, no support-override header, and no super-admin surface under `/v1`. A cross-tenant read returns `404 RESOURCE_NOT_FOUND` (§3.2 item 4). Cross-tenant operations, if any are ever needed, belong to a separately deployed, separately authorized control-plane service with its own specification and its own audit trail — not to this API.
3. **No bypass route.** No route accepts a CAPTCHA/OTP/phone-verification solution, a session cookie, a bearer token for a third-party site, a proxy list, an "undocumented endpoint" URL, a stealth or fingerprint-spoofing option, a `skipVerification` flag, a `force` flag, a `overridePolicy` flag, a `bypassHumanGate` flag, or a truth-state assignment. `HumanGate` is a legitimate step the system must not bypass (VG-SCOPE-003, VG-SCOPE-004, VG-DISC-004). Any request containing such a field is `422 BYPASS_ATTEMPT_REFUSED` (or `422 SCHEMA_VALIDATION_FAILED` under strict parsing), is refused with no state change, and is audited.
4. **No direct truth-state write.** §5.7.4's `requestedTruthState` is a guarded-transition request, not an assignment; `REQUEST_SUBMITTED`, `VERIFIED_REMOVED`, `ACKNOWLEDGED`, `SEARCH_DELISTED`, and `REAPPEARED` are reachable only through their effect or observation routes (SM-6).
5. **No inference route.** No route returns a subject-match probability, a "likely same person" assertion, or a removal prediction. Assessment outcomes are recorded `Confidence` objects with basis, and nothing else (VG-IDENT-004).
6. **No status-renaming route.** No route or query parameter maps a truth state to a friendlier label, and no response includes a `friendlyStatus`, `displayStatus`, `simpleStatus`, or `success` field (§7.3).
7. **No unversioned alias route and no undocumented route.** `/v1` is the whole surface; anything not in §5 or §6 does not exist, and a request to it is `404`.
8. **No route that mutates audit, evidence, or policy history.** Audit is append-only by absence of a mutation surface (VG-EVIDENCE-003); evidence is content-addressed and immutable (VG-EVIDENCE-001); jurisdiction policy is authored out of band (VG-POLICY-001).
9. **No route exposing another tenant's `Controller`, `Source` terms, or provider credentials.** Provider secrets are resolved through the `SecretResolver` port and never appear in any response (VG-SEC-002).
10. **No route that performs a legal determination.** The API records `PolicyDecision` rows resolved from versioned data and returns their fields. It does not state that a removal is legally required, that a refusal is unlawful, or that a jurisdiction's law compels an outcome. Every such question is **counsel-review** territory (`LEGAL_REVIEW_REQUIRED.md`, SPEC-000 §11) and is routed to `HUMAN_REQUIRED` or recorded as `NOT_REMOVABLE` with its basis.

---

## 11. Requirement catalogue — `VG-API-*`

Each requirement has exactly one acceptance oracle and exactly one required
negative case (DOD-001, DOD-008, DOD-014). "Serves" names the SPEC-000
requirements this API requirement implements at the boundary. A `VG-API-*` row is
satisfied only by executed evidence from the current candidate epoch, on the
public interface, with the artifact digest recorded (SPEC-000 §9).

### 11.1 Conventions

| ID | Requirement | Acceptance oracle | Required negative case | Serves |
|---|---|---|---|---|
| VG-API-001 | All routes live under the `/v1` base path; the major version is a path segment; no unversioned alias route exists. | A request to an unversioned path returns `404`; every documented route resolves under `/v1`; an OpenAPI document generated from the route registry lists no path outside `/v1`. | A request to `/subjects` (unversioned) returns `404` and creates no resource. |
| VG-API-002 | Every response is `application/json; charset=utf-8` except evidence content download; every request with a body is JSON except multipart upload. | Content-Type assertions pass across the route catalogue; a JSON request to the multipart upload route is rejected. | A request with `Content-Type: text/plain` carrying a JSON body is refused `415 UNSUPPORTED_MEDIA_TYPE` with no state change. |
| VG-API-003 | `X-Request-Id` and `correlationId` are present on every response and on every `AuditEvent` produced by the request. | A request with a supplied `X-Request-Id` echoes it verbatim; the response's `correlationId` is resolvable to the audit rows for the operation. | A malformed `X-Request-Id` is replaced, not echoed, and the request still carries a resolvable `correlationId`. |
| VG-API-004 | The token tenant binding comes only from the validated `tenant_id` claim and is never accepted from a body, query, or path parameter; it is propagated to RLS as `SET LOCAL app.tenant_id`. | A body/query containing `tenantId` or `tenant_id` is rejected by strict schema validation; the RLS session variable equals the token's `tenant_id` on every request. | A request whose body names a different tenant does not read or write that tenant's rows. |
| VG-API-005 | All collections use cursor pagination with an opaque, tenant-bound, HMAC-signed cursor; no route offers offset pagination. | Any collection route accepts `limit`+`cursor` and returns `page.nextCursor`; a walk of all pages yields each row exactly once with no duplicates. | A cursor issued for tenant A presented under tenant B's token returns `400 INVALID_CURSOR`, not rows. |
| VG-API-006 | Filtering is explicit and strict; unknown query parameters, unknown `truthState` tokens, and over-broad filter sets are rejected rather than ignored. | Each documented filter narrows the result set as specified; the applied default is echoed in `page.filter`. | `?truthState=DONE` returns `400 INVALID_TRUTH_STATE` and `?limitt=5` returns `400 UNKNOWN_QUERY_PARAMETER`. |
| VG-API-007 | Sorting is allowlisted per route, single-field, and never a PII field. | Each route's documented sort fields are accepted and produce a correctly ordered page; all others are refused. | `?sort=identifierValue:asc` returns `400 INVALID_SORT_FIELD`. |
| VG-API-008 | Rate limits are enforced per tenant and per `(tenant, sourceId)` for discovery, with `RateLimit-*` headers on every response. | Under a configured limit, calls are served and headers report decreasing remaining budget; at the limit the call is refused client-side. | A burst above the configured per-source limit is refused `429 RATE_LIMITED` with `Retry-After` and produces no discovery request to the source (VG-DISC-003 negative case). |
| VG-API-009 | ETag-based optimistic concurrency is enforced on case-scoped mutations: `If-Match` required, `412` on stale, `428` on absent. | Two concurrent requests with the same `If-Match` produce exactly one success and one `412`; a stale-token request leaves state unchanged. | Two concurrent T5 requests with the same ETag do not both succeed. |

### 11.2 Authentication and authorization at the boundary

| ID | Requirement | Acceptance oracle | Required negative case | Serves |
|---|---|---|---|---|
| VG-API-010 | Every `/v1` route except the four health/readiness/liveness/startup routes and webhook ingress requires a Keycloak OIDC bearer token validated on signature, `iss`, `aud`, `exp`, `nbf`, and `azp`. | A valid token is accepted and a token with any single invalid claim is rejected with the mapped `401` code. | A token with a valid signature but the wrong `aud` returns `401 TOKEN_AUDIENCE_MISMATCH` and performs no work. |
| VG-API-011 | A token missing `tenant_id` or `roles` is rejected; absent claims are never interpreted as empty authorization. | A token lacking `tenant_id` is refused and no RLS session is opened. | A token with no `roles` claim cannot read any subject (`401 TOKEN_INVALID_CLAIMS`), rather than being treated as a read-only caller. |
| VG-API-012 | Cross-tenant access returns `404 RESOURCE_NOT_FOUND` with a body byte-identical to a genuinely absent resource, never `403`, disclosing no existence information or timing differential. | A resource owned by another tenant returns `404` with an identical body to a genuinely absent resource. | Tenant B requesting tenant A's `caseId` receives `404`, not `403` and not an empty-but-distinguishable response (SPEC-005 `VG-AUTH-027` negative case). |
| VG-API-013 | Service-layer authorization and PostgreSQL RLS both independently reject the same unauthorized access. | With RLS enabled, the role/scope check alone and RLS alone each reject the access; disabling either in a test harness still yields a rejection. | A cross-tenant query executed with a valid token returns zero rows at the database layer independent of the API-layer check, under a connection role lacking `BYPASSRLS` (SPEC-002 RLS-4). |
| VG-API-014 | Every route names a required SPEC-005 role set and a required scope set from the closed §3.3 vocabulary; both are evaluated; a token with a `*` scope is refused. | A route-by-route authorization matrix is generated and matches §3.3 and the SPEC-005 §5 matrix; a token holding only the required roles and scopes succeeds and no surplus privilege is needed. | A token whose scope string is `*` returns `401 TOKEN_SCOPE_WILDCARD_FORBIDDEN` on every route, and a role membership without the required effect-bearing scope cannot execute an `ExternalAction` (SPEC-005 `VG-AUTHZ-015` negative case). |
| VG-API-015 | Step-up re-authentication within the SPEC-005 §6 5-minute window is required for authority mint/revocation, external action execution, certified mail, escalation, identifier reveal, evidence content download, and source/recipe changes. | With a fresh step-up, each listed route proceeds; the audit row records the step-up event. | A token at the base authentication level, or one whose step-up is older than 5 minutes, attempting §5.8.2 returns `403 STEP_UP_REQUIRED` and produces no external effect (SPEC-005 `VG-AUTH-026` negative case). |
| VG-API-016 | Machine/agent tokens have a distinct audience, carry an explicit role or scope set, and are refused the human-authority and PII scopes. | An MCP-audience token is accepted on MCP-exposed routes and refused on portal-only routes. | An MCP token attempting `POST /v1/subjects/{subjectId}/authority-grants` is refused `403 INSUFFICIENT_ROLE` (or `401` on audience) and creates no grant (SPEC-005 `VG-AUTH-029` negative case). |
| VG-API-017 | `TENANT_ADMIN` may not mint or approve an `AuthorityGrant` it owns; the API refuses and names the separation-of-duties rule, and no impersonation of `SUBJECT_USER` is possible by any header, query parameter, or claim. | A second authorized human or counsel completes the mint; the audit row records both identities. | An admin self-mint returns `403 SEPARATION_OF_DUTIES` and creates no grant, and an impersonation header is rejected as an unknown header (SPEC-005 `VG-AUTHZ-016`, `VG-AUTH-023` negative cases). |

### 11.3 Idempotency

| ID | Requirement | Acceptance oracle | Required negative case | Serves |
|---|---|---|---|---|
| VG-API-018 | Every state-changing route that can produce an external effect requires an `Idempotency-Key`; absence is refused before any work. | The §5 route catalogue marks each such route **Required**/**Required-if-effect**, and a generated matrix shows no effect-bearing route accepts a key-less call. | `POST /v1/cases/{caseId}/external-actions` without `Idempotency-Key` returns `400 IDEMPOTENCY_KEY_REQUIRED` and produces zero external effects. |
| VG-API-019 | A replayed key with an identical body fingerprint returns the stored original status and body with `Idempotency-Replayed: true`, and produces exactly one external effect. | Two identical §5.8.2 calls with the same key yield one `ExternalAction` row and identical bodies; the effect count is one. | A replayed submission produces no second mail piece or form submission (VG-ACTION-001 negative case). |
| VG-API-020 | Reusing a key with a different body fingerprint, or while the original is in flight, is refused with `409` and no new effect. | Same key + mutated body returns `409 IDEMPOTENCY_KEY_REUSE` carrying the original resource ID; a concurrent duplicate returns `409 IDEMPOTENCY_IN_FLIGHT` with `Retry-After`. | A mutated-body replay produces no second effect and does not overwrite the stored response. |
| VG-API-021 | A replayed 2xx is never counted as a new effect anywhere in metrics, coverage, or exports. | The effect counter counts distinct `(caseId, idempotencyKey)` pairs; a replay leaves every counter unchanged. | Replaying a `201` from §5.8.2 does not increment `actionCount` on the case or any coverage numerator. |
| VG-API-022 | Ambiguous external outcomes surface as `AMBIGUOUS` with `reconciliationRequired: true`, never as success, never as an automatic retry. | A simulated channel timeout yields `202` with `actionOutcome: "AMBIGUOUS"` and no truth-state change; §5.8.3 resolves it. | A simulated timeout produces no automatic second external effect (VG-ACTION-002 negative case). |

### 11.4 Route catalogue behaviour

| ID | Requirement | Acceptance oracle | Required negative case | Serves |
|---|---|---|---|---|
| VG-API-023 | `POST /v1/subjects` rejects any creation whose `AuthorityGrant` is absent, expired, revoked, or unsupported by evidence, and creates no subject row. | With a valid grant, a subject is created and its `authorityGrantId` is returned; the audit row records the grant used. | A forged or expired grant yields `422 AUTHORITY_GRANT_INVALID` and zero `ProtectedSubject` rows (VG-IDENT-001 negative case). |
| VG-API-024 | `POST /v1/subjects/{subjectId}/aliases` quarantines an alias that matches more than one subject instead of attaching it. | An unambiguous alias returns `201` with `quarantined: false`; an ambiguous alias returns `202` with `quarantined: true` and candidate subject IDs. | An alias matching two subjects is never auto-attached to either (VG-IDENT-002 negative case). |
| VG-API-025 | `POST /v1/subjects/{subjectId}/identifiers` stores the value encrypted and returns only a masked form; the plaintext never appears in a response, log, metric label, or audit field. | A created identifier returns `valueMasked` and no `value`; the stored row is encrypted; a log/telemetry scan for the seeded plaintext finds nothing. | A request whose identifier plaintext is seeded as a canary must not appear in the response body, any log line, or emitted telemetry. |
| VG-API-026 | `POST /v1/authority-grants/{authorityGrantId}/revocations` takes effect at execution time: an in-flight case whose grant is revoked cannot execute an external action. | After revocation, §5.8.2 on the case returns `409 AUTHORITY_REVOKED` with no external effect, and the case's subsequent transition is recorded with a basis. | Revoking a grant after `REQUEST_READY` yields no external write (VG-AUTHZ-001 negative case). |
| VG-API-027 | Only a `WRITE_PERMITTED` and fresh `Source` with a signed, fresh, enabled `RemovalRecipe` reports `writesEnabled: true`; `WRITE_UNCLEAR` never does. | For a `WRITE_PERMITTED` source with a fresh signed enabled recipe, `writesEnabled` is `true`; any guard false makes it `false` with a named `disabledReason`. | A `WRITE_UNCLEAR` source reports `writesEnabled: false` with no request parameter able to change it (VG-CHANNEL-002, ADR-003). |
| VG-API-028 | `POST /v1/sources/{sourceId}/recipes` verifies the recipe signature before persisting and creates the version disabled. | A correctly signed recipe is stored with `signatureVerified: true` and `enabled: false`; the signature is verified before the row exists. | A tampered or unsigned recipe yields `422 RECIPE_SIGNATURE_INVALID` and no recipe row (VG-CHANNEL-003 negative case). |
| VG-API-029 | `POST /v1/recipes/{recipeId}/enablement` refuses to enable unless every guard passes, and never silently enables. | With all guards true, `enabled` becomes `true` and `guardEvaluation` is returned; with any guard false, `409 RECIPE_GUARD_FAILED` names it and `enabled` stays false. | Enabling a stale recipe returns `409 RECIPE_GUARD_FAILED` and the recipe remains unable to write. |
| VG-API-030 | `POST /v1/discovery-runs` accepts `READ_ONLY` only and never initiates a write path. | A `READ_ONLY` run is accepted and performs no write; the discovery actor holds no write capability. | A run request with any write mode returns `422 DISCOVERY_MODE_FORBIDDEN` and issues no write (VG-DISC-001 negative case). |
| VG-API-031 | `GET /v1/discovery-runs/{discoveryRunId}` always reports attempted, succeeded, and skipped sources with reasons, plus coverage bounds. | `sourcesDeclared = sourcesAttempted + skipped`, every skipped entry names a reason, and `coverageBounds.complete` is `false` whenever any source is skipped. | A run that skipped sources cannot return a report with an empty `sourcesSkipped` or with `complete: true`. |
| VG-API-032 | `GET /v1/subjects/{subjectId}/candidate-records` returns candidate records only, with `assessmentState: "UNASSESSED"` and no `exposureId` for search-class sources. | A search-class record appears with `assessmentState: "UNASSESSED"` and `exposureId: null`; a confirmed exposure has a non-null `exposureId`. | A name-only search collision cannot be returned from this route in a state that reaches `MATCH_CONFIRMED` (VG-IDENT-004 negative case). |
| VG-API-033 | Every discovery-derived listing carries coverage bounds; a partial result set cannot present as absence. | Any response containing discovery-derived rows includes `coverage` with `sourcesAttempted`, `sourcesTotal`, and `complete`. | With 3 of 12 sources skipped, the response cannot omit `coverage` and cannot state absence unqualified (VG-DISC-002 negative case). |
| VG-API-034 | `POST /v1/exposures/{exposureId}/match-assessments` requires a non-empty `confidence.basis` and drives T3 only above the policy threshold. | A basis-bearing score above threshold returns `truthState: "MATCH_CONFIRMED"`; below threshold returns `DISCOVERED_CANDIDATE` with `belowThreshold: true` and no transition. | A score with an empty or absent `basis` returns `422 CONFIDENCE_BASIS_REQUIRED` and no transition (VG-IDENT-003 negative case). |
| VG-API-035 | `POST /v1/exposures/{exposureId}/disproofs` requires complete-enough coverage before it can produce `VERIFIED_NOT_PRESENT`. | With `scanComplete: true` and full coverage bounds, the exposure reaches `VERIFIED_NOT_PRESENT` with bounds recorded. | With partial coverage the request returns `422 COVERAGE_BOUNDS_REQUIRED` and the state is unchanged (SPEC-000 §5.1 negative case). |
| VG-API-036 | `POST /v1/cases/{caseId}/policy-decisions` returns a decision containing all four of `jurisdiction`, `legalBasis`, `channel`, `policyVersion`, and refuses any decision missing one. | A resolvable request returns a complete decision; a generated schema check shows all four fields mandatory. | A request that cannot resolve a complete decision is refused and the case does not progress past `MATCH_CONFIRMED` (VG-POLICY-002 negative case). |
| VG-API-037 | The API rejects a caller- or model-asserted `legalBasis` that has no matching row in the policy version in force. | A basis present in the in-force version resolves; the response cites the version. | A model-suggested basis with no matching policy row returns `422 LEGAL_BASIS_NOT_IN_POLICY_VERSION` and creates no decision (VG-POLICY-001 negative case). |
| VG-API-038 | A channel that outranks the requested channel cannot be skipped without a recorded unavailability reason. | A resolution that records each higher-priority channel as unavailable with a reason succeeds; the reasons are returned in `reasons[]`. | Requesting a lower-priority channel while a lawful higher-priority one is available and unrecorded returns `422 CHANNEL_PRIORITY_VIOLATION` (VG-CHANNEL-001 negative case). |
| VG-API-039 | `POST /v1/cases` refuses a case whose `PolicyDecision` is incomplete or whose `AuthorityGrant` scope is insufficient, and never creates a case at a state above the exposure's current state. | A fully-provisioned creation returns `truthState` equal to the exposure's current state and never `REQUEST_READY`. | Creating a case with a decision missing `legalBasis` returns `422 POLICY_DECISION_INCOMPLETE` and creates no case. |
| VG-API-040 | `PATCH /v1/cases/{caseId}` accepts only transitions listed in SPEC-001 §4.1, evaluates every listed guard inside the transaction, and refuses `REQUEST_SUBMITTED` as a target. | A legal guarded request returns the new `truthState`, the `transitionCode`, and the evaluated guards; the state is persisted and audit-appended. | `REQUEST_SUBMITTED` as `requestedTruthState` returns `422 TRANSITION_NOT_ROUTEABLE`; any transition outside §4.1 returns `409 ILLEGAL_TRANSITION` and leaves state unchanged. |
| VG-API-041 | `POST /v1/cases/{caseId}/human-gates` produces `HUMAN_REQUIRED` as a `200` first-class result, refuses any bypass attempt, and is excluded from failure metrics. | A gate record returns `200` with `truthState: "HUMAN_REQUIRED"`; the effectiveness metric counts it under `excludedFromNumerator.humanRequired`. | A request carrying `attemptedBypass: true` (or any bypass artefact field) returns `422 BYPASS_ATTEMPT_REFUSED` with no solver invoked (VG-DISC-004 negative case). |
| VG-API-042 | `POST /v1/cases/{caseId}/external-actions` refuses unless the case is `REQUEST_READY` with valid authority, a complete decision, a fresh signed enabled recipe, and available budget. | With all guards satisfied the action is created and the case reaches `REQUEST_SUBMITTED` with transition code `T8`. | From `MATCH_CONFIRMED`, the call returns `409 ILLEGAL_TRANSITION` and produces no external effect (SPEC-001 §4.2 `MATCH_CONFIRMED` → `REQUEST_SUBMITTED` negative case). |
| VG-API-043 | Exceeding a write effect budget refuses the action, records the attempt, and names the exhausted dimension. | Under budget, the action proceeds; at the limit, `409 EFFECT_BUDGET_EXCEEDED` carries dimension, limit, used, and window. | An unbounded retry loop is capped: after the configured limit every further attempt is refused and audited (VG-ACTION-005 negative case). |
| VG-API-044 | `POST /v1/external-actions/{externalActionId}/readback` requires an observation path distinct from the acting path. | A request naming a distinct `observationMethod` yields `202` with `readbackState: "PENDING"`. | A readback request naming the acting path or identity returns `422 OBSERVATION_PATH_NOT_INDEPENDENT` (VG-ACTION-003, VG-VERIFY-001 negative case). |
| VG-API-045 | `POST /v1/cases/{caseId}/controller-responses` records a claim and can reach `ACKNOWLEDGED` but never `VERIFIED_REMOVED`, and marks `claimedOutcomeIsObservation: false`. | A `CLAIMED_DELETION` response returns `truthState: "ACKNOWLEDGED"` with `verificationRequired: true`. | A controller claiming deletion with no observation yields `ACKNOWLEDGED`, not `VERIFIED_REMOVED` (VG-VERIFY-004 negative case, SPEC-000 §5.1). |
| VG-API-046 | `POST /v1/cases/{caseId}/verification-observations` refuses a same-path or same-identity observation, an unmet window, and a method mismatch, and produces `VERIFIED_REMOVED` only when all hold. | With a distinct path, the required window elapsed, and the recipe's method matched, the case reaches `VERIFIED_REMOVED` with transition code `T14`. | Re-using the acting session's own client returns `422 OBSERVATION_PATH_NOT_INDEPENDENT` (VG-VERIFY-001 negative case). |
| VG-API-047 | The observation window is enforced from recorded timestamps and the recipe's declared method must match the observation. | `windowSatisfied.elapsedSeconds ≥ requiredSeconds` is required and echoed; the recipe's `verificationMethod` equals the supplied `observationMethod`. | An immediate same-second recheck returns `422 OBSERVATION_WINDOW_NOT_MET`, and a method mismatch returns `422 OBSERVATION_METHOD_MISMATCH` (VG-VERIFY-002/003 negative cases). |
| VG-API-048 | A failed verification leaves the case in an honest non-success state and reports `verificationFailed: true`. | A `RECORD_PRESENT` observation returns `200` with `truthStateAfter: "ACKNOWLEDGED"` and `transitionCode: null`. | A failed verification never advances the case to `VERIFIED_REMOVED` or any success state (VG-VERIFY-004 negative case). |
| VG-API-049 | `POST /v1/exposures/{exposureId}/reappearances` requires a prior `VERIFIED_REMOVED` event and links to it; a first-ever discovery is never labelled `REAPPEARED`. | With a valid `priorRemovedEventId`, the exposure reaches `REAPPEARED` via `T17` and `reentry` states the fresh-grant/decision/recipe requirement. | A first-ever discovery submitted as a reappearance returns `409 REAPPEARANCE_WITHOUT_PRIOR_REMOVAL` (VG-REAPPEAR-001 negative case). |
| VG-API-050 | Reappearance re-entry preserves prior evidence and requires a new `ExternalAction` with a new `IdempotencyKey`; no route overwrites history. | After re-entry, prior evidence artifacts, transitions, and the original action remain readable and unmodified; the new attempt is a distinct `ExternalAction`. | A re-entry attempt that reuses the original `IdempotencyKey` produces no second effect, and no route mutates prior evidence (VG-REAPPEAR-002 negative case). |
| VG-API-051 | `POST /v1/evidence-artifacts` recomputes SHA-256 over the received bytes, compares to the supplied digest, and stores immutably only on match. | A matching digest returns `201` with `digestVerified: true`; a fresh integrity check reproduces the same digest. | A tampered artifact upload returns `422 EVIDENCE_DIGEST_MISMATCH` and creates no artifact row (VG-EVIDENCE-001 negative case). |
| VG-API-052 | Evidence artifacts are content-addressed and immutable: no route updates, replaces, or deletes artifact content; a digest mismatch on read fails loudly. | No `PATCH`/`PUT`/`DELETE` evidence route exists in the generated route registry; §5.12.4 returns `VERIFIED` for an intact artifact. | An artifact whose stored bytes are altered returns `409 EVIDENCE_INTEGRITY_FAILURE` on read and is never served (VG-EVIDENCE-001 negative case). |
| VG-API-053 | Artifact metadata exposes requirement → case → artifact → digest traceability that resolves to a stored hash; a dangling reference is refused. | Every `linkedTraceability` reference resolves to an existing artifact row with a matching digest. | An artifact link pointing at a non-existent artifact or a mismatched digest fails validation and the claim is rejected (VG-EVIDENCE-002 negative case). |
| VG-API-054 | Deadlines record the policy version and rule code they were derived from; no deadline duration is hard-coded in the API. | Every deadline DTO carries `derivedFrom.policyVersion` and `derivedFrom.ruleCode`, both resolvable. | A deadline created without provenance fails validation and is not persisted. |
| VG-API-055 | `POST /v1/cases/{caseId}/appeal-escalations` requires human/counsel review, refuses to be sendable while review is pending, and creates no external effect. | Creation returns `201` with `requiresHumanReview: true`, `reviewState: "PENDING_COUNSEL_REVIEW"`, and `externalEffect: false`. | Creating an escalation produces no external effect, and a body asserting `requiresHumanReview: false` for a review-mandating kind returns `422 HUMAN_REVIEW_REQUIRED` (VG-CHANNEL-001 #7 negative case). |
| VG-API-056 | `GET /v1/audit-events` requires an explicit bounded time range, returns append-only rows, and exposes no mutation route. | A bounded query returns rows that join to the originating requests by `correlationId`; the route registry contains no audit write route. | An unbounded audit query returns `400 TIME_RANGE_REQUIRED`, and any `PATCH`/`DELETE` on an audit path returns `404` with the row unchanged (VG-EVIDENCE-003 negative case). |
| VG-API-057 | `GET /v1/coverage-reports/{coverageReportId}` names the unchecked remainder and refuses to report absence from partial coverage. | For 74 attempted of 118 declared, the report returns `sourcesSkipped`, a non-empty `uncheckedRemainder`, `checkedFraction`, and `complete: false`. | A partial report cannot return an empty `uncheckedRemainder` or a `complete: true` claim (VG-DISC-002 negative case). |
| VG-API-058 | `GET /v1/metrics/removal-effectiveness` returns independently verified removals over eligible confirmed matches with numerator, denominator, interval, and confidence interval, and refuses a request without a time range. | The response contains `verifiedRemovedNumerator`, `eligibleConfirmedMatchDenominator`, `ratio`, `confidenceInterval`, and `interval`; the denominator definition is stated. | A request without `from`/`to` returns `400 TIME_RANGE_REQUIRED`, and no response anywhere reports a requests-sent or permanent-deletion figure as a removal metric (VG-OBS-002 negative case). |
| VG-API-059 | No API response collapses or renames a truth state: `truthState` values are the exact SPEC-000 §5 tokens, with no derived boolean or friendlier label. | A generated schema scan of every response DTO finds `truthState` typed as the closed eleven-member enum and finds no `removed`/`isRemoved`/`success`/`friendlyStatus` field. | A case at `REQUEST_SUBMITTED` returns `truthState: "REQUEST_SUBMITTED"`; no field in that response marks it as removed (SPEC-000 §5.1 negative case). |
| VG-API-060 | `GET /v1/health`, `/v1/ready`, `/v1/live`, and `/v1/startup` reflect real dependency state, require no bearer token, and are the only unauthenticated routes. | With all dependencies reachable, health is `HEALTHY`, readiness `READY`, liveness `ALIVE`, and startup `STARTED`; all four routes work without `Authorization`. | With a required dependency induced to fail, readiness returns `503` with the failed check named — a static `200` fails acceptance (VG-OPS-001 negative case). |

### 11.5 Webhook ingress

| ID | Requirement | Acceptance oracle | Required negative case | Serves |
|---|---|---|---|---|
| VG-API-061 | Every webhook route verifies an HMAC-SHA256 signature over the raw bytes covering timestamp, nonce, and body, with a resolved trusted key, before any parsing or dispatch. | A correctly signed delivery is accepted `202`; the signature is verified against the unparsed raw bytes and the verification is audited. | A delivery with an invalid signature returns `401 WEBHOOK_SIGNATURE_INVALID` and performs no state change or dispatch. |
| VG-API-062 | Webhook replay is rejected deterministically: timestamp window enforced, nonce single-use, event ID idempotent. | A first delivery succeeds; an out-of-window delivery is refused; the stored response is returned for a repeated event ID with `X-VG-Webhook-Replayed: true`. | A byte-identical replay with the same nonce returns `409 WEBHOOK_NONCE_REPLAY` exactly once and applies no second state change (VG-SEC-004 negative case). |
| VG-API-063 | Webhook processing is idempotent and never sets a truth state directly; it dispatches exactly one domain command. | A callback produces exactly one `ControllerResponse` and one `AuditEvent`; the resulting transition, if any, carries a `transitionCode`. | Two deliveries of the same event produce one `ControllerResponse`, not two (VG-ACTION-001 negative case at the ingress). |
| VG-API-064 | Webhook bodies are tainted input: control fields are ignored and audited, and cannot select a channel, author a basis, enable a recipe, or execute an action. | A clean callback records a response; the audit shows the dispatched command. | A callback body containing `legalBasis`, `channel`, `truthState`, or `budgetOverride` has those fields ignored, an `IGNORED_CONTROL_FIELD` audit row written, and no policy, recipe, or action change (VG-SEC-001 negative case). |
| VG-API-065 | A provider or mail-tracking callback records a transport/delivery fact and never satisfies independent verification or alone produces `ACKNOWLEDGED`. | `POST /v1/webhooks/provider-callbacks/{providerKeyId}` returns `truthStateChanged: false`; mail tracking updates only `MailPiece.deliveryStatus` and its evidence. | A `SUBMISSION_ACCEPTED` provider callback does not produce `VERIFIED_REMOVED` and does not satisfy T14 (VG-ACTION-003 negative case). |

### 11.6 Read models, error envelope, MCP, non-goals

| ID | Requirement | Acceptance oracle | Required negative case | Serves |
|---|---|---|---|---|
| VG-API-066 | No list response contains raw PII or unmasked identifier values; masking is the default and unmasking requires an explicit scope plus step-up on a single-subject route. | A generated DTO scan finds every list DTO's identifier fields typed as masked/opaque; `includeValue=true` on a single-subject route with the scope and step-up returns the value and writes an audit row. | A list route scanned with a seeded canary identifier value returns no match on that plaintext, under any scope. |
| VG-API-067 | Identifiers are opaque and no route accepts PII as a path parameter, query parameter, or sort field. | Every path parameter and sort field is an opaque ID or an allowlisted non-PII field. | `?sort=<alias value>` and a path containing a subject name both return `400`. |
| VG-API-068 | No response field, query parameter, or path segment uses a forbidden synonym from SPEC-000 §4 as a production identifier, with the two HTTP-layer exceptions of §7.3 (`X-Request-Id`, `requestId`) allowed by exact name only. | An automated vocabulary scan over the generated OpenAPI document finds no forbidden token (`request`/`ticket`/`job`/`hit`/`listing`/`scraper`/`bot`/`approval`/`consent`/`success`) in a path or field name, and no `request*` identifier other than the two sanctioned names. | A response DTO introducing `successRate` or `removalConfirmed` fails the vocabulary gate. |
| VG-API-069 | Errors use the single envelope of §8.1 with a stable `code`, a safe `message`, `requestId`, `correlationId`, and code-specific `details`. | Every non-2xx in the contract produces the envelope; `details` validates against its per-code schema. | A non-2xx response without `code` or without `requestId` fails the contract test. |
| VG-API-070 | Error bodies never contain PII, identifier plaintext, secrets, tokens, `IdempotencyKey` values, SQL, internal hostnames, or stack traces. | Error bodies are built from per-code allowlist templates; a canary scan of all error paths finds no seeded PII or secret. | An induced internal fault returns `500 INTERNAL_ERROR` with no exception message, stack trace, or connection string (VG-SEC-002 negative case). |
| VG-API-071 | The HTTP status mapping is stable and documented per code, with `409` reserved for state conflicts and `422` for input/guard validation. | A code-to-status table is generated from the registry and matches §8.2. | Returning `200` with an error body, or `500` for a validation failure, fails the contract test. |
| VG-API-072 | MCP-exposed tools map one-to-one onto `/v1` routes with schema-validated inputs and no widened capability. | Each tool's declared scopes equal or narrow its route's scopes; invalid input is rejected before dispatch. | A tool call with an input violating its schema never reaches the application layer, and no "arbitrary HTTP" or "arbitrary query" tool exists. |
| VG-API-073 | No MCP tool can author a legal basis, create a `PolicyDecision`, grant authority, or enable a recipe, and no write occurs without an existing `PolicyDecision`. | The MCP tool registry contains no such tool; §5.8.2 refuses without a `policyDecisionId`. | A tool call attempting to supply a model-authored `legalBasis` returns `422 LEGAL_BASIS_NOT_AUTHORABLE` and creates no decision (VG-POLICY-001 negative case). |
| VG-API-074 | Effect-bearing agent calls are bounded per token, subject, source, and window, and every effect call is audited with its budget consumption. | Under budget, an effect tool call proceeds; the audit row names token identity, tool, target, key fingerprint, and budget used. | An agent loop that exceeds its configured budget is capped: further calls return `409 EFFECT_BUDGET_EXCEEDED` and are audited (VG-ACTION-005 negative case). |
| VG-API-075 | The API exposes no bulk PII export route, no cross-tenant administration route, no bypass route, and no route that assigns a truth state directly. | The generated route registry contains no export, no `tenantId`-parameterized, and no `force`/`skipVerification`/`overridePolicy` route; the vocabulary and route gates pass. | A request to a hypothetical `/v1/subjects/export` returns `404`, a request naming `tenantId` is rejected, and a body with `bypassHumanGate: true` is refused with no state change. |

**Total: 75 requirements** (`VG-API-001` … `VG-API-075`), each with one acceptance oracle and one required negative case.

---

## 12. Acceptance for this specification

This specification is satisfied only when, for the API boundary and using executed
evidence from the current candidate epoch (SPEC-000 §9):

1. A generated route registry and OpenAPI document match §5 and §6 exactly — no
   undocumented route, no route absent from the document.
2. Every `VG-API-*` row in §11 has at least one executed test with recorded
   command, observed sentinel, artifact digest, and evidence path, and its
   required negative case has a separate executed test that fails when the guard
   is removed (DOD-018 mutation requirement).
3. Every §11 row that names a `VG-*` requirement in its `Serves` column is
   traceable to that requirement's own row in `REQUIREMENT_TRACEABILITY.csv`, and
   neither row may be marked passed while the other is unmet.
4. The vocabulary gate (§7.3, VG-API-068) runs over the generated OpenAPI document
   and fails the build on any forbidden token in a path or field name.
5. No endpoint is claimed as implemented until it has a passing, executed
   contract test; until then the endpoint's status is `NOT_IMPLEMENTED`.

**Current implementation status: NOT_IMPLEMENTED.** No route in §5 or §6 has been
built or exercised as of this revision, and no test result or evidence artifact
for any `VG-API-*` requirement exists. Nothing in this document may be cited as
evidence that an endpoint works.

---

## 13. Open items requiring human authority

Recorded honestly; not satisfiable by an agent (SPEC-000 §11).

- **Counsel review required, not asserted here:** whether a given jurisdiction
  supports a given `legalBasis`, the sufficiency of authorized-agent evidence for
  a given channel, California DROP eligibility and timelines, public-record and
  FCRA exemption boundaries, minor-subject lanes, regulator-escalation content and
  addressees, certified-mail templates, and any product claim derived from the
  removal-effectiveness metric. These are recorded in `LEGAL_REVIEW_REQUIRED.md`
  and are `EXTERNAL_REQUIRED` until reviewed. The API resolves them from versioned
  policy data and routes unresolved cases to `HUMAN_REQUIRED` or `NOT_REMOVABLE`;
  it states no legal conclusion of its own (§10 item 10).
- **Provider entitlement and transport permission** are external facts. Where they
  are unverified, the affected `Source` is `WRITE_UNCLEAR` and `writesEnabled` is
  `false` (ADR-003, VG-CHANNEL-002).
- **Named human UAT and assistive-technology validation** of any portal built on
  this contract (DOD-039).
- **Error-taxonomy ownership.** SPEC-006 was authored concurrently with this file
  and adopted §8.1/§8.2 verbatim, registering the reconciliation as its finding
  F-1 and the residual spelling-ownership tension as F-2. §8.4 states this file's
  resolution: SPEC-003 owns the wire codes and statuses, SPEC-006 owns the domain
  classes and their audit/telemetry codes. A human decision confirming that
  division is still required, because two normative files cannot both own the wire
  spelling.

---

## 14. Cross-specification reconciliation record

This specification, SPEC-002, SPEC-005, SPEC-006, and SPEC-007 were authored
concurrently. Where a sibling adopted, deferred to, or conflicted with this file,
the resolution is recorded here so a later reader does not have to rediscover it.
None of these entries is evidence that anything is implemented.

| # | Sibling | Point of contact | Resolution |
|---|---|---|---|
| R-1 | SPEC-005 | This file originally invented camelCase claims (`tenantId`, `scopes`, `authTime`, `acr`) and role names (`vg_analyst`, `vg_operator`, `vg_reviewer`, `vg_auditor`, `vg_tenant_admin`) that did not exist in SPEC-005. | **Corrected in this file.** §3.2 now reads SPEC-005 IDP-4's claims (`tenant_id`, `roles`, `subject_ref`, `auth_level`) and §3.3 names SPEC-005 §2's roles (`SUBJECT_USER`, `GUARDIAN`, `OPERATOR`, `TENANT_ADMIN`, `AUDITOR`, `SUPPORT`, `COUNSEL_REVIEWER`) and maps each scope to them. Step-up now follows SPEC-005 §6 (5-minute window) and §3 requires SPEC-005 §5's role matrix in addition to scopes. SPEC-005 was not modified. |
| R-2 | SPEC-005 | SPEC-005 §3 names the `AGENT`/`PARENT_GUARDIAN`/`LEGAL_REPRESENTATIVE` grant kinds and §4 the `IAL0`–`IAL3` levels; this file's §5.2.1 originally used `GUARDIAN`/`DEPENDENT` kinds and had no identity-level gate. | **Corrected in this file.** §5.2.1 now uses SPEC-005's kind tokens and returns `403 IDENTITY_LEVEL_INSUFFICIENT` when the recorded level is below the required level (VG-API-017). SPEC-005 §3 owns which kind is permitted for which lane; this file owns the error spelling and the status. |
| R-3 | SPEC-006 | SPEC-006 §6.1/§6.2 adopts this file's envelope, code set, and statuses, and registers the residual "who owns the wire spelling" tension as F-2. | **Resolved in this file's §8.4:** SPEC-003 owns wire codes and statuses; SPEC-006 owns domain classes and audit/telemetry codes. SPEC-006's domain-only codes (`NO_LAWFUL_BASIS`, `TAINTED_CONTENT_REJECTED`, `EGRESS_DENIED`, `AMBIGUOUS_EXTERNAL_EFFECT`) are adopted into §8.2 so no domain code lacks a wire spelling. SPEC-006 was not modified; F-2 remains open for a human decision if the division is rejected. |
| R-4 | SPEC-006 | SPEC-006 §7.1's summary column shows `403` for `AUTHORITY_EXPIRED`/`AUTHORITY_MISSING` and `503` for `PERMISSION_CLASS_UNCLEAR`/`RECIPE_STALE`/`RECIPE_UNSIGNED`, while its own §6.2 table — and this file's §8.2, which SPEC-006 declares authoritative — uses `409`. | **This file is the contract.** §8.2 keeps `409` for those codes. SPEC-006 §6.2 already agrees with this file; SPEC-006 §7.1's parenthetical status hints are the inconsistent part and should be corrected there. No behavior is ambiguous, since SPEC-006 F-1 declares §8.2 authoritative on status codes. |
| R-5 | SPEC-006 | SPEC-006 class 12 (`BudgetExceeded`) and §7.1 #20 show `429`, while §6.2 and this file's §8.2 use `409 EFFECT_BUDGET_EXCEEDED`. | **This file is the contract:** `409 EFFECT_BUDGET_EXCEEDED`. `429` remains reserved for request-rate limiting (`RATE_LIMITED`), which is a different control from an effect budget (VG-ACTION-005 versus VG-DISC-003). SPEC-006 §7.1 #20's `429` should be corrected to `409`. |
| R-6 | SPEC-006 | SPEC-006 class 15/§7.1 #25 show `500` for a readback digest mismatch, while §6.2 and this file use `409 EVIDENCE_INTEGRITY_FAILURE`. | **This file is the contract:** `409` for a readback integrity failure, with the artifact quarantined and not served. A digest mismatch is a detected, classified condition with a durable error path, and SPEC-006 H-8 forbids substituting `INTERNAL_ERROR` for a class that has one. SPEC-006 §7.1 #25's `500` should be corrected to `409`. |
| R-7 | SPEC-007 | SPEC-007 §11 proposes `GET /v1/startup` and states that SPEC-003 §5.17 owns the public API surface, so either SPEC-003 adds the route or the conflict resolves in SPEC-003's favour. | **This file adds it.** §5.17.4 now defines `GET /v1/startup` and VG-API-060 covers all four public health routes. SPEC-007's §7 semantics and its `provider-transport` dependency name are adopted by reference. `GET /metrics` remains outside `/v1` and cluster-internal, per SPEC-007. |
| R-8 | SPEC-007 | SPEC-007 §6.3 and §11 adopt this file's §5.16.3 removal-effectiveness denominator and require the API to disclose `acknowledged`, `requestSubmitted`, `searchDelisted`, and `ambiguous` in `excludedFromNumerator`. | **Already consistent.** §5.16.3 returns exactly those four exclusion components plus `notRemovable` and `humanRequired` as first-class disclosures, and VG-API-058 binds them. No change required in either file. |
| R-9 | SPEC-002 | This file's §7.2 originally described opaque mnemonic-prefixed IDs; SPEC-002 §4 fixes every primary key as `uuid DEFAULT gen_random_uuid()`. | **Corrected in this file.** §7.2 now states the canonical `/v1` identifier is the underlying UUID, and that the §5 mnemonic prefixes are documentation-only. SPEC-002 was not modified. |
| R-10 | SPEC-001 | SPEC-001 §4.1 contains no reverse transition, so a reconciliation finding of `EFFECT_ABSENT` cannot regress a case that already reached `REQUEST_SUBMITTED`. | **Handled in this file without amending SPEC-001.** §5.8.3 records the divergence as an audit row and requires review; the case remains at `REQUEST_SUBMITTED` and no state outside `T1`–`T21` is produced. If a `RECONCILING` truth state is ever wanted, it requires a SPEC-000 §5 amendment and a new state-machine row, not an API decision. |
| R-11 | SPEC-000 | SPEC-000 §4 forbids `request`, `success`, `approval`, and `consent` as production identifiers, but the standard HTTP tracing names `X-Request-Id`/`requestId` are unavoidable in practice, and SPEC-005 §2 uses "approve" in role-prohibition prose. | **Recorded, not silently tolerated.** §7.3 now names exactly two sanctioned HTTP-layer exceptions and requires the VG-API-068 vocabulary gate to allow them by exact name only. SPEC-005's prose use is descriptive text, not a `vg.*` identifier or a field name, so it does not breach the vocabulary lock — but a reviewer should confirm that reading, because SPEC-005 §2/§5 also uses "approve" where `VG-AUTHZ-016` means separation of duties. |
| R-12 | SPEC-005 | SPEC-005 §5's matrix is expressed in role × resource terms with subject-relative grants ("W (self)", "R (scoped)"), while this file expresses routes in scope terms. | **Both are required and both are stated.** §3.2 item 6 and the closing paragraph of §3.3 require a route to satisfy role membership **and** scopes **and** the execution-time grant assertion **and** the SPEC-001 §4.1 guard list. A future change to either vocabulary needs a matching change in the other file.
