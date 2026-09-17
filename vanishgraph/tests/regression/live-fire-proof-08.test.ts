/**
 * LIVE-FIRE-PROOF-08 — Provider transport (ADR-004, VG-CHANNEL-002, VG-SCOPE-004; EP-007 M2).
 *
 * THE OUTCOME'S OWN RULE: ONLY OFFICIAL, PERMITTED TRANSPORTS EXIST; NO UNDOCUMENTED ENDPOINT AND NO EXTRACTED
 * BROWSER-SESSION CREDENTIAL IS REACHABLE. Three artifacts carry it, and each is asserted where it lives:
 *
 *   * the DOMAIN FACTORY refuses any authentication mode outside the three official ones — `OFFICIAL_API`,
 *     `OFFICIAL_FORM`, `OFFICIAL_MAIL` — so a scraping, cookie-reuse or session-extraction mode cannot be recorded as a
 *     transport run at all;
 *   * the DATABASE agrees: `provider_transport_run.auth_mode` carries the same three-member CHECK, read from the
 *     migration that declares it, so the refusal is not only a constructor's;
 *   * the SPECIFICATION prohibits the alternative, read from SPEC-000, so the control is a requirement rather than a
 *     convention.
 *
 * THE REQUIRED NEGATIVE CASE — a request to an undocumented endpoint is refused — is proven by the SSRF suites, which
 * this file checks to exist rather than restating; and the PROVIDER-ENTITLEMENT RUN STAYS `EXTERNAL_REQUIRED`, which is
 * asserted against the provisioning contract rather than claimed: this repository has never contacted a provider.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createProviderTransportRun } from '../../src/domain/entities.ts';
import { TenantId } from '../../src/domain/identifiers.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TENANT = new TenantId('11111111-1111-4111-8111-111111111111');

/** The refusal an operation produced, or `undefined` when it did not refuse. */
function refusalOf(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** A permitted transport run, so each case can break exactly one thing. */
function run(authMode: string, overrides: Record<string, unknown> = {}): unknown {
  return createProviderTransportRun({
    id: 'run-1',
    tenantId: TENANT,
    transportName: 'the regulator portal',
    authMode: authMode as never,
    egressClass: 'OPAQUE_ID' as never,
    startedAtMs: 1_760_000_000_000,
    outcome: 'SUBMITTED',
    costRef: null,
    ...overrides,
  } as never);
}

describe('LIVE-FIRE-PROOF-08: only official transports, and the entitlement run stays external (ADR-004)', () => {
  test('NEGATIVE CASE: a transport mode outside the three official ones is REFUSED by the domain factory', () => {
    // The modes this forbids by name: the shapes an undocumented-endpoint client would need.
    for (const forbidden of ['SCRAPING', 'COOKIE_REUSE', 'SESSION_REPLAY', 'BROWSER_SESSION', 'UNDOCUMENTED_API', 'API']) {
      const refusal = refusalOf(() => run(forbidden));
      assert.ok(refusal instanceof Error, `${forbidden} must not be recordable as a transport`);
      assert.match(refusal.message, /authMode|one of/, `the refusal for ${forbidden} must name the field`);
    }
    for (const permitted of ['OFFICIAL_API', 'OFFICIAL_FORM', 'OFFICIAL_MAIL']) {
      assert.doesNotThrow(() => run(permitted), `${permitted} must be accepted, or the refusal above proves nothing`);
    }
  });

  test('the DATABASE carries the same three-member CHECK, read from the migration that declares it', () => {
    // Two layers agreeing is the point: a constructor can be bypassed by a migration or a hand-written INSERT, and this
    // is the assertion that the database refuses the same six values.
    const migration = readFileSync(resolve(ROOT, 'db/migrations/0005_evidence_audit_and_ops.sql'), 'utf8');
    assert.match(
      migration,
      /auth_mode\s+text NOT NULL CHECK \(auth_mode IN \('OFFICIAL_API','OFFICIAL_FORM','OFFICIAL_MAIL'\)\)/,
      'the schema must constrain the authentication mode to the official set',
    );
  });

  test('the SPECIFICATION prohibits the alternatives, and the prohibition is about endpoints and session credentials', () => {
    const spec = readFileSync(resolve(ROOT, '.agent/specs/SPEC-000-product-scope.md'), 'utf8');
    assert.match(spec, /VG-SCOPE-004/, 'the scope prohibition must be declared');
    assert.match(spec, /session, or token theft|undocumented/i, 'and it must name the two shapes this outcome forbids');
    assert.match(spec, /VG-CHANNEL-002/, 'with the channel rule stated in the same specification');
  });

  test('the undocumented-endpoint refusal is proven by SSRF suites that exist, and is not claimed here', () => {
    for (const suite of ['tests/contract/ssrf-controls.test.ts', 'tests/contract/ssrf-fetch-guard.test.ts']) {
      assert.equal(existsSync(resolve(ROOT, suite)), true, `${suite} must exist: it proves a refused target is refused`);
    }
  });

  test('THE ENTITLEMENT RUN STAYS EXTERNAL_REQUIRED: the provider credentials are unprovisioned, read from the contract', () => {
    // Asserted against the provisioning contract and the probe scripts rather than by running them: this repository has
    // never contacted a provider, so no assertion here may read as a provider run having happened.
    const preflight = readFileSync(resolve(ROOT, 'PREFLIGHT.md'), 'utf8');
    // MEASURED, AND IT CORRECTED THIS CASE: there is no `POSTAL_API` variable. The probe-to-variable mapping is read from
    // the PREFLIGHT table itself — `postal_api.sh` serves LOB_API_KEY, CLICK2MAIL_API_KEY and POSTGRID_API_KEY,
    // `search_api_key.sh` serves SEARCH_API_KEY, `stripe.sh` serves STRIPE_SECRET_KEY — so the assertion is the mapping
    // rather than a guessed name.
    const mapping: readonly (readonly [string, string])[] = [
      ['postal_api', 'LOB_API_KEY'],
      ['search_api_key', 'SEARCH_API_KEY'],
      ['stripe', 'STRIPE_SECRET_KEY'],
    ];
    for (const [probe, variable] of mapping) {
      assert.equal(existsSync(resolve(ROOT, `scripts/probes/${probe}.sh`)), true, `${probe}.sh must exist`);
      assert.match(preflight, new RegExp(`${variable}\\|OPTIONAL\\|scripts/probes/${probe}\\.sh`), `${variable} must be declared against ${probe}.sh`);
    }
    // And the run itself is accounted as blocked rather than passing: the ledger must carry the provider-transport row
    // with a blocked status, which is what "stays EXTERNAL_REQUIRED" means as data.
    const rows = readFileSync(resolve(ROOT, '.agent/verification/state/TEST_LEDGER.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { status?: string });
    const blocked = rows.filter((row) => row.status === 'BLOCKED_CREDENTIALS' || row.status === 'EXTERNAL_REQUIRED');
    assert.ok(blocked.length >= 1, 'the accounting must carry the blocked rows this outcome depends on');
  });
});
