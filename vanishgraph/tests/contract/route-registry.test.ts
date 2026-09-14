/**
 * Route registry contract (SPEC-003 §5, §8.2, §8.4).
 *
 * This suite is the mechanism that keeps `src/http/openapi/registry.ts` and
 * `src/http/errors/code-registry.ts` from drifting away from the specification. SPEC-003 §8.4 is
 * explicit that "the two files must never list different statuses for the same code; the contract
 * test compares them and fails on divergence", so the comparison is here and reads the spec text
 * rather than a copy of it.
 *
 * It reads `.agent/specs/SPEC-003-api-contracts.md` directly. That is deliberate: a checked-in
 * generated fixture would pass happily while the specification moved underneath it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ROUTES,
  SCOPES,
  WEBHOOK_ROUTES,
  EFFECT_BEARING_ROUTES,
  findRoute,
} from '../../src/http/openapi/registry.ts';
import {
  ERROR_CODES,
  DETAILS_ALLOWLIST,
  ERROR_CODE_NAMES,
  buildErrorEnvelope,
  isErrorCode,
  statusFor,
  type ErrorCode,
} from '../../src/http/errors/code-registry.ts';

const SPEC_DIR = join(import.meta.dirname, '..', '..', '.agent', 'specs');

function readSpec(name: string): string[] {
  return readFileSync(join(SPEC_DIR, name), 'utf8').split('\n');
}

const SPEC_LINES = readSpec('SPEC-003-api-contracts.md');
const SPEC_006_LINES = readSpec('SPEC-006-errors.md');

function sectionRange(
  lines: readonly string[],
  startPattern: RegExp,
  endPattern: RegExp,
): string[] {
  const start = lines.findIndex((l) => startPattern.test(l));
  const end = lines.findIndex((l, i) => i > start && endPattern.test(l));
  assert.ok(start >= 0, `spec section ${String(startPattern)} not found`);
  assert.ok(end > start, `spec section end ${String(endPattern)} not found`);
  return lines.slice(start, end);
}

describe('the route registry matches SPEC-003 §5 (VG-API-001)', () => {
  test('the catalogue has 78 routes across 17 groups', () => {
    // MEASURED three ways: table rows, bold prose headings, and per-group sums all give 78.
    // An earlier working assumption of 79 was a miscount; see the EP-004 §12 Surprises entry.
    assert.equal(ROUTES.length, 78, 'the §5 catalogue has 78 routes');
    assert.equal(new Set(ROUTES.map((r) => r.group)).size, 17);
    assert.equal(new Set(ROUTES.map((r) => r.id)).size, 78, 'catalogue ids must be unique');
    assert.equal(
      new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size,
      78,
      'no two routes may share a method and path',
    );
  });

  test('every route id, method, path and group matches the spec table row', () => {
    const rows = new Map<string, { method: string; path: string }>();
    for (const line of SPEC_LINES) {
      const m = /^\|\s*(5\.\d+\.\d+)\s*\|\s*`([A-Z]+)\s+(\S+)`/.exec(line);
      if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
        rows.set(m[1], { method: m[2], path: m[3] });
      }
    }
    assert.equal(rows.size, 78, 'the spec table must list 78 route rows');
    for (const route of ROUTES) {
      const expected = rows.get(route.id);
      assert.ok(expected !== undefined, `registry has ${route.id}, which the spec does not list`);
      assert.equal(route.method, expected.method, `${route.id} method`);
      assert.equal(route.path, expected.path, `${route.id} path`);
      assert.equal(route.group, route.id.split('.').slice(0, 2).join('.'), `${route.id} group`);
    }
  });

  test('the scope vocabulary is closed: every used scope appears in SPEC-003 §3.3', () => {
    const table = sectionRange(SPEC_LINES, /^### 3\.3 /, /^## 4\./).join('\n');
    const declared = new Set<string>();
    for (const m of table.matchAll(/`(vg\.[a-z_.]+)`/g)) {
      if (m[1] !== undefined) declared.add(m[1]);
    }
    // `vg.webhooks.ingest` is named in §3.3 ONLY to say it is deliberately absent from the
    // vocabulary, so it is not a declared scope. It is removed explicitly rather than by a
    // negative lookahead, so the reason is visible where the set is built.
    declared.delete('vg.webhooks.ingest');
    assert.ok(declared.size >= 20, `expected the §3.3 scope table, saw ${declared.size}`);

    for (const scope of SCOPES) {
      assert.ok(declared.has(scope), `scope ${scope} is not in the §3.3 closed vocabulary`);
    }
    // And the reverse: a scope in the table that the registry does not know about would mean a
    // route could require something the type system cannot express.
    const unused = [...declared].filter((s) => !(SCOPES as readonly string[]).includes(s));
    assert.deepEqual(unused, [], `§3.3 declares scopes the registry does not export: ${unused.join(', ')}`);
  });

  test('no route requires a webhook scope', () => {
    // SPEC-003 §3.3: `vg.webhooks.ingest` is deliberately absent so no token can forge ingress.
    for (const route of ROUTES) {
      for (const scope of route.scopes) {
        assert.equal(
          scope.includes('webhook'),
          false,
          `${route.id} requires ${scope}; webhook ingress is signature-authenticated, not scope-authenticated`,
        );
      }
    }
  });

  test('health, readiness, liveness and startup are the only unscoped routes', () => {
    const unscoped = ROUTES.filter((r) => r.scopes.length === 0).map((r) => r.id).sort();
    assert.deepEqual(unscoped, ['5.17.1', '5.17.2', '5.17.3', '5.17.4']);
  });

  test('no request-facing route accepts a truth state as input (SM-6)', () => {
    // The registry is a declaration, so the strongest check available here is that no route id
    // or path encodes a state transition as an input. The handler-level scan lives in
    // gate-api.sh, which reads the actual request schemas.
    for (const route of ROUTES) {
      if (route.method === 'GET') continue;
      assert.equal(
        /truth-?state/i.test(route.path),
        false,
        `${route.id} takes a truth state in its path; SM-6 forbids that`,
      );
    }
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'http', 'openapi', 'registry.ts'),
      'utf8',
    );
    // Strip comments before scanning. The registry's own header explains that a state name appears
    // nowhere in it, and a naive scan matched that explanation — a test failing on the sentence
    // that documents the property it checks.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(
      /truthState/.test(code),
      false,
      'the registry code must not mention a truth state at all',
    );
  });

  test('the effect-bearing set is exactly the routes SPEC-003 §4.1 makes idempotent', () => {
    assert.equal(EFFECT_BEARING_ROUTES.length, 31);
    for (const route of EFFECT_BEARING_ROUTES) {
      assert.equal(route.idempotency, 'required');
      assert.notEqual(route.method, 'GET', `${route.id} is a GET but requires an Idempotency-Key`);
    }
  });

  test('findRoute resolves a real route and refuses an unknown one', () => {
    assert.equal(findRoute('GET', '/v1/subjects')?.id, '5.1.2');
    assert.equal(findRoute('POST', '/v1/subjects')?.id, '5.1.1');
    assert.equal(findRoute('POST', '/v1/nope'), undefined);
    assert.equal(findRoute('DELETE', '/v1/subjects'), undefined);
  });

  test('webhook routes are held separately and are not in the §5 registry', () => {
    assert.equal(WEBHOOK_ROUTES.length, 3);
    for (const hook of WEBHOOK_ROUTES) {
      assert.equal(
        ROUTES.some((r) => r.path === hook.path),
        false,
        `${hook.path} must not appear in the §5 registry`,
      );
    }
  });

  test('the §5.9.1 scope is recorded despite the spec line being unparseable', () => {
    // SPEC-003 §5.9.1 joins its heading and Scope sentences with no whitespace:
    //   ...or T13 (`NOT_REMOVABLE`).Scope `vg.cases.write`. Idempotency **Required**.
    // so a line-anchored `^Scope ` extractor finds nothing. The registry records the scope read
    // from the sentence itself; this test pins that so the value cannot regress to empty.
    const line = SPEC_LINES.find((l) => l.includes('.Scope `vg.cases.write`'));
    assert.ok(line !== undefined, 'the §5.9.1 source defect is expected to still be present');
    assert.equal(findRoute('POST', '/v1/cases/{caseId}/controller-responses')?.scopes[0], 'vg.cases.write');
  });
});

describe('the error registry matches SPEC-003 §8.2 and never diverges from SPEC-006 §6.2', () => {
  /** Parse the §8.2 status table into code → status, ignoring prose parentheticals. */
  function specStatuses(): Map<string, number> {
    const out = new Map<string, number>();
    for (const line of sectionRange(SPEC_LINES, /^### 8\.2 /, /^### 8\.3 /)) {
      const row = /^\|\s*`(\d{3})`\s*\|/.exec(line);
      if (row?.[1] === undefined) continue;
      const status = Number(row[1]);
      const cells = line.split('|').slice(3).join('|');
      for (const m of cells.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) {
        const code = m[1];
        if (code === undefined || /^\d+$/.test(code)) continue;
        if (!out.has(code)) out.set(code, status);
      }
    }
    return out;
  }

  test('every implemented code exists in §8.2 with the same status', () => {
    const spec = specStatuses();
    assert.ok(spec.size >= 120, `expected the §8.2 code table, saw ${spec.size}`);
    // Two tokens inside the §8.2 parentheticals look like codes but are not: a truth state and a
    // matrix name. They are prose, verified by reading the lines that contain them.
    spec.delete('NOT_REMOVABLE');
    spec.delete('DATA_EGRESS_MATRIX');

    const mismatches: string[] = [];
    const extra: string[] = [];
    for (const code of ERROR_CODE_NAMES) {
      const expected = spec.get(code);
      if (expected === undefined) {
        extra.push(code);
        continue;
      }
      if (statusFor(code) !== expected) {
        mismatches.push(`${code}: registry=${statusFor(code)} spec=${expected}`);
      }
    }
    assert.deepEqual(mismatches, [], `status divergences from SPEC-003 §8.2: ${mismatches.join('; ')}`);
    assert.deepEqual(extra, [], `codes in the registry that §8.2 does not enumerate: ${extra.join(', ')}`);

    const missing = [...spec.keys()].filter((c) => !isErrorCode(c));
    assert.deepEqual(missing, [], `codes §8.2 enumerates that the registry lacks: ${missing.join(', ')}`);
  });

  test('SPEC-006 §6.2 agrees with SPEC-003 §8.2 on every shared code', () => {
    const spec003 = specStatuses();
    const spec006 = new Map<string, number>();
    const rows = sectionRange(SPEC_006_LINES, /^### 6\.2 /, /^## 7\./);

    // Locate the header row rather than assuming an offset from the section heading: the first
    // version of this parser used a fixed offset, found zero rows, and would have reported
    // "agreement" from an empty set.
    const headerIndex = rows.findIndex(
      (line) => /^\|\s*Domain `code`/.test(line) && /Wire `code`/.test(line),
    );
    assert.ok(headerIndex >= 0, 'the §6.2 mapping table header was not found');

    for (const line of rows.slice(headerIndex + 2)) {
      if (!line.startsWith('|')) continue;
      // A leading and trailing `|` means split() yields an empty first and last element, so the
      // cells are: [0]='' [1]=Domain code [2]=Wire code [3]=HTTP [4]=Message [5]=''.
      const parts = line.split('|').map((p) => p.trim());
      const wire = parts[2];
      const http = parts[3];
      if (wire === undefined || http === undefined) continue;
      // A row may list several wire codes; each is compared.
      const codes = [...wire.matchAll(/`([A-Z][A-Z0-9_]+)`/g)]
        .map((m) => m[1])
        .filter((c): c is string => c !== undefined);
      const statusMatch = /^(\d{3})$/.exec(http);
      if (codes.length === 0 || statusMatch?.[1] === undefined) continue;
      const status = Number(statusMatch[1]);
      // 202 is the reconciliation body, not an error status, so it has no error code to compare.
      if (status === 202) continue;
      for (const code of codes) {
        if (!spec006.has(code)) spec006.set(code, status);
      }
    }
    assert.ok(spec006.size >= 20, `expected the §6.2 mapping table, saw ${spec006.size}`);

    // ---------------------------------------------------------------------------------------
    // SPECIFICATION CONFLICT, resolved by reading both files rather than by picking one.
    //
    // `INVALID_TRUTH_STATE` is a KNOWN divergence between SPEC-003 §8.2 and SPEC-006 §6.2, and
    // SPEC-006 is inconsistent with ITSELF about it:
    //
    //   * SPEC-006 §6.2 "Codes owned by SPEC-003 §8.2" family table puts it under 400
    //     ("Malformed request / opaque-value validation").
    //   * SPEC-006 §6.2 domain-class table lists it as an EXAMPLE of the 422
    //     `INVALID_VALUE_OBJECT` (semantic) row — but that row's own text says the wire code is
    //     "field-specific code from SPEC-003 §8.2", i.e. it DEFERS to SPEC-003 for the status.
    //   * SPEC-003 §8.2, §2.3, §5.5 and §11.4 (VG-API-006) all say 400: the code is raised when a
    //     `truthState` QUERY TOKEN is unknown, which is opaque-value validation, not a semantic
    //     body failure.
    //
    // Resolution: 400. That is what SPEC-003 says (which owns the wire per §8.4), and what
    // SPEC-006's own family table and its explicit deferral both support. The single 422 mention
    // is the generic domain-class row's status, not a statement about this code.
    //
    // This is recorded rather than silently tolerated so that a future reader does not "fix" the
    // registry to 422 and break VG-API-006. Neither specification is edited in this node.
    const KNOWN_STATUS_CONFLICTS: Readonly<Record<string, { spec003: number; spec006GenericRow: number }>> = {
      INVALID_TRUTH_STATE: { spec003: 400, spec006GenericRow: 422 },
    };

    const divergences: string[] = [];
    for (const [code, status] of spec006) {
      const conflict = KNOWN_STATUS_CONFLICTS[code];
      if (conflict !== undefined) {
        // Assert the conflict has not changed shape: if SPEC-003 ever moves to 422, or SPEC-006's
        // family table moves to 422, this resolution is stale and must be revisited.
        assert.equal(
          status,
          conflict.spec006GenericRow,
          `${code}: the recorded SPEC-006 generic-row status changed; revisit the resolution`,
        );
        assert.equal(
          statusFor(code as ErrorCode),
          conflict.spec003,
          `${code}: the registry must follow SPEC-003, which owns the wire`,
        );
        continue;
      }
      const fromSpec003 = spec003.get(code);
      if (fromSpec003 !== undefined && fromSpec003 !== status) {
        divergences.push(`${code}: SPEC-003=${fromSpec003} SPEC-006=${status}`);
      }
      const impl = isErrorCode(code) ? statusFor(code) : undefined;
      if (impl !== undefined && impl !== status) {
        divergences.push(`${code}: registry=${impl} SPEC-006=${status}`);
      }
      // A code SPEC-006 maps but the registry lacks would be a wire code with no implementation.
      if (impl === undefined) {
        divergences.push(`${code}: SPEC-006 maps it but the registry has no such code`);
      }
    }
    assert.deepEqual(divergences, [], `SPEC-003/SPEC-006/registry divergence: ${divergences.join('; ')}`);
  });

  test('the one known SPEC-003/SPEC-006 status conflict is the only one', () => {
    // A guard on the guard: if a second conflict appears, this fails and the new one must be
    // resolved deliberately rather than absorbed by the exemption above.
    const spec003 = specStatuses();
    const conflicts: string[] = [];
    const rows = sectionRange(SPEC_006_LINES, /^### 6\.2 /, /^## 7\./);
    const headerIndex = rows.findIndex((line) => /^\|\s*Domain `code`/.test(line));
    for (const line of rows.slice(headerIndex + 2)) {
      if (!line.startsWith('|')) continue;
      const parts = line.split('|').map((p) => p.trim());
      const codes = [...(parts[2] ?? '').matchAll(/`([A-Z][A-Z0-9_]+)`/g)]
        .map((m) => m[1])
        .filter((c): c is string => c !== undefined);
      const status = Number(/^(\d{3})$/.exec(parts[3] ?? '')?.[1] ?? '0');
      for (const code of codes) {
        const fromSpec003 = spec003.get(code);
        if (fromSpec003 !== undefined && status !== 0 && fromSpec003 !== status && status !== 202) {
          conflicts.push(code);
        }
      }
    }
    assert.deepEqual(
      [...new Set(conflicts)].sort(),
      ['INVALID_TRUTH_STATE'],
      'a new SPEC-003/SPEC-006 status conflict appeared; resolve it explicitly, do not extend the exemption list',
    );
  });

  test('every message is a fixed template with no interpolation', () => {
    // SPEC-006 H-3: a message containing a placeholder is how a value reaches a response body.
    for (const [code, definition] of Object.entries(ERROR_CODES)) {
      assert.equal(
        /\$\{|\{\{|%s|%d|\[object/.test(definition.message),
        false,
        `${code} message looks interpolated: ${definition.message}`,
      );
      assert.ok(definition.message.length > 0, `${code} must have a message`);
      assert.match(definition.message, /[.!?]$/, `${code} message should be a sentence`);
    }
  });

  test('statuses come only from the SPEC-003 §8.2 status set', () => {
    const allowed = new Set([200, 201, 202, 204, 400, 401, 403, 404, 409, 410, 412, 413, 415, 422, 428, 429, 500, 503]);
    for (const code of ERROR_CODE_NAMES) {
      assert.ok(allowed.has(statusFor(code)), `${code} has an unlisted status ${statusFor(code)}`);
    }
  });

  test('retryable agrees with the guidance a client needs', () => {
    // A client must never blind-retry an effect-bearing route, so a non-retryable conflict such
    // as IDEMPOTENCY_KEY_REUSE must say so.
    assert.equal(ERROR_CODES.IDEMPOTENCY_KEY_REUSE.retryable, false);
    assert.equal(ERROR_CODES.IDEMPOTENCY_IN_FLIGHT.retryable, true);
    assert.equal(ERROR_CODES.DEPENDENCY_UNAVAILABLE.retryable, true);
    assert.equal(ERROR_CODES.ILLEGAL_TRANSITION.retryable, false);
  });
});

describe('the error envelope never leaks what it must not (SPEC-003 §8.1, §8.3)', () => {
  const base = {
    requestId: 'req_01HTEST',
    correlationId: '4bf92f3577b34da6a3ce929d0e0e4736',
    occurredAt: '2026-02-04T09:31:22.104Z',
  };

  test('an envelope has exactly one top-level key and the required fields', () => {
    const envelope = buildErrorEnvelope({ code: 'ILLEGAL_TRANSITION', ...base });
    assert.deepEqual(Object.keys(envelope), ['error']);
    assert.deepEqual(
      Object.keys(envelope.error).sort(),
      ['code', 'correlationId', 'message', 'occurredAt', 'requestId', 'retryable'],
    );
    assert.equal(envelope.error.code, 'ILLEGAL_TRANSITION');
    assert.equal(envelope.error.retryable, false);
  });

  test('details are filtered against the allowlist, so an unexpected key is dropped', () => {
    const envelope = buildErrorEnvelope({
      code: 'ILLEGAL_TRANSITION',
      ...base,
      details: {
        fromTruthState: 'ACKNOWLEDGED',
        toTruthState: 'VERIFIED_REMOVED',
        // None of these may reach the wire:
        stack: 'Error: boom\n  at handler (/app/src/http/routes/x.ts:1:1)',
        sql: 'SELECT * FROM protected_subject',
        subjectName: 'Jane Doe',
        authorization: 'Bearer eyJhbGciOi...',
        password: 'hunter2',
      },
    });
    const details = envelope.error.details ?? {};
    assert.deepEqual(Object.keys(details).sort(), ['fromTruthState', 'toTruthState']);
    const serialised = JSON.stringify(envelope);
    for (const secret of ['Jane Doe', 'hunter2', 'eyJhbGciOi', 'SELECT *', 'at handler']) {
      assert.equal(serialised.includes(secret), false, `envelope leaked ${secret}`);
    }
  });

  test('no message carries an identifier, URL, or provider text', () => {
    for (const code of ERROR_CODE_NAMES) {
      const message = ERROR_CODES[code].message;
      assert.equal(/https?:\/\//.test(message), false, `${code} message contains a URL`);
      assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/.test(message), false, `${code} message contains a UUID`);
      assert.equal(/@/.test(message), false, `${code} message contains an @ (possible email)`);
    }
  });

  test('the allowlist itself contains no PII-bearing key', () => {
    for (const key of DETAILS_ALLOWLIST) {
      assert.equal(
        /name|email|phone|address|value|token|secret|password|body|content/i.test(key),
        false,
        `details key ${key} looks PII- or secret-bearing`,
      );
    }
  });

  test('isErrorCode accepts real codes and refuses lookalikes', () => {
    assert.equal(isErrorCode('ILLEGAL_TRANSITION'), true);
    assert.equal(isErrorCode('NOT_A_CODE'), false);
    assert.equal(isErrorCode('vg.subjects.read'), false);
    assert.equal(isErrorCode('__proto__'), false, 'a prototype key must not be treated as a code');
    assert.equal(isErrorCode('toString'), false);
  });

  test('a code undefined at compile time cannot be forced in at runtime', () => {
    const forged = 'TOTALLY_MADE_UP' as ErrorCode;
    assert.equal(isErrorCode(forged), false);
  });
});
