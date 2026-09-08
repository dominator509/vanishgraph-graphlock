# SPEC-003 API Contracts

Public boundaries are versioned HTTP/control-plane APIs and bounded MCP tools. Every request carries authenticated tenant context, authority scope, correlation ID, and idempotency where state-changing.

Core operations: protected-subject enrollment, discovery scan, exposure review, removal-case creation, case status, evidence retrieval, recheck scheduling, report export, consent revocation, and account deletion. Responses expose truthful state and never collapse source removal with search delisting.

Acceptance uses public entrypoints, schema validation, authorization negatives, real persistence, async worker completion, independent readback, and artifact-bound E2E evidence.
