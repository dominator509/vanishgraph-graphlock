/**
 * Telemetry resource identity (EP-008 M1; SPEC-007 §2.1, §2.2, §4.3, §5.2-§5.4; DOD-029, DOD-037).
 *
 * THE ASSERTION THE MILESTONE NAMES, LITERALLY: for each of the nine canonical keys in turn, with that key unresolved,
 * the run emits ZERO records and increments the failure counter; with all nine resolved, every emitted record carries
 * all nine with the exact values recorded in `RUN_MANIFEST.json`; and a record carrying `unknown`, `n/a`, `latest` or a
 * zero digest fails.
 *
 * WHAT IS REAL HERE AND WHAT IS A FIXTURE, STATED SO NO READER MISTAKES ONE FOR THE OTHER. The values this repository
 * can resolve from its own files are read from those files (`package.json`, `RUN_MANIFEST.json`) and compared with what
 * the manifest records, so a drift between the two fails. The values it CANNOT resolve are marked `EXTERNAL_REQUIRED` in
 * the manifest with the reason — the artifact digest and the build-inputs digest belong to the build/release pipeline
 * (`scripts/artifact-identity.sh` is still a loud-fail placeholder owned by EP-009), and the loaded policy set and recipe
 * set belong to runtime loaders that do not exist yet — and the suite supplies those four as declared test inputs. The
 * suite also asserts that the manifest marks them unresolved, so a fixture can never be mistaken for a measurement.
 *
 * THE RECORDING SINK IS A PORT IMPLEMENTATION, NOT A DOUBLE OF THE THING UNDER TEST: the telemetry sink is the seam the
 * module is built around (TESTING.md's test-double zone), and the module's behaviour under test is what it decides to
 * hand that sink — including the decision to hand it nothing.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  CANONICAL_RESOURCE_KEYS,
  DECLARED_SERVICES,
  ENVIRONMENT_NAMES,
  RESOURCE_ATTR_MISSING_REASON,
  RESOURCE_ATTR_MISSING_SERIES,
  TENANT_CLASSES,
  resolveTelemetryResource,
  type CanonicalResourceKey,
  type ResolvedResourceInput,
} from '../../src/adapters/observability/telemetry-resource.ts';
import {
  PACKAGE_JSON_PATH,
  RUN_MANIFEST_PATH,
  TelemetryIdentityError,
  createTelemetryProducer,
  readWorkspaceStaticValues,
  requireDeclaredService,
  resolveWorkspaceResource,
  type EmittedTelemetryRecord,
  type ProcessIdentity,
  type TelemetryIdentityDiagnostic,
} from '../../src/infrastructure/observability/compose-telemetry.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const MANIFEST_PATH = join(ROOT, RUN_MANIFEST_PATH);
const ALLOWLIST_PATH = join(ROOT, 'config/telemetry/allowlist.json');

interface KeyRecord {
  readonly source: string;
  readonly resolution: 'STATIC' | 'PROCESS_INPUT' | 'EXTERNAL_REQUIRED';
  readonly value: string | null;
  readonly reason?: string;
  readonly allowed?: readonly string[];
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
  candidate_epoch: string;
  telemetry_resource: { keys: Record<string, KeyRecord> };
};
const keyRecords = manifest.telemetry_resource.keys;
const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as {
  version: string;
  default_disposition: string;
  egress_classes: readonly string[];
  dispositions: Record<string, string>;
  resource_keys: Record<string, { egress_class: string; disposition: string; on_resolution_failure: string }>;
  resource_key_note: string;
  span_attributes: Record<string, { egress_class: string; disposition: string }>;
  log_fields: Record<string, { egress_class: string; disposition: string }>;
  canonical_events: readonly string[];
  prohibited_field_names: readonly string[];
};
const allowlistText = readFileSync(ALLOWLIST_PATH, 'utf8');

const keysWith = (resolution: KeyRecord['resolution']): CanonicalResourceKey[] =>
  CANONICAL_RESOURCE_KEYS.filter((key) => keyRecords[key]?.resolution === resolution);

/** What a process knows about itself: exactly the three values §2.1 assigns to the deployment manifest. */
const PROCESS_IDENTITY: ProcessIdentity = {
  serviceName: 'vanishgraph-worker-verify',
  environment: 'local',
  tenantClass: 'TEST',
};

