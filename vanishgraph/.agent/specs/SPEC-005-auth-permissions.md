# SPEC-005 — Authentication, Authority, and Permissions

Status: SPECIFICATION (normative).
Depends on: SPEC-000 (§4 vocabulary, §6 authority requirements), SPEC-001
(`AuthorityGrant`, domain ports), SPEC-002 (RLS).
Conflict resolution: SPEC-000 wins, then SPEC-001, then SPEC-002, then this file.

**This is the specification that prevents VanishGraph from becoming a stalking
tool.** A privacy-removal service is, by construction, a system that accepts
instructions to remove a named person's data from the internet. The only thing
separating that from a harassment instrument is proof of *who is asking* and
*what authority they hold*. Accordingly, `AuthorityGrant` is a first-class,
evidenced entity (SPEC-001 §3.1), not a checkbox.

Requirement prefixes: `VG-AUTH-<NNN>` (authentication, session, roles),
`VG-AUTHZ-<NNN>` is **reserved by SPEC-000** for authority/authorization
semantics — continuing from `VG-AUTHZ-004`.

---

## 1. Identity provider and session model

Keycloak provides OIDC identity (ADR-001, research brief §5). VanishGraph does
not implement its own password store.

- **IDP-1** All interactive access uses OIDC authorization code flow with PKCE.
  Implicit and resource-owner-password flows are prohibited.
- **IDP-2** MFA is **required** for every human account. TOTP or WebAuthn;
  WebAuthn is preferred and required for `TENANT_ADMIN` and `OPERATOR` roles.
- **IDP-3** Access tokens are short-lived (≤15 minutes) and audience-restricted to
  the VanishGraph API. Refresh tokens are rotated, sender-constrained where
  available, and revoked on suspicion.
- **IDP-4** Every token carries `tenant_id`, `roles`, `subject_ref` (the human
  operator, not the `ProtectedSubject`), and `auth_level`. A token lacking
  `tenant_id` is rejected outright — there is no "all tenants" token.
- **IDP-5** Service-to-service calls use short-lived workload identities (mTLS or
  projected service-account tokens). Static long-lived service credentials are
  prohibited except the narrow provider-runner secrets described in §8.
- **IDP-6** Logout, global sign-out, and administrative revocation are real
  operations with executed evidence, not configuration claims.

## 2. Human roles

Roles are assigned per tenant. A user may hold different roles in different
tenants; roles never compose across tenants.

| Role | Purpose | Notably may **not** |
|---|---|---|
| `SUBJECT_USER` | The verified subject managing their own exposure. | Act for another subject; view other tenants; approve agent authority. |
| `GUARDIAN` | Parent/guardian acting for a minor subject. | Act for adults; bypass the minor strict lane. |
| `OPERATOR` | Case worker in the operations console. | Change jurisdiction policy; mint `AuthorityGrant`; delete audit. |
| `TENANT_ADMIN` | Tenant configuration, users, sources, recipes. | Read another tenant; bypass RLS; disable audit; self-approve agent authority. |
| `AUDITOR` | Read-only access to cases, evidence, and audit. | Any write; any state transition. |
| `SUPPORT` | Time-boxed, JIT, break-glass diagnostics. | Bulk PII access; write actions; presence without an active grant. |
| `COUNSEL_REVIEWER` | Approve escalation/regulator packets. | Trigger actions directly; alter evidence. |

- **ROLE-1** Least privilege is enforced at the API boundary **and** by RLS
  (VG-TENANT-002). A role is never the only control.
- **ROLE-2** `SUPPORT` access is just-in-time, time-boxed (≤60 minutes), scoped to
  one tenant, requires a reason string, is MFA+step-up gated, and emits audit
  events on entry, every read of PII-class data, and exit. Standing support
  access is prohibited.
- **ROLE-3** Impersonation of a `SUBJECT_USER` is prohibited. Where support needs
  to see what a subject sees, it uses a redacted diagnostic view, not the
  subject's session.
- **ROLE-4** No role may disable, truncate, or delete `audit_event` (VG-EVIDENCE-003).

## 3. Authority — the core privacy control

An `AuthorityGrant` proves the tenant may act for a `ProtectedSubject`. It is
required before any subject exists (VG-IDENT-001) and re-asserted at the moment
of every external write (VG-AUTHZ-001).

| Kind | Who | Required evidence |
|---|---|---|
| `SELF` | The subject themself. | Completed identity verification at the level required by §4. |
| `AGENT` | A third party acting for the subject. | Signed authorization instrument + agent identity verification + recorded scope. |
| `PARENT_GUARDIAN` | Parent/guardian of a minor. | Evidence of relationship + minor status determination. |
| `LEGAL_REPRESENTATIVE` | Court-appointed representative. | Court instrument, counsel-reviewed before activation. |

- **VG-AUTHZ-004** A grant carries an explicit `scope[]`; an action outside scope
  is refused even if the grant is otherwise valid.
