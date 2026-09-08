# SPEC-006 Error Handling

Errors are typed as validation, authorization, policy-denied, human-required, dependency-unavailable, ambiguous-effect, retryable, terminal, or internal. External effects fail closed and never return success after an ignored exception.

Temporal activities record attempts, receipts, correlation IDs, and reconciliation state. Ambiguous writes pause or reconcile before retry. Webhook and email events are authenticated, replay-protected, deduplicated, and treated as untrusted content.

Acceptance requires real dependency failures, cancellation, restart, duplicate delivery, stale recipe, prompt injection, and no-side-effect proof.
