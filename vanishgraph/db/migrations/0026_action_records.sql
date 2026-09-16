-- 0026 — the fields and records SPEC-003 §5.8 requires that the delivered schema does not carry.
--
-- FOUR THINGS, each named by the contract's own bodies:
--
-- 1. `external_action.recipe_id`, `.recipe_version`, `.template_version`, `.template_hash`. §5.8.1's row carries
--    `recipeId`/`recipeVersion`, §5.8.2's request supplies `recipeId`/`recipeVersion`/`templateRef`, and §5.8.5
--    reports `recipeSnapshot` and `templateSnapshot`. The action is the record that says WHICH signed recipe and
--    WHICH template produced it, so the columns are what make that provable rather than remembered.
--    `idempotencyKeyFingerprint` needs NO column: §5.8.1 requires a ONE-WAY digest of the key, the key itself is
--    already stored (§4 needs it for replay detection), and a stored digest could drift from the value it
--    digests — so it is computed on read.
--
-- 2. The `reconciliation` record (§5.8.3). VG-ACTION-002: an ambiguous action must be reconcilable, and "the
--    divergence is recorded as an audit row and surfaced for review" — the audit row is the spine, but the
--    reconciliation's own FACTS (method, instant, finding, evidence, note) are what §5.8.3's response reports and
--    what a reconciler later needs. `finding` is CHECKed to the three tokens §5.8.3 declares.
--
-- 3. The `readback` record (§5.8.4). §5.8.4's response carries `readbackState: "PENDING"` and a
--    `readbackRequestId`, and §5.8.5 reports `readbackState` with `readbackAt` and
--    `readbackEvidenceArtifactId`. A readback is a REQUEST for evidence, never evidence itself, so its state
--    starts PENDING and only evidence can move it — which is why the evidence column is what CONFIRMED means.
--
-- 4. `mail_piece.delivery_evidence_artifact_id`, `.sent_at`, and a WIDENED `delivery_status`. §5.8.6 renders
--    `ACCEPTED | IN_TRANSIT | DELIVERED | RETURNED | UNKNOWN` while the delivered CHECK admits
--    `NOT_SENT | SENT | DELIVERED | RETURNED | UNKNOWN` — the two vocabularies share three tokens and differ on
--    the other two, so a piece in transit cannot be stored with the token the contract reads. The CHECK is
--    widened to admit the contract's tokens ALONGSIDE the delivered ones, because rows written under the old
--    vocabulary may exist and narrowing would make them unwritable-by-repair; the READ maps both onto the
--    contract's set with a declared table (`MAIL_DELIVERY_STATUS` in the port).
--
-- `sent_at` is separate from `created_at` for the reason §5.8.6 lists both: a piece is created when it is
-- prepared and sent when the transport accepts it, and a report that conflated them would say a prepared piece
-- had been dispatched.

ALTER TABLE external_action
  ADD COLUMN recipe_id         uuid REFERENCES removal_recipe(id),
  ADD COLUMN recipe_version    integer,
  ADD COLUMN template_version  integer,
  ADD COLUMN template_hash     char(64);

ALTER TABLE external_action
  ADD CONSTRAINT external_action_template_hash_shape
    CHECK (template_hash IS NULL OR template_hash ~ '^[0-9a-f]{64}$');

CREATE TABLE reconciliation (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  case_id              uuid NOT NULL REFERENCES request_case(id),
  external_action_id   uuid NOT NULL REFERENCES external_action(id),
  method               text NOT NULL,
  observed_at          timestamptz NOT NULL,
  finding              text NOT NULL CHECK (finding IN ('EFFECT_CONFIRMED','EFFECT_ABSENT','INDETERMINATE')),
  evidence_artifact_id uuid REFERENCES evidence_artifact(id),
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE readback (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  case_id              uuid NOT NULL REFERENCES request_case(id),
  external_action_id   uuid NOT NULL REFERENCES external_action(id),
  observation_method   text NOT NULL,
  state                text NOT NULL CHECK (state IN ('PENDING','CONFIRMED','CONTRADICTED')),
  requested_at         timestamptz NOT NULL,
  readback_at          timestamptz,
  evidence_artifact_id uuid REFERENCES evidence_artifact(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- A state that claims an outcome must carry the instant AND the evidence that produced it. Stated in the
  -- database because "CONFIRMED, but nobody knows when or from what" is the shape VG-ACTION-003 forbids.
  CHECK (state = 'PENDING' OR (readback_at IS NOT NULL AND evidence_artifact_id IS NOT NULL))
);

-- §5.8.6 lists a case's pieces and §5.8.1 reports the piece for an action, so both lookups are indexed.
CREATE INDEX mail_piece_case_created_idx ON mail_piece (tenant_id, case_id, created_at DESC);
CREATE INDEX reconciliation_action_idx ON reconciliation (tenant_id, external_action_id, observed_at DESC);
CREATE INDEX readback_action_idx ON readback (tenant_id, external_action_id, requested_at DESC);

ALTER TABLE mail_piece
  ADD COLUMN delivery_evidence_artifact_id uuid REFERENCES evidence_artifact(id),
  ADD COLUMN sent_at timestamptz;

ALTER TABLE mail_piece
  DROP CONSTRAINT mail_piece_delivery_status_check;
ALTER TABLE mail_piece
  ADD CONSTRAINT mail_piece_delivery_status_check
    CHECK (delivery_status IN ('NOT_SENT','SENT','ACCEPTED','IN_TRANSIT','DELIVERED','RETURNED','UNKNOWN'));

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: reconciliation
ALTER TABLE reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON reconciliation
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: readback
ALTER TABLE readback ENABLE ROW LEVEL SECURITY;
ALTER TABLE readback FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON readback
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END
