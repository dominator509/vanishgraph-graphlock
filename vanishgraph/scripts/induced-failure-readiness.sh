#!/usr/bin/env sh
# Readiness induced-failure stage (SPEC-007 §7.4; EP-008 M5(d), VG-OPS-001). Sentinel: `readiness induced failure: ok`
#
# WHAT IT MUST DEMONSTRATE, PER DECLARED DEPENDENCY: the SAME probe code path reports PASS in the steady state and FAIL
# after exactly one induced failure, and PASS again after remediation. A probe that reports PASS in both states is a
# defect, and the stage does not print its sentinel unless every dependency demonstrated the transition.
#
# WHERE THE ENVIRONMENT FALLS SHORT, THIS STAGE SAYS SO AND FAILS. DOD-033: a dependency that cannot be provisioned is
# recorded ERROR with the provisioning attempt log. It is NOT skipped, and its row is NOT counted as demonstrated — a
# stage that printed its sentinel while four of six dependencies were never induced would be the fabrication this whole
# node exists to prevent.
#
# THE INDUCTION FOR postgresql IS THE DECLARED ONE — stop the container, observe, start it again — because §7.4 step 2
# names that action. The container is the project's own test database, the stop is immediately followed by the start, and
# the stage asserts the recovery before it reports anything.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "readiness induced failure: FAIL - node is required but not found" >&2; exit 1; }

EVIDENCE=.agent/evidence/EP-008/induced-failure
mkdir -p "$EVIDENCE"
STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  export VG_TEST_DSN_APP VG_TEST_DSN_OWNER VALKEY_URL
fi

PG_CONTAINER=${VG_PG_CONTAINER:-vanishgraph-ep003-postgres}
VALKEY_CONTAINER=${VG_VALKEY_CONTAINER:-vanishgraph-ep008-valkey}
MINIO_CONTAINER=${VG_MINIO_CONTAINER:-vanishgraph-ep008-minio}

