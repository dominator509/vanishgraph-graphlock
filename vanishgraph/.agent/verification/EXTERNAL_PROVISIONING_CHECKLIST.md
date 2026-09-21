# External provisioning checklist

**For:** the human repository owner. **Epoch:** `FORGE-SPEC-10` (`.agent/verification/state/RUN_STATE.json:17`).
**Pinned artifact:** `dist/vanishgraph-0.1.0.tgz` = `sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46`
(`.agent/verification/state/ARTIFACT_IDENTITY.json:20`).
**Verdict today:** `NO_GO` with 3 release blockers — `VERIFY-NOT-OK`, `EXTERNAL-GATES-UNSIGNED`, `NO-PASSING-ID`
(`.agent/verification/state/RELEASE_GATE.json:2`, `:93`, `:99`, `:105`) — and 0 of 5 mandatory external gates signed
(`.agent/evidence/EP-010/V-021/external-gates.jsonl:1-5`).

This document lists **only** the items that a human outside the harness must obtain, register, create or sign. Every
claim below is a citation into this repository; nothing is invented. Where the repository does not say how to obtain
an item, the step says so instead of guessing.

## 1. How to use this list

### What an item unlocks

- A credential is classified into one **lane** — `REQUIRED_NOW`, `REQUIRED_BEFORE_INTEGRATION`, `REQUIRED_BEFORE_E2E`,
  `REQUIRED_BEFORE_DEPLOY`, `OPTIONAL`, `HUMAN_EXTERNAL` — and the lane decides *when* it starts blocking work
  (`config/environment/schema.json:17-32`; lanes declared in `PREFLIGHT.md:36`).
- **A blocked credential blocks only its dependent work.** `PREFLIGHT.md:36` states it, `config/environment/schema.json:26`
  defines `BLOCKED_CREDENTIALS` as "not a defect", `ENVIRONMENT.md:24-25` repeats it for `REQUIRED_NOW`, and
  `scripts/validate-env.sh:11-14` implements it (absent `REQUIRED` credentials do **not** fail that gate).
  `DOD-031` passes because every block carries an explicit dependency edge
  (`.agent/verification/state/DOD_STATUS.jsonl:31`).
- Neither provisioning nor signing removes the two *product* blockers; see the final section.

### The order to execute this list in

**Part A and Part C first, Part B last.** A sign-off is bound to the pinned artifact digest, and a signature over
bytes that no longer exist attests nothing: the five requests were already re-issued once because the candidate
artifact changed, and the reissue reason names both digests
(`.agent/evidence/EP-010/V-021/external-gates.jsonl:1`, field `reissueReason`; `.agent/evidence/EP-010/V-021/SIGNOFF_INSTRUCTIONS.md:30-31`).
Any change that changes the artifact revokes every affected downstream result (`DOD-040`,
`.agent/verification/state/DOD_STATUS.jsonl:40`). So: provision → re-pin the artifact → sign → re-run the ship gate.

### How to verify a provisioning step (and what the probes really do)

Three commands are the honest checks. All three are read-only with respect to the credential: no command in this
repository prints a credential value (`ENVIRONMENT.md:69-71`).

| command | sentinel on success | what it reports |
|---|---|---|
| `sh scripts/preflight.sh` | `preflight: ok` (`scripts/preflight.sh:53`) | a `NOTICE` naming the unprovisioned keys among `DATABASE_URL`, `VALKEY_URL`, `S3_ENDPOINT`, `KEYCLOAK_ISSUER`, `LOCAL_MODEL_ENDPOINT`, `GITHUB_APP_ID`, with capability state `BLOCKED_CREDENTIALS` (`scripts/preflight.sh:39-51`) |
| `sh scripts/validate-env.sh` | `env validation: ok` (`scripts/validate-env.sh:110`) | a `NOTICE` listing **every** unprovisioned `REQUIRED` key, "state BLOCKED_CREDENTIALS, blocking only their dependent work (DOD-032)" (`scripts/validate-env.sh:104-108`) |
| `sh scripts/config-validate.sh --environment <clean-local\|staging\|production> --file <env-file>` | `config: ok` (`scripts/config-validate.sh:3`, `:507`) | a missing, empty, placeholder, malformed or out-of-enum value, or an unknown key, for that environment class (`ENVIRONMENT.md:61-71`; `config/environment/required.json:9-77`) |

A required key set to any of the prohibited substitutes (`PROVISION_ME`, `CHANGEME`, `TODO`, `PLACEHOLDER`,
`PASSWORD`, `NONE`, `-`, …) is **ABSENT**, not configured, and is reported with reason code
`PROHIBITED_SUBSTITUTE` (`config/environment/schema.json:55-74`).

**Caveat — the ten declared probes cannot report success in this tree.** Every `scripts/probes/*.sh` is a
pre-discovery loud-fail placeholder: it checks that its variable is present and then fails, deliberately, because
the previous version "printed 'probe ok' without reading the credential, contacting the service, or verifying
anything" (`scripts/probes/keycloak.sh:9-14`), and the shared helper states "This helper NEVER prints a success
sentinel. It has no success path." (`scripts/lib/loud-fail.sh:16-24`). Its two possible outputs are:

- key unset → `ERROR: <KEY> is unset; see PREFLIGHT.md and .env.example; provision it then re-run; unblocked by EP-0NN`
  (`scripts/lib/loud-fail.sh:33`; measured in `.agent/evidence/EP-010/V-013/probe-STRIPE_SECRET_KEY.log:1-3`);
- key set → `ERROR: <KEY> probe is an unimplemented placeholder; ...` (`scripts/lib/loud-fail.sh:22`), exit 1.

Consequently the `provisioningAction` recorded on the blocked ledger rows ("run `scripts/probes/stripe.sh` until it
exits 0"; `.agent/evidence/EP-010/V-013/HIPAA-011/status.json:33`) is **not achievable as written** in this tree. Use
the probe only to see *whether the variable is set at all*, and use the three commands above as the provisioning
evidence. Every Part A item therefore carries a **What must be implemented first** bullet that names its declared probe
(or records that no probe is declared), so that "obtain the credential" is never mistaken for "the dependent work can
now clear". Two further recorded irregularities, so the owner is not surprised:

- `scripts/probes/postal_api.sh` reads `LOB_API_KEY` only (`scripts/probes/postal_api.sh:17`), so it is the same probe
  for the `LOB_API_KEY`, `CLICK2MAIL_API_KEY` and `POSTGRID_API_KEY` rows (`PREFLIGHT.md:22-24`); running it for
  Click2Mail prints `ERROR: LOB_API_KEY is unset` (`.agent/evidence/EP-010/V-019/probe-CLICK2MAIL_API_KEY.log:1`).
- The probes name `EP-013`, `EP-003`, `EP-006` and `EP-009` as their unblocking node, while `.agent/GRAPH.md:4-14`
  declares only `EP-000`…`EP-010`.

### Where values go, and the one rule that must not be broken

- Values go in **your environment file** (a `.env`, or a file passed to `config-validate.sh --file`). `.env` and
  `.env.*` are gitignored except `.env.example`, and `*.pem` / `*.key` are gitignored, under the heading
  "Never commit credentials (VG-SEC-002)" (`.gitignore:15-20`).
- `.env.example` must keep **only** the `PROVISION_ME` placeholder: any other value there fails
  `scripts/validate-env.sh:73-80` as a leak (VG-SEC-002).
- A **new** key that the code reads must first be added to both `PREFLIGHT.md` and `.env.example`, and to
  `config/environment/schema.json`; otherwise the guards report `REQUIRED_KEY_UNDECLARED`,
  `UNDECLARED_IN_PREFLIGHT` or `MISSING_FROM_EXAMPLE` (`ENVIRONMENT.md:44-46`, `:75-82`; `scripts/validate-env.sh:47-71`).
  Only Part C item C-1 requires that today.
- If you reach a provider through a vendor SDK or vendor data, `LICENSE_POLICY.md:19-28` binds it: exact revision,
  SPDX identifier and full licence text, provenance, attribution, security review, commercial **and** open-source
  compatibility; a no-licence or "all rights reserved" source is FORBIDDEN (`LICENSE_POLICY.md:38`), and the entry
  must exist in `config/licences/runtime-allowlist.json` or the licence gate fails (`LICENSE_POLICY.md:74-82`).

## Part A — Credentials and registrations

**Why this order.** It is measured, not guessed: (1) items that flip a registry ID in the current epoch, most IDs
first; (2) items that unblock a whole lane, environment class or mandatory gate even without naming an ID, widest
first; (3) `OPTIONAL` entitlements; (4) `HUMAN_EXTERNAL` items that block nothing today. The ID counts come from the
`FORGE-SPEC-9` rows of `.agent/verification/state/TEST_LEDGER.jsonl`; the lane facts come from
`config/environment/schema.json` and `config/environment/required.json`.

Measured starting point: of the 484 accounted IDs in this epoch, exactly **7** are `BLOCKED_CREDENTIALS`, 205 are
`BLOCKED_PREREQUISITE` (190 on `capability:execution-mapping`, 15 on `capability:per-id-definition` — not
credentials), 4 are `BLOCKED_ENVIRONMENT` (deployed target, Part C), 1 is `BLOCKED_SAFETY` (Part C), 1 is
`DEFERRED_LONG_RUNNING` (Part C), 266 are `PARTIAL`
(`.agent/evidence/EP-010/M2-applicability/accounting.json:4-8`; `.agent/verification/state/RELEASE_GATE.json:14-33`).

### A-1 `STRIPE_SECRET_KEY` — 5 IDs, the single highest-yield item

- **What it is** — an `OPTIONAL`-lane provider entitlement: the secret key of the payment provider whose transport
  the worker role reaches. It is an entitlement, not a defect: a missing entitlement fails closed at the transport
  and is reported as `BLOCKED_CREDENTIALS` rather than substituted (`config/environment/required.json:109`).
- **Where it is declared** — `PREFLIGHT.md:25`; `config/environment/schema.json:267-276`; `.env.example:20`;
  `config/environment/required.json:122`.
- **How to obtain or create it** —
  1. The endpoint this repository's own attempt reached is `https://api.stripe.com/v1/balance`
     (`.agent/evidence/EP-008/induced-failure/provider-transport-attempt.txt:1`); the attempt answered `HTTP 401`
     without a credential, which the repository names as the *induced* state of its fail-closed proof
     (`.agent/verification/state/NEXT_ACTION.md:9-12`).
  2. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: how to create or recover the account, where
     the API keys are issued, and whether a read-only/restricted key is sufficient. The vendor key prefixes
     (`sk_live_`, `sk_test_`, `rk_`) are recorded as a *documented but deliberately unenforced* format
     (`config/environment/schema.json:275`), so the probe will not tell you whether you pasted the right kind of key.
  3. Prefer a test-mode key first: the transport is exercised read-only or as a no-op, "never a form write"
     (`.agent/evidence/EP-008/M5-probes-partial.txt:21-22`).
  4. Put the value in your environment file (never in `.env.example`, never committed — `.gitignore:15-18`).
- **How to verify it is provisioned** — `sh scripts/probes/stripe.sh` must stop printing
  `ERROR: STRIPE_SECRET_KEY is unset` (`.agent/evidence/EP-010/V-013/probe-STRIPE_SECRET_KEY.log:1`); then
  `sh scripts/validate-env.sh` must print `env validation: ok` with `STRIPE_SECRET_KEY` absent from the `NOTICE`
  list, and `sh scripts/config-validate.sh --environment staging --file <env-file>` must print `config: ok`. Then
  re-run the owning stage: `sh scripts/harness-run-stage.sh V-013`
  (`.agent/execplans/EP-010-node.md:762`).
- **What must be implemented first** — the probe is a **loud-fail placeholder**: it checks only that the variable is
  present and then exits 1 (`scripts/probes/stripe.sh:13-18`), because the shared helper "NEVER prints a success
  sentinel. It has no success path." (`scripts/lib/loud-fail.sh:16-24`; the fail call is `:22-23`, the presence check
  `:28-36`). Obtaining the key therefore does **not** make `sh scripts/probes/stripe.sh` exit 0, and the five dependent
  IDs cannot clear on the credential alone: the probe's own success path — "that is the EP-000 M1 discovery
  implementation" (`scripts/probes/stripe.sh:13-14`) — has to be implemented and demonstrated first. Treat this item as
  "obtain the key **and** have the probe implemented", not "obtain the key".
