/**
 * Policy decisions and jurisdiction policies against PostgreSQL (SPEC-003 §5.6.1–§5.6.4).
 *
 * THE RESOLUTION GOES THROUGH THE DOMAIN COMMAND. `resolvePolicy` re-asserts the policy version at the moment of
 * resolution (`assertPolicyInForce`: the decision's version must be the one the policy row carries, inside its
 * effective window, and the legal basis must exist in that version's rule set) and returns an audit row for the
 * decision. This file supplies the facts and writes what the command returned; it never decides a legal basis,
 * never picks a channel on its own, and never moves a truth state.
 *
 * THE CHANNEL IS CHECKED WITH THE DOMAIN'S OWN PRIORITY ENGINE. §5.6.1 refuses `409 CHANNEL_PRIORITY_VIOLATION`
 * when "a lower-priority channel [is] requested while a lawful higher-priority channel (§8) is available and not
 * recorded as unavailable with a reason". `selectChannel` is that rule, stated once in the domain against
 * SPEC-000 §8's ordering, so this file builds the option set the request describes — the requested channel plus
 * every alternative the caller listed — and refuses when the engine's selection is not what was requested.
 */

import { createHash } from 'node:crypto';

import type {
  JurisdictionPolicyRow,
  ListPoliciesParams,
  PolicyDecisionRow,
  PolicyQueries,
  ResolvePolicyOutcome,
  ResolvePolicyRequest,
} from '../../application/contracts/policy-queries.ts';
import { resolvePolicy } from '../../domain/commands.ts';
import { createJurisdictionPolicy, createPolicyDecision } from '../../domain/entities.ts';
import { DomainError } from '../../domain/errors.ts';
import { TenantId } from '../../domain/identifiers.ts';
import {
  CHANNEL_NAMES,
  Jurisdiction,
  LegalBasis,
  selectChannel,
  type ChannelName,
  type ChannelOption,
} from '../../domain/values.ts';
import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import { appendAuditEvents } from './audit-sink.ts';

/** The exemption evaluation every decision reports, and the one place it is stated. */
const NOT_EVALUATED = Object.freeze({ evaluated: false as const, exempt: null, checks: [] as readonly never[] });

function checksumOf(rules: readonly string[]): string {
  // The rules in their STORED order, so a reordering is a different checksum: the point of a checksum is to
  // change when the thing it covers changes.
  return createHash('sha256').update(JSON.stringify([...rules]), 'utf8').digest('hex');
}

function toDecisionRow(row: {
  id: string;
  case_id: string;
  jurisdiction: string;
  legal_basis: string;
  channel: string;
  version_label: string | null;
  reasons: unknown;
  decided_at: Date;
}): PolicyDecisionRow {
  return {
    policyDecisionId: row.id,
    caseId: row.case_id,
    jurisdiction: row.jurisdiction,
    legalBasis: row.legal_basis,
    channel: row.channel,
    policyVersion: row.version_label,
    reasons: Array.isArray(row.reasons)
      ? row.reasons.filter((entry): entry is string => typeof entry === 'string')
      : [],
    decidedAt: row.decided_at.toISOString(),
    exemptionEvaluation: NOT_EVALUATED,
  };
}

