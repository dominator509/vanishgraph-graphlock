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
import { createMetricsRegistryFromFile } from '../adapters/observability/metrics-registry.ts';
import { startMetricsListener } from './observability/compose-telemetry.ts';
import { buildServer, listen } from '../http/server.ts';
import { AUDIENCES, verifyToken } from '../adapters/oidc/verify.ts';
import { JwksCache, httpsJwksFetcher } from '../adapters/oidc/jwks.ts';
import { PostgresIdempotencyStore } from '../adapters/idempotency/postgres-store.ts';
import { PostgresTenantRunner } from '../adapters/persistence/postgres-runner.ts';
import { createDependencyClients, toDependencyProbes } from './observability/dependency-clients.ts';
import { PostgresSubjectQueries } from '../adapters/persistence/subjects.ts';
import { PostgresSubjectCommands } from '../adapters/persistence/subject-commands.ts';
import { PostgresSourceQueries, verificationKeysFrom } from '../adapters/persistence/sources.ts';
import { PostgresAppealQueries } from '../adapters/persistence/appeals.ts';
import { PostgresDeadlineQueries } from '../adapters/persistence/deadlines.ts';
import { PostgresAuditQueries } from '../adapters/persistence/audit-queries.ts';
import { PostgresObservationQueries } from '../adapters/persistence/observations.ts';
import { PostgresExposureQueries } from '../adapters/persistence/exposures.ts';
import { PostgresTransitionQueries } from '../adapters/persistence/transitions.ts';
import { PostgresCaseQueries } from '../adapters/persistence/cases.ts';
import { PostgresActionQueries } from '../adapters/persistence/actions.ts';
import { PostgresPolicyQueries } from '../adapters/persistence/policies.ts';
import { PostgresCoverageQueries } from '../adapters/persistence/coverage.ts';
import { PostgresEvidenceQueries } from '../adapters/persistence/evidence.ts';
import { PostgresDiscoveryQueries } from '../adapters/persistence/discovery.ts';
import { PostgresWebhookBindingQueries } from '../adapters/persistence/webhook-bindings.ts';
import { PostgresWebhookDeliveryCommands } from '../adapters/persistence/webhook-deliveries.ts';
import { FileReplayStore } from '../adapters/coordination/replay-store.ts';
import { PostgresControllerResponseQueries } from '../adapters/persistence/controller-responses.ts';
import { join as joinPath } from 'node:path';
import { tmpdir as tmpDirectory } from 'node:os';
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
 * Readiness probe composition.
 *
 * The probes are no longer configuration-presence stubs. Each of the six declared dependencies has
 * a probe that performs the SPEC-007 §7.2 action against the real dependency and classifies what it
 * measured: PostgreSQL opens a transaction and reads `current_user` for the session role, Valkey
 * PINGs and round-trips a namespaced key, the object store signs and fetches a probe object and
 * verifies its digest, Keycloak fetches discovery plus JWKS, the job worker reads heartbeat
 * freshness, and provider transport performs a read-only reachability request.
 *
 * A probe that cannot reach its dependency reports NOT READY with the reason named rather than
 * asserting health it has not measured, which is the static-200 failure VG-API-059 forbids.
 */

