# The ten declared readiness probes, implemented and measured with a negative control each (EP-010 M31)

Contract: `scripts/lib/loud-fail.sh` (exit 0 REACHABLE / 1 UNPROVISIONED / 2 CANNOT PROBE, never print a value,
discriminating). Seven probes were placeholders before this milestone; three were implemented earlier (stripe, postal_api,
valkey_url).

## Measured in this environment

    database_url (app DSN)   exit=0  DATABASE_URL: ok - a pooled connection opened, BEGIN/SELECT 1/ROLLBACK answered, and the session role is not a superuser
    valkey_url               exit=0  VALKEY_URL: ok - PING answered and a namespaced write/read/delete round trip returned the written value
    object_store             exit=0  S3_ENDPOINT: ok - HeadBucket answered and a signed GetObject of vanishgraph-probe/readiness/probe-object returned content matching the written payload's digest
    keycloak                 exit=0  KEYCLOAK_ISSUER: ok - OIDC discovery answered over TLS and the advertised JWKS carried 2 signing key(s); no token was minted
    stripe                   exit=1  STRIPE_SECRET_KEY is unset (PREFLIGHT.md; unblocked by EP-013)
    postal_api               exit=1  LOB_API_KEY is unset
    github_app               exit=1  GITHUB_APP_ID is unset
    local_model              exit=1  LOCAL_MODEL_ENDPOINT is unset
    search_api_key           exit=1  SEARCH_API_KEY is unset
    cloud_identity           exit=1  CLOUD_WORKLOAD_IDENTITY is unset

Four credentials are provisioned and their probes now PROVE reachability rather than reporting a placeholder. Six are
not provisioned in this environment, and outcome 1 is the honest answer for them: the variable is declared in
PREFLIGHT.md and provisioning it is a known action.

## The controls, because a probe that cannot fail is a defect

    CONTROL db owner DSN      exit=1  connected as the OWNER of this database; the owner bypasses row-level security (VG-DATA-001)
    CONTROL db dead port      exit=2  ECONNREFUSED: an unreachable service is not a refused credential
    CONTROL keycloak no CA    exit=1  DEPTH_ZERO_SELF_SIGNED_CERT; TLS verification is NOT disabled
    CONTROL keycloak bad host exit=2  ECONNREFUSED
    CONTROL s3 wrong secret   exit=1  HEAD_REFUSED_403: reachable and the credential is not accepted
    CONTROL s3 dead port      exit=2  UNREACHABLE
    CONTROL search_key set    exit=2  no search-provider endpoint is declared anywhere in this repository
    CONTROL cloud_id set      exit=2  a workload identity is resolved by the cloud runtime and this host has no metadata service
    CONTROL github bad appid  exit=1  GITHUB_APP_ID is not numeric (schema.json declares NUMERIC_ID)
    CONTROL local_model plain exit=1  plaintext and NOT loopback

## Two defects of my own, both found by a control rather than by reading

1. **The SigV4 signing key was one derivation short.** `signingKey` stopped at the service key instead of performing the
   fourth derivation (`... then HMAC(kService, "aws4_request")`), and MinIO refused EVERY request with HTTP 403 while the
   credential was CORRECT - which reads exactly like a refused credential and was not one. It now matches
   `src/adapters/observability/dependency-probes.ts` step for step: the correct credential passes and a wrong secret
   still fails with 403, which is what makes the probe discriminating rather than merely unhappy.
2. **The owner DSN passed.** The first version refused a superuser and accepted the provisioned OWNER DSN, whose role owns
   the database without being a superuser - so it would have reported a tenancy boundary that does not exist. The probe
   now also reads `current_user = pg_get_userbyid(datdba)` from the catalogue and refuses the owner.

A third defect was mine and is recorded elsewhere: the apostrophe in a comment inside a single-quoted `node -e` program
closed the string and made the script unparseable. `sh -n` is now run over every probe script.

## What the gates did with it

`scripts/gate-api.sh` and `scripts/gate-security.sh` run these probes and record `probe ok` or `BLOCKED_CREDENTIALS` per
variable; neither gate fails on a probe outcome. Both were re-run in a clean environment (no state file sourced) and both
printed their sentinels: `gate-api: ok`, `gate-security: ok`, with DATABASE_URL, VALKEY_URL and KEYCLOAK_ISSUER recorded
as BLOCKED_CREDENTIALS - the honest state of an environment that does not export them. Run with the state files
sourced, the same three probes report `probe ok`.

One measured trap for anyone re-running them: `tests/contract/scope-catalogue.test.ts` asserts that this environment has
KEYCLOAK_ISSUER unset, so running a gate in a shell where the state files were exported fails that assertion. The failure
is in the harness's environment, not in the gate.

## Effect on the artifact and the epoch

None, and that is measured rather than assumed: `scripts/**` is not in the package's `files` allowlist, so
`sh scripts/artifact-identity.sh` still reports `artifact identity: ok` with the source surface identical to the recorded
commit and the digest unchanged at `sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57`. The epoch
stays FORGE-SPEC-12.
