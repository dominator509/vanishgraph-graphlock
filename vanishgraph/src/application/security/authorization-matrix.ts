/**
 * The authorization matrix as data (SPEC-005 §5, §2 ROLE-1…ROLE-4; EP-006 M3).
 *
 * **THE DEFAULT IS DENY.** A cell that is not explicitly present is refused with the reason recorded, and that direction
 * is the whole design: an inferred `ALLOW` for a resource the matrix does not name is how a new route becomes reachable
 * before anybody decides it should be. The plan's fallback says the same thing — an ambiguous cell is `DENY` plus a
 * finding, never an inference and never an edit to the specification.
 *
 * THE PROHIBITIONS ARE ROWS, NOT PROSE. SPEC-005 §2 gives every role a "Notably may **not**" sentence, and each clause is
 * encoded here as an explicit `DENY` whose reason is the clause. A prohibition that lives only in a table in a document
 * is a prohibition a new route can forget; a prohibition that lives in the same structure the decision reads cannot be
 * forgotten without deleting a row.
 *
 * THE MATRIX IS SMALLER THAN THE SPECIFICATION'S, ON PURPOSE AND HONESTLY. SPEC-005 §5's full cell-by-cell matrix is a
 * large table; what is encoded here are the resources, actions and prohibitions this node can exercise and assert, with
 * `MATRIX_GAPS` naming the ones it does not yet cover so that a reader sees the boundary rather than assuming coverage.
 * An unlisted resource is `DENY`, so an uncovered gap fails closed.
 */

export type Decision = 'ALLOW' | 'DENY';

export interface MatrixCell {
  readonly resource: string;
  readonly action: string;
  readonly role: string;
  readonly decision: Decision;
  /** Why, in the specification's own terms. A DENY with no reason is indistinguishable from an oversight. */
  readonly reason: string;
}

/** Resources the matrix names. A resource absent from this list is refused with `UNKNOWN_RESOURCE`. */
export const MATRIX_RESOURCES: readonly string[] = Object.freeze([
  'subject',
  'authority_grant',
  'source',
  'recipe',
  'discovery_run',
  'exposure',
  'policy',
  'case',
  'action',
  'observation',
  'evidence',
  'appeal',
  'audit_event',
  'coverage',
  'identifier',
]);

/** The actions a caller can attempt. */
export const MATRIX_ACTIONS: readonly string[] = Object.freeze([
  'read',
  'write',
  'assess',
  'run',
  'execute',
  'revoke',
  'reveal',
  'approve',
  'delete',
  'export',
]);

const ROLES = ['SUBJECT_USER', 'GUARDIAN', 'OPERATOR', 'TENANT_ADMIN', 'AUDITOR', 'SUPPORT', 'COUNSEL_REVIEWER'] as const;
type Role = (typeof ROLES)[number];

/** Build an ALLOW row for every role in a list. */
function allow(resource: string, action: string, roles: readonly Role[], reason: string): MatrixCell[] {
  return roles.map((role) => ({ resource, action, role, decision: 'ALLOW', reason }));
}

