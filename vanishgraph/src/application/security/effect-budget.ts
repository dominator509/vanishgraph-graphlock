/**
 * Agent effect budgets (SPEC-005 §7 VG-AUTH-007/009; SPEC-006 §7.1 row 20; EP-006 M7).
 *
 * FOUR CEILINGS AND ONE AUTHORITY. The domain's per-subject/source/window write budget is AUTHORITATIVE; the per-token,
 * per-subject and per-source ceilings here are ADDITIONAL. Nothing in this module may report that the domain's budget is
 * available, and nothing here raises a ceiling: there is no override and no parameter that does.
 *
 * UNREADABLE BUDGET STATE IS EXHAUSTED (SPEC-006 §7.1 row 20). A budget store that cannot be read is the one moment the
 * ceiling matters most, so the failure direction is refusal — which is also why the read is modelled as returning
 * `undefined` rather than throwing.
 *
 * EXHAUSTION NAMES THE DIMENSION, so the caller learns which ceiling stopped it and can say so in the refusal: a bare
 * "budget exceeded" leaves an operator guessing between four limits.
 */

export type BudgetDimension = 'per-token' | 'per-subject' | 'per-source' | 'domain-write';

export interface BudgetCeiling {
  readonly dimension: BudgetDimension;
  readonly limit: number;
  readonly windowSeconds: number;
}

/** The ceilings this layer enforces. The domain budget is deliberately absent: it is not ours to read or to raise. */
export const AGENT_BUDGET_CEILINGS: readonly BudgetCeiling[] = Object.freeze([
  { dimension: 'per-token', limit: 200, windowSeconds: 3600 },
  { dimension: 'per-subject', limit: 50, windowSeconds: 3600 },
  { dimension: 'per-source', limit: 20, windowSeconds: 3600 },
]);

/** A budget reader. `undefined` means the state could not be read, which is EXHAUSTED rather than unlimited. */
export type BudgetReader = (dimension: BudgetDimension, key: string) => number | undefined;

export interface BudgetQuery {
  readonly tokenIdentity: string;
  readonly subjectRef: string;
  readonly sourceId: string;
}

export interface BudgetDecision {
  readonly allow: boolean;
  readonly code?: 'EFFECT_BUDGET_EXCEEDED' | 'DEPENDENCY_UNAVAILABLE';
  readonly dimension?: BudgetDimension;
  readonly limit?: number;
  /** `| undefined` because `exactOptionalPropertyTypes` is on and the exhausted dimension's usage can be unreadable. */
  readonly usage?: number | undefined;
  readonly windowSeconds?: number;
  readonly detail: string;
}

/**
 * Check every additional ceiling.
 *
 * THE MOST-EXHAUSTED DIMENSION IS REPORTED FIRST so the answer is stable rather than dependent on iteration order: two
 * runs with the same state must name the same ceiling, and a caller that sees a different dimension each time cannot
 * build a reliable refusal message.
 */
export function checkAgentBudget(query: BudgetQuery, reader: BudgetReader): BudgetDecision {
  const measurements: { readonly ceiling: BudgetCeiling; readonly usage: number | undefined; readonly key: string }[] = AGENT_BUDGET_CEILINGS.map(
    (ceiling) => ({
      ceiling,
      usage: reader(ceiling.dimension, keyFor(ceiling.dimension, query)),
      key: keyFor(ceiling.dimension, query),
    }),
  );

  const unreadable = measurements.find((measurement) => measurement.usage === undefined);
  if (unreadable !== undefined) {
    return {
      allow: false,
      code: 'DEPENDENCY_UNAVAILABLE',
      dimension: unreadable.ceiling.dimension,
      limit: unreadable.ceiling.limit,
      windowSeconds: unreadable.ceiling.windowSeconds,
      detail: `the ${unreadable.ceiling.dimension} budget state could not be read, and unreadable budget state is treated as exhausted (SPEC-006 §7.1 row 20)`,
    };
  }

  const exhausted = measurements
    .filter((measurement) => (measurement.usage ?? 0) >= measurement.ceiling.limit)
    .sort((left, right) => right.ceiling.limit - left.ceiling.limit);
  if (exhausted.length > 0) {
    const worst = exhausted[0];
    if (worst !== undefined) {
      return {
        allow: false,
        code: 'EFFECT_BUDGET_EXCEEDED',
        dimension: worst.ceiling.dimension,
        limit: worst.ceiling.limit,
        usage: worst.usage,
        windowSeconds: worst.ceiling.windowSeconds,
        detail: `${worst.ceiling.dimension} is at ${String(worst.usage)} of ${String(worst.ceiling.limit)} in a ${String(worst.ceiling.windowSeconds)}-second window`,
      };
    }
  }
  return { allow: true, detail: 'every additional ceiling has room' };
}

function keyFor(dimension: BudgetDimension, query: BudgetQuery): string {
  if (dimension === 'per-token') return `token:${query.tokenIdentity}`;
  if (dimension === 'per-subject') return `subject:${query.subjectRef}`;
  return `source:${query.sourceId}`;
}

/**
 * The domain's write budget, as a value the caller must present. This module does not read it and cannot raise it; it
 * exists here so a caller that wants to skip the domain check has nothing to call.
 */
export function domainBudgetIsAuthoritative(): string {
  return 'the domain’s per-subject/source/window write budget is authoritative (VG-ACTION-005); this layer is an additional ceiling and never a substitute';
}

/** A loop cap: the number of calls one agent loop may make, whatever the ceilings say. */
export const AGENT_LOOP_CALL_CAP = 50;

export interface LoopState {
  readonly callsMade: number;
}

export function checkLoopCap(state: LoopState): { readonly allow: boolean; readonly detail: string } {
  if (state.callsMade >= AGENT_LOOP_CALL_CAP) {
    return {
      allow: false,
      detail: `the agent loop has made ${String(state.callsMade)} calls, at its cap of ${String(AGENT_LOOP_CALL_CAP)}: further calls are refused`,
    };
  }
  return { allow: true, detail: `${String(AGENT_LOOP_CALL_CAP - state.callsMade)} calls remain in this loop` };
}