// The catalogue path is a repository-relative constant rather than a variable: the metrics endpoint serves the ONE
// registered catalogue, and a second path would be a second source of truth for what a metric is.
const METRICS_CATALOGUE_PATH = 'config/metrics/catalogue.json';

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
    subjectCommands: new PostgresSubjectCommands(),
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
    // The §5.15 read model. READ-ONLY: the only writer of udit_event is the audit sink.
    auditQueries: new PostgresAuditQueries(),
    // The 5.10/5.11 read model.
    observationQueries: new PostgresObservationQueries(),
    // The 5.5 exposure model, including the two guarded assessments that drive T3/T4.
    exposureQueries: new PostgresExposureQueries(),
    // The transition spine: the audit rows that record state changes, read back by 5.5.5.
    transitionQueries: new PostgresTransitionQueries(),
    // The 5.7 case aggregate. It receives the SAME verification keys as the 5.3 recipe routes, because
    // 5.7.4 reports the outcome of a real signature verification rather than the presence of a signature.
    caseQueries: new PostgresCaseQueries({ recipeVerificationKeys: recipeVerificationKeysFromEnvironment() }),
    // The 5.9 controller-response and email-thread model.
    controllerResponseQueries: new PostgresControllerResponseQueries(),
    // The 5.8 action model. It receives the recipe verification keys for the same reason 5.7's guards do: the
    // execution route reports whether the recipe's signature VERIFIED, not merely that bytes are present.
    actionQueries: new PostgresActionQueries({ recipeVerificationKeys: recipeVerificationKeysFromEnvironment() }),
    // The 5.6 policy model.
    policyQueries: new PostgresPolicyQueries(),
    // The 5.16 coverage and metric model. Its report table has no producer yet (the §5.4 discovery node owns it);
    // the routes read the table of record, and ASSUMPTIONS §3.34 states that in full.
    coverageQueries: new PostgresCoverageQueries(),
    evidenceQueries: new PostgresEvidenceQueries(),
    discoveryQueries: new PostgresDiscoveryQueries(),
    // The SPEC-003 §6 ingress. The replay binding is the FILE store M7 authorises when no coordination store is
    // provisioned (VALKEY_URL is BLOCKED_CREDENTIALS): durable, append-only, and shared across processes — never an
    // in-memory map, which M7 prohibits and which would stop protecting the moment a second process ran.
    webhookBindings: new PostgresWebhookBindingQueries(),
    webhookDeliveries: new PostgresWebhookDeliveryCommands({
      runner,
      controllerResponses: new PostgresControllerResponseQueries(),
    }),
    replayStore: new FileReplayStore({
      path: process.env['VG_REPLAY_LOG'] ?? joinPath(tmpDirectory(), 'vanishgraph-webhook-replay.log'),
    }),
    // NO SECRET STORE IS CONFIGURED, so every delivery is refused `503` with a reason that names the gap: a webhook
    // whose shared secret cannot be resolved cannot be verified, and accepting it unverified is the one thing the
    // signature exists to prevent.
    resolveSecret: async (secretName: string) => {
      throw new Error(
        `no secret resolver is configured for ${secretName}: webhook secrets must come from a secret manager (VG-SEC-002)`,
      );
    },
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
      // THE SIX DECLARED DEPENDENCIES, BUILT FROM THIS PROCESS'S OWN CONFIGURATION (EP-010 M26; SPEC-007 §7.2).
      // What stood here was three probes, two of them stubs that returned ok:false unconditionally, so `/v1/ready` was
      // permanently 503 and `/v1/health` was 503 because a REQUIRED dependency could never pass - and a probe that can
      // never pass is as much a defect as one that can never fail. The real actions live in
      // src/adapters/observability/dependency-probes.ts; `createDependencyClients` only composes them.
      //
      // REQUIREDNESS IS THE WEB ROLE'S, from config/environment/required.json `service_roles.web`: all four of these are
      // required, and the two this role does NOT require are absent from this list on purpose. A dependency with no
      // configuration gets no client, so it is reported as unconfigured rather than as healthy - and on this process the
      // worker heartbeat and the provider transport are exactly that, because neither store nor transport is declared
      // for this role here.
      role: 'web',
      probes: toDependencyProbes(
        createDependencyClients({
          // A REAL query, not a configuration check: a probe that only read the environment would report ready for a
          // database that is down (VG-API-059).
          querySessionRole: async (): Promise<string> => {
            let role = '';
            await runner.withTenantTransaction('00000000-0000-4000-8000-000000000000', async (tx) => {
              const result = (await tx.query('SELECT current_user AS role')) as { rows?: { role?: unknown }[] };
              role = String(result.rows?.[0]?.role ?? '');
            });
            return role;
          },
          // The tenant-scoped application role. A pool that connected as the owner would bypass row-level security, and
          // the probe treats that as the failure it is (VG-DATA-001).
          expectedRole: 'vg_app',
          valkeyUrl: config.valkeyUrl,
          keycloakIssuer: config.keycloakIssuer,
          // THE OBJECT STORE IS CONFIGURED FROM THE DECLARED VARIABLES, and the probe object's digest is the one
          // .agent/evidence/EP-010/M25-object-store/object-store-verification.md records as verified.
          ...(process.env['S3_ENDPOINT'] === undefined || process.env['S3_BUCKET'] === undefined
            ? {}
            : {
                objectStore: {
                  endpoint: String(process.env['S3_ENDPOINT']),
                  bucket: String(process.env['S3_BUCKET']),
                  // S3_REGION is DECLARED as an OPTIONAL key in config/environment/schema.json, and the default below is
                  // the same declared local default scripts/induced-failure-readiness.sh uses for VG_OBJECT_STORE_REGION
                  // (`?? "us-east-1"`): one region for the local store, stated once in the configuration surface and once
                  // in each reader, rather than a second environment name invented here.
                  region: process.env['S3_REGION'] ?? 'us-east-1',
                  accessKeyId: String(process.env['S3_ACCESS_KEY_ID'] ?? ''),
                  secretAccessKey: String(process.env['S3_SECRET_ACCESS_KEY'] ?? ''),
                  probeKey: 'readiness/probe-object',
                  expectedDigest: '870ca51706812c52d2360d17a64dfe68edff9c6a475eb4098c9c24937b031561',
                },
              }),
        }),
        ['postgresql', 'valkey', 'object-store', 'keycloak-jwks'],
      ),
    },
  });

  const bound = await listen(app, { port: config.port, host: config.host });
  // Only the address is printed. Config values, including the DSN and the session secret, are
  // never logged (VG-SEC-002).
  console.log(`serve: listening on http://${bound.host}:${bound.port}/v1`);

  // THE METRICS LISTENER IS A SECOND, CLUSTER-INTERNAL LISTENER AND NOT A ROUTE (SPEC-007 §2.3 rule 2; EP-008 M5). It
  // binds its own address, serves exactly one path, and starts only when the configuration asks for it
  // (`VANISHGRAPH_METRICS_PORT` is 0 by default), so exposing a scrape endpoint is a deliberate operator choice rather
  // than something a running service does by accident. A catalogue that cannot be validated stops startup: an endpoint
  // that would serve nothing is worse than none, because it looks like a healthy scrape target.
  let metricsListener: Awaited<ReturnType<typeof startMetricsListener>> | null = null;
  if (config.metricsPort > 0) {
    metricsListener = await startMetricsListener({
      registry: createMetricsRegistryFromFile(METRICS_CATALOGUE_PATH),
      path: config.metricsPath,
      host: config.metricsHost,
      port: config.metricsPort,
      environment: process.env.VANISHGRAPH_ENVIRONMENT ?? 'local',
    });
    // The URL is printed because the bind port may have been chosen by the operating system; no configuration VALUE is
    // printed, only the address the operator asked for.
    console.log(`serve: metrics listening on ${metricsListener.url} (cluster-internal only)`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`serve: ${signal} received, closing`);
    if (metricsListener !== null) await metricsListener.close();
    await app.close();
    // Close the pool so in-flight transactions finish and no connection is left open.
    await runner.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return 0;
}

// THE PROCESS MUST NOT EXIT AFTER STARTUP. MEASURED DEFECT this corrects, and it was found by the
// artifact-bound smoke test of EP-009 M4 rather than by any in-process suite: this line used to be
// `process.exit(await main())`, which terminated the process the moment startup finished. The service printed
// `serve: listening on http://…/v1` and then exited with code 0, so `npm run serve` started a server that could
// never answer a request. No test noticed, because every API suite calls `app.inject` in-process and never waits
// for a listener. Now a successful startup simply falls through: the listening sockets keep the event loop
// alive, and a signal handler is the only thing that exits (`process.exit(0)` inside `shutdown`). A non-zero
// return still exits, because a refusal to start must be visible to whatever launched the process.
const exitCode = await main();
if (exitCode !== 0) process.exit(exitCode);
