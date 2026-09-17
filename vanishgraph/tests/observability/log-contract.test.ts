/**
 * The structured log contract (EP-008 M3; SPEC-007 §5, §10; DOD-037, DOD-012).
 *
 * TWO HALVES, AND BOTH ARE NEEDED. The first drives the REAL logger and asserts what it accepts and what it refuses:
 * the mandatory fields, the conditional-required fields, the closed severity/event/outcome vocabularies, prohibited field
 * names at any depth, and the truthfulness rules. The second drives `scanLogStream` — the SAME checker the
 * `scripts/log-contract-guard.sh` stage runs over a captured stream — against planted defects, so the guard's silence
 * over a real capture means something. A checker that cannot report a defect is not a checker.
 *
 * THE CAPTURE IS THE REAL LOGGER'S OWN OUTPUT, written to `VG_LOG_CAPTURE` when the stage sets it, so the guard scans
 * bytes that came out of the writer rather than a reconstruction. When the variable is unset the suite writes its capture
 * to a temporary directory, so `sh scripts/test-unit.sh` is self-sufficient and leaves the tree clean.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  MissingIdentityError,
  LogContractViolation,
  createStructuredLogger,
  createStructuredLoggerFromFile,
  scanLogStream,
  truthfulnessViolations,
  type LogActivityScope,
} from '../../src/adapters/observability/structured-logger.ts';
import { loadTelemetryAllowlist, parseTelemetryAllowlist, type TelemetryAllowlist } from '../../src/adapters/observability/telemetry-allowlist.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const ALLOWLIST_PATH = join(ROOT, 'config/telemetry/allowlist.json');
const CAPTURE_PATH = process.env['VG_LOG_CAPTURE'] ?? join(tmpdir(), 'vanishgraph-log-capture.jsonl');
const FIXED_NOW = (): string => '2026-02-14T09:31:07.412Z';

const loaded = loadTelemetryAllowlist(ALLOWLIST_PATH);
assert.equal(loaded.ok, true, `the shipped allowlist must validate: ${loaded.ok ? '' : loaded.errors.join('; ')}`);
const allowlist = (loaded as { ok: true; allowlist: TelemetryAllowlist }).allowlist;

const CONTEXT = { service: 'vanishgraph-worker-verify', candidateEpoch: 'GENERATION', artifactDigest: `sha256:${'a'.repeat(64)}` };
const SCOPE: LogActivityScope = { correlationId: 'corr-7Q2F4M8ZC1', tenantId: 'ten-4KQ7', caseId: 'case-9F3B21' };

function newLogger(): { logger: ReturnType<typeof createStructuredLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createStructuredLogger({ allowlist, context: CONTEXT, sink: (line) => lines.push(line), now: FIXED_NOW });
  return { logger, lines };
}

const GOOD = {
  severity: 'INFO',
  event: 'VerifiedRemoved',
  outcome: 'SUCCEEDED',
  message: 'independent observation completed for exposure',
  truthStateFrom: 'ACKNOWLEDGED',
  truthStateTo: 'VERIFIED_REMOVED',
  transitionId: 'T14',
  'vanishgraph.verification.observation_id': 'ver-3P7L19',
} as const;

describe('one record, one line, with every mandatory field of §5.2 (DOD-012)', () => {
  test('the emitted line is the record, it carries all ten mandatory fields, and the sink got the same bytes', () => {
    const { logger, lines } = newLogger();
    const record = logger.log(SCOPE, { ...GOOD });
    assert.equal(lines.length, 1);
    assert.equal(lines[0], JSON.stringify(record), 'the sink must receive the record itself, serialised once');
    assert.equal(lines[0]?.includes('\n'), false, 'a record with a line break in it is two records');
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    for (const field of allowlist.logContract.mandatoryFields) {
      assert.ok(parsed[field] !== undefined && parsed[field] !== '', `${field} must be present and non-empty`);
    }
    assert.equal(parsed['timestamp'], FIXED_NOW());
    assert.equal(parsed['service'], CONTEXT.service);
    assert.equal(parsed['candidateEpoch'], 'GENERATION');
    assert.equal(parsed['artifactDigest'], CONTEXT.artifactDigest);
    assert.equal(parsed['caseId'], SCOPE.caseId);
    // THE SCOPE MARKERS ARE VALIDATION INPUT AND MUST NOT BE EMITTED: a field the allowlist does not classify would be
    // denied by the DLP stage at egress, which is a defect that only shows up at the boundary.
    assert.equal(Object.keys(parsed).some((key) => key.startsWith('scope:')), false);
    assert.equal(logger.emitted().length, 1);
  });

  test('the record is frozen, so nothing can mutate it after the fact', () => {
    const { logger } = newLogger();
    const record = logger.log(SCOPE, { ...GOOD }) as unknown as Record<string, unknown>;
    assert.equal(Object.isFrozen(record), true);
  });
});

describe('identity is refused rather than substituted (§5.2, §5.5)', () => {
  test('a missing correlationId is a typed refusal and emits nothing', () => {
    const { logger, lines } = newLogger();
    assert.throws(
      () => logger.log({ ...SCOPE, correlationId: null }, { ...GOOD }),
      (error: unknown) => error instanceof MissingIdentityError && error.field === 'correlationId',
    );
    assert.deepEqual(lines, [], 'a refused record must not reach a sink');
    assert.deepEqual(logger.emitted(), []);
  });

  test('an empty or blank correlationId is refused, so a zeroed value cannot stand in for one', () => {
    const { logger } = newLogger();
    for (const value of ['', '   ']) {
      assert.throws(() => logger.log({ ...SCOPE, correlationId: value }, { ...GOOD }), MissingIdentityError);
    }
    assert.equal(logger.emitted().length, 0, 'no record may be emitted with a substituted identity');
  });

  test('a missing tenantId is refused, and the refusal names the field', () => {
    const { logger } = newLogger();
    assert.throws(
      () => logger.log({ ...SCOPE, tenantId: null }, { ...GOOD }),
      (error: unknown) => error instanceof MissingIdentityError && error.field === 'tenantId',
    );
  });
});

describe('the closed vocabularies of §5.1, §5.2 and §5.4', () => {
  test('a severity outside the enum is refused, and the refusal names the accepted values', () => {
    const { logger } = newLogger();
    assert.throws(
      () => logger.log(SCOPE, { ...GOOD, severity: 'NOTICE' }),
      (error: unknown) => error instanceof LogContractViolation && /NOTICE.*closed enum/.test(error.violations.join(' ')),
    );
  });

  test('an event outside §5.4 is refused, and every canonical event is accepted', () => {
    const { logger } = newLogger();
    assert.throws(() => logger.log(SCOPE, { ...GOOD, event: 'RemovalComplete' }), LogContractViolation);
    for (const event of allowlist.canonicalEvents) {
      // A VERIFIED_REMOVED record needs its observation reference and a non-progress state cannot be SUCCEEDED, so the
      // loop supplies the fields each event's own rules require rather than weakening the record.
      const extra = event === 'VerifiedRemoved' ? { truthStateTo: 'VERIFIED_REMOVED', 'vanishgraph.verification.observation_id': 'ver-1' } : {};
      const record = logger.log(SCOPE, { ...GOOD, event, truthStateTo: 'MATCH_CONFIRMED', ...extra });
      assert.equal(record.event, event);
    }
  });

  test('an outcome outside the §5.2 enum is refused', () => {
    const { logger } = newLogger();
    assert.throws(() => logger.log(SCOPE, { ...GOOD, outcome: 'OK' }), LogContractViolation);
  });

  test('a timestamp that is not RFC 3339 with milliseconds is refused', () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({ allowlist, context: CONTEXT, sink: (line) => lines.push(line), now: () => '2026-02-14 09:31:07' });
    assert.throws(() => logger.log(SCOPE, { ...GOOD }), LogContractViolation);
    assert.deepEqual(lines, []);
  });
});

describe('the conditional-required fields of §5.2 follow the SCOPE, not the record', () => {
  test('a field whose entity is in scope is required, and the violation says which', () => {
    const { logger } = newLogger();
    // `caseId` is in scope (the caller passed one), so a record without it is invalid — the logger supplies it, and this
    // asserts the rule by validating a record that omits it directly.
    const violations = logger.validate({ ...GOOD, timestamp: FIXED_NOW(), service: CONTEXT.service, correlationId: SCOPE.correlationId, tenantId: SCOPE.tenantId, candidateEpoch: 'GENERATION', artifactDigest: CONTEXT.artifactDigest, 'scope:caseId': true });
    assert.equal(violations.some((entry) => /caseId is required when/.test(entry)), true, violations.join(' | '));
  });

  test('a record with no case in scope is valid without a caseId', () => {
    const { logger } = newLogger();
    const record = logger.log({ correlationId: 'corr-1', tenantId: 'ten-1' }, { ...GOOD, truthStateTo: 'MATCH_CONFIRMED' });
    assert.equal(record.caseId, undefined);
  });
});

describe('prohibited field names and non-template values (§5.3, §5.5)', () => {
  test('a prohibited name at any nesting depth is refused and the path is named', () => {
    const { logger } = newLogger();
    assert.throws(
      () => logger.log(SCOPE, { ...GOOD, evidence: { email: 'x@y.invalid' } }),
      (error: unknown) => error instanceof LogContractViolation && /evidence\.email/.test(error.violations.join(' ')),
    );
  });

  test('a value with a line break is refused, because it would split one record into two', () => {
    const { logger } = newLogger();
    assert.throws(
      () => logger.log(SCOPE, { ...GOOD, message: 'first line\nsecond line' }),
      (error: unknown) => error instanceof LogContractViolation && /line break/.test(error.violations.join(' ')),
    );
  });

  test('a nested structure is refused: §5.5 permits scalars, not object graphs', () => {
    const { logger } = newLogger();
    assert.throws(
      () => logger.log(SCOPE, { ...GOOD, evidence: { nested: { deep: 'value' } } }),
      (error: unknown) => error instanceof LogContractViolation && /nested structure/.test(error.violations.join(' ')),
    );
  });

  test('a flat map of scalars is permitted, which is what an evidence reference looks like', () => {
    const { logger } = newLogger();
    const record = logger.log(SCOPE, { ...GOOD, evidence: { id: 'evd-1', digest: 'a'.repeat(64) } });
    assert.deepEqual(record['evidence'], { id: 'evd-1', digest: 'a'.repeat(64) });
  });
});

describe('truthfulness (§10, DOD-037): no signal may assert a state the domain did not reach', () => {
  test('SUCCEEDED is refused for a state that never counts as progress', () => {
    const { logger, lines } = newLogger();
    for (const state of allowlist.logContract.successNamingProhibitedFor) {
      assert.throws(
        () => logger.log(SCOPE, { ...GOOD, truthStateTo: state }),
        (error: unknown) => error instanceof LogContractViolation && /never counts as progress/.test(error.violations.join(' ')),
        `${state} must not carry SUCCEEDED`,
      );
    }
    assert.deepEqual(lines, [], 'a false claim must not reach the sink');
  });

  test('a VERIFIED_REMOVED record without a linked observation is refused (alert A-01b shape)', () => {
    const { logger } = newLogger();
    assert.throws(
      () => logger.log(SCOPE, { ...GOOD, 'vanishgraph.verification.observation_id': undefined }),
      (error: unknown) => error instanceof LogContractViolation && /VERIFIED_REMOVED record must carry/.test(error.violations.join(' ')),
    );
  });

  test('VERIFIED_REMOVED with its observation reference is accepted, and REFUSED is fine for a non-progress state', () => {
    const { logger } = newLogger();
    const verified = logger.log(SCOPE, { ...GOOD });
    assert.equal(verified['truthStateTo'], 'VERIFIED_REMOVED');
    const refused = logger.log(SCOPE, { ...GOOD, outcome: 'REFUSED', truthStateTo: 'REQUEST_SUBMITTED', event: 'Refused' });
    assert.equal(refused['outcome'], 'REFUSED');
  });

  test('sampling may never drop an ERROR, a FATAL, or a truth-state transition', () => {
    const { logger } = newLogger();
    for (const severity of allowlist.logContract.neverSampled) {
      assert.throws(
        () => logger.log(SCOPE, { ...GOOD, severity, sampleSuppressed: true }),
        (error: unknown) => error instanceof LogContractViolation && /never be dropped by sampling/.test(error.violations.join(' ')),
        `${severity} must never be sampled away`,
      );
    }
    assert.throws(
      () => logger.log(SCOPE, { ...GOOD, event: 'VerifiedRemoved', sampleSuppressed: true }),
      LogContractViolation,
    );
    // AND THE RULE IS SPECIFIC TO THOSE RECORDS: an INFO record may be sampled, which is what makes the rule a rule.
    const sampled = logger.log(SCOPE, { ...GOOD, event: 'EgressScrubbed', severity: 'INFO', truthStateTo: 'MATCH_CONFIRMED', sampleSuppressed: true });
    assert.equal(sampled['sampleSuppressed'], true);
  });
});

describe('the stream scanner is the same checker the stage runs, and it reports rather than guesses', () => {
  test('a real capture produced by the logger scans clean, and the capture is written for the stage', () => {
    const { logger, lines } = newLogger();
    logger.log(SCOPE, { ...GOOD });
    logger.log({ correlationId: 'corr-2', tenantId: 'ten-1' }, { ...GOOD, event: 'ActionSubmitted', outcome: 'SUCCEEDED', truthStateTo: 'REQUEST_READY' });
    const stream = `${lines.join('\n')}\n`;
    assert.deepEqual(scanLogStream(allowlist, stream), []);
    mkdirSync(dirname(CAPTURE_PATH), { recursive: true });
    writeFileSync(CAPTURE_PATH, stream);
    assert.equal(readFileSync(CAPTURE_PATH, 'utf8'), stream, 'the capture must be the bytes the logger wrote');
    assert.ok(lines.length >= 2, 'the capture must not be a single record');
  });

  test('NEGATIVE CONTROL: an empty capture is a FAILURE, never a pass (DOD-007)', () => {
    const violations = scanLogStream(allowlist, '\n\n');
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? '', /proves nothing/);
  });

  test('NEGATIVE CONTROL: every planted defect is reported, with its line number', () => {
    const { logger, lines } = newLogger();
    logger.log(SCOPE, { ...GOOD });
    const good = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    const planted: readonly (readonly [string, Record<string, unknown>, RegExp])[] = [
      ['a missing mandatory field', Object.fromEntries(Object.entries(good).filter(([key]) => key !== 'message')), /message is missing/],
      ['a prohibited field name', { ...good, cookie: 'session=abc' }, /"cookie" is a prohibited field name/],
      ['a non-canonical event', { ...good, event: 'RemovalComplete' }, /event "RemovalComplete" is not canonical/],
      ['a non-canonical severity', { ...good, severity: 'NOTICE' }, /severity "NOTICE" is not canonical/],
      ['a false success claim', { ...good, truthStateTo: 'ACKNOWLEDGED' }, /never counts as progress/],
      ['an unverified removal claim', Object.fromEntries(Object.entries(good).filter(([key]) => !key.includes('observation_id'))), /VERIFIED_REMOVED record must carry/],
      ['a line that is not JSON', { raw: 'not json' }, /is not valid JSON/],    ];
    for (const [name, record, expected] of planted) {
      const stream = typeof record['raw'] === 'string' ? 'not json at all\n' : `${JSON.stringify(record)}\n`;
      const violations = scanLogStream(allowlist, stream);
      assert.ok(violations.length >= 1, `${name} must be reported`);
      assert.match(violations.join(' | '), expected, `${name} must be reported with the right reason`);
      assert.match(violations[0] ?? '', /^line 1: /, `${name} must name the line it came from`);
    }
  });

  test('the truthfulness rules are exported, so the guard and the logger cannot disagree about them', () => {
    const violations = truthfulnessViolations(allowlist, { truthStateTo: 'VERIFIED_REMOVED', outcome: 'SUCCEEDED' });
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? '', /must carry vanishgraph\.verification\.observation_id/);
  });
});

describe('the logger refuses to start on a policy that cannot be validated (§5, fail closed)', () => {
  test('a missing allowlist is a startup failure rather than a logger with no contract', () => {
    assert.throws(
      () => createStructuredLoggerFromFile(join(ROOT, 'config/telemetry/no-such-file.json'), { context: CONTEXT }),
      (error: unknown) => error instanceof LogContractViolation && /could not be validated/.test(error.message),
    );
  });

  test('a contract that drops a mandatory field or a severity is refused', () => {
    const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as Record<string, unknown>;
    const contract = raw['log_contract'] as Record<string, unknown>;
    const droppedField = parseTelemetryAllowlist({ ...raw, log_contract: { ...contract, mandatory_fields: (contract['mandatory_fields'] as string[]).filter((field) => field !== 'tenantId') } });
    assert.equal(droppedField.ok, false);
    if (!droppedField.ok) assert.match(droppedField.errors.join(' | '), /must include tenantId/);
    const droppedSeverity = parseTelemetryAllowlist({ ...raw, log_contract: { ...contract, severities: ['INFO'] } });
    assert.equal(droppedSeverity.ok, false);
    if (!droppedSeverity.ok) assert.match(droppedSeverity.errors.join(' | '), /must include TRACE/);
    const badConditional = parseTelemetryAllowlist({ ...raw, log_contract: { ...contract, conditional_fields: [{ field: 'caseId' }] } });
    assert.equal(badConditional.ok, false);
    if (!badConditional.ok) assert.match(badConditional.errors.join(' | '), /must carry field, when and scope_key/);
  });
});