- **VG-AUTHZ-005** Grant expiry and revocation are evaluated at execution time,
  inside the same transaction as the write, not at request-queue time.
- **VG-AUTHZ-006** Revocation is immediate and causes in-flight cases to halt
  before their next external write; already-submitted actions are not retried.
- **VG-AUTHZ-007** One subject may hold multiple grants (e.g. self + agent);
  the most restrictive applicable scope governs any given action.
- **VG-AUTHZ-008** A grant never authorises action against a *different* subject,
  even within the same tenant. Subject binding is exact.
- **VG-AUTHZ-009** Disputed or contested grants move the subject to a review lane
  (`HUMAN_REQUIRED`) rather than proceeding.

### 3.1 Anti-fraudulent-enrollment controls

Fraudulent authorized-agent enrollment is a named threat (research brief §11).

- **VG-AUTHZ-010** Agent enrollment requires document upload, signature
  verification, and a cooling-off period before the first external write.
- **VG-AUTHZ-011** Enrollment velocity limits apply per tenant, per IP class, and
  per payment instrument; anomalies route to review.
- **VG-AUTHZ-012** A subject may contest an agent grant; contesting immediately
  suspends that agent's write capability for that subject.
- **VG-AUTHZ-013** Multiple agents claiming the same subject raise a conflict
  requiring human resolution.
- **VG-AUTHZ-014** Notice is sent to the subject's verified contact channel on
  agent enrollment, so a fraudulent grant is discoverable by the person affected.

## 4. Identity verification levels

Verification strength scales with the consequence of the action. Levels are
recorded on the grant; the policy engine chooses the required level.

| Level | Method | Permits |
|---|---|---|
| `IAL0` | Email possession only. | Creating an account, viewing public marketing. Nothing subject-specific. |
| `IAL1` | Email + phone possession. | Initiating a discovery scan for a self-claimed subject (no writes). |
| `IAL2` | Government-ID document verification + liveness. | `REQUEST_READY` and self-service writes. |
| `IAL3` | `IAL2` + additional proof (knowledge-based or documentary). | Certified mail, regulator escalation, high-risk jurisdictions. |

- **VG-AUTH-001** A write-producing state is unreachable below the level the
  policy requires (VG-AUTHZ-003).
- **VG-AUTH-002** Verification artifacts are `IDENTITY_DOCUMENT` egress class,
  encrypted, access-logged, and crypto-shredded as soon as the decision is
  recorded (SPEC-002 §5).
- **VG-AUTH-003** Verification failures are rate-limited and do not reveal which
  factor failed (no oracle).
- **VG-AUTH-004** Minors follow the guardian lane and never receive `IAL2`
  document upload directly.

## 5. Authorization matrix

Every route is denied by default; access requires an explicit entry. Enforced in
the service layer **and** independently by RLS.

