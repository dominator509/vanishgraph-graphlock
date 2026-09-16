/**
 * The replay half of the webhook gate (SPEC-003 §6.2; VG-SEC-004; EP-006 M9).
 *
 * A THIN COMPOSITION ON PURPOSE. EP-004 built signature verification and a durable replay store; what was missing was the
 * step that turns a verified delivery into a single-use record, and this function is that step rather than a second
 * verifier. It refuses a nonce it has already seen and says which refusal it is, so the caller can distinguish a replay
 * from a signature failure — the two mean different things to an operator.
 */

export interface SignatureGateInput {
  readonly verified: { readonly nonce: string; readonly eventId: string };
  /** Whether the nonce is already recorded as used. The caller owns the store; this function owns the decision. */
  readonly alreadySeen: boolean;
}

export type SignatureGateResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly code: 'NONCE_REPLAY'; readonly detail: string };

export function checkWebhookSignature(input: SignatureGateInput): SignatureGateResult {
  if (input.verified.nonce.length === 0) {
    // An empty nonce cannot be recorded as used, so a delivery carrying one could be replayed indefinitely.
    return {
      ok: false,
      code: 'NONCE_REPLAY',
      detail: 'the delivery carries no nonce, so it cannot be recorded as used and every copy of it would look new',
    };
  }
  if (input.alreadySeen) {
    return {
      ok: false,
      code: 'NONCE_REPLAY',
      detail: `nonce ${input.verified.nonce} has already been used, so this delivery is a replay and is refused before any parsing or dispatch`,
    };
  }
  return { ok: true, detail: `nonce ${input.verified.nonce} is new and is now recorded as used` };
}