/**
 * THE FOUR VALUES BELOW ARE DECLARED TEST INPUTS, NOT MEASUREMENTS. Each stands in for a source that does not exist in
 * this tree — two belong to the build/release pipeline (EP-009) and two to runtime loaders — and the suite asserts that
 * the manifest marks each of them EXTERNAL_REQUIRED, so a fixture can never be read as a resolved value.
 */
const EXTERNAL_INPUTS = {
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  buildInputsDigest: `sha256:${'b'.repeat(64)}`,
  policyVersion: '2026-02-14.1',
  recipeSetDigest: `sha256:${'c'.repeat(64)}`,
} as const;

/** A process that has all nine values available: the three it knows and the four its pipeline and loaders supply. */
const SUPPLIED_IDENTITY: ProcessIdentity = { ...PROCESS_IDENTITY, ...EXTERNAL_INPUTS };

function completeInput(): ResolvedResourceInput {
  return resolveWorkspaceResource(ROOT, SUPPLIED_IDENTITY);
}

/** The input a run in this tree actually has: the three process values, and nothing for the four external ones. */
function workspaceInput(): ResolvedResourceInput {
  return resolveWorkspaceResource(ROOT, PROCESS_IDENTITY);
}

/**
 * A sink that records what it was handed, and a local-error sink that does the same.
 *
 * `received` is asserted to be EMPTY in the refusal cases, which is the acceptance property: no record reaches a sink.
 */
function recordingSinks(): {
  readonly sink: (record: EmittedTelemetryRecord) => void;
  readonly received: EmittedTelemetryRecord[];
  readonly diagnostics: TelemetryIdentityDiagnostic[];
  readonly localErrorSink: (diagnostic: TelemetryIdentityDiagnostic) => void;
} {
  const received: EmittedTelemetryRecord[] = [];
  const diagnostics: TelemetryIdentityDiagnostic[] = [];
  return {
    received,
    diagnostics,
    sink: (record) => received.push(record),
    localErrorSink: (diagnostic) => diagnostics.push(diagnostic),
  };
}

