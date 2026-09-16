/**
 * Browser privacy: the URL guard, the telemetry catalogue and the redaction rules (SPEC-004 §12 VG-UI-073…079/083).
 *
 * VG-UI-083 defines eight PII pattern classes "and nowhere else". This suite drives the URL builder with ONE FIXTURE PER
 * CLASS, asserts every class is refused with the right class id, and then asserts the fixture set itself covers all
 * eight — because a fixture set that has quietly lost a class is a suite that passes while the class is unchecked. That
 * self-test is the requirement's own oracle, and its required negative case is implemented at the bottom: with the alias
 * list unset, the personal-name fixture is NOT refused, which is what a pattern set missing case- and diacritic-folding
 * looks like.
 *
 * THE TWO SERVER-ENFORCED CLASSES ARE ASSERTED AS SUCH RATHER THAN FAKED. Classes (g) and (h) need the encrypted
 * identifier store and the recorded artefact content, and the plan's fallback is explicit that the store must never be
 * shipped to the browser to make a client check possible. So the suite asserts that the pattern set DECLARES those two
 * as `enforcedBy: 'server'`, that the client still refuses identifier-SHAPED values, and that the client's class list is
 * exactly the six it can honestly check.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  PII_PATTERN_CLASSES,
  PiiInUrlError,
  classify,
  classesByEnforcement,
  documentTitle,
  fold,
  historyState,
  path,
  query,
  ref,
  setSubjectAliases,
  url,
} from '../../ui/src/lib/url.ts';
import { TELEMETRY_EVENTS, TelemetryRefusedError, emit, scrub } from '../../ui/src/lib/telemetry.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const UI_SRC = join(PROJECT_ROOT, 'ui', 'src');

/** One valid example per class, keyed by the class id VG-UI-083 gives. */
const FIXTURES: Readonly<Record<string, string>> = {
  'a-email': 'data.subject@example.com',
  'b-telephone': '+14155550123',
  'c-government-id': '123-45-6789',
  'd-postal': '742 Evergreen Terrace',
  'e-personal-name': 'Zoë Ångström',
  'f-date-of-birth': '1980-03-03',
  'g-identifier': '8f14e45f-ceea-467a-9a3f-1c2b3d4e5f60',
  'h-evidence-content': 'ARTEFACT-CONTENT-EXCERPT',
};

// The alias list the personal-name class checks against. Set before the fixtures are driven, because a folded alias is
// what makes the class meaningful.
setSubjectAliases(['Zoe Angstrom', 'Zoë Ångström']);

