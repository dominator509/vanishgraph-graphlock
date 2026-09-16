/**
 * §6's capability resolution against real PostgreSQL, including the policy that makes it possible.
 *
 * WHAT THIS SUITE PROVES, and the second half is the one that matters most:
 *
 *   * An ACTIVE binding resolves — by capability token for §6.1, by advertised key id for §6.2/§6.3 — and the binding
 *     names the tenant the rest of the delivery will run as.
 *   * A RETIRED or REVOKED binding resolves to NOTHING, which is the same answer as "never existed": §6 lists one
 *     code (`404 WEBHOOK_BINDING_NOT_FOUND`) for all three, and distinguishing them would let a prober learn that a
 *     capability once existed.
 *   * **THE CAPABILITY POLICY DISCLOSES NOTHING.** An unbound session that presents NO capability value sees zero
 *     rows; one that presents a token hash sees exactly the row that token names and no other. That is the property
 *     the whole two-transaction design rests on, and it is asserted against the database rather than argued from the
 *     migration's text.
 *
 * FIXTURE DISCIPLINE: this suite's own tenants, per run (ASSUMPTIONS §3.27).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import {
  PostgresWebhookBindingQueries,
  capabilityTokenHash,
} from '../../src/adapters/persistence/webhook-bindings.ts';
import { appDsn, asTenant, exec, ownerDsn, withoutTenant } from './harness.ts';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const RUN = randomUUID().slice(0, 8);

let runner: PostgresTenantRunner;
const bindings = new PostgresWebhookBindingQueries();

/** A binding row, inserted by the OWNER and scoped explicitly: the fixtures are the point, not the policy. */
function newBinding(options: {
  readonly tenantId: string;
  readonly kind: 'CONTROLLER_CALLBACK' | 'PROVIDER_CALLBACK' | 'MAIL_TRACKING';
  readonly token?: string;
  readonly providerKeyId?: string;
  readonly status?: string;
  readonly withCase?: boolean;
}): { readonly id: string } {
  const id = randomUUID();
  const controllerId = randomUUID();
  const caseId = randomUUID();
  const subjectId = randomUUID();
  const grantId = randomUUID();
  const sourceId = randomUUID();
  const recordId = randomUUID();
  const exposureId = randomUUID();
  const lines = [
    'BEGIN;',
    `SELECT set_config('app.tenant_id', '${options.tenantId}', true);`,
    `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
       VALUES ('${subjectId}', '${options.tenantId}', 'wh-${RUN}-${subjectId.slice(0, 8)}', 'US-CA', false, 'ACTIVE');`,
    `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, revoked_at, signed_instrument)
       VALUES ('${grantId}', '${options.tenantId}', '${subjectId}', 'SELF', ARRAY['discovery'], now() - interval '1 day',
               now() + interval '30 days', NULL, false);`,
    `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class)
       VALUES ('${sourceId}', '${options.tenantId}', 'wh-source-${RUN}-${sourceId.slice(0, 8)}', 'REGISTRY', 'US-CA',
               'WRITE_PERMITTED');`,
    `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted)
       VALUES ('${recordId}', '${options.tenantId}', '${sourceId}', 'https://example.invalid/wh-${RUN}',
               now() - interval '2 days', repeat('a', 64), false);`,
    `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state)
       VALUES ('${exposureId}', '${options.tenantId}', '${subjectId}', '${recordId}', 0.9,
               '[{"feature":"NAME_EXACT","weight":0.4}]'::jsonb, 'MATCH_CONFIRMED');`,
    `INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, truth_state)
       VALUES ('${caseId}', '${options.tenantId}', '${subjectId}', '${exposureId}', '${sourceId}', '${grantId}',
               'MATCH_CONFIRMED');`,
    `INSERT INTO controller (id, tenant_id, name, kind, contact_refs)
       VALUES ('${controllerId}', '${options.tenantId}', 'controller-${RUN}-${controllerId.slice(0, 8)}', 'REGISTRY',
               ARRAY['contact-${RUN}']);`,
    `INSERT INTO webhook_binding (id, tenant_id, kind, provider_key_id, token_hash, secret_name, case_id, controller_id, status)
       VALUES ('${id}', '${options.tenantId}', '${options.kind}',
               ${options.providerKeyId === undefined ? 'NULL' : `'${options.providerKeyId}'`},
               ${options.token === undefined ? 'NULL' : `'${capabilityTokenHash(options.token)}'`},
               'secret-${RUN}', ${options.kind === 'CONTROLLER_CALLBACK' ? `'${caseId}'` : 'NULL'},
               ${options.kind === 'CONTROLLER_CALLBACK' ? `'${controllerId}'` : 'NULL'},
               '${options.status ?? 'ACTIVE'}');`,
    'COMMIT;',
  ];
  const created = exec(ownerDsn(), lines.join('\n'));
  assert.equal(created.status, 0, `binding fixture failed: ${created.output}`);
  return { id };
}

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES
       ('${TENANT_A}', 'webhook-suite-a-${RUN}', 'ACTIVE'),
       ('${TENANT_B}', 'webhook-suite-b-${RUN}', 'ACTIVE');`,
  );
  assert.equal(created.status, 0, `tenant fixture failed: ${created.output}`);
});

after(async () => {
  await runner.close();
});

describe('§6.1 a controller-callback capability resolves to its binding', () => {
  test('an ACTIVE token resolves, naming the tenant, case and controller', async () => {
    const token = `cap-${randomUUID()}`;
    const binding = newBinding({ tenantId: TENANT_A, kind: 'CONTROLLER_CALLBACK', token });
    const resolved = await bindings.resolveControllerToken(runner, capabilityTokenHash(token));
    assert.ok(resolved !== undefined, 'an active capability must resolve');
    assert.equal(resolved.tenantId, TENANT_A);
    assert.equal(resolved.kind, 'CONTROLLER_CALLBACK');
    assert.notEqual(resolved.caseId, null);
    assert.notEqual(resolved.controllerId, null);
    // The SECRET NAME, never the secret: the column holds a name the SecretResolver turns into material.
    assert.equal(resolved.secretName, `secret-${RUN}`);
    assert.ok(binding.id.length > 0);
  });

  test('a RETIRED or REVOKED capability resolves to NOTHING, exactly like an unknown one', async () => {
    for (const status of ['RETIRED', 'REVOKED']) {
      const token = `cap-${randomUUID()}`;
      newBinding({ tenantId: TENANT_A, kind: 'CONTROLLER_CALLBACK', token, status });
      const resolved = await bindings.resolveControllerToken(runner, capabilityTokenHash(token));
      assert.equal(resolved, undefined, `${status} must not resolve`);
    }
    // And a token that never existed is the same answer — the conflation §6 requires.
    const unknown = await bindings.resolveControllerToken(runner, capabilityTokenHash(`cap-${randomUUID()}`));
    assert.equal(unknown, undefined);
  });

  test('the WRONG token does not resolve the right binding', async () => {
    const token = `cap-${randomUUID()}`;
    newBinding({ tenantId: TENANT_A, kind: 'CONTROLLER_CALLBACK', token });
    const other = await bindings.resolveControllerToken(runner, capabilityTokenHash(`cap-${randomUUID()}`));
    assert.equal(other, undefined);
  });
});

describe('§6.2/§6.3 an advertised provider key resolves', () => {
  test('each provider kind resolves its own row, and a kind mismatch is not the other route’s binding', async () => {
    const providerKey = `pk-${randomUUID().slice(0, 8)}`;
    newBinding({ tenantId: TENANT_A, kind: 'PROVIDER_CALLBACK', providerKeyId: providerKey });
    const resolved = await bindings.resolveProviderKey(runner, providerKey);
    assert.ok(resolved !== undefined);
    assert.equal(resolved.kind, 'PROVIDER_CALLBACK');
    assert.equal(resolved.tenantId, TENANT_A);
    assert.equal(resolved.caseId, null, 'a provider binding names no case');

    const mailKey = `mk-${randomUUID().slice(0, 8)}`;
    newBinding({ tenantId: TENANT_A, kind: 'MAIL_TRACKING', providerKeyId: mailKey });
    const mail = await bindings.resolveProviderKey(runner, mailKey);
    assert.equal(mail?.kind, 'MAIL_TRACKING');

    // A retired provider key is not found, which is §6's answer for a rotated credential.
    const retiredKey = `pk-${randomUUID().slice(0, 8)}`;
    newBinding({ tenantId: TENANT_A, kind: 'PROVIDER_CALLBACK', providerKeyId: retiredKey, status: 'RETIRED' });
    assert.equal(await bindings.resolveProviderKey(runner, retiredKey), undefined);
  });
});

describe('the capability policy discloses nothing it was not given', () => {
  test('an unbound session with NO capability value sees ZERO rows', async () => {
    const token = `cap-${randomUUID()}`;
    newBinding({ tenantId: TENANT_A, kind: 'CONTROLLER_CALLBACK', token });
    // NO `app.tenant_id` AND NO capability value: the fail-closed path. MEASURED correction — the first version of
    // this test used `asTenant(dsn, '', …)`, which sets an EMPTY tenant and fails the `::uuid` cast (invalid input
    // syntax for type uuid: ""), so the assertion never ran. `withoutTenant` is the harness's real no-tenant path.
    const rows = withoutTenant(ownerDsn(), 'SELECT count(*)::text AS n FROM webhook_binding');
    assert.deepEqual(rows, ['0'], `an unbound session saw rows: ${JSON.stringify(rows)}`);
  });

  test('presenting ONE token hash reveals that row and no other', async () => {
    const mine = `cap-${randomUUID()}`;
    const theirs = `cap-${randomUUID()}`;
    newBinding({ tenantId: TENANT_A, kind: 'CONTROLLER_CALLBACK', token: mine });
    newBinding({ tenantId: TENANT_B, kind: 'CONTROLLER_CALLBACK', token: theirs });
    const rows = await runner.withCapabilityTransaction('token_hash', capabilityTokenHash(mine), async (tx) => {
      const result = await tx.query<{ tenant_id: string }>(
        `SELECT b.tenant_id::text AS tenant_id FROM webhook_binding b`,
      );
      return result.rows;
    });
    assert.equal(rows.length, 1, `presenting one capability must reveal one row, saw ${String(rows.length)}`);
    assert.equal(rows[0]?.tenant_id, TENANT_A);
  });

  test('the CAPABILITY VALUE IS THE ONLY THING THAT WIDENS THE VIEW: a provider key does not reveal token rows', async () => {
    const token = `cap-${randomUUID()}`;
    const providerKey = `pk-${randomUUID().slice(0, 8)}`;
    newBinding({ tenantId: TENANT_A, kind: 'CONTROLLER_CALLBACK', token });
    newBinding({ tenantId: TENANT_A, kind: 'PROVIDER_CALLBACK', providerKeyId: providerKey });
    const rows = await runner.withCapabilityTransaction('provider_key', providerKey, async (tx) => {
      const result = await tx.query<{ kind: string }>(`SELECT b.kind FROM webhook_binding b`);
      return result.rows;
    });
    assert.deepEqual(
      rows.map((row) => row.kind),
      ['PROVIDER_CALLBACK'],
      'a provider-key binding must reveal only its own row',
    );
  });

  test('a tenant-scoped session still sees its own rows, so the policy did not replace the tenant rule', async () => {
    const token = `cap-${randomUUID()}`;
    newBinding({ tenantId: TENANT_A, kind: 'CONTROLLER_CALLBACK', token });
    // The trailing `;` is REQUIRED: `asTenant` appends its own `COMMIT;` to whatever it is given, and a statement
    // without a terminator swallows it (MEASURED here: "syntax error at or near COMMIT").
    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT count(*)::text AS n FROM webhook_binding WHERE tenant_id = '${TENANT_A}';`,
    );
    assert.ok(Number(rows[0] ?? '0') >= 1, 'the tenant policy must still work');
    const other = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT count(*)::text AS n FROM webhook_binding WHERE tenant_id = '${TENANT_B}';`,
    );
    assert.deepEqual(other, ['0'], 'a tenant must not see another tenant’s bindings');
  });
});
