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
    windowMs: Number(process.env.JOB_WORKER_WINDOW_MS ?? 15000),
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

// keycloak-jwks: WIRED WHEN AN ISSUER IS CONFIGURED, through the real probe — OIDC discovery plus JWKS retrieval over
// TLS, with NO TOKEN MINTED, which is the declared action. The CA is supplied by the environment through
// NODE_EXTRA_CA_CERTS because the issuer here is a disposable local Keycloak with a self-signed certificate; TLS
// verification is NOT disabled, and a run without the CA fails (measured: "fetch failed" / DEPTH_ZERO_SELF_SIGNED_CERT).
const keycloakIssuer = process.env.VG_KEYCLOAK_ISSUER ?? "";
if (keycloakIssuer.trim().length > 0) {
  clients.keycloakJwks = probes.keycloakJwksProbe({
    discover: async () => {
      const discovery = await fetch(`${keycloakIssuer}/realms/master/.well-known/openid-configuration`);
      if (!discovery.ok) throw new Error(`discovery answered HTTP ${String(discovery.status)}`);
      const document = await discovery.json();
      if (typeof document.jwks_uri !== "string") throw new Error("the discovery document carries no jwks_uri");
      const jwks = await fetch(document.jwks_uri);
      if (!jwks.ok) throw new Error(`the JWKS answered HTTP ${String(jwks.status)}`);
      const keys = await jwks.json();
      return { issuer: String(document.issuer ?? ""), keys: Array.isArray(keys.keys) ? keys.keys.length : 0 };
    },
  });
}

// provider-transport: WIRED WHEN A DECLARED TRANSPORT HAS A CREDENTIAL, through the real probe — a READ-ONLY request with
// no body and NO FORM WRITE, which is the declared action of §7.2 and does not violate §6.7. The transport is chosen by
// which declared credential is present, so no new variable name is invented: Stripe (`STRIPE_SECRET_KEY`) first, then
// the search transport (`SEARCH_API_KEY`, also accepted as `SERPAPI_API_KEY` because that is the name the operator's
// file uses), then Click2Mail (`CLICK2MAIL_USERNAME` + `CLICK2MAIL_PASSWORD`, which is the credential SHAPE Click2Mail
// documents — a Basic auth pair, not a single key).
//
// THE INDUCED PHASE FORCES AN AUTH REJECTION ON PURPOSE, which is exactly what §7.4 step 2 prescribes for this
// dependency: `VG_PROVIDER_FORCE_BAD_CREDENTIAL=1` sends a deliberately wrong credential so the SAME read-only request is
// refused, without touching the account and without stopping anything at the provider. NO CREDENTIAL VALUE IS EVER
// PRINTED by this driver.
const forceBadCredential = process.env.VG_PROVIDER_FORCE_BAD_CREDENTIAL === "1";
const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
const searchKey = process.env.SEARCH_API_KEY ?? process.env.SERPAPI_API_KEY ?? "";
const click2mailUser = process.env.CLICK2MAIL_USERNAME ?? "";
const click2mailPassword = process.env.CLICK2MAIL_PASSWORD ?? "";
// A WRONG CREDENTIAL OF THE SAME SHAPE, so the provider rejects it as authentication rather than as a malformed request.
const bad = (value) => (value.length === 0 ? "invalid-credential" : `${value.slice(0, 4)}-invalid-credential`);
if (stripeKey.trim().length > 0) {
  clients.providerTransport = probes.providerTransportProbe({
    name: "stripe",
    reachability: async () => {
      const key = forceBadCredential ? bad(stripeKey) : stripeKey;
      const response = await fetch("https://api.stripe.com/v1/balance", { headers: { authorization: `Bearer ${key}` }, redirect: "manual", signal: AbortSignal.timeout(8000) });
      return { status: response.status };
    },
  });
} else if (searchKey.trim().length > 0) {
  clients.providerTransport = probes.providerTransportProbe({
    name: "search_api_key",
    reachability: async () => {
      const key = forceBadCredential ? bad(searchKey) : searchKey;
      const response = await fetch(`https://serpapi.com/account?api_key=${encodeURIComponent(key)}`, { redirect: "manual", signal: AbortSignal.timeout(8000) });
      return { status: response.status };
    },
  });
} else if (click2mailUser.trim().length > 0 && click2mailPassword.trim().length > 0) {
  clients.providerTransport = probes.providerTransportProbe({
    name: "click2mail",
    reachability: async () => {
      const user = forceBadCredential ? bad(click2mailUser) : click2mailUser;
      const password = forceBadCredential ? bad(click2mailPassword) : click2mailPassword;
      const basic = Buffer.from(`${user}:${password}`).toString("base64");
      const response = await fetch("https://stage-rest.click2mail.com/molpro/credit", { headers: { accept: "application/xml", authorization: `Basic ${basic}` }, redirect: "manual", signal: AbortSignal.timeout(8000) });
      return { status: response.status };
    },
  });
}
// WITH NO CREDENTIAL THE PROBE IS NOT WIRED, and the row says so rather than reporting a pass: a reachability check
// against a server this repository started would prove the check runs, not that a PROVIDER is reachable.
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
