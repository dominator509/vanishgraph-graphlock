# ENVIRONMENT.md

Toolchain and environments are pinned during EP-000 and mirrored in PREFLIGHT.

This file is the operator-facing description of the configuration surface. The machine-readable contract is
`config/environment/schema.json` (every key, its lane, its format) and `config/environment/required.json`
(the required set per environment class and per service role); `sh scripts/config-validate.sh` keeps the two,
the operator files and the code in agreement and prints `config: ok` only when they agree.

## The three axes, which are not the same axis

| axis | values | where it lives |
|---|---|---|
| environment class (a deployment shape) | `clean-local`, `staging`, `production` | `config/environment/required.json` |
| credential lane (when a value is needed) | `REQUIRED_NOW`, `REQUIRED_BEFORE_INTEGRATION`, `REQUIRED_BEFORE_E2E`, `REQUIRED_BEFORE_DEPLOY`, `OPTIONAL`, `HUMAN_EXTERNAL` | `config/environment/schema.json`, declared in PREFLIGHT.md |
| telemetry environment token (a metric label) | `local`, `ci`, `preview`, `staging`, `production` | SPEC-007 section 2.1, enforced by `src/adapters/observability/telemetry-resource.ts` |

They are deliberately kept apart. A deployment shape is not a metric label, and `VANISHGRAPH_ENVIRONMENT` must
be one of the five tokens or the telemetry layer refuses to emit — which is why the schema validates that key
against the same five tokens rather than a second list that could drift.

## The lanes, and what they are for

- **`REQUIRED_NOW`** — the graph cannot run its current stages without it. Its absence is
  `BLOCKED_CREDENTIALS`, which blocks only the work that depends on it (DOD-032, PREFLIGHT.md).
- **`REQUIRED_BEFORE_INTEGRATION`** — needed before integration tests can be honest.
- **`REQUIRED_BEFORE_E2E`** — needed before end-to-end verification; before that it is declared and
  unprovisioned rather than quietly optional.
- **`REQUIRED_BEFORE_DEPLOY`** — needed by a deployed stack. Declared now so that a deployment is not a
  discovery.
- **`OPTIONAL`** — the product runs without it; the feature that depends on it fails closed and names the key.
- **`HUMAN_EXTERNAL`** — only a human can supply it. No automation may derive, guess or default it.

## Why the schema covers more keys than the two operator files

The EP-009 plan says the schema key set must equal the union of `.env.example` and PREFLIGHT.md. That rule is
kept for the **credential contract** — the guard fails if the two files disagree in either direction, and it
fails if a credential key is missing from the schema — and it is deliberately **widened** for the keys the code
reads with defaults (`PORT`, `HOST`, `LOG_LEVEL`, the three `VANISHGRAPH_METRICS_*` keys, `VG_COMMIT`,
`VG_REPLAY_LOG`, `RECIPE_VERIFICATION_KEYS`, the local provisioning keys, the two test DSNs). A schema that
omitted them could not validate them, and an operator looking for the metrics bind address would find nothing.
The widening is recorded in the ledger rather than left for a reader to notice.

The complementary rule closes the gap the plan's rule cannot see: a key that is **required** by the code and
declared in **no** operator file is reported as `REQUIRED_KEY_UNDECLARED`. That is not hypothetical — it found
four keys in this tree (below).

## What this milestone found and fixed

`src/adapters/config/security-config.ts` requires eight variables and aborts when any is unset. Four of them —
`KEYCLOAK_PORTAL_AUDIENCE`, `KEYCLOAK_SERVICE_AUDIENCE`, `KEYCLOAK_MCP_AUDIENCE`, `KEYCLOAK_STEP_UP_ACR` — were
declared in **neither** `.env.example` nor `PREFLIGHT.md`. An operator provisioning from the declared contract
could not have discovered them, and the first start that wires the security boundary would have aborted on a
key no document named. They are now declared in both files, classified `REQUIRED_BEFORE_E2E` (no runtime path
calls `readSecurityConfig` yet, so they block nothing today; they become blocking when the boundary is wired
in), and the guard reports this class of gap from now on.

