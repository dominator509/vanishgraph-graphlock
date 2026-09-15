/**
 * Shared handler plumbing (SPEC-003 §3.2, §7).
 *
 * Every route handler needs the same four things before it can do any work, and each one is a place a
 * handler could forget a control. Putting them here means a handler CANNOT skip them: it receives a
 * context only after identity, tenancy and scope have all been satisfied.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not decide a truth state, does not read
 * `LEGAL_TRANSITIONS`, and does not contain a `switch` over `TruthState` that assigns anything. A
 * handler that needs a state change calls an application command; SPEC-001 SM-6 puts the decision
 * inside the guard list, and `scripts/scan-truth-state-input.ts` plus the gate's handler scan assert
 * that this layer never grows one.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { ApiError } from '../plugins/error-handler.ts';
import { requireTenantContext, withRequestTenant, type TenantTransaction } from '../plugins/tenancy.ts';
import { findRoute, type RouteDefinition, type Scope } from '../openapi/registry.ts';
import { requireStepUp } from '../plugins/identity.ts';
import { holdsAllScopes, type RequestContext } from '../../application/contracts/request-context.ts';

/** What a handler receives once every precondition has been satisfied. */
export interface HandlerContext {
  readonly route: RouteDefinition;
  readonly context: RequestContext;
  /** Run database work in the caller's tenant transaction. */
  readonly withTenant: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
}

/**
 * Convert a Fastify route pattern into the registry's template form.
 *
 * MEASURED MISMATCH this fixes: Fastify exposes `/v1/subjects/:subjectId` through `routeOptions.url`
 * while SPEC-003 §5 and the registry write `/v1/subjects/{subjectId}` (OpenAPI style). Without this
 * translation `findRoute` returns `undefined` for every parameterised route and the handler answers
 * `404 RESOURCE_NOT_FOUND` for a route that exists — a failure that looks like a missing resource
 * rather than a wiring bug, which is the worst kind to debug.
 *
 * The conversion happens here, ONCE, rather than by writing Fastify routes in brace form (which
 * Fastify would not match) or by storing colon form in the registry (which would no longer equal the
 * specification, breaking the set-equality test that guards it).
 */
export function toRegistryTemplate(fastifyPattern: string): string {
  return fastifyPattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

/**
 * Resolve the route definition and enforce its declared preconditions.
 *
 * ORDER IS THE CONTRACT: identity → tenancy → scope. A scope check before identity would have no
 * scopes to check; a tenancy check before identity would have no tenant. Both are already enforced by
 * their plugins as `onRequest` hooks, so reaching here means they passed, and this function's job is
 * the SCOPE check plus the defensive assertions.
 */
export function beginHandler(request: FastifyRequest, reply: FastifyReply): HandlerContext {
  const route = findRoute(request.method, toRegistryTemplate(request.routeTemplate));
  if (route === undefined) {
    // A route that is not in the registry is a defect: SPEC-003 §5 is the contract, and an
    // unregistered route has no declared scopes, so it cannot be authorized at all.
    throw new ApiError('RESOURCE_NOT_FOUND');
  }

  const context = requireTenantContext(request);

  // The route's declared scopes must ALL be held. Exact set membership, not substring matching: a
  // hypothetical `vg.subjects.readonly` must not satisfy `vg.subjects.read`.
  const missing = route.scopes.filter((scope: Scope) => !holdsAllScopes(context.scopes, [scope]));

  // CONDITIONAL requirements (§5.1.6, §5.1.8): a query parameter that raises the bar. Enforced here
  // rather than in each handler so the rule is stated once and the route-catalogue test can assert it.
  //
  // MEASURED DEFECT this corrects: the registry once declared `vg.pii.reveal` and `stepUp: true`
  // unconditionally on those two routes, so a MASKED read — the documented default — was refused with
  // `403 INSUFFICIENT_SCOPE` to a caller the contract permits.
  let conditionalStepUp = false;
  for (const requirement of route.conditional ?? []) {
    const raw = (request.query as Record<string, unknown>)[requirement.parameter];
    if (raw !== requirement.when) continue;
    for (const scope of requirement.scopes) {
      if (!holdsAllScopes(context.scopes, [scope])) missing.push(scope);
    }
    if (requirement.stepUp) conditionalStepUp = true;
  }

  if (missing.length > 0) {
    throw new ApiError('INSUFFICIENT_SCOPE', {
      missingScopes: [...missing],
      requiredScopes: [...route.scopes],
    });
  }

  // Checked AFTER the scope, because a caller lacking the scope should learn that rather than be told
  // to re-authenticate for an operation they cannot perform at all.
  // STEP-UP IS ENFORCED FROM THE REGISTRY, not by each handler remembering to call `requireStepUp`.
  //
  // Before this, `route.stepUp` was INFORMATIONAL: handlers that needed it called `requireStepUp` by
  // hand, so a route marked `stepUp: true` in the registry could be implemented WITHOUT the check and
  // nothing would notice. The registry is the contract, so it is the control.
  //
  // Ordering: step-up is checked AFTER the scope check, because a caller lacking the scope should
  // learn that rather than be told to re-authenticate for an operation they cannot perform at all.
  if (route.stepUp || conditionalStepUp) {
    requireStepUp(context, Date.now());
  }

  return {
    route,
    context,
    withTenant: <T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> =>
      withRequestTenant(request, request.server.vgTenancy, fn),
    request,
    reply,
  };
}

/**
 * Map an absent row to `404 RESOURCE_NOT_FOUND`.
 *
 * A resource owned by ANOTHER TENANT is indistinguishable from an absent one by construction: RLS
 * means the row is simply not returned, so both reach this same branch and produce one body. That is
 * SPEC-006 H-9, and it is why this helper takes no "reason" argument — there is nothing to
 * distinguish, and adding a parameter would invite a caller to leak the difference.
 */
export function notFound<T>(value: T | undefined): T {
  if (value === undefined) throw new ApiError('RESOURCE_NOT_FOUND');
  return value;
}

/** Parse a UUID path parameter, refusing anything else with the contract's 404. */
export function uuidParam(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, string>;
  const value = params[name];
  // A malformed id is reported as NOT FOUND rather than as a validation error: SPEC-006 H-9 requires
  // absent and other-tenant resources to be indistinguishable, and a distinct "malformed id" response
  // would tell a prober which shapes exist.
  if (value === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError('RESOURCE_NOT_FOUND');
  }
  return value;
}
