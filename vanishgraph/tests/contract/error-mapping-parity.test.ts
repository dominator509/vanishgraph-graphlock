/**
 * Error-mapping parity (SPEC-003 §8.2, §8.4; SPEC-006 §6.2 H-7).
 *
 * SPEC-006 H-7 states the requirement this file exists to satisfy: "The two files must never list
 * different statuses for the same code — the contract test compares them and fails on divergence."
 *
 * It reads BOTH specification files and compares them against the registry. Reading the specs
 * rather than a checked-in extract means the registry cannot drift while a generated duplicate
 * keeps passing. SPEC-003 §8.4 also requires that a change to §8.1/§8.2 invalidates the mapping,
 * which is only true if the test reads the live text.
 *
 * A divergence between the two specifications is a DEFECT TO RECORD, not a value to pick. The one
 * found while building this registry (`INVALID_TRUTH_STATE`) is recorded in EP-004 §12 with
 * citations to five SPEC-003 sections, and the resolution is asserted here so it cannot rot.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ERROR_CODE_REGISTRY,
  FORBIDDEN_ADHOC_TOKENS,
  KNOWN_MESSAGE_CONFLICTS,
  KNOWN_STATUS_CONFLICTS,
  WIRE_STATUS_AMBIGUITY,
  indexRegistry,
  isErrorCode,
  messageFor,
  retryableFor,
  statusesFor,
  statusFor,
  wireCodeForDomain,
  type ErrorCodeSpec,
} from '../../src/http/errors/code-registry.ts';

const SPEC_DIR = join(import.meta.dirname, '..', '..', '.agent', 'specs');
const SPEC_003 = readFileSync(join(SPEC_DIR, 'SPEC-003-api-contracts.md'), 'utf8').split('\n');
const SPEC_006 = readFileSync(join(SPEC_DIR, 'SPEC-006-errors.md'), 'utf8').split('\n');

function section(lines: readonly string[], start: RegExp, end: RegExp): string[] {
  const s = lines.findIndex((l) => start.test(l));
  const e = lines.findIndex((l, i) => i > s && end.test(l));
  assert.ok(s >= 0, `section ${String(start)} not found`);
  assert.ok(e > s, `section end ${String(end)} not found`);
  return lines.slice(s, e);
}

/** Parse SPEC-003 §8.2 into code → the set of statuses it is listed under. */
function spec003Statuses(): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const line of section(SPEC_003, /^### 8\.2 /, /^### 8\.3 /)) {
    const row = /^\|\s*`(\d{3})`\s*\|/.exec(line);
    if (row?.[1] === undefined) continue;
    const status = Number(row[1]);
    // Only the code column (the third cell onward); the description cell is prose.
    const cells = line.split('|').slice(3).join('|');
    for (const m of cells.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) {
      const code = m[1];
      if (code === undefined || /^\d+$/.test(code)) continue;
      const set = out.get(code) ?? new Set<number>();
      set.add(status);
      out.set(code, set);
    }
  }
  return out;
}

