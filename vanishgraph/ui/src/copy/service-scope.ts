/**
 * The service-scope statement, verbatim (SPEC-004 §11 VG-UI-070).
 *
 * ONE CONSTANT, FOUR CONSUMERS. The specification requires this exact block on `/portal/limitations`, in the footer of
 * every `/portal` route, on `/admin/metrics`, and in the header of the removal-effectiveness dashboard — and it requires
 * a copy-equality test. Four hand-written copies would be four chances to soften the sentence "it cannot guarantee that
 * a record is removed", which is the one line a sales-minded edit would remove first; one constant cannot drift from
 * itself.
 *
 * THE TEXT IS TRANSCRIBED FROM THE SPECIFICATION, and `tests/contract/truth-state-copy.test.ts` asserts equality after
 * whitespace normalisation by parsing the specification file — so a paraphrase fails the suite rather than shipping.
 */

export const SERVICE_SCOPE_STATEMENT =
  'What VanishGraph does: it submits privacy removal requests through lawful channels, records what happened, and ' +
  'independently verifies the result at each Source. What VanishGraph cannot do: it cannot guarantee that a record is ' +
  'removed. It does not control what a Controller does after a request is accepted, it cannot remove copies held in ' +
  'backups or by other parties it did not check, and it does not act for anyone who is not a verified subject or an ' +
  'authorized dependent.';

/**
 * The surfaces that must render it (§11), named here so a later milestone's inventory test can assert each one does —
 * and so a consumer that is NOT on this list is visibly out of contract.
 */
export const SERVICE_SCOPE_SURFACES: readonly string[] = [
  '/portal/limitations',
  '/portal (footer of every route)',
  '/admin/metrics',
  'removal-effectiveness dashboard header',
];
