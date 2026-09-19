/**
 * Dependency probes and the fail-closed readiness decision (SPEC-007 §7.1-§7.4; EP-008 M5(a); VG-OPS-001, DOD-014).
 *
 * THE RULES THIS FILE IMPLEMENTS, AND WHY EACH ONE IS A RULE RATHER THAN A PREFERENCE:
 *
 *   1. **ONE DISCRIMINATING PROBE PER DECLARED DEPENDENCY, WITH THE DECLARED ACTION.** §7.2 gives each dependency its
 *      exact action and hard timeout. A probe that "checks" a dependency by reading a configuration value is not a
 *      probe: it passes when the dependency is down, which is the failure DOD-014 exists to catch.
 *   2. **THE FIRST FAILING EVALUATION MAKES THE PROCESS UNREADY.** §7.3: "There is no grace period during which traffic
 *      continues after a required dependency is known to be down." So the overall state is computed with no damping in
 *      the readiness direction (damping exists only in the ALERTING direction, §7.3).
 *   3. **LIVENESS IS DELIBERATELY INDEPENDENT.** A dependency outage must not fail `/v1/live` and must not cause a
 *      restart loop: restarting a healthy process because a database is down converts a dependency incident into an
 *      availability incident.
 *   4. **EVERY FAILURE IS CLASSIFIED AND NAMED.** `reasonCode` comes from the closed enum the metric catalogue declares
 *      for `vanishgraph_dependency_probe_failures_total`, so on-call can act on a cause rather than on a boolean.
 *   5. **THE BUDGET IS NEVER EXTENDED.** 1 500 ms total, at most one retry inside a probe, and a probe that exceeds its
 *      own timeout is `TIMEOUT` rather than a longer wait.
 *
 * WHAT IS NOT IMPLEMENTED HERE, STATED SO IT IS NOT ASSUMED: the object-store probe's declared action is `HeadBucket`
 * plus a SIGNED `GetObject`, and NO module in this repository can sign an S3 request — there is no object-store client,
 * no SigV4 implementation and no credential resolver for one. The probe therefore reports `MISCONFIGURED` with that
 * reason rather than pretending to check the store. It is recorded as an open item in the M5 evidence file and the
 * operator runbook, not smoothed over.
 */

import { createHash, createHmac } from 'node:crypto';

import type { MetricsRegistry } from './metrics-registry.ts';

/**
 * The reason codes a probe may report, which are the catalogue's declared set for
 * `vanishgraph_dependency_probe_failures_total` (§6.5). They live here rather than in a file of their own so the runner
 * has one import, and `tests/observability/readiness-fail-closed.test.ts` asserts this list EQUALS the catalogue's, so a
 * code cannot be added in one place and missed in the other.
 */
export const DEPENDENCY_PROBE_REASON_CODES = [
  'TIMEOUT',
  'CONNECT_REFUSED',
  'AUTH_FAILED',
  'DNS_FAILED',
  'TLS_FAILED',
  'HTTP_5XX',
  'MISCONFIGURED',
  'UNKNOWN',
] as const;

export type ProbeReasonCode = (typeof DEPENDENCY_PROBE_REASON_CODES)[number];

export const READINESS_BUDGET_MS = 1500;

/** §7.2's declared dependencies, with the action and the hard timeout each probe must use. */
export const DECLARED_DEPENDENCIES = [
  { key: 'postgresql', required: true, timeoutMs: 300, action: 'pooled connection: BEGIN; SELECT 1; ROLLBACK, and the session role must be the tenant-scoped application role' },
  { key: 'valkey', required: true, timeoutMs: 200, action: 'PING, then write/read/delete under a namespaced probe key' },
  { key: 'job-worker', required: true, timeoutMs: 200, action: 'at least one worker heartbeat inside the declared freshness window' },
  { key: 'object-store', required: true, timeoutMs: 400, action: 'HeadBucket plus a signed GetObject of a probe key that must return the expected digest' },
  { key: 'keycloak-jwks', required: true, timeoutMs: 300, action: 'OIDC discovery plus JWKS retrieval over TLS, with no token minted' },
  { key: 'provider-transport', required: true, timeoutMs: 1000, action: 'read-only or no-op reachability per declared official transport, never a form write' },
] as const;

