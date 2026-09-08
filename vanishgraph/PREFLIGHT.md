# PREFLIGHT

Run this once after provisioning. Every external need is declared here. Missing values block only their dependent lane.

| Service | Purpose | Variable | Lane | Scope | Probe | Fallback |
|---|---|---|---|---|---|---|
| PostgreSQL | canonical state | DATABASE_URL | REQUIRED_NOW | local or managed database | scripts/probes/database_url.sh | none |
| Temporal | durable workflows | TEMPORAL_ADDRESS | REQUIRED_BEFORE_INTEGRATION | namespace access | scripts/probes/temporal_address.sh | none |
| Session signing | auth session integrity | SESSION_SECRET | REQUIRED_NOW | generated secret | - | none |
| Object storage | encrypted evidence | OBJECT_STORAGE_URL | REQUIRED_BEFORE_INTEGRATION | bucket access | scripts/probes/object_storage_url.sh | local S3-compatible service |
| Key management | envelope encryption | KMS_KEY_ID | REQUIRED_BEFORE_DEPLOY | tenant data key use | scripts/probes/kms_key_id.sh | isolated local key only for development |
| Search provider | discovery lane | SEARCH_API_KEY | REQUIRED_BEFORE_E2E | licensed search scope | scripts/probes/search_api_key.sh | user-supplied URLs and public permitted lanes |
| GitHub App | repair loop | GITHUB_APP_ID | OPTIONAL | minimum repository permissions | scripts/probes/github_app_id.sh | manual issue and draft PR workflow |
| Mail provider | certified mail | MAIL_PROVIDER_KEY | REQUIRED_BEFORE_E2E | sandbox and allowlisted targets | scripts/probes/mail_provider_key.sh | manual PDF/print/export |
| Identity verifier | authority enrollment | IDENTITY_VERIFIER_KEY | HUMAN_EXTERNAL | purpose-limited verification | - | counsel-approved manual attestation |
| Billing provider | subscriptions | BILLING_PROVIDER_KEY | REQUIRED_BEFORE_DEPLOY | test mode first | scripts/probes/billing_provider_key.sh | manual entitlement for pre-billing staging |
| Provider transport | coding/model lane | PROVIDER_RUNNER_HANDLE | OPTIONAL | official authorized runner only | scripts/probes/provider_runner_handle.sh | self-hosted model |
| Production staging | artifact proof | STAGING_KUBECONFIG | REQUIRED_BEFORE_DEPLOY | separate staging account | scripts/probes/staging_kubeconfig.sh | none |

PREFLIGHT-TABLE-BEGIN
DATABASE_URL|REQUIRED|scripts/probes/database_url.sh
TEMPORAL_ADDRESS|REQUIRED|scripts/probes/temporal_address.sh
SESSION_SECRET|REQUIRED|-
OBJECT_STORAGE_URL|REQUIRED|scripts/probes/object_storage_url.sh
KMS_KEY_ID|REQUIRED|scripts/probes/kms_key_id.sh
SEARCH_API_KEY|OPTIONAL|scripts/probes/search_api_key.sh
MAIL_PROVIDER_KEY|OPTIONAL|scripts/probes/mail_provider_key.sh
BILLING_PROVIDER_KEY|OPTIONAL|scripts/probes/billing_provider_key.sh
PROVIDER_RUNNER_HANDLE|OPTIONAL|scripts/probes/provider_runner_handle.sh
STAGING_KUBECONFIG|OPTIONAL|scripts/probes/staging_kubeconfig.sh
PREFLIGHT-TABLE-END

Production launch remains blocked until legal, provider, accessibility, UAT, security, and deployment gates have real evidence.
