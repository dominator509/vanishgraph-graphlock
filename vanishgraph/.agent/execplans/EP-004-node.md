NODE-META-BEGIN
ID: EP-004
DEPS: EP-003
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/gate-api.sh
VERIFY_SENTINEL: gate-api: ok
GREEN_TAG: green/EP-004
NODE-META-END

# EP-004 — API / Service Layer

## 1. Purpose / Big Picture

Build the Fastify `/v1` service boundary specified by SPEC-003: the single HTTP entry
point through which the Vite + React portal SPA and the MCP gateway reach the application
layer. At the end of this node the route catalogue of SPEC-003 §5 and SPEC-003 §6
exists as a real, running service that a black-box client can call, that fails closed
when a precondition cannot be established, and that refuses to invent a truth state.

The value of this node is not that HTTP requests get answered. It is that the boundary
becomes the place where four safety properties are enforced mechanically, before any
legal or privacy logic can be bypassed:

1. **No route sets a truth state.** A handler validates input, resolves the caller's
   tenant and scopes, dispatches **exactly one** SPEC-001 §6 application command, maps
   the result to a DTO, and returns (SPEC-003 §1, SPEC-001 §4.3 SM-6). `truthState` is
   read-only output produced by a guarded command.
2. **Tenant isolation is not application code.** `tenantId` is derived only from the
   validated token and is pushed into the PostgreSQL RLS session variable inside the
   request transaction (SPEC-003 §2.4, VG-TENANT-001/002).
3. **One intended external effect happens at most once.** Every effect-bearing route
   carries an `Idempotency-Key` and the boundary enforces replay/conflict semantics
   (SPEC-003 §4, VG-ACTION-001).
4. **Nothing in the response collapses two different facts.** `REQUEST_SUBMITTED` is
   not removal, `ACKNOWLEDGED` is not verification, `SEARCH_DELISTED` is not source
   deletion, a ratio never appears without its denominator (SPEC-003 §7.3/§7.4).

This node is **BLOCKED_CREDENTIALS** for a defined subset of its own acceptance.
`PREFLIGHT.md` marks `DATABASE_URL`, `VALKEY_URL`, and `KEYCLOAK_ISSUER` as `REQUIRED`
and none are provisioned. Where this plan cannot reach a real dependency it says so in
the milestone and records `BLOCKED_CREDENTIALS`; it never substitutes a mock and calls
it proof (DOD-010, DOD-020, SPEC-006 §7.2).

## 2. Scope

In scope:

- The Fastify service application, its plugin wiring, and its bootstrap/config
  validation.
- The `/v1` route catalogue of SPEC-003 §5 (17 groups, 5.1 … 5.17) and the webhook
  ingress of SPEC-003 §6.
- The application-contract layer that the HTTP layer calls (`src/application/**`):
  command/query interfaces, DTO shapes, and the port interfaces the handlers depend on.
- The error envelope, the closed code→status→message registry, and the domain-class to
  wire-code mapping of SPEC-006 §6.2.
- Request identity: bearer validation, required-claim checks, audience binding, scope
  checks, tenant resolution, correlation-ID propagation.
- `Idempotency-Key` handling: key validation, response storage, replay, conflict, and
  in-flight refusal.
- Cursor pagination (opaque, HMAC-signed, tenant-bound), strict filter/sort parsing,
  and the `page` object.
- Webhook ingress: signature verification over raw bytes, timestamp window, single-use
  replay token, idempotent event-ID handling, taint classification.
- Health/readiness/liveness that reflect real dependency state.
- Contract tests against the real HTTP boundary, integration tests against real
  PostgreSQL and Valkey, and black-box acceptance tests using public interfaces only.
- Additions to `COMMANDS.md` for every new command this node introduces.

## 3. Non-goals

- **No truth-state logic.** No handler decides a transition, and no handler contains a
  guard list. Guards live in the domain table (`src/domain/truth-state.ts`) and are
  evaluated by the application command (SPEC-001 §4.3 SM-6).
- **No persistence implementation.** Schema, migrations, RLS policies, repositories,
  and the PostgreSQL adapters are EP-003 deliverables. This node consumes those ports
  and is `BLOCKED_PREREQUISITE` on them.
- **No UI.** EP-005 owns every browser surface.
- **No authentication provider configuration.** Keycloak realm, clients, MFA policy,
  and token issuance are EP-006. This node validates tokens it is given and refuses
  everything else.
- **No discovery, channel, verification, or worker implementation.** Routes that would
  drive those workflows exist and dispatch their command, or they return the
  fail-closed code; they do not grow a local implementation.
- **No new route.** Anything not in SPEC-003 §5/§6 does not exist; a request to it is
  `404` (SPEC-003 §10 item 7).
- **No route may be widened.** A convenience route that returns an unmasked identifier
  in a list, exports in bulk, accepts a `tenantId` parameter, or accepts a bypass flag
  is a release blocker (SPEC-003 §10 items 1–3).
- No gate weakening, no sentinel printed from a path that performed no check, no mock
  presented as proof of an integration claim.

## 4. Context and Orientation

**Repository reality, as of this plan.** Do not overstate it:

| Element | Real state |
|---|---|
| `src/domain/` | Present: `errors.ts`, `truth-state.ts`, `state-machine.ts`, `values.ts`. |
| `tests/domain/` | Present: `state-machine.test.ts`, `values.test.ts`. |
| `src/application/`, `src/adapters/`, `src/http/`, `src/infrastructure/` | **Do not exist.** |
| `src/domain/ports` | **Not implemented.** SPEC-001 §5 declares the port list; no interface file exists yet. |
| EP-003 (Data & Persistence) | **Largely unstarted.** No schema, no migration, no repository, no RLS policy exists. |
| `package.json` | Two devDependencies (`typescript`, `@types/node`). **No runtime dependency at all** — no Fastify, no `pg`, no `jose`. |
| `tsconfig.json` | Strict, `noEmit: true`, `erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`, `allowImportingTsExtensions: true` with `rewriteRelativeImportExtensions`. |
| `scripts/test-integration.sh` | Loud-fail placeholder: `vg_loud_fail 'integration tests' 'EP-002'`, exits 1. |
| `scripts/security-check.sh` | Loud-fail placeholder, unblocked by EP-006. |
| `verify.sh` | Runs 15 stages in the mandated order and exits non-zero at the first placeholder. It prints `verify: ok` only when all fifteen genuinely pass. |

**Consequences that shape this plan.**

- `src/domain/` is the only implemented layer. Everything this node adds is above it,
  and the HTTP layer must reach the domain **only through application contracts**
  (`ARCHITECTURE.md` code law). The existing `scripts/import-boundary.sh` currently
  enforces this rule for `src/domain/**` only; M1 extends the scan so the rule is
  enforced for `src/application/**` and `src/http/**` too, rather than relying on
  convention.
- `tsconfig.json` has `noEmit: true` and `erasableSyntaxOnly: true`. The build
  configuration `tsconfig.build.json` is what emits; new source must stay
  erasable-syntax clean (no parameter properties, no enums, no namespaces).
- `scripts/test-integration.sh` cannot pass in this node's own right: as written it
  fails loudly and is unblocked by EP-002/EP-003 work that has not happened. M1 gives
  it a real implementation that runs this node's integration suites and fails closed
  when a required credential is absent — it does **not** get weakened, and it must not
  be made to print a sentinel on a path that skipped the suites.
- `verify.sh` therefore cannot print `verify: ok` at the end of this node. See §9 for
  how that is handled honestly, and §13 D1.

**Layer map this node creates.**

```
src/domain/**          existing. Imports nothing but node:* and relative paths.
src/application/**     NEW. Imports domain only. One module per SPEC-001 §6 command,
                       plus query services and the DTO/contract types.
src/adapters/**        NEW. Implements SPEC-001 §5 ports and the persistence ports.
src/http/**            NEW. Fastify plugins, routes, schemas, error mapper, identity.
src/infrastructure/**  NEW. Composition root, config validation, dependency construction.
```

## 5. Files to Read First

Governance and law:

- `AGENTS.md`, `.agent/EXECUTION_RULES.md`, `.agent/PLANS.md`, `.agent/LOOPS.md`
- `.agent/GRAPH.md`, `.agent/DONE_LAW.md` (42 clauses; DOD-001/004/007/010/011/012/013/
  014/017/018/019/024/025/026/027/032)
- `.agent/state/LEDGER.md`, `.agent/checklists/implementation.md`,
  `.agent/checklists/validation.md`
- `COMMANDS.md` (the closed command list; new commands are added here, never invented)

Specifications (normative, in conflict order — SPEC-000 wins):

- `.agent/specs/SPEC-000-product-scope.md` — vocabulary lock §4, truth model §5,
  non-collapse §5.1, coverage honesty §7, acceptance oracle §9
- `.agent/specs/SPEC-001-core-domain.md` — layer contract §1, value objects §2,
  transition table §4.1, illegal transitions §4.2, invariants §4.3, ports §5,
  commands §6, events §7
- `.agent/specs/SPEC-002-data-model.md` — tenancy, RLS, `app.tenant_id`, retention
- `.agent/specs/SPEC-003-api-contracts.md` — the whole of it; §2 conventions,
  §3 authz at the boundary, §4 idempotency, §5 route catalogue, §6 webhooks,
  §7 DTO rules, §8 error envelope, §10 non-goals, §11 `VG-API-001`…`VG-API-074`
- `.agent/specs/SPEC-005-auth-permissions.md` — role matrix §2, authority §3,
  identity levels §4, authorization matrix §5, step-up §6, MCP §7, secrets §8,
  rate limits §9, `VG-AUTH-020`…`VG-AUTH-032`
- `.agent/specs/SPEC-006-errors.md` — classification law §2, error catalogue §5,
  HTTP mapping §6.2 (the code→status→message table), fail-closed matrix §7.1,
  no-masking §8, no-PII-in-errors §9, retry/ladder §10
- `.agent/specs/SPEC-007-observability.md` — correlation ID, redaction, egress classes
- `.agent/specs/SPEC-008-production-readiness.md` — verdicts, epochs, artifact binding

Existing code (read before changing anything):

- `src/domain/errors.ts`, `src/domain/truth-state.ts`, `src/domain/state-machine.ts`,
  `src/domain/values.ts`
