/**
 * External actions against PostgreSQL (SPEC-003 §5.8.1–§5.8.6).
 *
 * THE EXECUTION PATH EVALUATES EVERY GUARD AND THEN REFUSES THE EFFECT, AND THE ORDER MATTERS. §5.8.2 is
 * VG-ACTION-001's route: it submits a removal request through a channel. No channel transport exists in this
 * repository — there is no provider adapter, no certified-mail API, no SMTP binding — so a REAL submission is
 * refused `503 DEPENDENCY_UNAVAILABLE` naming the unconfigured channel, exactly as §5.3.7 refuses to create a
 * recipe it cannot verify while ADR-006 is open. The guards are still evaluated first, in the contract's order,
 * because a request that is illegal on its own terms deserves the specific refusal rather than a 503 that hides
 * it. A `dryRun` is a complete, contract-defined outcome ("guard evaluation and payload validation are performed
 * and reported, and no external effect is produced and no state changes") and returns 200 with all of it.
 *
 * NOTHING HERE INVENTS A DELIVERY STATUS OR A REMOVAL. §5.8.3's reconciliation never regresses a truth state and
 * never produces a state outside the closed T1–T21 set; `EFFECT_CONFIRMED` re-drives T8 only when the case is
 * still `REQUEST_READY`, and otherwise reports the state the case is in; `EFFECT_ABSENT` records the divergence
 * and leaves the state alone. §5.8.4 records a REQUEST for evidence and never evidence itself.
 */

import { createHash } from 'node:crypto';

import type {
  ActionDetail,
  ActionGuards,
  ActionListRow,
  ActionQueries,
  ExecuteActionOutcome,
  ExecuteActionRequest,
  MailPieceRow,
  ReadbackOutcome,
  ReadbackRequest,
  ReconciliationOutcome,
  ReconciliationRequest,
} from '../../application/contracts/action-queries.ts';
import {
  MAIL_DELIVERY_STATUS,
  RECONCILIATION_FINDINGS,
  RECONCILIATION_METHODS,
  READBACK_METHODS,
} from '../../application/contracts/action-queries.ts';
import type { RecipeVerificationKeys } from '../../application/contracts/source-queries.ts';
import { executeAction as executeActionCommand } from '../../domain/commands.ts';
import { createAuditEvent, createExternalAction } from '../../domain/entities.ts';
import { DomainError } from '../../domain/errors.ts';
import type { ExternalAction } from '../../domain/entities.ts';
import { ActionId, CaseId, TenantId } from '../../domain/identifiers.ts';
import { IdempotencyKey, type ChannelName } from '../../domain/values.ts';
import { containsApparentPii } from '../../domain/values.ts';
import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import { appendAuditEvents } from './audit-sink.ts';
import { canonicalRecipePayload, verifyRecipeSignature } from './sources.ts';

/**
 * THE EGRESS FIELD ALLOWLIST, DECLARED HERE BECAUSE THE MATRIX NAMES NO FIELDS.
 *
 * `DATA_EGRESS_MATRIX.md` states the rule ("default deny for `CUSTOMER_PII`, `HIGH_RISK_PII`,
 * `IDENTITY_DOCUMENT` and `AUTH_SECRET`; use opaque IDs, local models and redaction first") and enumerates no
 * field names, so there is no normative list to read. The set below is therefore a DECLARED CHOICE, recorded in
 * `ASSUMPTIONS.md` §3.32, and it is deliberately the smallest set that can express §5.8.2's own example
 * (`{"subjectDisplayRef":"SUBJ-2026-00042"}`). Everything else is refused `PAYLOAD_FIELD_NOT_ALLOWLISTED`, which
 * is the fail-closed direction the matrix asks for: a field nobody allowlisted is a field nobody reviewed.
 */
export const EGRESS_FIELD_ALLOWLIST: readonly string[] = Object.freeze([
  'subjectDisplayRef',
  'caseRef',
  'sourceRef',
]);

/** The events that count against VG-ACTION-005's effect budget: attempts that could reach the outside world. */
const BUDGET_STATUSES = ['PREPARED', 'SUBMITTED', 'AMBIGUOUS', 'FAILED'] as const;

const CHANNEL_TRANSPORTS: Readonly<Record<string, string | null>> = Object.freeze({
  // None of these has an adapter in this repository. The map exists so the refusal can NAME the missing
  // transport rather than answering a generic 503, and so adding one is a single entry plus its adapter.
  OFFICIAL_SELF_SERVICE: null,
  PRIVACY_EMAIL: null,
  CERTIFIED_MAIL: null,
  CENTRALIZED_GOVERNMENT: null,
  AUTHORIZED_AGENT: null,
  SEARCH_ENGINE_DELISTING: null,
});

function fingerprintOf(idempotencyKey: string): string {
  // One-way, and the SAME function for every row so a caller can recognise its own key across responses without
  // the key ever being echoed (VG-ACTION-001, §5.8.1).
  return createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
}

