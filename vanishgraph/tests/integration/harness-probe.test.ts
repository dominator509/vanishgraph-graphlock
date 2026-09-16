/**
 * The integration root's zero-dependency check on its shared harness (EP-006 M10).
 *
 * IT BEGAN AS A DELIBERATE PROBE AND IS KEPT AS A PREFLIGHT, which is why it says so rather than calling itself
 * temporary. A real integration suite was written in round 73 and the stage reported it as producing NO RESULTS while
 * the same file produced five tests when run directly; this file answered the only question that mattered then — does
 * the stage RUN a file placed under `tests/integration/`? — with assertions that touch no database, so a failure here
 * was about the stage and not about PostgreSQL. The glob defect it found is fixed (`test-integration.sh` and the
 * collection guard now name the same three roots) and three real suites under this root run in the stage.
 *
 * WHAT IT IS WORTH NOW: if the shared harness stops importing, or `db/tenant-scoped-tables.txt` becomes unreadable or
 * loses a table, this fails BY NAME in milliseconds instead of surfacing as thirty confusing database failures. It does
 * NOT prove the harness can reach PostgreSQL — that is what every other suite under this root does, and pretending
 * otherwise here would be the sort of claim this repository's honesty rules exist to prevent.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { TENANT_A, TENANT_B, tenantScopedTables } from '../db/harness.ts';

describe('the integration root’s shared harness imports without a database (EP-006 M10)', () => {
  test('the harness module loads and exports well-formed fixture tenants', () => {
    assert.notEqual(TENANT_A, TENANT_B, 'the two fixture tenants must be distinct');
    assert.match(TENANT_A, /^[0-9a-f-]{36}$/);
    assert.match(TENANT_B, /^[0-9a-f-]{36}$/);
  });

  test('the tenant-scoped table list is readable and still names the tables EP-006 writes', () => {
    const tables = tenantScopedTables();
    assert.ok(tables.length >= 30, `expected the tenant-scoped table list, found ${String(tables.length)}`);
    assert.ok(tables.includes('authority_grant'), 'authority_grant must remain tenant-scoped');
    assert.ok(tables.includes('evidence_artifact'), 'evidence_artifact must remain tenant-scoped');
  });
});