- `tests/domain/state-machine.test.ts`, `tests/domain/values.test.ts`
- `package.json`, `tsconfig.json`, `tsconfig.build.json`
- `scripts/verify.sh`, `scripts/test-integration.sh`, `scripts/import-boundary.sh`,
  `scripts/gate-toolchain.sh`, `scripts/preflight.sh`, `scripts/lib/loud-fail.sh`
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt`

Project documents:

- `ARCHITECTURE.md`, `SECURITY.md`, `PREFLIGHT.md`, `.env.example`,
  `DATA_EGRESS_MATRIX.md`, `TOS_AUTOMATION_MATRIX.md`, `TESTING.md`, `ENVIRONMENT.md`,
  `DECISIONS.md` (ADR-001/ADR-016 PostgreSQL with a Postgres-native durable job queue, ADR-003 unclear writes are human-only, ADR-008 Kysely + SQL-first migrations)
- `PROJECT_RESEARCH_BRIEF.md` §3 (California DROP), §5 (provider transports)
- `.agent/verification/GRAPH.md`, `.agent/verification/stage-plans/V-009-api-integration-and-concurrency.md`,
  `.agent/verification/stage-plans/V-013-dynamic-security-and-domain-packs.md`

## 6. Expected Changed Files

Created:

- `src/application/**` — one module per SPEC-001 §6 command, query services, DTO and
  contract types (`src/application/contracts/**`).
- `src/domain/ports/**` — the port interfaces this node binds: idempotency store, audit
  sink, secret resolver, clock and ID generator. All of these are declared by EP-002
  under SPEC-001 §5.1, because each expresses a domain rule (at-most-once, append-only
  audit, secret handling, time, identity). This node implements their adapters; it must
  not re-declare them.
- `src/adapters/idempotency/**`, `src/adapters/audit/**`, `src/adapters/config/**` —
  adapters that do not depend on a credential.
- `src/adapters/persistence/**`, `src/adapters/coordination/**` — PostgreSQL and Valkey
  adapters (credential-dependent; see M6/M7).
- `src/http/**` — `server.ts`, `plugins/` (identity, tenancy, idempotency, rate limit,
  correlation, error handler), `schemas/`, `routes/**` (one file per SPEC-003 §5 group),
  `webhooks/**`, `errors/code-registry.ts`, `errors/envelope.ts`,
  `pagination/cursor.ts`, `openapi/registry.ts`.
- `tests/contract/**` — the route-registry, envelope, and mapping contract tests.
- `tests/integration/**` — real-PostgreSQL and real-Valkey suites.
- `tests/blackbox/**` — public-interface acceptance tests (DOD-011).
- `scripts/gate-api.sh` — this node's gate (see §9 and §13 D1).
- `tsconfig.service.json` — build configuration for the service layers.
- `.agent/evidence/EP-004/**` — evidence index entries for this node.

Modified:

- `package.json`, `package-lock.json` — add pinned runtime dependencies.
- `COMMANDS.md` — add every command this node introduces, with its sentinel.
- `ARCHITECTURE.md` — record the realised layer inventory and the service wiring.
- `ASSUMPTIONS.md` — update rows this node's evidence changes.
- `scripts/test-integration.sh` — real implementation (currently a loud-fail placeholder).
- `scripts/import-boundary.sh` — extend the boundary scan to the new layers.
- `tsconfig.json` — only if a new include path is required; keep `strict` settings.
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt` — add every new suite.
- `.agent/state/LEDGER.md` — milestone evidence.

Nothing else may change. Any other diff is a scope violation and must be reverted
before the milestone is committed.

## 7. Interfaces and Contracts

Vocabulary (SPEC-000 §4) — canonical tokens only, and only these, in code identifiers,
route paths, field names, log keys, metric labels, test names, and ledger entries:
`ProtectedSubject`, `AuthorityGrant`, `Source`, `RemovalRecipe`, `SourceRecord`,
`Exposure`, `Confidence`, `PolicyDecision`, `RequestCase`, `ExternalAction`,
`IdempotencyKey`, `VerificationObservation`, `Reappearance`, `EvidenceArtifact`,
`Controller`, `HumanGate`, `DLP`. The eleven truth-state tokens are the only status
vocabulary. Two HTTP-layer tokens are allowlisted by exact name and for no other
purpose: `X-Request-Id` and the envelope field `requestId` (SPEC-003 §7.3, VG-API-067).

Boundary contract (SPEC-003 §1) — every handler:

1. validates input against a route schema;
2. resolves `tenantId` and `scopes` from the validated access token only;
3. dispatches exactly one application command or query;
4. maps the result to a DTO from the closed DTO set;
5. never sets, writes, or accepts a truth state as input.

Route catalogue (SPEC-003 §5) — 17 groups and 5.17 health:

| Group | Routes | Required scope (representative) | Idempotency |
|---|---|---|---|
| 5.1 subjects/aliases/identifiers | 10 | `vg.subjects.read`/`.write` | Required on writes |
| 5.2 authority grants | 3 | `vg.authority.read`/`.write` + step-up | Required |
| 5.3 sources/catalogue/recipes | 10 | `vg.sources.read`/`.write`, `vg.recipes.write` | Required on writes |
| 5.4 discovery runs and source records | 5 | `vg.discovery.run`, `vg.discovery.read`, `vg.exposures.read` | Required on run start |
| 5.5 exposures and match assessment | 5 | `vg.exposures.read`/`.assess` | Required on writes |
| 5.6 policy decisions | 4 | `vg.policy.read`/`.write` | Required on resolution |
| 5.7 cases | 6 | `vg.cases.read`/`.write` | Required on writes |
| 5.8 external actions | 6 | `vg.actions.read`/`.execute` + step-up | **Required-if-effect** |
| 5.9 controller responses | 3 | `vg.cases.read`/`.write` | Required |
| 5.10 verification observations | 3 | `vg.observations.read`/`.write` | Required |
| 5.11 reappearances | 3 | `vg.observations.read`/`.write` | Required |
| 5.12 evidence artifacts | 5 | `vg.evidence.read`/`.read_content`/`.write` | Required |
| 5.13 deadlines | 3 | `vg.cases.read`/`.write` | Required on writes |
| 5.14 appeals and escalations | 3 | `vg.appeal.write` + step-up | Required |
| 5.15 audit query | 2 | `vg.audit.read` | Optional (read-only stream) |
| 5.16 coverage and effectiveness | 3 | `vg.coverage.read` | Optional |
| 5.17 health/ready/live | 3 | **no bearer token** | n/a |

Webhook ingress (SPEC-003 §6) — the only unauthenticated-by-bearer write surface:
`POST /v1/webhooks/controller-callbacks/{controllerCallbackToken}`,
`POST /v1/webhooks/provider-callbacks/{providerKeyId}`,
`POST /v1/webhooks/mail-tracking/{mailProviderKeyId}`. All three require
`X-VG-Key-Id`, `X-VG-Timestamp`, `X-VG-Nonce`, `X-VG-Signature`, `X-VG-Event-Id`;
verification order is fixed and the HMAC covers the **raw** bytes before parsing.

Error envelope (SPEC-003 §8.1 / SPEC-006 §6.1) — every non-2xx response has this body
and only this body:

```json
{
  "error": {
    "code": "ILLEGAL_TRANSITION",
    "message": "The requested state change is not permitted from the current state.",
    "requestId": "req_01H",
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

`message` is a **fixed, non-interpolated template per code** (SPEC-006 H-3). `details`
keys are allowlisted per code (SPEC-006 H-13). Nothing in an error body carries PII,
an identifier value, a secret, a token, an `IdempotencyKey` value, SQL, a host name, or
a stack trace (SPEC-003 §8.3, SPEC-006 §9.1). `409` is resource/state conflict; `422`
is request/guard semantics; `412`/`428` are the concurrency token only.

Idempotency (SPEC-003 §4) — uniqueness scope
`(tenantId, method, routeTemplate, idempotencyKey)`; stored on completion: response
status, response body, SHA-256 of the canonicalised request body, resulting resource
ID, `traceparent`, `completedAt`. Replay of an identical fingerprint returns the
**original** status and body with `Idempotency-Replayed: true`. Same key + different
fingerprint is `409 IDEMPOTENCY_KEY_REUSE`. Same key while in flight is
`409 IDEMPOTENCY_IN_FLIGHT` with `Retry-After`. Absent on a Required route is
`400 IDEMPOTENCY_KEY_REQUIRED`. A replayed 2xx is never counted as a new effect: effect
counts are distinct `(caseId, idempotencyKey)` pairs (VG-API-020).

Pagination (SPEC-003 §2.5) — `limit` (1–100, default 25) and opaque `cursor` only; no
`offset` anywhere. `page` is
`{"limit":25,"nextCursor":null,"hasMore":false,"sort":"observedAt:desc","filter":{…}}`.
A cursor is HMAC-signed, tenant-, route-, filter-, and sort-bound; a foreign cursor is
`400 INVALID_CURSOR`. Strict query parsing: unknown parameter is
`400 UNKNOWN_QUERY_PARAMETER`; unknown `truthState` token is `400 INVALID_TRUTH_STATE`;
more than 20 values in one filter is `400 FILTER_TOO_BROAD`.

## 8. Milestones

### M1: Service foundation, layer boundary, and this node's gate

GOAL: A runnable Fastify application exists in a pinned, locked dependency set; the
import-boundary gate enforces the layer rule for the new layers; and this node has a
gate that genuinely fails when the contract suites fail.

READ: `ARCHITECTURE.md`, `package.json`, `package-lock.json`, `tsconfig.json`,
`tsconfig.build.json`, `scripts/import-boundary.sh`, `scripts/gate-toolchain.sh`,
`COMMANDS.md`, `SPEC-001` §1, `SPEC-003` §1/§2.1, `.agent/DONE_LAW.md` DOD-007/DOD-024.

CHANGE: `package.json`, `package-lock.json`, `tsconfig.service.json`,
`src/http/server.ts`, `src/http/plugins/**.ts`, `src/http/routes/health.ts`,
`src/http/openapi/registry.ts`, `src/infrastructure/config.ts`,
`src/application/contracts/index.ts`, `tests/contract/route-registry.test.ts`,
`scripts/gate-api.sh`, `scripts/import-boundary.sh`, `scripts/test-integration.sh`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `COMMANDS.md`, `ARCHITECTURE.md`,
`ASSUMPTIONS.md`, `.agent/state/LEDGER.md`.

CONTENT:

1. `package.json` — add runtime dependencies pinned to exact versions (no `^`/`~`):
   `fastify`, `@fastify/type-provider-json-schema-to-ts` (or equivalent schema typing),
   `pg`, `ioredis`, `jose`, `pino`. Add scripts `serve`, `build:service`,
   `test:contract`, `test:integration`. Record the resolved versions in
   `ARCHITECTURE.md`. Rationale for each dependency in one line in the commit body:
   HTTP framework, schema-typed validation, PostgreSQL driver, Valkey client, OIDC
   JWKS/JWT verification, structured logging.
2. `tsconfig.service.json` — build configuration that compiles `src/**` (excluding
   `src/domain/**`'s `noEmit` treatment only if it must be included) to `dist/`, with
   `noEmit: false`, `declaration: true`, `sourceMap: true`, and the same strict flags
   as `tsconfig.json`. Keep `erasableSyntaxOnly` and `verbatimModuleSyntax`.
3. `src/infrastructure/config.ts` — reads and validates configuration, fails closed:
   absent `DATABASE_URL`, `VALKEY_URL`, `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`,
   `SESSION_SECRET` each abort bootstrap with the message
   `dependency unavailable: <ENV_NAME> is unset; see PREFLIGHT.md and .env.example`.
   It must never invent a default, never fall back to an in-process substitute, and
   never log a value — only the variable name (SPEC-006 §9.1 rule 3,
   `.agent/verification/HARNESS_LAWS.md` NM-* rules).
4. `src/http/server.ts` — builds the Fastify instance, registers plugins in a fixed
   order (correlation → error handler → identity → tenancy → routes), exports
   `buildServer(deps)` and leaves `listen` to a separate entry point so tests can use
   `app.inject`. Server construction never touches the network.
5. `src/http/openapi/registry.ts` — a single source of truth listing every route as
   `{ method, path, group, scopes, idempotency, successStatus, serves: ['VG-API-0NN'] }`.
   `src/http/routes/**` registers against this registry; the registry is what the
   contract tests and the OpenAPI document read. A route not in the registry is a
   defect.
6. `src/http/routes/health.ts` — real `/v1/health`, `/v1/ready`, `/v1/live` per
   SPEC-003 §5.17, backed by injected probe functions so a failing probe makes `/ready`
   return `503` with the failed check named. No static `200` is permitted (VG-API-059).
7. `scripts/import-boundary.sh` — extend the existing scan with two additional rules
   and keep the existing `src/domain/**` rule byte-for-byte in force:
   (a) `src/application/**` may import only `node:*`, relative paths, and `src/domain`;
   (b) `src/http/**` may import only `node:*`, relative paths, and `src/application`
   (never `src/domain` internals directly, never `src/adapters`).
   Print `import boundary: ok` only when all three rules hold; list offending
   specifiers and the file that contains them otherwise.
8. `scripts/test-integration.sh` — replace the loud-fail body with a real runner that
   executes `tests/integration/**` via `node --test`, requires every suite named in
   `.agent/verification/EXPECTED_TEST_MANIFEST.txt` that lives under `tests/integration/`
   to report at least one test, and fails closed with
   `integration tests: BLOCKED_CREDENTIALS - <ENV_NAME> is unset (probe: sh scripts/probes/<probe>.sh)`
   and exit 1 when a required credential is absent. It prints
   `integration tests: ok` **only** when the suites actually ran and passed. Do not
   make it pass by skipping.
9. `scripts/gate-api.sh` — this node's gate. Real content:

```sh
#!/usr/bin/env sh
# EP-004 API/service node gate.
#
# SCOPE, STATED HONESTLY: this gate verifies only what can be verified without a
# provisioned external dependency: that the service type-checks, that the layer
# import boundary holds, that the route registry matches SPEC-003, that the error
# mapping is internally consistent, and that the credential-free contract and
# black-box suites pass. It does NOT verify anything that needs PostgreSQL, Valkey,
# or Keycloak, and it says so in its output on every run. It never reports those as
# passing, and it never substitutes a mock for them (DOD-010, DOD-020).
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

[ -f src/http/server.ts ] || { echo "ep004 api gate: FAIL - src/http/server.ts is missing" >&2; exit 1; }
[ -f src/http/openapi/registry.ts ] || { echo "ep004 api gate: FAIL - route registry is missing" >&2; exit 1; }
[ -f src/http/errors/code-registry.ts ] || { echo "ep004 api gate: FAIL - error code registry is missing" >&2; exit 1; }

npx --no-install tsc --noEmit || { echo "ep004 api gate: FAIL - typecheck failed" >&2; exit 1; }
sh scripts/import-boundary.sh || { echo "ep004 api gate: FAIL - layer import boundary violated" >&2; exit 1; }

node --test "tests/contract/**/*.test.ts" || { echo "ep004 api gate: FAIL - contract tests failed" >&2; exit 1; }
node --test "tests/blackbox/**/*.test.ts" || { echo "ep004 api gate: FAIL - black-box acceptance tests failed" >&2; exit 1; }

