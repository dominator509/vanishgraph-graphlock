/**
 * One-off check: run the real keycloak-jwks probe against the local Keycloak over TLS.
 *
 * THE CA IS PROVIDED BY THE ENVIRONMENT THROUGH NODE_EXTRA_CA_CERTS, WHICH IS NOT A PROBE RELAXATION: the probe still
 * performs a verifying TLS handshake, against a certificate authority this environment supplies because the issuer is a
 * disposable local instance with a self-signed certificate. Nothing here disables verification — a probe run without
 * NODE_EXTRA_CA_CERTS fails with DEPTH_ZERO_SELF_SIGNED_CERT, which is the same failure a real deployment would see
 * against an untrusted issuer.
 */
import { pathToFileURL } from 'node:url';

const issuer = process.env.VG_KEYCLOAK_ISSUER ?? 'https://127.0.0.1:58443';
const probes = await import(pathToFileURL(`${process.cwd()}/src/adapters/observability/dependency-probes.ts`).href);

const probe = probes.keycloakJwksProbe({
  discover: async () => {
    const discovery = await fetch(`${issuer}/realms/master/.well-known/openid-configuration`);
    if (!discovery.ok) throw new Error(`discovery answered HTTP ${String(discovery.status)}`);
    const document = await discovery.json();
    if (typeof document.jwks_uri !== 'string') throw new Error('the discovery document carries no jwks_uri');
    const jwks = await fetch(document.jwks_uri);
    if (!jwks.ok) throw new Error(`JWKS answered HTTP ${String(jwks.status)}`);
    const keys = await jwks.json();
    return { issuer: String(document.issuer ?? ''), keys: Array.isArray(keys.keys) ? keys.keys.length : 0 };
  },
});

try {
  console.log('probe ->', await probe());
} catch (error) {
  console.log('probe -> refused:', error.reasonCode ?? '(no reason code)', '|', error.message);
}