- **What it unblocks** — exactly **5** registry IDs in `FORGE-SPEC-9`, all `BLOCKED_CREDENTIALS` with
  `blockingDependency` `capability:provider-entitlement` and edge `capability:provider-entitlement->V-013`:
  `HIPAA-011` (`.agent/verification/state/TEST_LEDGER.jsonl:6093`), `HIPAA-077` (`:6138`), `HIPAA-106` (`:6158`),
  `HIPAA-111` (`:6161`), `HIPAA-113` (`:6163`). Stage `V-013` currently reports `BLOCKED_CREDENTIALS=6` of its 298
  IDs (`DEPENDENCY_BLOCKER_GRAPH.json`, `stage_runs`, epoch `FORGE-SPEC-9`). It also clears the entitlement half of
  the `provider-transport` `EXTERNAL_REQUIRED` row (`.agent/verification/state/NEXT_ACTION.md:9-16`) and of
  `LIVE-FIRE-PROOF-08` (`.agent/evidence/EP-010/V-020/live-fire/live-fire-proof-08.status:1-3`). It does not touch
  `EXTERNAL-GATES-UNSIGNED`.
- **Where to record it** — your environment file only. The key is already declared in `PREFLIGHT.md:25`,
  `.env.example:20` and `config/environment/schema.json:267`, so no contract file needs a new row. **Never commit it**
  (`.gitignore:15-18`, VG-SEC-002).

### A-2 `CLICK2MAIL_API_KEY` — 2 IDs

- **What it is** — an `OPTIONAL`-lane provider entitlement on the postal transport (a mail/print provider key).
- **Where it is declared** — `PREFLIGHT.md:23`; `config/environment/schema.json:247-256`; `.env.example:18`;
  `config/environment/required.json:120`.
- **How to obtain or create it** —
  1. The postal transport the repository probed is `https://api.lob.com/v1/us_verifications`
     (`.agent/evidence/EP-008/induced-failure/provider-transport-attempt.txt:2`).
  2. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: account creation, key issuance, and the
     Basic-auth variable names. `config/environment/schema.json:255` states plainly that this tree declares an API
     key only, that the provider's transport also accepts HTTP Basic credentials, and that "those variable names are
     NOT declared anywhere in this repository".
  3. Put the value in your environment file; keep the read-only posture the transport declares
     (`.agent/evidence/EP-008/M5-probes-partial.txt:21-22`).
- **How to verify it is provisioned** — `sh scripts/probes/postal_api.sh` (which reads `LOB_API_KEY`, see the caveat
  above) must stop printing `ERROR: LOB_API_KEY is unset`
  (`.agent/evidence/EP-010/V-019/probe-CLICK2MAIL_API_KEY.log:1`); `sh scripts/validate-env.sh` → `env validation: ok`
  with no `NOTICE` line for the key. Then `sh scripts/harness-run-stage.sh V-013` (`:6142` and `:6219` both belong to
  stage `V-013`) or `sh scripts/harness-run-stage.sh V-019` (`.agent/execplans/EP-010-node.md:768`).
- **What must be implemented first** — `scripts/probes/postal_api.sh` is a loud-fail placeholder that checks presence
  and then exits 1 (`scripts/probes/postal_api.sh:13-18`; `scripts/lib/loud-fail.sh:16-24`, `:22-23`, `:28-36`), and it
  reads `LOB_API_KEY`, not this key. Provisioning `CLICK2MAIL_API_KEY` will not make any probe exit 0, so the credential
  alone cannot clear the two IDs; the postal transport's real reachability check has to be implemented first
  (`scripts/probes/postal_api.sh:13-14`).
- **What it unblocks** — **2** IDs: `HIPAA-083` (`.agent/verification/state/TEST_LEDGER.jsonl:6142`, stage `V-013`)
  and `HIPAA-119` (`:6219`, stage `V-019`), each `BLOCKED_CREDENTIALS` on `capability:provider-entitlement`
  (`DEPENDENCY_BLOCKER_GRAPH.json`, `stage_runs`: `V-013` `BLOCKED_CREDENTIALS=6`, `V-019` `BLOCKED_CREDENTIALS=1`).
- **Where to record it** — your environment file only; already declared in `PREFLIGHT.md:23`, `.env.example:18`,
  `config/environment/schema.json:247`. **Never commit it.**

### A-3 A Keycloak realm client registration producing the four `REQUIRED_BEFORE_E2E` values

- **What it is** — one human task in the identity provider: register the realm clients/audiences that yield
  `KEYCLOAK_PORTAL_AUDIENCE`, `KEYCLOAK_SERVICE_AUDIENCE`, `KEYCLOAK_MCP_AUDIENCE` and `KEYCLOAK_STEP_UP_ACR`. Three
  separate audiences are required — "a single shared audience would make a service token acceptable to the portal
  surface" (`config/environment/schema.json:205`) — and `KEYCLOAK_STEP_UP_ACR` is "the single declared acr value of
  SPEC-003 section 3.2 item 6; the six step-up classes compare against it" (`config/environment/schema.json:215`).
- **Where it is declared** — `PREFLIGHT.md:16-19`; `config/environment/schema.json:177-216` (lane
  `REQUIRED_BEFORE_E2E`); `.env.example:11-14`; required for `staging` and `production`
  (`config/environment/required.json:39-42`, `:64-67`) and explicitly **not** for `clean-local`
  (`config/environment/required.json:25`).
- **How to obtain or create it** —
  1. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: no realm name, client type, audience-mapping
     or acr/step-up configuration procedure is written anywhere. The repository records only that "no realm client
     registration was created" (`ENVIRONMENT.md:101-102`) and that the values "come from the realm client
     registration, which is a human task" (`config/environment/schema.json:185`).
  2. Use the same identity service the environment already uses; the local disposable instance is Keycloak 26.0.8
     (`ENVIRONMENT.md:98-99`) and the issuer must be `https` with verified TLS
     (`config/environment/schema.json:140-144`; `KEYCLOAK_ISSUER` uses the `HTTPS_URL` format,
     `config/environment/schema.json:37`).
  3. Put the four values in your environment file. Nothing in the contract files needs to change — the four keys were
     added to both operator files in EP-009 precisely so an operator could discover them (`ENVIRONMENT.md:48-56`).
- **How to verify it is provisioned** — `sh scripts/config-validate.sh --environment staging --file <env-file>` must
  print `config: ok` (`config/environment/required.json:39-42` makes them required for that class; the `IDENTIFIER`
  format is checked, `config/environment/schema.json:39`). The four keys have **no probe**
  (`PREFLIGHT.md:16-19`, probe column `-`), so the guard is the verification.
- **What must be implemented first** — **no probe is declared for these four keys** (`PREFLIGHT.md:16-19`, probe column
  `-`), so there is no loud-fail probe to implement here and no probe success path is owed; the loud-fail placeholders
  only affect the items whose `PREFLIGHT.md` rows name a script. The verification is the configuration guard alone
  (`sh scripts/config-validate.sh`, `scripts/config-validate.sh:3`, `:507`).
- **What it unblocks** — no registry ID names these keys directly, but they gate the widest set of downstream work:
  `DOD-020` is `BLOCKED_CREDENTIALS` because "the audience and ACR keys are `REQUIRED_BEFORE_E2E` and unprovisioned,
  so no production-class configuration resolves"
  (`.agent/verification/state/DOD_STATUS.jsonl:20`); the authenticated half of the golden path is
  `EXTERNAL_REQUIRED` for the same reason ("no realm client registration exists here, so no token with a registered
  audience can be minted", `.agent/evidence/EP-010/M5-clean-room-live-fire-external-gates.txt:55-57`;
  `.agent/evidence/EP-010/V-020/clean-room-inventory.txt:8`), which is the evidence `EXT-GATE-01` needs; and it is a
  precondition of any honest `staging`/`production` class configuration. **Reconciliation note:** `DOD-020`'s
  evidence says "(7 ID(s) blocked on credentials)", but the seven `BLOCKED_CREDENTIALS` rows of this epoch name
  `STRIPE_SECRET_KEY` (5) and `CLICK2MAIL_API_KEY` (2), not the audience keys. Both statements are in the record;
  the ledger rows are the per-ID facts. Nothing blocks at startup today: "No runtime path calls
  `readSecurityConfig` yet, so its absence blocks nothing today" (`config/environment/schema.json:185`).
- **Where to record it** — your environment file only; already declared in `PREFLIGHT.md:16-19`, `.env.example:11-14`,
  `config/environment/schema.json:177-216`. The values are non-secret identifiers, but the file that carries them also
  carries secrets, so it stays uncommitted (`.gitignore:15-18`).

### A-4 Deployment-class values for the ten `REQUIRED_NOW` credentials

