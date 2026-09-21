#!/usr/bin/env sh
# KEYCLOAK_ISSUER readiness probe. Sentinel: `<NAME>: ok - <detail>`; contract in scripts/lib/loud-fail.sh.
#
# SPEC BASIS AND THE DECLARED ACTION. PREFLIGHT.md declares this probe for KEYCLOAK_ISSUER and SPEC-007 section 7.2
# declares what the dependency must do: "OIDC discovery plus JWKS retrieval over TLS, WITH NO TOKEN MINTED". This probe
# performs exactly that: it reads the discovery document, follows the `jwks_uri` the ISSUER advertises rather than
# guessing one, and requires at least one signing key.
#
# THREE THINGS IT REFUSES, EACH FOR A STATED REASON:
#   1. a plaintext issuer, because the declared dependency is over TLS and a token verified against a key fetched over
#      plaintext is not a trust decision this service is allowed to make;
#   2. a discovery document with no `jwks_uri`, because then nothing can be verified;
#   3. a key set with no key, because a JWKS that carries none means no token could ever be verified.
#
# TLS IS VERIFIED, NEVER DISABLED. The local issuer serves a self-signed certificate, so its CA is supplied through
# NODE_EXTRA_CA_CERTS exactly as scripts/smoke-test.sh supplies it; without that CA this probe fails with a TLS error,
# which is the correct answer and is what its negative control asserts.
#
# IT NEVER PRINTS THE ISSUER'S QUERY STRING OR ANY TOKEN. It mints no token at all.
set -eu
. "$(dirname "$0")/../lib/loud-fail.sh"
vg_require_env 'KEYCLOAK_ISSUER' 'EP-006'

RESULT=$(node -e '
(async () => {
  const issuer = String(process.env.KEYCLOAK_ISSUER ?? "").replace(/\/$/, "");
  if (!issuer.startsWith("https://")) { process.stdout.write("NOT_HTTPS"); return; }
  try {
    const discovery = await fetch(issuer + "/.well-known/openid-configuration", { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!discovery.ok) { process.stdout.write("DISCOVERY_HTTP_" + String(discovery.status)); return; }
    const document = await discovery.json();
    if (typeof document.jwks_uri !== "string" || document.jwks_uri.length === 0) { process.stdout.write("NO_JWKS_URI"); return; }
    if (!String(document.jwks_uri).startsWith("https://")) { process.stdout.write("JWKS_NOT_HTTPS"); return; }
    const jwks = await fetch(document.jwks_uri, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!jwks.ok) { process.stdout.write("JWKS_HTTP_" + String(jwks.status)); return; }
    const keyset = await jwks.json();
    const keys = Array.isArray(keyset.keys) ? keyset.keys.length : 0;
    if (keys < 1) { process.stdout.write("NO_KEYS"); return; }
    process.stdout.write("OK_" + String(keys));
  } catch (error) {
    const code = error && error.code ? String(error.code) : "";
    if (code !== "") { process.stdout.write(code); return; }
    const cause = error && error.cause && error.cause.code ? String(error.cause.code) : "";
    if (cause !== "") { process.stdout.write(cause); return; }
    const message = error && error.message ? String(error.message) : "";
    // "fetch failed" alone does not say WHY, and the classification that matters here is TLS versus transport; an
    // unclassified fetch failure is reported as unreachable rather than as a refused credential.
    process.stdout.write(message.includes("fetch failed") ? "UNREACHABLE" : "UNKNOWN");
  }
})();
' 2>/dev/null || printf 'UNREACHABLE')

case "$RESULT" in
  OK_*)
    vg_probe_ok 'KEYCLOAK_ISSUER' "OIDC discovery answered over TLS and the advertised JWKS carried ${RESULT#OK_} signing key(s); no token was minted"
    ;;
  NOT_HTTPS)
    echo "ERROR: KEYCLOAK_ISSUER is not an HTTPS issuer, and the declared dependency is discovery plus JWKS over TLS; a key fetched over plaintext is not a trust decision this service may make" >&2
    exit 1
    ;;
  NO_JWKS_URI)
    echo "ERROR: the discovery document advertises no jwks_uri, so no token could ever be verified" >&2
    exit 1
    ;;
  JWKS_NOT_HTTPS)
    echo "ERROR: the discovery document advertises a jwks_uri that is not HTTPS" >&2
    exit 1
    ;;
  NO_KEYS)
    echo "ERROR: the JWKS document carries no signing key, so no token could ever be verified" >&2
    exit 1
    ;;
  DISCOVERY_HTTP_401|DISCOVERY_HTTP_403|JWKS_HTTP_401|JWKS_HTTP_403)
    echo "ERROR: the issuer answered ${RESULT}: it is reachable and this realm is not readable with this configuration" >&2
    exit 1
    ;;
  DISCOVERY_HTTP_404|JWKS_HTTP_404)
    echo "ERROR: the issuer answered ${RESULT}: the declared realm path does not exist on this host" >&2
    exit 1
    ;;
  DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID)
    echo "ERROR: the issuer's TLS certificate was refused with ${RESULT}; TLS verification is NOT disabled here, so supply the CA through NODE_EXTRA_CA_CERTS rather than weakening this probe" >&2
    exit 1
    ;;
  ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|UND_ERR_CONNECT_TIMEOUT|UNREACHABLE)
    vg_probe_cannot 'KEYCLOAK_ISSUER' "the declared issuer is not reachable from this environment (${RESULT}), so the configuration could not be tested; an unreachable issuer is not a refused credential"
    ;;
  *)
    echo "ERROR: the Keycloak probe failed with ${RESULT}, which is neither acceptance nor a declared unreachability" >&2
    exit 1
    ;;
esac
