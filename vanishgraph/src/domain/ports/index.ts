/**
 * Domain ports (SPEC-001 §5) — declarations only.
 *
 * The domain declares what it needs; infrastructure satisfies it. Nothing in this file
 * may acquire an implementation: an implementation here would put a socket, a database
 * driver, or a clock read inside the layer whose whole value is that it is pure.
 * `tests/domain/events.test.ts` asserts that importing this module yields zero runtime
 * exports.
 *
 * `Clock` and `IdGenerator` are ports rather than ambient calls so that observation
 * windows (VG-VERIFY-002) and scheduled re-observation (VG-REAPPEAR-001) are testable
 * without sleeping and without network.
 */

import type {
  ActionId,
  EvidenceId,
  IdKind,
  SourceId,
  TenantId,
} from '../identifiers.ts';
import type {
  AuditEvent,
  JurisdictionPolicy,
  RemovalRecipe,
  SourceRecord,
} from '../entities.ts';
import type {
  ChannelName,
  EgressClass,
  EvidenceDigest,
  IdempotencyKey,
  Jurisdiction,
} from '../values.ts';

/** Injectable time. Enables deterministic window and reappearance tests. */
export interface Clock {
  nowMs(): number;
}

/** Opaque identifier creation, one kind at a time. */
export interface IdGenerator {
  next(kind: IdKind): string;
}

/** Content-addressed evidence storage with digest verification (VG-EVIDENCE-001). */
export interface EvidenceStore {
  put(content: Uint8Array, digest: EvidenceDigest): Promise<void>;
  get(digest: EvidenceDigest): Promise<Uint8Array>;
  /** True only when the stored bytes still hash to the digest. */
  verify(digest: EvidenceDigest): Promise<boolean>;
}

/** Read-only observation of a Source (VG-DISC-001). */
export interface SourceReader {
  read(sourceId: SourceId): Promise<readonly SourceRecord[]>;
}

export interface ChannelWriteRequest {
  readonly tenantId: TenantId;
  readonly actionId: ActionId;
  readonly recipe: RemovalRecipe;
  readonly channel: ChannelName;
  readonly idempotencyKey: IdempotencyKey;
  readonly payloadRef: string;
}

/** Exactly one external effect, or an honest ambiguity. Never a blind retry. */
export type ChannelWriteOutcome =
  | { readonly kind: 'ACCEPTED'; readonly receiptRef: string }
  | { readonly kind: 'REFUSED'; readonly reason: string }
  | { readonly kind: 'AMBIGUOUS'; readonly detail: string }
  | { readonly kind: 'HUMAN_GATE'; readonly gateKind: string; readonly reason: string };

export interface ChannelWriter {
  submit(request: ChannelWriteRequest): Promise<ChannelWriteOutcome>;
}

export interface ObserveRequest {
  readonly tenantId: TenantId;
  readonly caseId: string;
  readonly sourceId: SourceId;
  readonly method: string;
  /** The identity that performed the action. Must differ from the observer. */
  readonly actingIdentity: string;
}

export type ObservationOutcome =
  | { readonly kind: 'ABSENT'; readonly evidenceId: EvidenceId }
  | { readonly kind: 'PRESENT'; readonly evidenceId: EvidenceId }
  | { readonly kind: 'INCONCLUSIVE'; readonly reason: string };

/** Observation through a path distinct from the acting path (VG-VERIFY-001). */
export interface IndependentObserver {
  observe(request: ObserveRequest): Promise<ObservationOutcome>;
}

/** Versioned jurisdiction policy lookup (VG-POLICY-001). */
export interface PolicyRepository {
  policyInForce(
    jurisdiction: Jurisdiction,
    atMs: number,
  ): Promise<JurisdictionPolicy | undefined>;
}

/** Append-only event sink (VG-EVIDENCE-003). */
export interface AuditSink {
  append(events: readonly AuditEvent[]): Promise<void>;
}

export interface EgressRequest {
  readonly tenantId: TenantId;
  readonly destination: string;
  readonly egressClass: EgressClass;
  readonly payloadRef: string;
}

/** Classify and gate data before any egress. Deny-by-default (VG-EGRESS-001). */
export interface EgressGate {
  classify(payload: unknown): EgressClass;
  authorize(request: EgressRequest): Promise<boolean>;
}

/** Secret access without database persistence (VG-SEC-002). */
export interface SecretResolver {
  resolve(name: string): Promise<string>;
}

/**
 * Key management and value hashing (SPEC-002 §4).
 *
 * Re-exported rather than redeclared: SPEC-001 §5.1 rule 1 wants one FILE per port, so the
 * declarations live in `./key-provider.ts` and the barrel exists so callers import from
 * `ports/index.ts` as they do for every other port. Declaring them again here would create two
 * sources of truth for the same interface.
 */
export type { KeyProvider, ValueHasher, WrappedKey } from './key-provider.ts';
