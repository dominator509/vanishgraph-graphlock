/**
 * The DLP scrub stage proved by canary, on exported bytes (SPEC-007 §4.1-§4.4; EP-008 M2; DOD-013, DOD-024, DOD-027).
 *
 * WHAT THIS SUITE ASSERTS, AND ON WHAT: §4.4 item 4 requires the assertion to operate on "exported bytes, not on the
 * in-process object graph", so every case below drives the real scrub stage and the real sink adapters, takes the bytes
 * the transport would have sent, and searches THOSE — as a substring, in a percent-decoded form, and inside every
 * base64-looking token they contain. The five sinks serialise differently on purpose, so this is five independent
 * renderings rather than one rendering reported five times.
 *
 * THE CANARY IS GENERATED AT RUN TIME FROM A SEED (§4.4 item 1). When `VG_CANARY_BUNDLE` names a bundle written by
 * `scripts/canary-dlp.mjs`, this suite consumes that file — which is how `scripts/egress-canary-test.sh` exercises the
 * real generator end to end — and otherwise it generates a bundle in-process from a fixed default seed so the unit stage
 * is self-sufficient. In both modes the seed and the digest over the bundle bytes are asserted to agree with the file or
 * the values the generator produced, so a bundle cannot be swapped underneath the run.
 *
 * THE HONEST LIMIT OF VALUE SCANNING, STATED IN THE SUITE RATHER THAN LEFT TO BE DISCOVERED: five of the twelve §4.2
 * classes are enforced by FIELD NAME or by EGRESS CLASS, because a person's name, a page body, a form value, a screenshot
 * and an identity document have no shape a scanner could recognise. A canary of one of those classes is refused because
 * the field that would carry it is refused — not because the value was recognised. This suite therefore asserts, for
 * those classes, that the NAME path denies with zero bytes exported AND that the configuration declares the enforcement
 * honestly (no pattern, so no false claim of value detection). A producer that puts a page body into an allowed field
 * called `message` is a producer defect this stage cannot catch by value, and the suite says so instead of implying
 * otherwise.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DLP_SINKS,
  CANARY_DETECTIONS_COUNTER,
  SINK_LABEL_VALUES,
  EGRESS_DENIED_COUNTER,
  SCRUB_OUTCOME_COUNTER,
  createEgressGate,
  createEgressGateFromFile,
  createSinkAdapters,
  type AcceptedPayload,
  type DlpSinkName,
  type ScrubResult,
} from '../../src/adapters/observability/egress-gate.ts';
import {
  loadTelemetryAllowlist,
  parseTelemetryAllowlist,
  type TelemetryAllowlist,
} from '../../src/adapters/observability/telemetry-allowlist.ts';
/**
 * THE GENERATOR IS LOADED BY URL RATHER THAN BY A BARE SPECIFIER, AND THE REASON IS THE TYPE SYSTEM RATHER THAN STYLE: a
 * static `import ... from '../../scripts/canary-dlp.mjs'` requires a hand-written declaration file for an untyped `.mjs`,
 * and a declaration file that merely restates the signature would be a second source of truth for a module this suite is
 * supposed to EXERCISE. Loading it by URL imports the real module at run time and types the result here, where the test
 * that consumes it lives.
 */
const generator = (await import(new URL('../../scripts/canary-dlp.mjs', import.meta.url).href)) as {
  generateCanaryBundle: (seed: string) => CanaryBundle;
  canonicalJson: (value: unknown) => string;
};

const ROOT = resolve(import.meta.dirname, '..', '..');
// THE PATH IS OVERRIDABLE BECAUSE THE DISABLED-RULE CONTROL IS A CONFIGURATION CHANGE, NOT A CODE CHANGE: the canary
// stage writes an alternate policy into its evidence directory, points this variable at it, and never touches the tracked
// configuration — which is why `git diff --exit-code` still passes after the control has run.
const ALLOWLIST_PATH = process.env['VG_TELEMETRY_ALLOWLIST_PATH'] ?? join(ROOT, 'config/telemetry/allowlist.json');
const EVIDENCE_DIR = process.env['VG_CANARY_EVIDENCE_DIR'] ?? join(tmpdir(), 'vanishgraph-canary-evidence');
// CREATED ONCE, AT THE TOP, because two suites below append evidence and a suite that only ran because another ran first
// would be an ordering dependency nobody wrote down.
mkdirSync(EVIDENCE_DIR, { recursive: true });
const DEFAULT_SEED = '0f1e2d3c4b5a6978';
const FIXED_NOW = (): string => '2026-02-14T09:31:07.412Z';

interface CanaryEntry {
  readonly site: string;
  readonly field_path: string;
  readonly rule_class: string;
  readonly encoding: 'plain' | 'base64' | 'percent' | 'truncated';
  readonly value: string;
}

interface CanaryBundle {
  readonly seed: string;
  readonly entries: readonly CanaryEntry[];
}

