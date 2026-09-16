/**
 * `Region` — the one wiring point for the states every data-bearing region implements (SPEC-004 §9; EP-005 M4).
 *
 * WHY A SWITCH RATHER THAN SEVEN INDEPENDENT COMPONENTS AT SEVEN CALL SITES. VG-UI-055 requires `/console/queue` (and by
 * extension every region) to implement loading, empty, partial-coverage, error, access-denied and human-gate states; if
 * each surface chose its own way to render them, the fourth surface would implement five of the six and nobody would
 * notice. Here the state is a DISCRIMINATED UNION: a region declares which state it is in, the union carries exactly the
 * props that state needs, and a state that requires a real callback (a cancel, a refresh, a retry) cannot be selected
 * without one. `exhaustive` below makes a new state a compile error rather than a silently unhandled branch.
 *
 * THE REGION'S HEADING IS FOCUSABLE AND IS WHERE FOCUS LANDS. VG-UI-059 requires focus to move to the region heading
 * after route-level navigation and after a successful submit, so the heading carries `tabIndex={-1}`, an id derived from
 * the region name, and the `data-region-heading` hook that the browser suite asserts on. A region without a heading
 * would give focus nowhere to go, which is why `name` is required and the heading is always rendered.
 *
 * THE `ready` STATE IS PART OF THE UNION. A union of six failure-shaped states would tempt a caller to render children
 * outside the region, and the seventh case — data present — is the common one. `ready` renders the children INSIDE the
 * region element, so the boundaries of the region are the same in every state.
 */

import type { ReactNode } from 'react';

import { PartialCoverageBanner } from '../coverage/PartialCoverageBanner.tsx';
import type { CoverageRun } from '../coverage/CoveragePanel.tsx';
import { AccessDenied, type AccessDeniedProps } from './AccessDenied.tsx';
import { EmptyState, type EmptyStateProps } from './EmptyState.tsx';
import { ErrorState, type ErrorStateProps } from './ErrorState.tsx';
import { HumanGateNotice, type HumanGateNoticeProps } from './HumanGateNotice.tsx';
import {
  LoadingRegion,
  type DelayedLoadingNoticeProps,
} from './LoadingRegion.tsx';
import { SessionExpiryNotice, type SessionExpiryNoticeProps } from './SessionExpiryNotice.tsx';

export type RegionPresentation =
  | { readonly kind: 'loading'; readonly height: string; readonly delayed?: DelayedLoadingNoticeProps | undefined }
  | { readonly kind: 'ready'; readonly children: ReactNode }
  | { readonly kind: 'empty'; readonly empty: EmptyStateProps }
  | { readonly kind: 'error'; readonly error: ErrorStateProps }
  | { readonly kind: 'access-denied'; readonly denied: AccessDeniedProps }
  | { readonly kind: 'human-gate'; readonly gate: HumanGateNoticeProps }
  | { readonly kind: 'session-expiry'; readonly session: SessionExpiryNoticeProps }
  | { readonly kind: 'partial-coverage'; readonly coverage: CoverageRun; readonly children: ReactNode };

export const REGION_STATE_KINDS: readonly RegionPresentation['kind'][] = [
  'loading',
  'ready',
  'empty',
  'error',
  'access-denied',
  'human-gate',
  'session-expiry',
  'partial-coverage',
];

/** A compile-time exhaustiveness check: adding a state without a branch here does not type-check. */
function exhaustive(value: never): never {
  throw new Error(`Region: unhandled state ${JSON.stringify(value)}`);
}

/** A DOM-id-safe form of the region name, so a name with spaces still yields a usable heading id. */
function headingId(name: string): string {
  return `region-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-heading`;
}

export interface RegionProps {
  /** The region's name. It becomes the heading text, the accessible name, and the live-region announcement. */
  readonly name: string;
  readonly state: RegionPresentation;
}

export function Region({ name, state }: RegionProps): React.JSX.Element {
  const id = headingId(name);
  return (
    <section className="vg-region" data-region="true" data-region-name={name} data-region-state={state.kind} aria-labelledby={id}>
      <h2 className="vg-region__heading" id={id} tabIndex={-1} data-region-heading="true">
        {name}
      </h2>
      <div className="vg-region__body">{body(name, state)}</div>
    </section>
  );
}

function body(name: string, state: RegionPresentation): ReactNode {
  switch (state.kind) {
    case 'loading':
      return <LoadingRegion regionName={name} height={state.height} delayed={state.delayed} />;
    case 'ready':
      return state.children;
    case 'empty':
      return <EmptyState {...state.empty} />;
    case 'error':
      return <ErrorState {...state.error} />;
    case 'access-denied':
      return <AccessDenied {...state.denied} />;
    case 'human-gate':
      return <HumanGateNotice {...state.gate} />;
    case 'session-expiry':
      return <SessionExpiryNotice {...state.session} />;
    case 'partial-coverage':
      return (
        <>
          <PartialCoverageBanner
            sourcesAttempted={state.coverage.sourcesAttempted}
            sourcesTotal={state.coverage.sourcesTotal}
            skippedCount={state.coverage.skippedSources.length}
            catalogueVersion={state.coverage.catalogueVersion}
            runWindow={state.coverage.runWindow}
          />
          {state.children}
        </>
      );
    default:
      return exhaustive(state);
  }
}
