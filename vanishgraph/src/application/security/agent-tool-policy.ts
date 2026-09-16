/**
 * The agent/MCP tool registry and its least-privilege policy (SPEC-005 §7 VG-AUTH-006…010, §10 VG-AUTH-029; SPEC-003 §9;
 * EP-006 M7).
 *
 * THE REGISTRY IS AN ENUMERATION, NOT A ROUTER. Every tool maps to exactly one `/v1` route and carries that route's scope
 * requirement; a tool may NARROW what the route allows and may never widen it. A free-form "call any endpoint" tool is
 * prohibited BY CONSTRUCTION — the registry has no such entry — and the suite asserts the registry's tool set equals the
 * enumeration, so adding one is a failing test rather than a quiet capability.
 *
 * THE ABSENT TOOLS ARE THE POINT. There is no tool for policy authoring, authority minting, recipe enabling, escalation
 * approval, audit query, evidence content download, or revealed PII. Each of those is an operation an agent credential
 * must not perform (VG-AUTH-010), and the reason they are absent rather than refused is that an absent tool cannot be
 * called by a model that has been talked into calling it.
 *
 * MODEL OUTPUT IS DATA. A value a model produced can populate an allowlisted template field and can never populate a
 * control field, so the registry names the fields a tool may accept from model output; anything else is refused before the
 * application layer sees it.
 */

import { MACHINE_FORBIDDEN_SCOPES, isScope } from './scope-catalogue.ts';

/** The write-capable tools, enumerated (SPEC-005 §7). Each is effect-bearing and needs an orchestration-supplied key. */
export const EFFECT_BEARING_TOOLS: readonly string[] = Object.freeze([
  'assess-match',
  'record-verification-observation',
  'record-reappearance',
  'record-human-gate',
  'upload-evidence-artifact',
]);

export interface AgentTool {
  /** The tool name an MCP client calls. */
  readonly name: string;
  /** Exactly one `/v1` route, so a tool cannot span capabilities. */
  readonly route: string;
  readonly method: 'GET' | 'POST';
  /** The scopes the CALLER must hold. Always a subset of the route's own requirement. */
  readonly scopes: readonly string[];
  /** Whether the tool can produce an effect outside the application. */
  readonly effectBearing: boolean;
  /** The fields a model may populate, by name. A field absent from this list is refused from model output. */
  readonly modelPopulatableFields: readonly string[];
}

const READ_TOOLS: readonly AgentTool[] = Object.freeze([
  { name: 'read-subject-summary', route: '/v1/subjects/{subjectId}', method: 'GET', scopes: ['vg.subjects.read'], effectBearing: false, modelPopulatableFields: [] },
  { name: 'read-exposures', route: '/v1/exposures', method: 'GET', scopes: ['vg.exposures.read'], effectBearing: false, modelPopulatableFields: [] },
  { name: 'read-case', route: '/v1/cases/{caseId}', method: 'GET', scopes: ['vg.cases.read'], effectBearing: false, modelPopulatableFields: [] },
  { name: 'read-coverage-report', route: '/v1/discovery-runs/{discoveryRunId}', method: 'GET', scopes: ['vg.discovery.read'], effectBearing: false, modelPopulatableFields: [] },
  { name: 'read-evidence-metadata', route: '/v1/evidence-artifacts/{evidenceArtifactId}', method: 'GET', scopes: ['vg.evidence.read'], effectBearing: false, modelPopulatableFields: [] },
]);

const WRITE_TOOLS: readonly AgentTool[] = Object.freeze([
  {
    name: 'assess-match',
    route: '/v1/exposures/{exposureId}/match-assessments',
    method: 'POST',
    scopes: ['vg.exposures.assess'],
    effectBearing: true,
    // The confidence object and the method are model-produced; the CHANNEL is not, which is what keeps a model from
    // selecting how an effect leaves the system.
    modelPopulatableFields: ['confidence.basis', 'method'],
  },
  {
    name: 'record-verification-observation',
    route: '/v1/cases/{caseId}/verification-observations',
    method: 'POST',
    scopes: ['vg.observations.write'],
    effectBearing: true,
    modelPopulatableFields: ['observedAt', 'method'],
  },
  {
    name: 'record-reappearance',
    route: '/v1/exposures/{exposureId}/reappearances',
    method: 'POST',
    scopes: ['vg.observations.write'],
    effectBearing: true,
    modelPopulatableFields: ['observedAt'],
  },
  {
    name: 'record-human-gate',
    route: '/v1/cases/{caseId}/human-gates',
    method: 'POST',
    scopes: ['vg.cases.write'],
    effectBearing: true,
    modelPopulatableFields: ['gateKind', 'rationale'],
  },
  {
    name: 'upload-evidence-artifact',
    route: '/v1/cases/{caseId}/evidence-artifacts',
    method: 'POST',
    scopes: ['vg.evidence.write'],
    effectBearing: true,
    modelPopulatableFields: ['kind', 'capturedAt'],
  },
]);

export const AGENT_TOOLS: readonly AgentTool[] = Object.freeze([...READ_TOOLS, ...WRITE_TOOLS]);

/** The tools that must never exist, named so their absence is asserted rather than assumed (VG-AUTH-010). */
export const PROHIBITED_TOOL_CAPABILITIES: readonly string[] = Object.freeze([
  'policy authoring',
  'authority minting',
  'recipe enabling',
  'escalation approval',
  'audit query',
  'evidence content download',
  'revealed PII (vg.pii.reveal)',
  'raw HTTP or shell passthrough',
]);

