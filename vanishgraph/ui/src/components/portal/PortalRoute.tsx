/**
 * `PortalRoute` — the shape every portal route renders: a page shell, one data region, and the state mapping (EP-005 M5).
 *
 * IT EXISTS SO THE NINE ROUTES CANNOT DISAGREE. Each route supplies its name, its query and two renderers (the ready
 * content and, where the collection can be empty, the empty state's four parts); the wiring — loading, error,
 * access-denied, human-gate, empty, partial coverage — comes from `regionStateOf` and is therefore identical everywhere
 * and asserted once. A route that hand-rolled its own query rendering is the screen that implements only the success
 * path, which is the failure VG-UI-055 names.
 *
 * THE REGION IS THE ONLY THING THIS COMPONENT RENDERS BESIDES THE SHELL, which is what lets the surfaces inventory
 * assert "exactly one region per route" and lets M4's state suite be true of the built application rather than of a
 * fixture.
 */

import type { ReactNode } from 'react';

import { PageShell } from '../PageShell.tsx';
import { Region, type RegionPresentation } from '../states/Region.tsx';
import { regionStateOf, type QueryLike, type RegionOptions } from './region-from-query.ts';

export interface PortalRouteProps<T> {
  /** The route path, as SPEC-004 §1 declares it. It is the page heading. */
  readonly path: string;
  readonly surface: string;
  readonly purpose: string;
  /** The region's name: its heading, its accessible name and its loading announcement. */
  readonly region: string;
  readonly height: string;
  readonly query: QueryLike<T>;
  readonly options: RegionOptions<T>;
  /** The content of the ready state. */
  readonly ready: (data: T) => ReactNode;
}

export function PortalRoute<T>({
  path,
  surface,
  purpose,
  region,
  height,
  query,
  options,
  ready,
}: PortalRouteProps<T>): React.JSX.Element {
  const outcome = regionStateOf(query, { ...options, name: region, height });
  const state =
    outcome.kind === 'ready'
      ? ({ kind: 'ready', children: ready(outcome.data) } as const)
      : outcome.kind === 'partial'
        ? ({ kind: 'partial-coverage', coverage: outcome.coverage, children: ready(outcome.data) } as const)
        : outcome.state;
  return (
    <>
      <PageShell surface={surface} path={path} purpose={purpose} />
      <Region name={region} state={state} />
    </>
  );
}

export function SubjectScopedGap({
  path,
  surface,
  purpose,
  region,
  operation,
}: {
  readonly path: string;
  readonly surface: string;
  readonly purpose: string;
  readonly region: string;
  readonly operation: string;
}): React.JSX.Element {
  const gap = identityNotConfigured(path, region, operation);
  return (
    <>
      <PageShell surface={surface} path={path} purpose={purpose} />
      <Region name={gap.region} state={gap.state} />
    </>
  );
}

/**
 * The state for a subject-scoped route in a deployment with no identity provider.
 *
 * THIS IS AN ERROR STATE AND NOT AN ACCESS DENIAL, and the distinction is SPEC-006 §2.1 rule 3: "a system ERROR is never
 * dressed as a candidate result". A deployment without `KEYCLOAK_ISSUER` has a configuration gap, not a user who lacks a
 * role, and rendering it as access-denied would tell a reader to ask for a role that would not help. The state names the
 * operation, states that no request was sent (so there is no reference number), and says why a retry would not help.
 */
export function identityNotConfigured(path: string, region: string, operation: string): {
  readonly path: string;
  readonly region: string;
  readonly state: RegionPresentation;
} {
  return {
    path,
    region,
    state: {
      kind: 'error',
      error: {
        operation,
        correlationId: null,
        retry: {
          kind: 'not-retryable',
          reason:
            'this deployment has no identity provider configured, so the portal cannot tell which subject is asking; the deployment’s KEYCLOAK_ISSUER provisioning action has not been performed',
        },
      },
    },
  };
}
