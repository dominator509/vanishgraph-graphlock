/**
 * The fetch guard: the only outbound path in the codebase (SPEC-000 VG-SEC-003; EP-006 M9).
 *
 * THE CLASSIFIER DECIDES AND THIS MODULE OBEYS. There is no branch here that connects to a target the classifier refused,
 * and the connection count the caller observes is the classifier's `connectionAttempts` — so a refusal cannot be reported
 * while a connection was made, because the connection is made by the same function that reads the decision.
 *
 * THE TRANSPORT IS INJECTED, WHICH IS WHAT MAKES THE ZERO-CONNECTION PROPERTY OBSERVABLE. A guard that called the platform
 * fetch internally could not be tested for "no connection was attempted" without a network observer; taking the transport
 * as a parameter means the suite's own listener is the observation, and it records nothing on a refusal.
 *
 * REDIRECTS ARE REFUSED BY DEFAULT. Where a caller opts in, the guard re-classifies the new target before following —
 * a redirect to a private address is the classic way past a check that ran only on the original URL.
 */

import {
  classifyTarget,
  type SsrfDecision,
  type TargetResolver,
} from './target-classifier.ts';

/** The transport, injected. Returning a response is the ONLY thing that counts as a connection. */
export type GuardedTransport = (url: string) => Promise<{ readonly status: number; readonly body: string; readonly location?: string | undefined }>;

export interface FetchGuardOptions {
  readonly resolver: TargetResolver;
  readonly transport: GuardedTransport;
  /** Following is off unless a caller asks for it, and a followed redirect is re-classified. */
  readonly followRedirects?: boolean | undefined;
  /** How many redirects may be followed, when following is enabled at all. */
  readonly maxRedirects?: number | undefined;
}

export interface GuardedFetchResult {
  readonly ok: boolean;
  readonly code?: 'TARGET_REFUSED' | 'SCHEME_NOT_ALLOWED' | 'RESOLUTION_FAILED' | 'HOST_MISSING' | 'TOO_MANY_REDIRECTS';
  readonly detail: string;
  readonly status?: number;
  readonly body?: string;
  /** How many connections this call actually opened. A refusal is zero. */
  readonly connections: number;
  /** The classification of the final target, so a caller can record what it reached. */
  readonly classification?: SsrfDecision;
}

/** Fetch through the guard. A refused target produces the classified error and NO transport call. */
export async function guardedFetch(url: string, options: FetchGuardOptions): Promise<GuardedFetchResult> {
  const maxRedirects = options.followRedirects === true ? (options.maxRedirects ?? 3) : 0;
  let current = url;
  let connections = 0;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const decision = classifyTarget({ url: current, resolver: options.resolver });
    if (!decision.allow) {
      return {
        ok: false,
        code: decision.code === 'TARGET_REFUSED' || decision.code === undefined ? 'TARGET_REFUSED' : decision.code,
        detail: decision.detail,
        connections,
        classification: decision,
      };
    }
    // THE ONLY PLACE A CONNECTION IS COUNTED, and it is counted because the transport was actually called.
    connections += 1;
    const response = await options.transport(current);
    if (response.location === undefined || response.status < 300 || response.status >= 400) {
      return { ok: true, detail: 'the target was reached and answered', status: response.status, body: response.body, connections, classification: decision };
    }
    if (options.followRedirects !== true) {
      return {
        ok: true,
        detail: 'a redirect response was returned without following it, because following is off by default',
        status: response.status,
        body: response.body,
        connections,
        classification: decision,
      };
    }
    // THE NEXT TARGET IS CLASSIFIED ON THE NEXT ITERATION, which is the re-check the plan requires: a redirect to a
    // private address is refused before the follow-up connection, and the count above shows the first hop was made.
    current = response.location;
  }
  return {
    ok: false,
    code: 'TOO_MANY_REDIRECTS',
    detail: `more than ${String(maxRedirects)} redirects were followed, so the fetch was abandoned`,
    connections,
  };
}

