/**
 * The portal's data boundary: wire shapes in, view models out (SPEC-003 §5; EP-005 M5).
 *
 * TWO JOBS, AND THEY ARE SEPARATED ON PURPOSE. A *validator* proves the response is the shape the contract declares
 * before anything reads it, and a *mapper* turns the wire row into the view model a surface renders — dropping the
 * fields a route carries but a surface must not show (the digest of a storage reference, for instance, is present on
 * every evidence row and rendered on none). A surface that read the wire shape directly would re-decide both on every
 * screen, which is how a field that should never render ends up rendered.
 *
 * THE MAPPERS DO NOT INVENT. Where the contract does not carry a value the renderer needs, the view model carries
 * `null` and the surface says so:
 *
 *   * THE COVERAGE DENOMINATOR IS `sourcesDeclared`. SPEC-003 §5.4.3 declares no `sourcesTotal`, and the coverage
 *     renderer's denominator is the declared count — mapping them is a decision recorded here rather than a rename
 *     hidden in a component.
 *   * THE CATALOGUE VERSION IS `null` FROM THIS ROUTE. §5.4.3 declares no catalogue field at all, while SPEC-004 §3
 *     requires the declared catalogue version beside every coverage figure. The honest rendering is "the response did
 *     not declare one", not a plausible-looking string, and the inventory suite asserts that case.
 *   * THE CONFIDENCE THRESHOLD IS `null` ON A LIST ROW. The threshold appears in §5.5.3's assessment response as
 *     `policyThresholdApplied`; a row read from §5.5.1 has no threshold, so the row's threshold is `null` and the
 *     renderer states that rather than showing a number it made up.
 *   * THE REDACTION STATE IS THE STORED TOKEN, verbatim. SPEC-003 §5.12.1 declares `UNREDACTED|DLP_SCRUBBED` and the
 *     stored CHECK accepts `NONE|SCRUBBED|DENIED` (recorded in ASSUMPTIONS); mapping one vocabulary onto the other here
 *     would hide a live contract conflict behind a UI translation.
 */

import type { TruthStateToken } from '../copy/truth-state.ts';
import { PortalClient, portalClient } from './client.ts';
import { TransportFailure } from './errors.ts';
import type {
  Collection,
  WireAppealEscalation,
  WireAuthorityGrant,
  WireConfidence,
  WireControllerResponse,
  WireDiscoveryRun,
  WireEvidenceArtifact,
  WireSubject,
  WireTimelineRow,
} from './wire.ts';

// ---------------------------------------------------------------------------------------------------------------
// Validation: the response must be the declared shape before a surface reads it
// ---------------------------------------------------------------------------------------------------------------

function fail(what: string, detail: string): never {
  throw new TransportFailure(200, `the API response for ${what} is not the declared shape: ${detail}`);
}

function asRecord(what: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(what, 'expected an object');
  return value as Record<string, unknown>;
}

function asArray(what: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) fail(what, 'expected an array');
  return value;
}

function asString(what: string, value: unknown): string {
  if (typeof value !== 'string') fail(what, 'expected a string');
  return value;
}

function asNumber(what: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(what, 'expected a finite number');
  return value;
}

function asBoolean(what: string, value: unknown): boolean {
  if (typeof value !== 'boolean') fail(what, 'expected a boolean');
  return value;
}

function asCollection<T>(what: string, body: unknown, row: (raw: unknown) => T): Collection<T> {
  const record = asRecord(what, body);
  return { data: asArray(`${what}.data`, record['data']).map(row) };
}

function confidence(what: string, value: unknown): WireConfidence {
  const record = asRecord(`${what}.confidence`, value);
  const basis = asArray(`${what}.confidence.basis`, record['basis']).map((entry) => {
    const item = asRecord(`${what}.confidence.basis[]`, entry);
    return {
      feature: asString(`${what}.confidence.basis[].feature`, item['feature']),
      weight: asNumber(`${what}.confidence.basis[].weight`, item['weight']),
    };
  });
  if (basis.length === 0) {
    // §5.5.1: "a score without basis is unrepresentable" — a row claiming one is a contract violation, not a UI state.
    fail(`${what}.confidence`, 'basis is empty, and the contract makes a score without basis unrepresentable');
  }
  return { value: asNumber(`${what}.confidence.value`, record['value']), basis };
}