/** The matrix. Cells not present are DENY. */
export const MATRIX: readonly MatrixCell[] = Object.freeze([
  // §5's per-route grants, in the terms the routes use.
  ...allow('subject', 'read', ['SUBJECT_USER', 'GUARDIAN', 'OPERATOR', 'TENANT_ADMIN', 'AUDITOR', 'COUNSEL_REVIEWER', 'SUPPORT'], 'vg.subjects.read'),
  ...allow('subject', 'write', ['SUBJECT_USER', 'GUARDIAN', 'TENANT_ADMIN'], 'vg.subjects.write'),
  ...allow('authority_grant', 'read', ['TENANT_ADMIN', 'AUDITOR', 'COUNSEL_REVIEWER', 'OPERATOR'], 'vg.authority.read'),
  ...allow('authority_grant', 'write', ['TENANT_ADMIN', 'SUBJECT_USER', 'GUARDIAN'], 'vg.authority.write, with minting subject to separation of duties'),
  ...allow('authority_grant', 'revoke', ['TENANT_ADMIN', 'SUBJECT_USER', 'GUARDIAN'], 'vg.authority.write permits revocation'),
  ...allow('source', 'read', ['OPERATOR', 'TENANT_ADMIN', 'AUDITOR', 'COUNSEL_REVIEWER'], 'vg.sources.read'),
  ...allow('source', 'write', ['TENANT_ADMIN'], 'vg.sources.write'),
  ...allow('recipe', 'write', ['TENANT_ADMIN'], 'vg.recipes.write, signed only'),
  ...allow('discovery_run', 'read', ['SUBJECT_USER', 'GUARDIAN', 'OPERATOR', 'TENANT_ADMIN', 'AUDITOR'], 'vg.discovery.read'),
  ...allow('discovery_run', 'run', ['SUBJECT_USER', 'GUARDIAN', 'OPERATOR', 'TENANT_ADMIN'], 'vg.discovery.run, read-only by default'),
  ...allow('exposure', 'read', ['SUBJECT_USER', 'GUARDIAN', 'OPERATOR', 'TENANT_ADMIN', 'AUDITOR', 'COUNSEL_REVIEWER'], 'vg.exposures.read'),
  ...allow('exposure', 'assess', ['OPERATOR', 'TENANT_ADMIN'], 'vg.exposures.assess'),
  ...allow('policy', 'read', ['OPERATOR', 'TENANT_ADMIN', 'AUDITOR', 'COUNSEL_REVIEWER'], 'vg.policy.read'),
  ...allow('policy', 'write', ['TENANT_ADMIN'], 'vg.policy.write, versioned data only'),
  ...allow('case', 'read', ['SUBJECT_USER', 'GUARDIAN', 'OPERATOR', 'TENANT_ADMIN', 'AUDITOR', 'COUNSEL_REVIEWER', 'SUPPORT'], 'vg.cases.read'),
  ...allow('case', 'write', ['OPERATOR', 'TENANT_ADMIN'], 'vg.cases.write'),
  ...allow('action', 'execute', ['OPERATOR', 'TENANT_ADMIN'], 'vg.actions.execute, gated by VG-AUTHZ-015'),
  ...allow('action', 'read', ['OPERATOR', 'TENANT_ADMIN', 'AUDITOR', 'COUNSEL_REVIEWER'], 'vg.actions.read'),
  ...allow('observation', 'write', ['OPERATOR', 'TENANT_ADMIN'], 'vg.observations.write'),
  ...allow('observation', 'read', ['OPERATOR', 'TENANT_ADMIN', 'AUDITOR', 'COUNSEL_REVIEWER'], 'vg.observations.read'),
  ...allow('evidence', 'read', ['SUBJECT_USER', 'GUARDIAN', 'OPERATOR', 'TENANT_ADMIN', 'AUDITOR', 'COUNSEL_REVIEWER'], 'vg.evidence.read'),
  ...allow('evidence', 'export', ['OPERATOR', 'TENANT_ADMIN', 'AUDITOR', 'COUNSEL_REVIEWER'], 'vg.evidence.read_content, step-up gated'),
  ...allow('evidence', 'write', ['OPERATOR', 'TENANT_ADMIN'], 'vg.evidence.write'),
  ...allow('appeal', 'write', ['COUNSEL_REVIEWER'], 'vg.appeal.write, step-up gated'),
  ...allow('audit_event', 'read', ['AUDITOR', 'TENANT_ADMIN', 'SUBJECT_USER', 'GUARDIAN'], 'vg.audit.read; OPERATOR is case-scoped only'),
  ...allow('coverage', 'read', ['OPERATOR', 'TENANT_ADMIN', 'AUDITOR'], 'vg.coverage.read'),

  // §2's prohibitions, encoded as rows so a route cannot forget them.
  { resource: 'audit_event', action: 'delete', role: 'TENANT_ADMIN', decision: 'DENY', reason: 'SPEC-005 §2: TENANT_ADMIN may not disable audit' },
  { resource: 'audit_event', action: 'delete', role: 'OPERATOR', decision: 'DENY', reason: 'SPEC-005 §2: OPERATOR may not delete audit' },
  { resource: 'evidence', action: 'delete', role: 'AUDITOR', decision: 'DENY', reason: 'SPEC-005 §2: AUDITOR may not perform any write or state transition' },
  { resource: 'evidence', action: 'delete', role: 'OPERATOR', decision: 'DENY', reason: 'evidence is append-only: no role deletes an artefact (VG-EVIDENCE-003)' },
  { resource: 'evidence', action: 'delete', role: 'TENANT_ADMIN', decision: 'DENY', reason: 'evidence is append-only: no role deletes an artefact (VG-EVIDENCE-003)' },
  { resource: 'evidence', action: 'write', role: 'AUDITOR', decision: 'DENY', reason: 'SPEC-005 §2: AUDITOR may not perform any write' },
  { resource: 'case', action: 'write', role: 'AUDITOR', decision: 'DENY', reason: 'SPEC-005 §2: AUDITOR may not perform any state transition' },
  { resource: 'authority_grant', action: 'write', role: 'OPERATOR', decision: 'DENY', reason: 'SPEC-005 §2: OPERATOR may not mint AuthorityGrant' },
  { resource: 'policy', action: 'write', role: 'OPERATOR', decision: 'DENY', reason: 'SPEC-005 §2: OPERATOR may not change jurisdiction policy' },
  { resource: 'subject', action: 'write', role: 'OPERATOR', decision: 'DENY', reason: 'SPEC-005 §2: an operator works cases and does not edit the subject record' },
  { resource: 'subject', action: 'write', role: 'AUDITOR', decision: 'DENY', reason: 'SPEC-005 §2: AUDITOR may not perform any write' },
  { resource: 'action', action: 'execute', role: 'AUDITOR', decision: 'DENY', reason: 'SPEC-005 §2: AUDITOR may not perform any state transition' },
  { resource: 'action', action: 'execute', role: 'COUNSEL_REVIEWER', decision: 'DENY', reason: 'SPEC-005 §2: COUNSEL_REVIEWER may not trigger actions directly' },
  { resource: 'appeal', action: 'write', role: 'OPERATOR', decision: 'DENY', reason: 'SPEC-005 §2: OPERATOR may not approve escalation packets' },
  { resource: 'identifier', action: 'reveal', role: 'TENANT_ADMIN', decision: 'DENY', reason: 'vg.pii.reveal is granted per SPEC-005 §2 SUPPORT rules and never standing' },
  { resource: 'identifier', action: 'reveal', role: 'OPERATOR', decision: 'DENY', reason: 'vg.pii.reveal is never a standing role grant' },
  { resource: 'identifier', action: 'reveal', role: 'AUDITOR', decision: 'DENY', reason: 'vg.pii.reveal is never a standing role grant' },
  { resource: 'identifier', action: 'reveal', role: 'SUPPORT', decision: 'DENY', reason: 'SPEC-005 §2: SUPPORT may not have bulk PII access, and reveal is granted just-in-time per case' },
  // THE TWO ROLES WHOSE §2 PROHIBITIONS ARE NOT ABOUT A RESOURCE THEY ADMINISTER. MEASURED: the first version of this
  // matrix had no DENY row for SUBJECT_USER or GUARDIAN, and the suite's prohibition check failed for both - a role with a
  // prohibition sentence and no row is a prohibition the decision function cannot apply.
  { resource: 'authority_grant', action: 'approve', role: 'SUBJECT_USER', decision: 'DENY', reason: 'SPEC-005 §2: a subject may not approve agent authority for themselves' },
  { resource: 'authority_grant', action: 'approve', role: 'GUARDIAN', decision: 'DENY', reason: 'SPEC-005 §2: a guardian may not bypass the minor strict lane by approving authority' },
  { resource: 'authority_grant', action: 'approve', role: 'OPERATOR', decision: 'DENY', reason: 'SPEC-005 §2: an operator may not mint or approve authority' },
  { resource: 'identifier', action: 'reveal', role: 'SUBJECT_USER', decision: 'DENY', reason: 'vg.pii.reveal is never standing, and a subject receives their own values through the subject read, not through reveal' },
  { resource: 'identifier', action: 'reveal', role: 'GUARDIAN', decision: 'DENY', reason: 'vg.pii.reveal is never standing, and a guardian sees the minor’s values through the minor’s own record' },
  { resource: 'subject', action: 'read', role: 'SUPPORT', decision: 'ALLOW', reason: 'vg.subjects.read, but only within an active JIT grant (ROLE-2)' },
  ...allow('case', 'read', ['SUPPORT'], 'vg.cases.read, but only within an active JIT grant (ROLE-2)'),
]);