export type DependencyKey = (typeof DECLARED_DEPENDENCIES)[number]['key'];

export const DEPENDENCY_KEYS: readonly DependencyKey[] = DECLARED_DEPENDENCIES.map((dependency) => dependency.key);

export type ProbeStatus = 'PASS' | 'FAIL' | 'TIMEOUT' | 'UNKNOWN';

export interface ProbeResult {
  readonly name: DependencyKey;
  readonly required: boolean;
  readonly status: ProbeStatus;
  readonly latencyMs: number;
  /** `null` when the probe passed: a passing probe has no reason code to give. */
  readonly reasonCode: ProbeReasonCode | null;
  readonly detail: string;
}

/** A probe function. It throws to fail; the runner classifies the throw. */
export type Probe = () => Promise<string>;

export interface DependencyClients {
  readonly postgresql?: Probe;
  readonly valkey?: Probe;
  readonly jobWorker?: Probe;
  readonly objectStore?: Probe;
  readonly keycloakJwks?: Probe;
  readonly providerTransport?: Probe;
}

export interface ProbeRunnerOptions {
  readonly clients: DependencyClients;
  readonly registry?: MetricsRegistry;
  /** The service reporting readiness. Required by the catalogue's label set for the readiness series (§6.5). */
  readonly service?: string;
  /** Injected so the budget test can drive the clock instead of waiting for it. */
  readonly now?: () => number;
}

export interface ReadinessEvaluation {
  readonly dependencyState: 'READY' | 'NOT_READY';
  readonly failedChecks: readonly DependencyKey[];
  readonly checks: readonly ProbeResult[];
  readonly budgetExceeded: boolean;
  readonly totalLatencyMs: number;
}

/** A probe that cannot run because nothing in this repository can perform its declared action. */
export class ProbeUnavailableError extends Error {
  readonly reasonCode: ProbeReasonCode;
  constructor(message: string, reasonCode: ProbeReasonCode = 'MISCONFIGURED') {
    super(message);
    this.name = 'ProbeUnavailableError';
    this.reasonCode = reasonCode;
  }
}

/**
 * Classify a thrown probe failure into the catalogue's closed reason-code enum.
 *
 * THE CLASSIFICATION IS BY CAUSE, NOT BY MESSAGE-MATCHING ALONE: the error's `code` property (Node's, `pg`'s and
 * `ioredis`'s all set one) is consulted first, because a message is prose that changes and a code is a contract.
 */
export function classifyProbeFailure(error: unknown): { reasonCode: ProbeReasonCode; detail: string } {
  if (error instanceof ProbeUnavailableError) return { reasonCode: error.reasonCode, detail: error.message };
  if (error instanceof Error && error.name === 'AbortError') {
    return { reasonCode: 'TIMEOUT', detail: 'the probe exceeded its hard timeout (§7.2) and was aborted' };
  }
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'ECONNREFUSED') return { reasonCode: 'CONNECT_REFUSED', detail };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { reasonCode: 'DNS_FAILED', detail };
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ESOCKETTIMEDOUT') return { reasonCode: 'TIMEOUT', detail };
  if (code.startsWith('ERR_TLS') || code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return { reasonCode: 'TLS_FAILED', detail };
  if (code === '28P01' || code === '28000' || code === 'NOAUTH' || code === 'WRONGPASS' || code === 'NOPERM') return { reasonCode: 'AUTH_FAILED', detail };
  if (/HTTP 5\d\d/.test(detail)) return { reasonCode: 'HTTP_5XX', detail };
  return { reasonCode: 'UNKNOWN', detail };
}