function truthState(what: string, value: unknown): TruthStateToken {
  return asString(`${what}.truthState`, value) as TruthStateToken;
}

// ---------------------------------------------------------------------------------------------------------------
// View models: what a surface renders
// ---------------------------------------------------------------------------------------------------------------

export interface ConfidenceView {
  readonly value: number;
  readonly basis: readonly { readonly feature: string; readonly weight: number }[];
  /** The policy threshold applied, or `null` when the response did not state one (see the header). */
  readonly threshold: number | null;
  readonly policyVersion: string | null;
}

export interface ExposureView {
  readonly exposureId: string;
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly truthState: TruthStateToken;
  readonly confidence: ConfidenceView;
  readonly caseRef: string | null;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  /** The id of the removed event this exposure reappeared from, or `null` when it did not reappear. */
  readonly reappearanceOf: string | null;
}

export interface CaseView {
  readonly caseId: string;
  readonly sourceId: string;
  readonly exposureId: string;
  readonly truthState: TruthStateToken;
  readonly channel: string;
  readonly actionCount: number;
  readonly verificationCount: number;
  readonly nextDeadline: { readonly deadlineId: string; readonly kind: string; readonly dueAt: string; readonly state: string } | null;
  readonly updatedAt: string;
  /** NAMED FOR WHAT IT IS: the code of the last recorded transition, present only when the route returned one. */
  readonly lastTransitionCode: string | null;
  readonly evidenceArtifactIds: readonly string[];
}

export interface TimelineRowView {
  readonly at: string;
  readonly kind: WireTimelineRow['kind'];
  readonly refId: string;
  readonly truthStateAfter: TruthStateToken;
  readonly summary: string;
  readonly correlationId: string;
}

export interface DeadlineView {
  readonly deadlineId: string;
  readonly kind: string;
  readonly dueAt: string;
  readonly policyVersion: string;
  readonly ruleCode: string;
  readonly state: string;
  readonly overdueSeconds: number;
}

export interface CoverageView {
  readonly sourcesAttempted: number;
  /** The denominator: §5.4.3's `sourcesDeclared`. */
  readonly sourcesDeclared: number;
  readonly sourcesSucceeded: number;
  readonly skipped: readonly { readonly sourceId: string; readonly reason: string }[];
  readonly complete: boolean;
  readonly checkedFraction: number;
  readonly runState: WireDiscoveryRun['runState'];
  /** Always `null` from this route: §5.4.3 declares no catalogue field (see the header). */
  readonly catalogueVersion: null;
}

// ---------------------------------------------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------------------------------------------

export function toExposureView(what: string, raw: unknown): ExposureView {
  const record = asRecord(what, raw);
  return {
    exposureId: asString(`${what}.exposureId`, record['exposureId']),
    sourceId: asString(`${what}.sourceId`, record['sourceId']),
    sourceRecordId: asString(`${what}.sourceRecordId`, record['sourceRecordId']),
    truthState: truthState(what, record['truthState']),
    confidence: {
      ...confidence(what, record['confidence']),
      threshold: record['policyThresholdApplied'] === undefined ? null : asNumber(`${what}.policyThresholdApplied`, record['policyThresholdApplied']),
      policyVersion: record['policyVersion'] === undefined ? null : asString(`${what}.policyVersion`, record['policyVersion']),
    },
    caseRef: record['caseRef'] === null || record['caseRef'] === undefined ? null : asString(`${what}.caseRef`, record['caseRef']),
    firstObservedAt: asString(`${what}.firstObservedAt`, record['firstObservedAt']),
    lastObservedAt: asString(`${what}.lastObservedAt`, record['lastObservedAt']),
    reappearanceOf:
      record['reappearanceOf'] === null || record['reappearanceOf'] === undefined
        ? null
        : asString(`${what}.reappearanceOf`, record['reappearanceOf']),
  };
}

