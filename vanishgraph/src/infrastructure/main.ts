#!/usr/bin/env node
/**
 * Service entry point (SPEC-003 §2.1).
 *
 * PLACEMENT: this file lives in src/infrastructure/ because it is the COMPOSITION ROOT. It reads
 * configuration and constructs the HTTP layer, and ARCHITECTURE.md §2 permits infrastructure to
 * import everything while forbidding http from importing infrastructure. A first version sat at
 * src/http/main.ts and imported ../infrastructure/config.ts; scripts/import-boundary.sh
 * refused it, correctly, and moving the file was the right fix rather than widening the rule.
 *
 * This is the ONLY place that binds a port. `buildServer` constructs the application and never
 * touches the network, which is what lets every contract test drive the real HTTP boundary
 * through `app.inject` with no port, no race and no cleanup. Keeping the two apart also means a
 * test cannot accidentally start a listener by importing the server module.
 *
 * Bootstrap order is deliberate: configuration is validated FIRST, so a misconfigured process
 * fails before it can accept a single request. The failure message names the missing variable
 * and never its value (VG-SEC-002, SPEC-006 §9.1 rule 3).
 */

import { loadConfig, ConfigurationError, missingVariables } from './config.ts';
import { buildServer, listen } from '../http/server.ts';
import type { ProbeResult } from '../http/routes/health.ts';

/** Build identity. Read from the environment so CI can stamp a real commit. */
const VERSION = process.env.npm_package_version ?? '0.1.0';
const COMMIT = process.env.VG_COMMIT ?? 'unknown';

/**
 * Readiness probes.
 *
 * DELIBERATELY HONEST ABOUT THEIR OWN LIMITS: these check that configuration is present, not that
 * the dependency answers. Reaching PostgreSQL and Valkey requires the drivers and the network,
 * which EP-004 M6 supplies; until then a probe that reported "postgres ok" without connecting
 * would be exactly the static-200 failure VG-API-059 forbids.
 *
 * So the probes below report what they can actually prove, and a `/ready` on this build returns
 * 503 with the reason named. That is the correct answer for a service whose dependencies are not
 * yet wired, and it is visible rather than hidden.
 */
function configuredProbe(name: string, envName: string): () => Promise<ProbeResult> {
  return async () => {
    const value = process.env[envName];
    if (value === undefined || value.trim().length === 0) {
      return { name, ok: false, reason: `${envName} is unset` };
    }
    return {
      name,
      ok: false,
      // Reachability is the operational half of this probe and arrives with the driver wiring in
      // EP-004 M6. Until then the probe reports NOT READY rather than asserting health it has not
      // measured, which is the whole point of VG-API-059.
      reason: `${envName} is configured; reachability is measured once the driver wiring lands (EP-004 M6)`,
    };
  };
}

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      // The message already names variables only. Nothing else is printed, so no value can leak.
      console.error(`serve: FAIL - ${error.message}`);
      const missing = missingVariables();
      if (missing.length > 0) {
        console.error(`serve: missing (${missing.length}): ${missing.join(', ')}`);
      }
      console.error('serve: refusing to start; a service that cannot reach its dependencies must not accept traffic');
      return 1;
    }
    throw error;
  }

  const app = buildServer({
    version: VERSION,
    commit: COMMIT,
    logLevel: config.logLevel,
    health: {
      startedAt: new Date(),
      now: () => new Date(),
      probes: [
        configuredProbe('postgres', 'DATABASE_URL'),
        configuredProbe('valkey', 'VALKEY_URL'),
        configuredProbe('keycloak', 'KEYCLOAK_ISSUER'),
      ],
    },
  });

  const bound = await listen(app, { port: config.port, host: config.host });
  // Only the address is printed. Config values, including the DSN and the session secret, are
  // never logged (VG-SEC-002).
  console.log(`serve: listening on http://${bound.host}:${bound.port}/v1`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`serve: ${signal} received, closing`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return 0;
}

process.exit(await main());
