const { pathToFileURL } = await import("node:url");
const probes = await import(pathToFileURL(`${process.cwd()}/src/adapters/observability/dependency-probes.ts`).href);
const clients = {};

// postgresql: a real pooled round trip whose session role must be the application role (§7.2).
const dsn = process.env.VG_TEST_DSN_APP ?? "";
if (dsn.trim().length > 0) {
  const pg = await import("pg");
  // WARM THE POOL OUTSIDE THE PROBE, WHICH IS §7.2's OWN WORD: it declares a POOLED connection with a 300 ms probe
  // timeout, so the cost of ESTABLISHING the connection belongs to startup and not to the probe. MEASURED: with a cold
  // pool the control run reported TIMEOUT for postgresql under gate load while the same probe took 43 ms standalone — a
  // healthy dependency reported as broken, which would have been read as a product defect. This warm-up is behaviour,
  // not a threshold change: the timeout is unchanged at 300 ms.
  const pool = new pg.default.Pool({ connectionString: dsn, max: 1, connectionTimeoutMillis: 250 });
  await pool.query("SELECT 1").catch(() => undefined);
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

// object-store: WIRED WHEN THE ENVIRONMENT PROVIDES AN ENDPOINT AND CREDENTIALS, through the real SigV4 probe — the same
// declared action (HeadBucket plus a signed GetObject whose content must match the expected digest). When the environment
// provides nothing, the probe that REFUSES TO PRETEND is used instead, so the row reads UNAVAILABLE rather than pass.
const objectStoreEndpoint = process.env.VG_OBJECT_STORE_ENDPOINT ?? "";
if (objectStoreEndpoint.trim().length > 0) {
  const { createHash } = await import("node:crypto");
  const crypto = await import("node:crypto");
  const payload = "vanishgraph object-store probe payload";
  const region = process.env.VG_OBJECT_STORE_REGION ?? "us-east-1";
  const bucket = process.env.VG_OBJECT_STORE_BUCKET ?? "vanishgraph-probe";
  const key = process.env.VG_OBJECT_STORE_KEY ?? "readiness/probe-object";
  const credentials = {
    accessKeyId: process.env.VG_OBJECT_STORE_ACCESS_KEY ?? "",
    secretAccessKey: process.env.VG_OBJECT_STORE_SECRET_KEY ?? "",
  };
  const sign = (method, canonicalPath, body) =>
    probes.signS3Request({ method, endpoint: objectStoreEndpoint, canonicalPath, region, ...credentials, at: new Date(), ...(body === undefined ? {} : { payload: body }) });
  // THE PROBE OBJECT IS WRITTEN THROUGH THE SAME SIGNER THE PROBE READS WITH, so the fixture cannot drift from the code
  // under test. A PUT that fails is reported loudly: a probe that fails because its fixture is missing would be
  // indistinguishable from a dependency that is down.
  try {
    const mk = sign("PUT", `/${bucket}`);
    const created = await fetch(mk.url, { method: "PUT", headers: mk.headers });
    const sp = sign("PUT", `/${bucket}/${key}`, payload);
    const put = await fetch(sp.url, { method: "PUT", headers: { ...sp.headers, "content-length": String(Buffer.byteLength(payload)) }, body: payload });
    if (put.status >= 400) console.error(`object-store fixture: PUT answered ${put.status}`);
    if (created.status >= 400 && created.status !== 409) console.error(`object-store fixture: bucket create answered ${created.status}`);
    clients.objectStore = probes.objectStoreProbe({
      endpoint: objectStoreEndpoint,
      bucket,
      region,
      ...credentials,
      probeKey: key,
      expectedDigest: createHash("sha256").update(payload).digest("hex"),
      fetchImpl: fetch,
    });
    void crypto;
  } catch (error) {
    console.error(`object-store fixture: ${error.message}`);
  }
} else {
  clients.objectStore = probes.objectStoreProbeUnavailable;
}

// keycloak-jwks and provider-transport: no issuer and no provider entitlement are provisioned in this environment, and
// the stage reports that rather than faking a probe.
const runner = probes.createProbeRunner({ clients });
const evaluation = await runner.evaluate();
for (const check of evaluation.checks) {
  // THE NAME MAPPING IS THE DRIVER'S OWN DEFECT SOURCE AND WAS MEASURED: object-store was missing from the ternary that
  // used to sit here, so a WIRED object-store client was still reported UNAVAILABLE and its induction block never fired
  // — the verdict read "not provisioned" while the probe was in fact passing. The mapping is now exhaustive.
  const CLIENT_KEY = { "job-worker": "jobWorker", "keycloak-jwks": "keycloakJwks", "provider-transport": "providerTransport", "object-store": "objectStore" };
  const state = clients[CLIENT_KEY[check.name] ?? check.name] === undefined ? "UNAVAILABLE" : "PROVISIONED";
  console.log(`${check.name}|${state}|${check.status}|${check.reasonCode ?? "-"}|${check.latencyMs}ms|${check.detail.replace(/\|/g, "/")}`);
}
console.log(`overall|${evaluation.dependencyState}|${evaluation.totalLatencyMs}ms`);
// THE DRIVER EXITS EXPLICITLY. MEASURED: with a CONNECTED valkey client the process never returned to the shell, because an open socket keeps the event loop alive, and the stage hung until the executor killed it at its 600-second cap - the control run never finished and the induction never ran. Closing the clients is not enough on its own when a client is mid-retry, so the exit is explicit.
process.exit(0);
