# SPEC-001 Core Domain

## Canonical entities
Tenant, ProtectedSubject, AuthorityGrant, Alias, Identifier, Source, SourceRecord, Exposure, EvidenceArtifact, RemovalRecipe, RequestCase, ExternalAction, VerificationObservation, Reappearance, PolicyDecision, AuditEvent.

## State invariants
1. Every effect belongs to exactly one tenant, subject, and authority scope.
2. SEARCH_HIT never implies SUBJECT_MATCH.
3. REQUEST_SUBMITTED never implies VERIFIED_REMOVED.
4. Every external write has one idempotency key and a reconciliation path.
5. A stale or legally unclear recipe cannot write.
6. Ambiguous identity matches route to HUMAN_REQUIRED.

## Acceptance
State transitions are deterministic, persisted, independently read back, and tested for duplicate, reordered, delayed, unauthorized, and restart scenarios.