echo "ep004 api gate: UNVERIFIED-BY-THIS-GATE (credential-dependent, recorded as BLOCKED_CREDENTIALS):"
for pair in "DATABASE_URL:sh scripts/probes/database_url.sh" \
            "VALKEY_URL:sh scripts/probes/valkey_url.sh" \
            "KEYCLOAK_ISSUER:sh scripts/probes/keycloak.sh"; do
  name=${pair%%:*}; probe=${pair#*:}
  if sh -c "$probe" >/dev/null 2>&1; then
    echo "  - ${name}: probe ok"
  else
    echo "  - ${name}: BLOCKED_CREDENTIALS (probe: ${probe})"
  fi
done

echo "gate-api: ok"
```

10. `COMMANDS.md` — add, each with its sentinel, on the same line style as the existing
    file: `sh scripts/gate-api.sh` (`gate-api: ok`); `npm run test:contract`;
    `npm run test:integration`; `npx tsc -p tsconfig.service.json` (build, `build: ok`
    via `scripts/build.sh` once this node extends it); `sh scripts/import-boundary.sh`
    (`import boundary: ok`); `sh scripts/test-integration.sh` (`integration tests: ok`);
    `node --test "tests/contract/**/*.test.ts"`; `node --test "tests/blackbox/**/*.test.ts"`
    (`npm run test:contract` and `npm run test:integration` are the declared entry points
    and are what the gate and the milestones actually invoke; the `node --test` forms are
    listed beside them so the mapping between command and suite is explicit).
    The credential probes `sh scripts/probes/database_url.sh`,
    `sh scripts/probes/valkey_url.sh`, and `sh scripts/probes/keycloak.sh` are already
    declared by `PREFLIGHT.md` and are used here deliberately — they are the mechanism by
    which `BLOCKED_CREDENTIALS` is evidenced, so their exact paths appear in every `RUN`
    block that reports it.
    The governing rule: a command may not be used before it is declared (AGENTS.md).
11. `.agent/verification/EXPECTED_TEST_MANIFEST.txt` — add `tests/contract/route-registry.test.ts`.
12. `ARCHITECTURE.md` — add the realised layer map from §4 and the dependency table with
    exact versions. `ASSUMPTIONS.md` — update the "No credentials supplied" row with the
    M1 probe evidence.

RUN:
```
node --version
npm --version
npm install --no-audit --no-fund
npx --no-install tsc --noEmit
sh scripts/import-boundary.sh
node --test "tests/contract/**/*.test.ts"
sh scripts/probes/database_url.sh; echo "probe exit: $?"
sh scripts/probes/valkey_url.sh; echo "probe exit: $?"
sh scripts/probes/keycloak.sh; echo "probe exit: $?"
sh scripts/gate-api.sh
git status --short
```

EXPECT: `import boundary: ok`; the contract suite passes; each probe prints
`BLOCKED_CREDENTIALS`-bearing failure output with a non-zero exit code (none of
`DATABASE_URL`, `VALKEY_URL`, `KEYCLOAK_ISSUER` is provisioned — this is the current
true state, not a defect to work around); the final line `gate-api: ok`; and
`git status --short` listing only files from §6. `verify.sh` does **not** print
`verify: ok` at this node and must not be made to.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-004 MILESTONE_PASS "M1 gate-api: ok; import boundary: ok; DATABASE_URL/VALKEY_URL/KEYCLOAK_ISSUER BLOCKED_CREDENTIALS"`

FALLBACK: if Fastify's JSON-schema type provider proves incompatible with
`erasableSyntaxOnly`/`verbatimModuleSyntax`, drop the type provider and validate with
hand-written JSON Schema plus explicit narrowing functions — a simpler, real
implementation with no behavioural loss. Do not disable the strict compiler flags and
do not hand-roll a bespoke HTTP server.

COMMIT: `git add -A && git commit -m "[EP-004][M1] service foundation, layer boundary gate, and node gate"`

### M2: Error envelope, code registry, and HTTP mapping

GOAL: Every non-2xx response is the single SPEC-003 §8.1 envelope, produced from a
closed code registry whose statuses and messages are machine-compared against
SPEC-006 §6.2.

READ: `.agent/specs/SPEC-006-errors.md` §5.1/§5.2/§5.3/§5.4/§6.1/§6.2, §7.1, §9.1, §11.5;
`.agent/specs/SPEC-003-api-contracts.md` §8.1/§8.2/§8.3/§8.4;
`src/domain/errors.ts`, `src/domain/state-machine.ts`.

CHANGE: `src/http/errors/code-registry.ts`, `src/http/errors/envelope.ts`,
`src/http/errors/templates.ts`, `src/http/plugins/error-handler.ts`,
`tests/contract/error-envelope.test.ts`, `tests/contract/error-mapping-parity.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT: transcribe `src/http/errors/code-registry.ts` with the closed table below.
This is the complete SPEC-006 §6.2 domain-class mapping; every row is data, not prose.
The `message` column is the byte-exact template from SPEC-006 §6.2 — do not paraphrase,
do not interpolate.

```ts
/**
 * The closed /v1 error-code registry.
 *
 * SPEC BASIS: SPEC-003 §8.2 (the contract) and SPEC-006 §6.2 (the taxonomy side).
 * SPEC-006 H-7 requires the two files never to list different statuses for the same
 * code; tests/contract/error-mapping-parity.test.ts enforces that mechanically by
 * reading both specification files and comparing them to this table.
 *
 * `domainCode` is the token used in audit, telemetry and the internal error registry.
 * `wireCode` is the only token that may appear in a response body. They differ for
 * several classes on purpose: the internal token names the cause, the wire token is
 * the contract.
 */
export interface ErrorCodeSpec {
  readonly domainCode: string;
  readonly wireCode: string;
  readonly status: number;
  readonly message: string;
  readonly retryable: boolean;
}

export const ERROR_CODE_REGISTRY: readonly ErrorCodeSpec[] = Object.freeze([
  { domainCode: 'ILLEGAL_TRANSITION', wireCode: 'ILLEGAL_TRANSITION', status: 409, retryable: false,
    message: 'The requested state change is not permitted from the current state.' },
  { domainCode: 'AUTHORITY_EXPIRED', wireCode: 'AUTHORITY_EXPIRED', status: 409, retryable: false,
    message: 'The authority grant for this case is no longer valid.' },
  { domainCode: 'AUTHORITY_EXPIRED', wireCode: 'AUTHORITY_REVOKED', status: 409, retryable: false,
    message: 'The authority grant for this case was revoked.' },
  { domainCode: 'AUTHORITY_MISSING', wireCode: 'AUTHORITY_INVALID', status: 409, retryable: false,
    message: 'No valid authority grant is bound to this case.' },
  { domainCode: 'AUTHORITY_SCOPE_VIOLATION', wireCode: 'AUTHORITY_GRANT_SCOPE_INSUFFICIENT', status: 422, retryable: false,
    message: 'The authority grant does not cover the requested action.' },
  { domainCode: 'POLICY_UNRESOLVED', wireCode: 'JURISDICTION_UNRESOLVED', status: 422, retryable: false,
    message: 'No jurisdiction policy resolves for this request.' },
  { domainCode: 'POLICY_UNRESOLVED', wireCode: 'LEGAL_BASIS_NOT_IN_POLICY_VERSION', status: 422, retryable: false,
    message: 'The requested legal basis does not exist in the policy version in force.' },
  { domainCode: 'NO_LAWFUL_BASIS', wireCode: 'NO_LAWFUL_BASIS', status: 409, retryable: false,
    message: 'No lawful removal path exists for this record.' },
  { domainCode: 'RECIPE_STALE', wireCode: 'RECIPE_STALE', status: 409, retryable: false,
    message: 'The removal recipe for this source is stale.' },
  { domainCode: 'RECIPE_UNSIGNED', wireCode: 'RECIPE_UNSIGNED', status: 409, retryable: false,
    message: 'The removal recipe for this source failed signature verification.' },
  { domainCode: 'RECIPE_UNSIGNED', wireCode: 'RECIPE_SIGNATURE_INVALID', status: 422, retryable: false,
    message: 'The submitted recipe signature could not be verified.' },
  { domainCode: 'PERMISSION_CLASS_UNCLEAR', wireCode: 'SOURCE_PERMISSION_UNCLEAR', status: 409, retryable: false,
    message: 'The write permission class for this source is unclear; writes are disabled.' },
  { domainCode: 'IDEMPOTENCY_CONFLICT', wireCode: 'IDEMPOTENCY_KEY_REUSE', status: 409, retryable: false,
    message: 'This idempotency key was already used for a different request.' },
  { domainCode: 'IDEMPOTENCY_CONFLICT', wireCode: 'IDEMPOTENCY_IN_FLIGHT', status: 409, retryable: true,
    message: 'A request with this idempotency key is still in flight.' },
  { domainCode: 'IDEMPOTENCY_CONFLICT', wireCode: 'IDEMPOTENCY_KEY_REQUIRED', status: 400, retryable: false,
    message: 'An Idempotency-Key header is required for this operation.' },
  { domainCode: 'BUDGET_EXCEEDED', wireCode: 'EFFECT_BUDGET_EXCEEDED', status: 409, retryable: false,
    message: 'The action budget for this subject, source, and window is exhausted.' },
  { domainCode: 'TAINTED_CONTENT_REJECTED', wireCode: 'TAINTED_CONTENT_REJECTED', status: 422, retryable: false,
    message: 'Untrusted content cannot direct this operation.' },
  { domainCode: 'EGRESS_DENIED', wireCode: 'EGRESS_DENIED', status: 403, retryable: false,
    message: 'This data class may not leave the system under the current policy.' },
  { domainCode: 'DIGEST_MISMATCH', wireCode: 'EVIDENCE_INTEGRITY_FAILURE', status: 409, retryable: false,
    message: 'A stored artifact failed integrity verification.' },
  { domainCode: 'DIGEST_MISMATCH', wireCode: 'EVIDENCE_DIGEST_MISMATCH', status: 422, retryable: false,
    message: 'The supplied digest does not match the received content.' },
  { domainCode: 'DIGEST_MISMATCH', wireCode: 'EVIDENCE_DIGEST_MALFORMED', status: 422, retryable: false,
    message: 'The supplied digest is not a valid SHA-256 value.' },
  { domainCode: 'TENANT_SCOPE_VIOLATION', wireCode: 'RESOURCE_NOT_FOUND', status: 404, retryable: false,
    message: 'The requested resource was not found.' },
  { domainCode: 'OBSERVATION_NOT_INDEPENDENT', wireCode: 'OBSERVATION_PATH_NOT_INDEPENDENT', status: 422, retryable: false,
    message: 'The observation does not use a path independent of the action.' },
  { domainCode: 'OBSERVATION_WINDOW_NOT_MET', wireCode: 'OBSERVATION_WINDOW_NOT_MET', status: 422, retryable: true,
    message: 'The required observation window has not yet elapsed.' },
  { domainCode: 'VERIFICATION_METHOD_MISMATCH', wireCode: 'OBSERVATION_METHOD_MISMATCH', status: 422, retryable: false,
    message: "The observation method does not match the recipe's verification method." },
  { domainCode: 'HUMAN_GATE_REQUIRED', wireCode: 'HUMAN_GATE_OPEN', status: 422, retryable: false,
    message: 'A human gate is open for this case; automation cannot proceed.' },
  { domainCode: 'HUMAN_GATE_REQUIRED', wireCode: 'HUMAN_STEP_REQUIRED', status: 422, retryable: false,
    message: 'A human step is required before this operation can continue.' },
  { domainCode: 'INVALID_VALUE_OBJECT', wireCode: 'SCHEMA_VALIDATION_FAILED', status: 400, retryable: false,
    message: 'The request body is malformed.' },
  { domainCode: 'AUDIT_UNAVAILABLE', wireCode: 'DEPENDENCY_UNAVAILABLE', status: 503, retryable: true,
    message: 'A required dependency is unavailable; the operation was not performed.' },
  { domainCode: 'STORAGE_UNAVAILABLE', wireCode: 'DEPENDENCY_UNAVAILABLE', status: 503, retryable: true,
    message: 'A required dependency is unavailable; the operation was not performed.' },
  { domainCode: 'DEPENDENCY_UNAVAILABLE', wireCode: 'DEPENDENCY_UNAVAILABLE', status: 503, retryable: true,
    message: 'A required dependency is unavailable.' },
  { domainCode: 'EXTERNAL_TIMEOUT', wireCode: 'DEPENDENCY_UNAVAILABLE', status: 503, retryable: true,
    message: 'A required dependency is unavailable.' },
  { domainCode: 'UNAUTHENTICATED', wireCode: 'TOKEN_MISSING', status: 401, retryable: false,
    message: 'A bearer access token is required.' },
  { domainCode: 'UNAUTHENTICATED', wireCode: 'TOKEN_INVALID', status: 401, retryable: false,
    message: 'The access token could not be verified.' },
  { domainCode: 'UNAUTHENTICATED', wireCode: 'TOKEN_EXPIRED', status: 401, retryable: false,
    message: 'The access token has expired.' },
  { domainCode: 'UNAUTHENTICATED', wireCode: 'TOKEN_INVALID_CLAIMS', status: 401, retryable: false,
    message: 'The access token is missing a required claim.' },
  { domainCode: 'UNAUTHENTICATED', wireCode: 'TOKEN_AUDIENCE_MISMATCH', status: 401, retryable: false,
    message: 'The access token was issued for a different audience.' },
  { domainCode: 'UNAUTHENTICATED', wireCode: 'TOKEN_SCOPE_WILDCARD_FORBIDDEN', status: 401, retryable: false,
    message: 'A wildcard scope is not permitted.' },
  { domainCode: 'FORBIDDEN', wireCode: 'INSUFFICIENT_SCOPE', status: 403, retryable: false,
    message: 'The access token does not carry a required scope.' },
  { domainCode: 'FORBIDDEN', wireCode: 'INSUFFICIENT_ROLE', status: 403, retryable: false,
    message: 'The access token does not carry a required role.' },
  { domainCode: 'FORBIDDEN', wireCode: 'STEP_UP_REQUIRED', status: 403, retryable: false,
    message: 'Re-authentication is required for this operation.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'INVALID_CURSOR', status: 400, retryable: false,
    message: 'The supplied cursor is not valid for this collection.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'INVALID_SORT_FIELD', status: 400, retryable: false,
    message: 'The requested sort field is not available on this collection.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'UNKNOWN_QUERY_PARAMETER', status: 400, retryable: false,
    message: 'An unknown query parameter was supplied.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'INVALID_TRUTH_STATE', status: 400, retryable: false,
    message: 'The supplied truth state is not one of the eleven canonical states.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'INVALID_GROUP_BY', status: 400, retryable: false,
    message: 'The requested grouping is not available.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'TIME_RANGE_REQUIRED', status: 400, retryable: false,
    message: 'An explicit time range is required for this collection.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'TIME_RANGE_TOO_WIDE', status: 400, retryable: false,
    message: 'The requested time range exceeds the permitted span.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'FILTER_TOO_BROAD', status: 400, retryable: false,
    message: 'A filter supplied too many values.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'MISSING_REQUIRED_HEADER', status: 400, retryable: false,
    message: 'A required header is missing.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'IDEMPOTENCY_KEY_MALFORMED', status: 400, retryable: false,
    message: 'The Idempotency-Key header is malformed.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'SCHEMA_VALIDATION_FAILED', status: 422, retryable: false,
    message: 'The request is well formed but fails a semantic validation.' },
  { domainCode: 'PRECONDITION', wireCode: 'PRECONDITION_FAILED', status: 412, retryable: false,
    message: 'The supplied If-Match value does not match the current resource state.' },
  { domainCode: 'PRECONDITION', wireCode: 'PRECONDITION_REQUIRED', status: 428, retryable: false,
    message: 'An If-Match header is required for this operation.' },
  { domainCode: 'TRANSPORT', wireCode: 'PAYLOAD_TOO_LARGE', status: 413, retryable: false,
    message: 'The request body exceeds the permitted size.' },
  { domainCode: 'TRANSPORT', wireCode: 'UNSUPPORTED_MEDIA_TYPE', status: 415, retryable: false,
    message: 'The request media type is not supported.' },
  { domainCode: 'TRANSPORT', wireCode: 'RATE_LIMITED', status: 429, retryable: true,
    message: 'The rate limit for this operation has been reached.' },
  { domainCode: 'TRANSPORT', wireCode: 'INTERNAL_ERROR', status: 500, retryable: false,
    message: 'An unexpected server fault occurred.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_SIGNATURE_INVALID', status: 401, retryable: false,
    message: 'The webhook signature could not be verified.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_KEY_UNKNOWN', status: 401, retryable: false,
    message: 'The webhook key identifier is not trusted.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW', status: 401, retryable: false,
    message: 'The webhook timestamp is outside the accepted window.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_NONCE_MISSING', status: 400, retryable: false,
    message: 'The webhook replay token is missing or malformed.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_NONCE_REPLAY', status: 409, retryable: false,
    message: 'This webhook delivery has already been processed.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_BINDING_NOT_FOUND', status: 404, retryable: false,
    message: 'The webhook destination is not recognised.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_CASE_STATE_CONFLICT', status: 409, retryable: false,
    message: 'The case cannot accept this webhook at its current state.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_ACTION_NOT_FOUND', status: 409, retryable: false,
    message: 'The referenced external action was not found.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_PROVIDER_RUN_MISMATCH', status: 409, retryable: false,
    message: 'The provider run does not match the referenced external action.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_MAIL_PIECE_NOT_FOUND', status: 409, retryable: false,
    message: 'The referenced mail piece was not found.' },
]);
```

`src/http/errors/envelope.ts` — `toEnvelope(error, ctx)` returns exactly one top-level
key `error` with `code`, `message` (looked up from the registry, never from
`error.message`), `requestId`, `correlationId`, `retryable`, `occurredAt`, and an
optional `details` object filtered against a per-code allowlist. An unmapped exception
becomes `500 INTERNAL_ERROR` with **no** exception message, no stack, and an alert with
a server-side stack reference (SPEC-006 H-8). `src/http/plugins/error-handler.ts`
installs it as the Fastify error handler and must not catch-and-continue.

`tests/contract/error-mapping-parity.test.ts` — parses `SPEC-003` §8.2 and `SPEC-006`
§6.2 from the specification files, extracts every `code → status` pair, and asserts the
registry agrees with both. It also asserts (a) `code` uniqueness, (b) every code is
`SCREAMING_SNAKE_CASE`, (c) no row carries an ad-hoc success token (`SUCCESS`, `DONE`,
`COMPLETE`, `REMOVED`, `OK`, `NONE`) in `code` or `message`, and (d) every `details`
key used anywhere in `src/http/**` appears in the allowlist. A divergence between the
two specs is a **defect to record**, not a value to pick: if the test finds one, stop
and record it in §12, with both citations, rather than editing a specification.

`tests/contract/error-envelope.test.ts` — for every registry row, inject a synthetic
failure through a test-only route and assert the response body validates against the
envelope schema, has exactly one top-level key, matches the templated message
byte-for-byte, and carries `requestId` and `correlationId`. A negative case asserts
that an induced plain `Error` yields `500 INTERNAL_ERROR` whose body contains neither
the exception message nor a stack frame.

RUN:
```
node --test "tests/contract/error-envelope.test.ts"
node --test "tests/contract/error-mapping-parity.test.ts"
sh scripts/gate-api.sh
```

EXPECT: both contract suites pass and report their test counts; `gate-api: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-004 MILESTONE_PASS "M2 error envelope and code registry parity: ok"`

FALLBACK: if the specification files are reflowed such that the parity test's parser
cannot read §8.2/§6.2 tables reliably, generate the registry instead from a checked-in
machine-readable extract committed alongside the specs, and make the parity test assert
the extract is byte-identical to the table region it was taken from. A hand-maintained
duplicate list is not an acceptable fallback.

COMMIT: `git add -A && git commit -m "[EP-004][M2] error envelope and closed code registry"`

### M3: Request identity, token validation, tenant resolution, and correlation

GOAL: Every `/v1` route except health and webhook ingress rejects a missing, malformed,
wrong-audience, or claim-deficient token with the mapped `401` code, and derives
`tenantId` solely from the validated token.

READ: `SPEC-005` §1 (IDP-1…IDP-6), §2, §5; `SPEC-003` §2.3, §2.4, §3.1, §3.2, §3.3;
`SPEC-002` (RLS section); `.agent/specs/SPEC-007-observability.md` (correlation,
redaction); `src/domain/values.ts`; `PREFLIGHT.md`.

CHANGE: `src/http/plugins/identity.ts`, `src/http/plugins/tenancy.ts`,
`src/http/plugins/correlation.ts`, `src/adapters/oidc/jwks.ts`,
`src/adapters/oidc/verify.ts`, `src/application/contracts/request-context.ts`,
`tests/contract/token-validation.test.ts`,
`tests/contract/tenant-resolution.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `src/adapters/oidc/verify.ts` — verifies signature against the realm JWKS and checks
  `iss`, `aud`, `exp`, `nbf`, `azp`. Required claims: `sub`, `iss`, `aud`, `exp`,
  `tenantId`, `scopes`, `roles`, `authTime`, `acr`. A token missing `tenantId` or
  `scopes` is `401 TOKEN_INVALID_CLAIMS` — **never** treated as an empty scope set
  (SPEC-003 §3.2 item 2). A wildcard scope value is `401 TOKEN_SCOPE_WILDCARD_FORBIDDEN`.
  Audience binding: portal, service, and MCP tokens carry distinct `aud`; a token
  presented to the wrong audience is `401 TOKEN_AUDIENCE_MISMATCH`. Bearer only: no
  query-string token, no cookie, no `X-Api-Key` on any `/v1` route (§3.2 item 1).
- `src/adapters/oidc/jwks.ts` — JWKS fetch with an in-memory TTL cache keyed by
  `iss` + `kid`; a cache miss that cannot reach the issuer produces
  `503 DEPENDENCY_UNAVAILABLE` and **never** a degraded "accept unverified" path.
  Log the cache age as `keycloak-jwks.cacheAgeSeconds` (SPEC-003 §5.17.1 shape). The
  issuer URL comes from `KEYCLOAK_ISSUER`; when it is unset, bootstrap already refused
  in M1 — this adapter must not paper over that.
- `src/http/plugins/tenancy.ts` — takes `tenantId` from the verified token and sets the
  RLS session variable with `SET LOCAL app.tenant_id = $1` inside the request
  transaction (SPEC-003 §2.4). A `tenantId` present in a body, query string, or path is
  rejected by strict schema parsing; it is never authoritative and no route accepts it
  (VG-API-004). When no transaction is open, the plugin must refuse rather than run an
  unscoped query (SPEC-006 §7.1 row 13).
- `src/http/plugins/correlation.ts` — assigns `correlationId` from a well-formed W3C
  `traceparent` when present, otherwise generates one; echoes a valid `X-Request-Id`
  verbatim and replaces a malformed one (never rejecting the call for that header
  alone). Both values are attached to the request context and to every `AuditEvent`
  the request produces (VG-API-003, VG-OBS-001). `traceparent` is never trusted for
  authorization, tenancy, or sampling.
- `src/application/contracts/request-context.ts` — the immutable per-request context
  object handed to application commands:
  `{ tenantId, actorIdentity, roles, scopes, authLevel, authTime, correlationId, requestId, clock }`.
  It must contain no field that a handler could use to bypass a scope check.
- Scope vocabulary: the closed §3.3 list, with the five v1 role bundles
  (`vg_analyst`, `vg_operator`, `vg_reviewer`, `vg_auditor`, `vg_tenant_admin`) as
  declared constants. Roles confer no privilege beyond their scopes.
- Refusal paths that are testable without Keycloak: signature/claim/audience/scope
  logic is exercised against a **locally generated key pair and a locally signed token**
  whose JWKS is supplied through the injected fetch port. State honestly in the test
  file header that this proves the verification logic, not Keycloak's configuration,
  and that real-IdP verification is `BLOCKED_CREDENTIALS` on `KEYCLOAK_ISSUER`
  (EP-006 owns the realm).

RUN:
```
node --test "tests/contract/token-validation.test.ts"
node --test "tests/contract/tenant-resolution.test.ts"
sh scripts/probes/keycloak.sh; echo "probe exit: $?"
sh scripts/gate-api.sh
```

EXPECT: both suites pass; `keycloak.sh` exits non-zero (no realm provisioned);
`gate-api: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-004 MILESTONE_PASS "M3 token validation and tenant resolution: ok; KEYCLOAK_ISSUER BLOCKED_CREDENTIALS"`

FALLBACK: if no JOSE library is acceptable under the locked dependency policy, implement
RS256 verification with `node:crypto` `createPublicKey` plus `verify` — real
cryptographic verification with no third-party dependency, not a stub. Never accept an
unverified token to keep tests green.

COMMIT: `git add -A && git commit -m "[EP-004][M3] request identity, token validation, and tenant resolution"`

### M4: Collections — cursor pagination, strict filters, sorting, and the page object

GOAL: Every collection route accepts `limit`+`cursor` and nothing else, returns the
SPEC-003 §2.5 `page` object, and refuses an unknown parameter, an unknown truth-state
token, an over-broad filter, or a cursor issued for another tenant/route/filter/sort.

READ: `SPEC-003` §2.5, §2.6, §2.7, §7.1, §7.2, §7.3, §7.4;
`.agent/specs/SPEC-000-product-scope.md` §4, §5, §7; `src/domain/truth-state.ts`.

CHANGE: `src/http/pagination/cursor.ts`, `src/http/query/strict.ts`,
`src/http/query/filters.ts`, `src/http/dto/page.ts`,
`tests/contract/pagination.test.ts`, `tests/contract/filter-strictness.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `src/http/pagination/cursor.ts` — cursor is
  `base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload, SESSION_SECRET))`.
  Payload binds `tenantId`, `routeTemplate`, a canonical hash of the normalised filter
  set, the sort key, and the last row's keyset values. Verification recomputes the HMAC
  in constant time and compares every binding; any mismatch is `400 INVALID_CURSOR`.
  The decoder rejects an oversized cursor before base64 decoding (bound the input at
  512 bytes) and never `JSON.parse`s unauthenticated bytes. A cursor carries no PII and
  no truth state. There is **no** `offset` parameter on any route and no code path that
  can produce one.
- `src/http/query/strict.ts` — a schema-driven query parser: extra properties are
  `400 UNKNOWN_QUERY_PARAMETER`; a `sort` value outside the route's allowlist is
  `400 INVALID_SORT_FIELD`; a `truthState` value outside the eleven canonical tokens is
  `400 INVALID_TRUTH_STATE`; more than 20 values in a comma-separated filter is
  `400 FILTER_TOO_BROAD`. `from`/`to` follow inclusive-lower/exclusive-upper semantics,
  and a missing range on a time-filterable collection defaults to the last 30 days
  **and echoes the applied default** in `page.filter`.
- `src/http/dto/page.ts` — the exact `page` shape and the rule that
  `page.nextCursor` is `null` on the last page. `hasMore` and `nextCursor` must agree;
  a test asserts they cannot disagree.
- `tests/contract/pagination.test.ts` — walks a seeded collection of 250 rows page by
  page and asserts each row appears exactly once with no duplicates and no gaps, for at
  least two routes with different sort orders. Negative cases: a cursor minted for
  tenant A rejected under tenant B's context; a cursor minted for route R rejected on
  route S; a cursor minted for `sort=a:asc` rejected under `sort=b:desc`; a truncated
  cursor rejected; a cursor with a valid payload but a flipped signature byte rejected.
- `tests/contract/filter-strictness.test.ts` — `?truthState=DONE` is
  `400 INVALID_TRUTH_STATE`, `?limitt=5` is
  `400 UNKNOWN_QUERY_PARAMETER`, `?sort=identifierValue:asc` is
  `400 INVALID_SORT_FIELD`, and a 21-value filter is `400 FILTER_TOO_BROAD` — each with
  no result rows and no state change.

RUN:
```
node --test "tests/contract/pagination.test.ts"
node --test "tests/contract/filter-strictness.test.ts"
sh scripts/gate-api.sh
```

EXPECT: both suites pass; `gate-api: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-004 MILESTONE_PASS "M4 cursor pagination and strict query parsing: ok"`

FALLBACK: if keyset pagination over a specific route's ordering proves unstable (ties on
the sort key), extend the keyset with the opaque row ID as a deterministic tiebreaker —
a real, simpler ordering, not a switch to offset pagination. Offset pagination over
append-only evidence is prohibited by SPEC-003 §2.5 and must not be introduced as a
fallback.

COMMIT: `git add -A && git commit -m "[EP-004][M4] cursor pagination and strict query parsing"`

### M5: Idempotency — replay, conflict, and in-flight refusal

GOAL: A replayed `Idempotency-Key` with an identical body returns the stored original
status and body and produces **no** second effect; a different body fingerprint, or a
key still in flight, is refused with `409` and no new effect.

READ: `SPEC-003` §4.1–§4.5, §2.3, §5.8.2; `SPEC-006` §5.3 rows 10 and 11;
`SPEC-001` §6 (`ExecuteAction`); `src/domain/values.ts` (`IdempotencyKey`),
`src/domain/errors.ts` (`IdempotencyConflict`, `AmbiguousExternalEffect`).

CHANGE: `src/domain/ports/idempotency-store.ts`,
`src/http/plugins/idempotency.ts`, `src/adapters/idempotency/postgres-store.ts`,
`tests/contract/idempotency.test.ts`, `tests/integration/idempotency-store.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `src/domain/ports/idempotency-store.ts` — port with
  `begin(scopeKey) → {state: 'NEW'|'IN_FLIGHT'|'COMPLETED', record?}`,
  `complete(scopeKey, record)`, and `abandon(scopeKey)`. `scopeKey` is
  `(tenantId, method, routeTemplate, idempotencyKey)`. The port is declared in the
  application layer; only the adapter knows it is PostgreSQL.
- `src/http/plugins/idempotency.ts` — header validation first (16–255 chars,
  `[A-Za-z0-9._:-]`; malformed ⇒ `400 IDEMPOTENCY_KEY_MALFORMED`), then the route-level
  requirement from the registry (`Required` / `Required-if-effect` / `Optional`);
  absent on a required route ⇒ `400 IDEMPOTENCY_KEY_REQUIRED` **before any work**.
  Then: same key + identical canonicalised-body fingerprint + completed ⇒ return the
  stored status and body with `Idempotency-Replayed: true`; same key + different
  fingerprint ⇒ `409 IDEMPOTENCY_KEY_REUSE` carrying `originalResourceId`; same key
  while in flight ⇒ `409 IDEMPOTENCY_IN_FLIGHT` with `Retry-After: 5`. Retention is
  24 h by default. On a route whose effect has a durable domain `IdempotencyKey`, an
  expired HTTP record resolves from the domain record and returns
  `idempotencyReplayed: true` (§4.3 last-but-two row).
- Canonicalisation: the fingerprint is over a deterministic serialisation (sorted keys,
  normalised numbers, no insignificant whitespace). Two byte-different but semantically
  identical JSON bodies **must** fingerprint equal; a semantically different body
  **must** fingerprint differently. Both directions have a test.
- `src/http/plugins/idempotency.ts` must also enforce the non-promotion rule: a replayed
  2xx never increments any effect counter, and the effect counter counts distinct
  `(caseId, idempotencyKey)` pairs (VG-API-020).
- `tests/contract/idempotency.test.ts` — runs against a test-only effect-bearing route
  wired to an in-process store double for the *logic* assertions, and its file header
  states plainly that this proves the boundary semantics, not the durable store. The
  durable-store proofs live in `tests/integration/idempotency-store.test.ts` and are
  `BLOCKED_CREDENTIALS` on `DATABASE_URL`.
- `tests/integration/idempotency-store.test.ts` — concurrency: two simultaneous
  requests with the same key produce exactly one completed effect and one
  `IDEMPOTENCY_IN_FLIGHT` or replay; a crash between effect and completion is simulated
  by abandoning a record and asserting the next call is refused rather than duplicated.

RUN:
```
node --test "tests/contract/idempotency.test.ts"
sh -c 'sh scripts/probes/database_url.sh' ; echo "probe exit: $?"
sh scripts/gate-api.sh
```

EXPECT: the contract suite passes; `database_url.sh` exits non-zero
(`DATABASE_URL` unprovisioned ⇒ the integration suite is `BLOCKED_CREDENTIALS`);
`gate-api: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-004 MILESTONE_PASS "M5 idempotency semantics: ok; idempotency store integration BLOCKED_CREDENTIALS DATABASE_URL"`

FALLBACK: if PostgreSQL cannot serve as the idempotency store at this node (EP-003
unfinished), implement the port against a single-writer append-only file with `flock`
for the credential-free path so the semantics are exercised on something durable, and
keep the PostgreSQL adapter as the production binding. An in-memory-only store
presented as durable is prohibited (DOD-015, DOD-020).

COMMIT: `git add -A && git commit -m "[EP-004][M5] idempotency replay, conflict, and in-flight refusal"`

### M6: Route catalogue against real PostgreSQL and RLS

GOAL: The route catalogue of SPEC-003 §5 is wired to the persistence layer with RLS
enforced from the token's tenant, and a cross-tenant read returns `404` with a
byte-identical body to a genuinely absent resource.

READ: `SPEC-003` §3.2 item 4/5, §5.1–§5.17, §7.1–§7.4; `SPEC-002` (schema, RLS,
migrations); `SPEC-006` §7.1 rows 12/13; `.agent/execplans/EP-003-node.md` (the node that
owns the schema); `src/domain/state-machine.ts`, `src/domain/truth-state.ts`.

CHANGE: `src/http/routes/**` (all 17 groups), `src/adapters/persistence/**`,
`src/application/commands/**`, `src/application/queries/**`,
`tests/integration/rls-isolation.test.ts`,
`tests/integration/route-catalogue.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- One route module per SPEC-003 §5 group. Each handler: validates input, asserts
  required scopes from the registry, dispatches exactly one application command or
  query, maps the result to a DTO from the closed DTO set, and returns. A handler that
  contains a transition guard list, a `switch` over `TruthState` that assigns a state,
  or an `UPDATE … SET truth_state` is a defect and must be rewritten to call the
  command.
- `truthState` appears only as output, taken verbatim from the domain token. No route
  accepts it as input. A scan test asserts no request schema in `src/http/schemas/**`
  contains a `truthState` property and no response DTO contains a field named
  `removed`, `isRemoved`, `removalConfirmed`, `deleted`, `success`, `friendlyStatus`, or
  `displayStatus` (VG-API-058, VG-API-067).
- Cross-tenant behaviour: a resource owned by another tenant returns
  `404 RESOURCE_NOT_FOUND` with an identical body and no distinguishable timing signal
  (§3.2 item 4, SPEC-006 H-9). The internal `TENANT_SCOPE_VIOLATION` code is audit- and
  telemetry-only and never appears in a body or header.
- `tests/integration/rls-isolation.test.ts` — runs against real PostgreSQL with two
  seeded tenants and asserts (a) a query under tenant A returns zero rows for tenant B's
  data **at the database layer**, (b) the service-layer scope check rejects the same
  access independently, and (c) with the service-layer check stubbed out in the test
  harness only, RLS still returns zero rows (VG-TENANT-002, VG-API-013). This test is
  `BLOCKED_CREDENTIALS` on `DATABASE_URL` and `BLOCKED_PREREQUISITE` on EP-003's
  migrations.
- `tests/integration/route-catalogue.test.ts` — for every registry entry, asserts the
  route exists with its documented method and success status, that a token carrying
  exactly the required scopes succeeds, and that a token missing one required scope gets
  `403 INSUFFICIENT_SCOPE`.

**Blocked work, stated honestly.** `DATABASE_URL` is `REQUIRED` in `PREFLIGHT.md` and is
not provisioned. EP-003 is largely unstarted, so no schema, migration, or RLS policy
exists. Therefore:

- The route catalogue can be **written and type-checked**, and its credential-free
  contract assertions can pass.
- `tests/integration/rls-isolation.test.ts` and the persistence half of
  `route-catalogue.test.ts` are **BLOCKED_CREDENTIALS** (`DATABASE_URL`) and
  **BLOCKED_PREREQUISITE** (EP-003) and must be recorded as such in the ledger and in
  §12. They must **not** be written to pass, and they must **not** be replaced by an
  in-memory substitute presented as proof (DOD-010, SPEC-006 §7.1 rows 12/13).
- If EP-003 has not delivered the schema when this milestone is reached, stop at
  `NODE_BLOCKED` for this milestone with the two blocking references named, and record
  the exact prerequisite. Do not invent a schema in this node; that is EP-003's audit
  list and this node's diff would violate §6.

RUN:
```
node --test "tests/contract/**/*.test.ts"
sh -c 'sh scripts/probes/database_url.sh'; echo "probe exit: $?"
sh scripts/gate-api.sh
```

EXPECT: contract suites pass; `database_url.sh` exits non-zero; `gate-api: ok`
with the `DATABASE_URL: BLOCKED_CREDENTIALS` line present in its output.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-004 MILESTONE_PASS "M6 route catalogue wired; rls-isolation BLOCKED_CREDENTIALS DATABASE_URL + BLOCKED_PREREQUISITE EP-003"`

FALLBACK: if EP-003 delivers repositories but no RLS policy, wire the routes and record
RLS as `BLOCKED_PREREQUISITE` with the missing policy named. Do **not** compensate by
adding application-layer tenant filtering as the only control — that is exactly the
single-layer defence SPEC-000 VG-TENANT-002 forbids.

COMMIT: `git add -A && git commit -m "[EP-004][M6] route catalogue wired to persistence with RLS tenant scoping"`

### M7: Webhook ingress — signature, replay protection, and idempotent processing

GOAL: The three SPEC-003 §6 webhook routes verify an HMAC-SHA256 signature over the raw
request bytes before parsing, reject a replayed delivery exactly once, and dispatch
exactly one domain command without ever setting a truth state directly.

READ: `SPEC-003` §6.1–§6.4; `SPEC-006` §7.1 rows 21/23; `SPEC-000` VG-SEC-004,
VG-SEC-001; `SPEC-001` §6 (`RecordControllerResponse`); `src/domain/errors.ts`
(`TaintedContentRejected`).

CHANGE: `src/http/webhooks/verify.ts`, `src/http/webhooks/routes.ts`,
`src/adapters/coordination/replay-store.ts`, `src/http/plugins/raw-body.ts`,
`tests/contract/webhook-verification.test.ts`,
`tests/integration/webhook-replay.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `src/http/plugins/raw-body.ts` — captures the raw request bytes for the webhook routes
  only, with a hard 256 KiB cap; a larger body is `413 PAYLOAD_TOO_LARGE` and the bytes
  are discarded unparsed.
- `src/http/webhooks/verify.ts` — fixed verification order: resolve `X-VG-Key-Id`
  (unknown or retired ⇒ `401 WEBHOOK_KEY_UNKNOWN`) → check `X-VG-Timestamp` within
  ±300 s (`401 WEBHOOK_TIMESTAMP_OUT_OF_WINDOW`) → check `X-VG-Nonce` shape
  (`400 WEBHOOK_NONCE_MISSING`) → verify `X-VG-Signature`
  (`v1=<hex>`, HMAC-SHA256 over
  `"<timestamp>.<nonce>.<raw request body bytes>"`) with a **constant-time** comparison
  (`401 WEBHOOK_SIGNATURE_INVALID`) → check `X-VG-Event-Id`. No JSON parsing, no
  normalisation, and no schema validation happens before the signature check.
- `src/adapters/coordination/replay-store.ts` — Valkey-backed store keyed
  `(providerKeyId, nonce)` and `(providerKeyId, eventId)` with a 3600 s TTL. A repeated
  nonce is `409 WEBHOOK_NONCE_REPLAY` with **no** state change, rejected once and
  deterministically. A repeated event ID is **not** an error: return the stored original
  response with `200` and `X-VG-Webhook-Replayed: true`. If the store is unavailable the
  request fails **closed** with `503 DEPENDENCY_UNAVAILABLE` — never "accept and dedupe
  later".
- Taint: every webhook body is tainted input. Any field naming a channel, legal basis,
  truth state, budget, or idempotency key is ignored and its presence is audited as
  `IGNORED_CONTROL_FIELD`; it is never applied. Free text is stored as evidence with
  `taint: "TAINTED"`.
- `truthStateChanged: false` is returned unconditionally by the provider- and
  mail-tracking routes: a provider delivery callback is transport fact, not a
  `VerificationObservation`, and can never satisfy T14 (VG-API-064). The
  controller-callback route drives `RecordControllerResponse`, and a
  `claimedOutcome: "DELETED"` produces `ACKNOWLEDGED` with
  `claimedOutcomeIsObservation: false` — never `VERIFIED_REMOVED`.
- `tests/contract/webhook-verification.test.ts` — credential-free, using an injected key
  resolver and an injected replay-port double for the logic: valid signature accepted;
  tampered body rejected; signature computed over a re-serialised body rejected (proving
  the raw-bytes requirement); stale timestamp rejected; missing replay token rejected;
  unknown key rejected; oversized body rejected before parsing. Negative case: a body
  carrying `legalBasis`, `channel`, `truthState`, and `budgetOverride` produces an
  `IGNORED_CONTROL_FIELD` audit row and changes no policy, recipe, or action.
- `tests/integration/webhook-replay.test.ts` — needs `VALKEY_URL`; `BLOCKED_CREDENTIALS`
  until provisioned. It must assert the byte-identical replay returns
  `409 WEBHOOK_NONCE_REPLAY` exactly once and that a repeated event ID returns the
  stored response with `X-VG-Webhook-Replayed: true`.

RUN:
```
node --test "tests/contract/webhook-verification.test.ts"
sh -c 'sh scripts/probes/valkey_url.sh'; echo "probe exit: $?"
sh scripts/gate-api.sh
```

EXPECT: the contract suite passes; `valkey_url.sh` exits non-zero; `gate-api: ok`
with `VALKEY_URL: BLOCKED_CREDENTIALS` in its output.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-004 MILESTONE_PASS "M7 webhook signature and taint handling: ok; webhook replay integration BLOCKED_CREDENTIALS VALKEY_URL"`

FALLBACK: if no replay store is available, implement the same single-use semantics on a
durable append-only file with an exclusive lock for the credential-free contract path,
keeping the Valkey adapter as the production binding. A process-local `Map` presented
as replay protection is prohibited: it is in-memory ladder/state, which SPEC-006 §10.3
forbids.

COMMIT: `git add -A && git commit -m "[EP-004][M7] webhook ingress verification, replay protection, and taint handling"`

### M8: Black-box acceptance and the vocabulary/route gates

GOAL: Acceptance tests prove behaviour through public HTTP interfaces only, using
runtime-generated unpredictable canaries, and the generated OpenAPI document passes the
vocabulary gate.

READ: `.agent/DONE_LAW.md` DOD-011, DOD-012, DOD-013, DOD-018; `SPEC-000` §9;
`SPEC-003` §11 (`VG-API-001`…`VG-API-074`), §12; `SPEC-006` §9.2 (canary method).

CHANGE: `tests/blackbox/**`, `src/http/openapi/document.ts`,
`scripts/copy-lint-gate.sh` (see note), `tests/contract/vocabulary-gate.test.ts`,
`COMMANDS.md`, `.agent/verification/EXPECTED_TEST_MANIFEST.txt`,
`.agent/state/LEDGER.md`.

CONTENT:

- `tests/blackbox/acceptance.test.ts` — drives the real server through
  `app.inject` (in-process HTTP, public routes only) or a real listening socket, using
  only documented routes, documented headers, and documented DTO fields. It must not
  import `src/http/routes/**` internals, must not call a command directly, and must not
  read the database to force a pass (DOD-011).
- Runtime canaries: generate a fresh random `displayRef`, a unique local part on a
  reserved documentation domain, a unique digit string, and a unique
  `AUTH_SECRET`-shaped token at run time; record the seed/source and the generated
  values in the evidence index; assert **zero matches** for every canary in every error
  body, every response body that should not carry it, and every emitted log line. Do
  not use fixture values (DOD-013).
- Independent readback (DOD-012): where an action has a side effect observable through a
  second channel, observe it through that channel. At this node the reachable proofs are
  the audit stream and the persisted transition record; state which ones are reachable
  and which are `BLOCKED_CREDENTIALS`.
- `src/http/openapi/document.ts` — emits an OpenAPI 3.1 document from the route registry
  and the schema modules. The document is the artefact the vocabulary gate scans.
- `tests/contract/vocabulary-gate.test.ts` — scans the generated OpenAPI document, the
  route registry, and the DTO type declarations for SPEC-000 §4 forbidden synonyms used
  as production identifiers (`client`, `target`, `victim`, `user_profile`, `consent`,
  `permission`, `site`, `vendor`, `provider`, `scraper`, `script`, `bot`, `automation`,
  `hit`, `listing`, `result`, `lead`, `match`, `finding`, `compromise`, `score`,
  `probability`, `certainty`, `ruling`, `verdict`, `ticket`, `job`, `task`, `request`,
  `submission`, `dedupe_key`, `nonce`, `check`, `recheck`, `confirmation`, `relapse`,
  `regression`, `attachment`, `file`, `screenshot`, `broker`, `company`, `entity`,
  `blocker`, `captcha_wall`, `sanitizer`, `cleaner`, and the ad-hoc status tokens
  `DONE`, `COMPLETE`, `SUCCESS`, `REMOVED`). Two tokens are allowlisted **by exact name
  only**: `X-Request-Id` and `requestId`. Every other `request*` identifier fails.
  A forbidden hit exits non-zero and names the file and line (VG-API-067).
- Route non-goal negative cases, each asserted to `404` and to create nothing: a request
  to `/v1/subjects` unversioned, `/v1/subjects/export`, any route accepting a `tenantId`
  parameter, and any body containing `bypassHumanGate`, `force`, `skipVerification`, or
  `overridePolicy` (VG-API-074, SPEC-003 §10).
- Evidence upload negative case: a tampered multipart upload whose declared `digest`
  does not match the received bytes returns `422 EVIDENCE_DIGEST_MISMATCH` and creates no
  artifact row (VG-API-050).
- **Command note.** The vocabulary/copy-lint gate is required by SPEC-003 VG-API-067 and
  by SPEC-004 VG-UI-080/081/082/083, and SPEC-004 VG-UI-080 requires the gate to be
  invoked by a command **added to `COMMANDS.md` before it is used**. This node adds
  `sh scripts/copy-lint-gate.sh` (`copy lint gate: ok`) to `COMMANDS.md` in this
  milestone and creates the script with real content: it scans the generated OpenAPI
  document, the built browser bundle if present, and the route/DTO declarations; it
  exits non-zero with a named file, line, and token on a hit; it fails on a zero-file
  scan; and its allowlist self-test fails on an entry that carries no reason (VG-UI-080).
  EP-005 M2 consumes the same script for the UI copy rules — one gate, one command, not
  two competing scanners.

RUN:
```
node --test "tests/blackbox/**/*.test.ts"
node --test "tests/contract/vocabulary-gate.test.ts"
sh scripts/copy-lint-gate.sh
sh scripts/gate-api.sh
python3 scripts/anti-gaming-scan.py .
```

EXPECT: the black-box suite passes; the vocabulary gate reports `copy lint gate: ok`;
`gate-api: ok`; `anti-gaming-scan.py` exits 0. Any hit is a defect to fix, never a
baseline to accept (SPEC-006 §8 row 8).

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-004 MILESTONE_PASS "M8 black-box acceptance, canaries, vocabulary gate: ok"`

FALLBACK: if `app.inject` cannot exercise a route that needs a real listening socket or
a real multipart parser, start the server on an ephemeral port inside the test and drive
it over a real socket. Never bypass the HTTP layer to reach the application layer "for
convenience" — that would invalidate the black-box claim under DOD-011.

COMMIT: `git add -A && git commit -m "[EP-004][M8] black-box acceptance, canaries, and vocabulary gate"`

### M9: Node-level acceptance, blocked-work accounting, and close-out

GOAL: The node's gate passes, every unverifiable item is recorded with the exact
SPEC-006 §4.1 status and its blocking reference, and no claim in the ledger is stronger
than its evidence.

READ: `.agent/DONE_LAW.md` (DOD-025, DOD-026, DOD-029, DOD-032); `SPEC-008` §1, §2, §3,
§9; `SPEC-006` §4.1 (`BLOCKED_CREDENTIALS`, `BLOCKED_PREREQUISITE`, `UNVERIFIED`);
`.agent/verification/state/NEXT_ACTION.md`, `.agent/verification/state/TEST_LEDGER.jsonl`.

CHANGE: `scripts/gate-api.sh` (final form), `.agent/evidence/EP-004/**`,
`.agent/verification/state/TEST_LEDGER.jsonl`,
`.agent/verification/state/NEXT_ACTION.md`, `.agent/state/LEDGER.md`, `COMMANDS.md`.

CONTENT:

- Run the full credential-free suite one more time in a single pass and capture the raw
  logs as evidence under `.agent/evidence/EP-004/` with content hashes recorded in
  `.agent/verification/state/EVIDENCE_INDEX.jsonl` (DOD-025).
- Record every ID this node owns in `TEST_LEDGER.jsonl` with the SPEC-006 §4.1 required
  fields. Expect at minimum: the credential-free `VG-API-*` rows as `PASS` with command,
  exit code, sentinel, and evidence digest; `VG-API-012`/`VG-API-013` (cross-tenant at
  both layers) as `BLOCKED_CREDENTIALS` (`DATABASE_URL`) plus `BLOCKED_PREREQUISITE`
  (EP-003 RLS policy) with `probeCommand: sh scripts/probes/database_url.sh` and the
  observed probe exit code; the webhook replay rows as `BLOCKED_CREDENTIALS`
  (`VALKEY_URL`); the real-IdP token rows as `BLOCKED_CREDENTIALS` (`KEYCLOAK_ISSUER`).
  A row must never be left `UNVERIFIED` silently — `UNVERIFIED` is legitimate, but it is
  stated, not implied.
- Update `NEXT_ACTION.md` to name EP-005 and to list the three provisioning actions that
  unblock the credential-dependent rows.
- Append `NODE_DONE` for EP-004 **only** if every milestone above has a `MILESTONE_PASS`
  event carrying a real observed sentinel. Tag `green/EP-004`. Do **not** modify
  `.agent/verification/state/RELEASE_GATE.json`: the verdict remains `INCONCLUSIVE`
  because no artifact, no verification subgraph run, and no external gate exists
  (SPEC-008 §13).
- Do **not** write "EP-004 complete" as a claim that the API works. The honest statement
  is: the credential-free contract and black-box acceptance suites pass; the
  credential-dependent rows are `BLOCKED_CREDENTIALS` on named variables.

RUN:
```
sh scripts/gate-api.sh
node --test "tests/contract/**/*.test.ts"
node --test "tests/blackbox/**/*.test.ts"
sh scripts/ledger.sh append <AGENT_ID> EP-004 NODE_DONE "EP-004 closed: gate-api: ok; credential-dependent rows BLOCKED_CREDENTIALS"
sh scripts/ledger.sh status EP-004
git tag green/EP-004
git log --oneline -1
sh scripts/graph-next.sh
```

EXPECT: `gate-api: ok`; `DONE` from `ledger.sh status EP-004`; tag `green/EP-004`
created; `graph-next.sh` prints `NEXT EP-005`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-004 NODE_DONE "EP-004 closed: gate-api: ok; DATABASE_URL/VALKEY_URL/KEYCLOAK_ISSUER BLOCKED_CREDENTIALS"`

FALLBACK: none. If the gate fails, the node stays open — do not tag, and do not narrow
the gate to make it pass.

COMMIT: `git add -A && git commit -m "[EP-004][M9] close API/service node with blocked-work accounting"`

## 9. Validation and Acceptance

Per-criterion acceptance, each tied to an ID and to executed evidence only:

1. `sh scripts/gate-api.sh` prints `gate-api: ok` and exits 0.
2. Every `VG-API-*` row has at least one executed test with a recorded command, exit
   code, sentinel, artifact digest, and evidence path, or an explicit SPEC-006 §4.1
   non-`PASS` status with its blocking reference (SPEC-003 §12 items 1–5).
3. The route registry equals SPEC-003 §5 and §6 exactly — no undocumented route and no
   documented route missing — asserted as a set equality in both directions.
4. The generated OpenAPI document passes `sh scripts/copy-lint-gate.sh` and the
   `VG-API-067` vocabulary scan.
5. The error envelope tests pass for every registry code, and the parity test finds **no
   status divergence** between SPEC-003 §8.2 and SPEC-006 §6.2. Any divergence is
   recorded in §12 as a specification defect with both citations — never resolved by
   editing a specification.
6. `Idempotency-Key` behaviour: replay returns the stored response with
   `Idempotency-Replayed: true` and produces one effect; mutated body is
   `409 IDEMPOTENCY_KEY_REUSE`; concurrent duplicate is `409 IDEMPOTENCY_IN_FLIGHT`
   (VG-API-018/019/020).
7. Cursor pagination: a full walk yields each row exactly once; a foreign cursor is
   `400 INVALID_CURSOR`; there is no `offset` parameter anywhere (VG-API-005).
8. `correlationId` and `X-Request-Id` appear on every response and are resolvable to the
   audit rows for the operation (VG-API-003).
9. Black-box tests use public interfaces only and drive at least one runtime-generated
   canary set with a zero-match assertion (DOD-011, DOD-013).
10. `truthState` is never accepted as input and never renamed on output; the handler scan
    finds no transition-guard list and no truth-state assignment in `src/http/**`
    (SPEC-001 §4.3 SM-6).
11. Independent verification of side effects is demonstrated where reachable, and the
    unreachable cases are named `BLOCKED_CREDENTIALS` rather than described as proved
    (DOD-012).
12. Every milestone's evidence exists as a `MILESTONE_PASS` ledger row with a real
    observed sentinel, and every unverifiable row carries a SPEC-006 §4.1 status with its
    required fields.

**Node VERIFY narrowing — requires owner ratification (§13 D1).** The stub header for
this node declared `VERIFY: sh scripts/verify.sh` / `VERIFY_SENTINEL: verify: ok`. That
header is generic boilerplate reproduced across all eleven stubs, and `verify.sh`'s
fifteen mandated stages include artifact-bound smoke, artifact-bound E2E, and
artifact-bound live-fire, none of which can pass before a production artifact exists
(EP-009), plus `preflight`, `reality-gate`, `format-check`, `dependency-audit`, and
`security-check`, which are still loud-fail placeholders owned by other nodes. Keeping
the boilerplate would make this node permanently unclosable and would create pressure to
fake a green. This plan therefore narrows **this node's** verify to
`sh scripts/gate-api.sh` / `gate-api: ok`, which covers this node's actual
deliverable and genuinely fails when the contract suites fail. This is **not** a gate
weakening: no stage is removed from `verify.sh`, the stage order is untouched, and the
M1 milestone *strengthens* `scripts/test-integration.sh` from a loud-fail placeholder
into a real runner. The change is recorded in §13 D1 and needs owner ratification.

**Never claim:** that `/v1` is "done", "working", or "production-ready"; that the API
passes `verify.sh`; that it is exercised against PostgreSQL, Valkey, or Keycloak; or
that any `VG-API-*` row is satisfied whose dependency is unprovisioned. The honest
statement is bounded: the credential-free contract and black-box suites pass, and the
credential-dependent rows are `BLOCKED_CREDENTIALS`. The ship verdict remains
`INCONCLUSIVE` (SPEC-008 §13).

## 10. Idempotence and Recovery

To re-enter this node cold:

1. Read `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`,
   `.agent/EXECUTION_RULES.md`, `.agent/DONE_LAW.md`, this plan, the specifications in
   §5, and the last 30 ledger rows (`sh scripts/ledger.sh tail 30`).
2. Run `sh scripts/ledger.sh status EP-004`. If `DONE`, the node is closed and no
   milestone may be re-run for credit.
3. Resume at the first milestone whose `Progress` checkbox is unchecked **and** which has
   no `MILESTONE_PASS` row in `.agent/state/LEDGER.md`. If the two disagree, the ledger
   is authoritative and the disagreement is a finding to record in §12.
4. Before starting that milestone, re-run the **previous** milestone's `RUN` block and
   confirm its sentinel still appears. Cached green is not green (SPEC-008 VG-SHIP-006).
5. Re-read every file named in that milestone's `READ` before editing. Never edit a file
   from memory.

Recovery properties:

- No milestone is destructive. Every one re-runs to the same result.
- If `node_modules` state is suspect: `rm -rf node_modules && npm ci`.
- If a contract test fails after a dependency bump: the dependency change is a new
  candidate epoch; record the prior evidence as invalidated (VG-REL-004, DOD-040) rather
  than reusing it.
- If an outbound call to a real dependency is required and the credential is absent, the
  correct action is to record `BLOCKED_CREDENTIALS` with the probe command and exit code
  and continue with the independent credential-free work. Blanket blocking is invalid
  (DOD-031, VG-SHIP-014).
- If the same failure signature recurs three times, the bounded ladder terminates the
  attempt: stop, record the terminal state with all three attempt artefacts linked, and
  produce the structured blocked report (SPEC-006 §10.3, AGENTS.md STOP list). Never
  apply the same fix twice.

## 11. Progress

- [ ] M1: Service foundation, layer boundary, and this node's gate
- [ ] M2: Error envelope, code registry, and HTTP mapping
- [ ] M3: Request identity, token validation, tenant resolution, and correlation
- [ ] M4: Collections — cursor pagination, strict filters, sorting, and the page object
- [ ] M5: Idempotency — replay, conflict, and in-flight refusal
- [ ] M6: Route catalogue against real PostgreSQL and RLS
- [ ] M7: Webhook ingress — signature, replay protection, and idempotent processing
- [ ] M8: Black-box acceptance and the vocabulary/route gates
- [ ] M9: Node-level acceptance, blocked-work accounting, and close-out

## 12. Surprises & Discoveries

### 2026-09-14 — EP-003 never built a repository layer, and M6's CHANGE list assumes one

M6's CHANGE list names `src/adapters/persistence/**` as though it existed. It does not. EP-003's own
scope section lists "the service layer, HTTP/API, authorization middleware (EP-004/EP-006)" as OUT of
scope, and its non-goals say "No touching of the domain layer". EP-003 delivered schema, migrations,
RLS and gates — no repositories.

So M6 is effectively TWO deliverables: the persistence layer EP-003 deliberately left, and the route
catalogue. That is legitimate work for this node, but it means M6 is the largest milestone in the
graph and should be executed incrementally rather than in one pass.

### 2026-09-14 — THREE negative controls silently did nothing, because of a PowerShell `$1` expansion

The `SET` versus `SET LOCAL` trap is the most dangerous mistake available in the tenant runner: with
session-scoped `SET`, a pooled connection keeps the previous request's tenant. I sabotaged the runner
three times to prove the test caught it, and **all three times the suite still passed**.

The reason was NOT a weak test. It was that my PowerShell replacement string contained `$1`, which
PowerShell expanded to an empty string, so the replacement silently matched nothing and the runner was
never actually modified. The control verified the unmodified code.

MEASURED once the replacement was made literal-safe: the sabotaged runner leaks
`11111111-1111-4111-8111-111111111111` into a released pooled connection, and the test fails with
`a pooled connection still carries a tenant (...); the setting is not LOCAL`, then passes 16/16 once
restored.

**The lesson recorded here is about verification hygiene, not about TypeScript:** a negative control
that passes is evidence of nothing until the sabotage itself is confirmed applied. Every later control
in this node prints whether the edit landed before running the suite.

A second, narrower problem was also found while chasing this: the first version of the test used a
SEPARATE pool and inspected a connection the runner had never touched, so it could not have detected a
leak in any case. It now acquires from the runner's own pool through
`observeReleasedConnectionSetting()`, whose only purpose is to make that observable without exposing a
general unscoped-query method.

### 2026-09-14 — the domain refused an `IdempotencyKey` the HTTP contract REQUIRES it to accept

`src/domain/values.ts` capped `IdempotencyKey` at **200 characters**, but SPEC-003 §4.2 fixes the
caller-facing bound at **16–255**. MEASURED before the fix: `new IdempotencyKey('a'.repeat(255))`
threw. A caller following the specification could send a 255-character key and have construction
fail INSIDE the domain, producing a 500 for input the contract declared valid.

The bound now matches the contract. The domain deliberately does NOT enforce the 16-character MINIMUM
or the `[A-Za-z0-9._:-]` charset: SPEC-001 §2 says only "non-empty, stable across retries, unique per
intended effect", and a domain minimum would refuse internal keys that never cross the wire. Those
are `/v1` shape rules, enforced at the boundary.

The existing test asserted the implementation's 200 rather than the specification's 255, so it had to
be corrected too — a test that encodes a bug is how a bug survives a refactor.

### 2026-09-14 — the fingerprint was STORED but never COMPARED, so a changed body replayed

The idempotency plugin computed the body fingerprint, wrote it into the record, and then never read
it back. `begin` returned `COMPLETED` for a key regardless of the new body, so **a request with a
changed body silently received the first request's 201** — SPEC-003 §4.3's
`IDEMPOTENCY_KEY_REUSE` conflict never fired.

Found by the contract suite's "a changed body is refused 409" test, which is exactly the assertion
that would have been easy to omit. The comparison now lives at the boundary, because the store is a
state machine that does not know the policy.

### 2026-09-14 — `begin` could not tell the CLAIMER from a concurrent reader, so no request proceeded

After the fingerprint fix, a two-caller race returned `IN_FLIGHT + IN_FLIGHT` — neither request
proceeded — and a 20-caller race reported **zero** claims. The implementation inferred "did I insert?"
by comparing the stored fingerprint against its own, which cannot distinguish the inserter from a
concurrent caller sending the same body: both match.

The fix uses the `INSERT ... RETURNING state` output, which answers the question unambiguously.
MEASURED both ways against the live database: the inserting statement emits `IN_FLIGHT`, and the
`ON CONFLICT DO NOTHING` path emits `(0 rows)`. Without this, an effect-bearing request would have
returned `409 IDEMPOTENCY_IN_FLIGHT` forever instead of executing exactly once — a fail-closed bug
that looks like a busy system.

### 2026-09-14 — the same `set_config` echo-row trap as EP-003 M5, in a new place

`PostgresIdempotencyStore.read` parsed `rows[0]` as the state, but `scopedSql` opens with
`SELECT set_config(...)`, whose return value is the FIRST output line. The store therefore read the
tenant UUID as the state and reported `unrecognised stored state (11111111-...-111111111111)` for
every operation.

This is the **second** occurrence of this trap in the graph (the first was `asTenant` in EP-003 M5),
which makes it a pattern rather than an accident. The row is now selected by matching its `vg_state=`
label rather than by position.

### 2026-09-14 — the store's statements were refused by RLS until the tenant was set

Every store operation initially failed with `new row violates row-level security policy for table
"http_idempotency"`. FORCE RLS applies to the table OWNER too (SPEC-002 RLS-4), so the statement must
carry `app.tenant_id`. All four operations now run inside a transaction with a transaction-local
setting, which is also what stops one tenant's claim colliding with another's.

Related, a diagnostic defect: the adapter reported only `begin failed`, hiding the RLS refusal. It now
includes the redacted psql output, because a specific, actionable fault should not look like a generic
one.

### 2026-09-14 — `IdempotencyStore` was a spec-named domain port that EP-002 never declared

SPEC-001 §5.1 lists `IdempotencyStore` with location `src/domain/ports/` and the reason "at-most-once
is a domain invariant (VG-ACTION-001)". EP-002 — which owns port declaration per §5.1 rule 4 —
declared neither it nor `AuthorityGrantRepository`, and its execplan never mentions them. This node
declares `IdempotencyStore` once, here. `AuthorityGrantRepository` remains undeclared and is recorded
in ASSUMPTIONS.md as an open gap.

The M5 plan text contradicted itself on the same point: it named `src/domain/ports/idempotency-store.ts`
and then said "the port is declared in the application layer". The specification's placement table won.

### 2026-09-14 — `src/http` needed the port's types, and the tenant brand, without importing the domain

Two boundary refusals in this milestone, both correct:

1. The plugin imported `IdempotencyScope`/`IdempotencyStore` from `src/domain/ports/`. The
   application contracts barrel now re-exports them.
2. The plugin constructed `new TenantId(...)`, which required importing the domain class. The fix is
   better than the workaround: `RequestContext.tenantId` now carries the BRANDED `TenantId` (the
   application layer may import the domain, ARCHITECTURE.md §2), minted ONCE by the identity plugin
   through a sanctioned `tenantIdFrom` factory. Every consumer receives the validated brand and
   cannot substitute a plain string, so there is no second place the shape can be loosened.

### 2026-09-14 — `src/http` needed the truth-state vocabulary but may not import the domain

`src/http/query/strict.ts` must validate a `truthState` filter token against the ELEVEN canonical
states. Reading them from `src/domain/truth-state.ts` directly is forbidden: ARCHITECTURE.md §2
forbids `http` from importing the domain, and `scripts/import-boundary.sh` refused it.

A second copy of the list in the HTTP layer would be worse than the violation it avoids — that is
exactly how an API comes to accept a token the state machine rejects, and the divergence would be
invisible until a caller received rows in a state the domain considers impossible.

The fix is the `src/application/contracts/index.ts` barrel: it re-exports `ALL_TRUTH_STATES` (and the
identity contract from M3), so the boundary depends on an application contract while the list keeps
ONE definition. The barrel deliberately does NOT re-export `LEGAL_TRANSITIONS` or the guard
implementations: a handler that could read the transition table would be a handler that decides a
transition, which SPEC-001 SM-6 puts inside a guarded command.

A related trap found while doing this: `ALL_TRUTH_STATES` is the export name, not `TRUTH_STATES`. The
first import used the wrong name and failed to resolve, which the typechecker caught.

### 2026-09-14 — the pagination walk terminates on the last row, with no trailing empty page

An M4 assertion expected `rows.length + 1` pages for a `limit=1` walk, assuming a final empty page.
MEASURED: 50 rows produce exactly 50 pages. The loop stops when a page returns a null `nextCursor`,
and the final page has no lookahead row to mint one from, so the walk ends on the last row. The
assertion was wrong about the implementation, not the other way round.

The cursor keyset's **id tiebreaker** (the plan's stated FALLBACK) is implemented and tested with a
seed whose 250 rows share only 5 distinct `createdAt` values — about 50 rows per tie group. A seed of
250 unique timestamps would have passed while the repeat/skip bug sat undetected.

