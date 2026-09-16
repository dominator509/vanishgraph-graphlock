/**
 * Evidence and audit cannot be mutated, at every layer that could be asked to (EP-006 M10; SPEC-005 VG-AUTHZ-017,
 * VG-AUTH-031; SPEC-000 VG-EVIDENCE-001/003; SPEC-003 VG-API-052, VG-API-056).
 *
 * THE FOUR LAYERS, BECAUSE ONE OF THEM IS NOT THE OTHERS:
 *
 *  1. **No mutation surface.** The route registry is asserted to contain no `PATCH`, `PUT` or `DELETE` route under
 *     `/v1/evidence-artifacts` or `/v1/audit-events`. This is a property of the contract, not of the database.
 *  2. **No privilege.** The RUNTIME ROLE (`vg_app`, the role every request uses, and the role a `TENANT_ADMIN` request
 *     runs as) must hold no `UPDATE` or `DELETE` on either table. MEASURED BEFORE THE FIX: `vg_app` held BOTH on
 *     `evidence_artifact` — `db/privileges.sql` grants `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` and revoked only
 *     `audit_event`. The requirement was unmet and this suite is where it was caught; the privilege is revoked in the
 *     same file now, and the assertion is what keeps it revoked.
 *  3. **An attempt fails.** A privilege that exists only in a catalogue is not a control, so an actual `UPDATE` and
 *     `DELETE` are attempted as `vg_app` and must be refused. Both probes run inside a transaction that is ROLLED BACK,
 *     so if a future change grants the privilege the test FAILS instead of mutating the evidence store.
 *  4. **The storage rules.** `audit_event` carries `DO INSTEAD NOTHING` rules and a `TRUNCATE` trigger, so an attempted
 *     audit mutation is a no-op FOR EVERY ROLE including the owner — proven by committing the attempt and observing the
 *     row unchanged, which is the only way to prove a silent no-op. MEASURED: the rule fires BEFORE privilege checking,
 *     so the same attempt as `vg_app` also exits 0 with the row unchanged even though `vg_app` holds no `UPDATE` or
 *     `DELETE` privilege on the table. The rule, not the privilege, is what protects the audit log from the runtime
 *     role, and this suite asserts the measured behaviour so that dropping the rule is visible.
 *
 * WHAT THIS SUITE DOES NOT CLAIM: that the owner cannot delete evidence. VG-AUTHZ-017 says retention removes evidence
 * "only by the retention subsystem (SPEC-002 §5)", and that subsystem does not exist yet; the owner's capability is
 * therefore asserted POSITIVELY, so this suite cannot be read as "no role may ever delete evidence" — which would
 * contradict the requirement it serves. The gap between the plan's phrase "refused for every role" and what is enforced
 * per role is recorded rather than smoothed over (ASSUMPTIONS §3.56).
 *
 * FIXTURE DISCIPLINE: this suite's own tenant, per run (ASSUMPTIONS §3.27).
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { ROUTES } from '../../src/http/openapi/registry.ts';
import { appDsn, asTenant, exec, ownerDsn } from '../db/harness.ts';

const TENANT = randomUUID();
const RUN = randomUUID().slice(0, 8);

let artifactId: string;
let artifactDigest: string;
let auditId: string;

/** A labelled count, parsed by marker rather than by position (a tenant session also echoes `set_config`). */
function countOf(lines: readonly string[]): string {
  const marker = /vg_count=(\d+)/.exec(lines.join('\n'));
  assert.ok(marker !== null, `no vg_count marker in: ${lines.join(' | ')}`);
  return marker[1] ?? '';
}

/** Whether a role holds a privilege on a table, as a string so the rendering cannot be mistaken. */
function privilege(role: string, table: string, verb: string): string {
  const rows = asTenant(
    ownerDsn(),
    TENANT,
    `SELECT 'vg_priv=' || (CASE WHEN has_table_privilege('${role}', '${table}', '${verb}') THEN 'true' ELSE 'false' END);`,
  );
  const marker = /vg_priv=(true|false)/.exec(rows.join('\n'));
  assert.ok(marker !== null, `no vg_priv marker in: ${rows.join(' | ')}`);
  return marker[1] ?? '';
}

/** The stored digest of the fixture artifact, read as the owner under its tenant. */
function storedDigest(): string {
  const rows = asTenant(
    ownerDsn(),
    TENANT,
    `SELECT 'vg_digest=' || digest FROM evidence_artifact WHERE id = '${artifactId}';`,
  );
  const marker = /vg_digest=([0-9a-f]{64})/.exec(rows.join('\n'));
  assert.ok(marker !== null, `no vg_digest marker in: ${rows.join(' | ')}`);
  return marker[1] ?? '';
}