- **What it is** — the `REQUIRED_NOW` set a *deployed* class needs:
  `DATABASE_URL`, `VALKEY_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`,
  `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, `SESSION_SECRET`. Locally they already exist as
  disposable containers (PostgreSQL 16, Valkey, MinIO, Keycloak 26.0.8 — `ENVIRONMENT.md:98-100`); the owner supplies
  the managed equivalents for a deployed class and for any machine that must run `npm run serve`.
- **Where it is declared** — `PREFLIGHT.md:6-15`; `config/environment/schema.json:76-176`; `.env.example:1-10`;
  required set for `clean-local` (`config/environment/required.json:12-23`), `staging` (`:29-48`) and `production`
  (`:54-73`); the `web` role requires all ten plus the object-store keys (`config/environment/required.json:82-95`),
  the `worker` role requires the same storage and secret material without the Keycloak credentials (`:100-110`).
- **How to obtain or create it** —
  1. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: no managed PostgreSQL, Valkey/Redis or
     S3-compatible object-store product, region or console is named. The declared formats are what you must satisfy:
     `POSTGRES_DSN` (`postgres`/`postgresql` URL with a host), `REDIS_URL` (`redis`/`rediss` URL with a host),
     `HTTP_URL`, `IDENTIFIER`, `SECRET`, `S3_BUCKET_NAME` (3–63 chars, lowercase/digits/dots/hyphens)
     (`config/environment/schema.json:34-42`).
  2. `SESSION_SECRET` is a secret you generate yourself; the only requirement stated is `SECRET` with
     `minimum_length: 32`, mirroring what `src/adapters/config/security-config.ts` already enforces
     (`config/environment/schema.json:167-176`). **NOT DOCUMENTED IN THIS REPOSITORY**: how to generate it.
  3. `KEYCLOAK_ISSUER` must be `https` — plaintext issuers are refused (`config/environment/schema.json:37`, `:140-144`).
  4. Put the values in the environment file of that machine; `DATABASE_URL` carries credentials in its userinfo and is
     treated as secret, so the guard never prints it (`config/environment/schema.json:84`).
- **How to verify it is provisioned** — `sh scripts/preflight.sh` → `preflight: ok` with no `NOTICE` for
  `DATABASE_URL`, `VALKEY_URL`, `S3_ENDPOINT`, `KEYCLOAK_ISSUER` (`scripts/preflight.sh:39-51`);
  `sh scripts/validate-env.sh` → `env validation: ok`; and per class,
  `sh scripts/config-validate.sh --environment <class> --file <env-file>` → `config: ok`.
- **What must be implemented first** — four of the ten keys have loud-fail placeholder probes —
  `DATABASE_URL` (`scripts/probes/database_url.sh:13-18`), `VALKEY_URL` (`scripts/probes/valkey_url.sh:13-18`),
  `S3_ENDPOINT` (`scripts/probes/object_store.sh:13-18`) and `KEYCLOAK_ISSUER` (`scripts/probes/keycloak.sh:13-18`) —
  each of which checks presence and then exits 1 (`scripts/lib/loud-fail.sh:16-24`, `:22-23`, `:28-36`). The other six
  (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`,
  `SESSION_SECRET`) have **no probe** (`PREFLIGHT.md:9-11`, `:13-15`). Provisioning therefore does not make any probe
  exit 0; the four declared probes' real reachability checks have to be implemented first.
- **What it unblocks** — the six variables of `README.md:69-76` are precisely what `npm run serve` refuses to start
  without, and that published command is one of the three `BLOCKED_CREDENTIALS` commands recorded when the published
  commands were executed as written (`.agent/evidence/EP-009/drills/gate-published-commands.log:12-15`, DOD-023
  passing with those three recorded). It is a precondition of every artifact-bound stage that must run against a
  deployed artifact (`DOD-004`, `.agent/verification/state/DOD_STATUS.jsonl:4`) and of
  `sh scripts/config-validate.sh --environment production --file <env-file>` in the production procedure
  (`deploy/production/README.md:35-39`). No registry ID names these keys, so no ID count moves on provisioning alone.
- **Where to record it** — the environment file for that class, never committed (`.gitignore:15-20`). All ten keys are
  already declared in `PREFLIGHT.md:6-15`, `.env.example:1-10` and `config/environment/schema.json:76-176`, so no
  contract change is needed.

### A-5 A GitHub App registration — 3 values, `REQUIRED_BEFORE_DEPLOY`

- **What it is** — a GitHub App plus its installation, yielding `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and
  `GITHUB_INSTALLATION_ID`; the declared observation credentials for the CI pipeline.
- **Where it is declared** — `PREFLIGHT.md:27-29`; `config/environment/schema.json:287-316`; `.env.example:22-24`;
  required for `staging` and `production` (`config/environment/required.json:45-47`, `:70-72`).
- **How to obtain or create it** —
  1. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: how to register the app, generate and download
     the private key, install the app on the repository, and read the installation id. The repository names no
     account, organisation or app name.
  2. Satisfy the declared formats: both ids are `NUMERIC_ID` — "a value that is not is a mistyped credential, not a
     username" (`config/environment/schema.json:40`) — and the private key must be a PEM block with matching BEGIN/END
     lines (`config/environment/schema.json:41`). The probe is declared for `GITHUB_APP_ID` only
     (`PREFLIGHT.md:27`; the other two rows carry `-`).
  3. Never commit the key: `*.pem` and `*.key` are gitignored, and `.env`/`.env.*` are gitignored
     (`.gitignore:15-20`).
- **How to verify it is provisioned** — `sh scripts/probes/github_app.sh` must stop printing
  `ERROR: GITHUB_APP_ID is unset` (`scripts/probes/github_app.sh:17`; the probe is a loud-fail placeholder, see the
  caveat above); `sh scripts/validate-env.sh` → `env validation: ok` with no `NOTICE` for the three keys.
- **What must be implemented first** — `scripts/probes/github_app.sh` is a loud-fail placeholder: presence check only,
  then exit 1 (`scripts/probes/github_app.sh:13-18`; `scripts/lib/loud-fail.sh:16-24`, `:22-23`, `:28-36`). It also
  covers `GITHUB_APP_ID` alone — the private key and the installation id have no probe (`PREFLIGHT.md:28-29`). So the
  credential set does not make the probe exit 0, and remote CI observation needs the app-reachability path implemented
  first.
- **What it unblocks** — remote observation of the CI pipeline: "The pipeline has never run remotely. The declared
  observation credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`) are unprovisioned, so
  remote observation is `BLOCKED_CREDENTIALS`" (`DEPLOYMENT.md:39-43`; `.github/workflows/ci.yml:12-13`;
  `RELEASE.md:64`). No registry ID names them. Note the pipeline would still fail two stages by design
  (`live-fire` is a placeholder; `smoke`/`e2e` need the digest binding — `DEPLOYMENT.md:41-43`), so provisioning alone
  does not produce a green pipeline.
- **Where to record it** — your environment file (and CI secrets for the remote job). Already declared in
  `PREFLIGHT.md:27-29`, `.env.example:22-24`, `config/environment/schema.json:287-316`. **Never commit the private key.**

### A-6 `LOCAL_MODEL_ENDPOINT` — `REQUIRED_BEFORE_INTEGRATION`

- **What it is** — the HTTP endpoint of the local model server the integration lane requires.
- **Where it is declared** — `PREFLIGHT.md:20`; `config/environment/schema.json:217-226` (`HTTP_URL`, lane
  `REQUIRED_BEFORE_INTEGRATION`); `.env.example:15`; required for `staging` and `production`
  (`config/environment/required.json:44`, `:69`), not for `clean-local` (`:12-23`).
- **How to obtain or create it** —
  1. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: which model server to run, its image or
     package, its port, and whether it must be reachable from the worker. `ENVIRONMENT.md:101-102` records only that a
     local model endpoint is **not** provisioned here.
  2. Supply an `http`/`https` URL with a host (`config/environment/schema.json:36`).
- **How to verify it is provisioned** — `sh scripts/probes/local_model.sh` must stop printing
  `ERROR: LOCAL_MODEL_ENDPOINT is unset` (`scripts/probes/local_model.sh:17`); `sh scripts/preflight.sh` must drop it
  from its `NOTICE` (`scripts/preflight.sh:39`).
- **What must be implemented first** — `scripts/probes/local_model.sh` is a loud-fail placeholder: presence check only,
  then exit 1 (`scripts/probes/local_model.sh:13-18`; `scripts/lib/loud-fail.sh:16-24`, `:22-23`, `:28-36`). Supplying
  the endpoint does not make the probe exit 0, so whether the model server actually answers is still unproven after
  provisioning; the probe's real check has to be implemented first.
- **What it unblocks** — the lane's own purpose, "needed before integration tests can be honest"
  (`config/environment/schema.json:27`), the `staging`/`production` required set
  (`config/environment/required.json:44`, `:69`) and therefore production-class configuration resolution (`DOD-020`,
  `.agent/verification/state/DOD_STATUS.jsonl:20`). No registry ID names it today.
- **Where to record it** — your environment file only; already declared in `PREFLIGHT.md:20`, `.env.example:15`,
  `config/environment/schema.json:217`.

### A-7 The remaining `OPTIONAL` provider entitlements — `SEARCH_API_KEY`, `LOB_API_KEY`, `POSTGRID_API_KEY`

- **What it is** — three `OPTIONAL` entitlements of the same class as A-1/A-2 (a search-provider key and two postal
  provider keys). The product runs without them; the feature that depends on each fails closed and names the key
  (`config/environment/schema.json:30`).

| key | declared at | probe | endpoint the repository probed |
|---|---|---|---|
| `SEARCH_API_KEY` | `PREFLIGHT.md:21`; `config/environment/schema.json:227-236`; `.env.example:16` | `scripts/probes/search_api_key.sh:17` | `https://serpapi.com/account` (`.agent/evidence/EP-008/induced-failure/provider-transport-attempt.txt:3`) |
| `LOB_API_KEY` | `PREFLIGHT.md:22`; `config/environment/schema.json:237-246`; `.env.example:17` | `scripts/probes/postal_api.sh:17` | `https://api.lob.com/v1/us_verifications` (`.agent/evidence/EP-008/induced-failure/provider-transport-attempt.txt:2`) |
| `POSTGRID_API_KEY` | `PREFLIGHT.md:24`; `config/environment/schema.json:257-266`; `.env.example:19` | `scripts/probes/postal_api.sh:17` (reads `LOB_API_KEY`) | not probed by name; the three transports are named in `.agent/evidence/EP-008/induced-failure/provider-transport-attempt.txt:1-3` |