function toMailRow(row: {
  created_at: Date;
  id: string;
  case_id: string;
  template_version: number;
  template_hash: string;
  transport_name: string;
  tracking_id: string | null;
  delivery_status: string;
  delivery_evidence_artifact_id: string | null;
  sent_at: Date | null;
}): MailPieceRow {
  return {
    mailPieceId: row.id,
    caseId: row.case_id,
    templateVersion: row.template_version,
    templateHash: row.template_hash,
    provider: row.transport_name,
    trackingId: row.tracking_id,
    // Mapped through the declared table; an unmapped stored token is reported as UNKNOWN rather than echoed,
    // because §5.8.6's vocabulary is a closed set and the column's is not.
    deliveryStatus: MAIL_DELIVERY_STATUS[row.delivery_status] ?? 'UNKNOWN',
    deliveryEvidenceArtifactId: row.delivery_evidence_artifact_id,
    sentAt: row.sent_at === null ? null : row.sent_at.toISOString(),
    cursorValue: row.created_at.toISOString(),
  };
}

export class PostgresActionQueries implements ActionQueries {
  readonly #keys: RecipeVerificationKeys;

  constructor(options: { readonly recipeVerificationKeys: RecipeVerificationKeys }) {
    this.#keys = options.recipeVerificationKeys;
  }

  async caseExists(tx: TenantTransaction, caseId: string): Promise<boolean> {
    const result = await tx.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM request_case c WHERE c.id = $1::uuid) AS present`,
      [caseId],
    );
    return result.rows[0]?.present === true;
  }

  async #readbackState(
    tx: TenantTransaction,
    externalActionId: string,
  ): Promise<{ state: string; readbackAt: Date | null; evidenceArtifactId: string | null }> {
    const result = await tx.query<{ state: string; readback_at: Date | null; evidence_artifact_id: string | null }>(
      `SELECT r.state, r.readback_at, r.evidence_artifact_id::text AS evidence_artifact_id
         FROM readback r WHERE r.external_action_id = $1::uuid
        ORDER BY r.requested_at DESC, r.id DESC LIMIT 1`,
      [externalActionId],
    );
    const row = result.rows[0];
    // NO READBACK ROW MEANS PENDING: §5.8.2's response says `readbackRequired: true` for an accepted action, and
    // "required but not yet requested" is what PENDING means here. NULL would say nobody asked, which is true but
    // not what the contract's field reports.
    if (row === undefined) return { state: 'PENDING', readbackAt: null, evidenceArtifactId: null };
    return { state: row.state, readbackAt: row.readback_at, evidenceArtifactId: row.evidence_artifact_id };
  }

  async #mailPieceFor(
    tx: TenantTransaction,
    caseId: string,
    channel: string,
  ): Promise<MailPieceRow | null> {
    const result = await tx.query<{
      created_at: Date;
      id: string;
      case_id: string;
      template_version: number;
      template_hash: string;
      transport_name: string;
      tracking_id: string | null;
      delivery_status: string;
      delivery_evidence_artifact_id: string | null;
      sent_at: Date | null;
    }>(
      `SELECT m.id::text AS id, m.case_id::text AS case_id, m.template_version, m.template_hash,
              m.transport_name, m.tracking_id, m.delivery_status,
              m.delivery_evidence_artifact_id::text AS delivery_evidence_artifact_id, m.sent_at, m.created_at, m.created_at
         FROM mail_piece m WHERE m.case_id = $1::uuid
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
      [caseId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    // §5.8.5 reports `mailPiece` "when the channel is certified mail"; the row exists only for that channel in
    // practice, so the presence of the row is the condition and `channel` documents why the caller asked.
    void channel;
    return toMailRow(row);
  }

