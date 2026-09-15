/**
 * The Fastify application (SPEC-003 §1, §2.4).
 *
 * Two properties of this file matter more than its contents:
 *
 *  1. **`buildServer` never touches the network.** It constructs the instance and registers
 *     plugins; `listen` lives in a separate entry point. That is what lets every contract test
 *     drive the real HTTP boundary through `app.inject` with no port, no race, and no cleanup.
 *  2. **Plugin order is fixed and load-bearing.** Correlation runs first so every later error and
 *     log line carries the same `correlationId`; the error handler runs before anything that can
 *     throw; identity runs before tenancy because a tenant is derived FROM the validated token;
 *     and routes run last so they can rely on all of it. Reordering these silently breaks
 *     correlation on 401 responses — the failures that most need correlating.
 *
 * The server does not decide truth states, does not import `src/domain`, and does not open a
 * connection. Handlers dispatch application commands; enforcement lives behind the ports.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import type { JsonSchemaToTsProvider } from '@fastify/type-provider-json-schema-to-ts';

import { healthRoutes, type HealthDependencies } from './routes/health.ts';
import { subjectRoutes } from './routes/subjects.ts';
import { sourceRoutes } from './routes/sources.ts';
import { appealRoutes } from './routes/appeals.ts';
import { deadlineRoutes } from './routes/deadlines.ts';
import { auditRoutes } from './routes/audit.ts';
import { observationRoutes } from './routes/observations.ts';
import { exposureRoutes } from './routes/exposures.ts';
import type { SubjectQueries } from '../application/contracts/subject-queries.ts';
import type { RecipeVerificationKeys, SourceQueries } from '../application/contracts/source-queries.ts';
import type { AppealQueries } from '../application/contracts/appeal-queries.ts';
import type { DeadlineQueries } from '../application/contracts/deadline-queries.ts';
import type { AuditQueries } from '../application/contracts/audit-queries.ts';
import type { ObservationQueries } from '../application/contracts/observation-queries.ts';
import type { ExposureQueries } from '../application/contracts/exposure-queries.ts';
import type { TransitionQueries } from '../application/contracts/transition-queries.ts';
import { installCorrelation } from './plugins/correlation.ts';
import { installErrorHandler } from './plugins/error-handler.ts';
import { installIdentity, type IdentityPluginOptions } from './plugins/identity.ts';
import { installTenancy, type TenancyPluginOptions } from './plugins/tenancy.ts';
import { installIdempotency, type IdempotencyPluginOptions } from './plugins/idempotency.ts';

/**
 * The concrete Fastify type every route in this service is registered against.
 *
 * The logger parameter uses `FastifyBaseLogger` rather than pino's `Logger`: Fastify narrows the
 * logger internally, and naming pino here produced a type that `buildServer` could not return
 * (`Property 'msgPrefix' is missing`). The alias must describe what Fastify actually constructs,
 * not what its default logger happens to be.
 */
export type VgFastify = FastifyInstance<
  import('node:http').Server,
  import('node:http').IncomingMessage,
  import('node:http').ServerResponse,
  import('fastify').FastifyBaseLogger,
  JsonSchemaToTsProvider
>;

export interface ServerDependencies {
  /** Readiness probes (SPEC-003 §5.17). Injected so readiness reflects real dependency state. */
  readonly health: HealthDependencies;
  /** Build identity reported by `/v1/health`. */
  readonly version: string;
  readonly commit: string;
  /**
   * Identity resolution (SPEC-003 §3, SPEC-005 IDP-1…IDP-6).
   *
   * REQUIRED, not optional. EP-004 M1 declared it optional and a server built without it could not
   * serve data routes; M3 made it mandatory because an optional authentication plugin is a
   * configuration in which every route is unauthenticated, and a fail-closed default that depends on
   * remembering to pass an argument is not fail-closed.
   */
  readonly identity: IdentityPluginOptions;
  /**
   * Tenancy (SPEC-003 §2.4, VG-TENANT-001). Required for the same reason: a request with no tenant
   * binding must be unrepresentable rather than merely refused by convention.
   */
  readonly tenancy: TenancyPluginOptions;
  /**
   * Idempotency (SPEC-003 §4, VG-ACTION-001).
   *
   * REQUIRED, for the same reason as identity: an optional idempotency plugin is a configuration in
   * which an effect-bearing route can submit a duplicate external write, and the mistake would be
   * invisible because the handler looks correct.
   */
  readonly idempotency: IdempotencyPluginOptions;
  /**
   * The cursor signing secret (SPEC-003 §2.5). REQUIRED: a cursor signed with an empty or default
   * secret is a cursor an attacker can mint, and ncodeCursor refuses an empty one rather than
   * producing forgeable values. It comes from configuration and is never a literal in this layer.
   */
  readonly sessionSecret: string;
  /**
   * The subject read model (SPEC-003 §5.1). Injected as a port so the boundary never imports an
   * adapter; the composition root supplies the PostgreSQL implementation.
   */
  readonly subjectQueries: SubjectQueries;
  /**
   * The source catalogue and recipe read/write model (SPEC-003 §5.3). Injected as a port for the same
   * reason as `subjectQueries`.
   */
  readonly sourceQueries: SourceQueries;
  /**
   * The trusted recipe signing keys (SPEC-003 §5.3.7, VG-CHANNEL-003).
   *
   * REQUIRED, and legitimately EMPTY. An empty map is not a degraded mode: it means no key is
   * configured, so `POST /v1/sources/{sourceId}/recipes` refuses with `503 DEPENDENCY_UNAVAILABLE`
   * rather than storing a recipe whose signature nobody checked. ADR-006 (KMS selection) is OPEN, so
   * this is the current state of every deployment — and it must be visible as a refusal, not as a
   * silently accepted unverified recipe.
   */
  readonly recipeVerificationKeys: RecipeVerificationKeys;
  /**
   * The appeal-escalation model (SPEC-003 §5.14). Injected as a port for the same reason as the others:
   * the boundary must not import `src/adapters/**` (ARCHITECTURE.md §2).
   */
  readonly appealQueries: AppealQueries;
  /**
   * The deadline model (SPEC-003 §5.13). Injected as a port for the same reason as the others. The clock is
   * NOT injected here: the routes read it once per request and pass the instant down, so a caller cannot
   * supply a different "now" to two halves of one derivation.
   */
  readonly deadlineQueries: DeadlineQueries;
  /**
   * The audit-stream read model (SPEC-003 §5.15). Injected as a port for the same reason as the others.
   */
  readonly auditQueries: AuditQueries;
  /**
   * The observation and reappearance read models (SPEC-003 §5.10.2, §5.10.3, §5.11.2, §5.11.3). One port for
   * four routes because they share the g.observations.read scope and one subject: what was OBSERVED.
   */
  readonly observationQueries: ObservationQueries;
  /**
   * The exposure model (SPEC-003 §5.5): two reads and the two guarded assessments that drive T3/T4.
   */
  readonly exposureQueries: ExposureQueries;
  /**
   * The transition spine (SPEC-003 §5.5.5, §5.7.3, §5.7.6). A SEPARATE port from `exposureQueries` because it
   * reads the audit trail rather than the aggregate: one answers "what is this exposure", the other answers
   * "what moved it", and a route that needs both should have to say so.
   */
  readonly transitionQueries: TransitionQueries;
  readonly logLevel?: string;
}