/** Parse SPEC-006 §6.2 into code → status, with the message where the row states one. */
function spec006Mapping(): Map<string, { status: number; message: string | undefined }> {
  const out = new Map<string, { status: number; message: string | undefined }>();
  const rows = section(SPEC_006, /^### 6\.2 /, /^## 7\./);
  const header = rows.findIndex((l) => /^\|\s*Domain `code`/.test(l));
  assert.ok(header >= 0, 'the §6.2 domain-class table header was not found');

  for (const line of rows.slice(header + 2)) {
    if (!line.startsWith('|')) continue;
    const p = line.split('|').map((x) => x.trim());
    const wire = p[2] ?? '';
    const http = p[3] ?? '';
    const msg = p[4] ?? '';
    const status = Number(/^(\d{3})$/.exec(http)?.[1] ?? '0');
    if (status === 0 || status === 202) continue; // 202 is the reconciliation body, not an error
    const message = /^`(.*)`$/.exec(msg)?.[1];
    for (const m of wire.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
      const code = m[1];
      if (code === undefined) continue;
      if (!out.has(code)) out.set(code, { status, message });
    }
  }
  return out;
}

/** The retryable classes from SPEC-006 §5.3's `Rty` column. */
function spec006Retryable(): Set<string> {
  const out = new Set<string>();
  for (const line of section(SPEC_006, /^### 5\.3 /, /^### 5\.4 /)) {
    if (!line.startsWith('|')) continue;
    const p = line.split('|').map((x) => x.trim());
    // | # | Class | code | description | Cat | Rty | wire |
    const code = (p[3] ?? '').replace(/`/g, '');
    const rty = p[6] ?? '';
    if (!/^[A-Z][A-Z0-9_]+$/.test(code)) continue;
    if (rty === 'Y') out.add(code);
  }
  return out;
}

describe('the registry agrees with SPEC-003 §8.2 and SPEC-006 §6.2 (H-7)', () => {
  const s3 = spec003Statuses();
  const s6 = spec006Mapping();

  test('both specification tables parsed to a plausible size', () => {
    assert.ok(s3.size >= 120, `SPEC-003 §8.2 yielded ${s3.size} codes`);
    assert.ok(s6.size >= 25, `SPEC-006 §6.2 yielded ${s6.size} wire codes`);
  });

  test('every registry code exists in SPEC-003 §8.2 with a matching status', () => {
    const problems: string[] = [];
    for (const row of ERROR_CODE_REGISTRY) {
      const declared = s3.get(row.wireCode);
      if (declared === undefined) {
        problems.push(`${row.wireCode}: not enumerated in SPEC-003 §8.2`);
        continue;
      }
      if (!declared.has(row.status)) {
        problems.push(`${row.wireCode}: registry=${row.status} spec003={${[...declared].join(',')}}`);
      }
    }
    assert.deepEqual(problems, [], `SPEC-003 §8.2 divergences:\n  ${problems.join('\n  ')}`);
  });

  test('the conflict exemption list matches the actual SPEC-003/SPEC-006 divergence exactly', () => {
    // A guard on the guard: if a SECOND conflict appears, this fails and the new one must be
    // resolved deliberately rather than absorbed by the existing exemption.
    const actual: string[] = [];
    for (const [code, entry] of s6) {
      const declared = s3.get(code);
      if (declared === undefined) continue;
      if (declared.has(entry.status)) continue;
      // SCHEMA_VALIDATION_FAILED legitimately has two statuses; §8.2 lists both.
      if ((WIRE_STATUS_AMBIGUITY[code]?.length ?? 0) > 1) continue;
      actual.push(code);
    }
    assert.deepEqual(
      actual.sort(),
      Object.keys(KNOWN_STATUS_CONFLICTS).sort(),
      'the set of SPEC-003/SPEC-006 status conflicts changed; resolve it in EP-004 §12 rather than extending the list',
    );
  });

  test('the recorded INVALID_TRUTH_STATE conflict still has the shape it was resolved against', () => {
    const conflict = KNOWN_STATUS_CONFLICTS.INVALID_TRUTH_STATE;
    assert.ok(conflict !== undefined, 'the recorded conflict must exist');
    // SPEC-003 owns the wire (its §8.4), and it says 400 in §8.2 and in VG-API-006.
    assert.equal(statusFor('INVALID_TRUTH_STATE'), conflict.spec003);
    assert.equal(conflict.spec003, 400);
    // If SPEC-006's generic row ever stops saying 422, this resolution is stale and must be
    // revisited: the assertion is here so that change cannot pass unnoticed.
    assert.equal(s6.get('INVALID_TRUTH_STATE')?.status, conflict.spec006GenericRow);
    assert.equal(
      s3.get('INVALID_TRUTH_STATE')?.has(400),
      true,
      'SPEC-003 §8.2 must still list INVALID_TRUTH_STATE under 400',
    );
  });

  test('every SPEC-006 §6.2 row with a message matches the registry byte-for-byte', () => {
    // For the codes where SPEC-006 §6.2 itself states TWO templates, the registry must carry the
    // canonical one and BOTH templates must still be present in the spec. The assertion is
    // therefore: a single-template code matches exactly, and a declared-conflict code matches one
    // of its declared templates and the spec still contains all of them.
    const mismatches: string[] = [];
    for (const [code, entry] of s6) {
      if (entry.message === undefined || entry.message.length === 0) continue;
      if (!isErrorCode(code)) continue;

      const conflict = KNOWN_MESSAGE_CONFLICTS[code];
      if (conflict === undefined) {
        if (messageFor(code) !== entry.message) {
          mismatches.push(
            `${code}:\n    spec006:  ${JSON.stringify(entry.message)}\n    registry: ${JSON.stringify(messageFor(code))}`,
          );
        }
        continue;
      }

      if (!conflict.includes(messageFor(code))) {
        mismatches.push(`${code}: registry message ${JSON.stringify(messageFor(code))} is not one of the declared templates`);
      }
      if (!conflict.includes(entry.message)) {
        mismatches.push(`${code}: the spec message ${JSON.stringify(entry.message)} is not in the declared conflict list; the conflict changed shape`);
      }
    }
    assert.deepEqual(mismatches, [], `message template divergences:\n  ${mismatches.join('\n  ')}`);
  });

  test('a declared message conflict is genuinely two templates in the spec, not an excuse', () => {
    // A guard on the exemption. Two different situations are declared here and must not be
    // conflated:
    //
    //   * DEPENDENCY_UNAVAILABLE — SPEC-006 §6.2 ITSELF states two templates for one wire code.
    //     Both must be present in the spec.
    //   * SCHEMA_VALIDATION_FAILED — SPEC-003 §8.2 gives the code two STATUSES with "(syntax)" and
    //     "(semantic)" parentheticals, but SPEC-006 §6.2 states a template for only the syntactic
    //     one. The semantic template comes from the EP-004 plan and has NO specification source,
    //     recorded as a finding (EP-004 §12) rather than presented as a spec quote.
    for (const [code, templates] of Object.entries(KNOWN_MESSAGE_CONFLICTS)) {
      assert.ok(templates.length >= 2, `${code} declares a conflict with fewer than two templates`);
      assert.equal(new Set(templates).size, templates.length, `${code} declares duplicate templates`);

      const specText = SPEC_006.join('\n');
      const present = templates.filter((t) => specText.includes(t));
      if (code === 'DEPENDENCY_UNAVAILABLE') {
        assert.equal(
          present.length,
          templates.length,
          `${code}: both templates must be quoted from SPEC-006; found ${present.length}`,
        );
      } else {
        // For a code whose extra template has no spec source, assert the SPEC-SOURCED one is real
        // and that the registry carries it, so the untraceable text is never the chosen one.
        assert.ok(present.length >= 1, `${code}: at least one template must come from SPEC-006`);
        assert.equal(
          messageFor(code),
          templates[templates.length - 1],
          `${code}: the canonical template must be the one SPEC-006 states`,
        );
        assert.ok(
          present.includes(messageFor(code)),
          `${code}: the chosen canonical template must be the SPEC-006 one`,
        );
      }
    }
  });

  test('retryable mirrors the Rty column of SPEC-006 §5.3', () => {
    const specRetryable = spec006Retryable();
    assert.ok(specRetryable.size >= 4, `expected the §5.3 Rty column, saw ${specRetryable.size}`);

    // §5.3 keys its Rty column by DOMAIN code, so the comparison must be on domainCode. An earlier
    // version looked up the WIRE code and produced a false failure: IDEMPOTENCY_IN_FLIGHT's domain
    // class is IDEMPOTENCY_CONFLICT (row 10), which the spec does not mark Rty=Y.
    const wrong: string[] = [];
    for (const row of ERROR_CODE_REGISTRY) {
      if (!specRetryable.has(row.domainCode)) continue;
      if (!row.retryable) {
        wrong.push(`${row.wireCode} (domain ${row.domainCode}) is Rty=Y in §5.3 but not retryable`);
      }
    }
    assert.deepEqual(wrong, [], wrong.join('\n  '));

    // The converse: a DOMAIN class the spec does not mark Y must not be retryable here — with one
    // declared exception, below.
    const domainClasses = new Set(
      section(SPEC_006, /^### 5\.3 /, /^### 5\.4 /)
        .filter((l) => l.startsWith('|'))
        .map((l) => (l.split('|').map((x) => x.trim())[3] ?? '').replace(/`/g, ''))
        .filter((c) => /^[A-Z][A-Z0-9_]+$/.test(c)),
    );
    // §5.3 row 10 maps ONE class (`IDEMPOTENCY_CONFLICT`, Rty=N) to TWO wire codes:
    // `IDEMPOTENCY_KEY_REUSE` and `IDEMPOTENCY_IN_FLIGHT`. The class is not retryable because a
    // REUSED key must never be retried — that is how a duplicate external effect is submitted.
    // The IN-FLIGHT case is different: the first request has not finished, so retrying after a
    // delay is the correct client behaviour. The spec creates the distinction by naming both codes
    // under one class, so the exception is the spec's, not this test's.
    const RETRYABLE_EXCEPTIONS = new Set(['IDEMPOTENCY_IN_FLIGHT']);

    const overMarked: string[] = [];
    for (const row of ERROR_CODE_REGISTRY) {
      if (!domainClasses.has(row.domainCode)) continue; // not a §5.3 class
      if (specRetryable.has(row.domainCode)) continue;
      if (RETRYABLE_EXCEPTIONS.has(row.wireCode)) continue;
      if (row.retryable) {
        overMarked.push(`${row.wireCode} (domain ${row.domainCode}) is retryable but §5.3 says Rty=N`);
      }
    }
    assert.deepEqual(overMarked, [], overMarked.join('\n  '));

    // And the exception itself must stay narrow: the REUSE spelling of the same class is NOT
    // retryable, so a future edit cannot widen the exception to the whole class.
    assert.equal(
      ERROR_CODE_REGISTRY.find((r) => r.wireCode === 'IDEMPOTENCY_IN_FLIGHT')?.retryable,
      true,
    );
    assert.equal(
      ERROR_CODE_REGISTRY.find((r) => r.wireCode === 'IDEMPOTENCY_KEY_REUSE')?.retryable,
      false,
    );
  });

  test('the API-layer retryable codes are the ones SPEC-003 §8.2 implies', () => {
    // RATE_LIMITED (429) and IDEMPOTENCY_IN_FLIGHT (409, in flight) are API-layer codes with no
    // §5.3 domain class. They are retryable for a stated reason each, asserted here so the set
    // cannot grow silently.
    const retryableWireCodes = ERROR_CODE_REGISTRY.filter((r) => r.retryable)
      .map((r) => r.wireCode);
    const unique = [...new Set(retryableWireCodes)].sort();
    assert.deepEqual(
      unique,
      [
        'DEPENDENCY_UNAVAILABLE',        // 503 transient
        'IDEMPOTENCY_IN_FLIGHT',        // 409: the first request has not finished
        'OBSERVATION_WINDOW_NOT_MET',   // 422 but a legitimate retryable condition (SPEC-006 H-10)
        'RATE_LIMITED',                 // 429
      ],
      'the retryable set changed; each addition needs a stated reason',
    );
    // A non-retryable conflict must stay non-retryable: blind-retrying a reused idempotency key
    // is how a duplicate external effect is submitted.
    assert.equal(ERROR_CODE_REGISTRY.find((r) => r.wireCode === 'IDEMPOTENCY_KEY_REUSE')?.retryable, false);
    assert.equal(ERROR_CODE_REGISTRY.find((r) => r.wireCode === 'ILLEGAL_TRANSITION')?.retryable, false);
  });
});

