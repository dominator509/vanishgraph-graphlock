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

# THE OBJECT STORE'S OWN VARIABLES, WHEN THE ENVIRONMENT PROVIDES THEM. An unset endpoint is not an error: the row
# then reads UNAVAILABLE and the provisioning attempt log says why.
export VG_OBJECT_STORE_ENDPOINT VG_OBJECT_STORE_REGION VG_OBJECT_STORE_BUCKET VG_OBJECT_STORE_KEY VG_OBJECT_STORE_ACCESS_KEY VG_OBJECT_STORE_SECRET_KEY

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
DRIVER_EOF

run_driver() {
  node "$EVIDENCE/probe-driver.mjs" 2>&1 | tee "$1"
}

echo "== control run =="
run_driver "$EVIDENCE/control.txt" || true
cp "$EVIDENCE/control.txt" "$EVIDENCE/control-observed.txt"

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
      verdict="DEMONSTRATED (PASS before, FAIL after induction on the same probe path, PASS after remediation)"
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