| Resource / action | SUBJECT_USER | GUARDIAN | OPERATOR | TENANT_ADMIN | AUDITOR | COUNSEL |
|---|---|---|---|---|---|---|
| Own subject profile | RW (self) | RW (minor) | R | R | R | R |
| Other subject in tenant | — | — | R (scoped) | R | R | R |
| Other tenant | — | — | — | — | — | — |
| Alias / identifier write | W (self) | W (minor) | — | W | — | — |
| AuthorityGrant mint | — | — | — | W (not self-approve) | — | R |
| AuthorityGrant revoke | W (own) | W (minor's) | — | W | — | — |
| Source / catalogue write | — | — | R | W | R | R |
| RemovalRecipe publish | — | — | — | W (signed only) | R | R |
| Discovery run trigger | W (self) | W (minor) | W | W | — | — |
| Match confirm | — | — | W | W | — | — |
| PolicyDecision write | — | — | — | W (data-only) | R | R |
| ExternalAction execute | — | — | W (gated) | W (gated) | — | — |
| Verification record | — | — | W | W | R | R |
| Evidence read | R (own) | R (minor) | R (case) | R | R | R |
| Evidence delete | — | — | — | — | — | — |
| Audit read | R (own) | R (minor) | R (case) | R | R | R |
| Escalation approve | — | — | — | — | — | W |
| Tenant config | — | — | — | W | R | — |

- **VG-AUTHZ-015** "Gated" write roles still require a valid `AuthorityGrant`, a
  complete `PolicyDecision`, a signed fresh recipe, and an available budget. Role
  membership alone never authorises an external effect.
- **VG-AUTHZ-016** `TENANT_ADMIN` may not approve its own `AuthorityGrant`
  (separation of duties); a second authorised human or counsel is required.
- **VG-AUTHZ-017** Evidence deletion is unavailable to every role; evidence is
  retained per policy and removed only by the retention subsystem (SPEC-002 §5).

## 6. Step-up authentication

Sensitive operations require re-authentication within the last 5 minutes
(`auth_level` claim), regardless of session age:

- Minting or expanding an `AuthorityGrant`.
- Executing or authorising an external write.
- Generating certified mail.
- Approving an escalation or regulator packet.
- Entering `SUPPORT` break-glass.
- Changing tenant policy data, sources, or recipes.

- **VG-AUTH-005** A missing or stale step-up is refused; it is never silently
  downgraded to a lesser verification.

## 7. Machine and agent (MCP) access

Coding/agent transports (research brief §4) and the MCP gateway are powerful and
therefore narrowly scoped.

- **VG-AUTH-006** MCP/agent tools are schema-validated, typed, individually
  authorised, and carry per-tool effect budgets (VG-ACTION-005).
- **VG-AUTH-007** No agent credential can author legal policy, mint authority,
  execute a write without a pre-existing `PolicyDecision`, or approve an
  escalation.
- **VG-AUTH-008** Agent credentials are held by an isolated provider runner and
  are never stored in the application database or copied into tenant scope.
- **VG-AUTH-009** Every agent tool invocation is audited with the invoking
  identity, tool, target, and correlation ID.
- **VG-AUTH-010** Provider transports must be official, documented automation
  surfaces. Cookie/session theft, undocumented endpoints, and consumer
  subscription pooling are prohibited (VG-SCOPE-004, VG-SCOPE-010).

## 8. Secret handling

- **VG-AUTH-011** Secrets live in a dedicated secret manager (or KMS-encrypted
  parameters), never in the application database, repository, container image, or
  logs (VG-SEC-002).
- **VG-AUTH-012** Workload identity is short-lived and automatically rotated;
  static keys require a recorded, time-bounded exception.
- **VG-AUTH-013** Secret access is logged with the accessing workload identity.
- **VG-AUTH-014** A secret-scanning gate runs in CI and on the repository; a
  finding blocks the release.
- **VG-AUTH-015** Provider-runner secrets are isolated per provider and per
  environment; a production runner never holds staging or personal credentials.

## 9. Abuse prevention and rate limits

- **VG-AUTH-016** Per-tenant and per-identity rate limits apply to discovery,
  writes, verification, and evidence reads; a breach is refused client-side and
  audited (VG-ACTION-005).
- **VG-AUTH-017** Subject enumeration is inhibited: responses for a
  non-existent versus unauthorised subject are indistinguishable, and no endpoint
  confirms whether a named person is a customer.
- **VG-AUTH-018** Bulk export of PII is not an available operation for any role
  (SPEC-003 non-goals).
- **VG-AUTH-019** Repeated authorization failures trip progressive lockout and
  alert (SPEC-007 alert catalogue).

## 10. Verification requirements for this specification

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-AUTH-020 | MFA enforced for all human accounts. | Login without a second factor is refused. | Password-only login fails and is audited. |
| VG-AUTH-021 | Tokens lacking `tenant_id` are rejected. | Request with such a token returns 401. | Crafted token returns no data. |
| VG-AUTH-022 | Cross-tenant access denied at both layers. | Service and RLS each independently refuse. | With service check bypassed in test, RLS still returns zero rows. |
| VG-AUTH-023 | Self-approval of authority is impossible. | `TENANT_ADMIN` cannot approve own grant. | Attempt returns a separation-of-duties error. |
| VG-AUTH-024 | Expired/revoked grant halts writes. | Execution-time assertion refuses. | Revoked-during-flight case performs no further write. |
| VG-AUTH-025 | Scope violation refused. | Action outside `scope[]` rejected. | Read-scoped grant cannot write. |
| VG-AUTH-026 | Step-up required and enforced. | Stale `auth_level` refused for sensitive ops. | Sensitive op after 5 minutes fails without re-auth. |
| VG-AUTH-027 | Subject enumeration inhibited. | Nonexistent vs unauthorised indistinguishable. | Timing/response differential test fails the gate. |
| VG-AUTH-028 | `SUPPORT` access is JIT, time-boxed, audited. | Entry/read/exit audit events exist. | Standing access attempt is denied. |
| VG-AUTH-029 | Agent cannot author policy or bypass `PolicyDecision`. | Tool call refused. | Agent-issued write without a decision fails. |
| VG-AUTH-030 | Secrets absent from DB, logs, and images. | Scan and canary tests pass. | Seeded secret never appears in output. |
| VG-AUTH-031 | Evidence deletion unavailable to all roles. | All delete paths refused. | Admin delete attempt fails. |
| VG-AUTH-032 | Agent enrollment notice reaches the subject. | Notice artifact recorded on grant creation. | Enrollment without recorded notice fails acceptance. |

## 11. Open items requiring human authority

- Authorized-agent evidence requirements, minor-handling rules, and the
  acceptability of any particular identity-verification method require counsel
  review before activation (`LEGAL_REVIEW_REQUIRED.md`). This spec defines
  mechanism and control, not legal sufficiency.
- `IAL3` verification vendor selection requires a DPA and security review; it is
  `BLOCKED_CREDENTIALS` until PREFLIGHT is satisfied.
- Named human UAT and accessibility validation of the verification flows are
  `EXTERNAL_REQUIRED` (DOD-039) and cannot be satisfied by automation.
