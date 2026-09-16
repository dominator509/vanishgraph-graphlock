/**
 * Step-up authentication policy for the six sensitive operation classes (SPEC-005 §6 VG-AUTH-005, §4; SPEC-003 §3.2 item
 * 6; EP-006 M5).
 *
 * THE CLASSES ARE DATA, AND THE POLICY IS A REFUSAL. There is no branch here that lowers a required level, retries at a
 * lower level, or treats a stale `authTime` as acceptable — the three ways a step-up check is usually weakened. A missing
 * or stale step-up is `STEP_UP_REQUIRED`, which is `403`.
 *
 * FRESHNESS IS ESTABLISHED FROM THE INJECTED CLOCK AND NEVER FROM THE PROCESS WALL CLOCK (SPEC-006 §7.1 row 24). That is
 * not tidiness: a check that read `Date.now()` would report a fresh step-up on a machine whose clock is wrong, and the
 * whole point of a freshness window is that the re-authentication happened recently. When the clock is unavailable,
 * freshness CANNOT be established, so the operation is refused — the stricter posture the plan's fallback also names.
 */

/** The `acr` a step-up must present. The single value the deployment is built for; the realm registers it. */
export const STEP_UP_ACR = 'urn:vg:loa:step-up';

/** The freshness window: a step-up older than this is stale. */
export const STEP_UP_WINDOW_SECONDS = 5 * 60;

/** The six classes. Each names the operation it gates, in the specification's terms. */
export type StepUpClass =
  | 'AUTHORITY_GRANT_MINT_OR_EXPAND'
  | 'EXTERNAL_WRITE_EXECUTE_OR_AUTHORISE'
  | 'CERTIFIED_MAIL_GENERATE'
  | 'ESCALATION_OR_REGULATOR_PACKET_APPROVE'
  | 'SUPPORT_BREAK_GLASS_ENTER'
  | 'TENANT_POLICY_SOURCE_RECIPE_CHANGE';

export interface StepUpRule {
  readonly stepUpClass: StepUpClass;
  readonly requires: string;
  readonly detail: string;
  /** The SPEC-003 §3.2 item 6 phrase this class answers to, so the mechanical match has something to compare. */
  readonly wirePhrase: string;
}

/**
 * The declared classes.
 *
 * SPEC-003 §3.2 item 6 names five operations (evidence content download, identifier reveal, authority-grant creation and
 * revocation, external action execution, appeal/escalation creation) and SPEC-005 §6 adds the `SUPPORT` break-glass and
 * tenant-policy classes. THE TWO SETS DO NOT LINE UP ONE FOR ONE — "creation and revocation" is one wire phrase covering
 * one class here, and "evidence content download" and "identifier reveal" are two operations that share the
 * `EXTERNAL_WRITE`-class machinery — so the mapping is recorded per class and asserted rather than assumed. A mismatch is
 * fixed by amending this implementation, never the specification.
 */
export const STEP_UP_CLASSES: readonly StepUpRule[] = Object.freeze([
  {
    stepUpClass: 'AUTHORITY_GRANT_MINT_OR_EXPAND',
    requires: STEP_UP_ACR,
    detail: 'minting or expanding an AuthorityGrant',
    wirePhrase: 'authority-grant creation and revocation',
  },
  {
    stepUpClass: 'EXTERNAL_WRITE_EXECUTE_OR_AUTHORISE',
    requires: STEP_UP_ACR,
    detail: 'executing or authorising a write to the outside world',
    // ONE CLASS, THREE ITEM-6 OPERATIONS, AND THE GROUPING IS A RECORDED DECISION RATHER THAN AN OVERSIGHT: SPEC-003
    // 3.2 item 6 names evidence content download, identifier reveal and external action execution as three operations
    // requiring step-up, while SPEC-005 6 declares one class for the sensitive-effect family. MEASURED: the mechanical
    // match failed for the first two phrases until they were claimed here, and the fix is in the implementation, which is
    // where the plan puts it.
    wirePhrase: 'evidence content download, identifier reveal, external action execution',
  },
  {
    stepUpClass: 'CERTIFIED_MAIL_GENERATE',
    requires: STEP_UP_ACR,
    detail: 'generating a certified mail piece',
    wirePhrase: 'certified mail generation (SPEC-005 §6)',
  },
  {
    stepUpClass: 'ESCALATION_OR_REGULATOR_PACKET_APPROVE',
    requires: STEP_UP_ACR,
    detail: 'approving an appeal or regulator packet',
    wirePhrase: 'appeal/escalation creation',
  },
  {
    stepUpClass: 'SUPPORT_BREAK_GLASS_ENTER',
    requires: STEP_UP_ACR,
    detail: 'entering the SUPPORT break-glass path (just-in-time, ≤60 minutes)',
    wirePhrase: 'SUPPORT break-glass entry (SPEC-005 §6)',
  },
  {
    stepUpClass: 'TENANT_POLICY_SOURCE_RECIPE_CHANGE',
    requires: STEP_UP_ACR,
    detail: 'changing tenant policy, a source, or a recipe',
    wirePhrase: 'tenant policy/source/recipe change (SPEC-005 §6)',
  },
]);