describe('every PII class is refused, and the fixture set covers all eight (VG-UI-083)', () => {
  test('the pattern set declares exactly the eight classes, each with an enforcement point', () => {
    const ids = PII_PATTERN_CLASSES.map((entry) => entry.id);
    assert.deepEqual(ids, [
      'a-email',
      'b-telephone',
      'c-government-id',
      'd-postal',
      'e-personal-name',
      'f-date-of-birth',
      'g-identifier',
      'h-evidence-content',
    ]);
    const enforcement = classesByEnforcement();
    assert.equal(enforcement.browser.length, 6, `browser-enforced classes: ${enforcement.browser.join(', ')}`);
    assert.deepEqual(enforcement.server, ['g-identifier', 'h-evidence-content']);
  });

  test('the fixture set has one example for every declared class, and no example without a class', () => {
    const declared = PII_PATTERN_CLASSES.map((entry) => entry.id).sort();
    const covered = Object.keys(FIXTURES).sort();
    assert.deepEqual(covered, declared, 'the fixture set and the pattern set must cover the same classes');
  });

  test('each BROWSER-enforced class refuses its own fixture, and names the class that matched', () => {
    for (const entry of PII_PATTERN_CLASSES.filter((candidate) => candidate.enforcedBy === 'browser')) {
      const fixture = FIXTURES[entry.id] ?? '';
      assert.ok(fixture.length > 0, `${entry.id} has no fixture`);
      assert.equal(classify(fixture), entry.id, `${entry.id}: the fixture must classify as its own class`);
      assert.throws(
        () => url('/portal/exposures', { reference: fixture }),
        (error: unknown) => {
          assert.ok(error instanceof PiiInUrlError, `${entry.id}: expected a PiiInUrlError, got ${String(error)}`);
          assert.equal(error.patternClass, entry.id);
          return true;
        },
        `${entry.id} must be refused`,
      );
    }
  });

  test('the two SERVER-enforced classes are declared as such, never faked as client checks', () => {
    // VG-UI-083's own required negative case is a pattern set that "scans only plaintext instead of digest-comparing
    // Identifier values". The honest answer is the plan's fallback: the client CANNOT digest-compare without the
    // encrypted store, so it declares that class server-enforced and refuses the shape it can see. Asserting that
    // declaration is what stops a later change from quietly claiming a check the browser never performed.
    const server = PII_PATTERN_CLASSES.filter((entry) => entry.enforcedBy === 'server').map((entry) => entry.id);
    assert.deepEqual(server, ['g-identifier', 'h-evidence-content']);
    // The client refuses an identifier-SHAPED value where no reference belongs, and permits a declared one.
    assert.equal(classify(FIXTURES['g-identifier'] ?? ''), 'g-identifier');
    assert.throws(() => query({ subject: FIXTURES['g-identifier'] ?? '' }), /matches PII pattern class g-identifier/);
    assert.equal(query({ cursor: ref(FIXTURES['g-identifier'] ?? '') }).includes('8f14e45f'), true, 'a declared reference is permitted');
    // And the artefact-content class has no client test at all: the flag is the record, and it says so.
    const evidence = PII_PATTERN_CLASSES.find((entry) => entry.id === 'h-evidence-content');
    assert.equal(evidence?.test(FIXTURES['h-evidence-content'] ?? ''), false);
  });

  test('a bare identifier in a query is refused, while a route segment may be one', () => {
    // THE CONFLICT THIS RESOLVES, MEASURED: refusing class (g) everywhere made `/console/cases/<uuid>` unbuildable — a
    // case identifier is a UUID and so is a keyset cursor. A path segment IS the route's identifier, so it is permitted;
    // a query value must be declared as an opaque reference, and anything else identifier-shaped is refused.
    assert.equal(path('console', 'cases', '11111111-2222-3333-4444-555555555555'), '/console/cases/11111111-2222-3333-4444-555555555555');
    assert.throws(() => query({ caseId: '11111111-2222-3333-4444-555555555555' }), PiiInUrlError);
    assert.equal(query({ caseId: ref('11111111-2222-3333-4444-555555555555') }), '?caseId=11111111-2222-3333-4444-555555555555');
  });

  test('every surface the builder owns is guarded: path segment, query value, history.state and title', () => {
    const email = FIXTURES['a-email'] ?? '';
    assert.throws(() => path('portal', email), PiiInUrlError);
    assert.throws(() => query({ email }), PiiInUrlError);
    assert.throws(() => historyState({ subject: email }), PiiInUrlError);
    assert.throws(() => documentTitle(`Case for ${email}`), PiiInUrlError);
    // And a legitimate value still builds, so the guard is not simply refusing everything.
    assert.equal(url('/portal/exposures', { limit: 25 }), '/portal/exposures?limit=25');
    assert.equal(path('console', 'cases', '11111111-2222-3333-4444-555555555555'), '/console/cases/11111111-2222-3333-4444-555555555555');
    assert.equal(historyState({ routeName: 'console' })['routeName'], 'console');
  });

  test('a segment carrying a path delimiter is refused, because it would change the route', () => {
    assert.throws(() => path('console', 'cases/../admin'), /contains a path delimiter/);
  });

  test('the fold is what makes the alias class work, and the class is absent without aliases', () => {
    // The positive direction, with aliases set.
    assert.equal(classify('Zoe Angstrom'), 'e-personal-name');
    assert.equal(classify('ZOË ÅNGSTRÖM'), 'e-personal-name');
    // NEGATIVE CASE, in the shape the requirement names: empty the alias list and the SAME fixture stops being refused —
    // which is exactly what a pattern set without case- and diacritic-folding would do. The list is restored immediately.
    setSubjectAliases([]);
    assert.equal(classify(FIXTURES['e-personal-name'] ?? ''), null, 'without aliases the name class cannot match');
    setSubjectAliases(['Zoe Angstrom', 'Zoë Ångström']);
    assert.equal(classify(FIXTURES['e-personal-name'] ?? ''), 'e-personal-name');
    assert.equal(fold('Zoë  ÅNGSTRÖM'), 'zoe angstrom');
  });
});

