/**
 * Idempotency at the HTTP boundary (SPEC-003 §4.1–§4.5, VG-ACTION-001, VG-API-020).
 *
 * WHY THIS IS A PLUGIN AND NOT A HANDLER RESPONSIBILITY: an effect-bearing route that forgot the
 * check would submit a duplicate certified letter, and the mistake would be invisible in review
 * because the handler looks correct. Enforcing it here means the check runs for every route the
 * REGISTRY marks, whether or not the handler remembers.
 *
 * THE ORDER OF OPERATIONS IS THE CONTRACT, and each step exists because the one after it is unsafe
 * without it:
 *
 *   1. **Registry requirement first.** SPEC-003 §4.1: a route marked Required that arrives without
 *      the header is `400 IDEMPOTENCY_KEY_REQUIRED` and "produces no state change". Checking before
 *      any work is what makes "no state change" true rather than aspirational.
 *   2. **Shape validation.** 16–255 chars, `[A-Za-z0-9._:-]`. A malformed key is
 *      `400 IDEMPOTENCY_KEY_MALFORMED`, also before any work.
 *   3. **Canonicalised fingerprint.** Two byte-different but semantically identical bodies must
 *      fingerprint EQUAL, or an honest retry is refused as a conflict; two semantically different
 *      bodies must fingerprint DIFFERENTLY, or a genuine change is silently dropped.
 *   4. **begin() → replay / conflict / proceed.** The store decides atomically, so two simultaneous
 *      requests cannot both proceed.
 *   5. **abandon() on a pre-effect failure.** Without it a transient error leaves the key in flight
 *      forever and the caller can never retry.
 *
 * THE NON-PROMOTION RULE (§4.4): a replayed response is not evidence of a new effect. This plugin
 * therefore counts NOTHING. A counter incremented here would count HTTP 2xx responses, which §4.4
 * explicitly forbids; effect counts come from distinct `(caseId, idempotencyKey)` pairs in the domain.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ApiError } from './error-handler.ts';
import type {
  IdempotencyRecord,
  IdempotencyScope,
  IdempotencyStore,
} from '../../application/contracts/index.ts';

/** The header names of SPEC-003 §4. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'idempotency-replayed';
export const IDEMPOTENCY_KEY_ECHO_HEADER = 'idempotency-key-echo';

/** How long a completed record is retained (SPEC-003 §4.2). */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** `Required`, `Required-if-effect`, or `Optional` (SPEC-003 §4.1). */
export type IdempotencyRequirement = 'required' | 'required-if-effect' | 'optional';

/**
 * The key shape of SPEC-003 §4.2: 16–255 characters from `[A-Za-z0-9._:-]`.
 *
 * The MINIMUM matters as much as the maximum: a 3-character key has so little entropy that two
 * unrelated clients collide, and the second request would be replayed against the first's response
 * — a cross-request data leak dressed as idempotency.
 */
const KEY_SHAPE = /^[A-Za-z0-9._:-]{16,255}$/;

export class IdempotencyKeyMalformedError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_MALFORMED' as const;
}

export function validateIdempotencyKey(value: string | undefined): string {
  if (value === undefined || !KEY_SHAPE.test(value)) {
    throw new IdempotencyKeyMalformedError(
      'an Idempotency-Key must be 16-255 characters of [A-Za-z0-9._:-]',
    );
  }
  return value;
}

/**
 * Canonicalise a parsed JSON value into a deterministic string.
 *
 * Object keys are sorted, numbers are normalised, `undefined` members are dropped, and there is no
 * insignificant whitespace. This is what makes "byte-different but semantically identical"
 * fingerprint equal, which is the property an honest retry depends on.
 *
 * WHAT IS DELIBERATELY NOT NORMALISED: array ORDER is preserved, because `[1,2]` and `[2,1]` are
 * different requests; and string content is untouched, because `"a"` and `"A"` are different values.
 * Normalising either would make two genuinely different requests collide, which is worse than the
 * problem being solved.
 *
 * `-0` normalises to `0` (they compare equal in JavaScript, so treating them as different would
 * fingerprint the same body two ways across runtimes). `NaN`/`Infinity` cannot appear in valid JSON
 * and are rendered as their literal tokens so they cannot silently become `null`.
 */
export function canonicalise(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    // `-0` and `0` are the same value for every comparison a caller can make.
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
  }
  // A function or symbol cannot appear in a parsed JSON body; render it so it is visible rather than
  // silently collapsing two different bodies to the same fingerprint.
  return `${typeof value}`;
}

/** SHA-256 of the canonicalised body (SPEC-003 §4.2). */
export function fingerprintOf(body: unknown): string {
  return createHash('sha256').update(canonicalise(body)).digest('hex');
}