## Validating a real environment

```sh
sh scripts/config-validate.sh                                             # the declared surface, plus the self-test
sh scripts/config-validate.sh --environment staging --file /path/to.env    # a real environment, fail closed
sh scripts/config-validate.sh --environment staging --process             # the process environment
sh scripts/config-validate.sh --example /path/to/.env.example              # an example file, placeholder-only
```

A real environment is refused when a required key for that class is absent, set to an empty string, set to a
prohibited placeholder, malformed for its declared format, or outside its declared enum; and when a key is
present that the schema does not know, because warn-only is not permitted. **No value is ever printed**: the
output names keys and reason codes, and the guard enforces that with a canary whose appearance in any output is
itself a failure.

### Reason codes

`MISSING_REQUIRED_KEY`, `EMPTY_VALUE`, `PROHIBITED_SUBSTITUTE`, `MALFORMED_VALUE`, `ENUM_VIOLATION`,
`UNKNOWN_KEY`, `VALUE_PRESENT`, `DUPLICATE_KEY`, `MALFORMED_LINE`, `UNDECLARED_IN_PREFLIGHT`,
`MISSING_FROM_EXAMPLE`, `UNDECLARED_IN_SCHEMA`, `STALE_SCHEMA_DECLARATION`, `CODE_KEY_UNDECLARED_IN_SCHEMA`,
`REQUIRED_KEY_UNDECLARED`, `REQUIRED_FLAG_DRIFT`, `REQUIRED_SET_DRIFT`, `DEPENDENCY_SET_DRIFT`,
`PROBE_MISSING`, `LANE_UNKNOWN`, `FORMAT_UNKNOWN`, `SCHEMA_SHAPE_INVALID`, `CLASS_UNKNOWN`,
`SPEC_TABLE_UNPARSEABLE`, `PREFLIGHT_TABLE_MISSING`, `CODE_LIST_UNPARSEABLE`, `CONTROL_DID_NOT_FAIL`,
`CONTROL_UNEXPECTED_CODE`, `CONTROL_DID_NOT_NAME_KEY`, `CONTROL_RESTORE_FAILED`, `VALUE_LEAKED`.

`CONTROL_*` reasons are about the guard itself: it runs five negative controls on every invocation (remove a
required key, empty a required value, substitute a placeholder, malform a value, add an unknown key), requires
the typed failure for each, and then proves restoration by re-validating the untouched fixture. A validator
that reports only good news is a placebo, so a control that stops discriminating fails the guard.

## Dependencies, per role, from the specification

`config/environment/required.json` records the required and optional dependency set per service role, and the
guard compares it with the **SPEC-007 section 7.2 table parsed from the specification**: `postgresql`
(both roles, 300 ms), `valkey` (both, 200 ms), `object-store` (both, 400 ms), `keycloak-jwks` (web only,
300 ms), `provider-transport` (worker only, 1000 ms each) and `job-worker` (required for NO role, by design:
a stalled worker fleet must be visible without taking the web tier down).

## Provisioned here, and not

Measured in this environment (`.agent/evidence/`): PostgreSQL 16, Valkey, MinIO and Keycloak 26.0.8 are
provisioned as disposable local containers and their probes are demonstrated by induced failure; a real Stripe
**test** key was used for one read-only balance request whose induced state is an auth rejection. **Not**
provisioned: a local model endpoint, the four Keycloak audience/ACR values (no realm client registration was
created), a GitHub App, and the postal and search provider entitlements. Each unprovisioned `REQUIRED` key is
reported as `BLOCKED_CREDENTIALS` by `sh scripts/validate-env.sh`, which blocks only the work that depends on
it. No key is ever given a default to make a run look complete.
