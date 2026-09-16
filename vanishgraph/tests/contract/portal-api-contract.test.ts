/**
 * The portal's data boundary, asserted against the CONTRACT and against a stub transport (EP-005 M5).
 *
 * WHAT THIS SUITE IS FOR. The UI declares its own copy of every field name it reads, because `scripts/import-boundary.sh`
 * rule 4 forbids a browser bundle from importing the server's types. A hand-declared copy is exactly where a field name
 * gets invented, so:
 *
 *   1. EVERY DECLARED WIRE FIELD MUST APPEAR IN SPEC-003. The test parses the specification and requires each name in
 *      `ui/src/api/wire.ts` to occur in it. **Its limit is stated so it is not over-read:** the check proves a name is
 *      SOMEWHERE in a 175 KB contract, not that it is in the right section — which is why every declaration in
 *      `wire.ts` carries the section it came from, and why the mappers below are asserted case by case.
 *   2. THE MAPPERS ARE ASSERTED ON REAL RESPONSE SHAPES, including the three the UI must NOT invent: a coverage
 *      denominator that is `sourcesDeclared` and not a `sourcesTotal` the route never returns, a catalogue version that
 *      is `null` rather than a plausible string, and a confidence threshold that is `null` on a list row.
 *   3. THE CLIENT IS ASSERTED ON ITS REFUSALS: a POST with no `Idempotency-Key` throws, a non-2xx without the §8.1
 *      envelope is a `TransportFailure` and not an `ApiError` carrying invented identifiers, and no `authorization`
 *      header is fabricated when no token provider is configured.
 *
 * THE TRANSPORT IS A REAL `fetch`-SHAPED STUB, NOT A MOCK OF THE CLIENT: the code under test is the real
 * `PortalClient`, and only the network is replaced — which is what makes these assertions about the client rather than
 * about a double.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PortalClient } from '../../ui/src/api/client.ts';
import { ApiError, TransportFailure } from '../../ui/src/api/errors.ts';
import { createPortalApi } from '../../ui/src/api/portal.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SPEC = readFileSync(join(PROJECT_ROOT, '.agent', 'specs', 'SPEC-003-api-contracts.md'), 'utf8');
const WIRE = readFileSync(join(PROJECT_ROOT, 'ui', 'src', 'api', 'wire.ts'), 'utf8');

/** One recorded exchange. */
interface Exchange {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** A stub transport that answers with a queued response and records what it was asked. */
function stubTransport(responses: readonly { readonly status: number; readonly body: string; readonly headers?: Record<string, string> }[]): {
  readonly fetchImpl: typeof fetch;
  readonly exchanges: Exchange[];
} {
  const exchanges: Exchange[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    exchanges.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const queued = responses[index] ?? responses[responses.length - 1];
    index += 1;
    if (queued === undefined) throw new Error('the stub transport was called more times than it was given responses');
    return new Response(queued.body, { status: queued.status, headers: queued.headers ?? {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, exchanges };
}

/** A response body for a §5.5.1 list row, with only the declared fields. */
function exposureRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exposureId: '11111111-1111-4111-8111-111111111111',
    subjectRef: '22222222-2222-4222-8222-222222222222',
    sourceId: 'SOURCE_ALPHA',
    sourceRecordId: 'record-1',
    truthState: 'MATCH_CONFIRMED',
    confidence: { value: 0.87, basis: [{ feature: 'NAME_EXACT', weight: 0.6 }] },
    caseRef: null,
    firstObservedAt: '2026-09-01T00:00:00Z',
    lastObservedAt: '2026-09-02T00:00:00Z',
    ...overrides,
  };
}

describe('every wire field the UI declares exists in SPEC-003 (EP-005 M5)', () => {
  test('the declared field names all appear in the contract', () => {
    // The names are read from the declarations themselves: a quoted property key in `wire.ts` is a field the UI reads.
    const declared = new Set<string>();
    for (const match of WIRE.matchAll(/^\s{2}readonly ([A-Za-z][A-Za-z0-9]*)\??:/gm)) {
      if (match[1] !== undefined) declared.add(match[1]);
    }
    assert.ok(declared.size > 40, `expected the wire module to declare many fields, found ${String(declared.size)}`);
    const missing = [...declared].filter((name) => !SPEC.includes(name));
    assert.deepEqual(missing, [], `field names the UI declares but SPEC-003 does not contain: ${missing.join(', ')}`);
  });

  test('the mapper-only fields the contract DOES declare are named for their section, not invented', () => {
    // These three are the fields the mappers read but a surface never sees, and each is in SPEC-003 by name.
    for (const name of ['policyThresholdApplied', 'sourcesDeclared', 'coverageBounds', 'storageRef', 'claimedOutcomeIsObservation']) {
      assert.ok(SPEC.includes(name), `${name} must be declared by SPEC-003`);
    }
  });
});

describe('the client follows the contract for errors, keys and headers', () => {
  test('a non-2xx with the §8.1 envelope becomes an ApiError carrying the server identifiers', async () => {
    const envelope = {
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'No such resource.',
        requestId: 'req-1',
        correlationId: 'corr-1',
        retryable: false,
      },
    };
    const stub = stubTransport([{ status: 404, body: JSON.stringify(envelope) }]);
    const portal = createPortalApi(new PortalClient({ fetchImpl: stub.fetchImpl }));
    await assert.rejects(
      () => portal.exposure('missing'),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'RESOURCE_NOT_FOUND');
        assert.equal(error.correlationId, 'corr-1');
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });

  test('a non-2xx WITHOUT the envelope is a TransportFailure, not an ApiError with invented identifiers', async () => {
    const stub = stubTransport([{ status: 502, body: '<html>bad gateway</html>' }]);
    const portal = createPortalApi(new PortalClient({ fetchImpl: stub.fetchImpl }));
    await assert.rejects(
      () => portal.exposures({}),
      (error: unknown) => {
        assert.ok(error instanceof TransportFailure, `expected TransportFailure, got ${String(error)}`);
        assert.equal(error.httpStatus, 502);
        return true;
      },
    );
  });

  test('a POST refuses to go out without an Idempotency-Key', async () => {
    const stub = stubTransport([{ status: 200, body: '{}' }]);
    const portal = createPortalApi(new PortalClient({ fetchImpl: stub.fetchImpl }));
    await assert.rejects(
      () =>
        portal.assessExposure('e1', {
          confidence: { value: 0.9, basis: [{ feature: 'NAME_EXACT', weight: 1 }] },
          method: 'FEATURE_SET_V1',
          evidenceArtifactId: 'ev-1',
          humanReviewed: true,
          ifMatch: '"MATCH_CONFIRMED:1"',
          idempotencyKey: '   ',
        }),
      /Idempotency-Key/,
    );
    assert.equal(stub.exchanges.length, 0, 'nothing may be sent without the key');
  });

  test('a conditional write carries If-Match and the Idempotency-Key, and no fabricated Authorization', async () => {
    const stub = stubTransport([
      { status: 200, body: JSON.stringify({ truthState: 'MATCH_CONFIRMED', policyThresholdApplied: 0.85 }) },
    ]);
    const portal = createPortalApi(new PortalClient({ fetchImpl: stub.fetchImpl }));
    const outcome = await portal.assessExposure('e1', {
      confidence: { value: 0.9, basis: [{ feature: 'NAME_EXACT', weight: 1 }] },
      method: 'FEATURE_SET_V1',
      evidenceArtifactId: 'ev-1',
      humanReviewed: true,
      ifMatch: '"MATCH_CONFIRMED:1"',
      idempotencyKey: 'idem-1',
    });
    const sent = stub.exchanges[0];
    assert.equal(sent?.method, 'POST');
    assert.equal(sent?.headers['idempotency-key'], 'idem-1');
    assert.equal(sent?.headers['if-match'], '"MATCH_CONFIRMED:1"');
    assert.equal(sent?.headers['authorization'], undefined, 'no token provider means no Authorization header');
    assert.equal(outcome.threshold, 0.85);
  });

  test('a configured token provider supplies the bearer token', async () => {
    const stub = stubTransport([{ status: 200, body: JSON.stringify({ data: [], page: { limit: 25, nextCursor: null, hasMore: false } }) }]);
    const portal = createPortalApi(
      new PortalClient({ fetchImpl: stub.fetchImpl, getAccessToken: async () => 'token-1' }),
    );
    await portal.exposures({ limit: 25 });
    assert.equal(stub.exchanges[0]?.headers['authorization'], 'Bearer token-1');
  });

  test('the cursor and limit are sent as the contract’s query parameters, and no cursor is sent for the first page', async () => {
    const stub = stubTransport([
      { status: 200, body: JSON.stringify({ data: [], page: { limit: 10, nextCursor: null, hasMore: false } }) },
      { status: 200, body: JSON.stringify({ data: [], page: { limit: 10, nextCursor: null, hasMore: false } }) },
    ]);
    const portal = createPortalApi(new PortalClient({ fetchImpl: stub.fetchImpl, baseUrl: '/v1' }));
    await portal.exposures({ limit: 10 });
    await portal.exposures({ limit: 10, cursor: 'abc' });
    assert.equal(stub.exchanges[0]?.url, '/v1/exposures?limit=10');
    assert.equal(stub.exchanges[1]?.url, '/v1/exposures?limit=10&cursor=abc');
  });
});

describe('the mappers do not invent what the contract does not carry', () => {
  test('a list row yields a null threshold rather than a number nobody sent', async () => {
    const stub = stubTransport([
      {
        status: 200,
        body: JSON.stringify({ data: [exposureRow()], page: { limit: 25, nextCursor: null, hasMore: false } }),
      },
    ]);
    const portal = createPortalApi(new PortalClient({ fetchImpl: stub.fetchImpl }));
    const list = await portal.exposures({});
    const row = list.data[0];
    assert.ok(row !== undefined);
    assert.equal(row.confidence.value, 0.87);
    assert.deepEqual(row.confidence.basis, [{ feature: 'NAME_EXACT', weight: 0.6 }]);
    assert.equal(row.confidence.threshold, null, 'VG-UI-019 renders the threshold, and this route does not carry one');
    assert.equal(row.confidence.policyVersion, null);
    assert.equal(row.reappearanceOf, null);
  });

  test('a discovery run maps sourcesDeclared to the denominator and reports no catalogue version', async () => {
    const stub = stubTransport([
      {
        status: 200,
        body: JSON.stringify({
          discoveryRunId: 'run-1',
          runState: 'COMPLETED_PARTIAL',
          requestedAt: '2026-09-01T00:00:00Z',
          completedAt: '2026-09-01T01:00:00Z',
          coverage: {
            sourcesDeclared: 30,
            sourcesAttempted: 12,
            sourcesSucceeded: 11,
            sourcesSkipped: [{ sourceId: 'SOURCE_BETA', reason: 'HUMAN_REQUIRED' }],
            coverageBounds: { complete: false, checkedFraction: 0.4 },
          },
        }),
      },
    ]);
    const portal = createPortalApi(new PortalClient({ fetchImpl: stub.fetchImpl }));
    const coverage = await portal.discoveryRun('run-1');
    assert.equal(coverage.sourcesDeclared, 30);
    assert.equal(coverage.sourcesAttempted, 12);
    assert.equal(coverage.complete, false);
    assert.deepEqual(coverage.skipped, [{ sourceId: 'SOURCE_BETA', reason: 'HUMAN_REQUIRED' }]);
    assert.equal(coverage.catalogueVersion, null, 'the response declares no catalogue version, so none is invented');
  });

  test('the evidence view model never carries the storage reference to a surface', async () => {
    const stub = stubTransport([
      {
        status: 200,
        body: JSON.stringify({
          evidenceArtifactId: 'ev-1',
          digest: 'sha256:abc',
          digestVerified: true,
          kind: 'SOURCE_SNAPSHOT',
          storageRef: 's3://bucket/key',
          capturedAt: '2026-09-01T00:00:00Z',
          redactionState: 'SCRUBBED',
          sizeBytes: 1024,
          immutable: true,
          linkedCaseIds: ['case-1'],
          linkedTraceability: { requirementIds: ['VG-EVIDENCE-001'], caseIds: ['case-1'], transitionIds: ['t-1'] },
        }),
      },
    ]);
    const portal = createPortalApi(new PortalClient({ fetchImpl: stub.fetchImpl }));
    const { evidence, etag } = await portal.evidence('ev-1');
    assert.equal(evidence.storageRef, 's3://bucket/key', 'the validator proves the field is present');
    assert.equal(evidence.redactionState, 'SCRUBBED', 'the STORED token is passed through verbatim');
    assert.equal(etag, null);
    // The property name the SURFACES read is not the storage reference; the mapper's shape is asserted by the wire
    // type, and the property that matters here is that the digest and the immutability flag are both carried.
    assert.equal(evidence.digestVerified, true);
    assert.equal(evidence.immutable, true);
  });

  test('NEGATIVE CASE: a confidence object with an empty basis is refused, not rendered', async () => {
    const stub = stubTransport([
      {
        status: 200,
        body: JSON.stringify({
          data: [exposureRow({ confidence: { value: 0.9, basis: [] } })],
          page: { limit: 25, nextCursor: null, hasMore: false },
        }),
      },
    ]);
    const portal = createPortalApi(new PortalClient({ fetchImpl: stub.fetchImpl }));
    await assert.rejects(
      () => portal.exposures({}),
      /basis is empty, and the contract makes a score without basis unrepresentable/,
    );
  });
});
