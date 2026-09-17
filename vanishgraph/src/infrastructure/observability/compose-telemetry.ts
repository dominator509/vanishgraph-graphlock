/**
 * The single telemetry emission path (SPEC-007 §2.1, §2.2, §2.3; EP-008 M1; plan §7.2; DOD-029, DOD-037).
 *
 * WHY THIS FILE EXISTS RATHER THAN PER-CALL-SITE ATTRIBUTES: SPEC-007 §2.1 rule 4 requires the resource attributes to be
 * attached by the SDK's resource configuration rather than by individual call sites, so that a new call site cannot omit
 * them. This repository has NO OpenTelemetry SDK — `package.json` carries no telemetry dependency, measured and recorded
 * verbatim in `.agent/evidence/EP-008/M1-discovery.txt` — and EP-008's dependency rules forbid adding one without an ADR.
 * The plan's FALLBACK for exactly this case is taken: the attributes are attached in ONE composition function that wraps
 * every producer and is the only exported emission path. A new call site still cannot omit them, because there is no
 * other way to emit.
 *
 * WHAT THE FAILURE PATH DOES, PRECISELY. §2.1 rule 1: a producer that cannot resolve a key "refuses to emit, records the
 * refusal as a local structured error, and increments the telemetry-egress failure counter". So on refusal this module:
 *
 *   * emits ZERO records — nothing reaches the sink, and `emitted()` stays empty;
 *   * writes exactly ONE `TelemetryIdentityMissing` local structured error (§5.4's declared operational event) for the
 *     life of the producer, because a process that cannot identify itself should say so once, not once per record;
 *   * increments `vanishgraph_telemetry_egress_failures_total{reason_code="RESOURCE_ATTR_MISSING"}` (alert A-11's exact
 *     series) once per refused `emit` call, which is the volume signal.
 *
 * THE DIAGNOSTIC GOES TO STDERR BY DEFAULT, DELIBERATELY. §2.3 rule 1 makes standard output the only *log* sink, and a
 * record that cannot resolve its resource cannot carry §5.2's mandatory `tenantId` / `artifactDigest` fields. Writing it
 * to stdout would put a non-compliant record into the log stream; writing it to stderr keeps it what §2.1 calls it — a
 * local structured error. The tension is recorded for the log-contract milestone rather than hidden: see
 * `.agent/evidence/EP-008/M1-discovery.txt`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CANONICAL_RESOURCE_KEYS,
  DECLARED_SERVICES,
  RESOURCE_ATTR_MISSING_COUNTER,
  RESOURCE_ATTR_MISSING_REASON,
  RESOURCE_ATTR_MISSING_SERIES,
  resolveTelemetryResource,
  type CanonicalResourceKey,
  type DeclaredService,
  type ResolvedResourceInput,
  type TelemetryIdentityRefusal,
} from '../../adapters/observability/telemetry-resource.ts';

/** Where the two values this repository can resolve from its own files live, relative to the workspace root. */
export const RUN_MANIFEST_PATH = '.agent/verification/state/RUN_MANIFEST.json';
export const PACKAGE_JSON_PATH = 'package.json';

/** §5.1's uppercase closed enum. `FATAL` means the process is terminating; it is not a synonym for a serious `ERROR`. */
export const LOG_SEVERITIES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
export type LogSeverity = (typeof LOG_SEVERITIES)[number];

/**
 * What the process and its loaders know about themselves.
 *
 * THE THREE PROCESS-LEVEL VALUES ARE REQUIRED AND NULLABLE, NOT OPTIONAL: a caller must state what it is and is allowed
 * to state that it does not know, which then fails closed. The four remaining values are optional because their sources
 * do not exist in this repository yet — the build/release pipeline owns two (EP-009: `scripts/artifact-identity.sh` is a
 * loud-fail placeholder) and the runtime loaders own two — and a caller that has them supplies them.
 */
export interface ProcessIdentity {
  readonly serviceName: string | null;
  readonly environment: string | null;
  readonly tenantClass: string | null;
  readonly artifactDigest?: string | null;
  readonly buildInputsDigest?: string | null;
  readonly policyVersion?: string | null;
  readonly recipeSetDigest?: string | null;
}

/** The two static values, read from the workspace. `null` means unresolvable, never "assume". */
export interface WorkspaceStaticValues {
  readonly serviceVersion: string | null;
  readonly candidateEpoch: string | null;
  readonly unreadable: readonly string[];
}