export interface IdempotencyPluginOptions {
  readonly store: IdempotencyStore;
  /**
   * The requirement for a route, from the registry. Returning `undefined` means the route is not
   * known to the registry, which is treated as `optional` — NOT as `required`, because a route the
   * registry does not know about is a defect the contract suite catches, and failing every request to
   * it here would obscure that.
   */
  readonly requirementFor: (method: string, routeTemplate: string) => IdempotencyRequirement | undefined;
  readonly now?: () => number;
}

/** What the plugin stores on the request for a handler to use. */
export interface IdempotencyContext {
  readonly scope: IdempotencyScope;
  readonly fingerprint: string;
  /** True when this request CLAIMED the key and must call `complete` or `abandon`. */
  readonly claimed: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    vgIdempotency: IdempotencyContext | undefined;
    /** Set by a handler's response hook so the plugin can store the outcome. */
    routeTemplate: string;
  }
}

/**
 * Run a handler under idempotency control.
 *
 * Exported so a route calls it explicitly rather than relying on a hook that must guess when the work
 * begins. `work` is only invoked when the key was newly claimed, so there is no path where an effect
 * happens without the key having been claimed first.
 */
export async function withIdempotency<T>(
  request: FastifyRequest,
  options: IdempotencyPluginOptions,
  reply: FastifyReply,
  work: () => Promise<{ status: number; body: unknown; resourceId?: string | null }>,
): Promise<T | undefined> {
  const context = request.vgIdempotency;
  const requirement = options.requirementFor(request.method, request.routeTemplate);
  const rawKey = headerValue(request, IDEMPOTENCY_KEY_HEADER);

  // A route where the key adds no protection: echoed for diagnosis only, and the handler runs
  // normally (SPEC-003 §4.3 last row). The echo is deliberately NOT the key itself in a log line;
  // here it is a response header the caller already knows.
  if (requirement === 'optional' || requirement === undefined) {
    if (rawKey !== undefined) reply.header(IDEMPOTENCY_KEY_ECHO_HEADER, rawKey);
    const result = await work();
    return sendResult(reply, result) as T | undefined;
  }

  // `required-if-effect` means the route MAY produce an effect depending on its body. Treating it as
  // required is the safe reading: a route that turns out not to need the key still accepts it, while
  // a route that needs it and did not receive one is refused before any work.
  if (context === undefined) {
    // No context means `beforeHandler` did not claim a key. For a required route that is either a
    // missing header (already refused below) or a wiring defect; refusing is the safe answer.
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED');
  }

  // A replayed request returns the ORIGINAL status and body, byte for byte, with the marker header.
  // A COMPLETED key replays ONLY when the body matches. A different body is a CONFLICT, not a replay
  // (SPEC-003 §4.3): returning the original response for a changed request would tell a caller their
  // new request succeeded when the effect performed was a different one.
  //
  // MEASURED DEFECT this fixes: the fingerprint was computed and STORED but never COMPARED, so a
  // changed body silently replayed the first request's 201. The store is a state machine and does not
  // know this policy; the comparison belongs at the boundary, which is here.
  if (!context.claimed) {
    const record = await options.store.begin(context.scope, context.fingerprint);
    if (record.state === 'COMPLETED' && record.record !== undefined) {
      if (record.record.fingerprint !== context.fingerprint) {
        // SPEC-003 §4.3 gives this conflict body `idempotencyKey`, `originalResourceId` and `detail`.
        // The KEY is echoed because the caller supplied it and already knows it; `originalResourceId`
        // is a resource in the caller's own tenant, which RLS already scoped. Neither is a request
        // body value, and §8.3 forbids echoing those.
        throw new ApiError('IDEMPOTENCY_KEY_REUSE', {
          idempotencyKeyHash: createHash('sha256').update(context.scope.idempotencyKey).digest('hex').slice(0, 16),
        });
      }
      reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
      return reply.code(record.record.responseStatus).send(record.record.responseBody) as T;
    }
    // The store changed under us between the hook and here; treating it as in flight is correct,
    // because another request holds the key.
    reply.header('retry-after', '5');
    throw new ApiError('IDEMPOTENCY_IN_FLIGHT', { retryAfterSeconds: 5 });
  }

  let result: { status: number; body: unknown; resourceId?: string | null };
  try {
    result = await work();
  } catch (error) {
    // The work failed BEFORE producing an effect (a handler that produced one would not throw).
    // Releasing the key is what lets the caller retry; without this the key stays in flight forever.
    await options.store.abandon(context.scope);
    throw error;
  }

  const record: IdempotencyRecord = {
    responseStatus: result.status,
    responseBody: typeof result.body === 'string' ? result.body : JSON.stringify(result.body),
    fingerprint: context.fingerprint,
    resourceId: result.resourceId ?? null,
    traceparent: headerValue(request, 'traceparent') ?? null,
    completedAtMs: (options.now ?? Date.now)(),
  };
  await options.store.complete(context.scope, record);
  return sendResult(reply, result) as T | undefined;
}