- **How to obtain or create them** — 1. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: account
  creation and key issuance for the search provider and both postal providers. 2. One recorded naming discrepancy to
  expect, not to "fix" by renaming: `config/environment/schema.json:235` states that the EP-009 plan expects a key
  count that only adds up if a differently named key (`SERPAPI_API_KEY`) is present, that no module reads that name,
  and that the tree's declared name `SEARCH_API_KEY` is authoritative. 3. Values are `SECRET` format
  (`config/environment/schema.json:38`) and stay in your environment file.
- **How to verify they are provisioned** — each probe must stop printing `ERROR: <KEY> is unset`
  (`scripts/probes/search_api_key.sh:17`, `scripts/probes/postal_api.sh:17`), and `sh scripts/validate-env.sh` must
  print `env validation: ok`.
- **What must be implemented first** — both probes named above are loud-fail placeholders: presence check only, then
  exit 1 (`scripts/probes/search_api_key.sh:13-18`, `scripts/probes/postal_api.sh:13-18`;
  `scripts/lib/loud-fail.sh:16-24`, `:22-23`, `:28-36`). `POSTGRID_API_KEY` has no probe of its own and
  `postal_api.sh` reads `LOB_API_KEY`, so provisioning these three keys will not make any probe exit 0; the search and
  postal reachability checks have to be implemented first.
- **What they unblock** — no registry ID names them. They are the entitlements the `provider-transport` readiness row
  is waiting on: "**NEXT ACTION (an environment action, not code):** obtain an official-transport credential, set it,
  and re-run `sh scripts/induced-failure-readiness.sh`. The row becomes demonstrable with no code change"
  (`.agent/verification/state/NEXT_ACTION.md:9-16`), and they are the entitlement half of `LIVE-FIRE-PROOF-08`
  (`EXTERNAL_REQUIRED`, `.agent/evidence/EP-010/V-020/live-fire/live-fire-proof-08.status:1-3`). `DEPLOYMENT.md:24-27`
  is the command that would then print `readiness induced failure: ok`.
- **Where to record them** — your environment file only; all three are already declared in the two operator files and
  the schema at the lines above. **Never commit them.**

### A-8 `STRIPE_WEBHOOK_SECRET`

- **What it is** — the payment provider's webhook signing secret, an `OPTIONAL` key "required only where the payment
  webhook is enabled" (`config/environment/required.json:123`); the `whsec_` prefix is documented and deliberately
  not enforced (`config/environment/schema.json:285`).
- **Where it is declared** — `PREFLIGHT.md:26`; `config/environment/schema.json:277-286`; `.env.example:21`. No probe
  is declared (`PREFLIGHT.md:26`, probe column `-`).
- **How to obtain or create it** — 1. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: how to
  create the webhook endpoint and read its signing secret. 2. Enable it only if the payment webhook is enabled for
  your deployment (`config/environment/required.json:123`). 3. Your environment file, never committed
  (`.gitignore:15-18`).
- **How to verify it is provisioned** — there is no probe; the check is
  `sh scripts/config-validate.sh --environment <class> --file <env-file>` → `config: ok` with the key present and
  non-placeholder (`config/environment/schema.json:55-74`).
- **What must be implemented first** — **no probe is declared for this key** (`PREFLIGHT.md:26`, probe column `-`), so
  no loud-fail probe restricts it and no probe success path is owed. The verification is the configuration guard
  (`scripts/config-validate.sh:3`, `:507`); note that the same loud-fail limitation applies to the adjacent
  `STRIPE_SECRET_KEY` item, which is the credential that would actually exercise the payment transport.
- **What it unblocks** — nothing named per ID: it is `OPTIONAL` and `config/environment/required.json:116-142` lists it
  under `not_required_anywhere`. It matters only to the deployment that enables the webhook.
- **Where to record it** — your environment file only; already declared in `PREFLIGHT.md:26` and `.env.example:21`.

### A-9 `CLOUD_WORKLOAD_IDENTITY`

- **What it is** — an `OPTIONAL` workload-identity reference (an ARN-shaped or path-shaped identifier,
  `config/environment/schema.json:44`) for a deployment that resolves outbound credentials by workload identity
  instead of a static secret; the guard reports it missing rather than substituting a static credential
  (`config/environment/schema.json:355`, citing SPEC-006 section 7.1 item 16).
- **Where it is declared** — `PREFLIGHT.md:33`; `config/environment/schema.json:347-356`; `.env.example:28`;
  `config/environment/required.json:117`.
- **How to obtain or create it** — 1. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: no cloud is
  named (ADR-006 is still `OPEN`, `DECISIONS.md:16`, `:201`), so the identity's creation procedure and its shape are
  the provider's to state. 2. Supply a value in the `CLOUD_IDENTITY` format (letters, digits and `. _ : / @ -`;
  `config/environment/schema.json:44`). 3. Your environment file, never committed.
- **How to verify it is provisioned** — `sh scripts/probes/cloud_identity.sh` must stop printing
  `ERROR: CLOUD_WORKLOAD_IDENTITY is unset` (`scripts/probes/cloud_identity.sh:17`).
- **What must be implemented first** — `scripts/probes/cloud_identity.sh` is a loud-fail placeholder: presence check
  only, then exit 1 (`scripts/probes/cloud_identity.sh:13-18`; `scripts/lib/loud-fail.sh:16-24`, `:22-23`, `:28-36`).
  Supplying the identity reference does not make the probe exit 0; whether the workload identity actually resolves has
  to be implemented and demonstrated first.
- **What it unblocks** — nothing named per ID. It is the key that lets a deployment avoid a static credential
  (`config/environment/schema.json:355`), and it is the shape Part C item C-2's KMS decision will need.
- **Where to record it** — your environment file only; already declared in `PREFLIGHT.md:33` and `.env.example:28`.

### A-10 The `HUMAN_EXTERNAL` runner handles — `CODEX_RUNNER_HANDLE`, `CLAUDE_RUNNER_HANDLE`, `GROK_RUNNER_HANDLE`

- **What it is** — three external runner identities. The lane definition is unambiguous: "Only a human can supply it:
  no automation may derive, guess or default it" (`config/environment/schema.json:31`).
- **Where it is declared** — `PREFLIGHT.md:30-32`; `config/environment/schema.json:317-346` (`RUNNER_HANDLE` format:
  letters, digits and `. _ -`; `config/environment/schema.json:43`); `.env.example:25-27`;
  `config/environment/required.json:124-126`.
- **How to obtain or create it** — 1. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: what a valid
  handle is and where it is issued. 2. Supply a `RUNNER_HANDLE`-formatted value per runner. 3. Your environment file,
  never committed.
- **How to verify it is provisioned** — no probe is declared (`PREFLIGHT.md:30-32`, probe column `-`); the check is
  `sh scripts/config-validate.sh --environment <class> --file <env-file>` → `config: ok`.
- **What must be implemented first** — **no probe is declared for any of the three handles**
  (`PREFLIGHT.md:30-32`, probe column `-`), so there is no loud-fail probe to implement and no probe success path is
  owed for them. If a future stage delegates to an external runner, that stage's own probe path is the thing that must
  be implemented — the handle alone proves nothing.
- **What it unblocks** — **nothing today, by declaration**: "No stage in EP-000 through EP-009 delegates to an
  external runner, so an unset handle blocks nothing today; a human must supply it before any stage that does"
  (`config/environment/schema.json:325`; `config/environment/required.json:124-126`). It is listed here so the set is
  complete, not because it moves any ID or clause.
- **Where to record it** — your environment file only; already declared in `PREFLIGHT.md:30-32` and `.env.example:25-27`.

## Part B — The five external sign-off gates

All five requests are `EXTERNAL_REQUIRED` and carry the same prepared request digest. The digest to sign is the
**current pinned** tarball digest:

```
sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46
```

`dist/vanishgraph-0.1.0.tgz`, `.agent/verification/state/ARTIFACT_IDENTITY.json:20`; equal to
`requestedArtifactDigest` in all five rows of `.agent/evidence/EP-010/V-021/external-gates.jsonl:1-5`. Check it
yourself immediately before signing — the recorded command is in
`.agent/evidence/EP-010/V-021/SIGNOFF_INSTRUCTIONS.md:33-35`. **This digest changed in EP-010 M12** (from
`sha256:81215aaf…`) because the licence review `config/licences/runtime-allowlist.json` ships inside the package:
any sign-off against the older digest is refused by name. Sign the `ARTIFACT_IDENTITY.json` value, always.

| gate_id | gate | who must sign (`externalPartyRole`, verbatim) | digest to sign | what the participant is asked to do (from `preparedScenarioList`) | record |
|---|---|---|---|---|---|
| `EXT-GATE-01` | human UAT of the golden path | `Named authorised business participant` | pinned digest above | 1. Onboard a subject with a valid authority grant. 2. Register a source and record a source record. 3. Assess a match and reach `MATCH_CONFIRMED`. 4. Resolve policy and prepare a request. 5. Submit the request through the declared channel. 6. Record a controller response as a claim. 7. Record an independent verification inside the window and reach `VERIFIED_REMOVED`. 8. Detect a reappearance and raise the human gate. | `<R1>` |
| `EXT-GATE-02` | manual assistive-technology validation at WCAG 2.2 AA | `Named assistive-technology practitioner` | pinned digest above | 1. Every declared portal and console route with a screen reader. 2. Keyboard-only traversal of the onboarding steps and the human gate. 3. The loading, empty, error, access-denied and session-expiry region states. 4. Contrast and focus visibility on every region background. | `<R2>` |
| `EXT-GATE-03` | legal and compliance review of jurisdictions, agent evidence, templates and claims | `Qualified counsel` | pinned digest above | 1. The jurisdiction policy rows in `db/migrations` and the `LegalBasis` rule that a model may not author one. 2. The agent-evidence model and the discovery template set. 3. The removal, delisting and reappearance claims the product is allowed to make. 4. The data-egress matrix and its protected classes. (The standing scope is `LEGAL_REVIEW_REQUIRED.md:3`: CCPA/CPRA, California DROP, other supported jurisdictions, authorized-agent evidence, public-record exceptions, minors, DPA/transfer terms, templates, regulator escalation, mail use and product claims.) | `<R3>` |
| `EXT-GATE-04` | hardware, HSM or accredited assessment where applicable | `Accredited assessor` | pinned digest above | 1. Key-material handling: `src/adapters/crypto/local-key-provider.ts` is an in-process provider standing in for the managed KMS the project does not have. 2. The signature gap recorded in the artifact identity (status `EXTERNAL_REQUIRED`). 3. Whether an HSM is applicable to this deployment at all. | `<R4>` |
| `EXT-GATE-05` | production deployment authorization | `Authorised operator (manual only)` | pinned digest above | 1. Read back the deployed digest and compare it with the pinned digest. 2. Validate the configuration for the production class with `sh scripts/config-validate.sh --environment production --file <env-file>`. 3. Check the health surface. 4. Run the artifact-bound smoke against the deployed digest. 5. Record the operator name, the digest and the time. | `<R5>` |

