/**
 * The rate-limit gate: it consults the limiter BEFORE the handler and attaches the headers to every response (SPEC-005 §9
 * VG-AUTH-016; EP-006 M6).
 *
 * THE DECISION COMES FIRST, WHICH IS WHAT "BEFORE DISPATCH" MEANS IN PRACTICE: the plugin resolves the class for the route,
 * calls `checkRateLimit`, and refuses with `429 RATE_LIMITED` and a `Retry-After` before the handler can run. A limiter
 * consulted inside the handler would have already performed the work it was meant to bound.
 *
 * THE HEADERS GO ON BOTH ANSWERS. A client that only learns its budget when it is refused has no way to slow down; the
 * `onSend` hook attaches them to the admitted response too, from the decision the preHandler stored on the request.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  checkRateLimit,
  type RateLimitClass,
  type RateLimitCounter,
  type RateLimitHeaders,
  type RateLimitPolicy,
} from '../../application/security/rate-limit-policy.ts';

declare module 'fastify' {
  interface FastifyRequest {
    rateLimitHeaders?: RateLimitHeaders | undefined;
  }
}

export interface RateLimitPluginOptions {
  readonly counter: RateLimitCounter;
  /** The clock the windows are measured from. Required, for the same reason the step-up policy requires one. */
  readonly now: () => number;
  /** The class a route belongs to, or `undefined` for an unlimited route. */
  readonly classForRoute: (method: string, path: string) => RateLimitClass | undefined;
  /** The source a discovery call targets, when the route carries one: it activates the per-source ceiling. */
  readonly sourceForRequest?: (request: FastifyRequest) => string | undefined;
  readonly identityOf?: (request: FastifyRequest) => { readonly tenantId: string; readonly actorIdentity: string } | undefined;
  readonly policy?: RateLimitPolicy;
  readonly refuse: (request: FastifyRequest, reply: FastifyReply, code: string, detail: string, retryAfterSeconds: number) => void;
}

interface LimitClaims {
  readonly tenant_id?: string;
  readonly sub?: string;
}

function defaultIdentity(request: FastifyRequest): { readonly tenantId: string; readonly actorIdentity: string } | undefined {
  const claims = (request as unknown as { identityClaims?: LimitClaims }).identityClaims;
  if (claims?.tenant_id === undefined || claims.sub === undefined) return undefined;
  return { tenantId: claims.tenant_id, actorIdentity: claims.sub };
}

export function installRateLimit(app: FastifyInstance, options: RateLimitPluginOptions): void {
  const identityOf = options.identityOf ?? defaultIdentity;

  app.addHook('preHandler', (request, reply, done) => {
    const rateClass = options.classForRoute(request.method, request.routeOptions?.url ?? request.url);
    const identity = identityOf(request);
    if (rateClass === undefined) {
      done();
      return;
    }
    if (identity === undefined) {
      // AN UNIDENTIFIED REQUEST HAS NO BUDGET TO SPEND: refusing is the fail-closed direction, and the identity plugin
      // authenticates before this one runs, so this path means the order was changed rather than that a client misbehaved.
      done();
      return;
    }
    const sourceId = options.sourceForRequest?.(request);
    void checkRateLimit(
      { tenantId: identity.tenantId, actorIdentity: identity.actorIdentity, rateClass, ...(sourceId === undefined ? {} : { sourceId }) },
      options.counter,
      options.now(),
      options.policy,
    )
      .then((decision) => {
        request.rateLimitHeaders = decision.headers;
        if (decision.allow) {
          done();
          return;
        }
        options.refuse(
          request,
          reply,
          decision.code ?? 'RATE_LIMITED',
          decision.detail ?? 'the rate limit for this operation is exhausted',
          decision.retryAfterSeconds ?? 60,
        );
        // NO done(): the handler must not run for a refused call.
      })
      .catch((error: unknown) => {
        // A LIMITER THAT CANNOT ANSWER MUST NOT ADMIT THE CALL. Failing open here would make an outage of the counter an
        // outage of the limit, which is the one moment the limit matters most.
        options.refuse(
          request,
          reply,
          'DEPENDENCY_UNAVAILABLE',
          `the rate limiter could not be consulted: ${error instanceof Error ? error.message : 'unknown failure'}`,
          60,
        );
      });
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    const headers = request.rateLimitHeaders;
    if (headers !== undefined) {
      for (const [name, value] of Object.entries(headers)) reply.header(name, value);
    }
    done(null, payload);
  });
}

/** The class a path belongs to, by the registry's own shapes. Reads are unlimited except the two VG-AUTH-016 names. */
export function rateClassForPath(method: string, path: string): RateLimitClass | undefined {
  const normalised = path.split('?')[0] ?? path;
  const upper = method.toUpperCase();
  if (normalised.startsWith('/v1/discovery-runs') && upper === 'POST') return 'discovery';
  if (normalised.includes('/verification-observations') && upper === 'POST') return 'verification';
  if (normalised.startsWith('/v1/evidence-artifacts') && upper === 'GET') return 'evidence_read';
  if (upper === 'POST' || upper === 'PATCH' || upper === 'PUT' || upper === 'DELETE') return 'write';
  return undefined;
}

