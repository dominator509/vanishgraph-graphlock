/**
 * Measured provisioning attempt for the `provider-transport` row.
 *
 * WHY THIS EXISTS: the row has been reported as "no provider entitlement" — an ASSERTION. This turns it into an
 * OBSERVATION: a read-only, no-op reachability request against a real declared transport's public endpoint, with no
 * credential, NO FORM WRITE and no effect of any kind (SPEC-000 §6.7 forbids a probe writing to a provider).
 *
 * WHAT THE RESULT MEANS, AND WHY IT IS NOT A PASS: §7.4 step 2 induces this dependency by "forc[ing] the provider
 * transport to return an auth rejection". A transport that answers 401 without a credential IS ALREADY IN THE INDUCED
 * STATE, so a control run cannot reach PASS until a credential exists — which is exactly what EXTERNAL_REQUIRED means and
 * why a locally hosted stand-in would prove nothing: the declared dependency is the provider, not a server this
 * repository controls.
 */
import { pathToFileURL } from 'node:url';

const transports = [
  { name: 'stripe', url: 'https://api.stripe.com/v1/balance' },
  { name: 'postal_api', url: 'https://api.lob.com/v1/us_verifications' },
  { name: 'search_api_key', url: 'https://serpapi.com/account' },
];

const probes = await import(pathToFileURL(`${process.cwd()}/src/adapters/observability/dependency-probes.ts`).href);

for (const transport of transports) {
  const started = Date.now();
  let status = 0;
  let note = '';
  try {
    // A GET with no body, no credential and no query parameters: the least invasive request that still shows whether the
    // transport answers. `redirect: 'manual'` keeps it from following into an effect-bearing path.
    const response = await fetch(transport.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    status = response.status;
    note = status === 401 || status === 403 ? 'auth rejection (the induced state of §7.4 step 2)' : status >= 500 ? 'server error' : 'answered';
  } catch (error) {
    note = `unreachable: ${error.cause?.code ?? error.name}`;
  }
  console.log(`${transport.name} | ${transport.url} | HTTP ${String(status || '-')} | ${note} | ${String(Date.now() - started)}ms`);
}

// AND THE PROBE'S OWN VERDICT ON THE SAME OBSERVATION, which is what the verdict table would carry.
const probe = probes.providerTransportProbe({
  name: 'stripe',
  reachability: async () => ({ status: (await fetch('https://api.stripe.com/v1/balance', { redirect: 'manual', signal: AbortSignal.timeout(8000) })).status }),
});
try {
  console.log('probe ->', await probe());
} catch (error) {
  console.log(`probe -> refused: ${String(error.reasonCode)} | ${error.message}`);
}
