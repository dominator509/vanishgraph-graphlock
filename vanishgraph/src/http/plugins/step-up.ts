/**
 * The step-up binding: it connects a route's declared class to the policy (SPEC-005 §6; EP-006 M5).
 *
 * WHY A BINDING RATHER THAN A CHECK INSIDE THE POLICY. `step-up-policy.ts` decides whether a session satisfies a class; a
 * route has to say WHICH class it needs, and that is registry data rather than something a handler passes by habit. This
 * module reads the class from the request's route configuration, takes the session's `acr` and `authTime` from the claims
 * the identity plugin already verified, and refuses with the policy's own code and audit row.
 *
 * IT RUNS AS A `preHandler`, SO THE REFUSAL PRECEDES THE HANDLER. That is the assertion the suite makes with a dispatch
 * spy: a step-up check that ran inside the handler would still have dispatched the command and possibly produced the
 * external effect the class exists to gate.
 *
 * THE CLOCK IS AN OPTION, NOT A GLOBAL. A plugin that read the process clock would report a fresh step-up on a machine
 * whose clock is wrong, and the policy's whole freshness rule depends on the time being the one the deployment trusts;
 * the option is required, so a caller cannot forget it and get the wall clock by accident.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { checkStepUp, type Clock, type StepUpClass } from '../../application/security/step-up-policy.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The step-up decision of the last check, so a handler can audit the class it was gated by. */
    stepUpClass?: StepUpClass | undefined;
  }
}

export interface StepUpPluginOptions {
  /**
   * The clock the freshness check uses. REQUIRED: a default would hide the decision, and SPEC-006 §7.1 row 24 makes an
   * unavailable clock a refusal rather than an assumption.
   */
  readonly clock: Clock;
  /** Maps a route to the class it requires. Returns `undefined` for a route that requires no step-up. */
  readonly classForRoute: (method: string, path: string) => StepUpClass | undefined;
  /**
   * How a refusal is written. Injected so the plugin does not depend on the error-envelope implementation.
   *
   * IT MUST SEND THE REPLY. The plugin does NOT call done() after refusing, because calling it continues the chain to
   * the handler - MEASURED: the first version called refuse(...) and then done(), and the suite's dispatch spy recorded
   * the handler running on a refused request, which is precisely the 'refused after the work was done' failure the class
   * exists to prevent. A refuse that only records and never replies leaves the request open, which is a loud failure
   * rather than a silent one.
   */
  readonly refuse: (request: FastifyRequest, reply: FastifyReply, code: string, detail: string) => void;
}

/** The claims the identity plugin verified, read defensively: a request without them is refused, not assumed. */
interface StepUpClaims {
  readonly acr?: string | undefined;
  readonly auth_time?: number | undefined;
}

function evidenceFrom(request: FastifyRequest): { acr: string | undefined; authTime: number | undefined } {
  const claims = (request as unknown as { identityClaims?: StepUpClaims }).identityClaims;
  if (claims === undefined) return { acr: undefined, authTime: undefined };
  return { acr: claims.acr, authTime: claims.auth_time };
}

/**
 * Install the step-up guard.
 *
 * THE CLASS COMES FROM THE ROUTE, NOT FROM THE CALLER. A handler cannot opt out by omitting an argument, because there is
 * no argument: the plugin asks `classForRoute` for the path being served and applies the policy when it answers.
 */
export function installStepUp(app: FastifyInstance, options: StepUpPluginOptions): void {
  app.addHook('preHandler', (request, reply, done) => {
    const stepUpClass = options.classForRoute(request.method, request.routeOptions?.url ?? request.url);
    if (stepUpClass === undefined) {
      done();
      return;
    }
    request.stepUpClass = stepUpClass;
    const decision = checkStepUp(stepUpClass, evidenceFrom(request), options.clock);
    if (decision.ok) {
      done();
      return;
    }
    options.refuse(request, reply, decision.code ?? 'STEP_UP_REQUIRED', decision.detail ?? 'step-up refused');
    // NO done() HERE: see the `refuse` contract above. Continuing the chain would run the handler.
    return;
  });
}

/** Whether a path belongs to one of the six classes, by the registry's own path shapes. */
export function classForPath(method: string, path: string): StepUpClass | undefined {
  const normalised = path.split('?')[0] ?? path;
  const upper = method.toUpperCase();
  if (normalised.startsWith('/v1/authority-grants') && upper !== 'GET') return 'AUTHORITY_GRANT_MINT_OR_EXPAND';
  if (normalised.endsWith('/external-actions') && upper === 'POST') return 'EXTERNAL_WRITE_EXECUTE_OR_AUTHORISE';
  if (normalised.endsWith('/evidence-artifacts') && upper === 'POST') return 'EXTERNAL_WRITE_EXECUTE_OR_AUTHORISE';
  if (normalised.endsWith('/content') && upper === 'GET') return 'EXTERNAL_WRITE_EXECUTE_OR_AUTHORISE';
  if (normalised.endsWith('/identifiers') && upper === 'POST') return 'EXTERNAL_WRITE_EXECUTE_OR_AUTHORISE';
  if (normalised.endsWith('/mail-pieces') && upper === 'POST') return 'CERTIFIED_MAIL_GENERATE';
  if (normalised.endsWith('/appeal-escalations') && upper === 'POST') return 'ESCALATION_OR_REGULATOR_PACKET_APPROVE';
  if (normalised.startsWith('/v1/support/')) return 'SUPPORT_BREAK_GLASS_ENTER';
  if (normalised.startsWith('/v1/admin/') && upper !== 'GET') return 'TENANT_POLICY_SOURCE_RECIPE_CHANGE';
  return undefined;
}