### 2026-09-14 — THIS NODE'S OWN M3 PLAN TEXT is stale: it specifies camelCase claims and invented role names

The M3 CONTENT section says to require claims `sub`, `iss`, `aud`, `exp`, `tenantId`, `scopes`,
`authTime`, `acr`, and to declare five role bundles (`vg_analyst`, `vg_operator`, `vg_reviewer`,
`vg_auditor`, `vg_tenant_admin`).

**Neither is correct.** SPEC-003 §14 R-1 records that this file originally invented exactly those
names and that they were corrected:

> "This file originally invented camelCase claims (`tenantId`, `scopes`, `authTime`, `acr`) and role
> names (`vg_analyst`, `vg_operator`, `vg_reviewer`, `vg_auditor`, `vg_tenant_admin`) that did not
> exist in SPEC-005. → **Corrected in this file.** §3.2 now reads SPEC-005 IDP-4's claims
> (`tenant_id`, `roles`, `subject_ref`, `auth_level`) and §3.3 names SPEC-005 §2's roles."

SPEC-003 §3.2 item 2 is explicit that the API "reads `tenant_id`, `roles`, `subject_ref`, and
`auth_level` and does not invent parallel camelCase claims". SPEC-005 §2 lists **seven** roles:
`SUBJECT_USER`, `GUARDIAN`, `OPERATOR`, `TENANT_ADMIN`, `AUDITOR`, `SUPPORT`, `COUNSEL_REVIEWER`.

