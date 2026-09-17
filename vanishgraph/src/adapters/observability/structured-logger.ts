/**
 * The structured log contract (SPEC-007 §5, §10; EP-008 M3; DOD-037, DOD-012).
 *
 * ONE PLACE DECIDES WHAT A LOG RECORD IS, AND IT DECIDES BEFORE THE RECORD LEAVES THE PROCESS. §5.2 makes
 * `timestamp`, `severity`, `service`, `correlationId`, `tenantId`, `event`, `outcome`, `message`, `candidateEpoch` and
 * `artifactDigest` mandatory; makes `caseId`, `exposureId` and `actionId` required WHEN THE ENTITY IS IN SCOPE; §5.1
 * fixes an uppercase severity enum; §5.4 fixes the canonical event names; §5.3 prohibits a list of field NAMES at any
 * depth; and §5.5 requires every value to be an opaque identifier, a digest, an enum token, a number, a boolean, a
 * duration, a currency amount, a version string, a jurisdiction code, or a content-free template.
 *
 * THE VOCABULARY IS READ FROM `config/telemetry/allowlist.json`, NOT RESTATED HERE. A second copy of the mandatory-field
 * list or the event list in this file would be a copy that drifts from the one the guard checks, and the drift would be
 * invisible until a record was rejected in production.
 *
 * A MISSING CORRELATION ID IS A REFUSAL, NOT A NEW ID. §5.2 requires `correlationId` on every record and §5.5's whole
 * purpose is that records join to a case; an activity invoked without one is refused with a typed error. Generating a
 * fresh identifier, or substituting an empty or zeroed one, would produce a record that LOOKS correlated and joins to
 * nothing, which is worse than no record at all — so this module has no default and no fallback.
 *
 * TRUTHFULNESS IS A PROPERTY OF THE RECORD, AND IT IS CHECKED HERE RATHER THAN TRUSTED. §10 and DOD-037: a signal may
 * never assert a state the domain did not reach. `scanLogStream` re-checks a captured stream for the four shapes that
 * matter — success naming on a state that never counts as progress, a `VERIFIED_REMOVED` record with no linked
 * observation, a non-canonical event or severity, and a prohibited field name — so the guard that scans real output uses
 * the same code the logger uses to refuse a record.
 */

import {
  loadTelemetryAllowlist,
  type TelemetryAllowlist,
} from './telemetry-allowlist.ts';

/** The severities of §5.1, in ascending order. Read from the configuration so the two cannot disagree. */
export type LogSeverity = string;

export interface StructuredLogRecord {
  readonly timestamp: string;
  readonly severity: LogSeverity;
  readonly service: string;
  readonly correlationId: string;
  readonly tenantId: string;
  readonly event: string;
  readonly outcome: string;
  readonly message: string;
  readonly candidateEpoch: string;
  readonly artifactDigest: string;
  readonly caseId?: string;
  readonly exposureId?: string;
  readonly actionId?: string;
  readonly [field: string]: unknown;
}

/** What the caller knows about the activity. `correlationId` has no default: its absence is refused. */
export interface LogActivityScope {
  readonly correlationId: string | null;
  readonly tenantId: string | null;
  /** Present ONLY when the entity is in scope; the logger requires the field when the key is present here. */
  readonly caseId?: string | null;
  readonly exposureId?: string | null;
  readonly actionId?: string | null;
}

export interface LogContext {
  readonly service: string;
  readonly candidateEpoch: string;
  readonly artifactDigest: string;
}

export class MissingIdentityError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`log record refused: ${detail}`);
    this.name = 'MissingIdentityError';
    this.field = field;
  }
}

export class LogContractViolation extends Error {
  readonly violations: readonly string[];
  constructor(violations: readonly string[]) {
    super(`log record refused: ${violations.join('; ')}`);
    this.name = 'LogContractViolation';
    this.violations = violations;
  }
}