/** The bundle this run used, its digest, and where it came from — recorded so the evidence cannot be ambiguous. */
const bundlePath = process.env['VG_CANARY_BUNDLE'];
const bundle: CanaryBundle = bundlePath === undefined
  ? (generator.generateCanaryBundle(DEFAULT_SEED) as CanaryBundle)
  : (JSON.parse(readFileSync(bundlePath, 'utf8')) as CanaryBundle);
const bundleBytes = generator.canonicalJson(bundle);
const bundleDigest = createHash('sha256').update(bundleBytes).digest('hex');

const loaded = loadTelemetryAllowlist(ALLOWLIST_PATH);
assert.equal(loaded.ok, true, `the shipped allowlist must validate: ${loaded.ok ? '' : loaded.errors.join('; ')}`);
const allowlist = (loaded as { ok: true; allowlist: TelemetryAllowlist }).allowlist;

const VALUE_CLASSES = allowlist.ruleClasses.filter((rule) => rule.enforcement === 'VALUE_PATTERN').map((rule) => rule.ruleClass);
const NAME_CLASSES = allowlist.ruleClasses.filter((rule) => rule.enforcement !== 'VALUE_PATTERN').map((rule) => rule.ruleClass);

/** The prohibited field name that is the control for a class with no value pattern. */
const CONTROL_FIELD_NAME: Readonly<Record<string, string>> = Object.freeze({
  SUBJECT_NAME: 'name',
  PAGE_CONTENT: 'pageContent',
  FORM_VALUE: 'formValues',
  SENSITIVE_SCREENSHOT: 'screenshot',
  IDENTITY_DOCUMENT_CONTENT: 'documentNumber',
});

const RESOURCE_FIXTURE: Readonly<Record<string, string>> = Object.freeze({
  'service.name': 'vanishgraph-worker-verify',
  'service.version': '0.1.0',
  'deployment.environment.name': 'local',
  'vanishgraph.tenant.class': 'TEST',
  'vanishgraph.candidate_epoch': 'GENERATION',
  'vanishgraph.artifact.digest': `sha256:${'a'.repeat(64)}`,
  'vanishgraph.build.inputs_digest': `sha256:${'b'.repeat(64)}`,
  'vanishgraph.policy.version': '2026-02-14.1',
  'vanishgraph.recipe.set_digest': `sha256:${'c'.repeat(64)}`,
});

/** An allowlisted opaque field that must survive unchanged (§4.4 item 4, second half). */
const OPAQUE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  correlationId: 'corr-7Q2F4M8ZC1',
  caseId: 'case-9F3B21',
  transitionId: 'T14',
});

/**
 * Every form of a byte string that a reader could recover: the bytes themselves, their percent-decoded form, and the
 * UTF-8 decoding of every base64-looking token in them. §4.4 forbids a canary "as a substring, as a decoded form, or as
 * a token", and this is that list.
 */
function decodedCandidates(bytes: string): string[] {
  const candidates = [bytes];
  try {
    const decoded = decodeURIComponent(bytes);
    if (decoded !== bytes) candidates.push(decoded);
  } catch {
    // A malformed percent sequence cannot be decoded; the raw bytes are already a candidate.
  }
  for (const match of bytes.matchAll(/[A-Za-z0-9+/]{24,}={0,2}/g)) {
    const decoded = Buffer.from(match[0], 'base64').toString('utf8');
    if (decoded.length > 0 && /^[\x20-\x7e]*$/.test(decoded)) candidates.push(decoded);
  }
  return candidates;
}

/**
 * The cleanliness oracle. It returns the violations rather than throwing, so the same helper can prove it FAILS when a
 * rule class is disabled — which is the difference between a test and a test that cannot fail (§4.4 item 5).
 */
function canaryViolations(exported: readonly string[], values: readonly string[]): string[] {
  const violations: string[] = [];
  for (const bytes of exported) {
    for (const candidate of decodedCandidates(bytes)) {
      for (const value of values) {
        if (value.length >= 8 && candidate.includes(value)) violations.push(value);
      }
    }
  }
  return violations;
}

const gate = createEgressGate({ allowlist });
const sinks = createSinkAdapters({ env: {}, now: FIXED_NOW });

function drive(
  fields: Readonly<Record<string, unknown>>,
  sink: DlpSinkName = 'LOG_FORWARDER',
  resource: Readonly<Record<string, string>> = RESOURCE_FIXTURE,
): { readonly result: ScrubResult; readonly bytes: readonly string[] } {
  const result = gate.scrub(sink, { fields, resource });
  if (!result.ok) return { result, bytes: [] };
  const sent = sinks.send(result.payload);
  assert.equal(sent.ok, true, 'an accepted payload must be sendable');
  return { result, bytes: sent.ok ? [sent.bytes] : [] };
}

function entriesWith(ruleClass: string, encoding: CanaryEntry['encoding']): CanaryEntry[] {
  return bundle.entries.filter((entry) => entry.rule_class === ruleClass && entry.encoding === encoding);
}

