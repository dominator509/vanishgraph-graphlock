/**
 * The tenant-scoped PostgreSQL transaction runner (SPEC-003 §2.4, SPEC-002 RLS-1…RLS-4).
 *
 * WHAT THIS FILE IS: the one place a request's database work happens. It replaces the
 * `unavailableTransactionRunner` stub that EP-004 M3 installed, which refused every call because no
 * pool existed yet.
 *
 * THE PROPERTY THAT MATTERS MOST is `SET LOCAL`. Two statements look equivalent and are not:
 *
 *     SET app.tenant_id = '...'          -- session-scoped: survives COMMIT
 *     SET LOCAL app.tenant_id = '...'    -- transaction-scoped: reverted at COMMIT/ROLLBACK
 *
 * With `SET`, a pooled connection keeps the previous request's tenant, and the NEXT caller reads
 * another tenant's rows. That is the single most dangerous mistake available in this file, and it is
 * invisible in a single-request test — which is why the runner takes a connection from a pool, sets
 * the tenant with `set_config(..., true)` (the function form of `SET LOCAL`), and always ends the
 * transaction before releasing the connection.
 *
 * WHY THE TENANT IS PARAMETERISED AND NOT INTERPOLATED: `set_config` takes the value as a bind
 * parameter, so a tenant value cannot terminate the statement. The value is also already a branded
 * `TenantId` whose constructor validated it, so this is defence in depth rather than the only guard.
 *
 * WHY `pg` AND NOT THE PSQL HELPER: `psql.ts` spawns a process per statement, which is correct for a
 * gate and wrong for a server. A request path needs a pool. The `pg` driver is already an exact-pinned
 * dependency (M1) and this is the adapter layer, where a driver belongs.
 */

import { Pool, type PoolClient } from 'pg';

import type { TenantTransaction, TenantTransactionRunner } from '../../http/plugins/tenancy.ts';
import type { Dsn } from '../../infrastructure/database/psql.ts';

/** A DSN the driver can use. Built from the parsed shape so a password never appears in a log. */
function connectionConfig(dsn: Dsn): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} {
  return {
    host: dsn.host,
    port: Number(dsn.port),
    database: dsn.database,
    user: dsn.user,
    password: dsn.password,
  };
}

export interface PostgresRunnerOptions {
  readonly dsn: Dsn;
  /** Maximum pooled connections. Small by default: each tenant transaction holds one briefly. */
  readonly maxConnections?: number;
  /** Statement timeout in milliseconds, applied per transaction. */
  readonly statementTimeoutMs?: number;
}

export class PostgresTenantRunner implements TenantTransactionRunner {
  private readonly pool: Pool;
  private readonly statementTimeoutMs: number;

