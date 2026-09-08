# Data egress matrix

Default deny for CUSTOMER_PII, HIGH_RISK_PII, IDENTITY_DOCUMENT and AUTH_SECRET. Use opaque IDs, local models and redaction first. External model access requires tenant policy, DPA, retention and field allowlist; secrets and raw identity documents never enter models. DLP gates telemetry, repair, issues and PRs.