/** The fixture audit row's actor, read as the owner under its tenant. */
function auditActor(): string {
  const rows = asTenant(
    ownerDsn(),
    TENANT,
    `SELECT 'vg_actor=' || actor FROM audit_event WHERE id = ${auditId};`,
  );
  const marker = /vg_actor=(.*)$/m.exec(rows.join('\n'));
  assert.ok(marker !== null, `no vg_actor marker in: ${rows.join(' | ')}`);
  return (marker[1] ?? '').trim();
}

before(() => {
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES ('${TENANT}', 'evidence-immutability-${RUN}', 'ACTIVE');`,
  );
  assert.equal(created.status, 0, `tenant fixture failed: ${created.output}`);

  artifactId = randomUUID();
  artifactDigest = createHash('sha256').update(`immutability:${RUN}`, 'utf8').digest('hex');
  const artifact = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT}', true);`,
      `INSERT INTO evidence_artifact (id, tenant_id, case_id, kind, digest, storage_ref, egress_class,
                                      redaction_state, captured_at)
         VALUES ('${artifactId}', '${TENANT}', NULL, 'SOURCE_SNAPSHOT', '${artifactDigest}',
                 's3://evidence/${RUN}/${artifactId}', 'NONE', 'NONE', now());`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(artifact.status, 0, `artifact fixture failed: ${artifact.output}`);

  const audit = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT}', true);`,
      `INSERT INTO audit_event (tenant_id, actor, action, target_kind, target_id, correlation_id, payload)
         VALUES ('${TENANT}', 'immutability-fixture-${RUN}', 'evidence.immutability.fixture', 'EvidenceArtifact',
                 '${artifactId}', gen_random_uuid(), '{}'::jsonb)
         RETURNING 'vg_audit_id=' || id::text;`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(audit.status, 0, `audit fixture failed: ${audit.output}`);
  const marker = /vg_audit_id=(\d+)/.exec(audit.output);
  assert.ok(marker !== null, `no audit id in the fixture output: ${audit.output}`);
  auditId = marker[1] ?? '';
});

after(() => {
  // Nothing is cleaned up: this suite's tenant is per run and its rows are the evidence it asserted against. Deleting
  // them would need the very privilege under test.
});

describe('no route mutates evidence or audit (VG-API-052, VG-API-056)', () => {
  test('the registry contains no PATCH, PUT or DELETE route under the evidence or audit paths', () => {
    const mutating = ROUTES.filter(
      (route) =>
        (route.method === 'PATCH' || route.method === 'PUT' || route.method === 'DELETE') &&
        (route.path.startsWith('/v1/evidence-artifacts') || route.path.startsWith('/v1/audit-events')),
    );
    assert.deepEqual(
      mutating.map((route) => `${route.method} ${route.path}`),
      [],
      'a mutation route for evidence or audit would defeat the append-only property before any database check runs',
    );
    // THE NON-VACUITY CONTROL: the registry does contain the read routes, so the filter above is looking at a populated
    // registry and not at an empty list.
    const readRoutes = ROUTES.filter((route) => route.path.startsWith('/v1/evidence-artifacts'));
    assert.ok(readRoutes.length >= 3, `expected the evidence read routes, saw ${String(readRoutes.length)}`);
  });
});

describe('the runtime role holds no mutation privilege (VG-AUTHZ-017, VG-AUTH-031)', () => {
  test('vg_app may SELECT and INSERT evidence, and may NOT update or delete it', () => {
    assert.equal(privilege('vg_app', 'evidence_artifact', 'SELECT'), 'true', 'readback is required by §5.12.2');
    assert.equal(privilege('vg_app', 'evidence_artifact', 'INSERT'), 'true', 'upload is required by §5.12.1');
    assert.equal(privilege('vg_app', 'evidence_artifact', 'UPDATE'), 'false', 'evidence is immutable (VG-EVIDENCE-001)');
    assert.equal(privilege('vg_app', 'evidence_artifact', 'DELETE'), 'false', 'deletion is unavailable to every application role (VG-AUTHZ-017)');
  });

  test('vg_app may insert audit rows and may NOT update, delete or truncate them', () => {
    assert.equal(privilege('vg_app', 'audit_event', 'SELECT'), 'true');
    assert.equal(privilege('vg_app', 'audit_event', 'INSERT'), 'true', 'every state change must be able to append its event');
    assert.equal(privilege('vg_app', 'audit_event', 'UPDATE'), 'false');
    assert.equal(privilege('vg_app', 'audit_event', 'DELETE'), 'false');
    assert.equal(privilege('vg_app', 'audit_event', 'TRUNCATE'), 'false');
  });

  test('the OWNER keeps the capability the retention subsystem will need, so the control is scoped not absolute', () => {
    // VG-AUTHZ-017 removes evidence "only by the retention subsystem": revoking the privilege from EVERY role would
    // make that requirement unimplementable, and this assertion is what stops the revocation being widened by accident.
    assert.equal(privilege('vg_owner', 'evidence_artifact', 'DELETE'), 'true');
    assert.equal(privilege('vg_app', 'evidence_artifact', 'DELETE'), 'false');
  });
});

