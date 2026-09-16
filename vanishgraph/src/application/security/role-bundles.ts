/**
 * The seven human roles and their scope bundles (SPEC-005 §2; SPEC-003 §3.3; EP-006 M1).
 *
 * EACH BUNDLE CARRIES ITS PROHIBITION BESIDE IT. SPEC-005 §2 has a "Notably may **not**" column, and a role definition
 * that keeps only the grants loses the sentence that stops an implementer widening it later. The `mayNot` field is that
 * sentence transcribed, and the M1 suite asserts it is non-empty for every role and matches the specification's column.
 *
 * THE BUNDLES ARE DERIVED FROM SPEC-003 §3.3's "Roles that may carry it" COLUMN, not invented here, and the suite
 * derives them the same way from the parsed table and asserts equality. Where the specification attaches a condition to
 * a role's scope (TENANT_ADMIN may mint authority "subject to separation of duties"), the condition is carried in
 * `conditions` rather than dropped: a bundle that silently turned a conditional grant into an unconditional one would
 * widen the role, which §3.3 forbids in its first paragraph.
 */

import { assertBundleWithinCatalogue } from './scope-catalogue.ts';

export type Role =
  | 'SUBJECT_USER'
  | 'GUARDIAN'
  | 'OPERATOR'
  | 'TENANT_ADMIN'
  | 'AUDITOR'
  | 'SUPPORT'
  | 'COUNSEL_REVIEWER';

export interface RoleBundle {
  readonly role: Role;
  readonly purpose: string;
  /** The scopes the role may carry, derived from SPEC-003 §3.3. */
  readonly scopes: readonly string[];
  /** The specification's own prohibition sentence for this role (SPEC-005 §2). */
  readonly mayNot: string;
  /** Conditions the specification attaches to a grant in this bundle. */
  readonly conditions?: readonly string[];
}

const ROLES: readonly Role[] = [
  'SUBJECT_USER',
  'GUARDIAN',
  'OPERATOR',
  'TENANT_ADMIN',
  'AUDITOR',
  'SUPPORT',
  'COUNSEL_REVIEWER',
];