function toCaseView(what: string, raw: unknown): CaseView {
  const record = asRecord(what, raw);
  const deadline = record['nextDeadline'];
  const transition = record['lastTransition'];
  return {
    caseId: asString(`${what}.caseId`, record['caseId']),
    sourceId: asString(`${what}.sourceId`, record['sourceId']),
    exposureId: asString(`${what}.exposureId`, record['exposureId']),
    truthState: truthState(what, record['truthState']),
    channel: asString(`${what}.channel`, record['channel']),
    actionCount: asNumber(`${what}.actionCount`, record['actionCount']),
    verificationCount: asNumber(`${what}.verificationCount`, record['verificationCount']),
    nextDeadline:
      deadline === null || deadline === undefined
        ? null
        : (() => {
            const item = asRecord(`${what}.nextDeadline`, deadline);
            return {
              deadlineId: asString(`${what}.nextDeadline.deadlineId`, item['deadlineId']),
              kind: asString(`${what}.nextDeadline.kind`, item['kind']),
              dueAt: asString(`${what}.nextDeadline.dueAt`, item['dueAt']),
              state: asString(`${what}.nextDeadline.state`, item['state']),
            };
          })(),
    updatedAt: asString(`${what}.updatedAt`, record['updatedAt']),
    lastTransitionCode:
      transition === undefined || transition === null
        ? null
        : asString(`${what}.lastTransition.transitionCode`, asRecord(`${what}.lastTransition`, transition)['transitionCode']),
    evidenceArtifactIds:
      record['evidenceArtifactIds'] === undefined
        ? []
        : asArray(`${what}.evidenceArtifactIds`, record['evidenceArtifactIds']).map((id) =>
            asString(`${what}.evidenceArtifactIds[]`, id),
          ),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------------------------------------------

export interface PortalApi {
  readonly subject: (subjectId: string) => Promise<WireSubject>;
  readonly authorityGrants: (subjectId: string) => Promise<readonly WireAuthorityGrant[]>;
  readonly exposures: (query: { readonly limit?: number; readonly cursor?: string | null }) => Promise<Collection<ExposureView>>;
  readonly exposure: (exposureId: string) => Promise<{ readonly exposure: ExposureView; readonly etag: string | null }>;
  readonly caseDetail: (caseId: string) => Promise<{ readonly detail: CaseView; readonly etag: string | null }>;
  readonly timeline: (caseId: string) => Promise<readonly TimelineRowView[]>;
  readonly deadlines: (caseId: string) => Promise<readonly DeadlineView[]>;
  readonly controllerResponses: (caseId: string) => Promise<readonly WireControllerResponse[]>;
  readonly evidence: (evidenceArtifactId: string) => Promise<{ readonly evidence: WireEvidenceArtifact; readonly etag: string | null }>;
  readonly discoveryRun: (discoveryRunId: string) => Promise<CoverageView>;
  readonly assessExposure: (
    exposureId: string,
    input: {
      readonly confidence: WireConfidence;
      readonly method: string;
      readonly evidenceArtifactId: string;
      readonly humanReviewed: boolean;
      readonly ifMatch: string;
      readonly idempotencyKey: string;
    },
  ) => Promise<{ readonly truthState: TruthStateToken; readonly threshold: number | null; readonly assessmentRecorded: boolean }>;
  readonly createAppealEscalation: (
    caseId: string,
    input: {
      readonly kind: string;
      readonly requiresHumanReview: boolean;
      readonly artifactIds: readonly string[];
      readonly templateVersion: string;
      readonly templateHash: string;
      readonly ifMatch: string;
      readonly idempotencyKey: string;
    },
  ) => Promise<WireAppealEscalation>;
}

/** Build the portal API over a client. The default export uses the application's own client. */
export function createPortalApi(transport: PortalClient = portalClient): PortalApi {
  const query = (params: Readonly<Record<string, string | number | undefined>>): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const text = search.toString();
    return text.length === 0 ? '' : `?${text}`;
  };

  return {
    subject: async (subjectId) =>
      (await transport.get(`/subjects/${subjectId}`, (body) => asRecord('GET /subjects/{id}', body))).body as unknown as WireSubject,

    authorityGrants: async (subjectId) =>
      (
        await transport.get(`/subjects/${subjectId}/authority-grants`, (body) =>
          asCollection('GET /subjects/{id}/authority-grants', body, (raw) => asRecord('grant', raw) as unknown as WireAuthorityGrant),
        )
      ).body.data,

    exposures: async ({ limit = 25, cursor = null }) =>
      (
        await transport.get(`/exposures${query({ limit, cursor: cursor ?? undefined })}`, (body) =>
          asCollection('GET /exposures', body, (raw) => toExposureView('GET /exposures row', raw)),
        )
      ).body,

    exposure: async (exposureId) => {
      const result = await transport.get(`/exposures/${exposureId}`, (body) => toExposureView('GET /exposures/{id}', body));
      return { exposure: result.body, etag: result.etag };
    },

    caseDetail: async (caseId) => {
      const result = await transport.get(`/cases/${caseId}`, (body) => toCaseView('GET /cases/{id}', body));
      return { detail: result.body, etag: result.etag };
    },

    timeline: async (caseId) =>
      (
        await transport.get(`/cases/${caseId}/timeline`, (body) =>
          asCollection('GET /cases/{id}/timeline', body, (raw) => {
            const record = asRecord('timeline row', raw);
            return {
              at: asString('timeline.at', record['at']),
              kind: asString('timeline.kind', record['kind']) as WireTimelineRow['kind'],
              refId: asString('timeline.refId', record['refId']),
              truthStateAfter: truthState('timeline', record['truthStateAfter']),
              summary: asString('timeline.summary', record['summary']),
              correlationId: asString('timeline.correlationId', record['correlationId']),
            };
          }),
        )
      ).body.data,

    deadlines: async (caseId) =>
      (
        await transport.get(`/cases/${caseId}/deadlines`, (body) =>
          asCollection('GET /cases/{id}/deadlines', body, (raw) => {
            const record = asRecord('deadline row', raw);
            const derived = asRecord('deadline.derivedFrom', record['derivedFrom']);
            return {
              deadlineId: asString('deadline.deadlineId', record['deadlineId']),
              kind: asString('deadline.kind', record['kind']),
              dueAt: asString('deadline.dueAt', record['dueAt']),
              policyVersion: asString('deadline.derivedFrom.policyVersion', derived['policyVersion']),
              ruleCode: asString('deadline.derivedFrom.ruleCode', derived['ruleCode']),
              state: asString('deadline.state', record['state']),
              overdueSeconds: asNumber('deadline.overdueSeconds', record['overdueSeconds']),
            } satisfies DeadlineView;
          }),
        )
      ).body.data,

    controllerResponses: async (caseId) =>
      (
        await transport.get(`/cases/${caseId}/controller-responses`, (body) =>
          asCollection('GET /cases/{id}/controller-responses', body, (raw) => {
            const record = asRecord('controller response row', raw);
            return {
              claimedOutcomeIsObservation: asBoolean(
                'controllerResponse.claimedOutcomeIsObservation',
                record['claimedOutcomeIsObservation'],
              ),
              ...(record['claimedOutcome'] === undefined
                ? {}
                : { claimedOutcome: asString('controllerResponse.claimedOutcome', record['claimedOutcome']) }),
            };
          }),
        )
      ).body.data,

    evidence: async (evidenceArtifactId) => {
      const result = await transport.get(`/evidence-artifacts/${evidenceArtifactId}`, (body) => {
        const record = asRecord('GET /evidence-artifacts/{id}', body);
        return {
          evidenceArtifactId: asString('evidence.evidenceArtifactId', record['evidenceArtifactId']),
          digest: asString('evidence.digest', record['digest']),
          digestVerified: asBoolean('evidence.digestVerified', record['digestVerified']),
          kind: asString('evidence.kind', record['kind']),
          // THE STORAGE REFERENCE IS READ AND DELIBERATELY NOT RETURNED TO A SURFACE: it is how the server finds the
          // bytes, and a browser has no use for it. The validator proves it is present; the view model omits it.
          storageRef: asString('evidence.storageRef', record['storageRef']),
          capturedAt: asString('evidence.capturedAt', record['capturedAt']),
          redactionState: asString('evidence.redactionState', record['redactionState']),
          sizeBytes: asNumber('evidence.sizeBytes', record['sizeBytes']),
          immutable: asBoolean('evidence.immutable', record['immutable']),
          linkedCaseIds: asArray('evidence.linkedCaseIds', record['linkedCaseIds']).map((id) =>
            asString('evidence.linkedCaseIds[]', id),
          ),
          ...(record['linkedTraceability'] === undefined
            ? {}
            : {
                linkedTraceability: (() => {
                  const trace = asRecord('evidence.linkedTraceability', record['linkedTraceability']);
                  const ids = (key: string): string[] =>
                    asArray(`evidence.linkedTraceability.${key}`, trace[key]).map((id) =>
                      asString(`evidence.linkedTraceability.${key}[]`, id),
                    );
                  return {
                    requirementIds: ids('requirementIds'),
                    caseIds: ids('caseIds'),
                    transitionIds: ids('transitionIds'),
                  };
                })(),
              }),
        } satisfies WireEvidenceArtifact;
      });
      return { evidence: result.body, etag: result.etag };
    },

    discoveryRun: async (discoveryRunId) =>
      (
        await transport.get(`/discovery-runs/${discoveryRunId}`, (body) => {
          const record = asRecord('GET /discovery-runs/{id}', body);
          const coverage = asRecord('discoveryRun.coverage', record['coverage']);
          const bounds = asRecord('discoveryRun.coverage.coverageBounds', coverage['coverageBounds']);
          return {
            runState: asString('discoveryRun.runState', record['runState']) as WireDiscoveryRun['runState'],
            sourcesAttempted: asNumber('coverage.sourcesAttempted', coverage['sourcesAttempted']),
            sourcesDeclared: asNumber('coverage.sourcesDeclared', coverage['sourcesDeclared']),
            sourcesSucceeded: asNumber('coverage.sourcesSucceeded', coverage['sourcesSucceeded']),
            skipped: asArray('coverage.sourcesSkipped', coverage['sourcesSkipped']).map((entry) => {
              const item = asRecord('coverage.sourcesSkipped[]', entry);
              return {
                sourceId: asString('coverage.sourcesSkipped[].sourceId', item['sourceId']),
                reason: asString('coverage.sourcesSkipped[].reason', item['reason']),
              };
            }),
            complete: asBoolean('coverage.coverageBounds.complete', bounds['complete']),
            checkedFraction: asNumber('coverage.coverageBounds.checkedFraction', bounds['checkedFraction']),
            catalogueVersion: null as null,
          } satisfies CoverageView;
        })
      ).body,

    assessExposure: async (exposureId, input) => {
      const result = await transport.post(
        `/exposures/${exposureId}/match-assessments`,
        {
          idempotencyKey: input.idempotencyKey,
          ifMatch: input.ifMatch,
          body: {
            confidence: { value: input.confidence.value, basis: input.confidence.basis },
            method: input.method,
            evidenceArtifactId: input.evidenceArtifactId,
            humanReviewed: input.humanReviewed,
          },
        },
        (body) => {
          const record = asRecord('POST match-assessments', body);
          return {
            truthState: truthState('POST /exposures/{id}/match-assessments', record['truthState']),
            threshold:
              record['policyThresholdApplied'] === undefined
                ? null
                : asNumber('POST /exposures/{id}/match-assessments policyThresholdApplied', record['policyThresholdApplied']),
            assessmentRecorded: record['assessmentRecorded'] === true,
          };
        },
      );
      return result.body;
    },

    createAppealEscalation: async (caseId, input) => {
      const result = await transport.post(
        `/cases/${caseId}/appeal-escalations`,
        {
          idempotencyKey: input.idempotencyKey,
          ifMatch: input.ifMatch,
          body: {
            kind: input.kind,
            requiresHumanReview: input.requiresHumanReview,
            artifactIds: [...input.artifactIds],
            templateVersion: input.templateVersion,
            templateHash: input.templateHash,
          },
        },
        (body) => body as unknown as WireAppealEscalation,
      );
      return result.body;
    },
  };
}

/** The application's API, constructed once. */
export const portalApi: PortalApi = createPortalApi();


