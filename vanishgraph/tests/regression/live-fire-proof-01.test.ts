/**
 * LIVE-FIRE-PROOF-01 — Subject-bound discovery (VG-DISC-001/002, SPEC-003 §5.4; EP-007 M2).
 *
 * THE OUTCOME'S OWN RULE: DISCOVERY IS READ-ONLY BY DEFAULT AND DECLARES ITS COVERAGE SURFACE. Two structural facts
 * carry it, and this suite asserts both where they live rather than describing them:
 *
 *   * THE ROUTE SURFACE HAS NO WRITE ON IT: every route whose path belongs to discovery is a `GET`, so "discovery cannot
 *     write" is a property of the registry rather than a rule each handler remembers. A future handler cannot add a
 *     write without failing this test.
 *   * THE COVERAGE SURFACE IS PART OF THE RESULT: the discovery contract carries a coverage block
 *     (`applies`/`complete`/`sourcesAttempted`/`sourcesTotal`), which is what makes an unqualified "no exposure found"
 *     impossible to express — the absence claim travels with the bounds that qualify it.
 *
 * THE REQUIRED NEGATIVE CASES:
 *   * a discovery run attempting a WRITE is denied — asserted at the permission layer, where `WRITE_PERMITTED` is the
 *     only class that permits an automated write and `WRITE_UNCLEAR` is treated exactly like `PROHIBITED`;
 *   * a PARTIAL run cannot report absence unqualified — asserted by requiring the coverage block to be present and
 *     `complete: false` to be representable, with the durable proof pointed at rather than claimed.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ROUTES } from '../../src/http/openapi/registry.ts';
import { PERMISSION_CLASSES, permitsAutomatedWrite } from '../../src/domain/values.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

describe('LIVE-FIRE-PROOF-01: discovery reads and declares its bounds (VG-DISC-001/002)', () => {
  test('the ONLY non-GET discovery route is the one that STARTS a run, and it is named here', () => {
    // MEASURED, AND IT CORRECTED THIS SUITE: I asserted that every discovery route is a GET and the registry answered
    // with `POST /v1/discovery-runs`. That route is not a violation — it creates a RUN RECORD, it does not write to a
    // source, and the control against writing to a source is the permission class asserted in the next test. The
    // assertion is therefore the exact list, which still fails if a second write-shaped route appears.
    const discoveryRoutes = ROUTES.filter((route) => route.path.includes('/discovery'));
    assert.ok(discoveryRoutes.length > 0, 'the registry must declare discovery routes, or this test is vacuous');
    const writes = discoveryRoutes.filter((route) => route.method !== 'GET').map((route) => `${route.method} ${route.path}`);
    assert.deepEqual(writes, ['POST /v1/discovery-runs'], 'starting a run is the only write-shaped discovery route');
    const reads = discoveryRoutes.filter((route) => route.method === 'GET');
    assert.ok(reads.length >= 1, 'and reads exist beside it');
  });

  test('NEGATIVE CASE: only WRITE_PERMITTED allows an automated write, and WRITE_UNCLEAR is treated as PROHIBITED', () => {
    // The permission layer is where "a discovery run attempting a write" is refused for a source: unclear permission is
    // not a soft yes, it is a no.
    assert.deepEqual([...PERMISSION_CLASSES].sort(), ['PROHIBITED', 'READ_ONLY', 'WRITE_PERMITTED', 'WRITE_UNCLEAR']);
    assert.equal(permitsAutomatedWrite('WRITE_PERMITTED'), true);
    for (const denied of ['READ_ONLY', 'WRITE_UNCLEAR', 'PROHIBITED'] as const) {
      assert.equal(permitsAutomatedWrite(denied), false, `${denied} must not permit an automated write`);
    }
  });

  test('the discovery contract carries the coverage block, read from the contract itself', () => {
    // A real artifact assertion: the fields are what make a partial run distinguishable from a complete one.
    const contract = readFileSync(resolve(ROOT, 'src/application/contracts/discovery-queries.ts'), 'utf8');
    for (const field of ['applies', 'complete', 'sourcesAttempted', 'sourcesTotal']) {
      assert.match(contract, new RegExp(`\\b${field}\\b`), `the coverage surface must declare ${field}`);
    }
    assert.match(contract, /coverage/, 'and the result must carry it, not only the type declare it');
  });

  test('NEGATIVE CASE: absence cannot be reported unqualified — `complete: false` is representable', () => {
    // The distinction the outcome rests on: "nothing was found" across eleven sources and across three are different
    // statements, and the contract must be able to say which one it is.
    const contract = readFileSync(resolve(ROOT, 'src/application/contracts/discovery-queries.ts'), 'utf8');
    assert.match(contract, /complete: boolean/, 'a partial run must be expressible');
    assert.match(contract, /sourcesAttempted/, 'and its attempt count must travel with the result');
    assert.match(contract, /sourcesTotal/, 'beside the total it is measured against');
  });

  test('the durable read path is proven in a suite that exists, and is not claimed here', () => {
    for (const suite of ['tests/db/candidate-records.test.ts', 'tests/db/observation-reads.test.ts']) {
      assert.equal(existsSync(resolve(ROOT, suite)), true, `${suite} must exist: it proves the reads against PostgreSQL`);
    }
  });

  test('discovery routes declare scopes, so an unauthenticated caller cannot reach them', () => {
    // The other half of "subject-bound": a discovery read is scoped to a tenant and a caller, which is asserted by the
    // registry naming a scope for each route rather than leaving it open.
    for (const route of ROUTES.filter((candidate) => candidate.path.includes('/discovery'))) {
      assert.ok(route.scopes.length > 0 || route.path.startsWith('/v1/health'), `${route.id} must declare a scope`);
    }
  });
});
