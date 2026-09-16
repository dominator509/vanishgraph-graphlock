/**
 * Replay protection for the webhook ingress (SPEC-003 §6.2, VG-SEC-004).
 *
 * WHAT THE STORE MUST GUARANTEE, and why a `Map` cannot:
 *
 *   * **A repeated nonce is rejected ONCE, deterministically, before any state change.** §6.2 makes the difference
 *     explicit: the replay is "rejected once … not merely de-duplicated after the fact". A store that lets the
 *     second delivery through and cleans up afterwards has already run the effect twice.
 *   * **A repeated event id is NOT an error.** It is an idempotent redelivery: the ORIGINAL response is returned
 *     with `200` and `X-VG-Webhook-Replayed: true`, which requires the store to keep the response alongside the id.
 *   * **Unavailability FAILS CLOSED.** §6.2: `503 DEPENDENCY_UNAVAILABLE`, "never accept and dedupe later". This is
 *     why the port has no "best effort" member and why an implementation error is a refusal rather than a warning.
 *   * **A process-local `Map` is PROHIBITED** (EP-004 M7's fallback clause): it is in-memory state, which SPEC-006
 *     §10.3 forbids, and it silently stops protecting the moment a second process runs.
 *
 * THE TTL IS 3600 s AND IT IS ENFORCED BY EXPIRY, not by a cleanup pass: a record whose instant has passed is
 * treated as absent. A cleanup-only design leaves the window in which a stale nonce still blocks a legitimate
 * delivery — the opposite failure, and the one that makes an operator disable the control.
 */

/** What the ingress learns when it offers a delivery to the store. */
export type ReplayDecision =
  /** Neither the nonce nor the event id has been seen: the delivery may proceed. */
  | { readonly kind: 'NEW' }
  /** The same nonce, same key: a replay. No state change, `409 WEBHOOK_NONCE_REPLAY`. */
  | { readonly kind: 'NONCE_REPLAY' }
  /**
   * The same event id, same key: an idempotent redelivery. The stored response is returned with `200` and
   * `X-VG-Webhook-Replayed: true`.
   */
  | { readonly kind: 'EVENT_REPLAY'; readonly storedStatus: number; readonly storedBody: unknown };

export interface ReplayStore {
  /**
   * Claim a delivery.
   *
   * The nonce and the event id are claimed TOGETHER, in one call, because they answer the same question and a
   * two-call protocol has an interleaving in which both deliveries pass the first check.
   */
  begin(input: {
    readonly providerKeyId: string;
    readonly nonce: string;
    readonly eventId: string;
    readonly nowMs: number;
  }): Promise<ReplayDecision>;
  /** Record the response an event id produced, so a redelivery can return it unchanged. */
  complete(input: {
    readonly providerKeyId: string;
    readonly eventId: string;
    readonly status: number;
    readonly body: unknown;
    readonly nowMs: number;
  }): Promise<void>;
}

/** §6.2's TTL, in seconds. */
export const REPLAY_TTL_SECONDS = 3600;

/** Whether a recorded instant is still inside the window. Exported because both adapters must agree on it. */
export function isLive(recordedAtMs: number, nowMs: number): boolean {
  return nowMs - recordedAtMs < REPLAY_TTL_SECONDS * 1000;
}