/**
 * Build the application.
 *
 * Deliberately synchronous and side-effect free: no `listen`, no DNS, no connection.
 */
export function buildServer(deps: ServerDependencies): VgFastify {
  const app = Fastify({
    // The correlation id is generated by our own plugin, so Fastify's is disabled: two id
    // generators would produce two ids and the log/response pair would not join.
    genReqId: () => '',
    logger: {
      level: deps.logLevel ?? 'info',
      // Redaction at the logger, as a second line of defence behind the error envelope: even if a
      // handler logged a header object wholesale, these paths never reach the sink (VG-SEC-002).
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["idempotency-key"]',
          'req.headers["x-vg-signature"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
    },
    // A route not in the registry must not be reachable. Handlers register only from ROUTES.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  }).withTypeProvider<JsonSchemaToTsProvider>();

  // ORDER IS LOAD-BEARING. See the file header.
  //
  // Installed directly rather than through `app.register`: register() runs a plugin in an
  // encapsulated child context, so its hooks apply only to routes registered INSIDE that child.
  // Measured: registering these as plugins left `request.correlationId` empty, set no
  // `x-correlation-id` header, and bypassed the error envelope entirely for sibling routes.
  installCorrelation(app);
  installErrorHandler(app);
  // Identity runs BEFORE tenancy: a tenant is derived FROM the validated token, so tenancy has
  // nothing to bind until identity has succeeded. Both run before routes so no handler can execute
  // without a context.
  installIdentity(app, deps.identity);
  installTenancy(app, deps.tenancy);
  // Idempotency runs AFTER identity (the scope key includes the tenant) and BEFORE routes, so the
  // claim happens before any handler can produce an effect.
  installIdempotency(app, deps.idempotency);

  // The SPEC-003 §5.1 group. Registered with Fastify's `:param` syntax; `beginHandler` normalises the
  // matched pattern back to the registry's `{param}` form, because the registry equals the
  // specification and the specification uses brace notation.
  app.register(subjectRoutes, { sessionSecret: deps.sessionSecret, queries: deps.subjectQueries });

  // The SPEC-003 §5.3 group. Same registration convention as §5.1.
  app.register(sourceRoutes, {
    sessionSecret: deps.sessionSecret,
    queries: deps.sourceQueries,
    verificationKeys: deps.recipeVerificationKeys,
  });

  // The SPEC-003 §5.14 group. No session secret: nothing in §5.14 paginates, so no cursor is minted —
  // passing one would advertise a pagination surface the routes do not have.
  app.register(appealRoutes, { queries: deps.appealQueries });

  // The SPEC-003 §5.13 group. No session secret: nothing in §5.13 paginates.
  app.register(deadlineRoutes, { queries: deps.deadlineQueries });

  // The SPEC-003 §5.15 group: two reads, and no mutation surface anywhere (VG-EVIDENCE-003).
  app.register(auditRoutes, { sessionSecret: deps.sessionSecret, queries: deps.auditQueries });

  // The SPEC-003 5.10.2/5.10.3/5.11.2/5.11.3 reads.
  app.register(observationRoutes, { sessionSecret: deps.sessionSecret, queries: deps.observationQueries });
  app.register(exposureRoutes, {
    sessionSecret: deps.sessionSecret,
    queries: deps.exposureQueries,
    transitions: deps.transitionQueries,
  });

  app.register(healthRoutes, {
    deps: deps.health,
    version: deps.version,
    commit: deps.commit,
  });

  return app;
}

/**
 * Start listening. Separate from `buildServer` so tests never bind a port.
 *
 * Returns the bound address so the caller can report the real port when 0 was requested.
 */
export async function listen(
  app: VgFastify,
  options: { readonly port: number; readonly host: string },
): Promise<{ readonly port: number; readonly host: string }> {
  await app.listen({ port: options.port, host: options.host });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    return { port: options.port, host: options.host };
  }
  return { port: address.port, host: options.host };
}