export interface LogContractOptions {
  readonly allowlist: TelemetryAllowlist;
  /** The three values every record carries from the process identity (EP-008 M1's resource attributes). */
  readonly context: LogContext;
  /** Where an accepted record goes. Standard output is the only log sink (§2.3 rule 1). */
  readonly sink?: (line: string) => void;
  /** Injected so a test can pin the timestamp; the format is §5.2's RFC 3339 with milliseconds. */
  readonly now?: () => string;
}

export interface StructuredLogger {
  /** Build, validate and emit one record. Throws a typed error rather than emitting an invalid record. */
  log(scope: LogActivityScope, record: Omit<StructuredLogRecord, 'timestamp' | 'service' | 'candidateEpoch' | 'artifactDigest'>): StructuredLogRecord;
  /** Every record this logger emitted, in order. */
  emitted(): readonly StructuredLogRecord[];
  /** Validate a record without emitting it. Returns the violations, so a caller can see all of them at once. */
  validate(record: Record<string, unknown>): readonly string[];
}

const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/;

/**
 * Build the logger.
 *
 * THE ORDER OF CHECKS IS THE ORDER OF THE CONTRACT: identity first (a record without a correlation id is not a record),
 * then the closed vocabularies, then the mandatory and conditional fields, then the prohibited names at any depth, and
 * finally the truthfulness rules. Each check can name what it rejected, so a failure report says which field and which
 * rule rather than "invalid record".
 */
export function createStructuredLogger(options: LogContractOptions): StructuredLogger {
  const contract = options.allowlist.logContract;
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date().toISOString());
  const records: StructuredLogRecord[] = [];

  function validate(record: Record<string, unknown>): string[] {
    const violations: string[] = [];

    for (const field of contract.mandatoryFields) {
      const value = record[field];
      if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) {
        violations.push(`${field} is mandatory on every record (§5.2) and is absent or empty`);
      }
    }

    const severity = record['severity'];
    if (typeof severity === 'string' && !contract.severities.includes(severity)) {
      violations.push(`severity "${severity}" is not one of the closed enum ${contract.severities.join(', ')} (§5.1)`);
    }
    const event = record['event'];
    if (typeof event === 'string' && !options.allowlist.canonicalEvents.includes(event)) {
      violations.push(`event "${event}" is not a canonical event name (§5.4)`);
    }
    const outcome = record['outcome'];
    if (typeof outcome === 'string' && !contract.outcomes.includes(outcome)) {
      violations.push(`outcome "${outcome}" is not one of ${contract.outcomes.join(', ')} (§5.2)`);
    }

    const timestamp = record['timestamp'];
    if (typeof timestamp === 'string' && !RFC3339_MILLIS.test(timestamp)) {
      violations.push(`timestamp "${timestamp}" is not RFC 3339 with millisecond precision and an explicit offset (§5.2)`);
    }

    // THE CONDITIONAL FIELDS ARE REQUIRED BY THE SCOPE, NOT BY THE RECORD: the caller states what is in scope, and a
    // record that omits a field whose entity is in scope is invalid.
    for (const conditional of contract.conditionalFields) {
      if (record[`scope:${conditional.scopeKey}`] === true && (record[conditional.field] === undefined || record[conditional.field] === null)) {
        violations.push(`${conditional.field} is required when ${conditional.when}, and the scope says it is (§5.2)`);
      }
    }

    // PROHIBITED NAMES AT ANY NESTING DEPTH (§5.3). The nine resource keys are not record fields and are not passed here.
    for (const path of findProhibitedNames(options.allowlist, record)) {
      violations.push(`"${path}" is a prohibited field name (§5.3)`);
    }

    // §5.5: a value must be an opaque identifier, a digest, an enum token, a number, a boolean, a duration, a currency
    // amount, a version string, a jurisdiction code, or a content-free template. Concretely: no nested object other than
    // a flat map of scalars, and no embedded newline, because a JSON record with a newline in it is two records.
    for (const [field, value] of Object.entries(record)) {
      if (field.startsWith('scope:')) continue;
      if (typeof value === 'string' && /[\r\n]/.test(value)) {
        violations.push(`"${field}" contains a line break, which would split one record into two (§5.2)`);
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value) && !isFlatScalarMap(value)) {
        violations.push(`"${field}" is a nested structure; §5.5 permits opaque identifiers, enum tokens, numbers, booleans, durations, currency amounts, versions and jurisdiction codes`);
      }
    }

    violations.push(...truthfulnessViolations(options.allowlist, record));
    return violations;
  }

  return {
    log: (scope, record) => {
      if (scope.correlationId === null || scope.correlationId.trim().length === 0) {
        throw new MissingIdentityError('correlationId', 'the activity carries no correlationId, and §5.2 makes it mandatory: a generated or zeroed substitute would look correlated and join to nothing');
      }
      if (scope.tenantId === null || scope.tenantId.trim().length === 0) {
        throw new MissingIdentityError('tenantId', 'the record carries no tenantId, and §5.2 makes it mandatory');
      }

      const complete: Record<string, unknown> = {
        ...record,
        timestamp: now(),
        service: options.context.service,
        correlationId: scope.correlationId,
        tenantId: scope.tenantId,
        candidateEpoch: options.context.candidateEpoch,
        artifactDigest: options.context.artifactDigest,
        ...(scope.caseId === undefined || scope.caseId === null ? {} : { caseId: scope.caseId }),
        ...(scope.exposureId === undefined || scope.exposureId === null ? {} : { exposureId: scope.exposureId }),
        ...(scope.actionId === undefined || scope.actionId === null ? {} : { actionId: scope.actionId }),
        'scope:caseId': scope.caseId !== undefined && scope.caseId !== null,
        'scope:exposureId': scope.exposureId !== undefined && scope.exposureId !== null,
        'scope:actionId': scope.actionId !== undefined && scope.actionId !== null,
      };

      const violations = validate(complete);
      if (violations.length > 0) throw new LogContractViolation(violations);

      // THE SCOPE MARKERS ARE VALIDATION INPUT, NOT RECORD CONTENT: emitting them would put a field in the record that
      // no allowlist entry classifies, which the DLP stage would then deny.
      const { 'scope:caseId': _c, 'scope:exposureId': _e, 'scope:actionId': _a, ...emit } = complete;
      const frozen = Object.freeze(emit) as unknown as StructuredLogRecord;
      records.push(frozen);
      sink(JSON.stringify(frozen));
      return frozen;
    },
    emitted: () => records,
    validate,
  };
}

