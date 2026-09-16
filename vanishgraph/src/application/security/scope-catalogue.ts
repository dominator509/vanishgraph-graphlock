/**
 * The closed `/v1` scope vocabulary (SPEC-003 §3.3; EP-006 M1).
 *
 * TRANSCRIBED FROM THE SPECIFICATION'S TABLE, and `tests/contract/scope-catalogue.test.ts` PARSES that table and asserts
 * set equality in both directions — a scope added here without a specification row fails, and a row with no scope here
 * fails. A hand-maintained list that nothing compares against the contract is a list that drifts.
 *
 * TWO THINGS THE PLAN SAID THAT THE SPECIFICATION CONTRADICTS, MEASURED AND RECORDED RATHER THAN QUIETLY FOLLOWED:
 *
 *   1. The plan asks for "the four 'service token must not hold' scopes". SPEC-003 §3.2 item 9 names **seven**:
 *      `vg.authority.write`, `vg.policy.write`, `vg.appeal.write`, `vg.actions.execute`, `vg.audit.read`,
 *      `vg.pii.reveal` and `vg.evidence.read_content`. The specification wins, the set below is the seven, and the
 *      suite asserts the count against the parsed sentence so a later edit to either side is visible.
 *   2. The plan asks for "the five role bundles from SPEC-003 §3.3". §3.3 declares no bundles: it is a scope table with
 *      a "Roles that may carry it" column. The bundles in `role-bundles.ts` are therefore DERIVED from that column (and
 *      the test derives them the same way and asserts equality), which is stronger than transcribing a list that does
 *      not exist in the document.
 */

/** The scopes, in the specification's own order. */
export const SCOPES: readonly string[] = Object.freeze([
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
  'vg.appeal.write',
  'vg.audit.read',
  'vg.coverage.read',
  'vg.pii.reveal',
]);

/**
 * The scopes a machine token must never hold (SPEC-003 §3.2 item 9). SEVEN, not the four the plan names.
 *
 * The webhook ingress scope is not here because it is not a scope at all: §3.3 states it is "deliberately absent from
 * this table", and `assertNotIngestScope` below is what enforces that rather than a comment.
 */
export const MACHINE_FORBIDDEN_SCOPES: readonly string[] = Object.freeze([
  'vg.authority.write',
  'vg.policy.write',
  'vg.appeal.write',
  'vg.actions.execute',
  'vg.audit.read',
  'vg.pii.reveal',
  'vg.evidence.read_content',
]);

/** The ingress scope that must never appear in a caller token (SPEC-003 §3.3). */
export const INGEST_SCOPE = 'vg.webhooks.ingest';

const SCOPE_SET = new Set(SCOPES);

/** Whether a value is one of the closed vocabulary's scopes. */
export function isScope(value: string): boolean {
  return SCOPE_SET.has(value);
}

/** A wildcard scope value is `401 TOKEN_SCOPE_WILDCARD_FORBIDDEN` (SPEC-003 §3.2 item 9). Refused, never expanded. */
export function assertNoWildcard(scope: string): void {
  if (scope.includes('*')) {
    throw new Error(
      `scope "${scope}" contains a wildcard: SPEC-003 §3.2 item 9 refuses a wildcard scope value outright rather than expanding it`,
    );
  }
}

/** Refuse the ingress scope anywhere a caller could present it (SPEC-003 §3.3). */
export function assertNotIngestScope(scope: string): void {
  if (scope === INGEST_SCOPE) {
    throw new Error(
      `${INGEST_SCOPE} is not a caller-issued scope: webhook ingress is authenticated by signature and capability token, and a token carrying it could forge ingress`,
    );
  }
}

/** Whether a machine token may hold a scope. */
export function machineMayHold(scope: string): boolean {
  return isScope(scope) && !MACHINE_FORBIDDEN_SCOPES.includes(scope);
}

/** A bundle containing a scope outside the closed vocabulary is a defect, and this is where it is caught. */
export function assertBundleWithinCatalogue(bundleName: string, scopes: readonly string[]): void {
  for (const scope of scopes) {
    assertNoWildcard(scope);
    assertNotIngestScope(scope);
    if (!isScope(scope)) {
      throw new Error(`bundle ${bundleName} carries "${scope}", which is not in the SPEC-003 §3.3 scope vocabulary`);
    }
  }
}