export function toolNamed(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

export type ToolRefusal =
  | 'TOOL_UNKNOWN'
  | 'TOOL_SCOPE_VIOLATION'
  | 'TOOL_NOT_PERMITTED_FOR_AGENT'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'MODEL_FIELD_NOT_POPULATABLE'
  | 'TAINTED_CONTENT_REJECTED';

export interface ToolCall {
  readonly tool: string;
  /** The scopes the calling token holds. */
  readonly heldScopes: readonly string[];
  /** Supplied by the ORCHESTRATION layer, never by the model. */
  readonly idempotencyKey?: string | undefined;
  /** The fields the model authored, by name, with whether the content is trusted. */
  readonly modelFields?: readonly { readonly name: string; readonly trusted: boolean }[] | undefined;
}

export interface ToolDecision {
  readonly allow: boolean;
  readonly code?: ToolRefusal;
  readonly detail?: string;
}

/**
 * Decide whether an agent may call a tool.
 *
 * THE ORDER PUTS THE REGISTRY FIRST: an unknown tool is refused before its scopes are considered, because a tool nobody
 * declared has no scope requirement to satisfy. Then the machine-forbidden scopes, so an agent token holding one is
 * refused outright rather than only where a tool happens to need it. Then the tool's own scopes, then the key, then the
 * model-authored fields.
 */
export function decideToolCall(call: ToolCall): ToolDecision {
  const tool = toolNamed(call.tool);
  if (tool === undefined) {
    return { allow: false, code: 'TOOL_UNKNOWN', detail: `"${call.tool}" is not in the agent tool registry` };
  }
  for (const scope of call.heldScopes) {
    if (!isScope(scope)) {
      return { allow: false, code: 'TOOL_SCOPE_VIOLATION', detail: `the token holds "${scope}", which is not in the closed vocabulary` };
    }
    if (MACHINE_FORBIDDEN_SCOPES.includes(scope)) {
      return {
        allow: false,
        code: 'TOOL_NOT_PERMITTED_FOR_AGENT',
        detail: `an agent credential may not hold ${scope}: SPEC-003 §3.2 item 9 forbids it to a machine token`,
      };
    }
  }
  const missing = tool.scopes.filter((scope) => !call.heldScopes.includes(scope));
  if (missing.length > 0) {
    return { allow: false, code: 'TOOL_SCOPE_VIOLATION', detail: `the tool requires ${missing.join(', ')}` };
  }
  if (tool.effectBearing && (call.idempotencyKey === undefined || call.idempotencyKey.length === 0)) {
    return {
      allow: false,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      detail: 'an effect-bearing tool call needs an IdempotencyKey from the orchestration layer, never from the model',
    };
  }
  for (const field of call.modelFields ?? []) {
    if (!tool.modelPopulatableFields.includes(field.name)) {
      // UNTRUSTED CONTENT THAT TRIES TO SELECT A CHANNEL OR TRIGGER A WRITE REJECTS THE OPERATION (VG-SEC-001).
      return {
        allow: false,
        code: field.trusted ? 'MODEL_FIELD_NOT_POPULATABLE' : 'TAINTED_CONTENT_REJECTED',
        detail: `"${field.name}" may not be populated from model output for ${tool.name}`,
      };
    }
  }
  return { allow: true };
}

/** The fingerprint of an idempotency key, for the audit row: the raw key is never recorded. */
export function idempotencyFingerprint(idempotencyKey: string): string {
  let hash = 0;
  for (const character of idempotencyKey) {
    hash = (hash * 31 + character.codePointAt(0)!) % 0xffffffff;
  }
  return `idem-${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

export interface AgentAuditEvent {
  readonly event: 'agent.tool_call' | 'agent.tool_refused' | 'agent.budget_exhausted';
  readonly tokenIdentity: string;
  readonly tool: string;
  readonly target: string;
  readonly idempotencyFingerprint: string | null;
  readonly correlationId: string;
  readonly budgetConsumed: number;
  readonly at: string;
}

/** Build the audit row for a call, admitted or refused. */
export function auditToolCall(input: {
  readonly admitted: boolean;
  readonly tokenIdentity: string;
  readonly tool: string;
  readonly target: string;
  readonly idempotencyKey?: string | undefined;
  readonly correlationId: string;
  readonly budgetConsumed: number;
  readonly at: string;
  readonly reason?: string | undefined;
}): AgentAuditEvent {
  return {
    event: input.admitted ? 'agent.tool_call' : 'agent.tool_refused',
    tokenIdentity: input.tokenIdentity,
    tool: input.tool,
    target: input.target,
    // THE FINGERPRINT, NEVER THE KEY: the key is a credential-shaped value and the audit stream is readable.
    idempotencyFingerprint: input.idempotencyKey === undefined ? null : idempotencyFingerprint(input.idempotencyKey),
    correlationId: input.correlationId,
    budgetConsumed: input.budgetConsumed,
    at: input.at,
  };
}

/** Whether a value may populate a control field. It may not, whatever its provenance. */
export function assertNotControlField(fieldName: string): void {
  const controlFields = ['channel', 'legalBasis', 'authorityGrantId', 'truthState', 'targetSource', 'requestedChannel'];
  if (controlFields.includes(fieldName)) {
    throw new Error(
      `"${fieldName}" is a control field: model output may populate an allowlisted template field and may never select a channel, a legal basis or a truth state (SPEC-003 §9.2 item 4)`,
    );
  }
}