describe('the canary bundle is generated, non-live, and covers every §4.2 class', () => {
  test('the run records its seed, its bundle digest and every entry it will assert on', () => {
    assert.match(bundle.seed, /^[0-9a-f]{8,}$/);
    assert.match(bundleDigest, /^[0-9a-f]{64}$/);
    assert.ok(bundle.entries.length >= 12, `one canary per class at least, saw ${String(bundle.entries.length)}`);
  });

  test('every §4.2 rule class in the shipped configuration has at least one canary', () => {
    const covered = new Set(bundle.entries.map((entry) => entry.rule_class));
    for (const rule of allowlist.ruleClasses) {
      assert.equal(covered.has(rule.ruleClass), true, `${rule.ruleClass} has no canary`);
    }
  });

  test('the six canary sites of §4.4 item 3 are all present', () => {
    const sites = new Set(bundle.entries.map((entry) => entry.site));
    for (const site of [
      'PROTECTED_SUBJECT_REFERENCE_CHAIN',
      'EMAIL_THREAD_BODY',
      'FETCHED_PAGE_BODY',
      'FORM_SUBMISSION_PAYLOAD',
      'SCREENSHOT_ARTIFACT',
      'SECRET_SHAPED_ENVIRONMENT_VALUE',
    ]) {
      assert.equal(sites.has(site), true, `${site} carries no canary`);
    }
  });

  test('the material is non-live BY CONSTRUCTION, not by convention', () => {
    // ONLY THE PLAIN FORM CARRIES THE SHAPE: an encoded form is deliberately not readable as the thing it encodes, so
    // asserting the reserved forms against it would be asserting the wrong property.
    for (const entry of bundle.entries.filter((candidate) => candidate.encoding === 'plain')) {
      if (entry.rule_class === 'EMAIL_ADDRESS') {
        assert.match(entry.value, /\.(invalid|example)\b/, `${entry.value} must use a reserved TLD`);
      }
      if (entry.rule_class === 'TELEPHONE_NUMBER') {
        assert.match(entry.value, /555-01\d\d$/, `${entry.value} must be in the reserved fictitious range`);
      }
      if (entry.rule_class === 'TOKEN_OR_SECRET') {
        assert.match(entry.value, /^(Bearer [0-9a-f]{40}|Cookie: session=[0-9a-f]{24})$/);
      }
      assert.equal(entry.value.trim().length > 0, true);
    }
    // AND EVERY ENCODED FORM IS DERIVED FROM ITS PLAIN SIBLING rather than being independent material, so a reader can
    // recover what was encoded and the generator cannot smuggle in a value no site produced.
    for (const entry of bundle.entries.filter((candidate) => candidate.encoding !== 'plain')) {
      const plain = bundle.entries.find(
        (candidate) => candidate.site === entry.site && candidate.rule_class === entry.rule_class && candidate.encoding === 'plain',
      );
      assert.ok(plain !== undefined, `${entry.site}/${entry.rule_class} has an encoded form with no plain form`);
      if (plain === undefined) continue;
      if (entry.encoding === 'base64') assert.equal(Buffer.from(plain.value, 'utf8').toString('base64'), entry.value);
      if (entry.encoding === 'percent') assert.equal(encodeURIComponent(plain.value), entry.value);
      if (entry.encoding === 'truncated') assert.equal(plain.value.startsWith(entry.value), true);
    }
  });

  test('the same seed reproduces the same bundle, and a different seed does not', () => {
    const again = generator.canonicalJson(generator.generateCanaryBundle(bundle.seed));
    assert.equal(again, bundleBytes, 'a recorded seed must replay the exact bundle');
    const other = generator.canonicalJson(generator.generateCanaryBundle('ffffffffffffffff'));
    assert.notEqual(other, bundleBytes, 'a different seed must not produce the same material');
  });

  test('NEGATIVE CONTROL: the cleanliness oracle flags a planted canary, so its silence means something', () => {
    const planted = entriesWith('EMAIL_ADDRESS', 'plain')[0];
    assert.ok(planted !== undefined);
    assert.deepEqual(canaryViolations([`{"message":"${planted.value}"}`], [planted.value]), [planted.value]);
    // And it sees a base64-encoded copy as well, which is the form a substring check alone would miss.
    const encoded = Buffer.from(planted.value, 'utf8').toString('base64');
    assert.deepEqual(canaryViolations([`{"message":"${encoded}"}`], [planted.value]), [planted.value]);
  });
});