function sendResult(
  reply: FastifyReply,
  result: { status: number; body: unknown },
): FastifyReply {
  return reply.code(result.status).send(result.body);
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value.length === 0 ? undefined : value;
}

export function installIdempotency(app: FastifyInstance, options: IdempotencyPluginOptions): void {
  app.decorateRequest('vgIdempotency', undefined);
  app.decorateRequest('routeTemplate', '');

  /**
   * Claim the key BEFORE the handler runs.
   *
   * `onRequest` rather than `preHandler`, so the claim happens before body parsing completes and
   * therefore before any expensive validation. The body fingerprint is computed later, in
   * `onRequest`'s sibling below, because the body is not parsed yet at this point.
   */
  app.addHook('onRequest', async (request) => {
    request.routeTemplate = normalizeRouteTemplate(request);
    const requirement = options.requirementFor(request.method, request.routeTemplate);
    if (requirement === 'optional' || requirement === undefined) return;

    const rawKey = headerValue(request, IDEMPOTENCY_KEY_HEADER);
    if (rawKey === undefined) {
      // SPEC-003 §4.1: refused BEFORE any work, so "produces no state change" is true.
      throw new ApiError('IDEMPOTENCY_KEY_REQUIRED');
    }
    let key: string;
    try {
      key = validateIdempotencyKey(rawKey);
    } catch {
      throw new ApiError('IDEMPOTENCY_KEY_MALFORMED');
    }

    if (request.vgContext === undefined) {
      // Identity runs after this hook's registration only if ordered so; a key with no tenant cannot
      // be scoped. The identity plugin refuses first in practice, but this keeps the failure honest
      // rather than scoping a key to an empty tenant.
      throw new ApiError('TOKEN_MISSING');
    }

    request.vgIdempotency = {
      scope: {
        // Taken from the context, which the identity plugin already branded and validated. The
        // boundary must not mint a tenant: it would be a second place the shape could be loosened.
        tenantId: request.vgContext.tenantId,
        method: request.method,
        routeTemplate: request.routeTemplate,
        idempotencyKey: key,
      },
      // The fingerprint is filled in by `preValidation`, once the body exists. An empty value here
      // would make every request with this key look like a replay of the first.
      fingerprint: '',
      claimed: false,
    };
  });

  /**
   * Compute the fingerprint and claim the key, now that the body is parsed.
   *
   * `preValidation` runs after body parsing and before the handler's schema validation, which is the
   * earliest point the body is available.
   */
  app.addHook('preValidation', async (request, reply) => {
    const context = request.vgIdempotency;
    if (context === undefined) return;
    const requirement = options.requirementFor(request.method, request.routeTemplate);
    if (requirement === 'optional' || requirement === undefined) return;

    const fingerprint = fingerprintOf(request.body ?? null);
    const outcome = await options.store.begin(context.scope, fingerprint);

    if (outcome.state === 'COMPLETED' && outcome.record !== undefined) {
      // Do not replay here: `withIdempotency` owns the response so the replay path is one place.
      request.vgIdempotency = { ...context, fingerprint, claimed: false };
      return;
    }
    if (outcome.state === 'IN_FLIGHT') {
      reply.header('retry-after', '5');
      throw new ApiError('IDEMPOTENCY_IN_FLIGHT', { retryAfterSeconds: 5 });
    }
    // NEW: this request claimed the key and must complete or abandon it.
    request.vgIdempotency = { ...context, fingerprint, claimed: true };
  });

  /**
   * Normalise a concrete path into its route TEMPLATE.
   *
   * SPEC-003 §4.2 scopes uniqueness by route TEMPLATE, not by resolved path: `/v1/cases/A/notes` and
   * `/v1/cases/B/notes` are the same route, so the same key on the same route for a different case is
   * a conflict, which is what the caller needs to be told. Using the resolved path would make every
   * case a different scope and silently defeat the protection.
   */
  function normalizeRouteTemplate(request: FastifyRequest): string {
    // Fastify exposes the matched pattern; falling back to the resolved url would scope by path.
    const fromRouter = (request as unknown as { routeOptions?: { url?: string } }).routeOptions?.url;
    if (typeof fromRouter === 'string' && fromRouter.length > 0) return fromRouter;
    return request.url.split('?')[0] ?? request.url;
  }
}