describe('the registry is structurally sound', () => {
  test('wire codes are unique except where a status distinction is declared', () => {
    // indexRegistry throws on a duplicate with a differing status that is not declared, so a
    // successful call is the assertion. It is called eagerly too, so a defect fails at import.
    const index = indexRegistry();
    assert.ok(index.byWireCode.size > 60, `indexed ${index.byWireCode.size} wire codes`);

    const seen = new Map<string, Set<number>>();
    for (const row of ERROR_CODE_REGISTRY) {
      const set = seen.get(row.wireCode) ?? new Set<number>();
      set.add(row.status);
      seen.set(row.wireCode, set);
    }
    const multi = [...seen.entries()].filter(([, statuses]) => statuses.size > 1).map(([code]) => code).sort();
    assert.deepEqual(
      multi,
      Object.keys(WIRE_STATUS_AMBIGUITY).filter((c) => (WIRE_STATUS_AMBIGUITY[c]?.length ?? 0) > 1).sort(),
      'a wire code carries several statuses without being declared in WIRE_STATUS_AMBIGUITY',
    );
  });

  test('the declared multi-status codes really are multi-status in SPEC-003 §8.2', () => {
    for (const [code, statuses] of Object.entries(WIRE_STATUS_AMBIGUITY)) {
      if (statuses.length < 2) continue;
      const declared = spec003Statuses().get(code);
      assert.ok(declared !== undefined, `${code} must appear in §8.2`);
      for (const status of statuses) {
        assert.ok(
          declared.has(status),
          `${code} claims status ${status} but §8.2 does not list it there`,
        );
      }
    }
  });

  test('every code is SCREAMING_SNAKE_CASE', () => {
    for (const row of ERROR_CODE_REGISTRY) {
      assert.match(row.wireCode, /^[A-Z][A-Z0-9_]*$/, `${row.wireCode} is not SCREAMING_SNAKE_CASE`);
      assert.match(row.domainCode, /^[A-Z][A-Z0-9_]*$/, `${row.domainCode} is not SCREAMING_SNAKE_CASE`);
    }
  });

  test('no code or message carries an ad-hoc success or lifecycle token', () => {
    // SPEC-000 §5: a truth state is not a success flag, and `REMOVED` is not `OK`. A code named
    // SUCCESS would make a failure indistinguishable from a success at the contract level.
    const offences: string[] = [];
    for (const row of ERROR_CODE_REGISTRY) {
      const tokens = row.wireCode.split('_');
      for (const forbidden of FORBIDDEN_ADHOC_TOKENS) {
        // A token equal to the forbidden word (not a substring: DELETED is not REMOVED).
        if (tokens.includes(forbidden)) offences.push(`${row.wireCode} contains token ${forbidden}`);
      }
      // The message must not claim a success either.
      for (const forbidden of ['successfully', 'has been removed', 'was removed']) {
        if (row.message.toLowerCase().includes(forbidden)) {
          offences.push(`${row.wireCode} message claims success: ${row.message}`);
        }
      }
    }
    assert.deepEqual(offences, [], offences.join('\n  '));
  });

  test('every status is one SPEC-003 §8.2 declares', () => {
    const declared = new Set<number>();
    for (const statuses of spec003Statuses().values()) for (const s of statuses) declared.add(s);
    for (const row of ERROR_CODE_REGISTRY) {
      assert.ok(
        declared.has(row.status),
        `${row.wireCode} uses status ${row.status}, which §8.2 does not declare`,
      );
    }
  });

  test('the registry cannot be mutated at runtime', () => {
    assert.equal(Object.isFrozen(ERROR_CODE_REGISTRY), true);
    assert.throws(() => {
      (ERROR_CODE_REGISTRY as unknown as ErrorCodeSpec[]).push({
        domainCode: 'X', wireCode: 'X', status: 500, message: 'x', retryable: false,
      });
    }, 'the registry must be frozen so a runtime push cannot add a code');
  });

  test('an unknown code is refused rather than defaulted', () => {
    assert.equal(isErrorCode('NOT_A_CODE'), false);
    assert.throws(() => statusFor('NOT_A_CODE'), /unknown wire error code/);
    assert.throws(() => messageFor('NOT_A_CODE'), /unknown wire error code/);
    assert.throws(() => retryableFor('NOT_A_CODE'), /unknown wire error code/);
    assert.deepEqual(statusesFor('NOT_A_CODE'), []);
    // Prototype keys must not masquerade as codes.
    assert.equal(isErrorCode('__proto__'), false);
    assert.equal(isErrorCode('constructor'), false);
  });

  test('the domain-to-wire map keeps shared causes distinguishable in audit', () => {
    // DEPENDENCY_UNAVAILABLE is the wire spelling of four domain causes. The domain token is what
    // keeps them apart in audit and telemetry, which is the whole reason the two columns exist.
    const audited = wireCodeForDomain('AUDIT_UNAVAILABLE');
    assert.deepEqual([...audited], ['DEPENDENCY_UNAVAILABLE']);
    assert.deepEqual([...wireCodeForDomain('STORAGE_UNAVAILABLE')], ['DEPENDENCY_UNAVAILABLE']);
    assert.deepEqual([...wireCodeForDomain('EXTERNAL_TIMEOUT')], ['DEPENDENCY_UNAVAILABLE']);
    assert.deepEqual([...wireCodeForDomain('TENANT_SCOPE_VIOLATION')], ['RESOURCE_NOT_FOUND']);
    // A domain code with several wire spellings, e.g. DIGEST_MISMATCH.
    assert.equal(wireCodeForDomain('DIGEST_MISMATCH').length, 3);
  });
});