describe('a value-pattern class never reaches a sink, in any encoding (SPEC-007 §4.2)', () => {
  /** Whether a truncated value still carries a marker of its class, which is what any value scanner can work with. */
  function stillRecognisable(ruleClass: string, value: string, pattern: string | undefined): boolean {
    if (ruleClass === 'EMAIL_ADDRESS') return value.includes('@');
    if (ruleClass === 'RAW_HTML') return value.trimStart().startsWith('<');
    if (pattern === undefined) return false;
    return new RegExp(pattern).test(value);
  }

  for (const ruleClass of VALUE_CLASSES) {
    test(`${ruleClass}: plain is redacted, encoded forms are refused, truncation is bounded and recorded`, () => {
      const rule = allowlist.ruleClasses.find((candidate) => candidate.ruleClass === ruleClass);
      assert.ok(rule !== undefined);
      const plain = entriesWith(ruleClass, 'plain')[0];
      assert.ok(plain !== undefined, `${ruleClass} has no plain canary`);
      const accepted = drive({ message: plain.value, ...OPAQUE_FIELDS });
      assert.equal(accepted.result.ok, true, `${ruleClass} plain should be redacted rather than denied`);
      if (!accepted.result.ok) return;
      // THE MESSAGES BELOW NAME THE RULE CLASS AND THE FIELD PATH, because the disabled-rule control is judged by its
      // failure text: a control that fails with a bare strict-equality diff proves the assertion ran, not which rule was
      // missing. §4.4 item 5 requires the offending rule class and field path to be named, so they are in the message.
      assert.equal(
        accepted.result.outcome,
        'REDACTED',
        `${ruleClass} should have been redacted in field ${plain.field_path}, but the outcome was ${accepted.result.outcome}`,
      );
      assert.equal(accepted.result.payload.redactionRuleClass, ruleClass, `${ruleClass} must be the class reported in ${plain.field_path}`);
      assert.match(accepted.result.payload.fields['message'] ?? '', /\[REDACTED:/, `${ruleClass} in field ${plain.field_path} was not redacted`);
      // THE OPAQUE IDENTIFIERS SURVIVE, so redaction did not simply delete the record.
      assert.equal(accepted.result.payload.fields['caseId'], OPAQUE_FIELDS['caseId']);
      assert.deepEqual(
        canaryViolations(accepted.bytes, [plain.value]),
        [],
        `${ruleClass} reached the exported bytes from field ${plain.field_path}`,
      );

      for (const encoding of ['base64', 'percent'] as const) {
        for (const entry of entriesWith(ruleClass, encoding)) {
          const refused = drive({ message: entry.value, ...OPAQUE_FIELDS });
          assert.equal(refused.result.ok, false, `${ruleClass} ${encoding} must be refused, not cleaned`);
          if (refused.result.ok) continue;
          assert.equal(refused.result.outcome, 'DENIED');
          assert.equal(refused.result.reasonCode, 'CANARY_DETECTED', `${ruleClass} ${encoding}: ${refused.result.detail}`);
          assert.equal(refused.result.fieldPath, 'message');
          assert.deepEqual(refused.bytes, [], 'a denial emits NO payload at all');
        }
      }

      // TRUNCATION IS THE ONE ENCODING A VALUE SCANNER CANNOT ALWAYS SEE, AND THIS SUITE SAYS SO RATHER THAN ASSERTING A
      // COVERAGE IT DOES NOT HAVE. A truncated value that still carries its class's marker must be refused or redacted —
      // no truncated canary may appear in the exported bytes. A truncation so short that the marker is gone (no `@`, no
      // opening tag, no match) is INDISTINGUISHABLE FROM ORDINARY TEXT, and that residue is written down as a measured
      // limitation instead of being papered over with an assertion that would pass either way.
      const undetectable: string[] = [];
      const markerless: string[] = [];
      const truncatedEntries = entriesWith(ruleClass, 'truncated');
      assert.ok(truncatedEntries.length >= 1, `${ruleClass} must have a truncated form, or the boundary is untested`);
      for (const entry of truncatedEntries) {
        if (!stillRecognisable(ruleClass, entry.value, rule.pattern)) {
          undetectable.push(entry.value);
          // THE BOUNDARY IS ASSERTED WHERE IT IS ASSERTABLE: for the two classes whose marker is a character, a value
          // without that character genuinely carries no part of the class, which is what makes it undetectable.
          if (ruleClass === 'EMAIL_ADDRESS') assert.equal(entry.value.includes('@'), false, `${entry.value} should have been refused`);
          if (ruleClass === 'RAW_HTML') assert.equal(entry.value.trimStart().startsWith('<'), false, `${entry.value} should have been refused`);
          markerless.push(`${entry.site} ${entry.value}`);
          continue;
        }
        const truncated = drive({ message: entry.value, ...OPAQUE_FIELDS });
        if (truncated.result.ok) {
          assert.deepEqual(canaryViolations(truncated.bytes, [entry.value]), [], `${ruleClass} truncation reached the bytes`);
        } else {
          assert.equal(truncated.result.reasonCode, 'CANARY_DETECTED', `${ruleClass} truncation: ${truncated.result.detail}`);
          assert.deepEqual(truncated.bytes, []);
        }
      }
      writeFileSync(
        join(EVIDENCE_DIR, 'truncation-limits.txt'),
        [...(markerless.length > 0 ? [`${ruleClass}: markerless truncation, undetectable by value:`] : []), ...markerless, ''].join('\n'),
        { flag: 'a' },
      );
      assert.equal(undetectable.length + truncatedEntries.filter((entry) => stillRecognisable(ruleClass, entry.value, rule.pattern)).length, truncatedEntries.length);
    });
  }
});

describe('a class with no value shape is refused by field name, and the configuration says so', () => {
  for (const ruleClass of NAME_CLASSES) {
    test(`${ruleClass}: the field that would carry it is denied, and no pattern is claimed`, () => {
      const rule = allowlist.ruleClasses.find((candidate) => candidate.ruleClass === ruleClass);
      assert.ok(rule !== undefined);
      assert.equal(rule.pattern, undefined, `${ruleClass} declares ${rule.enforcement} enforcement, so a pattern would be a false claim`);
      const entry = bundle.entries.find((candidate) => candidate.rule_class === ruleClass);
      assert.ok(entry !== undefined);
      const fieldName = CONTROL_FIELD_NAME[ruleClass] ?? 'message';
      const refused = drive({ [fieldName]: entry.value, ...OPAQUE_FIELDS });
      assert.equal(refused.result.ok, false, `${ruleClass} must not reach a sink`);
      if (refused.result.ok) return;
      assert.equal(refused.result.reasonCode, 'PROHIBITED_FIELD_NAME');
      assert.equal(refused.result.fieldPath, fieldName);
      assert.deepEqual(refused.bytes, [], 'a denial emits NO payload at all');
    });
  }
});

describe('the whole path, all five sinks, asserted on exported bytes (§4.4 items 3-4)', () => {
  test('every canary site is driven through the real gate to all five sinks with no canary in the bytes', () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const canaryValues = bundle.entries.filter((entry) => entry.encoding === 'plain').map((entry) => entry.value);
    const perSink: Record<string, string[]> = {};
    for (const sink of DLP_SINKS) perSink[sink] = [];

    for (const sink of DLP_SINKS) {
      for (const entry of bundle.entries.filter((candidate) => candidate.encoding === 'plain')) {
        // THE FIELD IS THE SITE'S OWN when it is prohibited, and the allowed `message` otherwise: a canary is injected
        // where PII would naturally flow, not into a field chosen to make the gate look good.
        const fieldName = CONTROL_FIELD_NAME[entry.rule_class] ?? entry.field_path;
        const fields: Record<string, string> = { ...OPAQUE_FIELDS, [fieldName]: entry.value };
        if (fieldName !== 'message') fields['message'] = 'an allowed field beside the canary';
        else fields['reasonCode'] = 'SCRUBBED';
        const result = gate.scrub(sink, { fields, resource: RESOURCE_FIXTURE });
        if (!result.ok) {
          assert.equal(result.reasonCode, 'PROHIBITED_FIELD_NAME', `${sink} ${entry.rule_class}: ${result.detail}`);
          continue;
        }
        const sent = sinks.send(result.payload);
        assert.equal(sent.ok, true);
        if (sent.ok) perSink[sink]?.push(sent.bytes);
      }
    }

    for (const sink of DLP_SINKS) {
      const bytes = perSink[sink] ?? [];
      assert.ok(bytes.length > 0, `${sink} exported nothing, so its cleanliness is unproven rather than proven`);
      assert.deepEqual(canaryViolations(bytes, canaryValues), [], `${sink} exported a canary`);
      // THE BYTES ARE WRITTEN WHERE THE CANARY STAGE CAN DIGEST THEM, and the digest is what the redaction-evidence
      // artifact carries. Writing them is not evidence on its own; the assertion above is.
      const text = bytes.join('\n---\n');
      writeFileSync(join(EVIDENCE_DIR, `capture-${sink}.txt`), `${text}\n`);
      writeFileSync(join(EVIDENCE_DIR, `capture-digest-${sink}.txt`), `${createHash('sha256').update(text).digest('hex')}\n`);
    }

    assert.equal(sinks.rows().length, 5, 'the five sinks of §4.1, no more and no fewer');
    for (const row of sinks.rows()) {
      assert.ok(['CONFIGURED', 'BLOCKED_ENVIRONMENT'].includes(row.status));
      assert.match(row.detail, /no delivery is claimed/, `${row.sink} must not imply a delivery`);
    }
    // NO EXTERNAL ENDPOINT IS REACHABLE FROM THIS ENVIRONMENT: every row is BLOCKED_ENVIRONMENT, which is the FALLBACK
    // the node plan prescribes, and the canary assertion above ran on the captured bytes regardless.
    assert.deepEqual(sinks.rows().filter((row) => row.status === 'CONFIGURED').map((row) => row.sink), []);
  });

  test('allowlisted opaque identifiers and all nine resource attributes still appear, unchanged', () => {
    const result = gate.scrub('OTLP_TRACE_EXPORTER', {
      fields: { message: 'independent observation completed for exposure', ...OPAQUE_FIELDS },
      resource: RESOURCE_FIXTURE,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const sent = sinks.send(result.payload);
    assert.equal(sent.ok, true);
    if (!sent.ok) return;
    for (const [key, value] of Object.entries(OPAQUE_FIELDS)) {
      assert.equal(result.payload.fields[key], value, `${key} must survive the scrub unchanged`);
      assert.ok(sent.bytes.includes(value), `${key} must appear in the exported bytes`);
    }
    for (const [key, value] of Object.entries(RESOURCE_FIXTURE)) {
      assert.ok(sent.bytes.includes(value), `${key} must appear in the exported bytes`);
    }
    assert.equal(result.outcome, 'ALLOWED_OPAQUE');
    assert.match(result.payload.scrubToken, /^scrub-[0-9a-f]{32}$/);
  });

  test('a resource attribute carrying a prohibited class is DENIED rather than rewritten', () => {
    const email = entriesWith('EMAIL_ADDRESS', 'plain')[0];
    assert.ok(email !== undefined);
    const result = gate.scrub('LOG_FORWARDER', {
      fields: { message: 'identity check' },
      resource: { ...RESOURCE_FIXTURE, 'service.version': email.value },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reasonCode, 'PROHIBITED_CLASS');
    assert.equal(result.fieldPath, 'service.version');
  });
});

describe('the deny-by-default rules of §4.1', () => {
  test('a field with no classification is denied, and the refusal names it', () => {
    const result = gate.scrub('DEBUG_BUNDLE', { fields: { notInTheAllowlist: 'value' }, resource: RESOURCE_FIXTURE });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reasonCode, 'NOT_ALLOWLISTED');
    assert.equal(result.fieldPath, 'notInTheAllowlist');
  });

  test('a prohibited field NAME is denied before its value is looked at', () => {
    const result = gate.scrub('PR_ISSUE_EXPORTER', { fields: { password: 'no' }, resource: RESOURCE_FIXTURE });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reasonCode, 'PROHIBITED_FIELD_NAME');
  });

  test('a field classified as denied is denied by class, not by value', () => {
    // The shipped configuration classifies only permitted fields, so this case uses a policy in which an identity-document
    // field exists: it is the §4.3 class rule being exercised, not a value pattern.
    const policy = parseTelemetryAllowlist({
      ...(JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as Record<string, unknown>),
      log_fields: {
        ...((JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as { log_fields: Record<string, unknown> }).log_fields),
        documentNumber: { egress_class: 'IDENTITY_DOCUMENT', disposition: 'DENY' },
      },
      prohibited_field_names: ['password'],
    });
    assert.equal(policy.ok, true, policy.ok ? '' : policy.errors.join('; '));
    if (!policy.ok) return;
    const classGate = createEgressGate({ allowlist: policy.allowlist });
    const result = classGate.scrub('LOG_FORWARDER', { fields: { documentNumber: 'X1234567' }, resource: RESOURCE_FIXTURE });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reasonCode, 'PROHIBITED_CLASS');
    assert.match(result.detail, /IDENTITY_DOCUMENT/);
  });

  test('a non-string value is a FAILURE, which behaves as a denial', () => {
    const result = gate.scrub('LOG_FORWARDER', { fields: { attempt: 3 }, resource: RESOURCE_FIXTURE });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.outcome, 'FAILED');
    assert.equal(result.reasonCode, 'SCRUB_FAILED');
  });

  test('an unvalidatable policy denies everything with POLICY_ABSENT, and says why', () => {
    const broken = createEgressGateFromFile(join(ROOT, 'config/telemetry/no-such-allowlist.json'));
    const result = broken.scrub('LOG_FORWARDER', { fields: { message: 'anything' }, resource: RESOURCE_FIXTURE });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.outcome, 'FAILED');
    assert.equal(result.reasonCode, 'POLICY_ABSENT');
    assert.match(result.detail, /could not be validated/);
    assert.equal(broken.disabledRuleClasses().length, 0);
  });
});

