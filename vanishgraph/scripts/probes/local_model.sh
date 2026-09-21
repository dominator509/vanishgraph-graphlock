#!/usr/bin/env sh
# LOCAL_MODEL_ENDPOINT readiness probe. Sentinel: `<NAME>: ok - <detail>`; contract in scripts/lib/loud-fail.sh.
#
# SPEC BASIS. PREFLIGHT.md declares this probe for LOCAL_MODEL_ENDPOINT, and config/environment/schema.json classifies
# the key at the REQUIRED_BEFORE_E2E lane: it is required before end-to-end work and NOT required for the clean-local
# class, so its unset state is a lane fact rather than a defect.
#
# THE DECLARED ACTION, AND THE RULE THAT SHAPES IT. The model endpoint is an inference server, and the only safe
# readiness action against it is READ-ONLY: this probe issues GET on the endpoint's model-list path (the OpenAI-compatible
# `/models` path, which this repository's agent runner speaks) and NEVER a completion request. A probe that generated
# tokens would spend the dependency's capacity and could be billed, and one that posted a prompt would be a form write,
# which SPEC-000 section 6.7 forbids.
#
# WHAT IT REFUSES: a plaintext endpoint that is not loopback (an inference server reached across the network in cleartext
# is not a trust decision this service may make), an auth rejection (reachable and not usable), and a 404 (the endpoint
# answers and is not the declared API).
#
# IT NEVER PRINTS A TOKEN. If the endpoint needs one, it is read from LOCAL_MODEL_API_KEY when that key is set, and no
# value is echoed.
set -eu
. "$(dirname "$0")/../lib/loud-fail.sh"
vg_require_env 'LOCAL_MODEL_ENDPOINT' 'EP-013'

RESULT=$(node -e '
(async () => {
  const raw = String(process.env.LOCAL_MODEL_ENDPOINT ?? "").replace(/\/$/, "");
  let url;
  try { url = new URL(raw); } catch { process.stdout.write("NOT_A_URL"); return; }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) { process.stdout.write("PLAINTEXT_OFF_HOST"); return; }
  const token = String(process.env.LOCAL_MODEL_API_KEY ?? "");
  const headers = token === "" ? {} : { authorization: "Bearer " + token };
  try {
    // A READ, NEVER A COMPLETION: the path is the model list, which an inference server exposes without spending capacity.
    const response = await fetch(raw + "/models", { headers, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (response.status === 401 || response.status === 403) { process.stdout.write("REFUSED_" + String(response.status)); return; }
    if (response.status === 404) { process.stdout.write("NO_MODELS_PATH"); return; }
    if (!response.ok) { process.stdout.write("HTTP_" + String(response.status)); return; }
    const document = await response.json().catch(() => null);
    const count = document && Array.isArray(document.data) ? document.data.length : 0;
    process.stdout.write(count > 0 ? "OK_" + String(count) : "NO_MODELS_LISTED");
  } catch (error) {
    process.stdout.write(String(error && error.code ? error.code : (error && error.name === "TimeoutError" ? "ETIMEDOUT" : "UNREACHABLE")));
  }
})();
' 2>/dev/null || printf 'UNREACHABLE')

case "$RESULT" in
  OK_*)
    vg_probe_ok 'LOCAL_MODEL_ENDPOINT' "the declared inference endpoint answered a READ-ONLY model list over ${RESULT#OK_} model(s); no completion was requested"
    ;;
  NO_MODELS_LISTED)
    echo "ERROR: the endpoint answered the model list and it carries no model, so no inference could be served" >&2
    exit 1
    ;;
  NO_MODELS_PATH)
    echo "ERROR: the endpoint answered HTTP 404 for the model list: it is reachable and it is not the declared inference API" >&2
    exit 1
    ;;
  REFUSED_401|REFUSED_403)
    echo "ERROR: the endpoint answered ${RESULT}: it is reachable and the declared credential is not accepted" >&2
    exit 1
    ;;
  NOT_A_URL)
    echo "ERROR: LOCAL_MODEL_ENDPOINT is not a URL this probe can address" >&2
    exit 1
    ;;
  PLAINTEXT_OFF_HOST)
    echo "ERROR: LOCAL_MODEL_ENDPOINT is plaintext and is NOT loopback; an inference endpoint reached in cleartext off-host is not a trust decision this service may make" >&2
    exit 1
    ;;
  ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|UND_ERR_CONNECT_TIMEOUT|UNREACHABLE)
    vg_probe_cannot 'LOCAL_MODEL_ENDPOINT' "the declared endpoint is not reachable from this environment (${RESULT}), so the configuration could not be tested; an unreachable server is not a refused credential"
    ;;
  HTTP_5*)
    echo "ERROR: the endpoint answered ${RESULT}: it is reachable and failing" >&2
    exit 1
    ;;
  *)
    echo "ERROR: the local-model probe failed with ${RESULT}, which is neither acceptance nor a declared unreachability" >&2
    exit 1
    ;;
esac
