NODE-META-BEGIN
ID: EP-006
DEPS: EP-005
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/gate-security.sh
VERIFY_SENTINEL: gate-security: ok
GREEN_TAG: green/EP-006
NODE-META-END

# EP-006 — Auth, Security & Permissions

## 1. Purpose / Big Picture

Implement SPEC-005 in full, and with it the control that separates VanishGraph from a
harassment instrument: proof of *who is asking* and *what authority they hold*.

A privacy-removal service is, by construction, a system that accepts instructions to
remove a named person's data from the internet. SPEC-005 §1 states the consequence
plainly, and this node is where it becomes mechanical rather than aspirational:

- **Identity**: Keycloak OIDC authorization-code flow with PKCE, MFA required for every
  human account, WebAuthn required for `TENANT_ADMIN` and `OPERATOR`, ≤15-minute access
  tokens bound to the VanishGraph API audience, and **no token without `tenant_id`** —
  there is no "all tenants" token (IDP-1…IDP-6).
- **Authority**: `AuthorityGrant` is a first-class evidenced entity. It is required
  before a subject exists, re-asserted **at execution time inside the write transaction**
  (not at queue time), scoped explicitly, subject-bound exactly, and revocable
  immediately — with in-flight cases halting before their next external write.
- **Non-bypassability**: least privilege is enforced at the API boundary **and**
  independently by PostgreSQL RLS. A role is never the only control (ROLE-1,
  VG-TENANT-002).
- **No self-approval**: `TENANT_ADMIN` cannot approve its own `AuthorityGrant`
  (VG-AUTHZ-016).
- **Fail closed**: an unreadable grant, an unresolvable clock, a missing secret, an
  unavailable DLP gate, or an unknown source permission class all stop the operation
  rather than proceeding on an assumption (SPEC-006 §7.1).

At the end of this node the negative cases that matter most are executed and green:
**an expired or revoked grant halts writes**, **a scope violation is refused**, and
**cross-tenant access is denied at both layers**.

**Honest boundary, stated before any milestone.** Keycloak is not provisioned.
`PREFLIGHT.md` marks `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`,
`SESSION_SECRET`, and `LOCAL_MODEL_ENDPOINT` as `REQUIRED`, and none exist. Consequences
that this plan states rather than hides:

- Realm creation, client registration, MFA enrolment policy, token-lifetime settings,
  sender-constrained refresh tokens, global sign-out, and administrative revocation are
  **`BLOCKED_CREDENTIALS`** on `KEYCLOAK_*`. They cannot be configured from this
  repository, and no milestone below pretends otherwise.
- What *can* be built and proved without a realm: token verification logic (signature,
  claims, audience, expiry, `auth_level` freshness) exercised against a locally generated
  key pair through the injected JWKS port; the closed scope vocabulary and role matrix;
  the `AuthorityGrant` lifecycle and its guards; step-up enforcement points; JIT support
  access state machine; MCP least privilege and effect budgets; secret resolution
  fail-closed behaviour; SSRF target classification; webhook signature/replay logic; rate
  limit and lockout logic; and the secret/PII scanning gates.
- Real-IdP verification, real-PostgreSQL RLS, real-Valkey replay and rate-limit state,
  and real-KMS secret resolution are recorded as `BLOCKED_CREDENTIALS` /
  `BLOCKED_PREREQUISITE` with the probe command and exit code — never simulated and
  called proof (DOD-010, DOD-020, SPEC-006 §7.2).
- `scripts/security-check.sh` is a loud-fail placeholder unblocked by **this node**, and
  `verify.sh` cannot print `verify: ok` while other nodes' stages remain placeholders.
  See §9 and §13 D1.

## 2. Scope

In scope:

- Keycloak OIDC integration: authorization-code + PKCE flow wiring for the portals,
  token verification against realm JWKS, required-claim enforcement, audience binding per
  client class (portal / service / MCP), refresh rotation hooks, and logout /
  global-sign-out / administrative-revocation call paths.
- MFA policy enforcement: every human account requires a second factor; WebAuthn required
  for `TENANT_ADMIN` and `OPERATOR`; a password-only or factor-less session is refused and
  audited (VG-AUTH-020).
- The closed scope vocabulary of SPEC-003 §3.3 and the SPEC-005 §5 authorization matrix,
  with the seven human roles of SPEC-005 §2 implemented as scope bundles that confer no
  privilege beyond their scopes.
- `AuthorityGrant` minting, verification, revocation, scope evaluation, execution-time
  re-assertion, subject binding, multi-grant restrictiveness, and contested-grant
  handling.
- Anti-fraudulent-enrollment controls: document upload, signature verification, cooling
  period, enrolment velocity limits, subject contest suspension, multi-agent conflict,
  and subject notice.
- Step-up authentication for the six sensitive operation classes of SPEC-005 §6.
- JIT `SUPPORT` break-glass: ≤60 minutes, single-tenant, reason required, MFA+step-up
  gated, entry/read/exit audit, standing access prohibited.
- MCP/agent surface: typed least-privilege tools, per-tool and per-subject/source/token
  effect budgets, agent audit rows, and the prohibition on agent-authored policy,
  authority, or unguarded writes.
- Secret handling: secret-manager/KMS resolution with no database or log persistence,
  short-lived workload identity, access logging, and a secret-scanning gate that blocks
  on a finding.
- SSRF controls on every outbound fetch, plus webhook signature verification and replay
  protection integrated with the EP-004 ingress.
- Per-tenant and per-identity rate limits, progressive lockout on repeated authorization
  failure, subject-enumeration inhibition, and the prohibition on bulk PII export.
- The security negative-test suite, including expired/revoked grant halting writes, scope
  violation refusal, and cross-tenant denial at both layers.
- A real implementation of `scripts/security-check.sh`.
- Additions to `COMMANDS.md` for every new command this node introduces.

## 3. Non-goals

- **No legal sufficiency judgement.** SPEC-005 §11 is explicit: this spec defines
  mechanism and control, not legal sufficiency. Authorized-agent evidence requirements,
  minor-handling rules, and the acceptability of any particular identity-verification
  method require counsel review (`LEGAL_REVIEW_REQUIRED.md`) and remain
  `EXTERNAL_REQUIRED`. No milestone below asserts that a grant is legally sufficient.
- **No identity-verification vendor selection.** `IAL3` requires a DPA and a security
  review and is `BLOCKED_CREDENTIALS` until PREFLIGHT is satisfied (SPEC-005 §11). The
  level is recorded and enforced; the vendor is not chosen here.
- **No permission store.** VanishGraph does not implement a password store (SPEC-005 §1).
- **No new `/v1` route and no route widening.** Routes are EP-004's audit list. This node
  adds middleware, guards, adapters, and configuration — not endpoints.
- **No UI redesign.** EP-005 owns presentation. This node supplies the server-side
  refusal paths the UI renders.
- **No gate weakening and no scanner baseline auto-acceptance.** A secret-scanning
  finding blocks; it is never added to a baseline to make a build pass (SPEC-006 §8 row
  8). No mock may be the sole proof of an integration or production claim (DOD-010).
- **No impersonation of `SUBJECT_USER`** (ROLE-3), and no bulk PII access for `SUPPORT`
  (ROLE-2).
- No production deployment (VG-SCOPE-009, ADR-005).

## 4. Context and Orientation

**Repository reality, as of this plan.** Do not overstate it:

| Element | Real state |
|---|---|
| Auth/security implementation | **Does not exist.** No OIDC adapter, no scope model, no grant service, no middleware, no rate limiter. |
| `src/domain/errors.ts` | Present, with the authority-related typed errors: `AuthorityExpired`, `AuthorityMissing`, `AuthorityScopeViolation`, `PermissionUnclear`, `BudgetExceeded`, `TaintedContentRejected`, `EgressDenied`, `TenantViolation`, `HumanGateRequired`. |
| `src/domain/ports` | **Not implemented.** SPEC-001 §5 declares `SecretResolver`, `EgressGate`, `AuditSink`, `Clock`, `IdGenerator`; no interface file exists. |
| EP-003 (persistence, RLS) | **Largely unstarted.** No schema, no migration, no RLS policy. The second enforcement layer does not exist yet. |
| EP-004 (API) | ExecPlan authored; **not executed.** No `/v1` route exists. |
| `scripts/security-check.sh` | Loud-fail placeholder: `vg_loud_fail 'security check' 'EP-006'`, exits 1. **This node gives it a real implementation.** |
| `scripts/dependency-audit.sh` | Loud-fail placeholder, unblocked by EP-001. |
| Keycloak / KMS / Valkey / object store | Not provisioned. `KEYCLOAK_*`, `SESSION_SECRET`, `LOCAL_MODEL_ENDPOINT`, `VALKEY_URL`, `S3_*` are `REQUIRED` and absent. |
| Secret-scanning gate | **Does not exist.** VG-AUTH-014 requires one that blocks the release; `dependency-audit.sh` is a placeholder and `anti-gaming-scan.py` is not a secret scanner. |

**Cross-cutting reality that shapes the milestones.**

- The domain already refuses illegal moves with typed errors, and `src/domain/errors.ts`
  already classifies `AuthorityExpired`, `AuthorityMissing`, and `AuthorityScopeViolation`
  as `CANDIDATE_FAILURE`. SPEC-006 §5.3 maps those to `409 AUTHORITY_EXPIRED` /
  `409 AUTHORITY_REVOKED` / `409 AUTHORITY_INVALID` / `422 AUTHORITY_GRANT_SCOPE_INSUFFICIENT`.
  This node must keep the domain free of HTTP concerns (SPEC-006 §1.1) and put the wire
  mapping in the EP-004 registry — extending it, never re-spelling it.
- `PermissionClass` is the one place where the SPEC-000 §4 forbidden synonym
  *permission* is legitimately used, because it is a SPEC-001 §2 value object naming a
  `Source` property, not an authority concept. SPEC-006 §12 item 2 records this, and
  SPEC-004 §0.3 allowlists it for the copy gate. Use the token exactly; never use bare
  *permission* to mean an `AuthorityGrant` or a `HumanGate`.
- `AuthorityGrant` `kind` has two vocabularies that must not be mixed: SPEC-005 §3 names
  `SELF`, `AGENT`, `PARENT_GUARDIAN`, `LEGAL_REPRESENTATIVE`; SPEC-003 §5.2.1 shows
  `SELF|AGENT|GUARDIAN|DEPENDENT` as the request enum. This is a recorded ambiguity (§12)
  that must be resolved before M4 codes the enum — the resolution is `AuthorityGrant`-side
  vocabulary being authoritative with an explicit, tested mapping for the wire enum, and
  it must be recorded in the Decision Log, not silently chosen.
- Audience values are not fixed anywhere in the specs read for this plan. SPEC-003 §3.2
  item 3 requires distinct `aud` per client class and §11.2 VG-API-016 requires an MCP
  token to be refused on portal-only routes, but no concrete audience string is given.
  M1 therefore makes this a **discovery step with a template blank** (§12, D1-adjacent)
  rather than an invented constant.

## 5. Files to Read First

Governance and law:

- `AGENTS.md`, `.agent/EXECUTION_RULES.md`, `.agent/PLANS.md`, `.agent/LOOPS.md`,
  `.agent/GRAPH.md`
- `.agent/DONE_LAW.md` — DOD-006, DOD-010, DOD-014, DOD-017, DOD-018, DOD-019, DOD-020,
  DOD-021, DOD-024, DOD-025, DOD-026, DOD-027, DOD-032, DOD-039
- `.agent/state/LEDGER.md`, `.agent/checklists/implementation.md`,
  `.agent/checklists/validation.md`
- `COMMANDS.md`

Specifications:

- `.agent/specs/SPEC-005-auth-permissions.md` — **the whole of it**: §1 identity and
  session model (IDP-1…IDP-6), §2 roles (ROLE-1…ROLE-4), §3 authority and the core
  privacy control (VG-AUTHZ-004…009), §3.1 anti-fraudulent enrollment (VG-AUTHZ-010…014),
  §4 identity verification levels (VG-AUTH-001…004), §5 authorization matrix and
  VG-AUTHZ-015…017, §6 step-up (VG-AUTH-005), §7 machine and MCP access
  (VG-AUTH-006…010), §8 secret handling (VG-AUTH-011…015), §9 abuse prevention
  (VG-AUTH-016…019), §10 verification table (VG-AUTH-020…032), §11 open human items
- `.agent/specs/SPEC-000-product-scope.md` — §4 vocabulary lock, §6.3 authority and
  policy, §6.4 channel and action, §6.6 tenancy/privacy/security, §11 open human items
- `.agent/specs/SPEC-003-api-contracts.md` — §3.2 what the API enforces, §3.3 the closed
  scope vocabulary and role bundles, §9 MCP and agent surface, §10 non-goals