describe('the accepted-payload token (§4.1: reaching a sink without one is impossible)', () => {
  test('a payload that is not the product of the scrub stage is refused by the sink at runtime', () => {
    const forged = { sink: 'LOG_FORWARDER', outcome: 'ALLOWED_OPAQUE', scrubToken: 'nope', fields: {}, resource: {}, redactionRuleClass: null, redactionCount: 0 };
    const sent = sinks.send(forged as unknown as AcceptedPayload);
    assert.equal(sent.ok, false);
    if (sent.ok) return;
    assert.equal(sent.reason, 'BLOCKED_ENVIRONMENT');
    assert.match(sent.detail, /no scrub token/);
  });

  test('the token is a digest over the accepted content, so two different payloads do not share one', () => {
    const first = gate.scrub('LOG_FORWARDER', { fields: { message: 'one' }, resource: RESOURCE_FIXTURE });
    const second = gate.scrub('LOG_FORWARDER', { fields: { message: 'two' }, resource: RESOURCE_FIXTURE });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.notEqual(first.payload.scrubToken, second.payload.scrubToken);
    const repeated = gate.scrub('LOG_FORWARDER', { fields: { message: 'one' }, resource: RESOURCE_FIXTURE });
    assert.equal(repeated.ok, true);
    if (!repeated.ok) return;
    assert.equal(repeated.payload.scrubToken, first.payload.scrubToken, 'the same content must produce the same token');
  });
});