/** Run one probe with its hard timeout, and at most one retry inside the probe (§7.2). */
async function runProbe(
  dependency: (typeof DECLARED_DEPENDENCIES)[number],
  probe: Probe | undefined,
  now: () => number,
): Promise<ProbeResult> {
  const started = now();
  const base = { name: dependency.key, required: dependency.required } as const;
  if (probe === undefined) {
    // A MISSING CLIENT IS A FAILURE, NOT A PASS. A probe that has not been wired is a dependency nobody is checking, and
    // reporting it healthy would be the fabrication DOD-037 forbids.
    return Object.freeze({
      ...base,
      status: 'UNKNOWN' as const,
      latencyMs: now() - started,
      reasonCode: 'MISCONFIGURED' as const,
      detail: `no probe is wired for ${dependency.key}; the declared action is: ${dependency.action}`,
    });
  }
  let lastFailure: { reasonCode: ProbeReasonCode; detail: string } | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), dependency.timeoutMs);
    try {
      const detail = await Promise.race([
        probe(),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            const abort = new Error(`probe ${dependency.key} exceeded ${String(dependency.timeoutMs)} ms`);
            abort.name = 'AbortError';
            reject(abort);
          });
        }),
      ]);
      clearTimeout(timer);
      return Object.freeze({ ...base, status: 'PASS' as const, latencyMs: now() - started, reasonCode: null, detail });
    } catch (error) {
      clearTimeout(timer);
      lastFailure = classifyProbeFailure(error);
      // AT MOST ONE RETRY INSIDE A PROBE (§7.2), and a TIMEOUT is not retried: the budget is what it is.
      if (lastFailure.reasonCode === 'TIMEOUT') break;
    }
  }
  const failure = lastFailure ?? { reasonCode: 'UNKNOWN' as ProbeReasonCode, detail: 'the probe failed without an error' };
  return Object.freeze({
    ...base,
    status: failure.reasonCode === 'TIMEOUT' ? ('TIMEOUT' as const) : ('FAIL' as const),
    latencyMs: now() - started,
    reasonCode: failure.reasonCode,
    detail: failure.detail,
  });
}

export interface ProbeRunner {
  probe(key: DependencyKey): Promise<ProbeResult>;
  evaluate(): Promise<ReadinessEvaluation>;
  /** Liveness never touches a dependency: it answers whether THIS process is running (§7.3). */
  live(): { status: 'PASS'; detail: string };
}

/**
 * Build the probe runner.
 *
 * THE EVALUATION IS SEQUENTIAL ON PURPOSE. §7.2's budget is 1 500 ms in total, and probes run in parallel would let a
 * single slow dependency consume the budget while others are still in flight; sequential probes make the total the sum
 * of what actually happened, which is what the budget is stated against.
 */