export class PostgresPolicyQueries implements PolicyQueries {
  async caseRowVersion(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<{ readonly rowVersionMs: number; readonly truthState: string } | undefined> {
    const result = await tx.query<{ updated_at: Date; truth_state: string }>(
      `SELECT c.updated_at, c.truth_state::text AS truth_state FROM request_case c WHERE c.id = $1::uuid`,
      [caseId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { rowVersionMs: row.updated_at.getTime(), truthState: row.truth_state };
  }

  async resolvePolicyDecision(
    tx: TenantTransaction,
    request: ResolvePolicyRequest,
  ): Promise<ResolvePolicyOutcome> {
    const base = await tx.query<{
      tenant_id: string;
      truth_state: string;
      updated_at: Date;
      subject_id: string;
      authority_grant_id: string;
      is_minor: boolean;
    }>(
      `SELECT c.tenant_id::text AS tenant_id, c.truth_state::text AS truth_state, c.updated_at,
              c.subject_id::text AS subject_id, c.authority_grant_id::text AS authority_grant_id,
              s.is_minor
         FROM request_case c JOIN protected_subject s ON s.id = c.subject_id
        WHERE c.id = $1::uuid`,
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

    // VG-POLICY-004 / §5.6.1: "For a minor subject, resolution for any automated write channel is refused with
    // `422 STRICT_LANE_REQUIRED`". NO table marks a channel as automated, so the rule is applied to EVERY channel
    // — the fail-closed direction, and the one the strict lane exists for. Recorded as a reading in §3.33.
    if (caseRow.is_minor) return { ok: false, reason: 'STRICT_LANE_REQUIRED' };

    // The authority is re-asserted at resolution, not remembered from creation (VG-AUTHZ-001): a grant revoked
    // between the two moments must not resolve a policy.
    const authority = await tx.query<{ revoked_at: Date | null; expires_at: Date | null; scope: string[] }>(
      `SELECT g.revoked_at, g.expires_at, g.scope FROM authority_grant g WHERE g.id = $1::uuid`,
      [caseRow.authority_grant_id],
    );
    const grant = authority.rows[0];
    const authorityValid =
      grant !== undefined &&
      grant.revoked_at === null &&
      (grant.expires_at === null || grant.expires_at.getTime() > request.nowMs);
    if (!authorityValid) return { ok: false, reason: 'CASE_AUTHORITY_INVALID' };

    const policies = await tx.query<{
      id: string;
      jurisdiction: string;
      version: number;
      effective_from: Date;
      effective_to: Date | null;
      rules: string[];
      provenance: string;
      version_label: string | null;
    }>(
      `SELECT p.id::text AS id, p.jurisdiction, p.version, p.effective_from, p.effective_to, p.rules,
              p.provenance, p.version_label
         FROM jurisdiction_policy p
        WHERE p.jurisdiction = $1
        ORDER BY p.version DESC`,
      [request.jurisdiction],
    );
    if (policies.rows.length === 0) return { ok: false, reason: 'JURISDICTION_UNRESOLVED' };

    const inForce = policies.rows.filter(
      (row) =>
        row.effective_from.getTime() <= request.nowMs &&
        (row.effective_to === null || row.effective_to.getTime() > request.nowMs),
    );
    const currentLabel = inForce[0]?.version_label ?? null;

    if (request.policyVersionLabel === null) {
      // The contract's request always carries a version; a caller that omits it is asking the API to choose which
      // version applies, and choosing is the API stating a legal conclusion of its own.
      return { ok: false, reason: 'POLICY_VERSION_UNNAMED' };
    }
    const named = policies.rows.find((row) => row.version_label === request.policyVersionLabel);
    if (named === undefined) return { ok: false, reason: 'JURISDICTION_UNRESOLVED' };
    const namedInForce =
      named.effective_from.getTime() <= request.nowMs &&
      (named.effective_to === null || named.effective_to.getTime() > request.nowMs);
    if (!namedInForce) {
      return { ok: false, reason: 'POLICY_VERSION_SUPERSEDED', inForceLabel: currentLabel };
    }

    // THE BASIS COMES FROM THE POLICY VERSION OR NOT AT ALL (see the port's header).
    if (named.rules.length !== 1) {
      return { ok: false, reason: 'LEGAL_BASIS_NOT_IN_POLICY_VERSION', rules: named.rules };
    }
    const legalBasisCode = named.rules[0] ?? '';

    // THE CHANNEL, THROUGH THE DOMAIN'S PRIORITY ENGINE.
    //
    // THE OPTION SET IS THE WHOLE PRIORITY TABLE, not just the channels the caller mentioned. VG-CHANNEL-001
    // allows a lower-priority channel only when EVERY higher-priority channel is RECORDED as unavailable with a
    // reason — so a channel the caller did not mention is AVAILABLE, which is the fail-closed reading: silence
    // about a higher-priority channel must not license a lower one. MEASURED: an earlier version passed only the
    // requested channel plus the caller's alternatives, and because the requested one was first in the array the
    // engine selected it and no violation was ever reported.
    //
    // `NOT_REMOVABLE_OUTCOME` is excluded: it is an outcome, not a channel a caller may request, and offering it
    // to the engine would let "no lawful channel" be selected as though it were one.
    const recordedUnavailable = new Map(
      request.alternatives
        .filter((alternative) => alternative.unavailable)
        .map((alternative) => [alternative.channel, alternative.reason ?? 'recorded unavailable']),
    );
    const options: ChannelOption[] = CHANNEL_NAMES.filter((name) => name !== 'NOT_REMOVABLE_OUTCOME').map(
      (name) => {
        const reason = recordedUnavailable.get(name);
        return {
          channel: name,
          unavailableKind: reason === undefined ? null : ('UNAVAILABLE' as const),
          unavailableReason: reason ?? null,
        };
      },
    );
    if (!CHANNEL_NAMES.includes(request.requestedChannel as ChannelName)) {
      return { ok: false, reason: 'CHANNEL_PRIORITY_VIOLATION', availableHigherPriority: '' };
    }
    let selected: ChannelName;
    try {
      selected = selectChannel(options).channel;
    } catch (error) {
      if (error instanceof DomainError) {
        // `selectChannel` refuses a malformed option set (an unavailable channel with no reason) and an option
        // set with no lawful channel at all. Both mean the request cannot be satisfied as written.
        return { ok: false, reason: 'CHANNEL_PRIORITY_VIOLATION', availableHigherPriority: '' };
      }
      throw error;
    }
    if (selected !== request.requestedChannel) {
      return { ok: false, reason: 'CHANNEL_PRIORITY_VIOLATION', availableHigherPriority: selected };
    }

    const tenantId = new TenantId(caseRow.tenant_id);
    const decisionId = (
      await tx.query<{ id: string }>(`SELECT gen_random_uuid()::text AS id`)
    ).rows[0]?.id;
    if (decisionId === undefined) return { ok: false, reason: 'JURISDICTION_UNRESOLVED' };

    const policy = createJurisdictionPolicy({
      id: named.id,
      tenantId,
      jurisdiction: new Jurisdiction(named.jurisdiction),
      version: named.version,
      effectiveFromMs: named.effective_from.getTime(),
      effectiveToMs: named.effective_to === null ? null : named.effective_to.getTime(),
      rules: [...named.rules],
      provenance: named.provenance as 'COUNSEL_REVIEWED' | 'OPERATOR_ENTERED',
    });
    const decision = createPolicyDecision({
      id: decisionId,
      tenantId,
      caseId: request.caseId,
      jurisdiction: new Jurisdiction(request.jurisdiction),
      legalBasis: new LegalBasis(legalBasisCode, named.version),
      channel: request.requestedChannel as ChannelName,
      policyVersion: named.version,
      reasons: [`CHANNEL_PRIORITY_${String(named.version)}_AVAILABLE`],
      decidedAtMs: request.nowMs,
    });

    let result;
    try {
      result = resolvePolicy(
        { tenantId, correlationId: request.correlationId, nowMs: request.nowMs },
        { caseId: request.caseId, decision, policy },
      );
    } catch (error) {
      if (error instanceof DomainError) {
        // The command re-asserts the version against the row it was given, so a refusal here means the policy
        // moved between the read and the command — inside one transaction, which is a defect rather than a race.
        return { ok: false, reason: 'POLICY_VERSION_SUPERSEDED', inForceLabel: currentLabel };
      }
      throw error;
    }

    await tx.query(
      `INSERT INTO policy_decision
         (id, tenant_id, case_id, jurisdiction, legal_basis, channel, policy_version, version_label, reasons,
          decided_at, exemption_evaluation)
       VALUES ($1::uuid, current_setting('app.tenant_id', true)::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb,
               to_timestamp($9::bigint / 1000.0), NULL)`,
      [
        decisionId,
        request.caseId,
        named.jurisdiction,
        legalBasisCode,
        request.requestedChannel,
        named.version,
        named.version_label,
        JSON.stringify(decision.reasons),
        Math.trunc(request.nowMs),
      ],
    );
    await appendAuditEvents(tx, [result.audit], { actorKind: 'SERVICE' });

    return {
      ok: true,
      response: {
        policyDecisionId: decisionId,
        caseId: request.caseId,
        jurisdiction: named.jurisdiction,
        legalBasis: legalBasisCode,
        channel: request.requestedChannel,
        policyVersion: named.version_label,
        reasons: [...decision.reasons],
        decidedAt: new Date(request.nowMs).toISOString(),
        exemptionEvaluation: NOT_EVALUATED,
      },
    };
  }

  async listPolicyDecisions(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<readonly PolicyDecisionRow[]> {
    const result = await tx.query<{
      id: string;
      case_id: string;
      jurisdiction: string;
      legal_basis: string;
      channel: string;
      version_label: string | null;
      reasons: unknown;
      decided_at: Date;
    }>(
      `SELECT d.id::text AS id, d.case_id::text AS case_id, d.jurisdiction, d.legal_basis, d.channel,
              d.version_label, d.reasons, d.decided_at
         FROM policy_decision d
        WHERE d.case_id = $1::uuid
        ORDER BY d.decided_at DESC, d.id DESC`,
      [caseId],
    );
    return result.rows.map(toDecisionRow);
  }

  async getPolicyDecision(
    tx: TenantTransaction,
    policyDecisionId: string,
  ): Promise<PolicyDecisionRow | undefined> {
    const result = await tx.query<{
      id: string;
      case_id: string;
      jurisdiction: string;
      legal_basis: string;
      channel: string;
      version_label: string | null;
      reasons: unknown;
      decided_at: Date;
    }>(
      `SELECT d.id::text AS id, d.case_id::text AS case_id, d.jurisdiction, d.legal_basis, d.channel,
              d.version_label, d.reasons, d.decided_at
         FROM policy_decision d WHERE d.id = $1::uuid`,
      [policyDecisionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toDecisionRow(row);
  }

  async listJurisdictionPolicies(
    tx: TenantTransaction,
    params: ListPoliciesParams,
  ): Promise<readonly JurisdictionPolicyRow[]> {
    const result = await tx.query<{
      jurisdiction: string;
      version: number;
      effective_from: Date;
      effective_to: Date | null;
      rules: string[];
      version_label: string | null;
    }>(
      `SELECT p.jurisdiction, p.version, p.effective_from, p.effective_to, p.rules, p.version_label
         FROM jurisdiction_policy p
        WHERE ($1::text IS NULL OR p.jurisdiction = $1)
        ORDER BY p.jurisdiction ASC, p.version DESC`,
      [params.jurisdiction],
    );
    const rows: JurisdictionPolicyRow[] = [];
    for (const row of result.rows) {
      const inForce =
        row.effective_from.getTime() <= params.inForceOnMs &&
        (row.effective_to === null || row.effective_to.getTime() > params.inForceOnMs);
      // `includeSuperseded: false` (the default) reports only versions in force ON THE INSTANT ASKED ABOUT, which
      // is why the flag filters on the same predicate the `inForce` field reports rather than on the clock.
      if (!params.includeSuperseded && !inForce) continue;
      rows.push({
        // A version nobody has labelled is reported by its ordinal rendered as a string: the field is the
        // contract's `policyVersion`, and omitting the row would hide a version that exists.
        policyVersion: row.version_label ?? String(row.version),
        jurisdiction: row.jurisdiction,
        effectiveFrom: row.effective_from.toISOString(),
        effectiveTo: row.effective_to === null ? null : row.effective_to.toISOString(),
        inForce,
        ruleCount: row.rules.length,
        policyChecksum: checksumOf(row.rules),
      });
    }
    return rows;
  }
}
