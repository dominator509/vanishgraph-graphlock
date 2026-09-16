/**
 * Durable replay protection for the webhook ingress (SPEC-003 §6.2).
 *
 * TWO BINDINGS, ONE CONTRACT. `ValkeyReplayStore` is the production binding §6.2 names (the coordination store);
 * `FileReplayStore` is the DURABLE fallback EP-004 M7 authorises when no coordination store is provisioned —
 * "a durable append-only file with an exclusive lock for the credential-free contract path, keeping the Valkey
 * adapter as the production binding". A process-local `Map` is prohibited by the same clause, and neither binding
 * here uses one: the file store's state is the file, so a restart, or a second process, sees the same records.
 *
 * WHY THE FILE STORE IS APPEND-ONLY. A rewrite-in-place store has a window in which a crash loses the claim that
 * was already answered `NEW` — and that window is exactly a double execution. Appending a line is atomic enough for
 * the claim to survive the process, and the file is read back on open.
 *
 * FAIL-CLOSED ON EVERY ERROR. §6.2 requires `503 DEPENDENCY_UNAVAILABLE` rather than "accept and dedupe later", so
 * an I/O failure raises `ReplayUnavailableError` and the route maps it to 503. An implementation that swallowed the
 * error would convert a coordination outage into silent replay exposure.
 */

import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ReplayDecision, ReplayStore } from '../../application/contracts/replay-store.ts';
import { REPLAY_TTL_SECONDS, isLive } from '../../application/contracts/replay-store.ts';

/** The ingestion's own failure, so a route can tell it apart from a malformed delivery. */
export class ReplayUnavailableError extends Error {
  readonly code = 'DEPENDENCY_UNAVAILABLE' as const;
  constructor(reason: string) {
    super(`replay store unavailable: ${reason}`);
    this.name = 'ReplayUnavailableError';
  }
}

interface FileRecord {
  readonly key: string;
  readonly nonce: string;
  readonly eventId: string;
  readonly atMs: number;
  readonly response?: { readonly status: number; readonly body: unknown };
}

/**
 * A durable, append-only, single-use claim log.
 *
 * THE LOCK IS AN EXCLUSIVE FILE, held for the duration of a claim, because the read-decide-append sequence is not
 * atomic by itself: two processes could both read "absent" and both append. The lock file is created with the `wx`
 * flag, so acquiring it IS the atomic step, and a stale lock (a process that died holding it) is broken after the
 * TTL so an outage cannot wedge the ingress permanently.
 */
export class FileReplayStore implements ReplayStore {
  readonly #path: string;
  readonly #lockPath: string;

  constructor(options: { readonly path: string }) {
    this.#path = options.path;
    this.#lockPath = `${options.path}.lock`;
    mkdirSync(dirname(options.path), { recursive: true });
    if (!existsSync(options.path)) writeFileSync(options.path, '', 'utf8');
  }

  async begin(input: {
    readonly providerKeyId: string;
    readonly nonce: string;
    readonly eventId: string;
    readonly nowMs: number;
  }): Promise<ReplayDecision> {
    const release = this.#acquire(input.nowMs);
    try {
      // THE NONCE IS CHECKED BEFORE THE EVENT ID, matching §6.2's ordering: a replayed byte-for-byte delivery is a
      // replay (409), not an idempotent redelivery, even though it also carries a known event id.
      //
      // AND THE LOG IS READ NEWEST-FIRST, because an event id has TWO records: the claim written by `begin` and the
      // response written by `complete`. MEASURED DEFECT this corrects: scanning forward found the CLAIM, which
      // carries no response, so a redelivery reported the default `200` instead of the `202` the original produced.
      const records = this.#read();
      const livesAt = (key: string): FileRecord | undefined => {
        for (let index = records.length - 1; index >= 0; index -= 1) {
          const record = records[index];
          if (record !== undefined && record.key === key && isLive(record.atMs, input.nowMs)) return record;
        }
        return undefined;
      };
      const nonceKey = `${input.providerKeyId}\u0000${input.nonce}`;
      const eventKey = `${input.providerKeyId}\u0000event\u0000${input.eventId}`;

      if (livesAt(nonceKey) !== undefined) return { kind: 'NONCE_REPLAY' };

      const eventSeen = livesAt(eventKey);
      if (eventSeen !== undefined) {
        return {
          kind: 'EVENT_REPLAY',
          // A record whose response was never written (a crash between claim and completion) reports `200` with an
          // empty body rather than a fabricated original: the delivery WAS processed, and inventing a body would be
          // the one thing worse than not having one.
          storedStatus: eventSeen.response?.status ?? 200,
          storedBody: eventSeen.response?.body ?? { accepted: true, replayedWithoutStoredBody: true },
        };
      }

      // BOTH are appended before the delivery proceeds, so a crash after this point leaves the claim recorded —
      // the ingress refuses a retry rather than executing the effect twice.
      this.#append({ key: nonceKey, nonce: input.nonce, eventId: input.eventId, atMs: input.nowMs });
      this.#append({ key: eventKey, nonce: input.nonce, eventId: input.eventId, atMs: input.nowMs });
      return { kind: 'NEW' };
    } catch (error) {
      if (error instanceof ReplayUnavailableError) throw error;
      throw new ReplayUnavailableError(error instanceof Error ? error.message : String(error));
    } finally {
      release();
    }
  }