The exact one-line records to append to `.agent/evidence/EP-010/V-021/signoffs.jsonl` — one line per gate,
`<…>` marks what only the signer can supply, every other field is already correct for this artifact. The `<R1>`…`<R5>`
marker at the start of each line is this document's label for the table above: **it is not part of the record and must
not be copied** into `signoffs.jsonl`.

```
<R1> {"gate_id":"EXT-GATE-01","gate":"human UAT of the golden path","status":"SIGNED","externalPartyRole":"Named authorised business participant","signerRef":"<role + roster or ticket label - no personal data beyond what the role requires>","signatureMethod":"<how the sign-off was produced and where it is kept>","signedAt":"<ISO-8601 UTC timestamp, e.g. 2026-09-22T10:00:00Z>","signedArtifactDigest":"sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46","scope":"<what you reviewed or exercised, against which scenario list>","unresolvedFindings":"none","evidencePath":"<path to the stored signature or record - the file must EXIST>","evidenceDigest":"<sha256 of that file's bytes>"}
<R2> {"gate_id":"EXT-GATE-02","gate":"manual assistive-technology validation at WCAG 2.2 AA","status":"SIGNED","externalPartyRole":"Named assistive-technology practitioner","signerRef":"<role + roster or ticket label>","signatureMethod":"<how the sign-off was produced and where it is kept>","signedAt":"<ISO-8601 UTC timestamp>","signedArtifactDigest":"sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46","scope":"<what you reviewed or exercised, against which scenario list>","unresolvedFindings":"none","evidencePath":"<path to the stored signature or record - the file must EXIST>","evidenceDigest":"<sha256 of that file's bytes>"}
<R3> {"gate_id":"EXT-GATE-03","gate":"legal and compliance review of jurisdictions, agent evidence, templates and claims","status":"SIGNED","externalPartyRole":"Qualified counsel","signerRef":"<role + roster or ticket label>","signatureMethod":"<how the sign-off was produced and where it is kept>","signedAt":"<ISO-8601 UTC timestamp>","signedArtifactDigest":"sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46","scope":"<what you reviewed or exercised, against which scenario list>","unresolvedFindings":"none","evidencePath":"<path to the stored signature or record - the file must EXIST>","evidenceDigest":"<sha256 of that file's bytes>"}
<R4> {"gate_id":"EXT-GATE-04","gate":"hardware, HSM or accredited assessment where applicable","status":"SIGNED","externalPartyRole":"Accredited assessor","signerRef":"<role + roster or ticket label>","signatureMethod":"<how the sign-off was produced and where it is kept>","signedAt":"<ISO-8601 UTC timestamp>","signedArtifactDigest":"sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46","scope":"<what you reviewed or exercised, against which scenario list>","unresolvedFindings":"none","evidencePath":"<path to the stored signature or record - the file must EXIST>","evidenceDigest":"<sha256 of that file's bytes>"}
<R5> {"gate_id":"EXT-GATE-05","gate":"production deployment authorization","status":"SIGNED","externalPartyRole":"Authorised operator (manual only)","signerRef":"<operator name and role>","signatureMethod":"<how the authorization was produced and where it is kept>","signedAt":"<ISO-8601 UTC timestamp>","signedArtifactDigest":"sha256:95ea86065b79c8ad06b9f74f80154655cb36c8b797d04ac1f4bcef1e221f0a46","scope":"<the deployed digest, the health-surface readings you took and the environment>","unresolvedFindings":"none","evidencePath":"<path to the stored authorization record - the file must EXIST>","evidenceDigest":"<sha256 of that file's bytes>"}
```

Rules that the machine check actually enforces, so a record is not silently refused — implemented ONCE in
`scripts/external-gates-status.sh` (EP-010 M12; the rules used to be duplicated and both copies were wrong, so no
signature could ever register): `status` must be `SIGNED`; `signedArtifactDigest` must equal the pinned tarball
digest; `externalPartyRole` must be **exactly** the role in the request file; `signerRef`, `signatureMethod`,
`signedAt`, `scope` and `unresolvedFindings` must each be a non-blank string (write `none` for `unresolvedFindings`
when there are none, because an empty value is rejected); `evidencePath` must name a file that EXISTS; and
`evidenceDigest` must be the sha256 of that file's bytes, so a claim resolves to a stored artifact hash
(VG-EVIDENCE-002). A refused record produces a blocker named `EXTERNAL-GATE-SIGNOFF-INVALID-<gate_id>` in
`.agent/verification/state/EXTERNAL_GATES_STATUS.json` and prints both values when they disagree. **No check proves a
signature is authentic** — these rules verify shape, and a fabricated record would have to fabricate a stored
artifact and its hash as well.

**An AI agent can never produce one of these.** `DOD-039` passes only because the five gates exist and none is signed
("an agent may never sign one", `.agent/verification/state/DOD_STATUS.jsonl:39`); each request row carries its own
`canAnAgentSatisfyIt` refusal, e.g. `EXT-GATE-03`: "no: counsel review is a legal judgement and AGENTS.md names it a
stop condition for an agent" (`external-gates.jsonl:3`). The store is likewise authored outside the harness
(`.agent/evidence/EP-010/V-021/SIGNOFF_INSTRUCTIONS.md:3-6`).

**The two records currently in the file are transient mechanism-test fixtures, not sign-offs.** A mechanism test run
for this milestone writes two labelled fixtures, runs the ship gate to prove both the accept path and the
stale-digest refusal path, then deletes them and re-runs; the committed state of
`.agent/evidence/EP-010/V-021/signoffs.jsonl` is an empty file (0 bytes), and the mechanism test's own evidence lives
under `.agent/evidence/EP-010/M12/` (`ship-gate-fixture-run.log`). Do not read the file's present contents as a claim:
`external gates 0/5 signed` is the state that must be assumed until a real record is appended. The fixtures are
labelled as such in their own fields (`"MECHANISM-TEST-FIXTURE - NOT A SIGNATURE …"`,
`.agent/evidence/EP-010/V-021/signoffs.jsonl:1-2`), and the recorded fixture run had reached only `epoch-pin` and
`artifact-identity` (`.agent/evidence/EP-010/M12/ship-gate-fixture-run.log:1-2`).

**The design limitation, stated plainly:** no check in this repository can distinguish a genuine human sign-off from a
fabricated record that happens to carry the right fields. The check verifies shape, not authenticity — `status`,
`signedArtifactDigest`, `externalPartyRole` and five non-blank strings (`scripts/production-readiness-check.sh:190-203`).
The only two safeguards are therefore structural, and both are the owner's to rely on:

1. **Nothing in the harness can write the store.** "no script in this repository writes
   `.agent/evidence/EP-010/V-021/signoffs.jsonl`, so a record can only get here because a human put it here"
   (`.agent/evidence/EP-010/V-021/SIGNOFF_INSTRUCTIONS.md:3-6`).
2. **The record must name its signer, method, date, scope, unresolved findings and the pinned digest**, all of which
   are the evidence `DOD-039` requires ("Named authorized sign-off, scope, date, scenarios/evidence, and unresolved
   findings", `.agent/verification/state/DOD_STATUS.jsonl:39`; field table in
   `.agent/evidence/EP-010/V-021/SIGNOFF_INSTRUCTIONS.md:18-28`).

The owner is strengthening this further by requiring a stored evidence artifact with a matching digest; **that
requirement is not yet enforced by any file cited in this checklist**, so until it is, a sign-off is trustworthy only
because a human put it there and referenced durable evidence in `evidencePath`.

**To register a real sign-off:** store the participant's signature or review record somewhere durable and reference it
in `evidencePath`, append **one line per gate** without rewriting other lines, then re-run
`sh scripts/production-readiness-check.sh`; the verdict's `external_gates[]` then carries `SIGNED` and
"`external gates N/5 signed`" moves (`.agent/evidence/EP-010/V-021/SIGNOFF_INSTRUCTIONS.md:47-56`).

## Part C — Infrastructure and environment targets

**Why this order.** These are the non-credential items, ordered by what must exist before the next one is meaningful:
a target to deploy to (C-1) → a class-validated configuration on it (C-2) → something to upgrade *from* (C-3) → the
key material that signs and encrypts (C-4) → the image format that a deployment would consume (C-5) → the place a
rollback rolls back to (C-6) → the runner and durations that only time can satisfy (C-7) → the authorization that
unblocks one safety-blocked ID (C-8) → the owner decisions that gate public release (C-9). Same bullet structure as
Part A.

### C-1 A staging target (and every environment class that is not `clean-local`)

- **What it is** — a deployed, non-production stack. `.agent/verification/TEST_ENVIRONMENT_MANIFEST.md:8` declares it
  as "managed US cloud, separate account" requiring "Kubernetes, KMS, object store, managed Postgres, browser pool",
  state `NOT_PROVISIONED`. `deploy/staging/README.md:3-7` records `EXTERNAL_REQUIRED` / `BLOCKED_CREDENTIALS` and that
  no staging host, credential or endpoint is reachable from this environment.
