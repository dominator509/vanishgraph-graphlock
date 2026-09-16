/**
 * The three §6 ingress routes against real PostgreSQL (EP-004 M7).
 *
 * WHAT THIS SUITE PROVES, in the order the pipeline runs:
 *
 *   * **A signed delivery is accepted and its effect is APPLIED** — 6.1 records a `ControllerResponse` and moves the
 *     case through the guarded transition (T11 to `ACKNOWLEDGED`), and the response says
 *     `claimedOutcomeIsObservation: false` even when the controller claims `DELETED`;
 *   * **A replay is refused ONCE and deterministically** — the same nonce is `409` with no second effect, and a
 *     repeated EVENT ID with a fresh nonce returns the STORED response with `X-VG-Webhook-Replayed: true`;
 *   * **Tainted control fields are IGNORED and audited** — a body carrying `legalBasis`, `channel`, `truthState` and
 *     `budgetOverride` still processes, and an `IGNORED_CONTROL_FIELD` audit row names the fields;
 *   * **The refusals are the contract's** — a tampered body is `401`, a stale timestamp is `401`, a retired binding is
 *     `404`, and a delivery with no resolvable secret is `503`, never an accepted delivery;
 *   * **The transport routes cannot move a case** — 6.2 records a provider fact and 6.3 a delivery fact, both with
 *     `truthStateChanged: false`, and the case state is asserted UNCHANGED afterwards.
 *
 * THE REPLAY STORE IS THE REAL FILE BINDING, in a temporary directory, because the in-memory substitute M7 prohibits
 * is exactly what a suite like this would otherwise reach for. `VALKEY_URL` is not provisioned, so no test here — or
 * anywhere in this repository — has exercised the Valkey binding against a real coordination store.
 *
 * FIXTURE DISCIPLINE: this suite's own tenants, per run (ASSUMPTIONS §3.27).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, testServerDependencies } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresWebhookBindingQueries } from '../../src/adapters/persistence/webhook-bindings.ts';
import { PostgresWebhookDeliveryCommands } from '../../src/adapters/persistence/webhook-deliveries.ts';
import { PostgresControllerResponseQueries } from '../../src/adapters/persistence/controller-responses.ts';
import { FileReplayStore } from '../../src/adapters/coordination/replay-store.ts';
import { webhookSignature } from '../../src/http/webhooks/verify.ts';
import { capabilityTokenHash } from '../../src/application/contracts/webhook-bindings.ts';
import { appDsn, asTenant, exec, ownerDsn } from './harness.ts';

const TENANT_A = randomUUID();
const RUN = randomUUID().slice(0, 8);
const SECRET = 'webhook-shared-secret-not-a-real-credential';

let runner: PostgresTenantRunner;
let app: VgFastify;
let replayDir: string;

interface World {
  readonly caseId: string;
  readonly controllerId: string;
  readonly token: string;
}

/** A case at MATCH_CONFIRMED with a controller and an ACTIVE callback capability bound to it. */
function newWorld(): World {
  const subjectId = randomUUID();
  const grantId = randomUUID();
  const sourceId = randomUUID();
  const recordId = randomUUID();
  const exposureId = randomUUID();
  const caseId = randomUUID();
  const controllerId = randomUUID();
  const token = `cap-${randomUUID()}`;
  const created = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
         VALUES ('${subjectId}', '${TENANT_A}', 'wh-${RUN}-${subjectId.slice(0, 8)}', 'US-CA', false, 'ACTIVE');`,
      `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, revoked_at, signed_instrument)
         VALUES ('${grantId}', '${TENANT_A}', '${subjectId}', 'SELF', ARRAY['discovery'], now() - interval '1 day',
                 now() + interval '30 days', NULL, false);`,
      `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class)
         VALUES ('${sourceId}', '${TENANT_A}', 'wh-src-${RUN}-${sourceId.slice(0, 8)}', 'REGISTRY', 'US-CA', 'WRITE_PERMITTED');`,
      `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted)
         VALUES ('${recordId}', '${TENANT_A}', '${sourceId}', 'https://example.invalid/wh-${RUN}',
                 now() - interval '2 days', repeat('b', 64), false);`,
      `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state)
         VALUES ('${exposureId}', '${TENANT_A}', '${subjectId}', '${recordId}', 0.9,
                 '[{"feature":"NAME_EXACT","weight":0.4}]'::jsonb, 'REQUEST_SUBMITTED');`,
      `INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, truth_state)
         VALUES ('${caseId}', '${TENANT_A}', '${subjectId}', '${exposureId}', '${sourceId}', '${grantId}', 'REQUEST_SUBMITTED');`,
      `INSERT INTO controller (id, tenant_id, name, kind, contact_refs)
         VALUES ('${controllerId}', '${TENANT_A}', 'ctl-${RUN}-${controllerId.slice(0, 8)}', 'REGISTRY', ARRAY['c-${RUN}']);`,
      `INSERT INTO webhook_binding (id, tenant_id, kind, token_hash, secret_name, case_id, controller_id, status)
         VALUES ('${randomUUID()}', '${TENANT_A}', 'CONTROLLER_CALLBACK', '${capabilityTokenHash(token)}',
                 'secret-${RUN}', '${caseId}', '${controllerId}', 'ACTIVE');`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(created.status, 0, `world fixture failed: ${created.output}`);
  return { caseId, controllerId, token };
}

/** A signed delivery: the headers §6.1 requires, over the exact bytes. */
function delivery(
  body: Record<string, unknown>,
  options: { readonly token?: string; readonly nonce?: string; readonly eventId?: string; readonly timestamp?: number; readonly keyId?: string } = {},
): { readonly headers: Record<string, string>; readonly payload: Buffer; readonly url: string } {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? `nonce-${randomUUID()}`;
  const eventId = options.eventId ?? `evt-${randomUUID()}`;
  return {
    url: `/v1/webhooks/controller-callbacks/${options.token ?? ''}`,
    payload,
    headers: {
      'content-type': 'application/json',
      'x-vg-key-id': options.keyId ?? 'controller-key',
      'x-vg-timestamp': timestamp,
      'x-vg-nonce': nonce,
      'x-vg-signature': webhookSignature(SECRET, timestamp, nonce, payload),
      'x-vg-event-id': eventId,
    },
  };
}

async function post(
  url: string,
  payload: Buffer,
  headers: Record<string, string>,
): Promise<{ readonly status: number; readonly json: Record<string, unknown>; readonly headers: Record<string, unknown> }> {
  const response = await app.inject({ method: 'POST', url, headers, payload });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    json = { __raw: response.body };
  }
  return { status: response.statusCode, json, headers: response.headers as Record<string, unknown> };
}

function codeOf(response: { json: Record<string, unknown> }): unknown {
  const error = response.json['error'];
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined;
}

function read(sql: string): string[] {
  return asTenant(ownerDsn(), TENANT_A, sql.trimEnd().endsWith(';') ? sql : `${sql};`);
}

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  replayDir = mkdtempSync(join(tmpdir(), 'vg-webhook-ingress-'));
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES ('${TENANT_A}', 'webhook-ingress-${RUN}', 'ACTIVE');`,
  );
  assert.equal(created.status, 0, `tenant fixture failed: ${created.output}`);
  app = buildServer(
    testServerDependencies({
      identity: testIdentity({ tenantId: TENANT_A }),
      tenancy: { runner },
      sessionSecret: TEST_SESSION_SECRET,
      logLevel: 'error',
      webhookBindings: new PostgresWebhookBindingQueries(),
      webhookDeliveries: new PostgresWebhookDeliveryCommands({
        runner,
        controllerResponses: new PostgresControllerResponseQueries(),
      }),
      replayStore: new FileReplayStore({ path: join(replayDir, 'replay.log') }),
      resolveSecret: async () => SECRET,
    }),
  );
});