/**
 * Read the values this repository can resolve from its own files.
 *
 * FAIL-CLOSED BY CONSTRUCTION: a missing or unparseable file yields `null` for the value it would have carried, and the
 * path is named in `unreadable`. It never throws and never substitutes, because the caller's next step is a refusal that
 * names the key, and a throw here would replace that with an unhandled crash that no counter records.
 */
export function readWorkspaceStaticValues(root: string): WorkspaceStaticValues {
  const unreadable: string[] = [];
  let serviceVersion: string | null = null;
  let candidateEpoch: string | null = null;

  try {
    const parsed = JSON.parse(readFileSync(join(root, PACKAGE_JSON_PATH), 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) serviceVersion = parsed.version.trim();
    else unreadable.push(`${PACKAGE_JSON_PATH} (no string "version")`);
  } catch {
    unreadable.push(PACKAGE_JSON_PATH);
  }

  try {
    const parsed = JSON.parse(readFileSync(join(root, RUN_MANIFEST_PATH), 'utf8')) as { candidate_epoch?: unknown };
    if (typeof parsed.candidate_epoch === 'string' && parsed.candidate_epoch.trim().length > 0) {
      candidateEpoch = parsed.candidate_epoch.trim();
    } else unreadable.push(`${RUN_MANIFEST_PATH} (no string "candidate_epoch")`);
  } catch {
    unreadable.push(RUN_MANIFEST_PATH);
  }

  return Object.freeze({ serviceVersion, candidateEpoch, unreadable: Object.freeze(unreadable) });
}

/**
 * Build the nine-key input record for a run.
 *
 * The inputs this repository cannot supply are `null` rather than absent, so the refusal names them as unresolved keys
 * instead of the object silently lacking a key the resolver would have to guess about.
 */
export function resolveWorkspaceResource(root: string, identity: ProcessIdentity): ResolvedResourceInput {
  const statics = readWorkspaceStaticValues(root);
  return Object.freeze({
    'service.name': identity.serviceName,
    'service.version': statics.serviceVersion,
    'deployment.environment.name': identity.environment,
    'vanishgraph.tenant.class': identity.tenantClass,
    'vanishgraph.candidate_epoch': statics.candidateEpoch,
    'vanishgraph.artifact.digest': identity.artifactDigest ?? null,
    'vanishgraph.build.inputs_digest': identity.buildInputsDigest ?? null,
    'vanishgraph.policy.version': identity.policyVersion ?? null,
    'vanishgraph.recipe.set_digest': identity.recipeSetDigest ?? null,
  });
}

/** Raised where §2.2 requires the process to fail startup rather than emit unattributed telemetry. */
export class TelemetryIdentityError extends Error {
  readonly key: CanonicalResourceKey;
  readonly reason: string;
  constructor(key: CanonicalResourceKey, reason: string, detail: string) {
    super(`telemetry identity: ${detail}`);
    this.name = 'TelemetryIdentityError';
    this.key = key;
    this.reason = reason;
  }
}

/**
 * §2.2: "A process that cannot map itself to this list fails startup rather than emitting unattributed telemetry."
 *
 * THIS IS THE ONE IDENTITY FAILURE THAT IS NOT A REFUSAL TO EMIT. Every other unresolved key leaves the process running
 * and silent; an unmappable `service.name` means the process was never a declared participant, so it must not start
 * under a name nobody declared. Returns the narrowed name so a caller can carry it in a typed field.
 */
export function requireDeclaredService(serviceName: string | null): DeclaredService {
  const trimmed = (serviceName ?? '').trim();
  if (!(DECLARED_SERVICES as readonly string[]).includes(trimmed)) {
    throw new TelemetryIdentityError(
      'service.name',
      'UNDECLARED_SERVICE',
      `"${trimmed}" is not one of the seven declared services (${DECLARED_SERVICES.join(', ')})`,
    );
  }
  return trimmed as DeclaredService;
}

/** §5.4's `TelemetryIdentityMissing`, as data. Local only: it never reaches a telemetry sink. */
export interface TelemetryIdentityDiagnostic {
  readonly event: 'TelemetryIdentityMissing';
  readonly severity: 'ERROR';
  readonly message: string;
  readonly reasonCode: string;
  readonly counter: string;
  readonly series: string;
  readonly unresolvedKeys: readonly CanonicalResourceKey[];
}

export type LocalErrorSink = (diagnostic: TelemetryIdentityDiagnostic) => void;

/** The default local sink: one JSON object per line on stderr, which is not the log sink (§2.3 rule 1). */
export const stderrDiagnosticSink: LocalErrorSink = (diagnostic) => {
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
};

/** A record a producer wants to emit. The nine attributes are added by this module, never by the caller. */
export interface TelemetryRecordInput {
  /** Content-free template text; §5.2's `message` field. Must not interpolate any §4.2 data class. */
  readonly message: string;
  readonly severity: LogSeverity;
  /** Fields the caller resolved. A key outside the allowlist is refused by the DLP scrub stage (EP-008 M2). */
  readonly attributes?: Readonly<Record<string, string>>;
}

/** A record that was emitted: the caller's fields and all nine canonical attributes. */
export interface EmittedTelemetryRecord {
  readonly message: string;
  readonly severity: LogSeverity;
  readonly attributes: Readonly<Record<string, string>>;
  readonly resource: Readonly<Record<CanonicalResourceKey, string>>;
}

export interface TelemetryEmissionRefused {
  readonly ok: false;
  readonly reasonCode: string;
  readonly counter: string;
  readonly series: string;
  readonly unresolvedKeys: readonly CanonicalResourceKey[];
  readonly detail: string;
}

export type TelemetryEmissionResult =
  | { readonly ok: true; readonly emitted: true; readonly record: EmittedTelemetryRecord }
  | TelemetryEmissionRefused;

/** A sink receives ONLY a record that already carries the resource. There is no path to a sink without one. */
export type TelemetrySink = (record: EmittedTelemetryRecord) => void;

export interface TelemetryProducer {
  /** Emit a record, or refuse. A refusal increments the counter and writes nothing to the sink. */
  emit(input: TelemetryRecordInput): TelemetryEmissionResult;
  /** Every record this producer emitted, in order. Present so a caller can assert that none was emitted. */
  emitted(): readonly EmittedTelemetryRecord[];
  /** Counter values, keyed by the full series including labels. */
  counters(): Readonly<Record<string, number>>;
  /** How many `emit` calls were refused. */
  refusals(): number;
  /** The local structured errors this producer wrote (at most one, and only when identity did not resolve). */
  diagnostics(): readonly TelemetryIdentityDiagnostic[];
  /** Whether this producer can emit at all. A caller may branch on this; it may not substitute values. */
  identityResolved(): boolean;
}

export interface TelemetryProducerOptions {
  readonly resource: ResolvedResourceInput;
  readonly sink: TelemetrySink;
  readonly localErrorSink?: LocalErrorSink;
}

/**
 * Build the one emission path.
 *
 * RESOLUTION HAPPENS ONCE, AT CONSTRUCTION, because a process's identity does not change while it runs: a producer that
 * re-resolved per record could emit the first hundred records attributed and the next hundred unattributed, which is the
 * drift L3 (identity) exists to prevent.
 */
export function createTelemetryProducer(options: TelemetryProducerOptions): TelemetryProducer {
  const resolved = resolveTelemetryResource(options.resource);
  const records: EmittedTelemetryRecord[] = [];
  const diagnostics: TelemetryIdentityDiagnostic[] = [];
  const counters: Record<string, number> = {};
  const localErrorSink = options.localErrorSink ?? stderrDiagnosticSink;

  if (!resolved.ok) {
    const refusal: TelemetryEmissionRefused = Object.freeze({
      ok: false as const,
      reasonCode: RESOURCE_ATTR_MISSING_REASON,
      counter: RESOURCE_ATTR_MISSING_COUNTER,
      series: RESOURCE_ATTR_MISSING_SERIES,
      unresolvedKeys: resolved.unresolvedKeys,
      detail: resolved.detail,
    });
    const diagnostic: TelemetryIdentityDiagnostic = Object.freeze({
      event: 'TelemetryIdentityMissing' as const,
      severity: 'ERROR' as const,
      message: 'telemetry identity could not be resolved; this process will emit no telemetry',
      reasonCode: RESOURCE_ATTR_MISSING_REASON,
      counter: RESOURCE_ATTR_MISSING_COUNTER,
      series: RESOURCE_ATTR_MISSING_SERIES,
      unresolvedKeys: resolved.unresolvedKeys,
    });
    // ONCE PER PRODUCER, NOT ONCE PER RECORD: the process announces that it cannot identify itself, and the counter
    // carries the volume of refused emissions.
    diagnostics.push(diagnostic);
    localErrorSink(diagnostic);
    let refusals = 0;
    counters[RESOURCE_ATTR_MISSING_SERIES] = 0;
    return {
      emit: () => {
        refusals += 1;
        counters[RESOURCE_ATTR_MISSING_SERIES] = refusals;
        return refusal;
      },
      emitted: () => records,
      counters: () => Object.freeze({ ...counters }),
      refusals: () => refusals,
      diagnostics: () => diagnostics,
      identityResolved: () => false,
    };
  }

  const resource = resolved.attributes;
  return {
    emit: (input) => {
      const record: EmittedTelemetryRecord = Object.freeze({
        message: input.message,
        severity: input.severity,
        attributes: Object.freeze({ ...(input.attributes ?? {}) }),
        resource,
      });
      records.push(record);
      options.sink(record);
      return { ok: true, emitted: true, record };
    },
    emitted: () => records,
    counters: () => Object.freeze({ ...counters }),
    refusals: () => 0,
    diagnostics: () => diagnostics,
    identityResolved: () => true,
  };
}

/** The keys a record must carry, exposed so a test asserts against the declaration rather than a copy of it. */
export const RESOURCE_KEYS: readonly CanonicalResourceKey[] = CANONICAL_RESOURCE_KEYS;

/* ----------------------------------------------------------------------------------------------------------------
 * The readiness composition (EP-008 M5(b))
 *
 * WHY THIS LIVES HERE AND NOT IN `src/http/health-routes.ts`: the import-boundary check refuses `src/http` importing
 * `src/adapters` or `src/infrastructure`, so the route layer declares the `ReadinessDecisionPort` shape and THIS module —
 * the composition root — implements it over the real probes, the real metrics registry and the real structured logger.
 * MEASURED: the first version of the route file imported the runner and the logger directly and the boundary check
 * refused it; the check was not relaxed (DOD-027).
 *
 * THE RECORD RULE IS IN THE ROUTE LAYER (`readinessTransitionRecord`, pure and testable) and the WRITING is here, so the
 * rule cannot drift between the two and the logger never enters `src/http`.
 * ---------------------------------------------------------------------------------------------------------------- */

import type { ReadinessChangedRecord, ReadinessDecision, ReadinessDecisionPort } from '../../http/health-routes.ts';
import { createProbeRunner, type DependencyClients, type DependencyKey } from '../../adapters/observability/dependency-probes.ts';
import { createStructuredLogger, type StructuredLogger } from '../../adapters/observability/structured-logger.ts';
import { renderExposition, type MetricsRegistry } from '../../adapters/observability/metrics-registry.ts';
import type { TelemetryAllowlist } from '../../adapters/observability/telemetry-allowlist.ts';

export interface ReadinessComposition {
  readonly port: ReadinessDecisionPort;
  /** The `ReadinessChanged` records written, in order, so a caller can observe the transitions rather than infer them. */
  readonly records: readonly ReadinessChangedRecord[];
  readonly logger: StructuredLogger;
}

export interface ReadinessCompositionOptions {
  readonly allowlist: TelemetryAllowlist;
  readonly clients: DependencyClients;
  readonly registry?: MetricsRegistry;
  readonly service: string;
  /** The process's build identity. Supplied, never invented: a zero digest is a prohibited substitute (M1). */
  readonly candidateEpoch: string;
  readonly artifactDigest: string;
  readonly correlationId: string;
  readonly tenantId: string;
  readonly sink?: (line: string) => void;
  readonly now?: () => Date;
}

/**
 * Build the readiness decision port.
 *
 * THE READINESS EVALUATION AND THE METRICS COME FROM ONE RUN: the port calls the probe runner once per decision, so the
 * counters and the HTTP answer describe the same evaluation rather than two that happened to be close together.
 */
export function composeReadiness(options: ReadinessCompositionOptions): ReadinessComposition {
  const now = options.now ?? ((): Date => new Date());
  const logger = createStructuredLogger({
    allowlist: options.allowlist,
    context: { service: options.service, candidateEpoch: options.candidateEpoch, artifactDigest: options.artifactDigest },
    ...(options.sink === undefined ? {} : { sink: options.sink }),
    now: () => now().toISOString(),
  });
  const runner = createProbeRunner({
    clients: options.clients,
    service: options.service,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    now: () => now().getTime(),
  });
  const records: ReadinessChangedRecord[] = [];
  let previous: ReadinessDecision['dependencyState'] | null = null;

  return {
    logger,
    records,
    port: {
      decide: async () => {
        const evaluation = await runner.evaluate();
        const decision: ReadinessDecision = Object.freeze({
          dependencyState: evaluation.dependencyState,
          failedChecks: evaluation.failedChecks,
          checks: Object.freeze(evaluation.checks.map((check) => Object.freeze({ name: check.name, ok: check.status === 'PASS', latencyMs: check.latencyMs, reasonCode: check.reasonCode }))),
          budgetExceeded: evaluation.budgetExceeded,
          totalLatencyMs: evaluation.totalLatencyMs,
        });
        // THE TRANSITION RULE IS THE ROUTE LAYER'S, IMPORTED RATHER THAN RESTATED (see the note above).
        const { readinessTransitionRecord } = await import('../../http/health-routes.ts');
        const record = readinessTransitionRecord(previous, decision);
        if (record !== null) {
          logger.log(
            { correlationId: options.correlationId, tenantId: options.tenantId },
            {
              severity: 'ERROR',
              event: 'ReadinessChanged',
              outcome: 'FAILED',
              message: record.message,
              dependencyKey: record.dependencyKey,
              reasonCode: record.reasonCode,
            },
          );
          records.push(record);
        }
        previous = decision.dependencyState;
        return decision;
      },
    },
  };
}

/** The six declared dependency keys, re-exported so the process entry point names them from one place. */
export const READINESS_DEPENDENCY_KEYS: readonly DependencyKey[] = ['postgresql', 'valkey', 'job-worker', 'object-store', 'keycloak-jwks', 'provider-transport'];

/* ----------------------------------------------------------------------------------------------------------------
 * The metrics listener (SPEC-007 §2.3 rule 2; EP-008 M5(b))
 *
 * CLUSTER-INTERNAL ONLY, AND THE CODE ENFORCES IT RATHER THAN DOCUMENTING IT: the listener binds the address it is
 * given (`VANISHGRAPH_METRICS_HOST`, loopback by default) and NOTHING else, it serves exactly one path
 * (`VANISHGRAPH_METRICS_PATH`), and it answers 404 to every other path and 405 to every other method. §2.3 rule 2 says
 * the endpoint "must be unreachable from the public ingress; exposure is a security defect, because raw metric series
 * disclose tenant shape and operational state" — so the listener is never mounted on the public server, and a caller
 * that wants it exposed has to change the configuration deliberately.
 *
 * IT ANSWERS ONLY WHAT WAS RECORDED: the body is `renderExposition`, which emits the registered catalogue and nothing
 * else, so this endpoint cannot invent a series.
 * ---------------------------------------------------------------------------------------------------------------- */

export interface MetricsListenerOptions {
  readonly registry: MetricsRegistry;
  readonly path: string;
  readonly host: string;
  readonly port: number;
  readonly environment: string;
}

export interface MetricsListener {
  readonly url: string;
  readonly requestsServed: number;
  close(): Promise<void>;
}

/** Start the listener. The caller decides whether to start it at all (`metricsPort === 0` means no listener). */
export async function startMetricsListener(options: MetricsListenerOptions): Promise<MetricsListener> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new RangeError(`the metrics listener needs a TCP port in range and received ${String(options.port)}`);
  }
  // PORT 0 MEANS "LET THE OPERATING SYSTEM CHOOSE", WHICH IS WHAT A TEST NEEDS to bind without racing another process
  // for a fixed number. THE CONFIGURATION STILL TREATS 0 AS "NO LISTENER": the service entry point calls this function
  // only when `config.metricsPort > 0`, so the caller decides WHETHER there is a listener and this function decides
  // WHICH port it lands on.
  const { createServer } = await import('node:http');
  let served = 0;
  const server = createServer((request, response) => {
    if ((request.method ?? 'GET') !== 'GET') {
      // 405, NOT 404: the path exists and the method does not, and saying so is what lets a scraper be fixed instead of
      // guessed at.
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' });
      response.end('method not allowed\n');
      return;
    }
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (path !== options.path) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found\n');
      return;
    }
    served += 1;
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    response.end(renderExposition(options.registry, { environment: options.environment }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : options.port;
  return {
    url: `http://${options.host}:${String(boundPort)}${options.path}`,
    get requestsServed() {
      return served;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
  };
}

/** Re-exported so a caller of this composition root needs one import for the refusal vocabulary. */
export { RESOURCE_ATTR_MISSING_COUNTER, RESOURCE_ATTR_MISSING_REASON, RESOURCE_ATTR_MISSING_SERIES };
export type { CanonicalResourceKey, ResolvedResourceInput, TelemetryIdentityRefusal };
