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
  const redis = new Redis(valkeyUrl, { lazyConnect: true, connectTimeout: 150, maxRetriesPerRequest: 1, enableOfflineQueue: false });
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