describe('the URL builder is the only place a path or query is constructed', () => {
  test('no other UI module builds a path or query string by concatenation', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        if (full.endsWith(join('lib', 'url.ts'))) continue;
        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        // A template literal or concatenation that produces a query string, or a `?`-bearing literal built from a value.
        for (const pattern of [/`[^`]*\?\$\{/, /['"]\?['"]\s*\+/, /\+\s*['"]\?['"]/, /searchParams\.set\(/, /new URLSearchParams\(/]) {
          if (pattern.test(code)) offenders.push(`${full.replace(`${PROJECT_ROOT}\\`, '')}: ${String(pattern)}`);
        }
      }
    };
    walk(UI_SRC);
    assert.deepEqual(offenders, [], `a UI module builds its own query string: ${offenders.join('; ')}`);
  });

  test('the CSP forbids third-party script, eval and cross-origin form posts (VG-UI-076)', () => {
    const html = readFileSync(join(PROJECT_ROOT, 'ui', 'index.html'), 'utf8');
    const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html.replace(/\s+/g, ' '))?.[1] ?? '';
    assert.ok(policy.length > 0, 'index.html must carry a CSP meta element');
    assert.match(policy, /script-src 'self'/);
    assert.match(policy, /form-action 'self'/);
    assert.equal(policy.includes('unsafe-eval'), false, 'the policy must not allow eval');
    assert.equal(/https?:\/\//.test(policy), false, `the policy must name no third-party origin: ${policy}`);
    assert.equal(policy.includes('*'), false, 'the policy must contain no wildcard');
    // The one relaxation is named rather than hidden, and it is style-only.
    assert.match(policy, /style-src 'self' 'unsafe-inline'/);
  });
});

describe('telemetry is a closed catalogue with a DLP class per parameter (VG-UI-075)', () => {
  test('an event not in the catalogue is refused', () => {
    assert.throws(() => emit('subject.viewed', { routeName: 'portal' }), TelemetryRefusedError);
  });

  test('an undeclared parameter is refused and a missing declared parameter is refused', () => {
    assert.throws(() => emit('route.viewed', { routeName: 'portal', regionState: 'ready', subjectEmail: 'x@y.zz' }), /does not declare a parameter/);
    assert.throws(() => emit('route.viewed', { routeName: 'portal' }), /missing its declared parameter/);
  });

  test('a value that matches a PII class is refused even in an enum parameter', () => {
    assert.throws(() => emit('route.viewed', { routeName: FIXTURES['a-email'] ?? '', regionState: 'ready' }), /matches PII pattern class/);
  });

  test('each egress class validates its own shape', () => {
    assert.equal(scrub('count', '12', 'n'), '12');
    assert.throws(() => scrub('count', 'twelve', 'n'), /not a whole number/);
    assert.equal(scrub('duration-ms', '42.5', 'n'), '42.5');
    assert.throws(() => scrub('duration-ms', 'fast', 'n'), /not a number/);
    assert.equal(scrub('enum', 'ready', 'n'), 'ready');
    assert.throws(() => scrub('enum', 'almost-ready', 'n'), /not an allowlisted value/);
    assert.equal(scrub('opaque-id', 'actor_OPAQUE9', 'n'), 'actor_OPAQUE9');
    assert.throws(() => scrub('opaque-id', 'Jane Doe', 'n'), /not an opaque token/);
  });

  test('a validated emission carries only the declared parameters', () => {
    const record = emit('coverage.viewed', { sourcesAttempted: 12, sourcesTotal: 30 });
    assert.deepEqual(record, { name: 'coverage.viewed', parameters: { sourcesAttempted: '12', sourcesTotal: '30' } });
    assert.equal(TELEMETRY_EVENTS.length >= 5, true);
  });
});