**Implemented to the SPECIFICATION, not to the stale plan text.** A token carrying only `tenantId` is
missing `tenant_id` and is refused `TOKEN_INVALID_CLAIMS`; a test asserts that specific case so the
camelCase names cannot creep back in. The five `vg_*` bundles appear nowhere in the code — a token
carrying one would grant nothing and a route checking for one would deny every legitimate caller.

This is the same class of defect as the SPEC-003 §5.9.1 scope line recorded below: a plan transcribed
from a draft the specification later corrected. **The plan's M3 CONTENT paragraph should be amended.**

### 2026-09-14 — `src/http` cannot import the OIDC adapter, so the identity contract moved to `application`

`src/http/plugins/identity.ts` initially imported `bearerFrom` and the result type directly from
`src/adapters/oidc/verify.ts`. `scripts/import-boundary.sh` refused it, correctly: ARCHITECTURE.md §2
forbids `http` from importing adapters, and the reason is concrete — the identity plugin would have
been welded to one verifier, so EP-006 could not replace it without editing a route.

The refusal and the fix: `bearerFrom`, `IdentityClaims`, `IdentityRefusal`, `IdentityResult` and the
`VerifyIdentity` port now live in `src/application/contracts/identity.ts`. The adapter IMPLEMENTS that
contract, the plugin DEPENDS on it, and the composition root wires them. The boundary gate passing is
the evidence.