describe('the nine canonical keys are declared once, and the manifest and the allowlist agree with the module', () => {
  test('the module declares exactly the nine keys of SPEC-007 §2.1', () => {
    assert.equal(CANONICAL_RESOURCE_KEYS.length, 9);
    assert.deepEqual([...CANONICAL_RESOURCE_KEYS].sort(), [
      'deployment.environment.name',
      'service.name',
      'service.version',
      'vanishgraph.artifact.digest',
      'vanishgraph.build.inputs_digest',
      'vanishgraph.candidate_epoch',
      'vanishgraph.policy.version',
      'vanishgraph.recipe.set_digest',
      'vanishgraph.tenant.class',
    ]);
  });

  test('the allowlist classifies every canonical key, and the manifest records every canonical key', () => {
    assert.deepEqual(Object.keys(allowlist.resource_keys).sort(), [...CANONICAL_RESOURCE_KEYS].sort());
    assert.deepEqual(Object.keys(keyRecords).sort(), [...CANONICAL_RESOURCE_KEYS].sort());
  });

  test('every manifest key states a source, a resolution from the closed set, and a reason when it cannot be resolved', () => {
    for (const key of CANONICAL_RESOURCE_KEYS) {
      const record = keyRecords[key];
      assert.ok(record !== undefined, `${key} must be recorded`);
      assert.ok(record.source.trim().length > 0, `${key} must name its source of truth`);
      assert.ok(
        ['STATIC', 'PROCESS_INPUT', 'EXTERNAL_REQUIRED'].includes(record.resolution),
        `${key}: "${record.resolution}" is not a resolution this suite knows; a new value needs a test for it`,
      );
      if (record.resolution === 'STATIC') {
        assert.equal(typeof record.value, 'string', `${key} is STATIC, so it must record a value`);
      } else {
        assert.equal(record.value, null, `${key} is ${record.resolution}, so it must not record a value`);
        assert.ok((record.reason ?? '').length > 40, `${key} must say WHY it cannot be resolved, not just that it cannot`);
      }
      if (record.resolution === 'PROCESS_INPUT') {
        assert.ok((record.allowed ?? []).length > 0, `${key} is supplied by the process, so the manifest must name its allowed values`);
      }
    }
  });

  test('the STATIC values the module reads from the workspace equal the values the manifest records', () => {
    // THE CROSS-CHECK THAT MAKES THE MANIFEST WORTH READING: the module resolves these from package.json and
    // RUN_MANIFEST.json, and this compares the result with the manifest's own claim about each.
    const statics = readWorkspaceStaticValues(ROOT);
    assert.deepEqual(statics.unreadable, [], 'both static sources must be readable in this repository');
    assert.equal(statics.serviceVersion, keyRecords['service.version']?.value);
    assert.equal(statics.candidateEpoch, keyRecords['vanishgraph.candidate_epoch']?.value);
    assert.equal(statics.candidateEpoch, manifest.candidate_epoch, 'the manifest records the epoch twice and the two must agree');
    assert.equal(statics.serviceVersion, JSON.parse(readFileSync(join(ROOT, PACKAGE_JSON_PATH), 'utf8')).version);
  });

  test('the keys this tree cannot resolve are exactly the ones the manifest marks EXTERNAL_REQUIRED with a reason', () => {
    // DERIVED, NOT HARDCODED: if EP-009 fills the artifact digest in, this expectation moves with it instead of failing
    // against a stale list.
    const external = keysWith('EXTERNAL_REQUIRED');
    assert.ok(external.length >= 1, 'a tree with no build artifact must record at least one unresolved key');
    for (const key of external) {
      assert.ok((keyRecords[key]?.reason ?? '').length > 40, `${key} must carry its reason for being unresolved`);
    }
    assert.equal(keysWith('STATIC').length + keysWith('PROCESS_INPUT').length + external.length, 9);
  });

  test('NEGATIVE CONTROL: reading a workspace that does not exist yields nulls and names the paths, and never throws', () => {
    const statics = readWorkspaceStaticValues(join(ROOT, 'no-such-directory-vanishgraph'));
    assert.equal(statics.serviceVersion, null);
    assert.equal(statics.candidateEpoch, null);
    assert.deepEqual([...statics.unreadable].sort(), [PACKAGE_JSON_PATH, RUN_MANIFEST_PATH].sort());
  });
});