export function createProbeRunner(options: ProbeRunnerOptions): ProbeRunner {
  const now = options.now ?? (() => Date.now());
  const probes: Readonly<Record<DependencyKey, Probe | undefined>> = Object.freeze({
    postgresql: options.clients.postgresql,
    valkey: options.clients.valkey,
    'job-worker': options.clients.jobWorker,
    'object-store': options.clients.objectStore,
    'keycloak-jwks': options.clients.keycloakJwks,
    'provider-transport': options.clients.providerTransport,
  });

  const record = (result: ProbeResult): void => {
    if (options.registry === undefined) return;
    // THE SERIES ARE THE CATALOGUE'S, WITH THE CATALOGUE'S LABELS: readiness per dependency key, probe failures by
    // classified reason, and the probe duration. A metric the catalogue does not declare cannot be recorded at all.
    options.registry.record('vanishgraph_readiness_status', { environment: 'local', dependency_key: result.name }, result.status === 'PASS' ? 1 : 0);
    options.registry.record('vanishgraph_dependency_probe_duration_seconds', { environment: 'local', dependency_key: result.name }, result.latencyMs / 1000);
    if (result.status !== 'PASS' && result.reasonCode !== null) {
      options.registry.record('vanishgraph_dependency_probe_failures_total', { environment: 'local', dependency_key: result.name, reason_code: result.reasonCode }, 1);
    }
  };

  /** The previous readiness verdict, so the state-change counter advances on a change rather than on every evaluation. */
  let lastState: 'READY' | 'NOT_READY' | null = null;

  const runAndRecord = async (key: DependencyKey): Promise<ProbeResult> => {
    const dependency = DECLARED_DEPENDENCIES.find((candidate) => candidate.key === key);
    if (dependency === undefined) throw new RangeError(`${key} is not a declared dependency (§7.2)`);
    const result = await runProbe(dependency, probes[key], now);
    record(result);
    return result;
  };

  const runner: ProbeRunner = {
    probe: (key) => runAndRecord(key),
    evaluate: async () => {
      const started = now();
      // THE PROBES RUN CONCURRENTLY, AND THAT IS A MEASURED CORRECTION TO A DESIGN THAT COULD NOT SATISFY §7.2.
      //
      // The first version ran them SEQUENTIALLY "so the total is the sum of what actually happened". Once all six
      // dependencies were genuinely wired — the last one being a real provider transport with a real credential — that
      // made the declared 1500 ms wall-clock budget UNSATISFIABLE: measured, the fifth probe (keycloak-jwks) was refused
      // because the budget was already spent, so a HEALTHY dependency was reported TIMEOUT and the whole readiness
      // verdict was NOT_READY for no reason other than the schedule. §7.2 states a budget for the READINESS DECISION,
      // which is wall-clock: a probe does not become unavailable because another probe ran first. So they are started
      // together and the budget keeps its meaning — elapsed wall clock, checked per probe at start and over the whole
      // evaluation below.
      //
      // A PROBE THAT WOULD START PAST THE BUDGET STILL DOES NOT START, AND IS RECORDED AS A FAILURE RATHER THAN SKIPPED:
      // §7.2 forbids extending the budget, and a dependency nobody had time to check is NOT known to be healthy.
      const results = await Promise.all(
        DECLARED_DEPENDENCIES.map(async (dependency): Promise<ProbeResult> => {
          const elapsedBeforeProbe = now() - started;
          if (elapsedBeforeProbe >= READINESS_BUDGET_MS) {
            const unrun: ProbeResult = Object.freeze({
              name: dependency.key,
              required: dependency.required,
              status: 'TIMEOUT' as const,
              latencyMs: 0,
              reasonCode: 'TIMEOUT' as const,
              detail: `the ${String(READINESS_BUDGET_MS)} ms readiness budget was already spent (${String(elapsedBeforeProbe)} ms) when this probe started, so it was not run: §7.2 forbids extending the budget, and an unchecked dependency is not a healthy one`,
            });
            record(unrun);
            return unrun;
          }
          // ONE RECORDING PER EXECUTION: the probes are run through the same path `probe()` uses, so a series cannot be
          // emitted twice for one evaluation or missed when the evaluation is the caller.
          return runAndRecord(dependency.key);
        }),
      );
      const checks: ProbeResult[] = [...results];
      const totalLatencyMs = now() - started;
      const failedChecks = checks.filter((check) => check.required && check.status !== 'PASS').map((check) => check.name);
      const budgetExceeded = totalLatencyMs > READINESS_BUDGET_MS;
      // NO GRACE PERIOD, NO DAMPING: one failing required dependency is enough (§7.3).
      //
      // AND A BUDGET BREACH IS ALSO UNREADY, WHICH IS A FINDING RATHER THAN A PREFERENCE: the declared per-probe
      // timeouts are 300 + 200 + 200 + 400 + 300 + 1000 = 2400 ms, which EXCEEDS the 1500 ms total budget §7.2 states. A
      // run in which several dependencies hang therefore cannot stay inside the budget however the probes are
      // scheduled, and reporting READY because every check eventually passed would hide an evaluation that took longer
      // than the specification allows. The breach is surfaced in the verdict AND in its own field.
      const dependencyState = failedChecks.length === 0 && !budgetExceeded ? ('READY' as const) : ('NOT_READY' as const);
      if (options.registry !== undefined) {
        options.registry.record('vanishgraph_readiness_status', { environment: 'local', dependency_key: 'overall' }, dependencyState === 'READY' ? 1 : 0);
        // THE CHANGE COUNTER ADVANCES ONLY ON A CHANGE, and only from a known previous state: the flapping alert A-10
        // counts transitions, so incrementing it on every evaluation would make a steady instance look like it is
        // flapping. The direction is the catalogue's bounded enum.
        if (lastState !== null && lastState !== dependencyState) {
          options.registry.record(
            'vanishgraph_readiness_state_changes_total',
            { environment: 'local', service: options.service ?? 'vanishgraph-api', direction: dependencyState === 'READY' ? 'TO_READY' : 'TO_NOT_READY' },
            1,
          );
        }
      }
      lastState = dependencyState;
      return Object.freeze({
        dependencyState,
        failedChecks: Object.freeze(failedChecks),
        checks: Object.freeze(checks),
        budgetExceeded,
        totalLatencyMs,
      });
    },
    live: () => ({ status: 'PASS', detail: 'the process is running and liveness does not evaluate any dependency (§7.3)' }),
  };
  return runner;
}