### 2026-09-14 — identity and tenancy became REQUIRED dependencies in `buildServer`

M1 declared `identity?` and `tenancy?` optional, with "the fail-closed default" as the rationale. That
was the wrong shape: an optional authentication plugin is a configuration in which **every route is
unauthenticated**, and a fail-closed default that depends on a caller remembering to pass an argument
is not fail-closed. Both are now required properties, so the unauthenticated configuration does not
type-check. Weakening this would be a security regression, not a convenience.

### 2026-09-14 — SPEC-006 §6.2 maps ONE wire code to TWO message templates

`DEPENDENCY_UNAVAILABLE` is the wire spelling of four domain classes, and §6.2 gives two different
templates for the same wire code (lines 660/661 vs 662/664):

| Domain code | Wire code | HTTP | Message template |
|---|---|---|---|
| `AUDIT_UNAVAILABLE` | `DEPENDENCY_UNAVAILABLE` | 503 | `A required dependency is unavailable; the operation was not performed.` |
| `STORAGE_UNAVAILABLE` | `DEPENDENCY_UNAVAILABLE` | 503 | `A required dependency is unavailable; the operation was not performed.` |
| `DEPENDENCY_UNAVAILABLE` | `DEPENDENCY_UNAVAILABLE` | 503 | `A required dependency is unavailable.` |
| `EXTERNAL_TIMEOUT` (read) | `DEPENDENCY_UNAVAILABLE` | 503 | `A required dependency is unavailable.` |