/** Build the logger from the versioned configuration; a configuration that cannot be validated is a startup failure. */
export function createStructuredLoggerFromFile(path: string, options: Omit<LogContractOptions, 'allowlist'>): StructuredLogger {
  const loaded = loadTelemetryAllowlist(path);
  if (!loaded.ok) {
    throw new LogContractViolation(loaded.errors.map((entry) => `the telemetry allowlist could not be validated: ${entry}`));
  }
  return createStructuredLogger({ allowlist: loaded.allowlist, ...options });
}

function isFlatScalarMap(value: object): boolean {
  return Object.values(value).every((entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean');
}

function findProhibitedNames(allowlist: TelemetryAllowlist, value: unknown, prefix = ''): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) found.push(...findProhibitedNames(allowlist, entry, `${prefix}[${String(index)}]`));
    return found;
  }
  if (typeof value !== 'object' || value === null) return found;
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix.length === 0 ? name : `${prefix}.${name}`;
    if (!name.startsWith('scope:') && allowlist.prohibitedFieldNames.includes(name)) found.push(path);
    found.push(...findProhibitedNames(allowlist, entry, path));
  }
  return found;
}

/**
 * The §10 truthfulness rules, as checks over one record.
 *
 * THEY ARE WRITTEN AS VIOLATIONS WITH THEIR REASON because a guard that only says "invalid" leaves a reader to guess
 * which of four rules fired, and the rules exist precisely so that a claim can be traced to what the domain reached.
 */