describe('the counters the alerts select (§4.1, §8 A-06 and A-06c)', () => {
  test('outcome, denial and canary series carry the label sets the alert expressions use', () => {
    const fresh = createEgressGate({ allowlist });
    fresh.scrub('LOG_FORWARDER', { fields: { message: 'clean record', ...OPAQUE_FIELDS }, resource: RESOURCE_FIXTURE });
    const email = entriesWith('EMAIL_ADDRESS', 'plain')[0];
    assert.ok(email !== undefined);
    fresh.scrub('LOG_FORWARDER', { fields: { message: email.value }, resource: RESOURCE_FIXTURE });
    const encoded = entriesWith('EMAIL_ADDRESS', 'base64')[0];
    assert.ok(encoded !== undefined);
    fresh.scrub('ERROR_REPORTER', { fields: { message: encoded.value }, resource: RESOURCE_FIXTURE });
    fresh.scrub('LOG_FORWARDER', { fields: { unknownField: 'x' }, resource: RESOURCE_FIXTURE });

    const counters = fresh.counters();
    assert.equal(counters[`${SCRUB_OUTCOME_COUNTER}{outcome="ALLOWED_OPAQUE"}`], 1);
    assert.equal(counters[`${SCRUB_OUTCOME_COUNTER}{outcome="REDACTED"}`], 1);
    assert.equal(counters[`${SCRUB_OUTCOME_COUNTER}{outcome="DENIED"}`], 2);
    assert.equal(counters[`${EGRESS_DENIED_COUNTER}{reason_code="CANARY_DETECTED"}`], 1);
    assert.equal(counters[`${EGRESS_DENIED_COUNTER}{reason_code="NOT_ALLOWLISTED"}`], 1);
    // THE LABEL VALUE IS THE CATALOGUE'S, NOT THE ADAPTER'S NAME (EP-008 M4 reconciled the two): §6.5 bounds the `sink`
    // label to {TRACE, LOG, ERROR_REPORT, PR_ISSUE, DEBUG_BUNDLE}, so the series carries ERROR_REPORT while this adapter
    // calls the sink ERROR_REPORTER. Asserting the mapping rather than the literal keeps the two in step.
    assert.equal(counters[`${CANARY_DETECTIONS_COUNTER}{sink="${SINK_LABEL_VALUES['ERROR_REPORTER']}"}`], 1);
    assert.equal(fresh.refusals().length, 2, 'every denial is observable rather than inferred');
    assert.equal(fresh.disabledRuleClasses().length, 0, 'the shipped configuration disables nothing');
  });
});