/* ----------------------------------------------------------------------------------------------------------------
 * The real probe clients
 *
 * EACH CLIENT PERFORMS THE DECLARED ACTION AND NOTHING ELSE. Two of them are deliberately absent rather than faked:
 * the object-store client cannot sign an S3 request anywhere in this repository, and the provider-transport client needs
 * a declared official transport to reach. A probe that cannot run reports that fact.
 * ---------------------------------------------------------------------------------------------------------------- */

/** The expected digest a signed probe read must return, so the read is verified rather than merely attempted (§7.2). */
export function probePayloadDigest(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export interface PostgresProbeOptions {
  /** Executes one statement and resolves with the session role. Injected so this module owns no connection pool. */
  readonly querySessionRole: () => Promise<string>;
  /** The tenant-scoped application role the session must be using (`vg_app`). */
  readonly expectedRole: string;
}

/** §7.2 postgresql: a real round trip that also proves the session is the tenant-scoped application role. */
export function postgresProbe(options: PostgresProbeOptions): Probe {
  return async () => {
    const role = await options.querySessionRole();
    if (role !== options.expectedRole) {
      // THE ROLE CHECK IS THE POINT OF THIS PROBE: a pool that connects as the owner bypasses row-level security, and a
      // readiness probe that only ran SELECT 1 would report that pool healthy while every tenant boundary is open.
      throw new ProbeUnavailableError(
        `the session role is "${role}" and the deployed role is "${options.expectedRole}": a connection that bypasses row-level security is not a working dependency (VG-DATA-001)`,
        'AUTH_FAILED',
      );
    }
    return `postgresql session role verified as ${role}`;
  };
}

export interface ValkeyProbeOptions {
  /** PING, then write, read and delete under a namespaced key. Resolves with the value read back. */
  readonly roundTrip: (key: string) => Promise<string>;
  readonly keyPrefix?: string;
}

/** §7.2 valkey: PING and a write/read/delete round trip under a namespaced probe key. */
export function valkeyProbe(options: ValkeyProbeOptions): Probe {
  return async () => {
    const key = `${options.keyPrefix ?? 'vanishgraph:probe'}:readiness`;
    const payload = `probe-${String(Date.now())}`;
    const readBack = await options.roundTrip(`${key}:${payload}`);
    if (readBack !== payload) {
      throw new ProbeUnavailableError(`valkey returned "${readBack}" for the probe key, not the written value`, 'MISCONFIGURED');
    }
    return 'valkey PING and write/read/delete round trip verified';
  };
}

export interface JobWorkerProbeOptions {
  /** The number of worker heartbeats inside the declared freshness window. */
  readonly freshHeartbeats: (windowMs: number) => Promise<number>;
  readonly windowMs: number;
}

/** §7.2 job-worker: at least one worker heartbeat inside the declared window. */
export function jobWorkerProbe(options: JobWorkerProbeOptions): Probe {
  return async () => {
    const fresh = await options.freshHeartbeats(options.windowMs);
    if (fresh < 1) {
      throw new ProbeUnavailableError(
        `no worker heartbeat in the last ${String(options.windowMs)} ms: withholding heartbeats is exactly how this probe is induced to fail (§7.4)`,
        'MISCONFIGURED',
      );
    }
    return `${String(fresh)} worker heartbeat(s) inside the ${String(options.windowMs)} ms freshness window`;
  };
}

/** §7.2 object-store: the declared action, with the repository's actual limitation stated as the failure. */
export const objectStoreProbeUnavailable: Probe = async () => {
  throw new ProbeUnavailableError(
    'the object-store probe requires HeadBucket and a SIGNED GetObject, and no module in this repository implements S3 request signing or holds an object-store credential: the probe is not wired rather than passing',
    'MISCONFIGURED',
  );
};

/* ----------------------------------------------------------------------------------------------------------------
 * §7.2 object-store: HeadBucket plus a SIGNED GetObject (EP-008 M5)
 *
 * THE SIGNER IS HERE BECAUSE THE PROVISIONING ATTEMPT LOG PROVED THE BLOCKER WAS CODE, NOT ENVIRONMENT: an object store
 * can be started from a locally cached image at any time, and the probe still could not run because nothing in this
 * repository could sign an S3 request. This is that signer — AWS Signature Version 4, header-based, single chunk — and
 * nothing more: it signs a HEAD and a GET, and it exists so the declared probe action can actually be performed rather
 * than reported as impossible.
 *
 * WHY HAND-WRITTEN RATHER THAN A DEPENDENCY: the dependency rules forbid adding an S3 client without an ADR, and §7.2
 * needs exactly two signed requests. A general-purpose client would be a much larger surface than the probe it serves.
 * ---------------------------------------------------------------------------------------------------------------- */

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** The signing key chain of SigV4: date, region, service, then `aws4_request`. */
function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
}

