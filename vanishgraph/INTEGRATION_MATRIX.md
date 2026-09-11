# Integration Matrix

| Integration | Type | Required | Notes |
|-------------|------|----------|-------|
| Database | PostgreSQL | Yes | Tested via scripts/probes/database_url.sh |
| Temporal | Temporal | Yes | Tested via scripts/probes/temporal_address.sh |
| Cache/KV | Valkey | Yes | Tested via scripts/probes/valkey_url.sh |
| Object Storage | S3 | Yes | Tested via scripts/probes/object_store.sh |
| Auth | Keycloak | Yes | Tested via scripts/probes/keycloak.sh |
| AI | Local Model | Yes | Tested via scripts/probes/local_model.sh |
| Search | Any | Optional | Tested via scripts/probes/search_api_key.sh |
| Postal/LOB | LOB/Click2Mail | Optional | Tested via scripts/probes/postal_api.sh |
| Billing | Stripe | Optional | Tested via scripts/probes/stripe.sh |
| VCS | GitHub App | Yes | Tested via scripts/probes/github_app.sh |
| Workload ID | Cloud Identity | Optional | Tested via scripts/probes/cloud_identity.sh |