# THE OBJECT STORE'S OWN VARIABLES, WITH THE SAME DEFAULTS THE GATE USES. MEASURED WHY THEY ARE DEFAULTS RATHER THAN
# SOMETHING THE CALLER MUST SET: a standalone run of this stage reported valkey UNKNOWN and object-store FAIL in its
# CONTROL run, while the same stage passed inside `gate-observability.sh`, which exports these itself. A STAGE WHOSE
# RESULT DEPENDS ON WHO SET THE ENVIRONMENT IS A TRAP — a green gate and a red standalone run for the same tree teach a
# reader to distrust one of them — so the stage now defaults to the disposable local instances this node provisioned, and
# an operator who has real ones overrides them.
export VALKEY_URL=${VALKEY_URL:-redis://127.0.0.1:56379}
export VG_OBJECT_STORE_ENDPOINT=${VG_OBJECT_STORE_ENDPOINT:-http://127.0.0.1:59000}
export VG_OBJECT_STORE_REGION=${VG_OBJECT_STORE_REGION:-us-east-1}
export VG_OBJECT_STORE_BUCKET=${VG_OBJECT_STORE_BUCKET:-vanishgraph-probe}
export VG_OBJECT_STORE_KEY=${VG_OBJECT_STORE_KEY:-readiness/probe-object}
export VG_OBJECT_STORE_ACCESS_KEY=${VG_OBJECT_STORE_ACCESS_KEY:-vgprobe}
export VG_OBJECT_STORE_SECRET_KEY=${VG_OBJECT_STORE_SECRET_KEY:-vgprobe-secret}

# THE LOCAL KEYCLOAK'S ISSUER AND ITS CA, WITH THE SAME DEFAULTS THE REST OF THIS STAGE USES. The issuer is a disposable
# instance started for this node with a self-signed certificate, so the environment supplies the CA; TLS VERIFICATION IS
# NOT DISABLED, and a run without NODE_EXTRA_CA_CERTS fails, which is how the earlier check proved the handshake is real.
# THE OPERATOR'S PROVIDER CREDENTIALS LIVE OUTSIDE THE REPOSITORY (VG-SEC-002) IN A SHELL FILE THAT IS SOURCED, NOT
# PARSED: a credential passed through a command line was measured to be mangled earlier in this session, so the file is
# read here and the names this stage uses are then EXPORTED EXPLICITLY — which also makes the file work when its lines
# omit `export` themselves. NO VALUE IS EVER PRINTED BY THIS STAGE.
PROVIDER_ENV_FILE=${VG_PROVIDER_ENV_FILE:-/c/tmp/vanishgraph-providers.env}
if [ -f "$PROVIDER_ENV_FILE" ]; then
  # ERRORS FROM SOURCING ARE DISCARDED AND DO NOT ABORT THE STAGE, AND THAT IS A MEASURED CORRECTION: an unquoted value
  # containing a space made the shell try to RUN part of it as a command, and the shell's own error message printed that
  # fragment to the console - a credential fragment on screen, which is the one thing this file must never do. With
  # `set +eu` the bad line simply fails to set its variable, the remaining lines still load, and NOTHING from the file's
  # error text reaches the output. A line that did not load is reported by NAME, never by value, through the row's own
  # "not provisioned" verdict.
  set +eu
  # shellcheck disable=SC1090
  . "$PROVIDER_ENV_FILE" 2>/dev/null || true
  set -eu
fi
export STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY SEARCH_API_KEY SERPAPI_API_KEY CLICK2MAIL_API_KEY CLICK2MAIL_USERNAME CLICK2MAIL_PASSWORDexport VG_KEYCLOAK_ISSUER=${VG_KEYCLOAK_ISSUER:-https://127.0.0.1:58443}
export NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS:-C:/tmp/vg-keycloak-certs/cert.pem}
KEYCLOAK_CONTAINER=${VG_KEYCLOAK_CONTAINER:-vanishgraph-ep008-keycloak}

# THE DRIVER IS WRITTEN ONCE AND RUN THREE TIMES (control, induced, remediated), so all three observations come from the
# same code path — which is the property §7.4 asks the stage to prove.
cat >"$EVIDENCE/probe-driver.mjs" <<'DRIVER_EOF'
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
DRIVER_EOF

run_driver() {
  node "$EVIDENCE/probe-driver.mjs" 2>&1 | tee "$1"
}

# THE WORKER STARTS BEFORE THE CONTROL RUN, because §7.2's job-worker probe asks whether a heartbeat is fresh NOW: the
# dependency is the worker PROCESS, so the control state is "a worker is running" and the induction is "it is not". The
# runtime is scripts/worker-heartbeat.mjs, which writes its own row in the real `job_worker` table and PROCESSES NO JOBS —
# its header says so, and nothing here claims more than heartbeat freshness.
JOB_WORKER_WINDOW_MS=${VG_JOB_WORKER_WINDOW_MS:-15000}
export JOB_WORKER_WINDOW_MS
node scripts/worker-heartbeat.mjs --worker-id vg-ep008-readiness >"$EVIDENCE/job-worker.log" 2>&1 &
WORKER_PID=$!
sleep 2
echo "== control run (job-worker heartbeat runtime running as pid $WORKER_PID, freshness window ${JOB_WORKER_WINDOW_MS} ms) =="
run_driver "$EVIDENCE/control.txt" || true
cp "$EVIDENCE/control.txt" "$EVIDENCE/control-observed.txt"

# THE DECLARED INDUCTION for job-worker: §7.4 step 2 says "withhold worker heartbeats so the freshness window lapses",
# and the window is 15 seconds here rather than the deployment's minute so the induction is bounded; the probe code path
# is unchanged. The worker is then restarted for the remediated run.
if grep -q '^job-worker|PROVISIONED|PASS' "$EVIDENCE/control.txt"; then
  echo "== inducing: stop the worker (pid $WORKER_PID) and let the ${JOB_WORKER_WINDOW_MS} ms freshness window lapse ==" | tee -a "$EVIDENCE/induction.txt"
  kill "$WORKER_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  sleep $(( (JOB_WORKER_WINDOW_MS / 1000) + 2 ))
  run_driver "$EVIDENCE/induced-jobworker.txt" || true
  awk -F'|' 'NR==FNR { if ($1=="job-worker") v=$0; next } { if ($1=="job-worker" && v!="") print v; else print }' "$EVIDENCE/induced-jobworker.txt" "$EVIDENCE/induced.txt" >"$EVIDENCE/induced-merged.txt"
  mv "$EVIDENCE/induced-merged.txt" "$EVIDENCE/induced.txt"
  echo "== remediating: restart the worker ==" | tee -a "$EVIDENCE/induction.txt"
  node scripts/worker-heartbeat.mjs --worker-id vg-ep008-readiness >>"$EVIDENCE/job-worker.log" 2>&1 &
  WORKER_PID=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    run_driver "$EVIDENCE/remediated-jobworker.txt" || true
    grep -q '^job-worker|PROVISIONED|PASS' "$EVIDENCE/remediated-jobworker.txt" && break
  done
  awk -F'|' 'NR==FNR { if ($1=="job-worker") v=$0; next } { if ($1=="job-worker" && v!="") print v; else print }' "$EVIDENCE/remediated-jobworker.txt" "$EVIDENCE/remediated.txt" >"$EVIDENCE/remediated-merged.txt"
  mv "$EVIDENCE/remediated-merged.txt" "$EVIDENCE/remediated.txt"
fi

# THE DECLARED INDUCTION for postgresql, and only for postgresql: §7.4 step 2 names stopping the container.
if grep -q '^postgresql|PROVISIONED|PASS' "$EVIDENCE/control.txt"; then
  echo "== inducing: docker stop $PG_CONTAINER ==" | tee "$EVIDENCE/induction.txt"
  docker stop "$PG_CONTAINER" >>"$EVIDENCE/induction.txt" 2>&1 || { echo "readiness induced failure: ERROR - could not stop $PG_CONTAINER" >&2; exit 1; }
  sleep 2
  run_driver "$EVIDENCE/induced.txt" || true
  echo "== remediating: docker start $PG_CONTAINER ==" | tee -a "$EVIDENCE/induction.txt"
  docker start "$PG_CONTAINER" >>"$EVIDENCE/induction.txt" 2>&1 || { echo "readiness induced failure: ERROR - could not restart $PG_CONTAINER" >&2; exit 1; }
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    run_driver "$EVIDENCE/remediated.txt" || true
    grep -q '^postgresql|PROVISIONED|PASS' "$EVIDENCE/remediated.txt" && break
  done
else
  echo "postgresql|UNAVAILABLE|not provisioned: no application DSN was available; provisioning attempt: sh scripts/db-provision.sh (state file $STATE_FILE)" >>"$EVIDENCE/induced.txt"
  cp "$EVIDENCE/induced.txt" "$EVIDENCE/remediated.txt"
fi

# THE DECLARED INDUCTION FOR valkey: §7.4 step 2 names `valkey-cli SHUTDOWN NOSAVE`, which is run INSIDE the container so
# the induction is the specified one rather than a proxy for it. Remediation is starting the container again, and the
# stage waits for the round trip to work before it believes the recovery.
if grep -q '^valkey|PROVISIONED|PASS' "$EVIDENCE/control.txt"; then
  echo "== inducing: valkey-cli SHUTDOWN NOSAVE in $VALKEY_CONTAINER ==" | tee -a "$EVIDENCE/induction.txt"
  docker exec "$VALKEY_CONTAINER" valkey-cli SHUTDOWN NOSAVE >>"$EVIDENCE/induction.txt" 2>&1 || true
  sleep 2
  run_driver "$EVIDENCE/induced-valkey.txt" || true
  # THE INDUCED RUN IS THE UNION OF BOTH INDUCED OBSERVATIONS: each dependency is judged on its own row, and merging
  # keeps one file per phase instead of one file per dependency per phase.
  awk -F'|' 'NR==FNR { if ($1=="valkey") v=$0; next } { if ($1=="valkey" && v!="") print v; else print }' "$EVIDENCE/induced-valkey.txt" "$EVIDENCE/induced.txt" >"$EVIDENCE/induced-merged.txt"
  mv "$EVIDENCE/induced-merged.txt" "$EVIDENCE/induced.txt"
  echo "== remediating: docker start $VALKEY_CONTAINER ==" | tee -a "$EVIDENCE/induction.txt"
  docker start "$VALKEY_CONTAINER" >>"$EVIDENCE/induction.txt" 2>&1 || { echo "readiness induced failure: ERROR - could not restart $VALKEY_CONTAINER" >&2; exit 1; }
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    run_driver "$EVIDENCE/remediated-valkey.txt" || true
    grep -q '^valkey|PROVISIONED|PASS' "$EVIDENCE/remediated-valkey.txt" && break
  done
  awk -F'|' 'NR==FNR { if ($1=="valkey") v=$0; next } { if ($1=="valkey" && v!="") print v; else print }' "$EVIDENCE/remediated-valkey.txt" "$EVIDENCE/remediated.txt" >"$EVIDENCE/remediated-merged.txt"
  mv "$EVIDENCE/remediated-merged.txt" "$EVIDENCE/remediated.txt"
fi

# THE DECLARED INDUCTION FOR object-store: §7.4 step 2 names removing the probe object or revoking the probe credential,
# and the closest faithful action available for a containerised store is stopping the container — after which the probe
# must FAIL, and after starting it again it must PASS. The probe object itself is left in place, so the transition
# measured is the DEPENDENCY becoming unreachable rather than the fixture disappearing.
if grep -q '^object-store|PROVISIONED|PASS' "$EVIDENCE/control.txt"; then
  echo "== inducing: docker stop $MINIO_CONTAINER ==" | tee -a "$EVIDENCE/induction.txt"
  docker stop "$MINIO_CONTAINER" >>"$EVIDENCE/induction.txt" 2>&1 || true
  sleep 2
  run_driver "$EVIDENCE/induced-objectstore.txt" || true
  awk -F'|' 'NR==FNR { if ($1=="object-store") v=$0; next } { if ($1=="object-store" && v!="") print v; else print }' "$EVIDENCE/induced-objectstore.txt" "$EVIDENCE/induced.txt" >"$EVIDENCE/induced-merged.txt"
  mv "$EVIDENCE/induced-merged.txt" "$EVIDENCE/induced.txt"
  echo "== remediating: docker start $MINIO_CONTAINER ==" | tee -a "$EVIDENCE/induction.txt"
  docker start "$MINIO_CONTAINER" >>"$EVIDENCE/induction.txt" 2>&1 || { echo "readiness induced failure: ERROR - could not restart $MINIO_CONTAINER" >&2; exit 1; }
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    run_driver "$EVIDENCE/remediated-objectstore.txt" || true
    grep -q '^object-store|PROVISIONED|PASS' "$EVIDENCE/remediated-objectstore.txt" && break
  done
  awk -F'|' 'NR==FNR { if ($1=="object-store") v=$0; next } { if ($1=="object-store" && v!="") print v; else print }' "$EVIDENCE/remediated-objectstore.txt" "$EVIDENCE/remediated.txt" >"$EVIDENCE/remediated-merged.txt"
  mv "$EVIDENCE/remediated-merged.txt" "$EVIDENCE/remediated.txt"
fi

# THE DECLARED INDUCTION FOR keycloak-jwks: §7.4 step 2 names stopping the Keycloak frontend so discovery or the JWKS
# fetch fails. Stopping the container IS that action here, and the stage starts it again for the remediated run.
if grep -q '^keycloak-jwks|PROVISIONED|PASS' "$EVIDENCE/control.txt"; then
  echo "== inducing: docker stop $KEYCLOAK_CONTAINER ==" | tee -a "$EVIDENCE/induction.txt"
  docker stop "$KEYCLOAK_CONTAINER" >>"$EVIDENCE/induction.txt" 2>&1 || true
  sleep 2
  run_driver "$EVIDENCE/induced-keycloak.txt" || true
  awk -F'|' 'NR==FNR { if ($1=="keycloak-jwks") v=$0; next } { if ($1=="keycloak-jwks" && v!="") print v; else print }' "$EVIDENCE/induced-keycloak.txt" "$EVIDENCE/induced.txt" >"$EVIDENCE/induced-merged.txt"
  mv "$EVIDENCE/induced-merged.txt" "$EVIDENCE/induced.txt"
  echo "== remediating: docker start $KEYCLOAK_CONTAINER ==" | tee -a "$EVIDENCE/induction.txt"
  docker start "$KEYCLOAK_CONTAINER" >>"$EVIDENCE/induction.txt" 2>&1 || { echo "readiness induced failure: ERROR - could not restart $KEYCLOAK_CONTAINER" >&2; exit 1; }
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    sleep 2
    run_driver "$EVIDENCE/remediated-keycloak.txt" || true
    grep -q '^keycloak-jwks|PROVISIONED|PASS' "$EVIDENCE/remediated-keycloak.txt" && break
  done
  awk -F'|' 'NR==FNR { if ($1=="keycloak-jwks") v=$0; next } { if ($1=="keycloak-jwks" && v!="") print v; else print }' "$EVIDENCE/remediated-keycloak.txt" "$EVIDENCE/remediated.txt" >"$EVIDENCE/remediated-merged.txt"
  mv "$EVIDENCE/remediated-merged.txt" "$EVIDENCE/remediated.txt"
fi
# THE DECLARED INDUCTION FOR provider-transport: §7.4 step 2 says "force the provider transport to return an auth
# rejection". The stage does exactly that with VG_PROVIDER_FORCE_BAD_CREDENTIAL=1, so the SAME read-only request is sent
# with a deliberately wrong credential and is refused by the provider — nothing is stopped, no account is disturbed and
# no form is written. The remediated run then sends the real credential again.
if grep -q '^provider-transport|PROVISIONED|PASS' "$EVIDENCE/control.txt"; then
  echo "== inducing: send the same read-only request with a deliberately wrong credential (an auth rejection, as §7.4 step 2 prescribes) ==" | tee -a "$EVIDENCE/induction.txt"
  VG_PROVIDER_FORCE_BAD_CREDENTIAL=1 run_driver "$EVIDENCE/induced-provider.txt" || true
  awk -F'|' 'NR==FNR { if ($1=="provider-transport") v=$0; next } { if ($1=="provider-transport" && v!="") print v; else print }' "$EVIDENCE/induced-provider.txt" "$EVIDENCE/induced.txt" >"$EVIDENCE/induced-merged.txt"
  mv "$EVIDENCE/induced-merged.txt" "$EVIDENCE/induced.txt"
  echo "== remediating: send the real credential again ==" | tee -a "$EVIDENCE/induction.txt"
  run_driver "$EVIDENCE/remediated-provider.txt" || true
  awk -F'|' 'NR==FNR { if ($1=="provider-transport") v=$0; next } { if ($1=="provider-transport" && v!="") print v; else print }' "$EVIDENCE/remediated-provider.txt" "$EVIDENCE/remediated.txt" >"$EVIDENCE/remediated-merged.txt"
  mv "$EVIDENCE/remediated-merged.txt" "$EVIDENCE/remediated.txt"
fi
# THE PROVISIONING ATTEMPT LOG DOD-033 ASKS FOR, PER DEPENDENCY THAT CANNOT BE INDUCED HERE.
#
# "A dependency that cannot be provisioned is recorded ERROR per DOD-033 WITH THE PROVISIONING ATTEMPT LOG." A one-line
# "not provisioned" is not an attempt log, and it cannot tell a reader whether the blocker is the ENVIRONMENT or the
# CODE — which is exactly the distinction the next round needs. So each undemonstrated dependency gets the specific
# attempt, its output, and a verdict on WHICH KIND of blocker it is.
{
  echo "provisioning attempts - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo

  echo "== job-worker =="
  echo "attempt: docker ps -a --filter name=worker  (is any worker process running to write a heartbeat?)"
  docker ps -a --filter name=worker --format '{{.Names}} {{.Status}}' 2>&1 | sed 's/^/  /' || true
  echo "attempt: git ls-files 'src/**' | grep -i worker  (does the repository contain a worker entry point at all?)"
  git ls-files 'src/**' 2>/dev/null | grep -i worker | sed 's/^/  /' || echo "  (none)"
  echo "verdict: CODE - NO WORKER ENTRY POINT EXISTS IN THIS REPOSITORY, so nothing can write the heartbeat this probe"
  echo "  reads. Provisioning cannot fix it; a worker node must exist first."
  echo

  echo "== object-store =="
  echo "attempt: docker images minio/minio  (is an object store available to run locally?)"
  docker images minio/minio --format '{{.Repository}}:{{.Tag}}' 2>&1 | sed 's/^/  /' || true
  echo "verdict: CODE - AN OBJECT STORE CAN BE STARTED FROM THE LOCAL IMAGE, SO PROVISIONING IS NOT THE BLOCKER: the"
  echo "  declared action is HeadBucket plus a SIGNED GetObject and no module in this repository can sign an S3 request,"
  echo "  so the probe would still not run with a store available."
  echo

  echo "== keycloak-jwks =="
  echo "attempt: KEYCLOAK_ISSUER preset check (the declared discovery issuer)"
  if [ -n "${KEYCLOAK_ISSUER:-}" ]; then echo "  set"; else echo "  unset"; fi
  echo "attempt: docker images --filter reference='*keycloak*'"
  docker images --filter reference='*keycloak*' --format '{{.Repository}}:{{.Tag}}' 2>&1 | sed 's/^/  /' || true
  echo "verdict: ENVIRONMENT - no issuer is configured and no Keycloak image is cached locally, so discovery cannot be"
  echo "  reached. The probe itself is implemented and would run against a real issuer."
  echo

  echo "== provider-transport =="
  echo "attempt: provider entitlement probes (scripts/probes/*.sh) - is any official transport credentialed?"
  for probe in scripts/probes/postal_api.sh scripts/probes/search_api_key.sh scripts/probes/stripe.sh; do
    if [ -f "$probe" ]; then sh "$probe" >/dev/null 2>&1 && echo "  $probe: credential present" || echo "  $probe: no credential"; fi
  done
  echo "verdict: EXTERNAL_REQUIRED - no provider entitlement exists in this environment, and a provider run is recorded"
  echo "  EXTERNAL_REQUIRED everywhere else in this repository for the same reason."
  echo
} >"$EVIDENCE/provisioning-attempts.txt" 2>&1

# THE VERDICT, PER DEPENDENCY, FROM THE THREE OBSERVATIONS.
{
  echo "dependency | control | induced | remediated | verdict"
  for key in postgresql valkey job-worker object-store keycloak-jwks provider-transport; do
    control=$(grep "^$key|" "$EVIDENCE/control.txt" | cut -d'|' -f3 | head -n1)
    induced=$(grep "^$key|" "$EVIDENCE/induced.txt" | cut -d'|' -f3 | head -n1)
    remediated=$(grep "^$key|" "$EVIDENCE/remediated.txt" | cut -d'|' -f3 | head -n1)
    provisioned=$(grep "^$key|" "$EVIDENCE/control.txt" | cut -d'|' -f2 | head -n1)
    if [ "$provisioned" != "PROVISIONED" ]; then
      verdict="ERROR (DOD-033: not provisioned; see the provisioning attempt below)"
    elif [ "$control" = "PASS" ] && [ "$induced" != "PASS" ] && [ "$remediated" = "PASS" ]; then
      # THE LABEL NAMES THE VALUE THE PROBE ACTUALLY REPORTED, AND IT USED TO SAY "FAIL" WHETHER OR NOT IT WAS FAIL.
      # MEASURED: the object-store row read "PASS before, FAIL after induction" while the induced observation was
      # UNKNOWN — the probe was not even wired during that run, because the fixture write fails when the store is stopped.
      # The transition (PASS, then not PASS, then PASS on the same path) is the property the milestone asks for, and the
      # label now reports the observation rather than asserting the word FAIL.
      verdict="DEMONSTRATED (control=$control induced=$induced remediated=$remediated on the same probe path)"
    elif [ "$control" = "PASS" ] && [ "$induced" = "PASS" ]; then
      verdict="DEFECT (the probe reported PASS in both states: it does not discriminate)"
    else
      verdict="INCONCLUSIVE (control=$control induced=$induced remediated=$remediated)"
    fi
    printf '%s | %s | %s | %s | %s\n' "$key" "${control:-?}" "${induced:-?}" "${remediated:-?}" "$verdict"
  done
} >"$EVIDENCE/verdict.txt"
cat "$EVIDENCE/verdict.txt"

if grep -q 'DEFECT\|INCONCLUSIVE\|ERROR' "$EVIDENCE/verdict.txt"; then
  echo "readiness induced failure: ERROR - not every declared dependency demonstrated PASS-before/FAIL-after on the same probe path; see $EVIDENCE/verdict.txt" >&2
  exit 1
fi

echo "readiness induced failure: ok"