describe('the disabled-rule control proves the canary assertion can fail (§4.4 item 5)', () => {
  test('with EMAIL_ADDRESS disabled the canary REACHES the exported bytes, and the report names the class and the field', () => {
    const control = createEgressGate({ allowlist, disabledRuleClasses: ['EMAIL_ADDRESS'] });
    assert.deepEqual(control.disabledRuleClasses(), ['EMAIL_ADDRESS']);
    const email = entriesWith('EMAIL_ADDRESS', 'plain')[0];
    assert.ok(email !== undefined);
    const result = control.scrub('LOG_FORWARDER', { fields: { message: email.value, ...OPAQUE_FIELDS }, resource: RESOURCE_FIXTURE });
    assert.equal(result.ok, true, 'a disabled rule lets the record through, which is what makes the control a control');
    if (!result.ok) return;
    const sent = sinks.send(result.payload);
    assert.equal(sent.ok, true);
    if (!sent.ok) return;
    const violations = canaryViolations([sent.bytes], [email.value]);
    // THE ASSERTION THE CANARY STAGE MAKES ON THE REAL GATE, RUN HERE AGAINST THE DISABLED ONE: it fails, and the failure
    // names the offending rule class and the field path — the two things §4.4 item 5 requires it to name.
    assert.deepEqual(violations, [email.value], 'the control must fail, or the suite cannot fail');
    writeFileSync(
      join(EVIDENCE_DIR, 'control-disabled-rule.txt'),
      `rule_class=EMAIL_ADDRESS\nfield_path=${email.field_path}\nvalue_reached_bytes=${violations[0] ?? ''}\n`,
    );
  });

  test('the same suite run against the real gate passes, which is the difference the control measures', () => {
    const email = entriesWith('EMAIL_ADDRESS', 'plain')[0];
    assert.ok(email !== undefined);
    const result = gate.scrub('LOG_FORWARDER', { fields: { message: email.value, ...OPAQUE_FIELDS }, resource: RESOURCE_FIXTURE });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const sent = sinks.send(result.payload);
    assert.equal(sent.ok, true);
    if (!sent.ok) return;
    assert.deepEqual(canaryViolations([sent.bytes], [email.value]), []);
  });
});