describe('an attempted mutation is refused, not merely absent from the registry', () => {
  test('vg_app cannot UPDATE an artifact, and the stored digest is unchanged afterwards', () => {
    // BEGIN … ROLLBACK: if a future change granted the privilege, this probe must FAIL rather than rewrite the evidence
    // store. The rollback is the safety property of the probe, not a weakening of it.
    const attempt = exec(
      appDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT}', true);`,
        `UPDATE evidence_artifact SET digest = repeat('f', 64) WHERE id = '${artifactId}';`,
        'ROLLBACK;',
      ].join('\n'),
    );
    assert.notEqual(attempt.status, 0, 'the update must be refused');
    assert.match(attempt.output, /permission denied/i, `expected a privilege refusal, got:\n${attempt.output}`);
    assert.equal(storedDigest(), artifactDigest, 'the artifact must be byte-identical after the attempt');
  });

  test('vg_app cannot DELETE an artifact', () => {
    const attempt = exec(
      appDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT}', true);`,
        `DELETE FROM evidence_artifact WHERE id = '${artifactId}';`,
        'ROLLBACK;',
      ].join('\n'),
    );
    assert.notEqual(attempt.status, 0, 'the delete must be refused');
    assert.match(attempt.output, /permission denied/i, `expected a privilege refusal, got:\n${attempt.output}`);
    assert.equal(
      countOf(asTenant(appDsn(), TENANT, "SELECT 'vg_count=' || count(*)::text FROM evidence_artifact;")),
      '1',
      'the artifact must still be there',
    );
  });

  test('vg_app cannot TRUNCATE the evidence or audit tables', () => {
    const truncateEvidence = exec(
      appDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT}', true);`,
        'TRUNCATE evidence_artifact;',
        'ROLLBACK;',
      ].join('\n'),
    );
    assert.notEqual(truncateEvidence.status, 0, 'TRUNCATE must be refused');
    assert.match(truncateEvidence.output, /permission denied/i, `got:\n${truncateEvidence.output}`);
    assert.equal(
      countOf(asTenant(appDsn(), TENANT, "SELECT 'vg_count=' || count(*)::text FROM evidence_artifact;")),
      '1',
    );
  });

  test('an audit mutation is a NO-OP for the owner too, because the rules refuse it at the storage layer', () => {
    // The owner HOLDS update/delete on audit_event (no privilege was revoked from it), so this refusal can only come
    // from the `DO INSTEAD NOTHING` rules. It is COMMITTED rather than rolled back, because a silent no-op can only be
    // proven by committing the attempt and observing that nothing moved.
    const attempt = exec(
      ownerDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT}', true);`,
        `UPDATE audit_event SET actor = 'tampered' WHERE id = ${auditId};`,
        `DELETE FROM audit_event WHERE id = ${auditId};`,
        'COMMIT;',
      ].join('\n'),
    );
    assert.equal(attempt.status, 0, `the rule makes these statements succeed as no-ops, got:\n${attempt.output}`);
    assert.equal(auditActor(), `immutability-fixture-${RUN}`, 'the audit row must be unchanged');
    assert.equal(
      countOf(asTenant(ownerDsn(), TENANT, `SELECT 'vg_count=' || count(*)::text FROM audit_event WHERE id = ${auditId};`)),
      '1',
      'the audit row must still exist',
    );
  });

  test('an audit mutation as vg_app SUCCEEDS AS A NO-OP, because the rule rewrites it before privileges are consulted', () => {
    // MEASURED, AND IT CONTRADICTED THE FIRST VERSION OF THIS TEST. `vg_app` holds NO update or delete privilege on
    // `audit_event`, so I asserted that the privilege would be refused first — and the probe exited 0 with the row
    // unchanged. PostgreSQL's rule system rewrites `UPDATE`/`DELETE` to nothing BEFORE privilege checking, so the
    // absent privilege is never consulted and the RULE is the control. The assertion is therefore the measured
    // behaviour: a `permission denied` here would mean the rule had been dropped and only the privilege was left.
    const attempt = exec(
      appDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT}', true);`,
        `UPDATE audit_event SET actor = 'tampered' WHERE id = ${auditId};`,
        `DELETE FROM audit_event WHERE id = ${auditId};`,
        'COMMIT;',
      ].join('\n'),
    );
    assert.equal(attempt.status, 0, `the rule makes these no-ops, got:\n${attempt.output}`);
    assert.doesNotMatch(attempt.output, /permission denied/i, 'the rule must fire, not the privilege check');
    assert.equal(auditActor(), `immutability-fixture-${RUN}`, 'the audit row must be unchanged');
    assert.equal(
      countOf(asTenant(ownerDsn(), TENANT, `SELECT 'vg_count=' || count(*)::text FROM audit_event WHERE id = ${auditId};`)),
      '1',
      'the audit row must still exist',
    );
  });
});
