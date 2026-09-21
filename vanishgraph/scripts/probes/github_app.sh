#!/usr/bin/env sh
# GITHUB_APP_ID readiness probe. Sentinel: `<NAME>: ok - <detail>`; contract in scripts/lib/loud-fail.sh.
#
# SPEC BASIS. PREFLIGHT.md declares this probe for GITHUB_APP_ID (with GITHUB_APP_PRIVATE_KEY and
# GITHUB_INSTALLATION_ID completing the trio) and config/environment/schema.json classifies the key at the
# REQUIRED_BEFORE_DEPLOY lane.
#
# THE DECLARED ACTION, AND THE ONE IT DELIBERATELY DOES NOT TAKE. A GitHub App authenticates with a short-lived RS256
# JWT signed by the app's private key, so this probe mints one and calls the READ-ONLY `/app` endpoint. It does NOT
# create an installation token, does NOT read a repository, and does NOT touch an issue: those are writes or reads of
# the customer's data, and a readiness probe has no business performing either (SPEC-000 section 6.7).
#
# THE JWT IS MINTED IN MEMORY AND NEVER PRINTED, and it expires in nine minutes. The private key is read from the
# environment, never echoed, and never written to disk.
#
# WHAT IT REFUSES, EACH FOR A STATED REASON: a private key that is not a PEM block (a mistyped secret is not an
# unreachable service), an app id that is not numeric (schema.json declares NUMERIC_ID), a 401 (reachable and the key is
# not accepted), and a 404 (the app does not exist).
set -eu
. "$(dirname "$0")/../lib/loud-fail.sh"
vg_require_env 'GITHUB_APP_ID' 'EP-013'
vg_require_env 'GITHUB_APP_PRIVATE_KEY' 'EP-013'

RESULT=$(node -e '
(async () => {
  const { createSign } = await import("node:crypto");
  const appId = String(process.env.GITHUB_APP_ID ?? "").trim();
  if (!/^[0-9]+$/.test(appId)) { process.stdout.write("APP_ID_NOT_NUMERIC"); return; }
  // A PEM supplied through an environment variable often carries escaped newlines; they are restored here rather than
  // at the call site, because a key that fails to parse must be reported as a key problem and not as an auth failure.
  const pem = String(process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").trim();
  if (!pem.includes("-----BEGIN") || !pem.includes("-----END")) { process.stdout.write("PRIVATE_KEY_NOT_PEM"); return; }
  const base64url = (value) => Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat is backdated 60 s because GitHub refuses a JWT whose iat is in ITS future and clocks differ; exp is inside the
  // 10-minute ceiling GitHub states.
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  let signature;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(header + "." + payload);
    signature = signer.sign(pem).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch (error) {
    process.stdout.write("PRIVATE_KEY_UNUSABLE");
    return;
  }
  const jwt = header + "." + payload + "." + signature;
  try {
    const response = await fetch("https://api.github.com/app", {
      headers: { authorization: "Bearer " + jwt, accept: "application/vnd.github+json", "user-agent": "vanishgraph-readiness-probe" },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401 || response.status === 403) { process.stdout.write("REFUSED_" + String(response.status)); return; }
    if (response.status === 404) { process.stdout.write("APP_NOT_FOUND"); return; }
    if (!response.ok) { process.stdout.write("HTTP_" + String(response.status)); return; }
    const document = await response.json().catch(() => null);
    const hasIdentity = document !== null && (typeof document.id === "number" || typeof document.slug === "string");
    process.stdout.write(hasIdentity ? "OK" : "NO_APP_IDENTITY");
  } catch (error) {
    process.stdout.write(String(error && error.code ? error.code : (error && error.name === "TimeoutError" ? "ETIMEDOUT" : "UNREACHABLE")));
  }
})();
' 2>/dev/null || printf 'UNREACHABLE')

case "$RESULT" in
  OK)
    vg_probe_ok 'GITHUB_APP_ID' 'an RS256 app JWT was minted in memory and the read-only /app endpoint accepted it; no installation token was created and no repository data was read'
    ;;
  REFUSED_401|REFUSED_403)
    echo "ERROR: the GitHub App endpoint answered ${RESULT}: it is reachable and the declared app id and private key are not accepted" >&2
    exit 1
    ;;
  APP_NOT_FOUND)
    echo "ERROR: the GitHub App endpoint answered 404: the declared app id does not exist" >&2
    exit 1
    ;;
  APP_ID_NOT_NUMERIC)
    echo "ERROR: GITHUB_APP_ID is not numeric, and config/environment/schema.json declares this key's format NUMERIC_ID; a mistyped identifier is not an unreachable service" >&2
    exit 1
    ;;
  PRIVATE_KEY_NOT_PEM)
    echo "ERROR: GITHUB_APP_PRIVATE_KEY does not look like a PEM block (no BEGIN/END line), so this probe will not attempt a signature" >&2
    exit 1
    ;;
  PRIVATE_KEY_UNUSABLE)
    echo "ERROR: GITHUB_APP_PRIVATE_KEY is a PEM block this runtime could not use to sign: the key is malformed, truncated, or not an RSA private key" >&2
    exit 1
    ;;
  NO_APP_IDENTITY)
    echo "ERROR: the endpoint answered 200 without an app identity in the document, so this probe cannot confirm which app answered" >&2
    exit 1
    ;;
  ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|UND_ERR_CONNECT_TIMEOUT|UNREACHABLE)
    vg_probe_cannot 'GITHUB_APP_ID' "the GitHub API is not reachable from this environment (${RESULT}), so the credential could not be tested; an unreachable service is not a refused credential"
    ;;
  *)
    echo "ERROR: the GitHub App probe failed with ${RESULT}, which is neither acceptance nor a declared unreachability" >&2
    exit 1
    ;;
esac