- `.agent/specs/SPEC-006-errors.md` — §2 classification law, §5.3 rows 2/3/4/9/10/12/13/14/16/20,
  §6.2 the code→status→message table, §7.1 the fail-closed matrix (all 25 rows),
  §8 no-masking rules, §9 no-PII-in-errors and the canary method, §10 retry and ladder
- `.agent/specs/SPEC-001-core-domain.md` — §5 ports, §6 commands, §4.3 invariants SM-2/SM-6
- `.agent/specs/SPEC-002-data-model.md` — tenancy, RLS, encryption, retention
- `.agent/specs/SPEC-007-observability.md` — log redaction, metric label restrictions,
  egress classes and DLP
- `.agent/specs/SPEC-008-production-readiness.md` — §9 external gates, §10 no-masking

Existing code and scripts:

- `src/domain/errors.ts` (all authority, egress, taint, tenant, and budget errors),
  `src/domain/values.ts` (`PermissionClass`, `EgressClass`, `DENY_BY_DEFAULT_EGRESS`,
  `permitsAutomatedWrite`), `src/domain/truth-state.ts` (T8 guards `authorityValid`,
  `budgetAvailable`), `src/domain/state-machine.ts`
- `tests/domain/state-machine.test.ts`, `tests/domain/values.test.ts`
- `package.json`, `tsconfig.json`, `tsconfig.build.json`
- `scripts/security-check.sh`, `scripts/verify.sh`, `scripts/import-boundary.sh`,
  `scripts/gate-toolchain.sh`, `scripts/gate-api.sh`, `scripts/gate-ui.sh`,
  `scripts/copy-lint-gate.sh` (if present), `scripts/probes/keycloak.sh`,
  `scripts/probes/valkey_url.sh`, `scripts/probes/database_url.sh`,
  `scripts/lib/loud-fail.sh`
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt`

Project documents:

- `SECURITY.md` (the threat model this node implements against), `PREFLIGHT.md`,
  `.env.example`, `DATA_EGRESS_MATRIX.md`, `TOS_AUTOMATION_MATRIX.md`,
  `LEGAL_REVIEW_REQUIRED.md`, `ENVIRONMENT.md`, `DECISIONS.md`
  (ADR-001, ADR-003 unclear writes are human-only, ADR-004 official provider transports
  only)
- `PROJECT_RESEARCH_BRIEF.md` §4 (provider transports), §5 (isolated provider runners),
  §11 (fraudulent authorized-agent enrolment)
- `.agent/verification/GRAPH.md`,
  `.agent/verification/stage-plans/V-013-dynamic-security-and-domain-packs.md`,
  `.agent/verification/ATOMIC_TEST_FACTORY.md`,
  `.agent/verification/CAPABILITY_MATRIX.md`,
  `.agent/verification/reports/RESIDUAL_RISK_AND_EXTERNAL_GATES.md`

## 6. Expected Changed Files

Created:

- `src/adapters/oidc/**` — realm client, JWKS cache, token verification, logout and
  global-sign-out calls, administrative revocation calls.
- `src/adapters/secrets/**` — secret manager / KMS resolver satisfying the
  `SecretResolver` port, with access logging.
- `src/adapters/coordination/rate-limit.ts` — Valkey-backed per-tenant and per-identity
  counters.
- `src/adapters/ssrf/**` — outbound fetch guard and target classifier.
- `src/application/security/**` — scope catalogue, role bundles, authorization matrix,
  `AuthorityService` (mint/verify/revoke/scope/execution-time assertion), enrollment
  controls, step-up policy, JIT support access service, agent tool policy and effect
  budgets, egress gate binding.
- `src/http/plugins/scope-guard.ts`, `src/http/plugins/step-up.ts`,
  `src/http/plugins/rate-limit.ts`, `src/http/plugins/support-access.ts`,
  `src/http/webhooks/signature.ts` (if EP-004 has not already created it).
- `tests/contract/role-matrix.test.ts`, `tests/contract/authority-grant.test.ts`,
  `tests/contract/step-up.test.ts`, `tests/contract/enrollment-controls.test.ts`,
  `tests/contract/jit-support-access.test.ts`, `tests/contract/mcp-least-privilege.test.ts`,
  `tests/contract/secret-handling.test.ts`, `tests/contract/ssrf-controls.test.ts`,
  `tests/contract/webhook-signature-replay.test.ts`,
  `tests/contract/rate-limit-abuse.test.ts`, `tests/security/negative-cases.test.ts`.
- `tests/fixtures/local-oidc/**` — a locally generated key pair and signing helper used
  only to exercise verification logic. Never a production code path.
- `scripts/secret-scan.sh` — the VG-AUTH-014 secret-scanning gate.
- `scripts/gate-security.sh` — this node's gate.
- `.agent/evidence/EP-006/**`.

Modified:

- `package.json`, `package-lock.json` — pinned `jose` (or the EP-004 choice),
  `@aws-sdk/client-kms` or the selected secret-manager client, and the secret scanner.
- `scripts/security-check.sh` — real implementation replacing the loud-fail placeholder.
- `scripts/import-boundary.sh` — add the rules for the new adapters and application
  modules.
- `src/http/errors/code-registry.ts` — extend only if SPEC-006 §6.2 requires a code not
  yet present; never re-spell a code.
- `COMMANDS.md` — every command this node introduces, with its sentinel.
- `ARCHITECTURE.md`, `SECURITY.md`, `ASSUMPTIONS.md`, `ENVIRONMENT.md`.
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt`.
- `.agent/state/LEDGER.md`.

Nothing else may change. Any other diff is a scope violation.

## 7. Interfaces and Contracts

**Identity and session (SPEC-005 §1).** OIDC authorization code flow with PKCE only —
implicit and resource-owner-password flows are prohibited. MFA is required for every
human account (TOTP or WebAuthn; WebAuthn required for `TENANT_ADMIN` and `OPERATOR`).
Access tokens are short-lived (≤15 minutes) and audience-restricted to the VanishGraph
API. Refresh tokens are rotated, sender-constrained where available, and revoked on
suspicion. Every token carries `tenant_id`, `roles`, `subject_ref` (the human operator,
never a `ProtectedSubject`), and `auth_level`; a token lacking `tenant_id` is rejected
outright. Service-to-service calls use short-lived workload identities (mTLS or projected
service-account tokens); static long-lived service credentials are prohibited except the
narrow provider-runner secrets of §8. Logout, global sign-out, and administrative
revocation are real operations with executed evidence, not configuration claims.

**Roles (SPEC-005 §2).** Assigned per tenant; roles never compose across tenants.

| Role | Purpose | Notably may **not** |
|---|---|---|
| `SUBJECT_USER` | The verified subject managing their own exposure. | Act for another subject; view other tenants; approve agent authority. |
| `GUARDIAN` | Parent/guardian acting for a minor subject. | Act for adults; bypass the minor strict lane. |
| `OPERATOR` | Case worker in the operations console. | Change jurisdiction policy; mint `AuthorityGrant`; delete audit. |
| `TENANT_ADMIN` | Tenant configuration, users, sources, recipes. | Read another tenant; bypass RLS; disable audit; self-approve agent authority. |
| `AUDITOR` | Read-only access to cases, evidence, and audit. | Any write; any state transition. |
| `SUPPORT` | Time-boxed, JIT, break-glass diagnostics. | Bulk PII access; write actions; presence without an active grant. |
| `COUNSEL_REVIEWER` | Approve escalation/regulator packets. | Trigger actions directly; alter evidence. |

**`AuthorityGrant` (SPEC-005 §3).**

| Kind | Who | Required evidence |
|---|---|---|
| `SELF` | The subject themself. | Completed identity verification at the level required by §4. |
| `AGENT` | A third party acting for the subject. | Signed authorization instrument + agent identity verification + recorded scope. |
| `PARENT_GUARDIAN` | Parent/guardian of a minor. | Evidence of relationship + minor status determination. |
| `LEGAL_REPRESENTATIVE` | Court-appointed representative. | Court instrument, counsel-reviewed before activation. |

- **VG-AUTHZ-004** A grant carries an explicit `scope[]`; an action outside scope is
  refused even if the grant is otherwise valid.
- **VG-AUTHZ-005** Expiry and revocation are evaluated **at execution time, inside the
  same transaction as the write** — not at request-queue time.
- **VG-AUTHZ-006** Revocation is immediate; in-flight cases halt before their next
  external write; already-submitted actions are not retried.
- **VG-AUTHZ-007** One subject may hold multiple grants; the most restrictive applicable
  scope governs any given action.
- **VG-AUTHZ-008** A grant never authorises action against a different subject, even
  within the same tenant. Subject binding is exact.
- **VG-AUTHZ-009** Disputed or contested grants move the subject to `HUMAN_REQUIRED`,
  not forward.

**Identity verification levels (SPEC-005 §4).**

| Level | Method | Permits |
|---|---|---|
| `IAL0` | Email possession only. | Creating an account, viewing public marketing. Nothing subject-specific. |
| `IAL1` | Email + phone possession. | Initiating a discovery scan for a self-claimed subject (no writes). |
| `IAL2` | Government-ID document verification + liveness. | `REQUEST_READY` and self-service writes. |
| `IAL3` | `IAL2` + additional proof. | Certified mail, regulator escalation, high-risk jurisdictions. |

`VG-AUTH-001` a write-producing state is unreachable below the required level;
`VG-AUTH-002` verification artefacts are `IDENTITY_DOCUMENT` egress class, encrypted,
access-logged, and crypto-shredded as soon as the decision is recorded; `VG-AUTH-003`
verification failures are rate-limited and do not reveal which factor failed (no oracle);
`VG-AUTH-004` minors follow the guardian lane and never receive `IAL2` document upload
directly.

**Authorization matrix (SPEC-005 §5).** Every route is denied by default; access requires
an explicit entry; enforced in the service layer **and** independently by RLS. The matrix
rows are the contract: own subject profile RW(self)/RW(minor)/R; other subject in tenant
R(scoped) for `OPERATOR`/`TENANT_ADMIN`/`AUDITOR`/`COUNSEL_REVIEWER`; **other tenant —
for every role**; alias/identifier write W(self)/W(minor)/W(`TENANT_ADMIN`); authority
mint W(`TENANT_ADMIN`, not self-approve); authority revoke W(own)/W(minor's)/
W(`TENANT_ADMIN`); source and catalogue write W(`TENANT_ADMIN`); recipe publish
W(`TENANT_ADMIN`, signed only); discovery run W(self)/W(minor)/W(`OPERATOR`)/
W(`TENANT_ADMIN`); match confirm W(`OPERATOR`)/W(`TENANT_ADMIN`); policy write
W(`TENANT_ADMIN`, data-only); external action execute W(gated)/W(gated); verification
record W(`OPERATOR`)/W(`TENANT_ADMIN`); evidence read R(own)/R(minor)/R(case)/R; **evidence
delete — no role**; audit read R(own)/R(minor)/R(case)/R; escalation approve
W(`COUNSEL_REVIEWER`); tenant config W(`TENANT_ADMIN`). `VG-AUTHZ-015`: "gated" roles
still require a valid `AuthorityGrant`, a complete `PolicyDecision`, a signed fresh
recipe, and an available budget — role membership alone never authorises an external
effect. `VG-AUTHZ-016`: `TENANT_ADMIN` may not approve its own grant. `VG-AUTHZ-017`:
evidence deletion is unavailable to every role.

**Closed scope vocabulary (SPEC-003 §3.3).** `vg.subjects.read`, `vg.subjects.write`,
`vg.authority.read`, `vg.authority.write`, `vg.sources.read`, `vg.sources.write`,
`vg.recipes.write`, `vg.discovery.read`, `vg.discovery.run`, `vg.exposures.read`,
`vg.exposures.assess`, `vg.policy.read`, `vg.policy.write`, `vg.cases.read`,
`vg.cases.write`, `vg.actions.execute`, `vg.actions.read`, `vg.webhooks.ingest`,
`vg.observations.write`, `vg.observations.read`, `vg.evidence.read`,
`vg.evidence.read_content`, `vg.evidence.write`, `vg.appeal.write`, `vg.audit.read`,
`vg.coverage.read`, `vg.pii.reveal`. Role bundles: `vg_analyst`, `vg_operator`,
`vg_reviewer`, `vg_auditor`, `vg_tenant_admin`. A wildcard scope is
`401 TOKEN_SCOPE_WILDCARD_FORBIDDEN`. A service token must not hold
`vg.authority.write`, `vg.policy.write`, `vg.appeal.write`, or `vg.audit.read`.

**Step-up (SPEC-005 §6).** Re-authentication within the last 5 minutes
(`auth_level` claim) is required for: minting or expanding an `AuthorityGrant`;
executing or authorising an external write; generating certified mail; approving an
escalation or regulator packet; entering `SUPPORT` break-glass; and changing tenant
policy data, sources, or recipes. `VG-AUTH-005`: a missing or stale step-up is refused and
is never silently downgraded to a lesser verification.

**MCP and agent surface (SPEC-005 §7, SPEC-003 §9).** Tools are schema-validated, typed,
individually authorised, and carry per-tool effect budgets. No agent credential can author
legal policy, mint authority, execute a write without a pre-existing `PolicyDecision`, or
approve an escalation. Agent credentials are held by an isolated provider runner and are
never stored in the application database or copied into tenant scope. Every agent tool
invocation is audited with the invoking identity, tool, target, and correlation ID.
Provider transports must be official, documented automation surfaces. MCP tokens must not
hold `vg.policy.write`, `vg.authority.write`, `vg.appeal.write`, `vg.actions.execute`,
`vg.audit.read`, or `vg.pii.reveal`; write-capable tools are the enumerated subset
`assess-match`, `record-verification-observation`, `record-reappearance`,
`record-human-gate`, `upload-evidence-artifact`, each requiring an `IdempotencyKey`
supplied by the orchestration layer, never generated by the model.

**Secret handling (SPEC-005 §8, SPEC-006 §7.1 rows 14/16).** Secrets live in a dedicated
secret manager (or KMS-encrypted parameters), never in the application database,
repository, container image, or logs. Workload identity is short-lived and automatically
rotated; static keys require a recorded, time-bounded exception. Secret access is logged
with the accessing workload identity. A secret-scanning gate runs in CI and on the
repository, and a finding **blocks the release**. Provider-runner secrets are isolated per
provider and per environment. A secret-resolution failure means **no attempt is made** —
never a fallback to a plaintext, `.env`, empty, or cached value (VG-ERR-055).

**Fail-closed matrix (SPEC-006 §7.1) — the 25 rows this node must satisfy.** In
particular: invalid OIDC token rejects before domain entry; revoked/expired grant refuses
at execution time; unknown or `WRITE_UNCLEAR` `PermissionClass` means **no write**;
unknown jurisdiction stops and records a legitimate outcome rather than a model-invented
basis; unknown recipe freshness or an unavailable clock disables the recipe; an absent
independent observation path prevents `VERIFIED_REMOVED` in all circumstances; an
unavailable `AuditSink` **abandons** the operation (no state change without its audit
event); an unenforced RLS session refuses the query; an unavailable DLP gate denies
egress; a secret-resolution failure makes no attempt; an ambiguous write outcome
reconciles and never blind-retries; untrusted content that attempts to select a channel or
trigger a write rejects the whole operation; a private/link-local/metadata fetch target is
refused; an invalid or replayed webhook is rejected before any state change.

**No-masking and no-PII rules (SPEC-006 §8, §9).** No gate step may use
continue-on-error, `|| true`, `set +e`, an ignored exit code, a pipeline that masks a
producer's status, a swallowed or blanket catch, an all-retry policy, filtered output, a
baseline auto-accept, or a silent skip. Error records, logs, traces, metrics, issue text,
and PR text carry opaque IDs only. The canary method of SPEC-006 §9.2 is the required
approach for PII-leak verification: runtime-generated unpredictable canaries, an
independent observation path, a zero-match assertion in every channel, and a seeded
control leak that the same check must detect (DOD-013, DOD-018).

**Unknown audience strings — a discovery blank, not an invented constant.** SPEC-003
§3.2 item 3 requires distinct `aud` values for portal, service, and MCP tokens, and
VG-API-016 requires an MCP token to be refused on portal-only routes, but no concrete
audience string appears in the specifications read for this plan. M1 fills this blank
from the keycloak probe output and the client registration, and records the result; no
milestone may hard-code an audience the realm does not issue. Until the realm exists the
verification logic is exercised with locally generated audiences through the injected
JWKS port, and real-audience proof is `BLOCKED_CREDENTIALS`.

## 8. Milestones

### M1: Security foundation, discovery blanks, and this node's gate

GOAL: The security module skeleton type-checks, the audience and realm facts are
discovered rather than invented, `scripts/security-check.sh` becomes a real gate that can
fail, and this node has a gate that genuinely fails when the security suites fail.

READ: `SECURITY.md`, `PREFLIGHT.md`, `.env.example`, `ENVIRONMENT.md`,
`SPEC-005` §1/§8/§9, `SPEC-003` §3.2/§3.3, `SPEC-006` §7.1/§8, `COMMANDS.md`,
`scripts/security-check.sh`, `scripts/gate-api.sh`, `scripts/gate-ui.sh`,
`scripts/import-boundary.sh`, `scripts/lib/loud-fail.sh`.

CHANGE: `src/application/security/scope-catalogue.ts`,
`src/application/security/role-bundles.ts`, `src/adapters/config/security-config.ts`,
`scripts/security-check.sh`, `scripts/gate-security.sh`, `scripts/import-boundary.sh`,
`tests/contract/scope-catalogue.test.ts`, `COMMANDS.md`, `ARCHITECTURE.md`,
`SECURITY.md`, `ASSUMPTIONS.md`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

1. **Discovery commands whose output fills the template blanks.** Run these and record
   the output verbatim in `SECURITY.md` under a new "Discovered security facts" heading.
   The blanks are `<PORTAL_AUD>`, `<SERVICE_AUD>`, `<MCP_AUD>`, `<REALM_ISSUER>`, and
   `<STEP_UP_ACR>`:

```
sh scripts/probes/keycloak.sh; echo "probe exit: $?"
sh scripts/probes/database_url.sh; echo "probe exit: $?"
sh scripts/probes/valkey_url.sh; echo "probe exit: $?"
sh scripts/probes/cloud_identity.sh; echo "probe exit: $?"
sh scripts/probes/local_model.sh; echo "probe exit: $?"
```

   Expected honest outcome: `KEYCLOAK_ISSUER` is unset, so the keycloak probe exits
   non-zero and every audience blank is recorded as `BLOCKED_CREDENTIALS — no realm
   provisioned; values to be filled from the client registration when KEYCLOAK_* is
   supplied`. Do **not** invent audience strings. Record the blank, the probe command, and
   the observed exit code.
2. `src/application/security/scope-catalogue.ts` — transcribe the closed SPEC-003 §3.3
   vocabulary as a frozen array of exact strings with one line of meaning each, plus
   `isScope()` and a `assertNoWildcard()` that rejects `*`. Transcribe the five role
   bundles from SPEC-003 §3.3 as scope sets, and add the four "service token must not
   hold" scopes as a named constant used by M7.
3. `src/application/security/role-bundles.ts` — the SPEC-005 §2 seven human roles mapped
   to scope bundles, each with an explicit `mayNot` note transcribed from the §2 table so
   the prohibition is visible where the bundle is defined, not only in the spec.
4. `src/adapters/config/security-config.ts` — reads and validates `KEYCLOAK_ISSUER`,
   `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `SESSION_SECRET`, and the audience
   values. Absent values abort with
   `dependency unavailable: <ENV_NAME> is unset; see PREFLIGHT.md and .env.example`.
   Never log a value — only the variable name.
5. `scripts/security-check.sh` — replace the loud-fail body with a real gate that runs,
   in order: the secret scan (`sh scripts/secret-scan.sh`), the security contract suites
   (M2–M10), the SSRF target-classification suite, and a scan for the SPEC-006 §8 masking
   patterns (continue-on-error, `|| true`, `set +e`, ignored `$?`) in `scripts/**` and any
   CI configuration. Prints `security check: ok` **only** when every step passed. It must
   fail closed and print no sentinel when a required credential prevents a suite from
   running: those suites record `BLOCKED_CREDENTIALS` with the probe command and exit code
   (SPEC-006 §4.1), and the gate's output names them.
6. `scripts/gate-security.sh` — this node's gate. Real content:

```sh
#!/usr/bin/env sh
# EP-006 auth/security node gate.
#
# SCOPE, STATED HONESTLY: this gate verifies what can be verified without a
# provisioned Keycloak realm, PostgreSQL, Valkey, or KMS: that the security modules
# type-check, that the layer import boundary holds, that the scope vocabulary and role
# bundles are closed and match the specification, that the credential-free security
# contract suites pass, that the SSRF classifier refuses private and link-local
# targets, that the secret-scanning gate is clean, and that no SPEC-006 section 8
# masking pattern exists in any gate script. It does NOT verify realm configuration,
# real token issuance, MFA enrolment, RLS, KMS resolution, or live webhook replay. It
# says so in its own output on every run and never reports those as passing.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

[ -f src/application/security/scope-catalogue.ts ] || { echo "ep006 security gate: FAIL - scope catalogue is missing" >&2; exit 1; }
[ -f src/application/security/authority-service.ts ] || { echo "ep006 security gate: FAIL - authority service is missing" >&2; exit 1; }
[ -f scripts/secret-scan.sh ] || { echo "ep006 security gate: FAIL - secret-scanning gate is missing" >&2; exit 1; }

npx --no-install tsc --noEmit || { echo "ep006 security gate: FAIL - typecheck failed" >&2; exit 1; }
sh scripts/import-boundary.sh || { echo "ep006 security gate: FAIL - layer import boundary violated" >&2; exit 1; }
sh scripts/secret-scan.sh || { echo "ep006 security gate: FAIL - secret scan found a finding" >&2; exit 1; }

node --test "tests/contract/scope-catalogue.test.ts" || { echo "ep006 security gate: FAIL - scope catalogue suite failed" >&2; exit 1; }
node --test "tests/security/**/*.test.ts" || { echo "ep006 security gate: FAIL - security suites failed" >&2; exit 1; }