export function truthfulnessViolations(allowlist: TelemetryAllowlist, record: Record<string, unknown>): string[] {
  const contract = allowlist.logContract;
  const violations: string[] = [];
  const truthStateTo = record['truthStateTo'];
  const outcome = record['outcome'];

  if (typeof truthStateTo === 'string' && contract.successNamingProhibitedFor.includes(truthStateTo)) {
    // §10 and SPEC-000 §5's progress rule: REQUEST_SUBMITTED, ACKNOWLEDGED and SEARCH_DELISTED never count as progress,
    // so a record that names one of them and reports SUCCEEDED asserts a state the domain did not reach.
    if (outcome === 'SUCCEEDED') {
      violations.push(`outcome SUCCEEDED is not available for truth state ${truthStateTo}: it never counts as progress (SPEC-000 §5, §10)`);
    }
    if (record['sampleSuppressed'] === true) {
      violations.push(`a record for truth state ${truthStateTo} may not be sampled away (§10.3)`);
    }
  }

  if (truthStateTo === 'VERIFIED_REMOVED') {
    // The one inbound transition to VERIFIED_REMOVED (T14) requires a VerificationObservation, so the record must carry
    // the reference; its absence is the "removal claim without verification" shape alert A-01b exists for.
    for (const field of contract.verifiedRemovedRequires) {
      const value = record[field];
      if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) {
        violations.push(`a VERIFIED_REMOVED record must carry ${field} (SPEC-001 §4.1 T14, §3.2)`);
      }
    }
  }

  const severity = record['severity'];
  if (typeof severity === 'string' && contract.neverSampled.includes(severity) && record['sampleSuppressed'] === true) {
    violations.push(`a ${severity} record may never be dropped by sampling (§10.3)`);
  }
  const event = record['event'];
  if (typeof event === 'string' && contract.neverDroppedEvents.includes(event) && record['sampleSuppressed'] === true) {
    violations.push(`a ${event} record may never be dropped by sampling (§10.3)`);
  }

  return violations;
}

/**
 * Scan a captured stream of JSON lines. The guard runs THIS, so the rules a live capture is checked against are the
 * rules the logger enforces, and a stream that cannot be parsed is a violation rather than a skipped line.
 */
export function scanLogStream(allowlist: TelemetryAllowlist, stream: string): readonly string[] {
  const violations: string[] = [];
  const lines = stream.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    // AN EMPTY CAPTURE IS A FAILURE, NEVER A PASS: a guard over zero records proves nothing (DOD-007).
    return ['the captured stream contains no records, so it proves nothing about the contract (DOD-007)'];
  }
  for (const [index, line] of lines.entries()) {
    // EVERY VIOLATION CARRIES THE SAME `line N: ` PREFIX, so a reader can locate the record no matter which rule fired —
    // including the parse failure, which the first version reported without the prefix and which the suite caught.
    const named = (entry: string): string => `line ${String(index + 1)}: ${entry}`;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      violations.push(named(`the record is not valid JSON: ${(error as Error).message}`));
      continue;
    }
    for (const field of allowlist.logContract.mandatoryFields) {
      const value = parsed[field];
      if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) {
        violations.push(named(`${field} is missing, and §5.2 makes it mandatory`));
      }
    }
    const severity = parsed['severity'];
    if (typeof severity === 'string' && !allowlist.logContract.severities.includes(severity)) {
      violations.push(named(`severity "${severity}" is not canonical`));
    }
    const event = parsed['event'];
    if (typeof event === 'string' && !allowlist.canonicalEvents.includes(event)) {
      violations.push(named(`event "${event}" is not canonical`));
    }
    for (const path of findProhibitedNames(allowlist, parsed)) {
      violations.push(named(`"${path}" is a prohibited field name (§5.3)`));
    }
    violations.push(...truthfulnessViolations(allowlist, parsed).map(named));
  }
  return violations;
}
