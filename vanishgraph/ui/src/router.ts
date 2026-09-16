/**
 * The route tree (SPEC-004 §1, VG-UI-004; EP-005 M1).
 *
 * WRITTEN FROM THE ROUTE FILES, exactly as `scripts/emit-route-manifest.ts` derives the manifest from them, so
 * the tree, the manifest and SPEC-004 §1's table are three views of one fact. The imports are explicit rather
 * than a filesystem scan at runtime: a bundler cannot scan, and an import that does not resolve is a build
 * failure rather than a route that silently disappears (which is the failure the manifest equality test exists
 * to catch, one step earlier).
 */

import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';

import { RootLayout } from './routes/__root.tsx';
import { NotFound } from './routes/not-found.tsx';
import { Page_admin_authority } from './routes/admin.authority.tsx';
import { Page_admin_catalog } from './routes/admin.catalog.tsx';
import { Page_admin_metrics } from './routes/admin.metrics.tsx';
import { Page_admin_policy } from './routes/admin.policy.tsx';
import { Page_admin_tenant } from './routes/admin.tenant.tsx';
import { Page_admin_users } from './routes/admin.users.tsx';
import { Page_auditor_cases__caseId_ } from './routes/auditor.cases.$caseId.tsx';
import { Page_auditor_claims } from './routes/auditor.claims.tsx';
import { Page_auditor_evidence__evidenceId_ } from './routes/auditor.evidence.$evidenceId.tsx';
import { Page_auditor_exports } from './routes/auditor.exports.tsx';
import { Page_console_cases__caseId_ } from './routes/console.cases.$caseId.tsx';
import { Page_console_coverage } from './routes/console.coverage.tsx';
import { Page_console_exposures__exposureId_ } from './routes/console.exposures.$exposureId.tsx';
import { Page_console_gates } from './routes/console.gates.tsx';
import { Page_console_queue } from './routes/console.queue.tsx';
import { Page_console_recipes } from './routes/console.recipes.tsx';
import { Page_portal_alerts } from './routes/portal.alerts.tsx';
import { Page_portal_authority } from './routes/portal.authority.tsx';
import { Page_portal_cases__caseId__evidence__evidenceId_ } from './routes/portal.cases.$caseId.evidence.$evidenceId.tsx';
import { Page_portal_cases__caseId_ } from './routes/portal.cases.$caseId.tsx';
import { Page_portal_exposures } from './routes/portal.exposures.tsx';
import { Page_portal_limitations } from './routes/portal.limitations.tsx';
import { Page_portal_onboarding } from './routes/portal.onboarding.tsx';
import { Page_portal_requests } from './routes/portal.requests.tsx';
import { Page_portal } from './routes/portal.tsx';

const rootRoute = createRootRoute({ component: RootLayout, notFoundComponent: NotFound });

const route_Page_admin_authority = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/authority',
  component: Page_admin_authority,
});

const route_Page_admin_catalog = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/catalog',
  component: Page_admin_catalog,
});

const route_Page_admin_metrics = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/metrics',
  component: Page_admin_metrics,
});

const route_Page_admin_policy = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/policy',
  component: Page_admin_policy,
});

const route_Page_admin_tenant = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/tenant',
  component: Page_admin_tenant,
});

const route_Page_admin_users = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/users',
  component: Page_admin_users,
});

const route_Page_auditor_cases__caseId_ = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auditor/cases/$caseId',
  component: Page_auditor_cases__caseId_,
});

const route_Page_auditor_claims = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auditor/claims',
  component: Page_auditor_claims,
});

const route_Page_auditor_evidence__evidenceId_ = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auditor/evidence/$evidenceId',
  component: Page_auditor_evidence__evidenceId_,
});

const route_Page_auditor_exports = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auditor/exports',
  component: Page_auditor_exports,
});

const route_Page_console_cases__caseId_ = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console/cases/$caseId',
  component: Page_console_cases__caseId_,
});

const route_Page_console_coverage = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console/coverage',
  component: Page_console_coverage,
});

const route_Page_console_exposures__exposureId_ = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console/exposures/$exposureId',
  component: Page_console_exposures__exposureId_,
});

const route_Page_console_gates = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console/gates',
  component: Page_console_gates,
});

const route_Page_console_queue = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console/queue',
  component: Page_console_queue,
});

const route_Page_console_recipes = createRoute({
  getParentRoute: () => rootRoute,
  path: '/console/recipes',
  component: Page_console_recipes,
});

const route_Page_portal_alerts = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portal/alerts',
  component: Page_portal_alerts,
});

const route_Page_portal_authority = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portal/authority',
  component: Page_portal_authority,
});

const route_Page_portal_cases__caseId__evidence__evidenceId_ = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portal/cases/$caseId/evidence/$evidenceId',
  component: Page_portal_cases__caseId__evidence__evidenceId_,
});

const route_Page_portal_cases__caseId_ = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portal/cases/$caseId',
  component: Page_portal_cases__caseId_,
});

const route_Page_portal_exposures = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portal/exposures',
  component: Page_portal_exposures,
});

const route_Page_portal_limitations = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portal/limitations',
  component: Page_portal_limitations,
});

const route_Page_portal_onboarding = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portal/onboarding',
  component: Page_portal_onboarding,
});

const route_Page_portal_requests = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portal/requests',
  component: Page_portal_requests,
});

const route_Page_portal = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portal',
  component: Page_portal,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    route_Page_admin_authority,
    route_Page_admin_catalog,
    route_Page_admin_metrics,
    route_Page_admin_policy,
    route_Page_admin_tenant,
    route_Page_admin_users,
    route_Page_auditor_cases__caseId_,
    route_Page_auditor_claims,
    route_Page_auditor_evidence__evidenceId_,
    route_Page_auditor_exports,
    route_Page_console_cases__caseId_,
    route_Page_console_coverage,
    route_Page_console_exposures__exposureId_,
    route_Page_console_gates,
    route_Page_console_queue,
    route_Page_console_recipes,
    route_Page_portal_alerts,
    route_Page_portal_authority,
    route_Page_portal_cases__caseId__evidence__evidenceId_,
    route_Page_portal_cases__caseId_,
    route_Page_portal_exposures,
    route_Page_portal_limitations,
    route_Page_portal_onboarding,
    route_Page_portal_requests,
    route_Page_portal,
  ]),
  defaultNotFoundComponent: NotFound,
});

declare module '@tanstack/react-router' {
  interface Register {
    readonly router: typeof router;
  }
}