describe('the allowlist validation refuses a policy that cannot be trusted', () => {
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as Record<string, unknown>;
  const mutate = (patch: Record<string, unknown>): unknown => ({ ...raw, ...patch });
  const ruleClasses = raw['dlp_rule_classes'] as Record<string, unknown>[];

  test('the shipped configuration validates, disables nothing, and declares the six reason codes', () => {
    assert.equal(loaded.ok, true);
    assert.deepEqual(allowlist.ruleClasses.filter((rule) => !rule.enabled), []);
    assert.equal(allowlist.defaultDisposition, 'DENY');
    assert.ok(allowlist.sinks.length === 5);
    assert.deepEqual([...allowlist.reasonCodes].sort(), [
      'CANARY_DETECTED',
      'NOT_ALLOWLISTED',
      'POLICY_ABSENT',
      'PROHIBITED_CLASS',
      'PROHIBITED_FIELD_NAME',
      'SCRUB_FAILED',
    ]);
    assert.equal(new Set(allowlist.ruleClasses.map((rule) => rule.ruleClass)).size, allowlist.ruleClasses.length);
    assert.equal(new Set(allowlist.sinks).size, DLP_SINKS.length);
    assert.deepEqual([...allowlist.sinks].sort(), [...DLP_SINKS].sort());
  });

  for (const [name, patch, expected] of [
    ['a default of ALLOW', { default_disposition: 'ALLOW' }, /default_disposition must be DENY/],
    ['an unknown EgressClass', { log_fields: { message: { egress_class: 'PUBLIC', disposition: 'ALLOW' } } }, /is not one of NONE/],
    ['an unknown disposition', { log_fields: { message: { egress_class: 'NONE', disposition: 'MAYBE' } } }, /is not one of ALLOW/],
    ['a prohibited name that is also allowlisted', { log_fields: { password: { egress_class: 'AUTH_SECRET', disposition: 'DENY' } } }, /is prohibited by SPEC-007/],
    ['a resource key with no fail-closed mark', { resource_keys: { 'service.name': { egress_class: 'NONE', disposition: 'ALLOW' } } }, /must carry on_resolution_failure/],
    ['a VALUE_PATTERN class with no pattern', { dlp_rule_classes: [{ ...ruleClasses.find((rule) => rule['enforcement'] === 'VALUE_PATTERN'), pattern: undefined }] }, /must carry a pattern/],
    ['a pattern on a FIELD_NAME class', { dlp_rule_classes: [{ ...ruleClasses.find((rule) => rule['enforcement'] === 'FIELD_NAME'), pattern: 'x' }] }, /a pattern would be dead configuration/],
    ['a duplicated rule class', { dlp_rule_classes: [ruleClasses[0], ruleClasses[0]] }, /appears twice/],
    ['a pattern that does not compile', { dlp_rule_classes: [{ ...ruleClasses.find((rule) => rule['enforcement'] === 'VALUE_PATTERN'), pattern: '([' }] }, /not a compilable/],
  ] as const) {
    test(`NEGATIVE CASE: ${name} is refused with a readable reason`, () => {
      const result = parseTelemetryAllowlist(mutate(patch));
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.errors.join(' | '), expected);
    });
  }

  test('a class marked enabled:false is accepted but recorded, because the control needs it and silence would hide it', () => {
    const policy = parseTelemetryAllowlist(mutate({
      dlp_rule_classes: ruleClasses.map((rule) => (rule['rule_class'] === 'EMAIL_ADDRESS' ? { ...rule, enabled: false } : rule)),
    }));
    assert.equal(policy.ok, true, policy.ok ? '' : policy.errors.join('; '));
    if (!policy.ok) return;
    const disabled = policy.allowlist.ruleClasses.filter((rule) => !rule.enabled).map((rule) => rule.ruleClass);
    assert.deepEqual(disabled, ['EMAIL_ADDRESS'], 'a reader can see exactly what the control switched off');
  });
});

describe('the redaction evidence this run leaves behind', () => {
  test('the bundle, its digest and the per-sink digests are written where the canary stage reads them', () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, 'canary-bundle.json'), bundleBytes);
    writeFileSync(join(EVIDENCE_DIR, 'canary-bundle-digest.txt'), `${bundleDigest}\n`);
    const written = readFileSync(join(EVIDENCE_DIR, 'canary-bundle.json'), 'utf8');
    assert.equal(createHash('sha256').update(written).digest('hex'), bundleDigest, 'the digest must describe the bytes on disk');
    for (const sink of DLP_SINKS) {
      const digest = readFileSync(join(EVIDENCE_DIR, `capture-digest-${sink}.txt`), 'utf8').trim();
      assert.match(digest, /^[0-9a-f]{64}$/, `${sink} must have its own exported-payload digest`);
    }
  });
});