describe('with any one key unresolved, the producer emits NOTHING and counts the refusal (SPEC-007 §2.1 rule 1)', () => {
  for (const key of CANONICAL_RESOURCE_KEYS) {
    test(`${key} unresolved: zero records, one diagnostic, counter incremented`, () => {
      const input: ResolvedResourceInput = { ...completeInput(), [key]: null };
      const sinks = recordingSinks();
      const producer = createTelemetryProducer({ resource: input, sink: sinks.sink, localErrorSink: sinks.localErrorSink });

      assert.equal(producer.identityResolved(), false, `${key} unresolved must not resolve the identity`);
      const result = producer.emit({ message: 'independent observation completed for exposure', severity: 'INFO' });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.deepEqual(result.unresolvedKeys, [key], `the refusal must name ${key} and nothing else`);
      assert.equal(result.reasonCode, RESOURCE_ATTR_MISSING_REASON);
      assert.equal(result.series, RESOURCE_ATTR_MISSING_SERIES);

      assert.deepEqual(producer.emitted(), [], 'ZERO records: nothing may reach a sink');
      assert.deepEqual(sinks.received, [], 'the sink must not have been called');
      assert.equal(producer.refusals(), 1);
      assert.equal(producer.counters()[RESOURCE_ATTR_MISSING_SERIES], 1, 'the counter must carry the refusal');
      assert.equal(sinks.diagnostics.length, 1, 'exactly one local structured error for the process');
      assert.equal(sinks.diagnostics[0]?.event, 'TelemetryIdentityMissing');
      assert.equal(sinks.diagnostics[0]?.severity, 'ERROR');
      assert.deepEqual(sinks.diagnostics[0]?.unresolvedKeys, [key]);
      // MEASURED GAP, NOW CLOSED: the first version of this suite counted only what reached the local sink, so a
      // duplicated internal diagnostic — two entries reported, one written — passed every assertion. The producer's own
      // record of its diagnostics is asserted against the sink's, so the two cannot disagree.
      assert.deepEqual(producer.diagnostics(), sinks.diagnostics, 'the producer must report exactly what it wrote');
    });
  }

  test('a refusal names EVERY unresolved key at once, not the first one', () => {
    const input: ResolvedResourceInput = {
      ...completeInput(),
      'vanishgraph.artifact.digest': null,
      'vanishgraph.policy.version': null,
      'vanishgraph.recipe.set_digest': null,
    };
    const resolved = resolveTelemetryResource(input);
    assert.equal(resolved.ok, false);
    if (resolved.ok) return;
    assert.deepEqual([...resolved.unresolvedKeys].sort(), [
      'vanishgraph.artifact.digest',
      'vanishgraph.policy.version',
      'vanishgraph.recipe.set_digest',
    ]);
    assert.match(resolved.detail, /3 of the nine/);
  });

  test('a refusing producer keeps refusing, and still writes only ONE local error for the process', () => {
    const sinks = recordingSinks();
    const input: ResolvedResourceInput = { ...completeInput(), 'vanishgraph.artifact.digest': null };
    const producer = createTelemetryProducer({ resource: input, sink: sinks.sink, localErrorSink: sinks.localErrorSink });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      producer.emit({ message: 'removal attempt recorded', severity: 'WARN' });
    }
    assert.equal(producer.refusals(), 5);
    assert.equal(producer.counters()[RESOURCE_ATTR_MISSING_SERIES], 5, 'the counter is the volume signal');
    assert.equal(producer.emitted().length, 0);
    assert.equal(sinks.received.length, 0);
    assert.equal(sinks.diagnostics.length, 1, 'one process, one announcement');
    assert.deepEqual(producer.diagnostics(), sinks.diagnostics);
  });

  test('the four prohibited substitutes of §2.1 rule 1 are refused for EVERY key that carries them', () => {
    const prohibited = ['unknown', 'n/a', 'latest', '0'.repeat(64)];
    for (const key of CANONICAL_RESOURCE_KEYS) {
      for (const value of prohibited) {
        const input: ResolvedResourceInput = { ...completeInput(), [key]: value };
        const sinks = recordingSinks();
        const producer = createTelemetryProducer({ resource: input, sink: sinks.sink, localErrorSink: sinks.localErrorSink });
        const result = producer.emit({ message: 'record', severity: 'INFO' });
        assert.equal(result.ok, false, `${key}="${value}" must be refused`);
        assert.equal(producer.emitted().length, 0, `${key}="${value}" must emit nothing`);
        assert.equal(sinks.received.length, 0, `${key}="${value}" must not reach the sink`);
        if (result.ok) continue;
        assert.deepEqual(result.unresolvedKeys, [key], `${key}="${value}" must be refused BY NAME`);
        assert.match(result.detail, /PROHIBITED_SUBSTITUTE/, 'the refusal must say it was a prohibited substitute');
      }
    }
  });

  test('the refusal reason distinguishes a missing value from a prohibited substitute', () => {
    const missing = resolveTelemetryResource({ ...completeInput(), 'service.version': null });
    const substituted = resolveTelemetryResource({ ...completeInput(), 'service.version': 'unknown' });
    assert.equal(missing.ok, false);
    assert.equal(substituted.ok, false);
    if (missing.ok || substituted.ok) return;
    assert.equal(missing.unresolved[0]?.reason, 'MISSING');
    assert.equal(substituted.unresolved[0]?.reason, 'PROHIBITED_SUBSTITUTE');
  });
});