This contradicts SPEC-006 **H-3**, which requires the message to be "a fixed, non-interpolated
template string **per `code`**". A client receiving one code with two possible texts cannot depend
on either, and a contract test comparing registry to spec would fail whichever text it chose.

**Resolution:** the canonical template is the one from the row whose domain code EQUALS the wire
code (`DEPENDENCY_UNAVAILABLE`), because that row defines the code rather than merely reaching it.
Recorded in `KNOWN_MESSAGE_CONFLICTS`. The parity test asserts the conflict still has this shape and
that both templates remain present in the spec, so the resolution cannot rot silently.

**Owner ratification wanted:** SPEC-006 §6.2 should state one template for `DEPENDENCY_UNAVAILABLE`
and let the domain code carry the "operation was not performed" nuance in audit, where it belongs.

### 2026-09-14 — a message template in this node's own plan has NO specification source

The EP-004 plan's registry table gives `SCHEMA_VALIDATION_FAILED` at 422 the template
`The request is well formed but fails a semantic validation.` That string does not appear anywhere
in SPEC-003 or SPEC-006 (verified by grep). SPEC-003 §8.2 does give the code two statuses with
`(syntax)` and `(semantic)` parentheticals, so the DISTINCTION is specified — but only the syntactic
template, `The request body is malformed.`, is actually stated.