  async listActions(
    tx: TenantTransaction,
    params: {
      readonly caseId: string;
      readonly limit: number;
      readonly after?: { readonly sortValue: string; readonly id: string };
    },
  ): Promise<readonly ActionListRow[]> {
    const values: unknown[] = [params.caseId];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${String(values.length)}`;
    };
    const keyset =
      params.after === undefined
        ? ''
        : // Ordering and pagination truncate together (ASSUMPTIONS §3.26): `created_at` is `now()`-derived and
          // carries microseconds while a cursor can only carry milliseconds.
          `AND (date_trunc('milliseconds', a.created_at), a.id::text) < (${bind(params.after.sortValue)}::timestamptz, ${bind(params.after.id)}::text)`;
    const limitParam = bind(params.limit + 1);

    const result = await tx.query<{
      id: string;
      case_id: string;
      channel: string;
      recipe_id: string | null;
      recipe_version: number | null;
      attempt: number;
      status: string;
      idempotency_key: string;
      submitted_at: Date | null;
      created_at: Date;
    }>(
      `SELECT a.id::text AS id, a.case_id::text AS case_id, a.channel, a.recipe_id::text AS recipe_id,
              a.recipe_version, a.attempt, a.status, a.idempotency_key, a.submitted_at, a.created_at
         FROM external_action a
        WHERE a.case_id = $1::uuid ${keyset}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limitParam}`,
      values,
    );

    const rows: ActionListRow[] = [];
    for (const row of result.rows) {
      const readback = await this.#readbackState(tx, row.id);
      const piece = await this.#mailPieceFor(tx, row.case_id, row.channel);
      rows.push({
        externalActionId: row.id,
        caseId: row.case_id,
        channel: row.channel,
        recipeId: row.recipe_id,
        recipeVersion: row.recipe_version,
        attempt: row.attempt,
        actionOutcome: row.status,
        idempotencyKeyFingerprint: fingerprintOf(row.idempotency_key),
        submittedAt: row.submitted_at === null ? null : row.submitted_at.toISOString(),
        readbackState: readback.state,
        mailPieceId: piece?.mailPieceId ?? null,
        cursorValue: row.created_at.toISOString(),
      });
    }
    return rows;
  }

  async actionRowVersion(
    tx: TenantTransaction,
    externalActionId: string,
  ): Promise<{ readonly rowVersionMs: number } | undefined> {
    const result = await tx.query<{ created_at: Date }>(
      `SELECT a.created_at FROM external_action a WHERE a.id = $1::uuid`,
      [externalActionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { rowVersionMs: row.created_at.getTime() };
  }

  async getActionDetail(
    tx: TenantTransaction,
    externalActionId: string,
  ): Promise<ActionDetail | undefined> {
    const base = await tx.query<{
      id: string;
      case_id: string;
      channel: string;
      recipe_id: string | null;
      recipe_version: number | null;
      attempt: number;
      status: string;
      idempotency_key: string;
      submitted_at: Date | null;
      template_version: number | null;
      template_hash: string | null;
      ambiguous: boolean;
      created_at: Date;
      truth_state: string;
    }>(
      `SELECT a.id::text AS id, a.case_id::text AS case_id, a.channel, a.recipe_id::text AS recipe_id,
              a.recipe_version, a.attempt, a.status, a.idempotency_key, a.submitted_at,
              a.template_version, a.template_hash, a.ambiguous, a.created_at,
              c.truth_state::text AS truth_state
         FROM external_action a JOIN request_case c ON c.id = a.case_id
        WHERE a.id = $1::uuid`,
      [externalActionId],
    );
    const row = base.rows[0];
    // Absent and another tenant's action reach this branch by construction (RLS): one 404 body (SPEC-006 H-9).
    if (row === undefined) return undefined;

    const readback = await this.#readbackState(tx, externalActionId);
    const piece = await this.#mailPieceFor(tx, row.case_id, row.channel);
    const recipe = await tx.query<{
      id: string;
      version: number;
      verification_method: string;
      channel: string;
    }>(
      `SELECT r.id::text AS id, r.version, r.verification_method, r.channel
         FROM removal_recipe r WHERE r.id = $1::uuid`,
      [row.recipe_id],
    );
    const reconciliation = await tx.query<{
      observed_at: Date;
      finding: string;
      method: string;
    }>(
      `SELECT r.observed_at, r.finding, r.method FROM reconciliation r
        WHERE r.external_action_id = $1::uuid
        ORDER BY r.observed_at DESC, r.id DESC LIMIT 1`,
      [externalActionId],
    );
    const recipeRow = recipe.rows[0];
    const reconciliationRow = reconciliation.rows[0];

    return {
      externalActionId: row.id,
      caseId: row.case_id,
      channel: row.channel,
      recipeId: row.recipe_id,
      recipeVersion: row.recipe_version,
      attempt: row.attempt,
      actionOutcome: row.status,
      idempotencyKeyFingerprint: fingerprintOf(row.idempotency_key),
      submittedAt: row.submitted_at === null ? null : row.submitted_at.toISOString(),
      readbackState: readback.state,
      mailPieceId: piece?.mailPieceId ?? null,
      cursorValue: row.created_at.toISOString(),
      rowVersionMs: row.created_at.getTime(),
      caseTruthState: row.truth_state,
      recipeSnapshot:
        recipeRow === undefined
          ? null
          : {
              recipeId: recipeRow.id,
              version: recipeRow.version,
              verificationMethod: recipeRow.verification_method,
              channel: recipeRow.channel,
            },
      templateSnapshot: { templateVersion: row.template_version, templateHash: row.template_hash },
      readback: {
        state: readback.state,
        readbackAt: readback.readbackAt === null ? null : readback.readbackAt.toISOString(),
        readbackEvidenceArtifactId: readback.evidenceArtifactId,
      },
      ambiguity: {
        ambiguous: row.ambiguous,
        reconciledAt: reconciliationRow === undefined ? null : reconciliationRow.observed_at.toISOString(),
        finding: reconciliationRow?.finding ?? null,
        method: reconciliationRow?.method ?? null,
      },
      mailPiece: piece,
    };
  }

  async listMailPieces(
    tx: TenantTransaction,
    params: {
      readonly caseId: string;
      readonly limit: number;
      readonly after?: { readonly sortValue: string; readonly id: string };
    },
  ): Promise<readonly MailPieceRow[]> {
    const values: unknown[] = [params.caseId];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${String(values.length)}`;
    };
    const keyset =
      params.after === undefined
        ? ''
        : `AND (date_trunc('milliseconds', m.created_at), m.id::text) < (${bind(params.after.sortValue)}::timestamptz, ${bind(params.after.id)}::text)`;
    const limitParam = bind(params.limit + 1);

    const result = await tx.query<{
      created_at: Date;
      id: string;
      case_id: string;
      template_version: number;
      template_hash: string;
      transport_name: string;
      tracking_id: string | null;
      delivery_status: string;
      delivery_evidence_artifact_id: string | null;
      sent_at: Date | null;
    }>(
      `SELECT m.id::text AS id, m.case_id::text AS case_id, m.template_version, m.template_hash,
              m.transport_name, m.tracking_id, m.delivery_status,
              m.delivery_evidence_artifact_id::text AS delivery_evidence_artifact_id, m.sent_at, m.created_at, m.created_at
         FROM mail_piece m
        WHERE m.case_id = $1::uuid ${keyset}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${limitParam}`,
      values,
    );
    return result.rows.map(toMailRow);
  }

  async executeAction(tx: TenantTransaction, request: ExecuteActionRequest): Promise<ExecuteActionOutcome> {
    const base = await tx.query<{
      tenant_id: string;
      truth_state: string;
      updated_at: Date;
      source_id: string;
      subject_id: string;
      authority_grant_id: string;
      policy_decision_id: string | null;
      recipe_id: string | null;
    }>(
      `SELECT c.tenant_id::text AS tenant_id, c.truth_state::text AS truth_state, c.updated_at,
              c.source_id::text AS source_id, c.subject_id::text AS subject_id,
              c.authority_grant_id::text AS authority_grant_id, c.policy_decision_id::text AS policy_decision_id,
              c.recipe_id::text AS recipe_id
         FROM request_case c WHERE c.id = $1::uuid`,
      [request.caseId],
    );
    const caseRow = base.rows[0];
    if (caseRow === undefined) return { ok: false, reason: 'NOT_FOUND' };
    const rowVersionMs = caseRow.updated_at.getTime();
    if (rowVersionMs !== request.expectedRowVersionMs) {
      return {
        ok: false,
        reason: 'PRECONDITION_FAILED',
        currentRowVersionMs: rowVersionMs,
        truthState: caseRow.truth_state,
      };
    }
    // THE STATE CHECKS HAPPEN AFTER THE DRY-RUN BRANCH, and that ordering is a decision rather than an accident:
    // §5.8.2's dry run "performs and reports" guard evaluation, so a caller in the wrong state must be able to
    // ASK what would block them. A real submission is refused `409 ILLEGAL_TRANSITION` below, after the gate
    // check, because "case not in REQUEST_READY (in particular, MATCH_CONFIRMED → REQUEST_SUBMITTED is explicitly
    // illegal, SPEC-001 §4.2)" is the answer a caller acting on a gated or unready case needs.
    // (MEASURED: with the check here, TypeScript narrowed the state to `REQUEST_READY` and the later
    // `humanGateOpen` comparison became unreachable — a dead refusal the contract lists.)

    // THE PAYLOAD ALLOWLIST, before anything else that could be influenced by it (VG-EGRESS-001).
    for (const [field, value] of Object.entries(request.payloadFields)) {
      if (!EGRESS_FIELD_ALLOWLIST.includes(field)) {
        return { ok: false, reason: 'PAYLOAD_FIELD_NOT_ALLOWLISTED', field };
      }
      if (containsApparentPii(value)) {
        // The allowlist admits a NAME; the value must still be an opaque reference. A caller that put an email
        // address in `subjectDisplayRef` is refused here rather than at the boundary of the network.
        return { ok: false, reason: 'PAYLOAD_FIELD_NOT_ALLOWLISTED', field };
      }
    }
    // VG-ACTION-004: CERTIFIED_MAIL requires a template hash, because a mail piece without one cannot be proven
    // to be the letter that was authorised.
    const templateHashRequired = request.channel === 'CERTIFIED_MAIL';
    if (templateHashRequired && (request.templateHash === null || request.templateVersion === null)) {
      return { ok: false, reason: 'TEMPLATE_HASH_REQUIRED' };
    }

    const decision = await tx.query<{ channel: string; policy_version: number }>(
      `SELECT d.channel, d.policy_version FROM policy_decision d WHERE d.id = $1::uuid`,
      [caseRow.policy_decision_id],
    );
    const decisionRow = decision.rows[0];
    if (decisionRow === undefined || decisionRow.channel !== request.channel) {
      return { ok: false, reason: 'CHANNEL_PRIORITY_VIOLATION' };
    }

    const authority = await tx.query<{ revoked_at: Date | null; expires_at: Date | null; scope: string[] }>(
      `SELECT g.revoked_at, g.expires_at, g.scope FROM authority_grant g WHERE g.id = $1::uuid`,
      [caseRow.authority_grant_id],
    );
    const authorityRow = authority.rows[0];
    const authorityValid =
      authorityRow !== undefined &&
      authorityRow.revoked_at === null &&
      (authorityRow.expires_at === null || authorityRow.expires_at.getTime() > request.nowMs) &&
      authorityRow.scope.includes('self_service_write');

    const source = await tx.query<{ permission_class: string }>(
      `SELECT s.permission_class::text AS permission_class FROM source s WHERE s.id = $1::uuid`,
      [caseRow.source_id],
    );
    const sourceWritable = source.rows[0]?.permission_class === 'WRITE_PERMITTED';

    const recipe = await tx.query<{
      id: string;
      source_id: string;
      version: number;
      channel: string;
      verification_method: string;
      freshness_at: Date;
      enabled: boolean;
      signing_key_ref: string | null;
      signature: Buffer | null;
      max_attempts_per_window: number | null;
      window_seconds: number | null;
    }>(
      `SELECT r.id::text AS id, r.source_id::text AS source_id, r.version, r.channel, r.verification_method,
              r.freshness_at, r.enabled, r.signing_key_ref, r.signature, r.max_attempts_per_window, r.window_seconds
         FROM removal_recipe r WHERE r.id = $1::uuid`,
      [request.recipeId],
    );
    const recipeRow = recipe.rows[0];
    if (recipeRow === undefined || recipeRow.version !== request.recipeVersion) {
      return { ok: false, reason: 'RECIPE_DISABLED' };
    }
    if (!recipeRow.enabled) return { ok: false, reason: 'RECIPE_DISABLED' };
    if (recipeRow.freshness_at.getTime() <= request.nowMs) return { ok: false, reason: 'RECIPE_STALE' };
    let recipeSigned = false;
    if (recipeRow.signature !== null && recipeRow.signing_key_ref !== null) {
      const verdict = verifyRecipeSignature(
        {
          signingKeyRef: recipeRow.signing_key_ref,
          signature: recipeRow.signature,
          payload: canonicalRecipePayload({
            sourceId: recipeRow.source_id,
            channel: recipeRow.channel,
            verificationMethod: recipeRow.verification_method,
            signingKeyRef: recipeRow.signing_key_ref,
            freshnessAt: recipeRow.freshness_at.toISOString(),
            maxAttemptsPerWindow: recipeRow.max_attempts_per_window ?? 0,
            windowSeconds: recipeRow.window_seconds ?? 0,
          }),
        },
        this.#keys,
      );
      recipeSigned = verdict === 'VERIFIED';
    }

    // VG-ACTION-005's budget, counted over the recipe's own window for this subject x source.
    let used = 0;
    let budgetAvailable = true;
    if (recipeRow.max_attempts_per_window !== null && recipeRow.window_seconds !== null) {
      const counted = await tx.query<{ used: number }>(
        `SELECT count(*)::int AS used FROM external_action a
          WHERE a.case_id IN (SELECT c2.id FROM request_case c2 WHERE c2.subject_id = $1::uuid AND c2.source_id = $2::uuid)
            AND a.status = ANY($3::text[])
            AND a.created_at > now() - make_interval(secs => $4::int)`,
        [caseRow.subject_id, caseRow.source_id, [...BUDGET_STATUSES], recipeRow.window_seconds],
      );
      used = counted.rows[0]?.used ?? 0;
      budgetAvailable = used < recipeRow.max_attempts_per_window;
    }

    // An OPEN HUMAN GATE IS THE CASE'S STATE. `human_gate` rows carry no resolution column, so "open" is exactly
    // "the case is at HUMAN_REQUIRED" — the state the gate drove it to. §5.8.2 refuses `422 HUMAN_GATE_OPEN`.
    const humanGateOpen = caseRow.truth_state === 'HUMAN_REQUIRED';

    const guards: ActionGuards = {
      authorityValid,
      recipeSignedAndFresh: recipeSigned && recipeRow.freshness_at.getTime() > request.nowMs,
      recipeEnabled: recipeRow.enabled,
      channelMatchesDecision: decisionRow.channel === request.channel,
      sourceWritable,
      budgetAvailable,
      humanGateOpen,
    };

    // A DRY RUN IS A COMPLETE OUTCOME (200): guards evaluated, payload validated, nothing produced, no state
    // change. It is NOT a submission, and the response says which state a real one would move to. A FAILED guard
    // is REPORTED here rather than refused, which is what "guard evaluation and payload validation are performed
    // and reported" means — a dry run whose point is to tell the caller what would block them must not answer
    // with the refusal itself.
    if (request.dryRun) {
      const wouldTransitionTo =
        guards.authorityValid &&
        guards.recipeSignedAndFresh &&
        guards.sourceWritable &&
        guards.budgetAvailable &&
        !guards.humanGateOpen
          ? 'REQUEST_SUBMITTED'
          : null;
      return {
        ok: true,
        response: {
          dryRun: true,
          guardsEvaluated: guards,
          payloadFieldsAccepted: Object.keys(request.payloadFields),
          wouldTransitionTo,
          templateHashRequired,
        },
      };
    }

    // A REAL SUBMISSION. The refusals are ordered so the caller learns the most specific thing first: the gate
    // that is holding the case, then the state, then the request's own entitlements, and only then the missing
    // transport — which is what every channel in this repository currently answers.
    if (humanGateOpen) return { ok: false, reason: 'HUMAN_GATE_OPEN' };
    if (caseRow.truth_state !== 'REQUEST_READY') {
      return { ok: false, reason: 'ILLEGAL_TRANSITION', fromTruthState: caseRow.truth_state };
    }
    if (!authorityValid) return { ok: false, reason: 'AUTHORITY_INVALID' };
    if (!sourceWritable) return { ok: false, reason: 'SOURCE_PERMISSION_UNCLEAR' };
    if (!recipeSigned) return { ok: false, reason: 'RECIPE_DISABLED' };
    if (!budgetAvailable) {
      return {
        ok: false,
        reason: 'EFFECT_BUDGET_EXCEEDED',
        used,
        limit: recipeRow.max_attempts_per_window ?? 0,
      };
    }

    const transport = CHANNEL_TRANSPORTS[request.channel];
    if (transport === undefined || transport === null) {
      // NO TRANSPORT EXISTS. This is the honest answer for every channel in this repository, and it is a 503
      // rather than a silent success precisely because the alternative is a route that reports submissions it
      // never made (VG-ACTION-001).
      return { ok: false, reason: 'CHANNEL_TRANSPORT_UNCONFIGURED', channel: request.channel };
    }

    // Unreachable today: every entry in CHANNEL_TRANSPORTS is null. It exists so that adding an adapter is a
    // single map entry plus the adapter, with the guards, idempotency and audit already in place — and so this
    // file has no code path that records a submission without a transport.
    throw new Error('a configured channel transport has no execution path yet');
  }

  async recordReconciliation(
    tx: TenantTransaction,
    request: ReconciliationRequest,
  ): Promise<ReconciliationOutcome> {
    const base = await tx.query<{
      id: string;
      case_id: string;
      status: string;
      ambiguous: boolean;
      channel: string;
      truth_state: string;
      tenant_id: string;
    }>(
      `SELECT a.id::text AS id, a.case_id::text AS case_id, a.status, a.ambiguous, a.channel,
              c.truth_state::text AS truth_state, c.tenant_id::text AS tenant_id
         FROM external_action a JOIN request_case c ON c.id = a.case_id
        WHERE a.id = $1::uuid`,
      [request.externalActionId],
    );
    const row = base.rows[0];
    if (row === undefined) return { ok: false, reason: 'NOT_FOUND' };
    // §5.8.3: "409 ACTION_NOT_AMBIGUOUS (nothing to reconcile)".
    if (!row.ambiguous) return { ok: false, reason: 'ACTION_NOT_AMBIGUOUS', actionOutcome: row.status };
    if (request.evidenceArtifactId !== null) {
      const evidence = await tx.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM evidence_artifact e WHERE e.id = $1::uuid) AS present`,
        [request.evidenceArtifactId],
      );
      if (evidence.rows[0]?.present !== true) return { ok: false, reason: 'EVIDENCE_NOT_FOUND' };
    }

    await tx.query(
      `INSERT INTO reconciliation
         (tenant_id, case_id, external_action_id, method, observed_at, finding, evidence_artifact_id, note)
       VALUES (current_setting('app.tenant_id', true)::uuid, $1::uuid, $2::uuid, $3, to_timestamp($4::bigint / 1000.0),
               $5, $6::uuid, $7)`,
      [
        row.case_id,
        request.externalActionId,
        request.method,
        Math.trunc(Date.parse(request.observedAt)),
        request.finding,
        request.evidenceArtifactId,
        request.note,
      ],
    );

    const tenantId = new TenantId(row.tenant_id);
    const observationId = `reconciliation:${request.externalActionId}`;

    if (request.finding === 'EFFECT_ABSENT') {
      // THE DIVERGENCE IS RECORDED AND THE STATE DOES NOT MOVE. §5.8.3: "a reissue requires a NEW IdempotencyKey.
      // No truth state regresses: SPEC-001 §4.1 has no reverse transition, and the API does not invent one."
      await tx.query(`UPDATE external_action SET status = 'FAILED', ambiguous = false WHERE id = $1::uuid`, [
        request.externalActionId,
      ]);
      const event = createAuditEvent({
        id: `${observationId}:${String(request.nowMs)}`,
        tenantId,
        actor: 'domain-command',
        action: 'ReconcileAction',
        targetKind: 'ExternalAction',
        targetId: request.externalActionId,
        correlationId: request.correlationId,
        atMs: request.nowMs,
        payload: {
          finding: request.finding,
          method: request.method,
          divergenceRecorded: true,
          truthStateUnchanged: row.truth_state,
        },
      });
      await appendAuditEvents(tx, [event], { actorKind: 'SERVICE' });
      return {
        ok: true,
        response: {
          externalActionId: request.externalActionId,
          actionOutcome: 'FAILED',
          caseId: row.case_id,
          truthState: null,
          truthStateUnchanged: row.truth_state,
          transitionCode: null,
          readbackRequired: false,
          divergenceRecorded: true,
          reissueAllowed: true,
          requiresNewIdempotencyKey: true,
          escalatedTo: null,
        },
      };
    }

    if (request.finding === 'INDETERMINATE') {
      // §5.8.3: the case is driven to HUMAN_REQUIRED via T9/T12 "where the current state permits it".
      //
      // THE AMBIGUITY IS NOT CLEARED, and the database says so itself: `external_action_check` is
      // `CHECK (status <> 'AMBIGUOUS' OR ambiguous)` — "an ambiguous result must be reconcilable, never silent"
      // (VG-ACTION-002). MEASURED: this branch first ran `SET ambiguous = false` and the constraint refused the
      // row (DatabaseError 23514). The rule is right: an INDETERMINATE reconciliation has NOT established what
      // happened, so the action stays ambiguous and reconcilable — a later reconciliation may still resolve it —
      // and what gets recorded now is the ESCALATION.
      const event = createAuditEvent({
        id: `${observationId}:${String(request.nowMs)}`,
        tenantId,
        actor: 'domain-command',
        action: 'ReconcileAction',
        targetKind: 'ExternalAction',
        targetId: request.externalActionId,
        correlationId: request.correlationId,
        atMs: request.nowMs,
        payload: { finding: request.finding, method: request.method, escalatedTo: 'HUMAN_REQUIRED' },
      });
      await appendAuditEvents(tx, [event], { actorKind: 'SERVICE' });
      return {
        ok: true,
        response: {
          externalActionId: request.externalActionId,
          actionOutcome: 'AMBIGUOUS',
          caseId: row.case_id,
          truthState: row.truth_state,
          truthStateUnchanged: null,
          transitionCode: null,
          readbackRequired: false,
          divergenceRecorded: false,
          reissueAllowed: false,
          requiresNewIdempotencyKey: false,
          escalatedTo: 'HUMAN_REQUIRED',
        },
      };
    }

    // EFFECT_CONFIRMED: the action did happen after all. The truth state moves ONLY if the case has not already
    // been moved by T8 — and a new readback is required either way, because confirming the effect is not
    // verifying the removal (VG-ACTION-003).
    await tx.query(`UPDATE external_action SET status = 'SUBMITTED', ambiguous = false WHERE id = $1::uuid`, [
      request.externalActionId,
    ]);
    let transitionCode: string | null = null;
    let truthState = row.truth_state;
    if (row.truth_state === 'REQUEST_READY') {
      const action = await this.#loadDomainAction(tx, request.externalActionId);
      if (action !== null) {
        try {
          const result = executeActionCommand(
            { tenantId, correlationId: request.correlationId, nowMs: request.nowMs },
            {
              caseId: row.case_id,
              action,
              existingIdempotencyKeys: [],
              budgetAvailable: true,
              outcome: { kind: 'ACCEPTED', receiptRef: `reconciled:${request.externalActionId}` },
            },
          );
          // The command returns a TRANSITION or an honest REFUSAL, and only a transition may move the case. A
          // refusal here means the machine would not accept the pair, which is recorded and reported rather than
          // retried or forced — `executeAction` returns a refusal when its own budget or idempotency guards fail.
          if ('refused' in result) {
            await appendAuditEvents(tx, [result.audit], { actorKind: 'SERVICE' });
          } else {
            await appendAuditEvents(
              tx,
              [result.audit],
              { actorKind: 'SERVICE' },
              {
                transitionCode: result.transitionId,
                from: result.from,
                to: result.to,
                evidenceArtifactIds: request.evidenceArtifactId === null ? [] : [request.evidenceArtifactId],
                caseId: row.case_id,
              },
            );
            await tx.query(`UPDATE request_case SET truth_state = $2::truth_state WHERE id = $1::uuid`, [
              row.case_id,
              result.to,
            ]);
            transitionCode = result.transitionId;
            truthState = result.to;
          }
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          // The machine refused the pair by THROWING (an illegal transition), so the state stays and the
          // reconciliation is still recorded.
          transitionCode = null;
        }
      }
    }

    return {
      ok: true,
      response: {
        externalActionId: request.externalActionId,
        actionOutcome: 'SUBMITTED',
        caseId: row.case_id,
        truthState,
        truthStateUnchanged: null,
        transitionCode,
        readbackRequired: true,
        divergenceRecorded: false,
        reissueAllowed: false,
        requiresNewIdempotencyKey: false,
        escalatedTo: null,
      },
    };
  }

  /** The stored action as the domain entity, for the command that records a confirmed effect. */
  async #loadDomainAction(tx: TenantTransaction, externalActionId: string): Promise<ExternalAction | null> {
    const result = await tx.query<{
      id: string;
      tenant_id: string;
      case_id: string;
      channel: string;
      idempotency_key: string;
      attempt: number;
      status: string;
      ambiguous: boolean;
      submitted_at: Date | null;
    }>(
      `SELECT a.id::text AS id, a.tenant_id::text AS tenant_id, a.case_id::text AS case_id, a.channel,
              a.idempotency_key, a.attempt, a.status, a.ambiguous, a.submitted_at
         FROM external_action a WHERE a.id = $1::uuid`,
      [externalActionId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return createExternalAction({
      id: new ActionId(row.id),
      tenantId: new TenantId(row.tenant_id),
      caseId: new CaseId(row.case_id),
      channel: row.channel as ChannelName,
      idempotencyKey: new IdempotencyKey(row.idempotency_key),
      attempt: row.attempt,
      status: row.status as ExternalAction['status'],
      ambiguous: row.ambiguous,
      submittedAtMs: row.submitted_at === null ? null : row.submitted_at.getTime(),
    });
  }

  async requestReadback(tx: TenantTransaction, request: ReadbackRequest): Promise<ReadbackOutcome> {
    const base = await tx.query<{
      id: string;
      case_id: string;
      acting_path_id: string | null;
      channel: string;
      recipe_id: string | null;
    }>(
      `SELECT a.id::text AS id, a.case_id::text AS case_id, a.acting_path_id, a.channel,
              a.recipe_id::text AS recipe_id
         FROM external_action a WHERE a.id = $1::uuid`,
      [request.externalActionId],
    );
    const row = base.rows[0];
    if (row === undefined) return { ok: false, reason: 'NOT_FOUND' };

    // VG-ACTION-003: the readback must observe through a DIFFERENT path than the one that acted. The recorded
    // acting path is what that comparison is against; when none is recorded — every action written before
    // migration 0027, and every action until a channel transport exists — the API CANNOT attest independence and
    // therefore does not claim it, which is why the response reports `independenceCheckedAgainst: null` rather
    // than a `true` nobody verified.
    if (row.acting_path_id !== null && row.acting_path_id === request.observationMethod) {
      return { ok: false, reason: 'OBSERVATION_PATH_NOT_INDEPENDENT', actingPathId: row.acting_path_id };
    }

    const readbackId = (
      await tx.query<{ id: string }>(
        `INSERT INTO readback
           (tenant_id, case_id, external_action_id, observation_method, state, requested_at)
         VALUES (current_setting('app.tenant_id', true)::uuid, $1::uuid, $2::uuid, $3, 'PENDING',
                 to_timestamp($4::bigint / 1000.0))
         RETURNING id::text AS id`,
        [
          row.case_id,
          request.externalActionId,
          request.observationMethod,
          Math.trunc(Date.parse(request.requestedAt)),
        ],
      )
    ).rows[0]?.id;
    if (readbackId === undefined) return { ok: false, reason: 'NOT_FOUND' };

    // A readback is a REQUEST for evidence, never evidence itself, and it never sets a truth state (§5.8.4).
    const tenantId = (
      await tx.query<{ tenant_id: string }>(
        `SELECT a.tenant_id::text AS tenant_id FROM external_action a WHERE a.id = $1::uuid`,
        [request.externalActionId],
      )
    ).rows[0]?.tenant_id;
    const event = createAuditEvent({
      id: `readback:${readbackId}`,
      tenantId: new TenantId(tenantId ?? ''),
      actor: 'domain-command',
      action: 'RequestReadback',
      targetKind: 'ExternalAction',
      targetId: request.externalActionId,
      correlationId: request.correlationId,
      atMs: request.nowMs,
      payload: { observationMethod: request.observationMethod, readbackId },
    });
    await appendAuditEvents(tx, [event], { actorKind: 'SERVICE' });

    return {
      ok: true,
      response: {
        externalActionId: request.externalActionId,
        readbackState: 'PENDING',
        observationMethod: request.observationMethod,
        readbackRequestId: readbackId,
        independenceCheckedAgainst: row.acting_path_id,
      },
    };
  }
}

/** Re-exported so a route can name the vocabulary without importing the contract module twice. */
export { READBACK_METHODS, RECONCILIATION_FINDINGS, RECONCILIATION_METHODS };