# SPEC-006 section 8 masking patterns must not exist in any gate script.
if grep -nE '(continue-on-error|\|\|[[:space:]]*true|set[[:space:]]+\+e)' scripts/*.sh >/dev/null 2>&1; then
  echo "ep006 security gate: FAIL - masking pattern found in scripts/" >&2
  grep -nE '(continue-on-error|\|\|[[:space:]]*true|set[[:space:]]+\+e)' scripts/*.sh >&2
  exit 1
fi

echo "ep006 security gate: UNVERIFIED-BY-THIS-GATE (recorded as BLOCKED_CREDENTIALS/BLOCKED_PREREQUISITE):"
for pair in "KEYCLOAK_ISSUER:sh scripts/probes/keycloak.sh" \
            "DATABASE_URL:sh scripts/probes/database_url.sh" \
            "VALKEY_URL:sh scripts/probes/valkey_url.sh" \
            "CLOUD_WORKLOAD_IDENTITY:sh scripts/probes/cloud_identity.sh"; do
  name=${pair%%:*}; probe=${pair#*:}
  if sh -c "$probe" >/dev/null 2>&1; then
    echo "  - ${name}: probe ok"
  else
    echo "  - ${name}: BLOCKED_CREDENTIALS (probe: ${probe})"
  fi
done
echo "  - RLS second enforcement layer: BLOCKED_PREREQUISITE (EP-003 schema and RLS policy not created)"
echo "  - realm MFA policy, refresh rotation, global sign-out, administrative revocation: BLOCKED_CREDENTIALS (KEYCLOAK_*)"
echo "  - manual assistive-technology validation of verification flows (SPEC-005 section 11, DOD-039): EXTERNAL_REQUIRED"
echo "  - counsel review of authorized-agent evidence, minors, identity-method sufficiency (SPEC-005 section 11): EXTERNAL_REQUIRED"

echo "gate-security: ok"
```

7. `tests/contract/scope-catalogue.test.ts` — asserts the catalogue equals the SPEC-003
   §3.3 scope list parsed from the specification (set equality in both directions),
   asserts every role bundle's scopes are a subset of the catalogue, asserts no bundle
   contains `*`, asserts `vg.webhooks.ingest` is not in any caller bundle, and asserts the
   four service-token-forbidden scopes are declared. Required negative case: adding a
   scope to a bundle that is not in the catalogue fails.
8. `COMMANDS.md` — add, each with its sentinel: `sh scripts/gate-security.sh`
   (`gate-security: ok`); `sh scripts/security-check.sh` (`security check: ok`);
   `sh scripts/secret-scan.sh` (`secret scan: ok`);
   `node --test "tests/contract/scope-catalogue.test.ts"` and
   `node --test "tests/security/**/*.test.ts"` (the credential-free security suites the
   node gate runs). The credential probes used in every `RUN` block that reports a blocked
   status — `sh scripts/probes/keycloak.sh`, `sh scripts/probes/database_url.sh`,
   `sh scripts/probes/valkey_url.sh`, `sh scripts/probes/cloud_identity.sh`,
   `sh scripts/probes/local_model.sh` — are already declared by `PREFLIGHT.md`; they are
   named here so the mechanism producing `BLOCKED_CREDENTIALS` is visible in the declared
   command set rather than implied.
