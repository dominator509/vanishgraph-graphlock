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

const SPEC_DIR = join(import.meta.dirname, '..', '..', '.agent', 'specs');

function readSpec(name: string): string[] {
  return readFileSync(join(SPEC_DIR, name), 'utf8').split('\n');
}

const SPEC_LINES = readSpec('SPEC-003-api-contracts.md');

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

  test('every route the spec marks step-up really carries stepUp in the registry', () => {
    // STEP-UP IS A SECURITY CONTROL, so its absence is a vulnerability rather than an inconvenience.
    // SPEC-003 §3.2 item 7 enumerates the routes that require it, and SPEC-005 §6 lists the
    // operations ("Minting or expanding an AuthorityGrant", "Executing or authorising an external
    // write", "Changing tenant policy data, sources, or recipes", …).
    //
    // MEASURED DEFECT this catches: the registry was generated from each route's Scope LINE, and
    // §5.3.4/§5.3.7/§5.3.10 (source permission-class change, recipe creation, recipe enablement) have
    // Scope lines that omit "+ step-up" even though §3.2 item 7 names those exact route numbers and
    // SPEC-005 §6 requires it for "sources, or recipes". Three sources agreed and the line was
    // silent, so the routes were marked NOT step-up — a missing control on three write routes.
    // The enumeration in §3.2 item 7 is authoritative because it names route numbers.
    const enumerated: string[] = [];
    const sectionStart = SPEC_LINES.findIndex((l) => /^### 3\.2 /.test(l));
    assert.ok(sectionStart >= 0, 'SPEC-003 §3.2 was not found');
    for (const line of SPEC_LINES.slice(sectionStart, sectionStart + 120)) {
      // The step-up paragraph is one sentence spanning several lines; collect the route ids from it.
      if (!/Step-up is required for:/.test(line) && enumerated.length === 0 && !/5\.2\.1/.test(line)) continue;
      for (const m of line.matchAll(/\b(5\.\d+\.\d+)\b/g)) {
        if (m[1] !== undefined) enumerated.push(m[1]);
      }
      if (/^\s*$/.test(line) && enumerated.length > 0) break;
    }
    assert.ok(enumerated.length >= 6, `expected the §3.2 item 7 route list, saw ${String(enumerated.length)}`);

    const notEnforced: string[] = [];
    for (const id of new Set(enumerated)) {
      // §5.1.6/§5.1.8 appear as "5.1.6/5.1.8 `includeValue=true`": theirs is CONDITIONAL, so the
      // registry carries it under `conditional` rather than as an unconditional `stepUp`.
      const route = ROUTES.find((r) => r.id === id);
      assert.ok(route !== undefined, `${id} is named by §3.2 item 7 but absent from the registry`);
      const conditional = (route.conditional ?? []).some((c) => c.stepUp);
      if (!route.stepUp && !conditional) {
        notEnforced.push(`${id} (${route.method} ${route.path})`);
      }
    }
    assert.deepEqual(
      notEnforced,
      [],
      `routes the specification requires step-up for but the registry does not enforce:\n  ${notEnforced.join('\n  ')}`,
    );
  });
});
