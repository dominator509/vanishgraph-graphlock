/**
 * The fetch guard: no connection is made to a refused target, and a redirect is re-classified (SPEC-000 VG-SEC-003; EP-006 M9).
 *
 * The transport is the suite's own listener, so "zero connection attempts" is an OBSERVATION rather than the caller's
 * report: the listener records every call it receives, and a refusal must leave it empty.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { guardedFetch, type GuardedTransport } from '../../src/adapters/ssrf/fetch-guard.ts';
import type { TargetResolver } from '../../src/adapters/ssrf/target-classifier.ts';

/** A transport that records what it was asked for. The recording IS the observation. */
function listener(responses: Readonly<Record<string, { readonly status: number; readonly body: string; readonly location?: string | undefined }>> = {}): {
  readonly transport: GuardedTransport;
  readonly seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    transport: async (url) => {
      seen.push(url);
      return responses[url] ?? { status: 200, body: 'ok' };
    },
  };
}

const resolver: TargetResolver = {
  resolve: (hostname) =>
    ({
      'public.example': ['93.184.216.34'],
      'internal.example': ['10.0.0.5'],
      'mixed.example': ['93.184.216.34', '127.0.0.1'],
      'redirect.example': ['93.184.216.34'],
    })[hostname] ?? [],
};

describe('the guard makes no connection to a refused target (VG-SEC-003)', () => {
  test('the metadata address, localhost and a private name each leave the listener empty', async () => {
    for (const url of [
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/admin',
      'https://internal.example/api',
      'https://mixed.example/api',
      'https://nowhere.example/',
      'http://public.example/',
    ]) {
      const target = listener();
      const result = await guardedFetch(url, { resolver, transport: target.transport });
      assert.equal(result.ok, false, `${url} must be refused`);
      assert.equal(result.connections, 0);
      assert.deepEqual(target.seen, [], `${url}: the transport must not be called`);
    }
  });

  test('a public target is fetched exactly once, and the classification is reported', async () => {
    const target = listener({ 'https://public.example/api': { status: 200, body: 'content' } });
    const result = await guardedFetch('https://public.example/api', { resolver, transport: target.transport });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.body, 'content');
    assert.equal(result.connections, 1);
    assert.deepEqual(target.seen, ['https://public.example/api']);
    assert.equal(result.classification?.classifications[0]?.targetClass, 'PUBLIC');
  });

  test('a redirect is NOT followed by default, and the connection count shows it was not', async () => {
    const target = listener({
      'https://redirect.example/go': { status: 302, body: '', location: 'https://169.254.169.254/' },
    });
    const result = await guardedFetch('https://redirect.example/go', { resolver, transport: target.transport });
    // The response is returned as it stands; the redirect is not followed, so the metadata address is never contacted.
    assert.equal(result.status, 302);
    assert.deepEqual(target.seen, ['https://redirect.example/go']);
    assert.equal(result.connections, 1);
  });

  test('a followed redirect is RE-CLASSIFIED, so a hop to a private address is refused', async () => {
    const target = listener({
      'https://redirect.example/go': { status: 302, body: '', location: 'https://internal.example/api' },
    });
    const result = await guardedFetch('https://redirect.example/go', { resolver, transport: target.transport, followRedirects: true });
    assert.equal(result.ok, false);
    assert.match(result.detail, /10\.0\.0\.5 \(PRIVATE\)/);
    // ONE connection was made — the first hop — and the second was refused before it happened. That is the distinction
    // the count exposes: the guard does not pretend the first request was never sent.
    assert.equal(result.connections, 1);
    assert.deepEqual(target.seen, ['https://redirect.example/go']);
  });

  test('a redirect chain within the limit is followed, each hop classified', async () => {
    const target = listener({
      'https://redirect.example/one': { status: 302, body: '', location: 'https://redirect.example/two' },
      'https://redirect.example/two': { status: 302, body: '', location: 'https://public.example/final' },
      'https://public.example/final': { status: 200, body: 'final' },
    });
    const result = await guardedFetch('https://redirect.example/one', {
      resolver: { resolve: (hostname) => (hostname === 'public.example' || hostname === 'redirect.example' ? ['93.184.216.34'] : []) },
      transport: target.transport,
      followRedirects: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.body, 'final');
    assert.deepEqual(target.seen, ['https://redirect.example/one', 'https://redirect.example/two', 'https://public.example/final']);
    assert.equal(result.connections, 3);
  });

  test('a chain longer than the limit is abandoned rather than followed indefinitely', async () => {
    const target = listener({
      'https://redirect.example/a': { status: 302, body: '', location: 'https://redirect.example/b' },
      'https://redirect.example/b': { status: 302, body: '', location: 'https://redirect.example/c' },
      'https://redirect.example/c': { status: 302, body: '', location: 'https://redirect.example/d' },
    });
    const result = await guardedFetch('https://redirect.example/a', {
      resolver: { resolve: () => ['93.184.216.34'] },
      transport: target.transport,
      followRedirects: true,
      maxRedirects: 2,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TOO_MANY_REDIRECTS');
    assert.equal(target.seen.length, 3, 'one original plus two followed hops');
  });
});
