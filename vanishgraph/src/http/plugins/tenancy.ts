/**
 * Tenancy (SPEC-003 §2.4, SPEC-002 §3 RLS-1…RLS-4, SPEC-006 §7.1 row 13).
 *
 * The rule this plugin exists to enforce: **`tenantId` comes from the verified token and is pushed
 * into the PostgreSQL RLS session variable inside the request transaction.** Tenant isolation is
 * therefore not application code that a handler could forget — it is a database policy that a
 * handler cannot bypass, because the connection role is not the table owner and lacks `BYPASSRLS`
 * (SPEC-002 RLS-4).
 *
 * THE FAIL-CLOSED REQUIREMENT (SPEC-006 §7.1 row 13): when no transaction is open, the plugin must
 * REFUSE rather than run an unscoped query. This is the subtle one. `current_setting('app.tenant_id',
 * true)` returns NULL outside a transaction, and a policy comparing `tenant_id = NULL` matches
 * nothing — which looks safe, until someone writes a query the policy does not cover, or the policy
 * is momentarily absent during a migration. Refusing is the only answer that does not depend on
 * every future query being policy-covered.
 *
 * There is no "system" tenant and no unscoped mode. A background job that must read across tenants is
 * a migration-role operation, not an HTTP request, and it does not pass through here.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiError } from './error-handler.ts';
import type { RequestContext } from '../../application/contracts/request-context.ts';

// Re-exported so a route module needs one import for the context type it passes around, rather
// than reaching into the application layer for it directly.
export type { RequestContext };

/**
 * A tenant-scoped transaction.
 *
 * `sql` runs inside a transaction in which `app.tenant_id` has been set with `SET LOCAL`, so the
 * setting is reverted automatically at COMMIT or ROLLBACK and cannot leak to the next request on a
 * pooled connection.
 */
export interface TenantTransaction {
  /** Run one statement inside the tenant-scoped transaction. */
  query<T = unknown>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

/** The injected data-access port. `src/http` never owns a connection pool. */
export interface TenantTransactionRunner {
  /**
   * Open a transaction, set `app.tenant_id` with `SET LOCAL`, run `fn`, then COMMIT.
   *
   * A throw from `fn` must ROLLBACK. The implementation owns that; this interface states it so an
   * adapter cannot quietly commit a partial write.
   */
  withTenantTransaction<T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T>;

  /**
   * Open a transaction scoped by a WEBHOOK CAPABILITY instead of a tenant, run `fn`, then COMMIT.
   *
   * WHY THIS EXISTS, and why it is not a hole in tenant isolation. §6's ingress is the only surface with no bearer
   * token: the capability in the request path IS what establishes the tenant, so the lookup that resolves it cannot
   * itself run under a tenant. Migration `0032` gives `webhook_binding` a second, narrower policy — an unbound
   * session sees ONLY the row whose token hash (or provider key id) it has already presented — and this method is
   * how that value is set with `SET LOCAL`, exactly as `withTenantTransaction` sets the tenant.
   *
   * THE CAPABILITY IS A CLOSED UNION, not a variable name: a caller cannot use this to set `app.tenant_id` or any
   * other setting, so there is no path by which a route hands itself a different binding than the one it proved.
   */
  withCapabilityTransaction<T>(
    capability: 'token_hash' | 'provider_key',
    value: string,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface TenancyPluginOptions {
  readonly runner: TenantTransactionRunner;
}

/** The value `SET LOCAL` is bound to. Validated so a malformed tenant cannot reach the database. */
const TENANT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refuse to proceed without a usable tenant.\n *\n * The TenantId constructor already validates the shape, so the re-check here is a DEFENCE IN DEPTH\n * for a context built by something other than the identity plugin — a test double, or a future\n * code path. It costs one regex and closes the case where an unvalidated tenant reaches the database.
 *
 * Called by any route that needs data. It is a separate function from the plugin so the refusal is
 * testable without a database, and so a route cannot "just this once" skip it.
 */
export function requireTenantContext(request: FastifyRequest): RequestContext {
  if (request.vgContext === undefined) {
    // No identity means no tenant. This is the fail-closed path SPEC-006 §7.1 row 13 requires: an
    // unscoped query must be impossible, not merely discouraged.
    throw new ApiError('TOKEN_MISSING');
  }
  const { tenantId } = request.vgContext;
  if (tenantId.value.trim().length === 0) {
    // The token verifier already refuses a missing `tenant_id`, so reaching here means a context was
    // constructed by something other than the verifier. Refusing is the only safe reading.
    throw new ApiError('TOKEN_INVALID_CLAIMS', { field: 'tenant_id' });
  }
  if (!TENANT_ID_SHAPE.test(tenantId.value)) {
    // A tenant id that is not a UUID cannot be a row in `tenant(id)`, which is `uuid`. Binding it
    // would produce a cast error deep in a query; refusing here names the problem at the boundary.
    throw new ApiError('TOKEN_INVALID_CLAIMS', { field: 'tenant_id' });
  }
  return request.vgContext;
}

/**
 * Run `fn` in a transaction scoped to the caller's tenant.
 *
 * `SET LOCAL` is used rather than `SET` because it is transaction-scoped: with `SET`, a pooled
 * connection would keep the previous request's tenant and the next caller would read another
 * tenant's rows. That is the single most dangerous mistake available in this file, so the adapter
 * contract requires `SET LOCAL` and the test asserts the local-setting behaviour against a real
 * database in EP-003's suite.
 */
export async function withRequestTenant<T>(
  request: FastifyRequest,
  options: TenancyPluginOptions,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  const context = requireTenantContext(request);
  return options.runner.withTenantTransaction(context.tenantId.value, fn);
}

export function installTenancy(app: FastifyInstance, options: TenancyPluginOptions): void {
  // No hook is registered. Tenancy is applied by the CALL SITE through `withRequestTenant`, because
  // a transaction's lifetime must be the handler's decision: an `onRequest` hook that opened one
  // would hold it across response serialisation and across any await the handler performs, and a
  // long-lived transaction is how a connection pool is exhausted.
  //
  // The plugin is installed anyway so the runner is attached once and a route cannot construct its
  // own unscoped access path.
  app.decorate('vgTenancy', options);
}

declare module 'fastify' {
  interface FastifyInstance {
    vgTenancy: TenancyPluginOptions;
  }
}
