/**
 * Shared helpers for the browser suites (EP-005 M4).
 *
 * TWO KINDS OF PAGE, AND THE DIFFERENCE IS RECORDED RATHER THAN BLURRED:
 *
 *   1. THE BUILT APPLICATION, served by `vite preview` from `ui/dist` — used for the routes, the axe pass, focus
 *      identity and reduced motion. This is the artefact that would ship (SPEC-008 VG-SHIP-021/022).
 *   2. THE STATE HARNESS, which is `page.setContent()` over markup produced by the REAL components through the same
 *      Node render harness the contract suites use, plus the CSS asset the build emitted. It exists because the region
 *      states are not mounted in any route yet (that is M5/M6's work, since a state needs a request behind it), and
 *      asserting their browser behaviour against nothing would be worse than asserting it against the components
 *      themselves. The harness renders component output, never fixtures that imitate it: `setContent` receives exactly
 *      what `renderToStaticMarkup` produced for a given state.
 *
 * THE HARNESS IS NOT A PRODUCT SURFACE. It adds no route, no HTML file and no bundle entry: nothing about it can be
 * reached by a user, and no fixture data enters the built artefact.
 *
 * WHAT A HARNESS PAGE CANNOT PROVE is stated where it is used: it has no application shell, so it says nothing about
 * the app's own focus management, and it is a static string, so it exercises no effects or timers.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildMirror, h, loadComponent, renderToHtml } from '../contract/render-support.ts';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const BUILT = join(PROJECT_ROOT, 'ui', 'dist');

type Component = (props: Record<string, unknown>) => unknown;

/** The route set SPEC-004 §1 declares, as emitted by `scripts/emit-route-manifest.ts`. */
export function declaredRoutes(): readonly string[] {
  const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'ui', 'src', 'route-manifest.json'), 'utf8')) as {
    routes: string[];
  };
  return manifest.routes;
}

/** The routes a browser can actually visit: a declared route with a `[param]` needs a real identifier. */
export function visitableRoutes(): readonly string[] {
  return declaredRoutes().filter((route) => !route.includes('['));
}

/**
 * The CSS the build emitted. REQUIRED, not optional: before M4 no stylesheet was imported at all, so every browser
 * measurement of contrast or focus would have measured browser defaults. A missing asset fails the suite loudly.
 */
export function builtCss(): string {
  const assets = readdirSync(join(BUILT, 'assets'));
  const sheets = assets.filter((name) => name.endsWith('.css'));
  if (sheets.length !== 1) {
    throw new Error(
      `expected exactly one built stylesheet in ui/dist/assets, found ${String(sheets.length)} (${assets.join(', ')}); run 'npm run build:web'`,
    );
  }
  return join(BUILT, 'assets', sheets[0] ?? '');
}

/** Build the mirror once per process and render one state's markup. */
export async function renderState(name: string): Promise<string> {
  buildMirror();
  const region = await loadComponent<{ Region: Component }>('components/states/Region.tsx');
  return renderToHtml(h(region.Region, { name: 'Case queue', state: STATE_FIXTURES[name] }));
}

/** The seven states plus `ready`, with the props each state requires. */
export const STATE_FIXTURES: Readonly<Record<string, Record<string, unknown>>> = {
  loading: { kind: 'loading', height: '9rem' },
  'loading-delayed': {
    kind: 'loading',
    height: '9rem',
    delayed: { operation: 'the case queue', onCancel: () => undefined },
  },
  ready: { kind: 'ready', children: 'Content that arrived.' },
  empty: {
    kind: 'empty',
    empty: {
      searched: 'exposures for this subject',
      window: { from: '2026-09-01T00:00:00Z', to: '2026-09-15T00:00:00Z' },
      coverage: coverageRun(),
      nextAction: null,
    },
  },
  'partial-coverage': { kind: 'partial-coverage', coverage: coverageRun(), children: 'Rows from a partial run.' },
  error: {
    kind: 'error',
    error: {
      operation: 'loading the case queue',
      correlationId: 'corr-9f2c-4d1e',
      retry: { kind: 'not-retryable', reason: 'a retry could send the request twice' },
    },
  },
  'access-denied': {
    kind: 'access-denied',
    denied: { requiredRole: 'a case worker for this tenant', backTo: { href: '/portal', label: 'Back to your portal' } },
  },
  'human-gate': {
    kind: 'human-gate',
    gate: {
      gateKind: 'identity verification',
      mustAct: 'you, by confirming your identity document',
      afterAction: 'the case moves to review and you are told what was decided',
      recorded: 'your request and the records found so far',
      qualifierId: 'gate-qualifier',
    },
  },
  'session-expiry-warning': {
    kind: 'session-expiry',
    session: {
      phase: 'warning',
      secondsRemaining: 120,
      reauthenticatePath: '/sign-in',
      onStaySignedIn: () => undefined,
    },
  },
  'session-expiry-expired': {
    kind: 'session-expiry',
    session: { phase: 'expired', reauthenticatePath: '/sign-in' },
  },
};

function coverageRun(): Record<string, unknown> {
  return {
    sourcesAttempted: 12,
    sourcesTotal: 30,
    catalogueVersion: 'catalogue-2026-09-01',
    runWindow: { from: '2026-09-01T00:00:00Z', to: '2026-09-15T00:00:00Z' },
    skippedSources: [{ sourceId: 'SOURCE_BETA', reason: 'human verification gate' }],
  };
}

/** Markup for all eleven truth states, for the grayscale distinguishability check (VG-UI-057). */
export async function renderAllBadges(): Promise<readonly { readonly token: string; readonly html: string }[]> {
  buildMirror();
  // THE COPY MODULE IS LOADED FROM THE MIRROR rather than imported with a `.ts` extension: the mirror is plain
  // JavaScript, so the suite does not depend on Playwright's loader resolving an explicit TypeScript extension.
  const copy = await loadComponent<{
    TRUTH_STATE_TOKENS: readonly string[];
    TRUTH_STATE_COPY: Readonly<Record<string, { readonly requiresScope: boolean }>>;
  }>('copy/truth-state.ts');
  const badge = await loadComponent<{ TruthStateBadge: Component }>('components/truth/TruthStateBadge.tsx');
  return copy.TRUTH_STATE_TOKENS.map((token) => {
    // The scope is passed only where §2.4 requires it, so each badge renders in its declared default form.
    const scope = copy.TRUTH_STATE_COPY[token]?.requiresScope === true ? { sourceId: 'EXAMPLE_SOURCE', windowDays: 30 } : undefined;
    return { token, html: renderToHtml(h(badge.TruthStateBadge, { state: token, scope, variant: 'block' })) };
  });
}