This is recorded rather than silently adopted as a spec quote. The registry uses the SPEC-006
syntactic template as canonical for the code (lowest status wins), keeps the semantic spelling for
the 422 case, and the parity test asserts that the chosen canonical text is the one SPEC-006 states.
The plan's untraceable sentence is left in the plan, annotated here.

### 2026-09-14 — one §5.3 class carries two wire codes with OPPOSITE retryability

SPEC-006 §5.3 row 10 marks `IDEMPOTENCY_CONFLICT` as `Rty=N` and maps it to TWO wire codes:
`IDEMPOTENCY_KEY_REUSE` and `IDEMPOTENCY_IN_FLIGHT`. The class is correctly not retryable — retrying
a **reused** key is exactly how a duplicate external effect is submitted — but the **in-flight** case
is different: the first request has not finished, so a delayed retry is correct client behaviour.

The spec creates the distinction by naming both codes under one class, so the exception is the
spec's rather than this node's. It is declared narrowly as `IDEMPOTENCY_IN_FLIGHT` only, and a test
asserts `IDEMPOTENCY_KEY_REUSE` stays non-retryable so a later edit cannot widen it to the class.

### 2026-09-14 — SPEC-003 §8.2 and SPEC-006 §6.2 disagree on `INVALID_TRUTH_STATE` (400 vs 422)

This is the divergence the plan's Surprises comment anticipated. Found by the contract test
comparing the two specification files mechanically, not by review.

The conflict, with citations:

| Source | Status it states | Reading |
|---|---|---|
| SPEC-003 §8.2 status table | **400** | "Malformed request, missing required header/parameter, opaque-value validation" |
| SPEC-003 §2.3 | **400** | unknown `truthState` filter token is rejected, never ignored |
| SPEC-003 §5.5 (route 5.5.1 errors) | **400** | `400 INVALID_TRUTH_STATE`, `400 INVALID_CURSOR`, `400 FILTER_TOO_BROAD` |
| SPEC-003 §7.3 | **400** | "Filtering rejects unknown tokens (`400 INVALID_TRUTH_STATE`)" |
| SPEC-003 §11.4 VG-API-006 | **400** | `?truthState=DONE` returns `400 INVALID_TRUTH_STATE` |
| SPEC-006 §6.2 family table ("Codes owned by SPEC-003 §8.2") | **400** | agrees with SPEC-003 |
| SPEC-006 §6.2 domain-class table | 422 | lists it as an *example* under `INVALID_VALUE_OBJECT` (semantic) |

So **SPEC-006 contradicts itself**, and its 422 mention is not a rule about this code: that row's
own wire-code cell reads "field-specific code **from SPEC-003 §8.2**", i.e. it defers to SPEC-003
for the status of the specific code.

**Resolution: 400**, and the reasoning is recorded in `tests/contract/route-registry.test.ts`
rather than left implicit:

1. SPEC-003 §8.4 states SPEC-006 "owns the taxonomy; this file owns the **wire**", so SPEC-003's
   status wins for a wire code.
2. SPEC-006's own family table agrees at 400.
3. Semantically, an unknown `truthState` **query token** is opaque-value validation (400), not a
   semantic body failure (422). SPEC-003 §8.2's own "409 versus 422" paragraph reserves 422 for
   "the request itself is semantically invalid or a required input is absent".

The contract test pins this three ways so the resolution cannot silently rot: it asserts the
registry equals SPEC-003, asserts SPEC-006's conflicting row still says 422 (if that changes, the
resolution is stale and must be revisited), and carries a guard test that FAILS if a **second**
SPEC-003/SPEC-006 status conflict ever appears. Neither specification is edited in this node.

**Owner ratification wanted:** this is a specification defect, and the honest fix is an
amendment to SPEC-006 §6.2 naming `INVALID_TRUTH_STATE` explicitly under 400.

### 2026-09-14 — SPEC-003 §5 contains **78** routes, not 79, and 5.9.1's Scope line is unparseable

MEASURED while building the route registry, three independent ways over
`.agent/specs/SPEC-003-api-contracts.md`:

- table rows matching `` ^\| 5\.\d+\.\d+ \| ``: **78**
- bold prose headings matching `` ^\*\*5\.\d+\.\d+ ``: **78**
- the two sets match 1:1 with no gaps

Per-group: 5.1=10, 5.2=3, 5.3=10, 5.4=5, 5.5=5, 5.6=4, 5.7=6, 5.8=6, 5.9=3, 5.10=3,
5.11=3, 5.12=5, 5.13=3, 5.14=3, 5.15=2, 5.16=3, 5.17=4 → **78**.

An earlier working assumption of 79 in this session was a miscount and is corrected here.
Section 6's three webhook routes (6.1–6.3) are the only other route rows in the document and
would give 81, not 79. The registry holds **78** §5 entries, with the 3 webhook routes kept
separately in `WEBHOOK_ROUTES`.

**Source defect (SPEC-003 §5.9.1), recorded not fixed** — specifications are not edited inside
this node:

```
...or T13 (`NOT_REMOVABLE`).Scope `vg.cases.write`. Idempotency **Required**.
```

The heading sentence and the `Scope` sentence are joined with no separating whitespace, so a
line-anchored `^Scope ` extractor matches **zero** lines for this route (verified) and would
silently emit an empty scope set — a route that then denies every caller. The registry records
`vg.cases.write` for 5.9.1, established by reading the sentence.

Related, lower impact: several lines join adjacent tokens with no space (`VG-ACTION-002SPEC-001`,
`VG-IDENT-003SPEC-000`), so a tokenizer splitting on whitespace alone yields malformed IDs.

**Interpretation choice worth recording:** for 5.1.6 and 5.1.8 the `vg.pii.reveal` scope and the
step-up requirement come from the `includeValue` **query parameter**, not from the base `Scope`
line. The registry includes them, because a caller needs the scope to exercise that reveal path;
the contract test asserts the vocabulary is closed either way.

<!-- Append only observed, dated findings with the exact command that produced them.
     Record specification defects here (for example a status divergence between
     SPEC-003 §8.2 and SPEC-006 §6.2) with both citations. Never resolve a
     specification conflict by editing a specification inside this node. -->
<!-- KNOWN BEFORE EXECUTION, recorded so the executor is not surprised.
     REVISED 2026-09-14 after EP-003 closed: several of these notes were true when written
     and are now stale. Corrections are marked so the executor is not misled the other way. -->
<!-- STALE, corrected: "EP-003 is largely unstarted, so M6 is BLOCKED_PREREQUISITE on it".
     EP-003 is DONE. The schema, 10 migrations, RLS on 29 tables, the generated policies,
     the job queue and the crypto/retention adapters all exist and are asserted by
     `sh scripts/gate-data.sh` (gate-data: ok). M6 is therefore NOT blocked on EP-003. -->
<!-- STALE, corrected: "scripts/test-integration.sh is a loud-fail placeholder".
     EP-003 M9 implemented it; it now provisions, migrates, seeds, runs the database suites
     through the manifest guard, and prints `test-integration: ok`. `verify.sh` clears it. -->
<!-- STILL TRUE: scripts/security-check.sh (EP-006) and every stage after it are loud-fail
     placeholders, so `verify.sh` still exits non-zero and cannot print `verify: ok`. -->
<!-- STILL TRUE: DATABASE_URL, VALKEY_URL and KEYCLOAK_ISSUER are not exported as environment
     variables, so the RLS-over-HTTP, durable-idempotency, webhook-replay and real-IdP rows of
     this node record BLOCKED_CREDENTIALS. NOTE the nuance, because it matters for honesty:
     PostgreSQL IS provisioned and reachable (EP-003 M2/M5/M8 prove it) and its credentials
     live in the mode-0600 state file outside the repository. What is absent is the exported
     `DATABASE_URL` variable the probe reads. Those are different facts and must not be
     reported as though the database did not exist. -->

## 13. Decision Log

| # | Decision | Rationale | Status |
|---|---|---|---|
| D1 | Node verify narrowed from `sh scripts/verify.sh` to `sh scripts/gate-api.sh`. | The stub header was generic boilerplate; `verify.sh` cannot pass before an artifact exists (EP-009) and while other nodes' stages are placeholders. Narrowing prevents pressure to fake a green and removes no stage from `verify.sh`. Follows the EP-000 D1 precedent. | PENDING OWNER RATIFICATION |
| D2 | The HTTP error code registry lives in `src/http/errors/code-registry.ts`, not in the domain. | SPEC-006 §1.1 forbids domain error classes from carrying an HTTP status or a human-facing message. The domain keeps `code`/`classification`/`retryable`; the HTTP layer owns status, message, and envelope. | ACCEPTED |
| D3 | `src/application/**` is introduced as the only path from `src/http/**` to `src/domain/**`. | The `ARCHITECTURE.md` code law requires HTTP to call application contracts only. Enforcing it in `scripts/import-boundary.sh` turns a convention into a gate. | ACCEPTED |
| D4 | The node gate verifies credential-free behaviour and prints an explicit `UNVERIFIED-BY-THIS-GATE` block naming each unprovisioned dependency. | A gate that silently skips credential-dependent work would be a masking defect (DOD-024); a gate that fails forever on unprovisioned credentials would block unrelated independent work (DOD-031). Naming the gap in the gate's own output is the honest third option. | ACCEPTED |
| D5 | Handler scan is a build-time gate: no request schema may contain `truthState`, and no response DTO may contain a removal-shaped derived field. | SPEC-001 SM-6 and SPEC-003 §7.3 are the product's central safety properties; a code-review convention cannot hold them. | ACCEPTED |

## 14. Outcomes & Retrospective

<!-- Filled in only after the node closes, with real observed evidence. Include:
     which VG-API rows reached PASS and on what command; which are BLOCKED_CREDENTIALS,
     BLOCKED_PREREQUISITE, or UNVERIFIED and on whose dependency; the specification
     defects found and their citations; and the exact commands whose sentinels were
     observed. Do not record any claim this node did not execute. -->