- **Where it is declared** — `.agent/verification/TEST_ENVIRONMENT_MANIFEST.md:8`;
  `deploy/staging/README.md:3-7`, `:22-27`, `:35-43`; `scripts/staging-verify.sh:41-55`; `DEPLOYMENT.md:49`.
  The clause it blocks is `DOD-009` (`BLOCKED_ENVIRONMENT`, "Integration tests use production-type databases, queues,
  caches, storage, brokers, and other required dependency classes", `.agent/verification/state/DOD_STATUS.jsonl:9`).
- **How to obtain or create it** —
  1. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: no cloud, region, account, cluster product or
     browser-pool product is named; the manifest states the shape only
     (`.agent/verification/TEST_ENVIRONMENT_MANIFEST.md:8`).
  2. Add the platform credentials for the new environment to `PREFLIGHT.md` **and** `.env.example` first:
     `deploy/staging/README.md:38-41` records that they "are not declared today, because no platform was ever
     provisioned", and that `sh scripts/config-validate.sh` reports such a key as `REQUIRED_KEY_UNDECLARED` "as soon
     as they are read by code, and the operator must add the rows first". This is the one place in this checklist
     where a **contract file must change** — the three files are `PREFLIGHT.md` (table rows), `.env.example`
     (placeholder lines) and `config/environment/schema.json` (key entries), kept in agreement by
     `scripts/config-validate.sh` (`ENVIRONMENT.md:5-8`).
  3. Set `VG_STAGING_ENDPOINT` to the staging ingress: `scripts/staging-verify.sh` requires it and never defaults it
     (`deploy/staging/README.md:42`; `scripts/staging-verify.sh:41-47`). `VG_STAGING_ENDPOINT` is declared in that
     README and read by that script — it is **not** in `PREFLIGHT.md`, so step 2 applies to it too.
  4. Deploy the pinned digest with `sh scripts/staging-deploy.sh`, then verify with `sh scripts/staging-verify.sh`
     (`deploy/staging/README.md:18-19`); tear the stack down afterwards and record the teardown
     (`deploy/staging/README.md:20`).
- **How to verify it is provisioned** — `sh scripts/staging-deploy.sh` prints `staging deploy: ok` only when the
  digest read back from the running system equals the pinned one (`deploy/staging/README.md:18`); the blocked
  alternative is recorded with the pinned digest, the manifest row, the probe command and exit code in
  `.agent/evidence/EP-009/M4-staging-deploy.txt` / `M4-staging-verify.txt` (`deploy/staging/README.md:24-27`).
  **Known blocker, measured:** the running artifact's health surface does not implement SPEC-003 §5.17
  (`deploy/staging/README.md:44-49`; `deploy/production/README.md:42-46`), so a staging deployment today "would verify
  a contract the artifact does not implement". Provisioning the target does not fix that; the contract must be
  implemented first. The `clean-local` fallback is a different, labelled run and may not be called staging
  (`deploy/staging/README.md:29-33`).
- **What it unblocks** — `DOD-009` (`.agent/verification/state/DOD_STATUS.jsonl:9`) and the **4** `BLOCKED_ENVIRONMENT`
  IDs whose `blockingDependency` is `capability:deployed-target`: `HIPAA-030`
  (`.agent/verification/state/TEST_LEDGER.jsonl:6103`, stage `V-013`), `HIPAA-086` (`:5845`, stage `V-005`),
  `HIPAA-078` (`:6215`, stage `V-019`), `HIPAA-089` (`:6217`, stage `V-019`) — their recorded provisioning action is
  exactly this item (`DEPENDENCY_BLOCKER_GRAPH.json`, `capability_edges`; `RELEASE_GATE.json:26`
  `blocked_environment: 4`). It is also the precondition for `DOD-004` ("no stage ran against a DEPLOYED digest,
  because staging is `NOT_PROVISIONED`", `.agent/verification/state/DOD_STATUS.jsonl:4`), for `DOD-020`'s
  production-class configuration resolution (`:20`), and for any SLO verdict at all: "local and CI environments may
  run the evaluation harness but may **NOT** produce an SLO verdict ... every verdict produced here is `INCONCLUSIVE`"
  (`config/slo/objectives.json:68`; `DOD-022`, `.agent/verification/state/DOD_STATUS.jsonl:22`).
- **Where to record it** — the environment file (gitignored, `.gitignore:15-18`) plus the three contract files named
  in step 2; the deploy/verify/teardown evidence under `.agent/evidence/EP-009/` and the staging fingerprint pointer
  in `.agent/verification/state/RUN_MANIFEST.json:116-119`. `artifact-smoke` scratch and `.env` must stay uncommitted
  (`.gitignore:15-20`, `:61-63`).

### C-2 A production-class validated configuration

- **What it is** — the `production` environment class of `config/environment/required.json` resolved and validated in
  the target environment, including the audience/ACR keys of Part A item A-3 and the deployment-class credentials of
  A-4.
- **Where it is declared** — `config/environment/required.json:52-76` (identical credential requirement to staging,
  deployment manual and authorized by a named operator); `config/environment/schema.json:15`; `DOD-020`
  (`.agent/verification/state/DOD_STATUS.jsonl:20`).
- **How to obtain or create it** — 1. Provision C-1 and A-3/A-4 first; this item is the composition, not a purchase.
  2. Write the production env file for the target and validate it with
  `sh scripts/config-validate.sh --environment production --file <env-file>` **before the artifact starts**
  (`DEPLOYMENT.md:18-23`; `deploy/production/README.md:35-39`). 3. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with
  the provider**: the production host and the operator roster are not named — deployment "requires a named authorized
  operator" (`deploy/production/README.md:8-13`) and is a mandatory external gate (`EXT-GATE-05`).
- **How to verify it is provisioned** — `config: ok` from the command in step 2, in the target environment
  (`deploy/production/README.md:35-39`).
- **What it unblocks** — `DOD-020` `BLOCKED_CREDENTIALS` ("no production-class configuration resolves",
  `.agent/verification/state/DOD_STATUS.jsonl:20`), one of the clauses standing between the candidate and `GO`, and the
  production pre-condition "validate the configuration for the production class"
  (`deploy/production/README.md:35-39`).
- **Where to record it** — the production env file and the change record; the guard "prints key names and reason codes
  and never a value, so its output is safe to attach to the change record" (`deploy/production/README.md:38-39`).

### C-3 A prior released artifact (for upgrade, downgrade and rollback paths)

- **What it is** — a previously released artifact whose bytes and digest can be upgraded from and rolled back to.
  Today "only one artifact version exists", so "no old/new state-hash comparison was performed"
  (`.agent/verification/state/DOD_STATUS.jsonl:35`).
- **Where it is declared** — `DOD-035` (`BLOCKED_PREREQUISITE`, `.agent/verification/state/DOD_STATUS.jsonl:35`);
  `docs/release/upgrade.md:3-18` ("Supported upgrade paths: NONE ARE CLAIMED" ... "this repository has never had a
  released prior state"); `db/UPGRADE_MATRIX.md:12-16` ("no customer release exists yet, so 'prior released schema'
  currently means the immediately preceding migration set of this same unreleased line"); `DOD-016`
  (`.agent/verification/state/DOD_STATUS.jsonl:16`); `deploy/production/README.md:56-58` (rollback never demonstrated
  for the same reason).
- **How to obtain or create it** — 1. Release one version and retain its exact bytes and digest. 2. Then execute the
  upgrade and rollback paths against real prior state, with old/new state hashes
  (`DOD-035`'s required evidence, `.agent/verification/state/DOD_STATUS.jsonl:35`). 3. **NOT DOCUMENTED IN THIS
  REPOSITORY - confirm with the provider**: no artifact registry, release host or retention location is named —
  `PREFLIGHT.md` has no registry row and `docs/release/supported-formats.md:29-43` names no publishing target. Note
  also that `docs/release/upgrade.md:5-8` records that `scripts/test-migrations.sh` does not exist, so the matrix's
  producer script is itself owed.
- **How to verify it is provisioned** — `sh scripts/artifact-identity.sh` prints `artifact identity: ok` for each
  digest it resolves (`RELEASE.md:19`), and `sh scripts/rollback-drill.sh` /
  `sh scripts/backup-restore-drill.sh` are the declared drills (`README.md:82-86`;
  `deploy/production/README.md:25-26`).
- **What it unblocks** — `DOD-035` (`BLOCKED_PREREQUISITE`) and the `DOD-016` from-prior migration path
  (`.agent/verification/state/DOD_STATUS.jsonl:16`); the production pre-condition that a rollback has somewhere to roll
  back to (`deploy/production/README.md:25-26`, `:50-58`).
- **Where to record it** — the upgrade matrix rows and their evidence paths (`db/UPGRADE_MATRIX.md:6-16`;
  `docs/release/upgrade.md:10-18`); the retained artifact and its digest in the release record
  (`.agent/verification/state/ARTIFACT_IDENTITY.json`).

### C-4 A signing key or managed KMS — and the HSM assessment

- **What it is** — the key material that would sign the release artifact and encrypt tenant keys. Today the identity
  records `signature.status = EXTERNAL_REQUIRED` with the reason "no signing key or managed KMS exists in this
  environment (ADR-006 open); an unsigned artifact is recorded as unsigned rather than represented as signed"
  (`.agent/verification/state/ARTIFACT_IDENTITY.json:27-30`).
- **Where it is declared** — `.agent/verification/state/ARTIFACT_IDENTITY.json:27-30`; `DECISIONS.md:16` (ADR-006
  "Retained, still `OPEN`") and `:201` ("Cloud/KMS selection (ADR-006) — blocks EP-009, and blocks encryption work in
  EP-003"); `README.md:93`; `RELEASE.md:32-34`, `:61`; `ASSUMPTIONS.md:359-364` (no production recipe signing key;
  `RECIPE_VERIFICATION_KEYS` unset in every deployment, so the recipe route refuses `503 DEPENDENCY_UNAVAILABLE`);
  `ASSUMPTIONS.md:1426-1437` (`ManagedKmsKeyProvider` raises `KeyProviderBlockedError`, and the local provider is
  "tests-and-local-only because ADR-006 is OPEN"); `EXT-GATE-04` (`external-gates.jsonl:4`); `DOD-003`
  (`.agent/verification/state/DOD_STATUS.jsonl:3`).
- **How to obtain or create it** —
  1. Make the ADR-006 decision (which cloud/KMS) and record it — that is the owner's open decision
     (`DECISIONS.md:201`).
  2. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: how to create a key, a key ring, an HSM
     backing or an identity for it. No product is named; `config/environment/schema.json:347-356` declares only the
     `CLOUD_WORKLOAD_IDENTITY` reference shape, and `RECIPE_VERIFICATION_KEYS` is declared as a `FILE_PATH` to "the key
     material used to verify recipe signatures" (`config/environment/schema.json:450-458`).
  3. Engage an accredited assessor for `EXT-GATE-04`, whose third scenario is "whether an HSM is applicable to this
     deployment at all" (`external-gates.jsonl:4`).
- **How to verify it is provisioned** — `sh scripts/artifact-identity.sh` prints `artifact identity: ok` and refuses a
  stale or unresolvable identity (`RELEASE.md:19`); the signature field is a recorded status, so check
  `.agent/verification/state/ARTIFACT_IDENTITY.json:28` after the change. For recipes, the route stops refusing when
  `RECIPE_VERIFICATION_KEYS` is set (`ASSUMPTIONS.md:359-364`).
- **What it unblocks** — the `EXTERNAL_REQUIRED` signature status that `DOD-003` records alongside its four produced
  formats (`.agent/verification/state/DOD_STATUS.jsonl:3`), the recipe-verification route
  (`ASSUMPTIONS.md:359-364`), SPEC-002 §4 crypto-shredding (`db/UPGRADE_MATRIX.md:18-20`) and the evidence
  `EXT-GATE-04` is asked to assess. It is **not** one of the four `RELEASE_GATE.json` release blockers, and buying a
  KMS does not by itself move the verdict.
- **Where to record it** — the ADR row in `DECISIONS.md:16` (status changed from `OPEN`), the key reference in the
  deployment's env file as `RECIPE_VERIFICATION_KEYS` (`config/environment/schema.json:450-458`) — never committed
  (`*.key` and `*.pem` are gitignored, `.gitignore:19-20`) — and the signature status in
  `.agent/verification/state/ARTIFACT_IDENTITY.json`, which is machine-written; do not hand-edit it.

### C-5 An OCI container image build definition

- **What it is** — the fifth declared artifact format, "OCI container image per declared service role". It is recorded
  `BLOCKED_ON_IMPLEMENTATION`: "The repository contains no `Dockerfile` and no container build definition ... Add a
  container build definition (one per declared service role, or one image with a role selector), then produce and
  digest-pin the images. Until then no test, deployment or evidence path may reference an image."
  (`docs/release/supported-formats.md:21-23`; `.agent/verification/state/ARTIFACT_IDENTITY.json:31-34`.)
- **Where it is declared** — `docs/release/supported-formats.md:19-27`; `.agent/verification/state/ARTIFACT_IDENTITY.json:31-34`;
  `README.md:90-92`; `RELEASE.md:26-31`; `.agent/verification/state/RUN_MANIFEST.json:107`, `:134`.
- **How to obtain or create it** — this one is **not** an external purchase and is documented as a repository change:
  1. Add the container build definition (one per declared service role, or one image with a role selector)
     (`docs/release/supported-formats.md:23`).
  2. Produce and digest-pin the images. The environment is not the blocker: "A container runtime IS available
     (`docker 29.7.2`, measured)" (`docs/release/supported-formats.md:17`, `:23`).
  3. No provider step exists here, so nothing needs to be confirmed with a third party.
- **How to verify it is provisioned** — the negative measurement is recorded: `git ls-files | grep -i dockerfile`
  returns nothing today (`docs/release/supported-formats.md:23`); after the change, the format must be produced with a
  digest, because "a format declared here and not produced, or produced but not digest-pinned, is a `FAIL` of DOD-003"
  (`docs/release/supported-formats.md:5-6`).
- **What it unblocks** — the fifth format of `DOD-003` (which passes today with the gap explicitly recorded,
  `.agent/verification/state/DOD_STATUS.jsonl:3`), and the per-service-role image SPEC-008 §7.2 names
  (`RELEASE.md:26-31`). It is a prerequisite for any container-based deployment, and no evidence path may reference an
  image until it exists (`docs/release/supported-formats.md:23`).
- **Where to record it** — the status and next action in `docs/release/supported-formats.md:21-23` and the
  `.agent/verification/state/ARTIFACT_IDENTITY.json` `oci_image` block (machine-written; mirrored in
  `.agent/verification/state/RUN_MANIFEST.json:107`).

### C-6 A point-in-time-recovery / backup target

- **What it is** — the recovery target a deployment can be rolled back to and measured against. Today "RPO/RTO are not
  measured because point-in-time recovery is not provisioned" (`.agent/verification/state/DOD_STATUS.jsonl:36`), and
  the retention-deletion propagation half is `BLOCKED_ENVIRONMENT` (`DEPLOYMENT.md:53`).
- **Where it is declared** — `DOD-036` (`.agent/verification/state/DOD_STATUS.jsonl:36`); `DEPLOYMENT.md:53`
  ("backup and restore | **OWED**"); `deploy/production/README.md:25-26` (pre-condition 5: "A restore point: the
  backup path was exercised by `sh scripts/backup-restore-drill.sh` and its evidence is under
  `.agent/evidence/EP-009/`, so a rollback has somewhere to roll back to"); `docs/release/upgrade.md:22-24` (the
  pre-upgrade backup is "not optional"); `db/UPGRADE_MATRIX.md:18-20` (restore-from-backup explicitly not claimed).
- **How to obtain or create it** —
  1. Provision a backup/PITR capability on the deployed data store of C-1 and a retention that the erasure rules can
     propagate through (`DEPLOYMENT.md:53`).
  2. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: no managed-database backup product, retention
     period, storage location or restore-point objective is named; the repository declares the *measurements* it wants
     (RPO, RTO, MTTR against reconciled state, `.agent/verification/state/DOD_STATUS.jsonl:36`), not how to obtain them.
  3. Retain a restore point before any upgrade: "an upgrade without a restore point is a change nobody can reverse"
     (`docs/release/upgrade.md:22-24`).
- **How to verify it is provisioned** — `sh scripts/backup-restore-drill.sh` is the declared drill
  (`deploy/production/README.md:25-26`; `README.md:84`), with evidence under `.agent/evidence/EP-009/drills/`; the
  clause's required evidence is the pre-disaster hash, the fault injection, the restore logs, the post-state
  reconciliation and the measured objectives (`.agent/verification/state/DOD_STATUS.jsonl:36`).
- **What it unblocks** — `DOD-036` (`PARTIAL`, `.agent/verification/state/DOD_STATUS.jsonl:36`), pre-condition 5 of the
  production procedure (`deploy/production/README.md:25-26`) and the rollback trigger of `deploy/production/README.md:50-58`.
  No registry ID names it, so no ID count moves on this item alone.
- **Where to record it** — the drill evidence and its status under `.agent/evidence/EP-009/drills/`
  (`deploy/production/README.md:25-26`, `:55-58`), and the restored/rolled-back digest in the release record.

### C-7 A long-running runner for the soak-class requirement

- **What it is** — a runner that can hold a duration workload and heartbeat while it runs. `E2E-018` ("Soak, Endurance
  & Resource-Leak Verification") is `DEFERRED_LONG_RUNNING`: "the prompt declares a duration requirement (no explicit
  duration in the prompt text) that cannot complete inside this campaign window", elapsed `PT0S - not started`,
  completion "requires a runner that can hold the workload for its planned duration"
  (`.agent/evidence/EP-010/V-017/E2E-018/status.json:15-25`).
- **Where it is declared** — `.agent/evidence/EP-010/V-017/E2E-018/status.json:15-25`;
  `DEPENDENCY_BLOCKER_GRAPH.json` (`capability:long-running-runner->V-017`);
  `DOD-038` (`.agent/verification/state/DOD_STATUS.jsonl:38`); `DOD-022` (`:22`); `RELEASE_GATE.json:31`
  (`deferred_long_running: 1`); `config/slo/objectives.json:2`, `:21`, `:30`, `:37`, `:47` (30-day windows and the rule
  that an abbreviated trial "is never reported as PASS").
- **How to obtain or create it** —
  1. Provide a runner that can hold the workload for its full planned duration and heartbeat into the stage checkpoint
     the harness already writes (`.agent/evidence/EP-010/V-017/E2E-018/status.json:22`).
  2. Declare the planned duration: it is recorded as "not declared in the prompt text"
     (`.agent/evidence/EP-010/V-017/E2E-018/status.json:19`), so the owner must state it before a run can be judged
     complete (`DOD-038` requires start/end timestamps, continuous heartbeats, telemetry, corpus/workload,
     interruptions and a full-duration report — `.agent/verification/state/DOD_STATUS.jsonl:38`).
  3. **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider**: no runner product, host or CI service is named.
     The three `*_RUNNER_HANDLE` keys are `HUMAN_EXTERNAL`, but the schema states that no stage in EP-000 through
     EP-009 delegates to an external runner (`config/environment/schema.json:325`), so a handle alone is not a runner.
  4. Budget for duration, not just capacity: the declared SLO windows are 30 days
     (`config/slo/objectives.json:21`, `:30`, `:37`, `:47`) and the SLO verdict may not be produced by a local or CI
     environment (`config/slo/objectives.json:68`).
- **How to verify it is provisioned** — re-run `sh scripts/harness-run-stage.sh V-017`
  (`.agent/execplans/EP-010-node.md:766`) and require that the row stops being `DEFERRED_LONG_RUNNING` only when a
  full-duration workload with continuous heartbeats exists; the taxonomy forbids `PASS` for a shortened trial
  (`.agent/verification/state/DOD_STATUS.jsonl:38`; `config/slo/objectives.json:2`).
- **What it unblocks** — `E2E-018` (the single `deferred_long_running` ID, `.agent/verification/state/RELEASE_GATE.json:31`),
  `DOD-038` and `DOD-022` (`.agent/verification/state/DOD_STATUS.jsonl:38`, `:22`), and every SLO verdict, which is
  `INCONCLUSIVE` until an environment may produce one (`config/slo/objectives.json:68`).
- **Where to record it** — the duration provenance and heartbeat reference on the row
  (`.agent/evidence/EP-010/V-017/E2E-018/status.json:17-25`), the stage checkpoint
  (`.agent/verification/state/stage-checkpoint.json`), and the clause evidence
  `.agent/evidence/EP-010/DOD/DOD-038.json`.

### C-8 Written authorization for active testing — `BC-056`

- **What it is** — an authorization, not a credential: `BC-056` is `BLOCKED_SAFETY` because "the prompt's own
  authorization boundary requires explicit authorization for active testing, which this harness does not have", and
  its next action is "obtain written authorization naming the target and the test types, then execute the prompt under
  that authorization" (`.agent/verification/state/TEST_LEDGER.jsonl:6180`).
- **Where it is declared** — `.agent/verification/state/TEST_LEDGER.jsonl:6180`;
  `DEPENDENCY_BLOCKER_GRAPH.json` (`capability:authorized-active-testing->V-016`); `RELEASE_GATE.json:29`
  (`blocked_safety: 1`).
- **How to obtain or create it** — 1. Obtain written authorization from the owner of the target system, naming the
  target and the test types (`TEST_LEDGER.jsonl:6180`, `nextAction`). 2. **NOT DOCUMENTED IN THIS REPOSITORY - confirm
  with the provider**: no authorization template, issuer or jurisdiction is declared. 3. Execute the prompt only under
  that authorization — the repository's rule is that the boundary is the prompt's own, and it is not to be relaxed.
- **How to verify it is provisioned** — there is no command; the status row's own `nextAction` is the acceptance test,
  and stage `V-016` must stop reporting `BLOCKED_SAFETY=1` (`DEPENDENCY_BLOCKER_GRAPH.json`, `stage_runs`, epoch
  `FORGE-SPEC-9`).
- **What it unblocks** — **1** ID (`BC-056`) and one of stage `V-016`'s 16 owned IDs; it is the only `BLOCKED_SAFETY`
  row in the registry (`.agent/verification/state/RELEASE_GATE.json:29`).
- **Where to record it** — the authorization document as the row's evidence, then re-run
  `sh scripts/harness-run-stage.sh V-016` (`.agent/execplans/EP-010-node.md:762-768` pattern) so the transition is
  recorded rather than claimed.

### C-9 Two owner decisions that are not credentials (and not infrastructure)

- **What they are** — (a) the copyright holder name for `LICENSE`/`NOTICE`; (b) trademark clearance for the
  "VanishGraph" name.
- **Where they are declared** — `LICENSE_POLICY.md:14-15`: "The copyright holder name in `NOTICE` is **not yet
  recorded**; it requires the owner's decision and must be set before any public release (`DECISIONS.md` §5)";
  `DECISIONS.md:199` ("Required before public release") and `:200` (trademark clearance, "still open");
  `ASSUMPTIONS.md:12` (working codename, trademark risk, "clearance before public launch", `**OPEN**` — no clearance
  performed); `LICENSE_POLICY.md:12-13` (a distributed `NOTICE` must be preserved and reproduced, Apache-2.0 §4d).
- **How to obtain or create them** — 1. Decide the legal entity name that must appear as copyright holder
  (`LICENSE_POLICY.md:14-15`). **NOT DOCUMENTED IN THIS REPOSITORY**: how the name must be rendered in `LICENSE` and
  `NOTICE`. 2. For the trademark: **NOT DOCUMENTED IN THIS REPOSITORY - confirm with the provider** — no jurisdiction,
  class or search service is named (`ASSUMPTIONS.md:12`); a clearance search and its jurisdiction are outside this
  repository.
- **How to verify they are provisioned** — no machine check exists; the `LICENSE`/`NOTICE` files and the open-decision
  list in `DECISIONS.md:197-205` are the record.
- **What they unblocks** — nothing in `.agent/verification/state/RELEASE_GATE.json:81-105`: these are preconditions of
  a *public release* (`LICENSE_POLICY.md:14-15`), not of the machine verdict. They are listed so that "release" is not
  read as "verdict token" and the obligation is not discovered late.
- **Where to record them** — `NOTICE` (distributed and reproduced, `LICENSE_POLICY.md:12-13`) and the copyright line in
  `LICENSE`; the decision's closure in `DECISIONS.md:197-205`.

## What this list does NOT fix

`RELEASE_GATE.json` carries exactly four release blockers (`.agent/verification/state/RELEASE_GATE.json:81-105`).
Provisioning changes the picture for none of them by itself:

| blocker id | what it says (`.agent/verification/state/RELEASE_GATE.json`) | fixed by this checklist? |
|---|---|---|
| `VERIFY-NOT-OK` | "`sh scripts/verify.sh` did not print `verify: ok`; the stage it reached last was `smoke`, and its failure is a release blocker rather than a note" (`.agent/verification/state/RELEASE_GATE.json:93`) | **No — and it is now the single most valuable thing to fix.** After EP-010 M12 the ladder reaches **13 of 15** stages and stops at `smoke` on a REAL product divergence: SPEC-003 §5.17.2 declares `/v1/ready` as `{"dependencyState":"READY\|NOT_READY","checkedAt":"…","failedChecks":[…]}` with per-dependency names, while `src/http/routes/health.ts` implements `{status, checks}` — and specs outrank code, so the implementation is wrong. Beyond it, `test-e2e` needs a browser runtime (`BLOCKED_ENVIRONMENT` when absent) and `live-fire` will not print its sentinel while 2 of its 12 outcomes need named external participants, so `verify: ok` is **not reachable by code alone**. No credential in Part A or target in Part C makes a failing gate pass; `DOD-021` remains `PARTIAL` (`.agent/verification/state/DOD_STATUS.jsonl:21`) |
| `DOD-DOD-019` | "clause `DOD-019` does not pass: reality gate: `reality-gate.sh` exited 1 WITHOUT its sentinel; the three prose hits recorded in EP-009 remain the gate's only findings" (`:89-93`) | **No.** `DOD-019` is `FAIL` (`.agent/verification/state/DOD_STATUS.jsonl:19`); the placeholder/stub/fake scan is a code-and-prose finding |
| `EXTERNAL-GATES-UNSIGNED` | "5 of 5 mandatory external gate(s) are unsigned; while any is open the verdict cannot exceed `CONDITIONAL_EXTERNAL_GATES` (VG-SHIP-030)" (`:95-99`) | **Only by Part B, and only a human can do it.** Provisioning produces the conditions a participant needs; it never produces the sign-off (`DOD-039`, `.agent/verification/state/DOD_STATUS.jsonl:39`) |
| `NO-PASSING-ID` | "not one of the 484 ids carries PASS, so no behaviour was verified end to end through its real entry point" (`:101-105`) | **No.** Provisioning flips 7 of 484 `BLOCKED_CREDENTIALS` rows at most; the remaining 205 `BLOCKED_PREREQUISITE` rows are `capability:execution-mapping` (190) and `capability:per-id-definition` (15) — missing per-ID execution mappings and definitions, not missing credentials — and 266 rows are `PARTIAL`. Reaching `PASS` requires executing the IDs in an authorised agentic runner and recording a PASS only where the oracle and a negative case ran (`RELEASE_GATE.json:104`) |

Clauses that provisioning does reach, and clauses it does not, in the same taxonomy
(`.agent/verification/state/DOD_STATUS.jsonl`; the verdict records 17 of 42 `PASS`, 0 `FAIL`, 25 other,
`.agent/verification/state/RELEASE_GATE.json:7-13`):

| clause | status | what provisioning does |
|---|---|---|
| `DOD-020` | `BLOCKED_CREDENTIALS` (`:20`) | **Partially.** A-3 + A-4 + C-1/C-2 let a production-class configuration resolve; the clause then still needs the boundary wired and exercised |
| `DOD-009` | `BLOCKED_ENVIRONMENT` (`:9`) | **Partially.** C-1 supplies a production-type environment; the clause also needs the integration runs executed against it |
| `DOD-004` | `PARTIAL` (`:4`) | **Partially.** C-1 gives a deployed digest to test against; the artifact-bound stages then have to run and pass |
| `DOD-035` | `BLOCKED_PREREQUISITE` (`:35`) | **Partially.** C-3 supplies a prior artifact; the paths then have to be executed with old/new state hashes |
| `DOD-036` | `PARTIAL` (`:36`) | **Partially.** C-1 + C-6 provide a backup/PITR target, which lets RPO/RTO be measured; the drill then has to run |
| `DOD-022` | `DEFERRED_LONG_RUNNING` (`:22`), `DOD-038` | **Partially.** C-1 + C-7 supply the environment and the runner; the durations themselves cannot be provisioned |
| `DOD-039` | `EXTERNAL_REQUIRED` (`:39`) | **No.** Only the five named humans can close it (Part B) |
| `DOD-003`, `DOD-005`, `DOD-016` | `PASS` / `PARTIAL` / `PARTIAL` (`:3`, `:5`, `:16`) | **No or partially.** C-4 and C-5 change recorded format/signature facts; `DOD-016`'s from-prior path needs C-3 |
| `DOD-019` | `PASS` (`:19`) | **No, and it no longer needs to be.** This clause was `FAIL` when this list was written; the three prose hits were reworded at their source in EP-010 M12 (no allow-list entry was added), and `reality gate: ok` now prints |
| `DOD-001`, `-008`, `-010`…`-015`, `-017`, `-021`, `-027`, `-028`, `-033`, `-037` | `PARTIAL` | **No.** These are test-execution, coverage, mutation, observability and reporting gaps in the candidate, not provisioning gaps |

**The two largest blocked groups are not credential items at all.** Of the 484 accounted IDs in `FORGE-SPEC-9`, 190 are
`BLOCKED_PREREQUISITE` on `capability:execution-mapping` (no repository gate covers the prompt's subject and no
environment path exists to execute it — e.g. `BC-002`, `.agent/verification/state/TEST_LEDGER.jsonl:5754`) and 15 are
`BLOCKED_PREREQUISITE` on `capability:per-id-definition` (the declared source is a summary with "no method, command or
completion gate; there is nothing to execute for this ID" — e.g. `SUP-001`, `.agent/verification/state/TEST_LEDGER.jsonl:5751`;
`SUP-015`, `:6234`). No credential, environment target or signature in Part A, Part B or Part C touches either group:
they are work-mapping and definition gaps in the harness, and they are 205 of the 484 IDs.

**And the ceiling for the 266 `PARTIAL` IDs is an authorised agentic runner, which no credential purchase supplies.**
Every one of those 266 rows carries `blockingDependency: capability:agentic-runner` (grouped from
`.agent/verification/state/TEST_LEDGER.jsonl`; representative row `GEN-001`, stage `V-004`, at
`.agent/verification/state/TEST_LEDGER.jsonl:5773`), and the dependency graph declares that edge against stages
`V-004`…`V-021` (`DEPENDENCY_BLOCKER_GRAPH.json`, `capability_edges`). SPEC-006 section 4.1 is what makes that a
ceiling rather than a formality: it "requires an executed oracle AND an executed negative case for a PASS"
(`scripts/harness-run-stage.sh:23`, `:368`, `:394`), and the verdict's own next action is to "execute the ids in an
authorised agentic runner and record PASS only where the oracle and a negative case ran"
(`.agent/verification/state/RELEASE_GATE.json:104`). A key, a cluster or a signature cannot produce a PASS.

Two ordering facts that survive everything above:

1. **Provisioning alone cannot lift the verdict.** With `DOD-019` `FAIL` and zero passing IDs, the ship gate's own
   rules keep it below `GO` regardless of how many credentials arrive — an unsigned mandatory gate caps the verdict at
   `CONDITIONAL_EXTERNAL_GATES` (`RELEASE_GATE.json:96`) and a failing clause is a `NO_GO` (`RELEASE_GATE.json:3`).
2. **Sign last.** Any change that changes the artifact revokes the affected downstream results
   (`DOD-040`, `.agent/verification/state/DOD_STATUS.jsonl:40`), and a sign-off over a superseded digest "attests
   nothing" and is refused by name with both digests printed
   (`.agent/evidence/EP-010/V-021/SIGNOFF_INSTRUCTIONS.md:30-31`; `.agent/evidence/EP-010/V-021/external-gates.jsonl:1`).
   Provision, re-pin, then ask the five participants to sign the digest that exists at that moment.
