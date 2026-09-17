/**
 * Service configuration (SPEC-003 §2.1, SPEC-006 §9.1 rule 3).
 *
 * This module is the ONLY place a service reads its environment. Two properties matter and are
 * enforced here rather than by convention:
 *
 *  1. **It fails closed.** A missing required variable aborts bootstrap with the exact message
 *     `dependency unavailable: <ENV_NAME> is unset; see PREFLIGHT.md and .env.example`. It never
 *     invents a default, never falls back to an in-process substitute, and never treats an
 *     empty string as a value. A service that starts without its database would answer requests
 *     it cannot serve, which is worse than not starting.
 *  2. **It never logs a value.** Only the variable NAME is ever mentioned. VG-SEC-002 and
 *     HARNESS_LAWS.md NM-* exist because a credential in a log line is a credential disclosed,
 *     and log aggregation outlives the incident.
 *
 * No secret appears in this file, in an error message, or in a thrown object's public fields.
 */

/** The variables the service cannot start without, with the probe that evidences each. */
export const REQUIRED_VARIABLES = {
  DATABASE_URL: 'scripts/probes/database_url.sh',
  VALKEY_URL: 'scripts/probes/valkey_url.sh',
  KEYCLOAK_ISSUER: 'scripts/probes/keycloak.sh',
  KEYCLOAK_CLIENT_ID: undefined,
  SESSION_SECRET: undefined,
} as const;

export type RequiredVariable = keyof typeof REQUIRED_VARIABLES;

export interface ServiceConfig {
  readonly databaseUrl: string;
  readonly valkeyUrl: string;
  readonly keycloakIssuer: string;
  readonly keycloakClientId: string;
  readonly sessionSecret: string;
  /** 0 disables the listener's port binding; tests always use 0 and `app.inject`. */
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  /**
   * The metrics scrape path of SPEC-007 §2.3 (`VANISHGRAPH_METRICS_PATH`, default `/metrics`).
   *
   * DECLARED HERE BECAUSE THE ENDPOINT IS CLUSTER-INTERNAL BY SPECIFICATION: §2.3 rule 2 requires `GET /metrics` to be
   * served on the process's metrics listener and to be unreachable from the public ingress, so its path and its bind
   * address are configuration rather than a route on the public server. The LISTENER itself is not built yet (EP-008
   * M5's outstanding item); this is the surface it will read, and nothing here claims it is being served.
   */
  readonly metricsPath: string;
  /** The cluster-internal bind address for the metrics listener. Defaults to the public host, never to 0.0.0.0. */
  readonly metricsHost: string;
  /** 0 means "no metrics listener"; tests leave it 0 so nothing binds a port. */
  readonly metricsPort: number;
}

/**
 * Raised when the service cannot be configured.
 *
 * `variable` carries the NAME only. There is deliberately no field for a value, so a caller
 * cannot accidentally serialise one into a log or an error response.
 */
export class ConfigurationError extends Error {
  readonly variable: string | undefined;
  constructor(message: string, variable?: string) {
    super(message);
    this.name = 'ConfigurationError';
    this.variable = variable;
  }
}

function requireVariable(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  // An empty string is NOT a value. Treating "" as configured is how a service binds to a
  // blank DSN and fails later, in a request, instead of at startup.
  if (raw === undefined || raw.trim().length === 0) {
    throw new ConfigurationError(
      `dependency unavailable: ${name} is unset; see PREFLIGHT.md and .env.example`,
      name,
    );
  }
  return raw;
}

function optionalPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT;
  if (raw === undefined || raw.trim().length === 0) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new ConfigurationError('dependency unavailable: PORT is not a valid TCP port', 'PORT');
  }
  return parsed;
}

/**
 * Read and validate configuration.
 *
 * Every required variable is checked BEFORE returning, and all failures are collected, so an
 * operator sees the complete set of missing dependencies in one start attempt rather than
 * discovering them one restart at a time.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const missing: string[] = [];
  const values = new Map<string, string>();

  for (const name of Object.keys(REQUIRED_VARIABLES)) {
    try {
      values.set(name, requireVariable(env, name));
    } catch {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    const detail = missing
      .map((name) => {
        const probe = REQUIRED_VARIABLES[name as RequiredVariable];
        return probe === undefined ? name : `${name} (probe: sh ${probe})`;
      })
      .join(', ');
    throw new ConfigurationError(
      `dependency unavailable: ${missing.join(', ')} unset; see PREFLIGHT.md and .env.example. ` +
        `Missing: ${detail}`,
      missing[0],
    );
  }

  return {
    // Non-null assertions are avoided: the loop above guarantees presence, and this re-read
    // keeps the guarantee in one place rather than spreading `!` through the object literal.
    databaseUrl: values.get('DATABASE_URL') ?? '',
    valkeyUrl: values.get('VALKEY_URL') ?? '',
    keycloakIssuer: values.get('KEYCLOAK_ISSUER') ?? '',
    keycloakClientId: values.get('KEYCLOAK_CLIENT_ID') ?? '',
    sessionSecret: values.get('SESSION_SECRET') ?? '',
    port: optionalPort(env),
    host: env.HOST ?? '127.0.0.1',
    logLevel: env.LOG_LEVEL ?? 'info',
    // THE METRICS SURFACE DEFAULTS TO CLUSTER-INTERNAL AND OFF: the default bind address is the same loopback the
    // service already uses, never 0.0.0.0, and port 0 means no listener. An operator must opt in to exposing a scrape
    // endpoint, and §2.3 rule 2 forbids it on the public ingress.
    metricsPath: (env.VANISHGRAPH_METRICS_PATH ?? '/metrics').trim() || '/metrics',
    metricsHost: env.VANISHGRAPH_METRICS_HOST ?? env.HOST ?? '127.0.0.1',
    metricsPort: optionalMetricsPort(env),
  };
}

/** The metrics listener's port. 0 (the default) means the listener is not started. */
function optionalMetricsPort(env: NodeJS.ProcessEnv): number {
  const raw = env.VANISHGRAPH_METRICS_PORT;
  if (raw === undefined || raw.trim().length === 0) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new ConfigurationError('dependency unavailable: VANISHGRAPH_METRICS_PORT is not a valid TCP port', 'VANISHGRAPH_METRICS_PORT');
  }
  return parsed;
}

/**
 * Report which required variables are absent, WITHOUT reading or revealing their values.
 *
 * Used by the health/readiness path and by `gate-api.sh` to evidence `BLOCKED_CREDENTIALS`.
 */
export function missingVariables(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return Object.keys(REQUIRED_VARIABLES).filter((name) => {
    const value = env[name];
    return value === undefined || value.trim().length === 0;
  });
}