/** The class for an operation, or `undefined` when the operation is not one of the six. */
export function stepUpClassFor(stepUpClass: string): StepUpRule | undefined {
  return STEP_UP_CLASSES.find((rule) => rule.stepUpClass === stepUpClass);
}

/** The clock the freshness check must use. Returning `undefined` means the time cannot be established. */
export type Clock = () => number | undefined;

export interface StepUpEvidence {
  /** The `acr` the session presented, or `undefined` when it presented none. */
  readonly acr: string | undefined;
  /** When the session last re-authenticated, in epoch seconds, or `undefined` when it did not say. */
  readonly authTime: number | undefined;
  /** Whether a re-authentication event was explicitly recorded (the fallback posture records one). */
  readonly reauthenticationRecorded?: boolean | undefined;
}

export interface StepUpDecision {
  readonly ok: boolean;
  readonly code?: 'STEP_UP_REQUIRED' | 'DEPENDENCY_UNAVAILABLE';
  readonly detail?: string;
  /** The audit row the caller writes on a refusal. */
  readonly audit?: {
    readonly event: 'step_up.refused';
    readonly stepUpClass: StepUpClass;
    readonly acr: string | undefined;
    readonly ageSeconds: number | null;
    readonly code: 'STEP_UP_REQUIRED' | 'DEPENDENCY_UNAVAILABLE';
    readonly at: number | null;
  };
}

/**
 * Decide whether the session satisfies the class's step-up requirement.
 *
 * THE ORDER IS THE POSTURE: the clock first (an unestablishable time refuses everything), then the `acr`, then freshness.
 * A check that measured a session's freshness with an unavailable clock would either throw or, worse, treat it as fresh.
 */
export function checkStepUp(
  stepUpClass: StepUpClass,
  evidence: StepUpEvidence,
  clock: Clock,
): StepUpDecision {
  const rule = stepUpClassFor(stepUpClass);
  if (rule === undefined) {
    // An operation with no declared class is not silently allowed: the caller asked for a class that does not exist.
    return {
      ok: false,
      code: 'STEP_UP_REQUIRED',
      detail: `"${stepUpClass}" is not one of the six declared step-up classes`,
    };
  }

  const now = clock();
  if (now === undefined) {
    return {
      ok: false,
      code: 'DEPENDENCY_UNAVAILABLE',
      detail:
        'the injected clock is unavailable, so the step-up’s freshness cannot be established and the operation is refused rather than assumed fresh (SPEC-006 §7.1 row 24)',
      audit: {
        event: 'step_up.refused',
        stepUpClass,
        acr: evidence.acr,
        ageSeconds: null,
        code: 'DEPENDENCY_UNAVAILABLE',
        at: null,
      },
    };
  }

  if (evidence.acr !== rule.requires) {
    return {
      ok: false,
      code: 'STEP_UP_REQUIRED',
      detail: `${rule.detail} requires acr ${rule.requires}; the session presented ${evidence.acr ?? 'none'}`,
      audit: { event: 'step_up.refused', stepUpClass, acr: evidence.acr, ageSeconds: null, code: 'STEP_UP_REQUIRED', at: now },
    };
  }

  if (evidence.authTime === undefined) {
    return {
      ok: false,
      code: 'STEP_UP_REQUIRED',
      detail: 'the session presented the step-up acr but no auth_time, so its freshness is unknown and it is refused',
      audit: { event: 'step_up.refused', stepUpClass, acr: evidence.acr, ageSeconds: null, code: 'STEP_UP_REQUIRED', at: now },
    };
  }

  const ageSeconds = now - evidence.authTime;
  if (ageSeconds > STEP_UP_WINDOW_SECONDS) {
    return {
      ok: false,
      code: 'STEP_UP_REQUIRED',
      detail: `the step-up is ${String(ageSeconds)} seconds old, which exceeds the ${String(STEP_UP_WINDOW_SECONDS)}-second window`,
      audit: { event: 'step_up.refused', stepUpClass, acr: evidence.acr, ageSeconds, code: 'STEP_UP_REQUIRED', at: now },
    };
  }

  // A step-up recorded in the FUTURE is refused as well: it means the token's clock and ours disagree, and accepting it
  // would make the window meaningless.
  if (ageSeconds < 0) {
    return {
      ok: false,
      code: 'STEP_UP_REQUIRED',
      detail: `the step-up is dated ${String(-ageSeconds)} seconds in the future, so the freshness window cannot be applied`,
      audit: { event: 'step_up.refused', stepUpClass, acr: evidence.acr, ageSeconds, code: 'STEP_UP_REQUIRED', at: now },
    };
  }

  return { ok: true };
}

