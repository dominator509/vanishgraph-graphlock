/**
 * Query state to region state: the one place a data region decides what it is showing (SPEC-004 §9; EP-005 M5).
 *
 * WHY THIS IS A PURE FUNCTION AND NOT A HOOK. Every surface has to answer the same question — pending, failed, empty,
 * partial, gated, or ready — and the failure mode §9 names is a screen that implements only the success path. A hook
 * would hide the decision inside a component; a pure function makes it testable without a browser, which is what
 * `tests/contract/portal-surfaces.test.ts` does for every branch, including the three that are easy to conflate:
 *
 *   * A 401 OR 403 IS ACCESS-DENIED, NOT AN ERROR (VG-UI-052). It renders the distinct state, names the role concept,
 *     and renders no data — not even a count.
 *   * A 404 IS AN EMPTY RESULT FOR A COLLECTION BUT AN ERROR FOR A SINGLE RESOURCE, and the caller says which by passing
 *     `notFound: 'empty' | 'error'`. Guessing would either hide a mistyped identifier or claim that a record the reader
 *     is not allowed to see does not exist.
 *   * A LEGITIMATE PRODUCT OUTCOME IS NEVER AN ERROR (SPEC-006 §2.1 rule 1). `HUMAN_REQUIRED` in the payload selects the
 *     human-gate state; it does not become a failure because the screen had nowhere else to put it.
 *
 * IT RETURNS AN OUTCOME RATHER THAN A FINISHED PRESENTATION, because the `ready` case needs the caller's own content:
 * the function decides WHICH state the region is in, and the route supplies what the ready or partial state contains.
 */

import { ApiError, TransportFailure } from '../../api/errors.ts';
import type { CoverageRun } from '../coverage/CoveragePanel.tsx';
import type { EmptyStateProps } from '../states/EmptyState.tsx';
import type { RegionPresentation } from '../states/Region.tsx';

/** The slice of a query result this mapping reads, so it can be called with anything query-shaped. */
export interface QueryLike<T> {
  readonly status: 'pending' | 'error' | 'success';
  readonly data?: T | undefined;
  readonly error?: unknown;
  readonly refetch?: (() => void) | undefined;
}

export type RegionOutcome<T> =
  | { readonly kind: 'presentation'; readonly state: RegionPresentation }
  | { readonly kind: 'ready'; readonly data: T }
  | { readonly kind: 'partial'; readonly data: T; readonly coverage: CoverageRun };

export interface RegionOptions<T> {
  /** The region name: the heading, the accessible name and the loading announcement. */
  readonly name: string;
  /** The box the skeleton reserves, so the layout does not move when data arrives. */
  readonly height: string;
  /** What a 404 means here: an empty collection, or an error for a single resource. */
  readonly notFound: 'empty' | 'error';
  /** Whether a successful response is legitimately empty. */
  readonly isEmpty?: (data: T) => boolean;
  /** The empty state's four required parts (VG-UI-049). Receives `undefined` for a 404-as-empty result. */
  readonly empty?: (data: T | undefined) => EmptyStateProps;
  /** The coverage the payload carries, when the surface renders a discovery-derived listing (VG-UI-050). */
  readonly coverage?: (data: T) => CoverageRun | null;
  /** The role concept an access denial names (VG-UI-052). */
  readonly requiredRole?: string;
  /** Where a denied or failed region can send the reader. */
  readonly backTo?: { readonly href: string; readonly label: string };
  /** A group in the payload that requires a person (VG-UI-053). */
  readonly humanGate?: (data: T) => {
    readonly gateKind: string;
    readonly mustAct: string;
    readonly afterAction: string;
    readonly recorded: string;
  } | null;
}

/** A read is idempotent, so a failed read may be retried; a write may not (VG-ACTION-001). */
const READ_IS_IDEMPOTENT = true;

function qualifierId(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-gate-qualifier`;
}

export function regionStateOf<T>(query: QueryLike<T>, options: RegionOptions<T>): RegionOutcome<T> {
  if (query.status === 'pending') {
    return { kind: 'presentation', state: { kind: 'loading', height: options.height } };
  }

  if (query.status === 'error') {
    const error = query.error;
    if (error instanceof ApiError && (error.httpStatus === 401 || error.httpStatus === 403)) {
      return {
        kind: 'presentation',
        state: {
          kind: 'access-denied',
          denied: {
            requiredRole: options.requiredRole ?? 'a role this account does not have for this tenant',
            backTo: options.backTo ?? { href: '/portal', label: 'Back to your portal' },
          },
        },
      };
    }
    if (error instanceof ApiError && error.httpStatus === 404 && options.notFound === 'empty' && options.empty !== undefined) {
      return { kind: 'presentation', state: { kind: 'empty', empty: options.empty(undefined) } };
    }
    return {
      kind: 'presentation',
      state: {
        kind: 'error',
        error: {
          operation: options.name,
          correlationId:
            error instanceof ApiError
              ? error.correlationId
              : error instanceof TransportFailure
                ? `no correlation identifier was returned (HTTP ${String(error.httpStatus)})`
                : 'no correlation identifier was returned',
          retry:
            query.refetch !== undefined &&
            READ_IS_IDEMPOTENT &&
            ((error instanceof ApiError && error.retryable === true) || error instanceof TransportFailure)
              ? { kind: 'idempotent', onRetry: query.refetch }
              : {
                  kind: 'not-retryable',
                  reason:
                    error instanceof ApiError
                      ? 'the API did not mark this failure as retryable'
                      : 'the failure did not come from the API, so retrying it here would not change the answer',
                },
        },
      },
    };
  }

  const data = query.data as T;
  const gate = options.humanGate?.(data) ?? null;
  if (gate !== null) {
    return {
      kind: 'presentation',
      state: { kind: 'human-gate', gate: { ...gate, qualifierId: qualifierId(options.name) } },
    };
  }
  if (options.isEmpty?.(data) === true && options.empty !== undefined) {
    return { kind: 'presentation', state: { kind: 'empty', empty: options.empty(data) } };
  }
  const coverage = options.coverage?.(data) ?? null;
  if (coverage !== null && coverage.sourcesAttempted < coverage.sourcesTotal) {
    return { kind: 'partial', data, coverage };
  }
  return { kind: 'ready', data };
}