describe('with all nine resolved, every emitted record carries all nine with the expected values', () => {
  test('every record carries all nine keys, and no record carries a tenth', () => {
    const sinks = recordingSinks();
    const input = completeInput();
    const producer = createTelemetryProducer({ resource: input, sink: sinks.sink, localErrorSink: sinks.localErrorSink });
    assert.equal(producer.identityResolved(), true);
    producer.emit({ message: 'first', severity: 'INFO', attributes: { reasonCode: 'NONE' } });
    producer.emit({ message: 'second', severity: 'WARN' });
    producer.emit({ message: 'third', severity: 'ERROR' });

    assert.equal(producer.emitted().length, 3);
    assert.equal(sinks.received.length, 3, 'every emitted record reaches the sink');
    for (const [index, record] of producer.emitted().entries()) {
      assert.deepEqual(Object.keys(record.resource).sort(), [...CANONICAL_RESOURCE_KEYS].sort(), `record ${String(index)}`);
      for (const key of CANONICAL_RESOURCE_KEYS) {
        const value = record.resource[key];
        assert.equal(typeof value, 'string');
        assert.ok(value.trim().length > 0, `record ${String(index)}: ${key} must be non-empty`);
        assert.equal(value, input[key], `record ${String(index)}: ${key} must be the resolved value, unchanged`);
      }
      assert.equal(Object.hasOwn(record.resource, 'service.namespace'), false, 'no invented key may appear');
    }
    assert.deepEqual(producer.counters(), {}, 'a resolved producer refuses nothing');
    assert.deepEqual(sinks.diagnostics, [], 'a resolved producer writes no identity error');
  });

  test('the values carried are the manifest-recorded STATIC values and the declared EXTERNAL_REQUIRED test inputs', () => {
    const input = completeInput();
    for (const key of keysWith('STATIC')) {
      assert.equal(input[key], keyRecords[key]?.value, `${key} must be the value the manifest records`);
    }
    for (const key of keysWith('PROCESS_INPUT')) {
      assert.equal(keyRecords[key]?.allowed?.includes(input[key] ?? ''), true, `${key} must be one of the allowed values`);
    }
    for (const key of keysWith('EXTERNAL_REQUIRED')) {
      // THE FIXTURE IS VISIBLE AS A FIXTURE: the manifest says this key has no source in this tree, and the value below
      // is the suite's declared input rather than a claimed measurement.
      assert.equal(keyRecords[key]?.value, null);
      assert.equal(typeof input[key], 'string');
      assert.ok((input[key] ?? '').length > 0);
    }
  });

  test('the sink receives the same immutable record the producer reports, including the caller attributes', () => {
    const sinks = recordingSinks();
    const producer = createTelemetryProducer({
      resource: completeInput(),
      sink: sinks.sink,
      localErrorSink: sinks.localErrorSink,
    });
    const result = producer.emit({ message: 'verified removal recorded', severity: 'INFO', attributes: { transitionId: 'T14' } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(sinks.received[0], result.record, 'the sink must receive the record, not a copy that could drift');
    assert.deepEqual(result.record.attributes, { transitionId: 'T14' });
    assert.equal(Object.isFrozen(result.record), true, 'a record that can be mutated after emission is not evidence');
  });
});

describe('the service name and the two enum attributes are closed sets (SPEC-007 §2.1, §2.2)', () => {
  test('each of the seven declared services resolves, and none of them is invented', () => {
    assert.equal(DECLARED_SERVICES.length, 7);
    for (const service of DECLARED_SERVICES) {
      const input: ResolvedResourceInput = { ...completeInput(), 'service.name': service };
      const resolved = resolveTelemetryResource(input);
      assert.equal(resolved.ok, true, `${service} must resolve`);
      if (!resolved.ok) continue;
      assert.equal(resolved.attributes['service.name'], service);
      assert.equal(requireDeclaredService(service), service);
    }
  });

  test('an undeclared service fails startup rather than emitting unattributed telemetry (§2.2)', () => {
    const input: ResolvedResourceInput = { ...completeInput(), 'service.name': 'vanishgraph-worker' };
    const resolved = resolveTelemetryResource(input);
    assert.equal(resolved.ok, false);
    if (resolved.ok) return;
    assert.equal(resolved.unresolved[0]?.reason, 'UNDECLARED_SERVICE');
    assert.throws(() => requireDeclaredService('vanishgraph-worker'), TelemetryIdentityError);
    assert.throws(() => requireDeclaredService(null), TelemetryIdentityError);
    // AND THE REFUSAL IS THE SAME COUNTER: §7.2 names one reason code for an unresolved resource attribute, and A-11
    // selects that one series, so an undeclared service must not open a second series nobody alerts on.
    assert.equal(resolved.reasonCode, RESOURCE_ATTR_MISSING_REASON);
  });

  test('the environment is one of the five §2.1 tokens, and a near-miss is refused', () => {
    assert.deepEqual([...ENVIRONMENT_NAMES], ['local', 'ci', 'preview', 'staging', 'production']);
    for (const environment of ENVIRONMENT_NAMES) {
      assert.equal(resolveTelemetryResource({ ...completeInput(), 'deployment.environment.name': environment }).ok, true, environment);
    }
    for (const wrong of ['dev', 'test', 'prod', 'production-us', 'LOCAL', '']) {
      const resolved = resolveTelemetryResource({ ...completeInput(), 'deployment.environment.name': wrong });
      assert.equal(resolved.ok, false, `"${wrong}" must not resolve`);
      if (resolved.ok) continue;
      assert.deepEqual(resolved.unresolvedKeys, ['deployment.environment.name']);
      assert.equal(resolved.unresolved[0]?.reason, wrong === '' ? 'MISSING' : 'UNKNOWN_ENVIRONMENT');
    }
  });

  test('the tenant class is an enum and never a tenant identifier (§2.1 rule 3)', () => {
    assert.deepEqual([...TENANT_CLASSES], ['INTERNAL', 'TEST', 'PILOT_TENANT', 'PRODUCTION_TENANT', 'EXTERNAL_REQUIRED']);
    for (const tenantClass of TENANT_CLASSES) {
      assert.equal(resolveTelemetryResource({ ...completeInput(), 'vanishgraph.tenant.class': tenantClass }).ok, true, tenantClass);
    }
    for (const wrong of ['PRODUCTION', 'tenant-4KQ7', 'test', '']) {
      const resolved = resolveTelemetryResource({ ...completeInput(), 'vanishgraph.tenant.class': wrong });
      assert.equal(resolved.ok, false, `"${wrong}" must not resolve`);
      if (resolved.ok) continue;
      assert.deepEqual(resolved.unresolvedKeys, ['vanishgraph.tenant.class']);
      assert.equal(resolved.unresolved[0]?.reason, wrong === '' ? 'MISSING' : 'UNKNOWN_TENANT_CLASS');
    }
  });
});

describe('the workspace as it actually is (EP-008 §9 item 2: an unresolved artifact digest emits zero records)', () => {
  test('a run in this tree refuses on exactly the keys the manifest marks EXTERNAL_REQUIRED', () => {
    const sinks = recordingSinks();
    const input = workspaceInput();
    const producer = createTelemetryProducer({ resource: input, sink: sinks.sink, localErrorSink: sinks.localErrorSink });
    assert.equal(producer.identityResolved(), false, 'a run with no build pipeline cannot identify its artifact');
    producer.emit({ message: 'a record this process cannot attribute', severity: 'INFO' });

    assert.deepEqual(producer.emitted(), [], 'zero records');
    assert.deepEqual(sinks.received, [], 'nothing reached the sink');
    assert.equal(sinks.diagnostics.length, 1, 'one TelemetryIdentityMissing record');
    assert.deepEqual(
      [...(sinks.diagnostics[0]?.unresolvedKeys ?? [])].sort(),
      [...keysWith('EXTERNAL_REQUIRED')].sort(),
      'the refusal must name exactly the keys this tree cannot resolve',
    );
    assert.ok((producer.counters()[RESOURCE_ATTR_MISSING_SERIES] ?? 0) > 0, 'the failure counter must be non-zero');
    assert.match(sinks.diagnostics[0]?.message ?? '', /will emit no telemetry/);
    assert.equal(sinks.diagnostics[0]?.series, RESOURCE_ATTR_MISSING_SERIES);
    assert.deepEqual(producer.diagnostics(), sinks.diagnostics, 'the producer must report exactly what it wrote');
  });

  test('the unresolved set is the four §2.1 keys whose upstream source does not exist yet', () => {
    // Named individually because the reason matters: two are build/release outputs owned by EP-009 and two are runtime
    // loaders. A tree that resolves one of them must change this list deliberately.
    assert.deepEqual([...keysWith('EXTERNAL_REQUIRED')].sort(), [
      'vanishgraph.artifact.digest',
      'vanishgraph.build.inputs_digest',
      'vanishgraph.policy.version',
      'vanishgraph.recipe.set_digest',
    ]);
    assert.equal(keyRecords['vanishgraph.artifact.digest']?.source, 'Build/release output (DOD-003, DOD-029)');
    assert.equal(workspaceInput()['vanishgraph.artifact.digest'], null, 'and the workspace resolution says so, not the test');
  });

  test('a caller that supplies the four unresolved values gets a producer that emits, with no substitution by the module', () => {
    const sinks = recordingSinks();
    const refused = createTelemetryProducer({
      resource: workspaceInput(),
      sink: sinks.sink,
      localErrorSink: sinks.localErrorSink,
    });
    assert.equal(refused.identityResolved(), false);
    // THE SAME MODULE AND THE SAME WORKSPACE, with the four values supplied: the refusal was about the input, not about a
    // code path that cannot emit, and the value carried is the caller's — the module substitutes nothing of its own.
    const supplied = createTelemetryProducer({
      resource: completeInput(),
      sink: sinks.sink,
      localErrorSink: sinks.localErrorSink,
    });
    assert.equal(supplied.identityResolved(), true);
    const result = supplied.emit({ message: 'artifact digest supplied', severity: 'INFO' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.record.resource['vanishgraph.artifact.digest'], EXTERNAL_INPUTS.artifactDigest);
    assert.equal(result.record.resource['vanishgraph.build.inputs_digest'], EXTERNAL_INPUTS.buildInputsDigest);
    assert.equal(result.record.resource['vanishgraph.policy.version'], EXTERNAL_INPUTS.policyVersion);
    assert.equal(result.record.resource['vanishgraph.recipe.set_digest'], EXTERNAL_INPUTS.recipeSetDigest);
    assert.deepEqual(sinks.received, [result.record]);
  });
});

describe('the allowlist is data, and it covers exactly what this milestone emits (SPEC-007 §4.3)', () => {
  test('the default is DENY, and every entry uses a known class and a known disposition', () => {
    assert.equal(allowlist.default_disposition, 'DENY', 'a field with no entry must be denied at runtime');
    const dispositions = Object.keys(allowlist.dispositions);
    assert.deepEqual(dispositions.sort(), ['ALLOW', 'ALLOW_WITH_REDACTION', 'DENY', 'DENY_BY_DEFAULT']);
    const groups = [allowlist.resource_keys, allowlist.span_attributes, allowlist.log_fields];
    for (const group of groups) {
      for (const [field, entry] of Object.entries(group)) {
        assert.ok(allowlist.egress_classes.includes(entry.egress_class), `${field}: unknown EgressClass ${entry.egress_class}`);
        assert.ok(dispositions.includes(entry.disposition), `${field}: unknown disposition ${entry.disposition}`);
        assert.equal(entry.disposition, 'ALLOW', `${field}: this milestone emits no denied field`);
        assert.ok(['NONE', 'OPAQUE_ID'].includes(entry.egress_class), `${field}: only NONE and OPAQUE_ID are permitted in telemetry`);
      }
    }
  });

  test('every canonical resource key carries the §2.1 fail-closed reason code, and the milestone’s own grep returns nine', () => {
    for (const key of CANONICAL_RESOURCE_KEYS) {
      assert.equal(allowlist.resource_keys[key]?.on_resolution_failure, RESOURCE_ATTR_MISSING_REASON, key);
    }
    const occurrences = allowlistText.split('\n').filter((line) => line.includes(RESOURCE_ATTR_MISSING_REASON)).length;
    assert.equal(occurrences, 9, 'exactly one line per canonical key, so the count IS the count of classified keys');
  });

  test('every §5.2 mandatory log field and every §3.1 span attribute has an entry', () => {
    for (const field of [
      'timestamp', 'severity', 'service', 'correlationId', 'tenantId', 'caseId', 'exposureId', 'actionId',
      'event', 'outcome', 'message', 'candidateEpoch', 'artifactDigest',
    ]) {
      assert.ok(allowlist.log_fields[field] !== undefined, `§5.2 ${field} must be classified`);
    }
    for (const attribute of [
      'vanishgraph.correlation_id', 'vanishgraph.tenant_id', 'vanishgraph.case_id', 'vanishgraph.exposure_id',
      'vanishgraph.action_id', 'vanishgraph.truth_state.from', 'vanishgraph.truth_state.to',
      'vanishgraph.transition_id', 'vanishgraph.idempotency_key', 'vanishgraph.egress.class',
      'vanishgraph.evidence.id', 'vanishgraph.evidence.digest', 'vanishgraph.verification.observation_id',
    ]) {
      assert.ok(allowlist.span_attributes[attribute] !== undefined, `§3.1 ${attribute} must be classified`);
    }
  });

  test('no prohibited field NAME is allowlisted, and the nine resource keys are the only stated exemption', () => {
    const allowlisted = [...Object.keys(allowlist.log_fields), ...Object.keys(allowlist.span_attributes)];
    for (const name of allowlist.prohibited_field_names) {
      assert.equal(allowlisted.includes(name), false, `"${name}" is prohibited by §5.3 and must not be allowlisted`);
    }
    // THE CONFLICT, RECORDED: §5.3 prohibits the leaf name `name`, while §2.1 mandates `service.name` and
    // `deployment.environment.name`. The file states the exemption and its boundary; a checker must raise it rather
    // than generalise it, and the two keys below are the whole exemption.
    assert.ok(allowlist.prohibited_field_names.includes('name'));
    assert.deepEqual(
      Object.keys(allowlist.resource_keys).filter((key) => key.split('.').includes('name')).sort(),
      ['deployment.environment.name', 'service.name'],
    );
    assert.match(allowlist.resource_key_note, /EXEMPT FROM THE LEAF-NAME PROHIBITION/);
    assert.match(allowlist.resource_key_note, /ONLY THEY ARE/);
  });

  test('the diagnostic and the emitted record use canonical event names and no prohibited field name', () => {
    assert.ok(allowlist.canonical_events.includes('TelemetryIdentityMissing'), '§5.4 declares this operational event');
    assert.ok(allowlist.canonical_events.includes('ReadinessChanged'), '§7.3 names this event');
    const sinks = recordingSinks();
    const producer = createTelemetryProducer({
      resource: { ...completeInput(), 'vanishgraph.policy.version': null },
      sink: sinks.sink,
      localErrorSink: sinks.localErrorSink,
    });
    producer.emit({ message: 'refused', severity: 'INFO' });
    const diagnostic = sinks.diagnostics[0];
    assert.ok(diagnostic !== undefined);
    assert.ok(allowlist.canonical_events.includes(diagnostic.event));
    for (const field of Object.keys(diagnostic)) {
      assert.equal(allowlist.prohibited_field_names.includes(field), false, `diagnostic field "${field}" is a prohibited name`);
    }
    for (const field of ['message', 'severity', 'attributes', 'resource']) {
      assert.equal(allowlist.prohibited_field_names.includes(field), false, `record field "${field}" is a prohibited name`);
    }
  });

  test('NEGATIVE CONTROL: the prohibited-name check can fail, and the allowlist version is stated', () => {
    const allowlisted = [...Object.keys(allowlist.log_fields)];
    assert.equal(allowlisted.includes('password'), false);
    // The check above is only meaningful if the list it reads contains names that COULD appear: if the list were empty,
    // every assertion in the previous test would hold vacuously.
    assert.ok(allowlist.prohibited_field_names.length >= 30, 'the prohibited-name list must be the §5.3 list, not a stub');
    assert.ok(allowlist.prohibited_field_names.includes('password'));
    assert.equal(allowlist.version, '1', 'the classification is versioned data');
  });
});