/**
 * The matrix cells this node does NOT yet encode, named so a reader sees the boundary. Every one of them is `DENY` by
 * the default rule, so an uncovered cell fails closed rather than open.
 */
export const MATRIX_GAPS: readonly string[] = Object.freeze([
  'SPEC-005 §5 rows for resources this node does not yet serve: every one of them is DENY by the default rule, so a gap fails closed rather than open',
  'the OPERATOR case-scoped vg.audit.read narrowing: the matrix grants AUDITOR and TENANT_ADMIN broadly, and the OPERATOR narrowing is enforced by the case scope rather than by this table - DENY is not the answer here, because the scope IS granted and the narrowing is a scope question',
]);

export interface AuthorizationQuery {
  readonly role: string;
  readonly resource: string;
  readonly action: string;
  /** The tenant the caller is acting in. */
  readonly tenantId: string;
  /** The tenant the resource belongs to. ABSENT means the caller did not say, which is not the same as same-tenant. */
  readonly resourceTenantId: string | undefined;
}

export interface AuthorizationDecision {
  readonly decision: Decision;
  readonly reason: string;
  /** The wire code the HTTP layer uses for a refusal. */
  readonly code?: 'INSUFFICIENT_ROLE' | 'INSUFFICIENT_SCOPE' | 'RESOURCE_NOT_FOUND' | 'SEPARATION_OF_DUTIES_REQUIRED';
}

