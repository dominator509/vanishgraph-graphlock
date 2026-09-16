/**
 * Shared support for the black-box suite (EP-004 M8).
 *
 * IT RE-EXPORTS THE HARNESS RATHER THAN REACHING PAST IT. `tests/db/harness.ts` holds the DSN plumbing and the
 * `asTenant`/`exec` helpers, and this module exists so the black-box suite imports ONE local path — the suite is
 * allowed to set up a tenant (a precondition, not an oracle) while being forbidden from reading a table to decide a
 * result. Keeping the import here makes that boundary visible in one place instead of scattered through the suite.
 */

export { appDsn, asTenant, exec, ownerDsn, withoutTenant, PROJECT_ROOT } from '../db/harness.ts';

/**
 * A tenant id for the black-box suite.
 *
 * The suite MINTS ITS OWN rather than using the seeded one: creating subjects inside the shared seeded tenant would
 * change what every other suite observes (ASSUMPTIONS §3.27), and the black-box suite writes subjects by design.
 */
export const TEST_TENANT_PLACEHOLDER = 'minted per run';