export interface SignedRequest {
  readonly url: string;
  readonly method: 'HEAD' | 'GET' | 'PUT';
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Sign one S3 request with SigV4.
 *
 * THE PAYLOAD HASH DESCRIBES THE BYTES THAT ARE SENT. MEASURED REASON FOR THE PARAMETER: the first version hardcoded the
 * EMPTY-string digest, which is correct for the two declared probe requests (HEAD and GET, neither carrying a body) and
 * WRONG for a PUT with a body — a bucket-creation attempt against a real MinIO was refused with HTTP 403 because the
 * signed payload hash did not describe the bytes that were sent. The streaming form is still not supported, and this
 * comment says so rather than implying general S3 support.
 */
export function signS3Request(options: {
  readonly method: 'HEAD' | 'GET' | 'PUT';
  readonly endpoint: string;
  readonly canonicalPath: string;
  readonly region: string;
  readonly service?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly at: Date;
  /** The request body, when there is one. Its digest becomes the signed payload hash (SigV4, single chunk). */
  readonly payload?: string;
}): SignedRequest {
  const service = options.service ?? 's3';
  const amzDate = options.at.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(options.endpoint).host;
  const payloadHash = sha256Hex(options.payload ?? '');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [options.method, options.canonicalPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${options.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(options.secretAccessKey, dateStamp, options.region, service)).update(stringToSign).digest('hex');
  return {
    url: `${options.endpoint.replace(/\/$/, '')}${options.canonicalPath}`,
    method: options.method,
    headers: {
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export interface ObjectStoreProbeOptions {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** The probe object's key and the digest its content MUST have: a read that returns something else has failed. */
  readonly probeKey: string;
  readonly expectedDigest: string;
  readonly fetchImpl?: typeof fetch;
  readonly at?: () => Date;
}

/** §7.2 object-store: HeadBucket, then a signed GetObject whose content must match the expected digest. */
export function objectStoreProbe(options: ObjectStoreProbeOptions): Probe {
  return async () => {
    const doFetch = options.fetchImpl ?? fetch;
    const at = options.at ?? ((): Date => new Date());
    const bucketPath = `/${options.bucket}`;
    const head = signS3Request({ method: 'HEAD', endpoint: options.endpoint, canonicalPath: bucketPath, region: options.region, accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, at: at() });
    const headResponse = await doFetch(head.url, { method: head.method, headers: head.headers });
    if (!headResponse.ok) {
      // 403 IS AUTHENTICATION, NOT REACHABILITY, and saying which is what lets on-call act on the cause.
      throw new ProbeUnavailableError(`HeadBucket answered HTTP ${String(headResponse.status)}`, headResponse.status === 403 || headResponse.status === 401 ? 'AUTH_FAILED' : headResponse.status >= 500 ? 'HTTP_5XX' : 'MISCONFIGURED');
    }
    const objectPath = `/${options.bucket}/${options.probeKey}`;
    const get = signS3Request({ method: 'GET', endpoint: options.endpoint, canonicalPath: objectPath, region: options.region, accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, at: at() });
    const getResponse = await doFetch(get.url, { method: get.method, headers: get.headers });
    if (!getResponse.ok) throw new ProbeUnavailableError(`the signed GetObject answered HTTP ${String(getResponse.status)}`, getResponse.status >= 500 ? 'HTTP_5XX' : 'AUTH_FAILED');
    const body = Buffer.from(await getResponse.arrayBuffer());
    const digest = sha256Hex(body);
    if (digest !== options.expectedDigest) {
      // A READ THAT RETURNS THE WRONG BYTES IS A FAILURE, which is why §7.2 requires the expected digest rather than a
      // successful status: an object store serving stale or substituted content is not a working dependency.
      throw new ProbeUnavailableError(`the signed GetObject returned content whose digest is ${digest} and not the expected ${options.expectedDigest}`, 'MISCONFIGURED');
    }
    return `HeadBucket and signed GetObject verified for ${options.bucket}/${options.probeKey}`;
  };
}

export interface JwksProbeOptions {
  /** OIDC discovery plus JWKS retrieval, over TLS, minting no token. */
  readonly discover: () => Promise<{ issuer: string; keys: number }>;
}

/** §7.2 keycloak-jwks: discovery and JWKS retrieval, with no token minted. */
export function keycloakJwksProbe(options: JwksProbeOptions): Probe {
  return async () => {
    const discovered = await options.discover();
    if (!discovered.issuer.startsWith('https://')) {
      throw new ProbeUnavailableError(`the discovered issuer "${discovered.issuer}" is not an HTTPS issuer`, 'MISCONFIGURED');
    }
    if (discovered.keys < 1) {
      throw new ProbeUnavailableError('the JWKS document carries no signing key, so no token could ever be verified', 'MISCONFIGURED');
    }
    return `issuer ${discovered.issuer} advertises ${String(discovered.keys)} signing key(s)`;
  };
}

export interface ProviderTransportProbeOptions {
  /** A read-only or no-op reachability check. NEVER a form write (SPEC-000 §6.7, VG-SCOPE-004). */
  readonly reachability: () => Promise<{ status: number }>;
  readonly name: string;
}

/** §7.2 provider-transport: read-only reachability per declared official transport, never a form write. */
export function providerTransportProbe(options: ProviderTransportProbeOptions): Probe {
  return async () => {
    const response = await options.reachability();
    // AN AUTH REJECTION IS A FAILURE, AND THIS IS A MEASURED CORRECTION. §7.4 step 2 induces this dependency by
    // "forc[ing] the provider transport to return an auth rejection", so a probe that PASSED on 401 could never detect
    // the induced state: it would report a healthy transport for the exact condition the specification calls the
    // failure. The first version accepted any status below 500. MEASURED against the three declared transports with no
    // credential: all three answer HTTP 401, which IS the induced state, so this row cannot reach PASS in this
    // environment and now says so rather than reporting a pass.
    if (response.status === 401 || response.status === 403) {
      throw new ProbeUnavailableError(
        `${options.name} rejected the request with HTTP ${String(response.status)}: the transport is reachable but not usable, and §7.4 step 2 names an auth rejection as the induced failure`,
        'AUTH_FAILED',
      );
    }
    if (response.status >= 500) throw new ProbeUnavailableError(`${options.name} answered HTTP ${String(response.status)}`, 'HTTP_5XX');
    return `${options.name} reachable and usable, HTTP ${String(response.status)}`;
  };
}