/**
 * Decide one request.
 *
 * THE ORDER OF THE CHECKS IS THE ORDER OF THE CODES, and cross-tenant comes first: a caller asking about another
 * tenant's resource must not learn whether the resource exists, so the answer is a refusal that does not distinguish
 * "not yours" from "not there" beyond the code the specification fixes.
 */
export function authorize(query: AuthorizationQuery): AuthorizationDecision {
  if (!MATRIX_RESOURCES.includes(query.resource)) {
    return { decision: 'DENY', reason: `resource "${query.resource}" is not in the matrix, and an unlisted resource is refused`, code: 'RESOURCE_NOT_FOUND' };
  }
  if (!MATRIX_ACTIONS.includes(query.action)) {
    return { decision: 'DENY', reason: `action "${query.action}" is not in the matrix, and an unlisted action is refused`, code: 'RESOURCE_NOT_FOUND' };
  }
  if (query.resourceTenantId === undefined) {
    // ABSENT IS NOT SAME-TENANT. A caller that did not resolve the resource's tenant has not established that it is
    // theirs, and treating an absent value as a match is how a cross-tenant read becomes reachable by omission.
    return { decision: 'DENY', reason: 'the resource tenant was not resolved, so the request cannot be shown to be same-tenant', code: 'RESOURCE_NOT_FOUND' };
  }
  if (query.resourceTenantId !== query.tenantId) {
    return { decision: 'DENY', reason: 'the resource belongs to another tenant', code: 'RESOURCE_NOT_FOUND' };
  }
  const cell = MATRIX.find(
    (candidate) => candidate.resource === query.resource && candidate.action === query.action && candidate.role === query.role,
  );
  if (cell === undefined) {
    return {
      decision: 'DENY',
      reason: `no cell grants ${query.role} "${query.action}" on "${query.resource}": the default is DENY`,
      code: 'INSUFFICIENT_ROLE',
    };
  }
  return { decision: cell.decision, reason: cell.reason, ...(cell.decision === 'DENY' ? { code: 'INSUFFICIENT_ROLE' as const } : {}) };
}

/**
 * Separation of duties for an authority grant (SPEC-005 VG-AUTH-023): the person who mints a grant may not be the person
 * it names.
 *
 * IT IS A SEPARATE FUNCTION BECAUSE IT IS A DIFFERENT QUESTION: the matrix says whether a role may write a grant, and this
 * says whether THIS actor may write THIS grant. Folding the two together is how a self-approval check gets lost in a
 * refactor of the matrix.
 */
export function assertSeparationOfDuties(actingPrincipal: string, grantSubjectRef: string): AuthorizationDecision {
  if (actingPrincipal === grantSubjectRef) {
    return {
      decision: 'DENY',
      reason: 'the acting principal is the person the grant names: SPEC-005 VG-AUTH-023 requires a second person to mint authority',
      code: 'SEPARATION_OF_DUTIES_REQUIRED',
    };
  }
  return { decision: 'ALLOW', reason: 'the acting principal is not the grant subject' };
}

