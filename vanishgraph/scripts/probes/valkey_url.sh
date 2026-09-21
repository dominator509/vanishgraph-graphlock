#!/usr/bin/env sh
# VALKEY_URL readiness probe. Sentinel: `<NAME>: ok - <detail>`; contract in scripts/lib/loud-fail.sh.
#
# SPEC BASIS AND THE DECLARED ACTION. PREFLIGHT.md declares this probe for VALKEY_URL and SPEC-007 section 7.2 declares
# what it must do: "PING, then write/read/delete under a namespaced probe key". This probe performs exactly that and
# VERIFIES THE VALUE IT READS BACK, because a PING alone proves the socket and not the store: a read-only replica, a
# full instance or a wrong database index all answer PING while every write fails, and a readiness probe that passes
# there would be the static-200 failure VG-API-059 forbids.
#
# IT USES THE SAME DRIVER THE APPLICATION USES - `ioredis`, the declared runtime dependency - rather than `redis-cli`,
# which is not installed on this host and would test a different client than the one that has to work.
#
# THE KEY IS NAMESPACED AND EXPIRES (`PX 10000`), so a probe killed mid-flight cannot leave a permanent key behind, and
# the delete is executed rather than assumed.
set -eu
. "$(dirname "$0")/../lib/loud-fail.sh"
vg_require_env 'VALKEY_URL' 'EP-003'

# The address is read INSIDE node and only a short outcome word crosses back out, so the URL - which may carry a
# password - is never printed and never appears in an argument list.
RESULT=$(node -e '
(async () => {
  const url = String(process.env.VALKEY_URL ?? "");
  const key = "vanishgraph:probe:readiness:" + String(Date.now());
  const payload = "probe-" + String(Date.now());
  let client;
  try {
    const { default: Redis } = await import("ioredis");
    client = new Redis(url, { lazyConnect: true, connectTimeout: 3000, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    await client.connect();
    const pong = await client.ping();
    if (String(pong).toUpperCase() !== "PONG") { process.stdout.write("PING_ODD"); return; }
    await client.set(key, payload, "PX", 10000);
    const readBack = await client.get(key);
    await client.del(key);
    process.stdout.write(readBack === payload ? "OK" : "ROUND_TRIP_MISMATCH");
  } catch (error) {
    process.stdout.write(String(error && error.code ? error.code : "UNREACHABLE"));
  } finally {
    if (client !== undefined) {
      try { await client.quit(); } catch { client.disconnect(); }
    }
  }
})();
' 2>/dev/null || printf 'UNREACHABLE')

case "$RESULT" in
  OK)
    vg_probe_ok 'VALKEY_URL' 'PING answered and a namespaced write/read/delete round trip returned the written value'
    ;;
  ROUND_TRIP_MISMATCH)
    echo "ERROR: VALKEY_URL answered PING but the write/read round trip returned a different value; the store is reachable and NOT usable for its purpose" >&2
    exit 1
    ;;
  PING_ODD)
    echo "ERROR: VALKEY_URL answered PING with something other than PONG" >&2
    exit 1
    ;;
  ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|UNREACHABLE)
    # `UNREACHABLE` IS THE LITERAL THE NODE PROGRAM WRITES WHEN THE DRIVER'S ERROR CARRIES NO `code`, AND IT BELONGS
    # HERE: the first version of this case list omitted it, so a refused connection fell through to the catch-all and
    # reported exit 1 - blaming the credential for an unreachable service. A control caught it (a bogus port answered
    # "failed with UNREACHABLE, which is neither acceptance nor a declared unreachability"), which is exactly what the
    # controls are for.
    vg_probe_cannot 'VALKEY_URL' "the declared address is not reachable from this environment (${RESULT}), so the credential could not be tested; an unreachable service is not a refused credential"
    ;;
  *)
    echo "ERROR: the valkey round trip failed with ${RESULT}, which is neither acceptance nor a declared unreachability" >&2
    exit 1
    ;;
esac