  async complete(input: {
    readonly providerKeyId: string;
    readonly eventId: string;
    readonly status: number;
    readonly body: unknown;
    readonly nowMs: number;
  }): Promise<void> {
    const release = this.#acquire(input.nowMs);
    try {
      this.#append({
        key: `${input.providerKeyId}\u0000event\u0000${input.eventId}`,
        nonce: '',
        eventId: input.eventId,
        atMs: input.nowMs,
        response: { status: input.status, body: input.body },
      });
    } catch (error) {
      if (error instanceof ReplayUnavailableError) throw error;
      throw new ReplayUnavailableError(error instanceof Error ? error.message : String(error));
    } finally {
      release();
    }
  }

  /** Read every live record. Lines are ignored when unparseable or expired, never repaired. */
  #read(): FileRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch (error) {
      throw new ReplayUnavailableError(error instanceof Error ? error.message : String(error));
    }
    const out: FileRecord[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line) as FileRecord);
      } catch {
        // A torn final line from a crash mid-append. Skipping it is safe: the claim it was writing is one the
        // delivery never received an answer for, so the provider will retry and be claimed then.
        continue;
      }
    }
    return out;
  }

  #append(record: FileRecord): void {
    try {
      appendFileSync(this.#path, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      throw new ReplayUnavailableError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Take the exclusive lock, breaking a stale one older than the TTL. Returns the release function. */
  #acquire(nowMs: number): () => void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.#lockPath, 'wx');
        closeSync(fd);
        return () => {
          try {
            // RELEASE IS DELETION. Emptying the file first would leave a marker a later reader could mistake for a
            // held lock, and the stale-lock timeout would then have to recover from a release that already happened.
            unlinkSync(this.#lockPath);
          } catch {
            // A failed release must not fail the DELIVERY: the stale-lock timeout is what recovers it.
          }
        };
      } catch {
        // Held. Break it only if it is older than the TTL, which is the one case where the holder cannot still be
        // working on a delivery whose timestamp is inside the window.
        let heldForMs: number;
        try {
          heldForMs = nowMs - statSync(this.#lockPath).mtimeMs;
        } catch {
          continue;
        }
        if (heldForMs > REPLAY_TTL_SECONDS * 1000) {
          try {
            unlinkSync(this.#lockPath);
          } catch {
            // Another process broke it first, which is the outcome this attempt wanted.
          }
          continue;
        }
        throw new ReplayUnavailableError('the replay log is locked by another delivery');
      }
    }
    throw new ReplayUnavailableError('could not acquire the replay log lock');
  }
}

/**
 * The coordination-store binding §6.2 names.
 *
 * CONSTRUCTED ONLY WHEN `VALKEY_URL` IS CONFIGURED, and it does not paper over a missing connection: an error from
 * the client is a `ReplayUnavailableError`, which the route maps to `503`. The client is injected rather than
 * imported so this file has no dependency on a Redis client's lifecycle, and the two scripted operations are the
 * only ones it performs:
 *
 *   * `SET key value NX PX <ttl>` for the nonce: the claim is the SET, so a second delivery's SET fails and the
 *     decision is taken from THAT — no read-then-write window.
 *   * `GET`/`SET` for the event id, where a hit returns the stored response.
 */
export interface ValkeyCommands {
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class ValkeyReplayStore implements ReplayStore {
  readonly #commands: ValkeyCommands;

  constructor(options: { readonly commands: ValkeyCommands }) {
    this.#commands = options.commands;
  }

  async begin(input: {
    readonly providerKeyId: string;
    readonly nonce: string;
    readonly eventId: string;
    readonly nowMs: number;
  }): Promise<ReplayDecision> {
    try {
      const eventKey = `vg:webhook:${input.providerKeyId}:event:${input.eventId}`;
      const stored = await this.#commands.get(eventKey);
      if (stored !== null) {
        const parsed = JSON.parse(stored) as { status?: number; body?: unknown };
        return {
          kind: 'EVENT_REPLAY',
          storedStatus: typeof parsed.status === 'number' ? parsed.status : 200,
          storedBody: parsed.body ?? { accepted: true, replayedWithoutStoredBody: true },
        };
      }
      const claimed = await this.#commands.setNx(
        `vg:webhook:${input.providerKeyId}:nonce:${input.nonce}`,
        '1',
        REPLAY_TTL_SECONDS,
      );
      // THE CLAIM IS THE SET. `false` means another delivery already claimed this nonce, which is the replay.
      if (!claimed) return { kind: 'NONCE_REPLAY' };
      return { kind: 'NEW' };
    } catch (error) {
      throw new ReplayUnavailableError(error instanceof Error ? error.message : String(error));
    }
  }

  async complete(input: {
    readonly providerKeyId: string;
    readonly eventId: string;
    readonly status: number;
    readonly body: unknown;
    readonly nowMs: number;
  }): Promise<void> {
    try {
      await this.#commands.set(
        `vg:webhook:${input.providerKeyId}:event:${input.eventId}`,
        JSON.stringify({ status: input.status, body: input.body }),
        REPLAY_TTL_SECONDS,
      );
    } catch (error) {
      throw new ReplayUnavailableError(error instanceof Error ? error.message : String(error));
    }
  }
}