/** True when a role is one of the seven. */
export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** The scope bundle for each role, derived from §3.3's role column. */
export const ROLE_BUNDLES: Readonly<Record<Role, RoleBundle>> = Object.freeze({
  SUBJECT_USER: {
    role: 'SUBJECT_USER',
    purpose: 'The verified subject managing their own exposure.',
    scopes: [
      'vg.subjects.read',
      'vg.subjects.write',
      'vg.authority.write',
      'vg.discovery.read',
      'vg.discovery.run',
      'vg.exposures.read',
      'vg.cases.read',
      'vg.evidence.read',
      'vg.audit.read',
    ],
    mayNot: 'Act for another subject; view other tenants; approve agent authority.',
    conditions: ['Every subject-scoped grant is confined to the subject’s own records (SPEC-005 §2, §3).'],
  },
  GUARDIAN: {
    role: 'GUARDIAN',
    purpose: 'Parent/guardian acting for a minor subject.',
    scopes: [
      'vg.subjects.read',
      'vg.subjects.write',
      'vg.authority.write',
      'vg.discovery.read',
      'vg.discovery.run',
      'vg.exposures.read',
      'vg.cases.read',
      'vg.evidence.read',
      'vg.audit.read',
    ],
    mayNot: 'Act for adults; bypass the minor strict lane.',
    conditions: ['Confined to the minor subject’s records, and the minor strict lane is not bypassable.'],
  },
  OPERATOR: {
    role: 'OPERATOR',
    purpose: 'Case worker in the operations console.',
    scopes: [
      'vg.subjects.read',
      'vg.authority.read',
      'vg.sources.read',
      'vg.discovery.read',
      'vg.discovery.run',
      'vg.exposures.read',
      'vg.exposures.assess',
      'vg.policy.read',
      'vg.cases.read',
      'vg.cases.write',
      'vg.actions.execute',
      'vg.actions.read',
      'vg.observations.write',
      'vg.observations.read',
      'vg.evidence.read',
      'vg.evidence.read_content',
      'vg.evidence.write',
      'vg.audit.read',
      'vg.coverage.read',
    ],
    mayNot: 'Change jurisdiction policy; mint `AuthorityGrant`; delete audit.',
    conditions: ['`vg.actions.execute` is gated by VG-AUTHZ-015: grant + decision + recipe + budget.'],
  },
  TENANT_ADMIN: {
    role: 'TENANT_ADMIN',
    purpose: 'Tenant configuration, users, sources, recipes.',
    scopes: [
      'vg.subjects.read',
      'vg.subjects.write',
      'vg.authority.read',
      'vg.authority.write',
      'vg.sources.read',
      'vg.sources.write',
      'vg.recipes.write',
      'vg.discovery.read',
      'vg.discovery.run',
      'vg.exposures.read',
      'vg.exposures.assess',
      'vg.policy.read',
      'vg.policy.write',
      'vg.cases.read',
      'vg.cases.write',
      'vg.actions.execute',
      'vg.actions.read',
      'vg.observations.write',
      'vg.observations.read',
      'vg.evidence.read',
      'vg.evidence.read_content',
      'vg.evidence.write',
      'vg.audit.read',
      'vg.coverage.read',
    ],
    mayNot: 'Read another tenant; bypass RLS; disable audit; self-approve agent authority.',
    conditions: [
      '`vg.authority.write` covers revocation, and minting is subject to separation of duties.',
      '`vg.actions.execute` is gated by VG-AUTHZ-015: grant + decision + recipe + budget.',
    ],
  },
  AUDITOR: {
    role: 'AUDITOR',
    purpose: 'Read-only access to cases, evidence, and audit.',
    scopes: [
      'vg.subjects.read',
      'vg.authority.read',
      'vg.sources.read',
      'vg.discovery.read',
      'vg.exposures.read',
      'vg.policy.read',
      'vg.cases.read',
      'vg.actions.read',
      'vg.observations.read',
      'vg.evidence.read',
      'vg.evidence.read_content',
      'vg.audit.read',
      'vg.coverage.read',
    ],
    mayNot: 'Any write; any state transition.',
    conditions: [
      '`vg.evidence.read_content` IS in this bundle: SPEC-003 §3.3’s role column grants it to AUDITOR and the scope itself is step-up gated. MEASURED: the first version of this bundle omitted it on the strength of §2’s "Any write" prohibition, and the derivation assertion failed — reading content is not a write, and the specification’s table wins.',
    ],
  },
  SUPPORT: {
    role: 'SUPPORT',
    purpose: 'Time-boxed, JIT, break-glass diagnostics.',
    scopes: ['vg.subjects.read', 'vg.cases.read'],
    mayNot: 'Bulk PII access; write actions; presence without an active grant.',
    conditions: [
      'Just-in-time, time-boxed (≤60 minutes), scoped to one tenant, reason string required, MFA+step-up gated, audited on entry, on every read of PII-class data, and on exit.',
      '`vg.pii.reveal` is never a standing grant: it is granted explicitly per SPEC-005 §2 and never to a machine token.',
    ],
  },
  COUNSEL_REVIEWER: {
    role: 'COUNSEL_REVIEWER',
    purpose: 'Approve escalation/regulator packets.',
    scopes: [
      'vg.subjects.read',
      'vg.authority.read',
      'vg.sources.read',
      'vg.exposures.read',
      'vg.policy.read',
      'vg.cases.read',
      'vg.actions.read',
      'vg.observations.read',
      'vg.evidence.read',
      'vg.evidence.read_content',
      'vg.appeal.write',
    ],
    mayNot: 'Trigger actions directly; alter evidence.',
    conditions: ['`vg.appeal.write` also requires step-up (SPEC-003 §3.3).'],
  },
});

/** Every role's bundle, validated against the closed vocabulary. Throws at import time on a defect rather than serving. */
export function validatedBundles(): readonly RoleBundle[] {
  return ROLES.map((role) => {
    const bundle = ROLE_BUNDLES[role];
    assertBundleWithinCatalogue(role, bundle.scopes);
    if (bundle.mayNot.trim().length === 0) {
      throw new Error(`role ${role} has no mayNot sentence: SPEC-005 §2 states a prohibition for every role`);
    }
    return bundle;
  });
}

/** The scopes a role may carry. */
export function scopesForRole(role: Role): readonly string[] {
  return ROLE_BUNDLES[role].scopes;
}