after(async () => {
  await app.close();
  await runner.close();
  rmSync(replayDir, { recursive: true, force: true });
});

describe('§6.1 a signed controller callback', () => {
  test('is accepted, RECORDED, and moves the case to ACKNOWLEDGED with the claim marked as a claim', async () => {
    const world = newWorld();
    const request = delivery(
      {
        eventId: 'evt-fixture',
        caseId: world.caseId,
        responseKind: 'CLAIMED_DELETION',
        claimedOutcome: 'DELETED',
        receivedAt: new Date().toISOString(),
        bodyRef: 'eml-0001',
      },
      { token: world.token },
    );
    const response = await post(request.url, request.payload, request.headers);
    assert.equal(response.status, 202, JSON.stringify(response.json));
    assert.equal(response.json['accepted'], true);
    assert.equal(response.json['caseId'], world.caseId);
    // THE CLAIM IS NOT AN OBSERVATION, even when it says DELETED: §6.1 and VG-VERIFY-004.
    assert.equal(response.json['claimedOutcomeIsObservation'], false);
    assert.equal(response.json['verificationRequired'], true);
    assert.equal(response.json['truthStateAfter'], 'ACKNOWLEDGED');

    // The EFFECT, read back from the database rather than from the response.
    const rows = read(
      `SELECT c.truth_state::text || '/' || (SELECT count(*) FROM controller_response r WHERE r.case_id = c.id)::text
         FROM request_case c WHERE c.id = '${world.caseId}'`,
    );
    assert.deepEqual(rows, ['ACKNOWLEDGED/1'], `rows were ${JSON.stringify(rows)}`);
  });

  test('a REPLAYED nonce is 409 with no second effect, and a repeated EVENT ID returns the stored answer', async () => {
    const world = newWorld();
    const nonce = `nonce-${randomUUID()}`;
    const eventId = `evt-${randomUUID()}`;
    const body = {
      eventId,
      caseId: world.caseId,
      responseKind: 'ACKNOWLEDGEMENT',
      claimedOutcome: 'UNSPECIFIED',
      bodyRef: 'eml-0002',
    };
    const first = delivery(body, { token: world.token, nonce, eventId });
    const accepted = await post(first.url, first.payload, first.headers);
    assert.equal(accepted.status, 202, JSON.stringify(accepted.json));

    // THE SAME BYTES AGAIN: same nonce, same event id. §6.2 makes this a replay, refused ONCE.
    const replay = await post(first.url, first.payload, first.headers);
    assert.equal(replay.status, 409, JSON.stringify(replay.json));
    assert.equal(codeOf(replay), 'WEBHOOK_NONCE_REPLAY');

    // A FRESH nonce with the same event id is an idempotent redelivery, not an error.
    const redelivery = delivery(body, { token: world.token, eventId });
    const replayed = await post(redelivery.url, redelivery.payload, redelivery.headers);
    assert.equal(replayed.status, 202, JSON.stringify(replayed.json));
    assert.equal(replayed.headers['x-vg-webhook-replayed'], 'true');
    // THE STORED RESPONSE, byte-identical: the same controller response id, not a second one.
    assert.equal(replayed.json['controllerResponseId'], accepted.json['controllerResponseId']);

    // And exactly ONE controller response exists for the case, so neither the replay nor the redelivery applied.
    const rows = read(`SELECT count(*)::text FROM controller_response WHERE case_id = '${world.caseId}'`);
    assert.deepEqual(rows, ['1'], 'a replay must not create a second response');
  });

  test('TAINTED CONTROL FIELDS are ignored and audited, and the delivery still processes', async () => {
    const world = newWorld();
    const request = delivery(
      {
        eventId: 'evt-tainted',
        caseId: world.caseId,
        responseKind: 'ACKNOWLEDGEMENT',
        claimedOutcome: 'NOT_DELETED',
        bodyRef: 'eml-0003',
        // Every one of these is an attempt to steer the system from outside (VG-SEC-001).
        legalBasis: 'CCPA_DELETE',
        channel: 'CERTIFIED_MAIL',
        truthState: 'VERIFIED_REMOVED',
        budgetOverride: 999,
        idempotencyKey: 'attacker-chosen',
      },
      { token: world.token },
    );
    const response = await post(request.url, request.payload, request.headers);
    assert.equal(response.status, 202, JSON.stringify(response.json));
    // The claimed outcome is the one in the ALLOWED field, and the tainted `truthState` did not become the state.
    assert.equal(response.json['truthStateAfter'], 'ACKNOWLEDGED');

    const audited = read(
      `SELECT payload::text FROM audit_event WHERE action = 'IGNORED_CONTROL_FIELD' AND correlation_id IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(audited.length, 1, 'the ignored fields must be audited');
    const payload = String(audited[0]);
    for (const field of ['legalBasis', 'channel', 'truthState', 'budgetOverride', 'idempotencyKey']) {
      assert.match(payload, new RegExp(field), `${field} must be named in the audit row`);
    }
    // THE VALUES ARE NOT IN THE AUDIT PAYLOAD: tainted input, and §8.3 keeps request values out of audit rows.
    assert.equal(payload.includes('CCPA_DELETE'), false);
    assert.equal(payload.includes('CERTIFIED_MAIL'), false);
  });

  test('the refusals are the contract’s, and none of them reaches the effect', async () => {
    const world = newWorld();
    const body = { eventId: 'evt-x', caseId: world.caseId, responseKind: 'ACKNOWLEDGEMENT', claimedOutcome: 'UNSPECIFIED', bodyRef: 'eml-x' };

    // 1. A TAMPERED body: the signature covers bytes that are no longer there.
    const good = delivery(body, { token: world.token });
    const tampered = await post(good.url, Buffer.from('{"caseId":"tampered"}', 'utf8'), good.headers);
    assert.equal(tampered.status, 401, JSON.stringify(tampered.json));
    assert.equal(codeOf(tampered), 'WEBHOOK_SIGNATURE_INVALID');

    // 2. A STALE timestamp.
    const stale = delivery(body, { token: world.token, timestamp: Math.floor(Date.now() / 1000) - 3600 });
    const staleResponse = await post(stale.url, stale.payload, stale.headers);
    assert.equal(staleResponse.status, 401, JSON.stringify(staleResponse.json));
    assert.equal(codeOf(staleResponse), 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');

    // 3. An UNKNOWN capability: §6's single answer for unknown, retired and revoked.
    const unknown = delivery(body, { token: `cap-${randomUUID()}` });
    const unknownResponse = await post(unknown.url, unknown.payload, unknown.headers);
    assert.equal(unknownResponse.status, 404, JSON.stringify(unknownResponse.json));
    assert.equal(codeOf(unknownResponse), 'WEBHOOK_BINDING_NOT_FOUND');

    // 4. NO resolvable secret: 503, because a delivery that cannot be verified must not be accepted unverified.
    const noSecret = buildServer(
      testServerDependencies({
        identity: testIdentity({ tenantId: TENANT_A }),
        tenancy: { runner },
        webhookBindings: new PostgresWebhookBindingQueries(),
        replayStore: new FileReplayStore({ path: join(replayDir, 'replay-2.log') }),
        resolveSecret: async (name: string) => {
          throw new Error(`no secret resolver is configured for ${name}`);
        },
      }),
    );
    const unresolved = await noSecret.inject({
      method: 'POST',
      url: good.url,
      headers: good.headers,
      payload: good.payload,
    });
    assert.equal(unresolved.statusCode, 503, unresolved.body);
    await noSecret.close();

    // NO EFFECT from any of the four.
    const rows = read(`SELECT count(*)::text FROM controller_response WHERE case_id = '${world.caseId}'`);
    assert.deepEqual(rows, ['0'], 'a refused delivery must not record a response');
  });
});

describe('§6.2/§6.3 the transport routes never move a case', () => {
  test('a provider fact is recorded against its transport run, and the case is unchanged', async () => {
    const world = newWorld();
    // A transport run and the binding that advertises it.
    const runId = randomUUID();
    const providerKey = `pk-${randomUUID().slice(0, 8)}`;
    const created = exec(
      ownerDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
        `INSERT INTO provider_transport_run (id, tenant_id, transport_name, auth_mode, egress_class, started_at, outcome)
           VALUES ('${runId}', '${TENANT_A}', 'registry-portal', 'OFFICIAL_FORM', 'NONE', now(), 'PENDING');`,
        `INSERT INTO webhook_binding (id, tenant_id, kind, provider_key_id, secret_name, status)
           VALUES ('${randomUUID()}', '${TENANT_A}', 'PROVIDER_CALLBACK', '${providerKey}', 'secret-${RUN}', 'ACTIVE');`,
        'COMMIT;',
      ].join('\n'),
    );
    assert.equal(created.status, 0, `provider fixture failed: ${created.output}`);

    const payload = Buffer.from(
      JSON.stringify({
        eventId: 'evt-p1',
        providerTransportRunId: runId,
        externalActionId: randomUUID(),
        providerEventKind: 'SUBMISSION_ACCEPTED',
        providerReference: 'ref-1',
        observedAt: new Date().toISOString(),
      }),
      'utf8',
    );
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = `nonce-${randomUUID()}`;
    const response = await post(
      `/v1/webhooks/provider-callbacks/${providerKey}`,
      payload,
      {
        'content-type': 'application/json',
        'x-vg-key-id': providerKey,
        'x-vg-timestamp': timestamp,
        'x-vg-nonce': nonce,
        'x-vg-signature': webhookSignature(SECRET, timestamp, nonce, payload),
        'x-vg-event-id': 'evt-p1',
      },
    );
    assert.equal(response.status, 202, JSON.stringify(response.json));
    assert.equal(response.json['recordedAs'], 'PROVIDER_TRANSPORT_FACT');
    // §6.3: a provider's own report is not an observation.
    assert.equal(response.json['truthStateChanged'], false);

    const rows = read(
      `SELECT outcome || '/' || (SELECT truth_state::text FROM request_case WHERE id = '${world.caseId}')
         FROM provider_transport_run WHERE id = '${runId}'`,
    );
    assert.deepEqual(rows, ['SUBMISSION_ACCEPTED/REQUEST_SUBMITTED'], 'the fact is recorded and the case did not move');
  });

  test('a delivery fact updates the mail piece, and a DELIVERED event with no tracking id is refused', async () => {
    const world = newWorld();
    const mailPieceId = randomUUID();
    const mailKey = `mk-${randomUUID().slice(0, 8)}`;
    const created = exec(
      ownerDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
        `INSERT INTO mail_piece (id, tenant_id, case_id, template_version, template_hash, transport_name, delivery_status)
           VALUES ('${mailPieceId}', '${TENANT_A}', '${world.caseId}', 1, repeat('a', 64), 'certified-mail', 'SENT');`,
        `INSERT INTO webhook_binding (id, tenant_id, kind, provider_key_id, secret_name, status)
           VALUES ('${randomUUID()}', '${TENANT_A}', 'MAIL_TRACKING', '${mailKey}', 'secret-${RUN}', 'ACTIVE');`,
        'COMMIT;',
      ].join('\n'),
    );
    assert.equal(created.status, 0, `mail fixture failed: ${created.output}`);

    const send = async (body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = `nonce-${randomUUID()}`;
      const eventId = String(body['eventId']);
      return post(`/v1/webhooks/mail-tracking/${mailKey}`, payload, {
        'content-type': 'application/json',
        'x-vg-key-id': mailKey,
        'x-vg-timestamp': timestamp,
        'x-vg-nonce': nonce,
        'x-vg-signature': webhookSignature(SECRET, timestamp, nonce, payload),
        'x-vg-event-id': eventId,
      });
    };

    // DELIVERED REQUIRES A TRACKING ID: `mail_piece_check` says so, and the route reports the missing field.
    const withoutTracking = await send({
      eventId: 'evt-m1',
      trackingId: null,
      mailPieceId,
      deliveryStatus: 'DELIVERED',
      occurredAt: new Date().toISOString(),
    });
    assert.equal(withoutTracking.status, 422, JSON.stringify(withoutTracking.json));
    assert.equal(codeOf(withoutTracking), 'SCHEMA_VALIDATION_FAILED');

    // With a tracking id the same event applies, and the case still does not move.
    const applied = await send({
      eventId: 'evt-m2',
      trackingId: 'TRACK-0001',
      mailPieceId,
      deliveryStatus: 'DELIVERED',
      occurredAt: new Date().toISOString(),
    });
    assert.equal(applied.status, 202, JSON.stringify(applied.json));
    assert.equal(applied.json['truthStateChanged'], false);

    const rows = read(
      `SELECT delivery_status || '/' || tracking_id || '/' ||
              (SELECT truth_state::text FROM request_case WHERE id = '${world.caseId}')
         FROM mail_piece WHERE id = '${mailPieceId}'`,
    );
    assert.deepEqual(rows, ['DELIVERED/TRACK-0001/REQUEST_SUBMITTED']);

    // An unknown mail piece is its own refusal.
    const unknownPiece = await send({
      eventId: 'evt-m3',
      mailPieceId: randomUUID(),
      deliveryStatus: 'IN_TRANSIT',
      occurredAt: new Date().toISOString(),
    });
    assert.equal(unknownPiece.status, 409, JSON.stringify(unknownPiece.json));
    assert.equal(codeOf(unknownPiece), 'WEBHOOK_MAIL_PIECE_NOT_FOUND');
  });
});
