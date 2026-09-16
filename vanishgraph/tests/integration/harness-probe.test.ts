/**
 * A deliberate probe of the integration stage's own collection (EP-006 M10).
 *
 * WHY THIS FILE EXISTS, AND IT IS TEMPORARY: a real integration suite was written in round 73 and the stage reported it as
 * producing NO RESULTS while the same file produced five tests when run directly. Before writing the real suites again,
 * this probe answers one question — does the stage RUN a file placed under `tests/integration/`? — with two assertions
 * that touch no database, so a failure here is about the stage rather than about PostgreSQL.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { TENANT_A, TENANT_B, tenantScopedTables } from '../db/harness.ts';

describe('the integration stage collects and runs a suite under tests/integration (EP-006 M10 probe)', () => {
  test('the harness imports, and its tenant list is the declared one', () => {
    assert.notEqual(TENANT_A, TENANT_B);
    assert.match(TENANT_A, /^[0-9a-f-]{36}$/);
  });

  test('the tenant-scoped table list is readable without a database connection', () => {
    const tables = tenantScopedTables();
    assert.ok(tables.length >= 30, `expected the tenant-scoped table list, found ${String(tables.length)}`);
    assert.ok(tables.includes('authority_grant'));
  });
});