  constructor(options: PostgresRunnerOptions) {
    this.pool = new Pool({
      ...connectionConfig(options.dsn),
      max: options.maxConnections ?? 10,
      // A pool that queues forever turns a slow database into an unbounded memory growth. Refusing
      // after a bounded wait produces a 503, which is honest, instead of a request that never ends.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    this.statementTimeoutMs = options.statementTimeoutMs ?? 15_000;
  }

  /**
   * Run `fn` inside a transaction scoped to `tenantId`.
   *
   * The sequence is deliberate:
   *   1. BEGIN, so the setting has a transaction to be local to.
   *   2. `set_config('app.tenant_id', $1, true)` — the `true` is what makes it LOCAL.
   *   3. `SET LOCAL statement_timeout`, so a runaway query cannot hold a connection indefinitely.
   *   4. run the work.
   *   5. COMMIT, or ROLLBACK on any throw.
   *   6. release the connection only after the transaction has ended.
   *
   * A failure anywhere after BEGIN reaches the `catch`, so a partial write cannot commit. The
   * `finally` releases the connection exactly once, including when the rollback itself throws — a
   * leaked connection would eventually exhaust the pool and take the service down.
   */
  async withCapabilityTransaction<T>(
    capability: 'token_hash' | 'provider_key',
    value: string,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    // The setting name is CHOSEN FROM A CLOSED MAP, so a caller cannot pass a variable name — `app.tenant_id`
    // included — and thereby bind a different context than the one it proved. The migration's capability policy
    // reads exactly these two names.
    const setting = capability === 'token_hash' ? 'app.webhook_token_hash' : 'app.webhook_provider_key';
    const client: PoolClient = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [setting, value]);
      await client.query(`SET LOCAL statement_timeout = ${String(this.statementTimeoutMs)}`);
      const tx: TenantTransaction = {
        query: async <R = unknown>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }> => {
          const result = await client.query(text, params === undefined ? undefined : [...params]);
          return { rows: result.rows as R[] };
        },
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      committed = true;
      return result;
    } catch (error) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Same rule as `withTenantTransaction`: the original failure is the one the caller needs.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async withTenantTransaction<T>(
    tenantId: string,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      // Parameterised: the tenant value is a bind parameter, never concatenated into the statement.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query(`SET LOCAL statement_timeout = ${String(this.statementTimeoutMs)}`);

      const tx: TenantTransaction = {
        query: async <R = unknown>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }> => {
          const result = await client.query(text, params === undefined ? undefined : [...params]);
          return { rows: result.rows as R[] };
        },
      };

      const value = await fn(tx);
      await client.query('COMMIT');
      committed = true;
      return value;
    } catch (error) {
      if (!committed) {
        // A rollback failure must not mask the original error: the caller needs the reason the work
        // failed, not the reason the cleanup did. The rollback failure is swallowed deliberately and
        // the connection is still released.
        try {
          await client.query('ROLLBACK');
        } catch {
          // Intentionally empty: see above.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Close the pool. Used by the entry point's shutdown path and by tests. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Pool visibility for readiness probes and tests. Reads only counters, never a connection. */
  poolStats(): { readonly total: number; readonly idle: number; readonly waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  /**
   * Acquire a connection from THIS runner's pool and read `app.tenant_id` WITHOUT setting it.
   *
   * WHAT THIS IS FOR, and why it is not a general-purpose escape hatch: it lets a test observe the
   * property `SET LOCAL` provides — that a connection returned to this pool does not still carry a
   * tenant. The test must acquire from the RUNNER'S OWN pool: an earlier version used a separate pool,
   * inspected a connection the runner had never touched, and passed even when the runner was
   * sabotaged to use session-scoped `set_config` (measured).
   *
   * It deliberately does not BEGIN, set anything, or run caller-supplied work. It reads ONE setting
   * and releases. Exposing a general raw-query method here would let a caller run an UNSCOPED query,
   * which is precisely what this class exists to make impossible.
   *
   * Returns the raw setting: `null` when never set, `''` when set and reverted, a tenant id when the
   * setting leaked.
   */
  async observeReleasedConnectionSetting(): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ value: string | null }>(
        "SELECT current_setting('app.tenant_id', true) AS value",
      );
      return result.rows[0]?.value ?? null;
    } finally {
      client.release();
    }
  }
}

/**
 * A readiness probe backed by a REAL query.
 *
 * `SELECT 1` inside a transaction proves three things at once: the pool can hand out a connection,
 * the credentials work, and the server answers. A probe that only checked configuration would report
 * ready for a database that is down — exactly the static-200 failure VG-API-059 forbids.
 *
 * The tenant is set to a well-formed but arbitrary UUID because `SELECT 1` reads no table; RLS is not
 * involved, and using a real tenant id here would be a needless coupling.
 */
export async function postgresReadinessProbe(
  runner: PostgresTenantRunner,
): Promise<{ name: string; ok: boolean; reason?: string; latencyMs?: number }> {
  const started = Date.now();
  try {
    await runner.withTenantTransaction('00000000-0000-4000-8000-000000000000', async (tx) => {
      await tx.query('SELECT 1');
    });
    return { name: 'postgres', ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    // The error's own message is NOT propagated: a driver error can carry a host, a port, a user
    // name or a connection string, and this result reaches a `/ready` response body.
    void error;
    return {
      name: 'postgres',
      ok: false,
      latencyMs: Date.now() - started,
      reason: 'connection or query failed; see server logs',
    };
  }
}
