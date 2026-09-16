/**
 * The security configuration boundary (SPEC-005 §1/§8/§9, SPEC-003 §3.2; EP-006 M1).
 *
 * IT ABORTS ON AN ABSENT VALUE AND NEVER LOGS ONE. SPEC-006 §8's masking rules are the reason: a configuration error
 * that prints the value it was given turns a startup failure into a credential disclosure in a log, and logs travel
 * further than the process does. Every message in this module names the VARIABLE and never its content, and the M1 suite
 * asserts that by driving each failure with a sentinel value and requiring the sentinel not to appear in the message.
 *
 * THE AUDIENCE VALUES ARE NOT INVENTED. SPEC-005 §1/§9 declare the audience model; the concrete strings (`<PORTAL_AUD>`,
 * `<SERVICE_AUD>`, `<MCP_AUD>`, `<REALM_ISSUER>`, `<STEP_UP_ACR>`) are filled from the client registration when a realm
 * exists. Until then they are ABSENT, and this module's job is to say which one is absent rather than to substitute a
 * plausible default: a default audience would make a misconfigured deployment look configured, and every token check
 * downstream would validate against a value nobody registered.
 */

/** The variables this boundary reads, in the order a reader should set them. */
export const SECURITY_ENV_VARS: readonly string[] = Object.freeze([
  'KEYCLOAK_ISSUER',
  'KEYCLOAK_CLIENT_ID',
  'KEYCLOAK_CLIENT_SECRET',
  'SESSION_SECRET',
  'KEYCLOAK_PORTAL_AUDIENCE',
  'KEYCLOAK_SERVICE_AUDIENCE',
  'KEYCLOAK_MCP_AUDIENCE',
  'KEYCLOAK_STEP_UP_ACR',
]);

export interface SecurityConfig {
  readonly realmIssuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly sessionSecret: string;
  readonly audiences: {
    readonly portal: string;
    readonly service: string;
    readonly mcp: string;
  };
  readonly stepUpAcr: string;
}

/** The one error shape this boundary throws: the variable's name, never its value. */
export class SecurityConfigError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`dependency unavailable: ${variable} is unset; see PREFLIGHT.md and .env.example`);
    this.name = 'SecurityConfigError';
    this.variable = variable;
  }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) throw new SecurityConfigError(name);
  return value;
}

/**
 * Read and validate the security configuration.
 *
 * A SECRET SHORTER THAN THE MINIMUM IS REFUSED rather than accepted quietly: `SESSION_SECRET` signs a session cookie,
 * and a short one is a signature an offline attacker can guess. The minimum is 32 characters, the same length the token
 * and digest material uses.
 */
export function readSecurityConfig(env: Readonly<Record<string, string | undefined>>): SecurityConfig {
  const sessionSecret = required(env, 'SESSION_SECRET');
  if (sessionSecret.length < 32) {
    // The message names the variable and the requirement, never the value.
    throw new Error('dependency unavailable: SESSION_SECRET is shorter than the 32-character minimum; see PREFLIGHT.md');
  }
  return {
    realmIssuer: required(env, 'KEYCLOAK_ISSUER'),
    clientId: required(env, 'KEYCLOAK_CLIENT_ID'),
    clientSecret: required(env, 'KEYCLOAK_CLIENT_SECRET'),
    sessionSecret,
    audiences: {
      portal: required(env, 'KEYCLOAK_PORTAL_AUDIENCE'),
      service: required(env, 'KEYCLOAK_SERVICE_AUDIENCE'),
      mcp: required(env, 'KEYCLOAK_MCP_AUDIENCE'),
    },
    stepUpAcr: required(env, 'KEYCLOAK_STEP_UP_ACR'),
  };
}

/** Which variables are absent, for a status report. Names only, in the declaration's order. */
export function missingSecurityEnvVars(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return SECURITY_ENV_VARS.filter((name) => env[name] === undefined || (env[name] ?? '').trim().length === 0);
}
