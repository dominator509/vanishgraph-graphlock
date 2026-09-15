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
import { AUDIENCES, verifyToken } from '../adapters/oidc/verify.ts';
import { JwksCache, httpsJwksFetcher } from '../adapters/oidc/jwks.ts';
import { PostgresIdempotencyStore } from '../adapters/idempotency/postgres-store.ts';
import { PostgresTenantRunner, postgresReadinessProbe } from '../adapters/persistence/postgres-runner.ts';
import { PostgresSubjectQueries } from '../adapters/persistence/subjects.ts';
import { PostgresSourceQueries, verificationKeysFrom } from '../adapters/persistence/sources.ts';
import { PostgresAppealQueries } from '../adapters/persistence/appeals.ts';
import { PostgresDeadlineQueries } from '../adapters/persistence/deadlines.ts';
import { findRoute } from '../http/openapi/registry.ts';
import { parseDsn } from '../adapters/../infrastructure/database/psql.ts';

/**
 * The trusted recipe signing keys, read from the environment.
 *
 * The variable is a JSON object mapping `signingKeyRef` to an SPKI PEM public key:
 *
 *     RECIPE_VERIFICATION_KEYS={"kms:recipe-1":"-----BEGIN PUBLIC KEY-----\n…"}
 *
 * WHY JSON RATHER THAN ONE VARIABLE PER KEY: the reference is caller-supplied data (§5.3.7's
 * `signingKeyRef`), so the set of keys is open-ended and a fixed variable name per key would require
 * a deployment change to add one.
 *
 * A MALFORMED DOCUMENT IS A BOOTSTRAP FAILURE, not an empty map. Silently treating a typo as "no keys
 * configured" would turn every recipe submission into a 503 whose cause is invisible, and the operator
 * would look for a missing key rather than a broken one. An ABSENT variable is not malformed: it is the
 * documented state of a deployment with no key yet, and it yields an empty map.
 *
 * An individual key that fails to parse is dropped by `verificationKeysFrom`, with its reference
 * reported, so one bad entry does not take reads down with it.
 */
function recipeVerificationKeysFromEnvironment(): ReturnType<typeof verificationKeysFrom>['keys'] {
  const raw = process.env['RECIPE_VERIFICATION_KEYS'];
  if (raw === undefined || raw.trim().length === 0) return verificationKeysFrom({}).keys;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The VALUE is never printed — it is key material in the PEM case (VG-SEC-002). The variable name
    // is enough for an operator to find the problem.
    throw new ConfigurationError('dependency unavailable: RECIPE_VERIFICATION_KEYS is not valid JSON', 'RECIPE_VERIFICATION_KEYS');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigurationError('dependency unavailable: RECIPE_VERIFICATION_KEYS must be a JSON object', 'RECIPE_VERIFICATION_KEYS');
  }

  const entries: Record<string, string> = {};
  for (const [ref, pem] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof pem !== 'string') {
      throw new ConfigurationError('dependency unavailable: RECIPE_VERIFICATION_KEYS values must be PEM strings', 'RECIPE_VERIFICATION_KEYS');
    }
    entries[ref] = pem;
  }
  const { keys, rejected } = verificationKeysFrom(entries);
  if (rejected.length > 0) {
    // Only the REFERENCES are named. A rejected key's bytes are never logged.
    console.error(`serve: RECIPE_VERIFICATION_KEYS entries rejected (unparseable public key): ${rejected.join(', ')}`);
  }
  return keys;
}

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

  // Identity is constructed from configuration. The JWKS fetch goes through the injected port so the
  // HTTP layer never owns a network client, and a fetch failure becomes DEPENDENCY_UNAVAILABLE at
  // verification time rather than an "accept unverified" fallback (see adapters/oidc/jwks.ts).
  const jwks = new JwksCache({ fetchJwks: httpsJwksFetcher(), now: () => Date.now() });

  // The tenant-scoped pool. Constructed once for the process: a pool per request would defeat the
  // point of pooling and exhaust PostgreSQL's connection limit under load.
  const runner = new PostgresTenantRunner({ dsn: parseDsn(config.databaseUrl) });

  const app = buildServer({
    version: VERSION,
    commit: COMMIT,
    logLevel: config.logLevel,
    identity: {
      verify: (token) =>
        verifyToken(token, {
          jwks,
          issuer: config.keycloakIssuer,
          // The portal audience is the default here because this process serves the portal's own
          // routes. A route set with a different audience (service, MCP) is EP-006's surface and
          // must construct its own verifier with that audience rather than reusing this one.
          expectedAudience: AUDIENCES.PORTAL,
          now: () => Date.now(),
        }),
    },
    tenancy: {
      // The REAL runner (EP-004 M6), replacing the M3 stub that refused every call. It opens a
      // transaction, sets `app.tenant_id` with transaction-local scope, and releases the connection
      // only after the transaction has ended.
      runner,
    },
    // From configuration, never a literal: a cursor signed with a known secret is a cursor any
    // caller can mint, which defeats the tenant binding it exists to provide.
    sessionSecret: config.sessionSecret,
    // The read model is constructed HERE, in the composition root, because this is the only layer
    // allowed to know that a PostgreSQL adapter exists.
    subjectQueries: new PostgresSubjectQueries(),
    // The §5.3 model, constructed here for the same reason.
    sourceQueries: new PostgresSourceQueries(),
    // Recipe signature verification keys, from the environment. An EMPTY map is a real state rather
    // than a fallback: every recipe submission is then refused with `503 DEPENDENCY_UNAVAILABLE`,
    // because VG-CHANNEL-003 forbids storing a recipe the system cannot verify. ADR-006 (KMS
    // selection) is OPEN, so no production key exists yet — and that refusal is what makes the gap
    // visible instead of silently accepting unverified recipes.
    recipeVerificationKeys: recipeVerificationKeysFromEnvironment(),
    // The §5.14 model, constructed here for the same reason as the others.
    appealQueries: new PostgresAppealQueries(),
    // The §5.13 model, constructed here for the same reason as the others.
    deadlineQueries: new PostgresDeadlineQueries(),
    idempotency: {
      // The durable store is PostgreSQL (SPEC-003 §4.2): the effect must survive a process restart,
      // so an in-memory store would defeat the mechanism it implements.
      store: new PostgresIdempotencyStore({ dsn: parseDsn(config.databaseUrl) }),
      // The requirement comes from the REGISTRY, which is the contract (SPEC-003 §4.1). MEASURED
      // DEFECT this corrects: the function returned `undefined` unconditionally, so no route ever
      // claimed a key and every effect-bearing route ran with idempotency OFF while its registry entry
      // said `required` — the same defect `beginHandler` had already fixed for step-up.
      requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
    },
    health: {
      startedAt: new Date(),
      now: () => new Date(),
      probes: [
        // A REAL query, not a configuration check: a probe that only read the environment would
        // report ready for a database that is down (VG-API-059).
        () => postgresReadinessProbe(runner),
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
    // Close the pool so in-flight transactions finish and no connection is left open.
    await runner.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return 0;
}

process.exit(await main());