9. `.agent/verification/EXPECTED_TEST_MANIFEST.txt` — add
   `tests/contract/scope-catalogue.test.ts`.

RUN:
```
sh scripts/probes/keycloak.sh; echo "probe exit: $?"
sh scripts/probes/database_url.sh; echo "probe exit: $?"
sh scripts/probes/valkey_url.sh; echo "probe exit: $?"
sh scripts/probes/cloud_identity.sh; echo "probe exit: $?"
sh scripts/probes/local_model.sh; echo "probe exit: $?"
node --test "tests/contract/scope-catalogue.test.ts"
sh scripts/gate-security.sh
git status --short
```

EXPECT: every probe exits non-zero (none of `KEYCLOAK_*`, `DATABASE_URL`, `VALKEY_URL`,
`CLOUD_WORKLOAD_IDENTITY`, `LOCAL_MODEL_ENDPOINT` is provisioned — this is the current
true state, recorded as `BLOCKED_CREDENTIALS`, not a defect to route around); the scope
suite passes; the final line `gate-security: ok` with its
`UNVERIFIED-BY-THIS-GATE` block present; `git status --short` listing only §6 files.
`verify.sh` does **not** print `verify: ok` at this node and must not be made to.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-006 MILESTONE_PASS "M1 gate-security: ok; audience blanks recorded BLOCKED_CREDENTIALS; scope catalogue closed"`

FALLBACK: if the specification's scope table cannot be parsed reliably, generate the
catalogue from a checked-in machine-readable extract and make the test assert the extract
is byte-identical to the table region it was taken from. A hand-maintained duplicate list
is not an acceptable fallback.

COMMIT: `git add -A && git commit -m "[EP-006][M1] security foundation, discovery blanks, and node gate"`

### M2: Keycloak OIDC integration, token verification, and MFA enforcement

GOAL: Portal routes refuse a password-only, factor-less, wrong-audience, expired, or
claim-deficient session with the mapped code, and the refresh/logout/revocation call paths
exist as real operations with coded evidence hooks.

READ: `SPEC-005` §1 (IDP-1…IDP-6), §10 (VG-AUTH-020, VG-AUTH-021);
`SPEC-003` §3.2 (items 1–3, 6, 7); `SPEC-006` §7.1 row 1; `src/domain/errors.ts`;
`PREFLIGHT.md` (`KEYCLOAK_*` rows); `scripts/probes/keycloak.sh`; EP-004 M3 (the
verification skeleton this milestone completes).

CHANGE: `src/adapters/oidc/realm-client.ts`, `src/adapters/oidc/authorization-code.ts`,
`src/adapters/oidc/token-verifier.ts`, `src/adapters/oidc/revocation.ts`,
`tests/contract/mfa-enforcement.test.ts`,
`tests/fixtures/local-oidc/issue.ts`, `tests/contract/audience-binding.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `src/adapters/oidc/authorization-code.ts` — builds the authorization request with PKCE
  (`code_challenge_method=S256`, a fresh high-entropy `code_verifier` per attempt) and a
  single-use `state`; validates `state` and the ID-token nonce on callback. Implicit and
  resource-owner-password flows are **not implemented** and their absence is asserted by
  a test that greps the adapter for the prohibited grant types.
- `src/adapters/oidc/token-verifier.ts` — completes what EP-004 M3 started: signature via
  realm JWKS, `iss`, `aud`, `exp`, `nbf`, `azp`, required claims (`sub`, `iss`, `aud`,
  `exp`, `tenantId`, `scopes`, `roles`, `authTime`, `acr`), and the ≤15-minute access-token
  lifetime assertion (IDP-3). A missing `tenant_id` is rejected outright with
  `401 TOKEN_INVALID_CLAIMS` and **no RLS session is opened** (VG-AUTH-021).
- `src/adapters/oidc/revocation.ts` — refresh-token revocation, global sign-out, and
  administrative revocation call paths against the realm. These are real calls that fail
  closed with `503 DEPENDENCY_UNAVAILABLE` when the realm is unreachable; they must never
  report success without a realm response. Until `KEYCLOAK_ISSUER` is provisioned, the
  suite that exercises them records `BLOCKED_CREDENTIALS` — it does not assert success.
- MFA enforcement (IDP-2): a session whose `acr`/`amr` shows only a password factor is
  refused with `403 STEP_UP_REQUIRED` for `TENANT_ADMIN` and `OPERATOR` (WebAuthn
  required) and with a refusal for every other human role (a second factor required).
  Required negative case: password-only login is refused **and audited** (VG-AUTH-020).
- `tests/contract/audience-binding.test.ts` — a token minted for one audience is refused
  on a route belonging to another audience with `401 TOKEN_AUDIENCE_MISMATCH` and performs
  no work. Audiences come from the M1 discovery blanks when provisioned; until then the
  test uses locally generated audience values through the injected JWKS port and its file
  header states that real-audience binding is `BLOCKED_CREDENTIALS`.
- `tests/fixtures/local-oidc/issue.ts` — generates a key pair and signs tokens for the
  verification tests. Every test that uses it must say in its header: "This proves the
  verification logic; it does not prove the realm configuration, which is
  BLOCKED_CREDENTIALS on KEYCLOAK_ISSUER."

RUN:
```
node --test "tests/contract/audience-binding.test.ts"
node --test "tests/contract/mfa-enforcement.test.ts"
sh scripts/probes/keycloak.sh; echo "probe exit: $?"
sh scripts/gate-security.sh
```

EXPECT: both suites pass against locally signed tokens; the keycloak probe exits
non-zero; `gate-security: ok` with `KEYCLOAK_ISSUER: BLOCKED_CREDENTIALS` in its
output.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-006 MILESTONE_PASS "M2 OIDC verification, audience binding, MFA enforcement: ok; realm config BLOCKED_CREDENTIALS KEYCLOAK_ISSUER"`

FALLBACK: if no OIDC client library is acceptable under the locked dependency policy,
implement the authorization-code exchange and JWKS verification with `node:crypto` and
`fetch` directly. Real protocol implementation, no stub. Never accept an unverified token
to keep a suite green.

COMMIT: `git add -A && git commit -m "[EP-006][M2] OIDC integration, token verification, and MFA enforcement"`

### M3: Role matrix, scope enforcement, and the API-boundary authorization gate

GOAL: Every route requires exactly the scopes and role named in the SPEC-003 §5 catalogue
and the SPEC-005 §5 matrix; a missing scope is refused before any domain work; and a
wildcard scope is refused on every route.

READ: `SPEC-005` §2 (ROLE-1…ROLE-4), §5 (the matrix, VG-AUTHZ-015…017);
`SPEC-003` §3.2 item 5, §3.3, §5 (per-route scope cells), §11.2;
`SPEC-006` §6.2 (403 codes); `src/http/openapi/registry.ts` (EP-004 M1).

CHANGE: `src/application/security/authorization-matrix.ts`,
`src/http/plugins/scope-guard.ts`, `tests/contract/role-matrix.test.ts`,
`tests/contract/scope-enforcement.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `src/application/security/authorization-matrix.ts` — the SPEC-005 §5 matrix as data:
  `(resource, action, role) → decision` where the decision is `ALLOW` or `DENY` with a
  reason. The default for any cell not explicitly present is **DENY**. The four "notably
  may not" columns of SPEC-005 §2 are encoded as explicit `DENY` rows, so a role's
  prohibititions are data, not prose.
- `src/http/plugins/scope-guard.ts` — reads the required scopes and role from the EP-004
  route registry, asserts scope satisfaction **before** the domain command runs, and
  emits `403 INSUFFICIENT_SCOPE` or `403 INSUFFICIENT_ROLE`. A token whose scope string is
  `*` is `401 TOKEN_SCOPE_WILDCARD_FORBIDDEN` on every route. Role membership alone never
  authorises an external effect: `vg.actions.execute` additionally requires a valid
  `AuthorityGrant`, a complete `PolicyDecision`, a signed fresh recipe, and an available
  budget, and a missing one produces the specific `409`/`422` code (VG-AUTHZ-015).
- A stale token whose scope set was valid when issued but no longer matches tenant
  entitlement is rejected by the application-layer entitlement check, and the rejection is
  audited (SPEC-003 §3.3 last paragraph).
- `tests/contract/role-matrix.test.ts` — walks every `(resource, action, role)` cell that
  appears in the SPEC-005 §5 matrix parsed from the specification and asserts the
  implementation's decision matches, in both directions (an unimplemented `ALLOW` and an
  unlisted permission both fail). Required negative cases: "other tenant" is `DENY` for
  every role; evidence delete is `DENY` for every role; `TENANT_ADMIN` self-approval of
  its own `AuthorityGrant` is `DENY` with `409`/`422` separation-of-duties behaviour
  (VG-AUTH-023).
- `tests/contract/scope-enforcement.test.ts` — for every registry entry, a token holding
  exactly the required scopes succeeds and a token missing one is refused with
  `403 INSUFFICIENT_SCOPE` **before** any domain call (asserted by a command-dispatch spy
  in the test harness that must record zero dispatches on the refused path). Required
  negative case: a `*` scope token is refused with `401 TOKEN_SCOPE_WILDCARD_FORBIDDEN`
  on every route (VG-API-014).

RUN:
```
node --test "tests/contract/role-matrix.test.ts"
node --test "tests/contract/scope-enforcement.test.ts"
sh scripts/gate-security.sh
```

EXPECT: both suites pass; `gate-security: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-006 MILESTONE_PASS "M3 role matrix and scope enforcement: ok; wildcard scope refused on every route"`

FALLBACK: if a matrix cell is genuinely ambiguous in SPEC-005 §5 (for example a resource
the matrix does not name), the correct action is **DENY** plus a §12 finding citing the
gap — not an inferred `ALLOW` and not an edit to the specification.

COMMIT: `git add -A && git commit -m "[EP-006][M3] role matrix, scope enforcement, and boundary authorization gate"`

### M4: `AuthorityGrant` lifecycle and anti-fraudulent-enrollment controls

GOAL: Minting, verification, scope evaluation, execution-time re-assertion, revocation,
and subject binding all hold; and the anti-fraudulent-enrollment controls of SPEC-005
§3.1 are implemented with the required evidence for each kind.

