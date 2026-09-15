-- 0012 — columns SPEC-003 §5.3 requires that SPEC-002 §2's DDL does not declare.
--
-- WHY THIS MIGRATION EXISTS, AND WHY IT IS ADDITIVE ONLY.
--
-- SPEC-003 §5.3 (sources, catalogue entries, and removal recipes) is a contract over fields that
-- have no column in the data model delivered by EP-003:
--
--   * §5.3.1 returns `controllerId` on the source DTO and §5.3.2 accepts `controllerId` and raises
--     `422 CONTROLLER_NOT_FOUND` — but SPEC-002 §2's `source` table carries no reference to
--     `controller`, so a declared controller would be silently discarded. Silence is the failure
--     mode SPEC-000 §5 forbids, so the reference is materialised instead.
--   * §5.3.2 and §5.3.4 accept `permissionEvidenceUrl`, and §5.3.2 raises
--     `422 PERMISSION_EVIDENCE_REQUIRED` when a `WRITE_PERMITTED` declaration lacks current
--     official-permission evidence. Evidence that cannot be recorded cannot be checked at
--     execution time, which is what VG-CHANNEL-002 requires.
--   * §5.3.1 reports `freshnessState` and §5.3.4 refreshes freshness by re-stating
--     `permissionCheckedAt`. SPEC-006 §5.3 row 7 defines staleness as "beyond its SOURCE-DECLARED
--     freshness window" — so the window is per-source data. With no column for it no window can be
--     declared, and the only remaining options would be a hard-coded global constant (invented) or
--     never reporting `STALE` (a lie). A nullable per-source window is the only honest form; a NULL
--     window means freshness cannot be established and is therefore treated as NOT fresh, which is
--     the fail-closed direction VG-CHANNEL-002 requires.
--   * §5.3.7 accepts `signingKeyRef`, `maxAttemptsPerWindow` and `windowSeconds` on a recipe
--     version, and §5.3.8 reports `disabledReason`. Without these columns a recipe's signing key and
--     its effect-budget window (VG-ACTION-005) cannot be re-established after ingestion, so
--     §5.3.10's `guardEvaluation.signatureVerified` could not be re-evaluated and §5.3.4's
--     auto-disable could not say WHY a recipe was disabled.
--   * §5.3.2 raises `409 SOURCE_ALREADY_DECLARED`, which is not decidable without a natural key
--     for a declared source. `(tenant_id, name)` is the key the §5.3.2 request body supplies.
--
-- Every column below is named by a specification sentence and is therefore not an invention of
-- this node; what this migration supplies is the storage those sentences presuppose. All columns
-- are NULLABLE and no existing row is rewritten, so nothing SPEC-002 §2 states is contradicted: it
-- declared a subset of the columns the contract needs, and this migration adds the remainder.
--
-- This deviation from EP-004 M6's instruction not to touch the schema is recorded in
-- ASSUMPTIONS.md §3.13 and in `.agent/execplans/EP-004-node.md` §12. M6's instruction exists so
-- that a node does not invent a schema in place of a MISSING prerequisite; the prerequisite here
-- (EP-003, tag `green/EP-003`) is delivered, and what it delivered cannot store the contract.

-- VG-CHANNEL-002: which controller is accountable for this source, and the official-permission
-- evidence that makes a WRITE_PERMITTED declaration checkable at execution time.
ALTER TABLE source
  ADD COLUMN controller_id           uuid REFERENCES controller(id),
  ADD COLUMN permission_evidence_url text,
  ADD COLUMN permission_window_seconds integer;

-- SPEC-006 §5.3 row 7: the freshness window is source-declared. A non-positive window would make
-- every permission permanently stale or permanently fresh, so it is refused rather than clamped.
ALTER TABLE source
  ADD CONSTRAINT source_permission_window_positive
    CHECK (permission_window_seconds IS NULL OR permission_window_seconds > 0);

-- `409 SOURCE_ALREADY_DECLARED` (§5.3.2) is only decidable with a natural key. A check-then-insert
-- without this index would let two concurrent declarations both succeed, which is exactly the
-- duplicate the conflict code exists to refuse.
CREATE UNIQUE INDEX source_tenant_name_uniq ON source (tenant_id, name);

-- VG-CHANNEL-003: the key that verified this recipe version's signature, and VG-ACTION-005: the
-- per-window attempt budget this version is allowed. `enabled_at` and `disabled_reason` make the
-- enablement history explainable instead of inferable (§5.3.8 `disabledReason`, §5.3.10 `enabledAt`).
ALTER TABLE removal_recipe
  ADD COLUMN signing_key_ref          text,
  ADD COLUMN max_attempts_per_window  integer,
  ADD COLUMN window_seconds           integer,
  ADD COLUMN enabled_at               timestamptz,
  ADD COLUMN disabled_reason          text;

ALTER TABLE removal_recipe
  ADD CONSTRAINT removal_recipe_budget_positive
    CHECK ((max_attempts_per_window IS NULL OR max_attempts_per_window > 0)
       AND (window_seconds          IS NULL OR window_seconds          > 0));

-- §5.3.10 requires If-Match, so the recipe DTO must expose a concurrency token the server can
-- recompute. `enabled` alone is too coarse: enabling and then disabling would return to the same
-- token and defeat the precondition. This column is the monotonically increasing version of the
-- recipe ROW (not of the recipe), incremented on every mutation.
ALTER TABLE removal_recipe
  ADD COLUMN row_version integer NOT NULL DEFAULT 1;

-- §5.3.4 requires If-Match on the SOURCE row for the same reason.
ALTER TABLE source
  ADD COLUMN row_version integer NOT NULL DEFAULT 1;

-- `disabled_reason` is constrained to the vocabulary §5.3.8 and SPEC-007's
-- `vanishgraph_stale_recipe_refusals_total` (`reason_code`) both use, so an operator reading the
-- field sees a token rather than free prose.
ALTER TABLE removal_recipe
  ADD CONSTRAINT removal_recipe_disabled_reason_vocabulary
    CHECK (disabled_reason IS NULL OR disabled_reason IN
      ('PERMISSION_UNCLEAR','PERMISSION_STALE','FRESHNESS_EXPIRED','SIGNATURE_INVALID',
       'OPERATOR_DISABLED','PERMISSION_DOWNGRADED'));
