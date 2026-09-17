/**
 * Forced failure: authority must fail CLOSED (DOD-014; SPEC-005 VG-AUTHZ-001/005/006, SPEC-000 VG-AUTHZ-001; EP-007 M3).
 *
 * WHAT MAKES THIS A FORCED-FAILURE SUITE RATHER THAN ANOTHER HAPPY-PATH ONE: every case here makes the thing that
 * supplies authority FAIL — expired, revoked, absent, contested, or the reader itself throwing — and asserts that the
 * refusal happens with no grant returned. DOD-014's subject is the behaviour of a control when its input is broken,
 * and the failure that matters is the one where a refusal is *mistaken* for a success: an unavailable reader that is
 * treated as "no objection" is the defect this file exists to make impossible.
 *
 * THE FOUR SHAPES OF "BROKEN INPUT", and why each is separate:
 *   * an EXPIRED grant — the input is present, well formed, and outside its window;
 *   * a REVOKED grant — present, well formed, and withdrawn;
 *   * NO GRANT AT ALL — the reader answers `undefined`, which must not become a pass;
 *   * A READER THAT THROWS — the authority store is unreachable, and the throw must propagate rather than being
 *     caught into a decision. Nothing in this repository may convert "I could not check" into "checked, fine".
 *
 * WHAT IT DOES NOT PROVE: that a database round trip fails closed. That is `tests/integration/authority-at-execution
 * .test.ts`, which drives the real adapter against PostgreSQL. This suite is about the pure decision, which is where the
 * "swallowed failure" defect would live if it existed.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuthorityError,
  mintGrant,
  verifyAtExecutionTime,
  type AuthorityGrant,
} from '../../src/application/security/authority-service.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SUBJECT = 'subject-opaque-1';
const NOW = '2026-09-16T00:00:00Z';
const LATER = '2026-09-17T00:00:00Z';

/** A grant that is valid at `NOW`, built by the real factory so the fixture cannot hold a shape `mintGrant` refuses. */
function grant(overrides: Partial<Parameters<typeof mintGrant>[0]> = {}): AuthorityGrant {
  return mintGrant({
    tenantId: TENANT,
    subjectRef: SUBJECT,
    kind: 'SELF',
    scope: ['discovery'],
    now: NOW,
    identityLevel: 'IAL2',
    evidenceArtifactId: null,
    noticeArtifactId: null,
    coolingOffUntil: null,
    authorityGrantId: 'grant-1',
    expiresAt: LATER,
    ...overrides,
  });
}

/** The refusal an operation produced, or `undefined` when it did not refuse. */
async function refusalOf(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Assert a refusal with a specific code, and that it is a decision rather than an unrelated exception. */
function assertRefusal(refusal: unknown, code: AuthorityError['code']): void {
  assert.ok(refusal instanceof AuthorityError, `expected an AuthorityError, got: ${String(refusal)}`);
  assert.equal(refusal.code, code);
  assert.ok(refusal.message.length > 0, 'a refusal must say why');
}

describe('forced failure: authority fails closed (DOD-014)', () => {
  test('an EXPIRED grant is refused at execution time, not admitted', async () => {
    // MEASURED, AND THE FIRST VERSION OF THIS TEST GOT IT WRONG: `mintGrant` REFUSES to build a grant whose window has
    // already closed (`expiresAt <= now`), so an "expired fixture" cannot be constructed at all — my first attempt
    // called `grant({ expiresAt: NOW })` and threw inside the fixture rather than in the assertion. The factory's
    // refusal is itself fail-closed behaviour and is asserted here; the in-flight case is then the same grant evaluated
    // at a later instant, which is what the execution-time check exists for.
    assert.throws(() => grant({ expiresAt: NOW }), /expiresAt .* is not after/, 'the factory must refuse a closed window');
    const valid = grant();
    const refusal = await refusalOf(() => verifyAtExecutionTime('grant-1', LATER, async () => valid));
    assertRefusal(refusal, 'AUTHORITY_EXPIRED');
    // And the same value at its own instant is admitted, so the refusal above is about the window and not the fixture.
    const admitted = await verifyAtExecutionTime('grant-1', NOW, async () => valid);
    assert.equal(admitted.authorityGrantId, 'grant-1');
  });

  test('a REVOKED grant is refused even though every other field is valid', async () => {
    const revoked: AuthorityGrant = { ...grant(), revokedAt: NOW };
    const refusal = await refusalOf(() => verifyAtExecutionTime('grant-1', NOW, async () => revoked));
    assertRefusal(refusal, 'AUTHORITY_REVOKED');
  });

  test('a CONTESTED grant is refused, because a subject’s dispute suspends writes immediately', async () => {
    const contested: AuthorityGrant = { ...grant(), contestedAt: NOW };
    const refusal = await refusalOf(() => verifyAtExecutionTime('grant-1', NOW, async () => contested));
    assertRefusal(refusal, 'AUTHORITY_REVOKED');
  });

  test('NO GRANT is a refusal, never an implicit pass', async () => {
    // The dangerous conversion this asserts against: `undefined` from the reader becoming "nothing to object to".
    const refusal = await refusalOf(() => verifyAtExecutionTime('grant-1', NOW, async () => undefined));
    assertRefusal(refusal, 'AUTHORITY_GRANT_INVALID');
  });

  test('a reader that THROWS propagates: an unreachable authority store is not a decision', async () => {
    const outage = new Error('authority store unreachable');
    const refusal = await refusalOf(() =>
      verifyAtExecutionTime('grant-1', NOW, async () => {
        throw outage;
      }),
    );
    assert.equal(refusal, outage, 'the original failure must reach the caller, not be swallowed into a verdict');
    assert.equal(refusal instanceof AuthorityError, false, 'and it must not be dressed up as a policy refusal');
  });

  test('a grant inside its COOLING-OFF window is refused, and admitted once the window passes', async () => {
    // THE EXPIRY MUST OUTLIVE THE COOLING-OFF WINDOW, OR THIS ASSERTS THE WRONG REFUSAL: with both set to `LATER`, the
    // second phase was refused as EXPIRED rather than admitted, which is what the first version of this test measured.
    const cooling: AuthorityGrant = { ...grant({ expiresAt: '2026-09-20T00:00:00Z' }), coolingOffUntil: LATER };
    const refusal = await refusalOf(() => verifyAtExecutionTime('grant-1', NOW, async () => cooling));
    assertRefusal(refusal, 'AUTHORITY_GRANT_INVALID');
    const admitted = await verifyAtExecutionTime('grant-1', LATER, async () => cooling);
    assert.equal(admitted.authorityGrantId, 'grant-1');
  });

  test('the reader is consulted on EVERY call, so a cached grant cannot outlive its window', async () => {
    // A caller holding an earlier decision must not be able to reuse it: the function takes a reader precisely so that
    // "the grant was valid when the request started" is not an argument it can be given.
    let calls = 0;
    const valid = grant();
    const reader = async (): Promise<AuthorityGrant> => {
      calls += 1;
      return calls === 1 ? valid : { ...valid, revokedAt: NOW };
    };
    await verifyAtExecutionTime('grant-1', NOW, reader);
    const refusal = await refusalOf(() => verifyAtExecutionTime('grant-1', NOW, reader));
    assertRefusal(refusal, 'AUTHORITY_REVOKED');
    assert.equal(calls, 2, 'the second verification must have read again rather than reusing the first answer');
  });
});
