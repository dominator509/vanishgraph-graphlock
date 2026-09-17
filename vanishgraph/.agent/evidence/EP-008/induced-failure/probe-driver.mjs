const { pathToFileURL } = await import("node:url");
const probes = await import(pathToFileURL(`${process.cwd()}/src/adapters/observability/dependency-probes.ts`).href);
const clients = {};

// postgresql: a real pooled round trip whose session role must be the application role (§7.2).
const dsn = process.env.VG_TEST_DSN_APP ?? "";
if (dsn.trim().length > 0) {
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: dsn, max: 1, connectionTimeoutMillis: 250 });
  clients.postgresql = probes.postgresProbe({
    querySessionRole: async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT 1");
        const role = await client.query("SELECT current_user AS role");
        await client.query("ROLLBACK");
        return String(role.rows[0]?.role ?? "");
      } finally {
        client.release();
      }
    },
    expectedRole: process.env.VG_EXPECTED_APP_ROLE ?? "vg_app",
  });
}

// valkey: PING plus a write/read/delete round trip (§7.2). Provisioned only when VALKEY_URL is set AND reachable.
const valkeyUrl = process.env.VALKEY_URL ?? "";
if (valkeyUrl.trim().length > 0) {
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(valkeyUrl, { lazyConnect: true, connectTimeout: 150, maxRetriesPerRequest: 1, enableOfflineQueue: false, retryStrategy: () => null });
  clients.valkey = probes.valkeyProbe({
    roundTrip: async (key) => {
      await redis.connect().catch(() => undefined);
      await redis.set(key, key.split(":").pop() ?? "", "EX", 5);
      const value = await redis.get(key);
      await redis.del(key);
      return String(value ?? "");
    },
  });
}

// job-worker: heartbeat freshness from the job queue table, read through the same pooled connection.
if (dsn.trim().length > 0) {
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: dsn, max: 1, connectionTimeoutMillis: 200 });
  clients.jobWorker = probes.jobWorkerProbe({
    windowMs: 60_000,
    freshHeartbeats: async () => {
      // THE TABLE NAME IS READ FROM THE MIGRATION THAT DECLARES IT (`job_worker`, migration 0008), NOT GUESSED.
      // MEASURED: the first version of this driver queried `job_worker_heartbeat` and the control run reported
      // `relation "job_worker_heartbeat" does not exist` — a driver defect that looked like a dependency failure.
      const result = await pool.query("SELECT count(*)::int AS fresh FROM job_worker WHERE heartbeat_at > now() - interval '60 seconds'");
      return Number(result.rows[0]?.fresh ?? 0);
    },
  });
}

// object-store: NOT WIRED ANYWHERE IN THIS REPOSITORY — the declared action needs S3 request signing (M5 evidence).
clients.objectStore = probes.objectStoreProbeUnavailable;

// keycloak-jwks and provider-transport: no issuer and no provider entitlement are provisioned in this environment, and
// the stage reports that rather than faking a probe.
const runner = probes.createProbeRunner({ clients });
const evaluation = await runner.evaluate();
for (const check of evaluation.checks) {
  const state = clients[check.name === "job-worker" ? "jobWorker" : check.name === "keycloak-jwks" ? "keycloakJwks" : check.name === "provider-transport" ? "providerTransport" : check.name] === undefined ? "UNAVAILABLE" : "PROVISIONED";
  console.log(`${check.name}|${state}|${check.status}|${check.reasonCode ?? "-"}|${check.latencyMs}ms|${check.detail.replace(/\|/g, "/")}`);
}
console.log(`overall|${evaluation.dependencyState}|${evaluation.totalLatencyMs}ms`);
// THE DRIVER EXITS EXPLICITLY. MEASURED: with a CONNECTED valkey client the process never returned to the shell, because an open socket keeps the event loop alive, and the stage hung until the executor killed it at its 600-second cap - the control run never finished and the induction never ran. Closing the clients is not enough on its own when a client is mid-retry, so the exit is explicit.
process.exit(0);