READ: `SPEC-005` §3 (all of it), §3.1 (VG-AUTHZ-010…014), §4 (VG-AUTH-001…004),
§10 (VG-AUTH-022…025, VG-AUTH-032); `SPEC-003` §5.2, §5.8.2;
`SPEC-000` VG-AUTHZ-001/002/003, VG-IDENT-001; `src/domain/errors.ts`;
`src/domain/truth-state.ts` (T8's `authorityValid` guard).

CHANGE: `src/application/security/authority-service.ts`,
`src/application/security/enrollment-controls.ts`,
`src/domain/ports/authority-repository.ts`,
`src/adapters/persistence/authority-repository.ts`,
`tests/contract/authority-grant.test.ts`,
`tests/contract/enrollment-controls.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `src/application/security/authority-service.ts` — `mint`, `verifyAtExecutionTime`,
  `revoke`, `assertScope`, `assertSubjectBinding`, `effectiveScope`. Binding rules:
  - **VG-AUTHZ-004** `assertScope(grant, requiredScope)` refuses an action outside
    `scope[]` with `AuthorityScopeViolation` even when the grant is otherwise valid.
  - **VG-AUTHZ-005** `verifyAtExecutionTime(grantId, now, tx)` reads the grant **inside
    the write transaction** and evaluates `expiresAt` and `revokedAt` there. A grant
    validated earlier in the request is not sufficient; a time-shifted-grant test proves
    the difference (VG-ERR-029).
  - **VG-AUTHZ-006** revocation halts in-flight cases before their next external write;
    already-submitted actions are not retried and history is never rewritten
    (VG-REAPPEAR-002).
  - **VG-AUTHZ-007** with multiple grants, `effectiveScope` returns the **most
    restrictive** applicable scope, and an action requiring more than that is refused.
  - **VG-AUTHZ-008** `assertSubjectBinding` refuses a grant used for a different subject
    in the same tenant.
  - **VG-AUTHZ-009** a disputed or contested grant moves the subject to `HUMAN_REQUIRED`
    via the domain command, not forward.
  - Kind-to-evidence: `SELF` requires the identity level of §4; `AGENT` requires a stored
    signed instrument and agent identity verification; `PARENT_GUARDIAN` requires
    relationship evidence plus a minor-status determination; `LEGAL_REPRESENTATIVE`
    requires a court instrument and is counsel-reviewed before activation. A missing
    instrument is `422 AUTHORITY_EVIDENCE_REQUIRED`, not a warning.
  - **Vocabulary decision, recorded not assumed.** SPEC-005 §3 names the kinds `SELF`,
    `AGENT`, `PARENT_GUARDIAN`, `LEGAL_REPRESENTATIVE`; SPEC-003 §5.2.1 shows the request
    enum as `SELF|AGENT|GUARDIAN|DEPENDENT`. Implement the SPEC-005 set as the canonical
    domain enum, provide an explicit two-way mapping for the wire enum, test the mapping
    in both directions, and record the resolution in §13 with both citations. Do not
    silently pick one and leave the other unhandled — an unmapped wire value must be
    `422 AUTHORITY_SCOPE_UNKNOWN`-class refusal, never a default.
- `src/application/security/enrollment-controls.ts` — the SPEC-005 §3.1 controls:
  - **VG-AUTHZ-010** agent enrollment requires document upload, signature verification,
    and a **cooling-off period** before the first external write. The cooling-off deadline
    is computed from the injected `Clock` and recorded on the grant.
  - **VG-AUTHZ-011** enrollment velocity limits per tenant, per IP class, and per payment
    instrument; a breach routes to review and is audited.
  - **VG-AUTHZ-012** a subject may contest an agent grant; a contest **immediately**
    suspends that agent's write capability for that subject.
  - **VG-AUTHZ-013** multiple agents claiming the same subject raise a conflict requiring
    human resolution.
  - **VG-AUTHZ-014** notice is sent to the subject's verified contact channel on agent
    enrollment, and the notice artefact is recorded on grant creation. Enrollment without
    a recorded notice fails acceptance (VG-AUTH-032).
- `tests/contract/authority-grant.test.ts` — positive path plus each refusal above, each
  asserted to leave state unchanged and to create no `ExternalAction`. Required negative
  cases: a **forged** grant is rejected and no subject row is created (VG-IDENT-001); an
  **expired** grant refuses with no external effect (VG-AUTHZ-001); a **revoked-during-
  flight** case performs no further write (VG-AUTH-024); a **read-scoped grant cannot
  write** (VG-AUTH-025); a grant for subject A cannot act on subject B.
- `tests/contract/enrollment-controls.test.ts` — each of VG-AUTHZ-010…014 with its
  negative case: enrollment without document upload or without signature verification is
  refused; a velocity breach routes to review; a contest suspends writes immediately
  (asserted by a write attempt immediately after the contest); a second agent for the same
  subject creates a conflict; enrollment with no recorded notice fails acceptance.
- `src/domain/ports/authority-repository.ts` — the port. `src/adapters/persistence/
  authority-repository.ts` implements it against PostgreSQL; its real-database proof is
  `BLOCKED_CREDENTIALS` (`DATABASE_URL`) and `BLOCKED_PREREQUISITE` (EP-003). The contract
  suite header must state that the logic proofs use an isolation double and that the
  durable-store proof is blocked (DOD-010) — and the milestone must record both statuses.

RUN:
```
node --test "tests/contract/authority-grant.test.ts"
node --test "tests/contract/enrollment-controls.test.ts"
sh scripts/probes/database_url.sh; echo "probe exit: $?"
sh scripts/gate-security.sh
```

EXPECT: both suites pass; the database probe exits non-zero; `gate-security: ok`
with `DATABASE_URL: BLOCKED_CREDENTIALS` in its output.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-006 MILESTONE_PASS "M4 AuthorityGrant lifecycle and enrollment controls: ok; durable-store proof BLOCKED_CREDENTIALS DATABASE_URL"`

FALLBACK: if the cooling-off period and velocity limits cannot be evaluated without a
durable store, implement them against the injected `Clock` and a durable append-only file
with an exclusive lock for the credential-free path, keeping the PostgreSQL adapter as the
production binding. A process-local counter presented as an enrollment velocity control is
prohibited: in-memory state is not a control (SPEC-006 §10.3).

COMMIT: `git add -A && git commit -m "[EP-006][M4] AuthorityGrant lifecycle and anti-fraudulent-enrollment controls"`

### M5: Step-up authentication across the six sensitive operation classes

GOAL: Each of the six sensitive operation classes refuses a missing or stale step-up with
`403 STEP_UP_REQUIRED` and never silently downgrades to a lesser verification, and the
audit row records the step-up.

READ: `SPEC-005` §6 (VG-AUTH-005), §4; `SPEC-003` §3.2 item 6, §11.2 (VG-API-015);
`SPEC-006` §6.2; `SPEC-002` (audit).

CHANGE: `src/application/security/step-up-policy.ts`, `src/http/plugins/step-up.ts`,
`tests/contract/step-up.test.ts`, `.agent/verification/EXPECTED_TEST_MANIFEST.txt`,
`.agent/state/LEDGER.md`.

CONTENT:

- `src/application/security/step-up-policy.ts` — declares the six classes as data, each
  with its required `acr` and its freshness window (5 minutes):
  `AUTHORITY_GRANT_MINT_OR_EXPAND`, `EXTERNAL_WRITE_EXECUTE_OR_AUTHORISE`,
  `CERTIFIED_MAIL_GENERATE`, `ESCALATION_OR_REGULATOR_PACKET_APPROVE`,
  `SUPPORT_BREAK_GLASS_ENTER`, `TENANT_POLICY_SOURCE_RECIPE_CHANGE`.
- `src/http/plugins/step-up.ts` — checks `acr` at or above the configured step-up level
  and `authTime` within the freshness window, using the **injected `Clock`** and never
  the process wall clock (SPEC-006 §7.1 row 24: an unavailable `Clock` means freshness
  cannot be established, so the operation is refused). A missing or stale step-up is
  `403 STEP_UP_REQUIRED`. There is no code path that reduces the required level, retries
  with a lower level, or treats a stale `authTime` as acceptable.
- `tests/contract/step-up.test.ts` — for each of the six classes: a fresh step-up
  proceeds and the audit row records it; a stale `authTime` (6 minutes) is refused; a
  missing `acr` is refused; and an unavailable `Clock` refuses rather than proceeding.
  Required negative case (VG-API-015): a token at the base authentication level
  attempting `POST /v1/cases/{caseId}/external-actions` returns `403 STEP_UP_REQUIRED`
  and produces **no external effect** — asserted by a command-dispatch spy recording zero
  dispatches and by an effect counter that does not move.
- Assert mechanically that the six classes match the SPEC-003 §3.2 item 6 list
  (evidence content download, identifier reveal, authority-grant creation and revocation,
  external action execution, appeal/escalation creation) plus the `SUPPORT` break-glass
  and tenant-policy classes, with the union recorded and any mismatch fixed by amending
  the implementation — never by amending the specification.

RUN:
```
node --test "tests/contract/step-up.test.ts"
sh scripts/gate-security.sh
```

EXPECT: the step-up suite passes; `gate-security: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-006 MILESTONE_PASS "M5 step-up enforced across six sensitive operation classes"`

FALLBACK: if the realm cannot yet supply an `acr` value at the required level, the
policy still refuses — the fallback is a **stricter** posture (require the step-up to be
demonstrated by an explicitly recorded re-authentication event), never a weaker one.

COMMIT: `git add -A && git commit -m "[EP-006][M5] step-up authentication for sensitive operations"`

### M6: JIT `SUPPORT` access, progressive lockout, rate limits, and enumeration inhibition

GOAL: `SUPPORT` access is just-in-time, time-boxed to ≤60 minutes, single-tenant,
reason-bearing, MFA+step-up gated, and audited on entry, every PII-class read, and exit;
standing access is denied; rate limits and progressive lockout behave as specified; and
subject enumeration is inhibited.

READ: `SPEC-005` §2 (ROLE-2, ROLE-3, ROLE-4), §9 (VG-AUTH-016…019), §10 (VG-AUTH-028);
`SPEC-003` §2.7, §5.15.1; `SPEC-007` (alert catalogue); `SPEC-006` §7.1.

CHANGE: `src/application/security/support-access-service.ts`,
`src/http/plugins/support-access.ts`, `src/adapters/coordination/rate-limit.ts`,
`src/http/plugins/rate-limit.ts`, `src/application/security/lockout.ts`,
`tests/contract/jit-support-access.test.ts`,
`tests/contract/rate-limit-abuse.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `src/application/security/support-access-service.ts` — a support session is a
  first-class record: `{ tenantId, actorIdentity, reason, grantedAt, expiresAt }` with
  `expiresAt - grantedAt ≤ 60 minutes`, one tenant, and a non-empty reason. States:
  `REQUESTED → ACTIVE → EXPIRED|REVOKED`. **Standing access does not exist as a state**
  (VG-AUTH-028). Entry, **every read of PII-class data**, and exit each append an
  `AuditEvent`. Impersonation of a `SUBJECT_USER` is prohibited; support sees the redacted
  diagnostic view instead (ROLE-3). No role may disable, truncate, or delete audit
  (ROLE-4).
- `src/http/plugins/support-access.ts` — denies any request whose identity carries the
  `SUPPORT` role without an `ACTIVE` session, with the refusal audited. It requires
  step-up on entry and MFA.
- `src/application/security/lockout.ts` — progressive lockout on repeated authorization
  failure (escalating delay and, past the threshold, a refusal) with an alert emitted
  through the SPEC-007 alert path (VG-AUTH-019).
- `src/adapters/coordination/rate-limit.ts` + `src/http/plugins/rate-limit.ts` — per-tenant
  and per-identity limits on discovery, writes, verification, and evidence reads
  (VG-AUTH-016), and the per-`(tenantId, sourceId)` conservative discovery limit enforced
  **client-side before dispatch** so an over-budget call is refused rather than silently
  overrun (VG-DISC-003). Every response carries `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset`; a refusal is `429 RATE_LIMITED` with `Retry-After` and no state
  change. Effect budgets stay authoritative in the domain and are a separate mechanism
  (VG-ACTION-005); the gateway/rate-limit layer is an additional ceiling, never a
  substitute.
- Enumeration inhibition (VG-AUTH-027): responses for a non-existent versus an
  unauthorised subject are indistinguishable in body, status, and timing; no endpoint
  confirms whether a named person is a customer. Bulk PII export is not an available
  operation for any role (VG-AUTH-018).
- `tests/contract/jit-support-access.test.ts` — a session exceeding 60 minutes expires and
  subsequent access is refused; a session for tenant A cannot read tenant B; entry, each
  PII read, and exit produce audit rows; a standing-access attempt is denied. Required
  negative case (VG-AUTH-028): a request with `SUPPORT` and no active session is denied
  and audited.
- `tests/contract/rate-limit-abuse.test.ts` — a burst above the configured per-source
  limit is refused `429` with `Retry-After` and produces **no** discovery request to the
  source (asserted by a dispatch spy); repeated authorization failures trip progressive
  lockout and emit an alert; a nonexistent-versus-unauthorised comparison finds no
  differential beyond the configured tolerance. Required negative case (VG-AUTH-027): a
  timing or response differential fails the gate.

RUN:
```
node --test "tests/contract/jit-support-access.test.ts"
node --test "tests/contract/rate-limit-abuse.test.ts"
sh -c 'sh scripts/probes/valkey_url.sh'; echo "probe exit: $?"
sh scripts/gate-security.sh
```

EXPECT: both suites pass for the credential-free logic paths; the Valkey probe exits
non-zero, so the durable rate-limit and replay counter suite records
`BLOCKED_CREDENTIALS` (`VALKEY_URL`) with the probe command and exit code;
`gate-security: ok` with `VALKEY_URL: BLOCKED_CREDENTIALS` in its output.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-006 MILESTONE_PASS "M6 JIT support access, lockout, rate limits, enumeration inhibition: ok; durable counters BLOCKED_CREDENTIALS VALKEY_URL"`

FALLBACK: if no shared counter store is available, implement the counters against a
durable append-only file with an exclusive lock for the credential-free path and keep the
Valkey adapter as the production binding. A process-local `Map` for rate limiting across
instances is not a rate limit; presenting it as one is a masking defect.

COMMIT: `git add -A && git commit -m "[EP-006][M6] JIT support access, lockout, rate limits, and enumeration inhibition"`

### M7: MCP and agent least privilege with effect budgets

GOAL: An agent credential cannot author policy, mint authority, approve an escalation,
execute an unguarded write, or read audit or revealed PII; every effect-bearing tool call
is budget-bounded and audited; and an agent loop that exceeds its budget is capped.

READ: `SPEC-005` §7 (VG-AUTH-006…010), §10 (VG-AUTH-029); `SPEC-003` §9 (all of it),
§11.6 (VG-API-071/072/073); `SPEC-006` §5.3 rows 12/13; `src/domain/errors.ts`
(`BudgetExceeded`, `TaintedContentRejected`).

CHANGE: `src/application/security/agent-tool-policy.ts`,
`src/application/security/effect-budget.ts`, `src/adapters/agent/tool-registry.ts`,
`tests/contract/mcp-least-privilege.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `src/application/security/agent-tool-policy.ts` — the tool registry as data. Every tool
  maps to exactly one `/v1` route and carries that route's scope requirement; a tool may
  **narrow** the route and may never widen it. Write-capable tools are the enumerated
  subset `assess-match`, `record-verification-observation`, `record-reappearance`,
  `record-human-gate`, `upload-evidence-artifact`, each marked effect-bearing and each
  requiring an `IdempotencyKey` supplied by the orchestration layer. The registry declares
  no tool for policy authoring, authority minting, recipe enabling, escalation approval,
  audit query, evidence content download, `vg.pii.reveal`, or any raw HTTP/shell
  passthrough. A free-form "call any endpoint" tool is prohibited by construction: the
  registry has no such entry and a test asserts the registry's tool set equals the
  enumeration.
- `src/application/security/effect-budget.ts` — four ceilings: per-token (calls per
  window), per-subject, per-source, and the domain's per-subject/source/window write
  budget. The domain budget is authoritative; the others are additional ceilings.
  Exhausting any ceiling yields `409 EFFECT_BUDGET_EXCEEDED` with the exhausted
  dimension, limit, usage, and window. There is no override tool and no parameter that
  raises a budget. Unreadable budget state is treated as **exhausted** (SPEC-006 §7.1 row
  20).
- Agent audit: every effect-bearing tool call emits an `AuditEvent` naming the token
  identity, the tool, the target, the `IdempotencyKey` **fingerprint** (never the raw
  key), the correlation ID, and the budget consumed. A budget refusal is itself audited.
- Agent credentials are held by an isolated provider runner and are never stored in the
  application database or copied into tenant scope (VG-AUTH-008). Model output that
  reaches a write path is treated as data: it can populate an allowlisted template field
  and can never populate a control field (SPEC-003 §9.2 item 4). Untrusted content that
  attempts to select a channel or trigger a write rejects the operation with
  `TAINTED_CONTENT_REJECTED` (VG-SEC-001, VG-ERR-036).
- `tests/contract/mcp-least-privilege.test.ts` — asserts the registry contains no
  privileged tool; that an MCP-audience token is accepted on MCP-exposed routes and
  refused on portal-only routes; that a tool call supplying a model-authored `legalBasis`
  is refused `422 LEGAL_BASIS_NOT_AUTHORABLE` and creates no decision (VG-AUTH-029,
  VG-API-072); that an input failing its tool schema never reaches the application layer;
  and that a loop exceeding the configured budget is capped with further calls refused
  `409 EFFECT_BUDGET_EXCEEDED` and audited (VG-API-073). Required negative case: a
  simulated agent write with no pre-existing `PolicyDecision` is refused and produces no
  external effect.

RUN:
```
node --test "tests/contract/mcp-least-privilege.test.ts"
sh scripts/gate-security.sh
```

EXPECT: the MCP suite passes; `gate-security: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-006 MILESTONE_PASS "M7 MCP least privilege and effect budgets: ok; agent loop capped and audited"`

FALLBACK: if the MCP transport itself is not available at this node, implement and test
the policy, registry, and budget modules as the library the transport will call, and
record the transport-level proof as `BLOCKED_PREREQUISITE` on the MCP gateway
implementation. Do not skip the policy tests because the transport is missing.

COMMIT: `git add -A && git commit -m "[EP-006][M7] MCP and agent least privilege with effect budgets"`

### M8: Secret handling, the secret-scanning gate, and DLP-before-egress

GOAL: A secret-scanning gate blocks on a finding; secrets resolve only through the
`SecretResolver` port; a resolution failure makes no attempt and never falls back; no
secret or PII reaches a log, an error body, a metric label, or a trace attribute; and
DLP-before-egress is fail-closed.

READ: `SPEC-005` §8 (VG-AUTH-011…015), §10 (VG-AUTH-030); `SPEC-006` §7.1 rows 14/16,
§9.1, §9.2 (the canary method), §5.3 rows 14/24; `SPEC-007` (egress classes, redaction);
`DATA_EGRESS_MATRIX.md`; `src/domain/values.ts` (`EgressClass`,
`DENY_BY_DEFAULT_EGRESS`); `src/domain/errors.ts` (`EgressDenied`).

CHANGE: `scripts/secret-scan.sh`, `src/domain/ports/secret-resolver.ts`,
`src/adapters/secrets/secret-resolver.ts`,
`src/application/security/egress-gate.ts`, `tests/contract/secret-handling.test.ts`,
`tests/contract/egress-and-redaction.test.ts`, `COMMANDS.md`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `scripts/secret-scan.sh` — the VG-AUTH-014 gate. Scans the repository working tree and
  tracked files for secret-shaped material: private-key headers, common provider token
  prefixes, high-entropy strings in assignment position, `.env` files with non-placeholder
  values, and credentials in CI configuration. It **exits non-zero and names the file and
  line** on a finding, fails on a zero-file scan, and has **no baseline auto-accept
  mechanism** — there is no `--update` flag and no ignore file that silences a class of
  finding without a recorded reason and owner (SPEC-006 §8 row 8). It prints
  `secret scan: ok` only on a clean tree. Its own self-test fixture (a deliberately seeded
  fake secret in a temp path) must be detected, proving the scanner discriminates
  (DOD-018).
- `src/domain/ports/secret-resolver.ts` + `src/adapters/secrets/secret-resolver.ts`
  — resolve by reference; short-lived workload identity with automatic rotation; static
  keys require a recorded time-bounded exception; every access is logged with the
  accessing workload identity (VG-AUTH-011…013). A resolution failure produces
  `503 DEPENDENCY_UNAVAILABLE` with **zero outbound attempts** and **no** fallback to a
  plaintext, `.env`, empty, or cached value (VG-ERR-055). Provider-runner secrets are
  isolated per provider and per environment; a production runner never holds staging or
  personal credentials (VG-AUTH-015).
- `src/application/security/egress-gate.ts` — default deny for `CUSTOMER_PII`,
  `HIGH_RISK_PII`, `IDENTITY_DOCUMENT`, and `AUTH_SECRET` (VG-EGRESS-001). Denied egress
  produces **no** outbound request, proven by an independent network observation rather
  than by the caller's own report (VG-ERR-037). DLP runs before every egress event and
  records a resolvable `redactionEvidenceId`; an unavailable scrubber denies egress
  (SPEC-006 §7.1 row 14, VG-ERR-071). Metric labels are restricted to `code`, `class`,
  `category`, `tenantId`, and declared reason enums — never a case, subject, or action ID
  and never free text (VG-ERR-070).
- `tests/contract/secret-handling.test.ts` — canary-driven (SPEC-006 §9.2): generate
  runtime-unpredictable canaries (a subject display name, a unique local part on a
  reserved documentation domain, a unique digit string, and an `AUTH_SECRET`-shaped
  token), drive every error path in scope, observe the emitted telemetry, log stream, and
  error envelopes **through the external collector path**, and assert a **zero-match**
  condition for every canary in every channel. Include the seeded control leak that the
  same check must detect. Required negative cases: a seeded secret never appears in
  output (VG-AUTH-030); an induced internal fault returns `500 INTERNAL_ERROR` with no
  exception message, stack trace, or connection string; a token, cookie, or page excerpt
  in an error fails the scan.
- `tests/contract/egress-and-redaction.test.ts` — a denied egress produces zero outbound
  requests; an `AUTH_SECRET`-class value cannot reach any model; an identity document
  cannot reach any model; an egress event without redaction evidence fails; egress
  attempted while the scrubber is down is denied with zero outbound requests.

RUN:
```
sh scripts/secret-scan.sh
node --test "tests/contract/secret-handling.test.ts"
node --test "tests/contract/egress-and-redaction.test.ts"
sh scripts/gate-security.sh
```

EXPECT: `secret scan: ok`; both suites pass with a zero-match canary result and a
detected control leak; `gate-security: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-006 MILESTONE_PASS "M8 secret scan: ok; canary zero-match with detected control leak; egress deny-by-default: ok"`

FALLBACK: if no secret-manager client can be added under the locked dependency policy,
implement the resolver against the cloud provider's HTTP API with the workload identity,
or against an OS keyring, behind the same port. Never fall back to reading `.env` in
production — the fail-closed behaviour is the requirement, and a `.env` fallback would
violate VG-ERR-055 and SPEC-006 §7.1 row 16.

COMMIT: `git add -A && git commit -m "[EP-006][M8] secret handling, secret-scanning gate, and DLP-before-egress"`

### M9: SSRF controls and webhook signature with replay protection

GOAL: Every outbound fetch refuses a private, loopback, link-local, or metadata target
before the connection attempt, and every webhook route verifies an HMAC-SHA256 signature
over the raw bytes with a timestamp window and single-use replay token before any parsing
or dispatch.

READ: `SPEC-000` VG-SEC-003, VG-SEC-004, VG-SEC-001; `SPEC-003` §6.1–§6.4, §11.5;
`SPEC-006` §7.1 rows 21/22/23, §5.3 rows 13/25; `SECURITY.md`; `TOS_AUTOMATION_MATRIX.md`;
`src/domain/errors.ts` (`TaintedContentRejected`).

CHANGE: `src/adapters/ssrf/fetch-guard.ts`, `src/adapters/ssrf/target-classifier.ts`,
`src/http/webhooks/signature.ts` (if EP-004 has not created it),
`src/http/webhooks/replay.ts` (if not created by EP-004),
`tests/contract/ssrf-controls.test.ts`,
`tests/contract/webhook-signature-replay.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `src/adapters/ssrf/target-classifier.ts` — classifies a resolved target before any
  connection: loopback, private (RFC 1918 and unique-local IPv6), link-local, multicast,
  unspecified, carrier-grade NAT, and cloud metadata endpoints (including
  `169.254.169.254`) are refused regardless of the hostname used. The classifier resolves
  the name first and classifies **every** resolved address, so a DNS name pointing at a
  private address is refused; it re-checks after any redirect (redirects are refused by
  default, and where a redirect is followed the new target is re-classified). Scheme is a
  closed allowlist (`https` only for external fetches); a non-allowlisted scheme is
  refused.
- `src/adapters/ssrf/fetch-guard.ts` — the only outbound fetch path in the codebase. A
  refused target produces the classified error and **no** connection attempt, proven by an
  independent observation (a listener that must record zero connections) rather than by
  the caller's report. Required negative case (VG-SEC-003): a fetch to `169.254.169.254`
  and a fetch to `localhost` are each refused with zero connection attempts. Also assert
  mechanically that no module outside `src/adapters/ssrf/**` calls the platform fetch
  directly.
- Webhook signature verification (VG-SEC-004, SPEC-003 §6.1): the fixed order is resolve
  `X-VG-Key-Id` → check `X-VG-Timestamp` (±300 s) → check `X-VG-Nonce` shape → verify
  `X-VG-Signature` (`v1=<hex>`, HMAC-SHA256 over `"<timestamp>.<nonce>.<raw request body
  bytes>"`) with a **constant-time** comparison → check `X-VG-Event-Id`. No JSON parsing
  or normalisation precedes the signature check; the raw body is capped at 256 KiB. A
  failure at any step returns the mapped error and **no** state change.
- Replay protection (SPEC-003 §6.2): a repeated `X-VG-Nonce` is `409 WEBHOOK_NONCE_REPLAY`
  with no state change, rejected **once** and deterministically; a repeated event ID
  returns the stored original response with `200` and `X-VG-Webhook-Replayed: true`; the
  replay store unavailable fails **closed** with `503 DEPENDENCY_UNAVAILABLE` — never
  "accept and dedupe later".
- Taint (SPEC-003 §6.3): webhook bodies are tainted input; any field naming a channel,
  legal basis, truth state, budget, or idempotency key is ignored and its presence is
  audited as `IGNORED_CONTROL_FIELD`; free text is stored as evidence with
  `taint: "TAINTED"`. A webhook **never** sets a truth state directly; it dispatches
  exactly one domain command. A provider delivery callback is not a
  `VerificationObservation` and cannot satisfy T14.
- `tests/contract/ssrf-controls.test.ts` — one refusal case per target class, each with a
  zero-connection assertion, plus a DNS-name-to-private-address case and a
  redirect-to-private case. Required negative case: a successful fetch from a
  metadata-service address fails the gate.
- `tests/contract/webhook-signature-replay.test.ts` — credential-free logic proofs using
  an injected key resolver and an injected replay port: valid signature accepted; tampered
  body rejected; a signature computed over a re-serialised body rejected (proving the
  raw-bytes requirement); stale timestamp rejected; missing replay token rejected; unknown
  key rejected; byte-identical replay rejected once; repeated event ID returns the stored
  response; store-unavailable fails closed. Required negative cases: a body carrying
  `legalBasis`, `channel`, `truthState`, and `budgetOverride` produces an
  `IGNORED_CONTROL_FIELD` audit row and changes no policy, recipe, or action; a
  `SUBMISSION_ACCEPTED` provider callback does not produce `VERIFIED_REMOVED` and does not
  satisfy T14. The durable-store replay proof is `BLOCKED_CREDENTIALS` (`VALKEY_URL`) and
  the real-KMS key-resolution proof is `BLOCKED_CREDENTIALS` (`KEYCLOAK_ISSUER` /
  secret-manager credentials); both statuses are recorded, not hidden.

RUN:
```
node --test "tests/contract/ssrf-controls.test.ts"
node --test "tests/contract/webhook-signature-replay.test.ts"
sh -c 'sh scripts/probes/valkey_url.sh'; echo "probe exit: $?"
sh scripts/gate-security.sh
```

EXPECT: both suites pass for the credential-free logic paths; the Valkey probe exits
non-zero; `gate-security: ok` with `VALKEY_URL: BLOCKED_CREDENTIALS` in its output.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-006 MILESTONE_PASS "M9 SSRF refusals with zero connection attempts; webhook signature and replay logic: ok; durable replay BLOCKED_CREDENTIALS VALKEY_URL"`

FALLBACK: if the platform fetch cannot be intercepted cleanly for the zero-connection
assertion, route the outbound call through an explicit `undici`/`node:http` agent whose
connection callback the test observes, so the assertion remains an observation of the
transport rather than of the caller's own report. Do not weaken the assertion to "the
guard returned an error" — that is the caller's self-report, which SPEC-000 §9.2 and
DOD-012 explicitly do not accept.

COMMIT: `git add -A && git commit -m "[EP-006][M9] SSRF controls and webhook signature with replay protection"`

### M10: Security negative cases — revoked grants, scope violations, cross-tenant denial at both layers

GOAL: The three headline negative cases are executed and green: an expired or revoked
grant halts writes with no external effect; a scope violation is refused even when the
grant is otherwise valid; and cross-tenant access is denied independently by the service
layer **and** by RLS.

READ: `SPEC-005` §10 (VG-AUTH-022, VG-AUTH-024, VG-AUTH-025, VG-AUTH-031);
`SPEC-000` VG-TENANT-001/002, VG-AUTHZ-001; `SPEC-003` §3.2 items 4/5, §11.2
(VG-API-012/013/025); `SPEC-006` §7.1 rows 2/13, §5.3 row 16, §6.2 H-9;
`src/domain/errors.ts`; `.agent/DONE_LAW.md` DOD-014, DOD-018.

CHANGE: `tests/security/negative-cases.test.ts`,
`tests/integration/authority-at-execution.test.ts`,
`tests/integration/cross-tenant-both-layers.test.ts`,
`tests/integration/evidence-immutability.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `tests/security/negative-cases.test.ts` (credential-free) — for each of the three
  headline cases, assert the refusal **and** that it is a refusal rather than a failure:
  - **Expired / revoked grant halts writes (VG-AUTH-024).** Revoke a grant after the case
    reached `REQUEST_READY`; the next external-write attempt is refused with
    `409 AUTHORITY_EXPIRED` or `409 AUTHORITY_REVOKED`, **zero** `ExternalAction` rows are
    created, and the effect counter does not move. The assertion must cover the
    execution-time check specifically: a grant that was valid when the request was queued
    and expired before the write must still be refused (VG-ERR-029, the time-shifted-grant
    test).
  - **Scope violation refused (VG-AUTH-025).** A grant scoped for reading cannot write; a
    grant scoped for one subject cannot act for another; the refusal is
    `422 AUTHORITY_GRANT_SCOPE_INSUFFICIENT`, state is unchanged, and no external effect
    occurs.
  - **Cross-tenant denied at both layers (VG-AUTH-022, VG-API-013).** The service-layer
    check refuses independently, and RLS refuses independently. The integration half of
    this lives in `tests/integration/cross-tenant-both-layers.test.ts` and is
    **BLOCKED_CREDENTIALS** (`DATABASE_URL`) and **BLOCKED_PREREQUISITE** (EP-003 RLS
    policy). The credential-free half asserts the service-layer refusal and the
    client-facing behaviour: a resource owned by another tenant returns
    `404 RESOURCE_NOT_FOUND` with a body **byte-identical** to a genuinely absent
    resource, and the internal `TENANT_SCOPE_VIOLATION` code never appears in a body,
    header, or timing signal (SPEC-006 H-9).
- `tests/integration/authority-at-execution.test.ts` — real-PostgreSQL proof that the
  execution-time assertion reads the grant inside the write transaction (including a
  revoke committed between the read and the write in a concurrent transaction). Blocked on
  `DATABASE_URL` and EP-003; record as `BLOCKED_CREDENTIALS`/`BLOCKED_PREREQUISITE`.
- `tests/integration/cross-tenant-both-layers.test.ts` — two seeded tenants; (a) a query
  under tenant A returns zero rows for tenant B's data at the database layer; (b) with the
  service-layer check disabled **in the test harness only**, RLS still returns zero rows;
  (c) with RLS enabled, the service layer refuses. Blocked as above.
- `tests/integration/evidence-immutability.test.ts` — every delete and update path against
  evidence and audit is refused for every role including `TENANT_ADMIN` (VG-AUTH-031,
  VG-AUTHZ-017, VG-EVIDENCE-003); an attempted audit mutation fails; the route registry
  contains no audit or evidence mutation route. The credential-free portion (route
  absence, service-layer refusal) passes now; the database-grant-level portion (no `UPDATE`
  or `DELETE` privilege for the application role) is `BLOCKED_CREDENTIALS`.
- Each controlled defect is paired with a mutation check (DOD-018): removing the
  execution-time assertion, the scope assertion, or the tenant predicate must make the
  corresponding test fail. A permanently green test that cannot fail proves nothing.

RUN:
```
node --test "tests/security/negative-cases.test.ts"
sh -c 'sh scripts/probes/database_url.sh'; echo "probe exit: $?"
sh scripts/gate-security.sh
sh scripts/security-check.sh
```

EXPECT: the credential-free negative-case suite passes, including the
byte-identical-404 assertion and the zero-effect assertions; the database probe exits
non-zero so the integration suites record `BLOCKED_CREDENTIALS` with the probe command
and exit code and are **not** reported as passing; `gate-security: ok`;
`security check: ok` with its blocked suites named in output.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-006 MILESTONE_PASS "M10 negative cases: revoked grant halts writes; scope violation refused; cross-tenant service-layer denial; RLS half BLOCKED_CREDENTIALS DATABASE_URL"`

FALLBACK: if the two-layer integration proof cannot run because EP-003 has not created
the RLS policy, the correct action is to record `BLOCKED_PREREQUISITE` naming the missing
policy and keep the service-layer proof green — **not** to compensate by adding
application-layer tenant filtering as the only control, and **not** to substitute an
in-memory database. VG-TENANT-002 requires both layers to reject independently; one layer
is not the requirement.

COMMIT: `git add -A && git commit -m "[EP-006][M10] security negative cases: revoked grants, scope violations, cross-tenant denial"`

### M11: Node-level acceptance, blocked-work accounting, and close-out

GOAL: The node's gate and `security-check.sh` pass, every unverifiable item carries its
exact SPEC-006 §4.1 status with a blocking reference, the two external human gates are
recorded as `EXTERNAL_REQUIRED`, and no claim is stronger than its evidence.

READ: `.agent/DONE_LAW.md` (DOD-025, DOD-026, DOD-029, DOD-032, DOD-039); `SPEC-008` §1,
§2, §3, §9, §13; `SPEC-006` §4.1; `SPEC-005` §11; `LEGAL_REVIEW_REQUIRED.md`;
`.agent/verification/reports/RESIDUAL_RISK_AND_EXTERNAL_GATES.md`.

CHANGE: `scripts/gate-security.sh` (final form), `.agent/evidence/EP-006/**`,
`.agent/verification/state/TEST_LEDGER.jsonl`,
`.agent/verification/state/NEXT_ACTION.md`, `.agent/state/LEDGER.md`, `COMMANDS.md`.

CONTENT:

- Run the full credential-free security suite in a single pass and capture raw logs under
  `.agent/evidence/EP-006/` with content hashes in
  `.agent/verification/state/EVIDENCE_INDEX.jsonl` (DOD-025).
- Record every `VG-AUTH-*` and `VG-AUTHZ-*` ID this node owns in `TEST_LEDGER.jsonl` with
  the SPEC-006 §4.1 required fields. Expect at minimum:
  - `PASS` with command, exit code, sentinel, and evidence digest: VG-AUTH-020,
    VG-AUTH-021, VG-AUTH-023, VG-AUTH-024, VG-AUTH-025, VG-AUTH-026, VG-AUTH-027,
    VG-AUTH-028, VG-AUTH-029, VG-AUTH-030, VG-AUTH-031, VG-AUTH-032 and the
    `VG-AUTHZ-004`…`VG-AUTHZ-017` logic proofs, each bounded to what its command actually
    established.
  - `BLOCKED_CREDENTIALS` with `credentialRef`, `probeCommand`, `probeExitCode`, and
    `provisioningDocRef` (`PREFLIGHT.md` row): VG-AUTH-022 (RLS layer) on `DATABASE_URL`;
    realm MFA policy, refresh rotation, sender-constrained tokens, global sign-out, and
    administrative revocation on `KEYCLOAK_*`; durable rate-limit, replay, and idempotency
    counters on `VALKEY_URL`; KMS/secret-manager resolution on `CLOUD_WORKLOAD_IDENTITY`;
    `IAL3` verification vendor on its DPA-blocked credential.
  - `BLOCKED_PREREQUISITE` with `blockingDependency` and `dependencyEdgeRef`: the RLS
    second-layer proofs on the EP-003 RLS policy; the `/v1` route-level scope matrix
    proofs on EP-004's executed route catalogue.
  - **`EXTERNAL_REQUIRED`** with `externalPartyRole`, `requestedArtifactDigest`,
    `requestEvidencePath`, `requestedAt`, and `ownerContactRef`: counsel review of
    authorized-agent evidence requirements, minor-handling rules, and the acceptability of
    any particular identity-verification method (SPEC-005 §11); and named human UAT and
    accessibility validation of the verification flows (SPEC-005 §11, DOD-039).
- Append `NODE_DONE` for EP-006 **only** if every milestone above has a `MILESTONE_PASS`
  event carrying a real observed sentinel. Tag `green/EP-006`. Do **not** modify
  `.agent/verification/state/RELEASE_GATE.json`: the verdict remains `INCONCLUSIVE`,
  because the external gates are open, RLS is unproven, and no verification subgraph run
  or artefact exists (SPEC-008 §13).
- Do **not** write "the platform is secure", "MFA is enforced", "RLS protects tenant
  data", or "ready for production". The honest statement is: the credential-free security
  controls and their negative cases pass; realm configuration, RLS enforcement, durable
  counters, and KMS resolution are `BLOCKED_CREDENTIALS`/`BLOCKED_PREREQUISITE` on named
  dependencies; and counsel review plus human UAT/accessibility validation are
  `EXTERNAL_REQUIRED`.

RUN:
```
sh scripts/gate-security.sh
sh scripts/security-check.sh
sh scripts/secret-scan.sh
sh scripts/ledger.sh append <AGENT_ID> EP-006 NODE_DONE "EP-006 closed: gate-security: ok; security check: ok; realm/RLS/KMS BLOCKED_CREDENTIALS; counsel and UAT EXTERNAL_REQUIRED"
sh scripts/ledger.sh status EP-006
git tag green/EP-006
git log --oneline -1
sh scripts/graph-next.sh
```

EXPECT: `gate-security: ok`; `security check: ok`; `secret scan: ok`; `DONE` from
`ledger.sh status EP-006`; tag `green/EP-006` created; `graph-next.sh` prints
`NEXT EP-007`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-006 NODE_DONE "EP-006 closed: gate-security: ok; security check: ok; KEYCLOAK_ISSUER/DATABASE_URL/VALKEY_URL/CLOUD_WORKLOAD_IDENTITY BLOCKED_CREDENTIALS; counsel + UAT EXTERNAL_REQUIRED"`

FALLBACK: none. If either gate fails, the node stays open — do not tag, and do not narrow
a gate to make it pass.

COMMIT: `git add -A && git commit -m "[EP-006][M11] close auth/security node with blocked and external-gate accounting"`

## 9. Validation and Acceptance

1. `sh scripts/gate-security.sh` prints `gate-security: ok` and exits 0, and
   `sh scripts/security-check.sh` prints `security check: ok` and exits 0.
2. A token lacking `tenant_id` is rejected with `401 TOKEN_INVALID_CLAIMS` and no RLS
   session is opened (VG-AUTH-021).
3. A password-only session is refused and audited (VG-AUTH-020); `TENANT_ADMIN` and
   `OPERATOR` require WebAuthn.
4. A token presented to the wrong audience is `401 TOKEN_AUDIENCE_MISMATCH` and performs
   no work.
5. Every route's required scopes match the SPEC-003 §5 catalogue and the SPEC-005 §5
   matrix; a missing scope is `403 INSUFFICIENT_SCOPE` before any domain call; a `*` scope
   is `401 TOKEN_SCOPE_WILDCARD_FORBIDDEN` on every route (VG-API-014).
6. `TENANT_ADMIN` cannot approve its own `AuthorityGrant` (VG-AUTH-023).
7. **An expired or revoked grant halts writes** at execution time with no external effect
   and no state change, including when the grant expired after the request was queued
   (VG-AUTH-024, VG-AUTHZ-001, VG-ERR-029).
8. **A scope violation is refused** with `422 AUTHORITY_GRANT_SCOPE_INSUFFICIENT` even
   when the grant is otherwise valid; a read-scoped grant cannot write (VG-AUTH-025).
9. **Cross-tenant access is denied at both layers**: the service layer and RLS each
   reject independently; the client sees `404 RESOURCE_NOT_FOUND` byte-identical to a
   genuinely absent resource, and the internal `TENANT_SCOPE_VIOLATION` code never appears
   in a body or header (VG-AUTH-022, VG-TENANT-002, SPEC-006 H-9).
10. Step-up is required and enforced for all six sensitive operation classes; a stale
    `auth_level` is refused and never downgraded (VG-AUTH-026, VG-AUTH-005).
11. `SUPPORT` access is JIT, ≤60 minutes, single-tenant, reason-bearing, audited on entry,
    PII read, and exit; standing access is denied (VG-AUTH-028).
12. An agent tool cannot author policy, mint authority, approve an escalation, read audit
    or revealed PII, or write without a pre-existing `PolicyDecision`; an over-budget loop
    is capped `409 EFFECT_BUDGET_EXCEEDED` and audited (VG-AUTH-029, VG-API-072/073).
13. Secrets are absent from the database, logs, and images; the secret-scanning gate exits
    non-zero on a seeded finding and has no baseline auto-accept; a resolution failure
    makes no attempt and never falls back (VG-AUTH-030, VG-ERR-055).
14. Evidence and audit deletion is unavailable to every role, and no mutation route exists
    (VG-AUTH-031, VG-AUTHZ-017).
15. Agent enrollment notice reaches the subject's verified contact channel and is recorded
    on grant creation (VG-AUTH-032, VG-AUTHZ-014).
16. Every metadata-service, loopback, private, and link-local fetch target is refused with
    **zero** connection attempts, observed independently (VG-SEC-003).
17. Every webhook is signature-verified over the raw bytes before parsing, timestamp-
    windowed, single-use on its replay token, and idempotent on its event ID; the replay
    store unavailable fails closed (VG-SEC-004, VG-API-060/061).
18. No SPEC-006 §8 masking pattern exists in any gate script; the canary harness reports a
    zero-match result **and** detects its own seeded control leak (DOD-024, DOD-013,
    DOD-018).
19. Every milestone's evidence exists as a `MILESTONE_PASS` ledger row with a real
    observed sentinel, and every unverifiable row carries a SPEC-006 §4.1 status with its
    required fields — including `BLOCKED_CREDENTIALS` for `KEYCLOAK_*`, `DATABASE_URL`,
    `VALKEY_URL`, and `CLOUD_WORKLOAD_IDENTITY`; `BLOCKED_PREREQUISITE` for the EP-003 RLS
    policy and the EP-004 route catalogue; and `EXTERNAL_REQUIRED` for counsel review and
    human UAT/accessibility validation.

**Node VERIFY narrowing — requires owner ratification (§13 D1).** The stub header declared
`VERIFY: sh scripts/verify.sh` / `VERIFY_SENTINEL: verify: ok`. `verify.sh` requires all
fifteen mandated stages, including `preflight`, `format-check`, `dependency-audit`,
`reality-gate`, `artifact-identity`, and artifact-bound smoke/E2E/live-fire, which are
loud-fail placeholders owned by other nodes or cannot pass before a production artefact
exists (EP-009). Keeping the boilerplate would make this node permanently unclosable and
would create pressure to fake a green. This plan narrows **this node's** verify to
`sh scripts/gate-security.sh` / `gate-security: ok`, which covers this node's
deliverable and genuinely fails when the security suites fail. No stage is removed from
`verify.sh`; M1 strengthens `scripts/security-check.sh` from a loud-fail placeholder into
a real gate. Recorded in §13 D1, needs owner ratification.

**Never claim:** that the platform is "secure", "hardened", "MFA-enforced",
"RLS-protected", "compliant", or "production ready"; that the Keycloak realm is
configured; that any grant is legally sufficient; or that any `VG-AUTH-*` / `VG-AUTHZ-*`
row is satisfied whose dependency is unprovisioned or whose determination belongs to
counsel or a human participant. The ship verdict remains `INCONCLUSIVE`, and the open
external gates keep the ceiling at `CONDITIONAL_EXTERNAL_GATES` even after everything else
passes (SPEC-008 VG-SHIP-030).

## 10. Idempotence and Recovery

To re-enter this node cold:

1. Read `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`,
   `.agent/EXECUTION_RULES.md`, `.agent/DONE_LAW.md`, this plan, the specifications in
   §5, and `sh scripts/ledger.sh tail 30`.
2. Run `sh scripts/ledger.sh status EP-006`. If `DONE`, the node is closed.
3. Resume at the first milestone whose `Progress` checkbox is unchecked and which has no
   `MILESTONE_PASS` row in `.agent/state/LEDGER.md`. The ledger is authoritative if the
   two disagree; record the disagreement in §12.
4. Re-run the **previous** milestone's `RUN` block and confirm its sentinel still appears
   before starting the next one. Cached green is not green (SPEC-008 VG-SHIP-006).
5. Re-read every file named in that milestone's `READ` before editing. Authority and
   scope rules are the product's core safety control; editing them from memory is how a
   control silently stops holding.

Recovery properties:

- No milestone is destructive. Every one re-runs to the same result.
- If a security suite fails after a dependency or configuration change, that change is a
  new candidate epoch: prior evidence is invalidated, not reused (VG-REL-004, DOD-040).
- If a credential is absent, record `BLOCKED_CREDENTIALS` with `credentialRef`,
  `probeCommand`, and `probeExitCode`, and continue with the independent credential-free
  work. Blanket blocking is invalid (DOD-031).
- If a secret-scan finding appears, the correct action is to **remove the secret and
  rotate it**, then rerun. Adding a baseline entry, an ignore comment without a recorded
  owner and reason, or a narrower rule to make the gate pass is gate weakening and
  prohibited (DOD-027, SPEC-006 §8 row 8).
- If the same failure signature recurs three times, the bounded ladder terminates the
  attempt: stop, record the terminal state with all three attempt artefacts linked, and
  produce the structured blocked report (SPEC-006 §10.3, AGENTS.md STOP list).
- A security judgement that requires human authority — legal sufficiency, biometric or
  identity-method acceptability, a decision to accept a residual risk — is a STOP-list
  item: record it as `EXTERNAL_REQUIRED` with the request artefact and digest, and do not
  decide it.

## 11. Progress

- [ ] M1: Security foundation, discovery blanks, and this node's gate
- [ ] M2: Keycloak OIDC integration, token verification, and MFA enforcement
- [ ] M3: Role matrix, scope enforcement, and the API-boundary authorization gate
- [ ] M4: `AuthorityGrant` lifecycle and anti-fraudulent-enrollment controls
- [ ] M5: Step-up authentication across the six sensitive operation classes
- [ ] M6: JIT `SUPPORT` access, progressive lockout, rate limits, and enumeration inhibition
- [ ] M7: MCP and agent least privilege with effect budgets
- [ ] M8: Secret handling, the secret-scanning gate, and DLP-before-egress
- [ ] M9: SSRF controls and webhook signature with replay protection
- [ ] M10: Security negative cases — revoked grants, scope violations, cross-tenant denial at both layers
- [ ] M11: Node-level acceptance, blocked-work accounting, and close-out

## 12. Surprises & Discoveries

<!-- Append only observed, dated findings with the exact command that produced them. -->
<!-- KNOWN BEFORE EXECUTION, recorded so the executor is not surprised:
     - KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, SESSION_SECRET,
       LOCAL_MODEL_ENDPOINT, DATABASE_URL, VALKEY_URL, and CLOUD_WORKLOAD_IDENTITY are
       REQUIRED by PREFLIGHT.md and are not provisioned. Realm configuration, RLS
       enforcement, durable counters, and KMS resolution therefore cannot reach PASS.
     - No concrete audience string for the portal, service, or MCP client appears in the
       specifications read for this plan; SPEC-003 section 3.2 item 3 requires distinct
       audiences but names none. M1 records this as a discovery blank rather than an
       invented constant, and no milestone may hard-code an audience the realm does not
       issue.
     - AuthorityGrant kind vocabulary is split: SPEC-005 section 3 names SELF, AGENT,
       PARENT_GUARDIAN, LEGAL_REPRESENTATIVE; SPEC-003 section 5.2.1 shows the request
       enum SELF|AGENT|GUARDIAN|DEPENDENT. M4 resolves it with an explicit tested mapping
       and records the decision in the Decision Log; it must not be resolved silently.
     - The word permission appears legitimately in PermissionClass (SPEC-001 section 2,
       a Source property) and is forbidden elsewhere as an AuthorityGrant synonym. Use the
       token exactly; never use bare permission to mean an authority grant.
     - SPEC-006 section 12 item 13 records an open inconsistency about the HTTP status for
       a legitimate HUMAN_REQUIRED outcome (409 in SPEC-006 section 6.2 versus 200 on the
       route in SPEC-003 section 5.7.5). This node does not resolve it; it records the
       citation if a test surfaces it and leaves the specifications unedited.
     - EP-003 is largely unstarted, so the second enforcement layer required by
       VG-TENANT-002 does not exist and the two-layer proof is BLOCKED_PREREQUISITE in
       addition to BLOCKED_CREDENTIALS. -->

## 13. Decision Log

| # | Decision | Rationale | Status |
|---|---|---|---|
| D1 | Node verify narrowed from `sh scripts/verify.sh` to `sh scripts/gate-security.sh`. | The stub header was generic boilerplate; `verify.sh` cannot pass before a production artefact exists and while other nodes' stages are placeholders. Narrowing prevents pressure to fake a green and removes no stage from `verify.sh`. Follows the EP-000 D1 precedent. | PENDING OWNER RATIFICATION |
| D2 | `AuthorityGrant` kind vocabulary resolves to the SPEC-005 §3 set, with an explicit two-way mapping for the SPEC-003 §5.2.1 wire enum. | The two specifications name different sets. SPEC-005 is the authority-and-permissions specification and its §3 table is the evidenced-entity definition; an unmapped wire value must be refused rather than silently defaulted. | PENDING OWNER RATIFICATION |
| D3 | Audience strings are a discovery blank filled from the realm/client registration, never an invented constant. | SPEC-003 §3.2 item 3 requires distinct audiences but names none. A hard-coded audience that the realm does not issue would be a false control. | ACCEPTED |
| D4 | The node gate verifies credential-free security behaviour and names every dependency and human gate it does not verify. | A gate that silently skips realm, RLS, KMS, or human work is a masking defect (DOD-024); a gate that fails forever on an unprovisioned dependency blocks independent work (DOD-031). Naming the gap in the gate's own output is the honest third option. | ACCEPTED |
| D5 | Effect budgets live in two places by design: the domain budget is authoritative, the gateway and rate-limit ceilings are additional. | SPEC-003 §9.3 is explicit that the domain budget is authoritative and the gateway budget is a ceiling, never a substitute. Collapsing them would let a gateway limit mask a domain budget failure. | ACCEPTED |
| D6 | No mock is the sole proof of an integration claim; every suite that uses an isolation double states what it proves and records the real-dependency proof as blocked. | DOD-010 and SPEC-006 §7.2 both prohibit substituting a mock and reporting PASS. The suite header is where a cold executor finds out which claim they are looking at. | ACCEPTED |

## 14. Outcomes & Retrospective

<!-- Filled in only after the node closes, with real observed evidence. Include: which
     VG-AUTH / VG-AUTHZ rows reached PASS and on what command; which are
     BLOCKED_CREDENTIALS (with credentialRef and probe exit code), BLOCKED_PREREQUISITE
     (with the dependency edge), or EXTERNAL_REQUIRED (with the requesting artefact
     digest); the resolved audience blanks and the AuthorityGrant kind mapping decision;
     the secret-scan and canary results; and the exact commands whose sentinels were
     observed. Do not record any claim this node did not execute. -->
