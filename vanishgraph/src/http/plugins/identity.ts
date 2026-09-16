/**
 * Identity resolution (SPEC-003 §3, SPEC-005 IDP-1…IDP-6).
 *
 * This plugin turns a bearer token into a `RequestContext`, or refuses. Two properties matter:
 *
 *  1. **Paths that must NOT require a token are named explicitly**, not inferred. `/v1/health`,
 *     `/v1/ready`, `/v1/live` and `/v1/startup` are the only ones (SPEC-003 §5.17). Webhook ingress
 *     is also exempt but is authenticated by signature — a different mechanism that M7 adds, so
 *     until then a webhook path is NOT silently allowed through here.
 *  2. **The refusal code comes from `verifyToken`**, so a missing token, a wrong audience, a missing
 *     claim and an unreachable key server each keep their own wire code. Collapsing them into one
 *     401 would tell an operator "your credential is wrong" while the key server is down.
 *
 * The plugin does not read a token from anywhere but the `Authorization` header (SPEC-003 §3.2
 * item 1). It does not open a transaction, does not touch the database, and does not decide
 * authorization: it establishes WHO is calling, and `tenancy.ts` establishes WHICH tenant's rows are
 * visible.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ApiError } from './error-handler.ts';
import { bearerFrom, type IdentityResult } from '../../application/contracts/identity.ts';
import { tenantIdFrom } from '../../application/contracts/index.ts';
import type { RequestContext } from '../../application/contracts/request-context.ts';
import { isStepUpFresh } from '../../application/contracts/request-context.ts';

/** A minimal clock so the context never reads the ambient time itself. */
const systemClock = { nowMs: (): number => Date.now() };

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by this plugin when identity resolution succeeded. */
    vgContext: RequestContext | undefined;
  }
}

export interface IdentityPluginOptions {
  /**
   * Verify a bearer token. Injected so the plugin is testable with a locally signed token and so
   * `src/http` never imports the OIDC adapter directly.
   */
  readonly verify: (token: string | undefined) => Promise<IdentityResult>;
}

/**
 * Paths that do not require a bearer token.
 *
 * SPEC-003 §5.17 defines all four. Readiness and liveness must be reachable by an orchestrator that
 * holds no credential; requiring one would make the health surface unusable exactly when it is
 * needed. No OTHER path is exempt, and the list is exact rather than prefix-based so a future wildcard
 * route cannot inherit an exemption it was never granted.
 */
export const UNAUTHENTICATED_PATHS: readonly string[] = [
  '/v1/health',
  '/v1/ready',
  '/v1/live',
  '/v1/startup',
];

/**
 * The webhook ingress prefix, exempted from bearer authentication and NOT from authentication itself.
 *
 * MEASURED, and the ingress was unreachable without it: §6 opens with "Webhook ingress is the only
 * unauthenticated-by-bearer write surface", so a bearer plugin that ran on these paths answered
 * `401 TOKEN_MISSING` to every delivery — a provider has no bearer token to send. §6 replaces the
 * bearer credential with THREE others, each enforced in the route rather than here: an HMAC-SHA256
 * signature over the raw bytes with a secret resolved from the capability's binding, a single-use
 * nonce, and a stable event id. The two exemptions are therefore not comparable, which is why this is
 * a separate constant with its own reason rather than an entry in the list above:
 *
 *   * the health routes require NO credential, because an orchestrator that had one would defeat the
 *     purpose of a liveness probe;
 *   * the ingress requires a DIFFERENT credential, and a delivery that fails it is refused before any
 *     work happens (`scripts/reality-gate.sh` and `tests/db/webhook-ingress.test.ts` both assert the
 *     refusals).
 *
 * A PREFIX, unlike the exact list above, because §6's third route carries a variable path segment
 * (`{providerKeyId}`, `{mailProviderKeyId}`, `{controllerCallbackToken}`) — the value is the
 * capability, so no fixed path list can name it.
 */
export const UNAUTHENTICATED_PREFIXES: readonly string[] = ['/v1/webhooks/'];

/** True when `path` needs no bearer token: one of the four public health routes, or the webhook ingress. */
export function isUnauthenticatedPath(path: string): boolean {
  const withoutQuery = path.split('?')[0] ?? path;
  if (UNAUTHENTICATED_PATHS.includes(withoutQuery)) return true;
  return UNAUTHENTICATED_PREFIXES.some((prefix) => withoutQuery.startsWith(prefix));
}

export function installIdentity(app: FastifyInstance, options: IdentityPluginOptions): void {
  app.decorateRequest('vgContext', undefined);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isUnauthenticatedPath(request.url)) return;

    const token = bearerFrom(request.headers as Record<string, string | string[] | undefined>);
    const result: IdentityResult = await options.verify(token);

    if (!result.ok) {
      // The code is preserved exactly: DEPENDENCY_UNAVAILABLE stays a 503 so an outage is not
      // reported as a bad credential, and TOKEN_AUDIENCE_MISMATCH stays distinct so a misconfigured
      // client is diagnosable without guesswork.
      throw new ApiError(result.code);
    }

    const claims = result.claims;
    request.vgContext = {
      // The ONE place a TenantId is minted for a request. The constructor validates the shape, so a
      // token carrying a malformed tenant cannot reach a scoped query. Every consumer downstream
      // receives the branded value and cannot substitute a plain string.
      tenantId: tenantIdFrom(claims.tenant_id),
      actorIdentity: claims.sub,
      roles: claims.roles,
      scopes: claims.scopes ?? [],
      authLevel: claims.auth_level,
      // SPEC-005 §6 uses the token's authentication time; `iat` is the fallback when the IdP does
      // not publish a distinct `auth_time`. Recorded as a fallback rather than silently treated as
      // "now", which would make every token look freshly stepped-up.
      authTimeSeconds: claims.iat,
      correlationId: request.correlationId,
      requestId: request.id === '' ? request.correlationId : request.id,
      subjectRef: claims.subject_ref,
      clock: systemClock,
    };

    void reply;
  });
}

/**
 * Require a fresh step-up for a route (SPEC-003 §3.2 item 7, SPEC-005 §6).
 *
 * Exported for the route modules that carry `stepUp: true` in the registry. A stale step-up is
 * refused, never silently downgraded (VG-AUTH-005).
 */
export function requireStepUp(context: RequestContext, nowMs: number): void {
  if (!isStepUpFresh(context.authTimeSeconds, nowMs)) {
    throw new ApiError('STEP_UP_REQUIRED');
  }
}
