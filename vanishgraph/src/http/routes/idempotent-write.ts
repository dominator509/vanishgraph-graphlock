/**
 * Idempotent write support for the routes that declare `Idempotency **Required**` (SPEC-003 §4).
 *
 * WHY THIS MODULE EXISTS. Five route modules had grown their own copy of this four-line wrapper — `sources.ts`,
 * `appeals.ts`, `deadlines.ts`, `exposures.ts` and now `cases.ts` — and copies drift. The drift that matters is
 * not cosmetic: `withIdempotency` is what makes a replayed request return the ORIGINAL response instead of
 * performing the effect a second time (§4.3), and a route whose copy forgot `h.withTenant(work)` would run the
 * handler OUTSIDE the tenant transaction — no `app.tenant_id`, therefore no rows under FORCE RLS, therefore a
 * silently empty read rather than an error. One definition removes the possibility.
 *
 * The work function returns the same `{status, body, resourceId}` shape every write route already produces, so
 * this helper changes no route's behaviour — it only removes the second, third, fourth and fifth spelling of it.
 */

import type { HandlerContext } from './handler-context.ts';
import { withIdempotency } from '../plugins/idempotency.ts';
import type { TenantTransaction } from '../plugins/tenancy.ts';

/** What a write handler produces. `resourceId` feeds the plugin's replay bookkeeping and the response's ids. */
export interface WriteResult {
  readonly status: number;
  readonly body: unknown;
  readonly resourceId?: string | null;
}

/**
 * Run `work` under idempotency control.
 *
 * The order is the contract's: the plugin checks the `Idempotency-Key` header and claims it BEFORE the tenant
 * transaction opens, so a replayed request never opens one and a failing handler abandons its claim rather than
 * leaving the key in flight (asserted by `tests/contract/idempotency.test.ts`).
 */
export async function idempotentWrite<R = unknown>(
  h: HandlerContext,
  work: (tx: TenantTransaction) => Promise<WriteResult>,
): Promise<R> {
  return withIdempotency<R>(h.request, h.request.server.vgIdempotency, h.reply, () =>
    h.withTenant(work),
  ) as Promise<R>;
}
