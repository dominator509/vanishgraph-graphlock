/**
 * The MCP surface binding for the agent tool registry (SPEC-003 §9.1/§9.2; SPEC-005 §7; EP-006 M7).
 *
 * THE ADAPTER DOES FOUR THINGS AND NOTHING ELSE: it exposes the enumerated tools, checks that the CALLER's audience is the
 * MCP one, validates the input against the tool's own schema BEFORE the application layer sees it, and consults the
 * budget. The policy lives in `application/security/`; this file is the binding, which is why every dependency is injected
 * and the adapter itself holds no state.
 *
 * THE AUDIENCE CHECK IS THE REASON AN MCP TOKEN CANNOT REACH A PORTAL ROUTE. The MCP audience is a distinct value, and a
 * token minted for it is refused here even when its scopes would satisfy the tool — the tool registry serves MCP and
 * nothing else.
 *
 * SCHEMA VALIDATION RUNS BEFORE DISPATCH, and a value that fails it never reaches the application layer. That ordering is
 * what keeps a model-shaped input from being interpreted by a handler that expects a checked one.
 */

import {
  AGENT_TOOLS,
  assertNotControlField,
  auditToolCall,
  decideToolCall,
  type AgentAuditEvent,
  type AgentTool,
} from '../../application/security/agent-tool-policy.ts';
import { checkAgentBudget, checkLoopCap, type BudgetReader, type LoopState } from '../../application/security/effect-budget.ts';

/** The audience this surface serves. Distinct from the portal's and the service's (SPEC-003 §3.2 item 3). */
export const MCP_AUDIENCE = 'vanishgraph-mcp';

export interface ToolSchema {
  readonly required: readonly string[];
  /** The fields the tool accepts at all. A field outside this list is refused, not ignored. */
  readonly allowed: readonly string[];
}

/** The schema for each tool, keyed by name. Every enumerated tool has one; a missing schema is a defect, not a pass. */
export const TOOL_SCHEMAS: Readonly<Record<string, ToolSchema>> = Object.freeze({
  'read-subject-summary': { required: ['subjectId'], allowed: ['subjectId'] },
  'read-exposures': { required: [], allowed: ['limit', 'cursor'] },
  'read-case': { required: ['caseId'], allowed: ['caseId'] },
  'read-coverage-report': { required: ['discoveryRunId'], allowed: ['discoveryRunId'] },
  'read-evidence-metadata': { required: ['evidenceArtifactId'], allowed: ['evidenceArtifactId'] },
  'assess-match': { required: ['exposureId', 'confidence'], allowed: ['exposureId', 'confidence', 'method', 'evidenceArtifactId'] },
  'record-verification-observation': { required: ['caseId', 'observedAt'], allowed: ['caseId', 'observedAt', 'method'] },
  'record-reappearance': { required: ['exposureId', 'observedAt'], allowed: ['exposureId', 'observedAt'] },
  'record-human-gate': { required: ['caseId', 'gateKind'], allowed: ['caseId', 'gateKind', 'rationale'] },
  'upload-evidence-artifact': { required: ['caseId', 'kind'], allowed: ['caseId', 'kind', 'capturedAt'] },
});

export interface ToolCallRequest {
  readonly tool: string;
  readonly tenantId: string;
  readonly tokenIdentity: string;
  readonly audience: string;
  readonly heldScopes: readonly string[];
  readonly subjectRef: string;
  readonly sourceId: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string | undefined;
  /** The fields the MODEL authored, by name. Anything here is subject to the tool's allowlist. */
  readonly modelFields?: readonly string[] | undefined;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ToolCallOutcome {
  readonly ok: boolean;
  readonly code?: string;
  readonly detail?: string;
  readonly httpStatus?: number;
  readonly audit: AgentAuditEvent;
  /** The application-layer call, present only when the call was admitted. */
  readonly dispatch?: (() => Promise<unknown>) | undefined;
}

export interface AgentToolRegistryOptions {
  readonly tenantId: string;
  readonly now: () => string;
  readonly budgetReader: BudgetReader;
  readonly loop: LoopState;
  /** The application-layer dispatch for an admitted call. The adapter never builds a route itself. */
  readonly dispatch: (tool: AgentTool, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
}

/**
 * Serve one tool call.
 *
 * EVERY REFUSAL IS AUDITED, including a budget refusal and an unknown tool: the audit stream is where an agent's intent
 * is visible, and a refusal that left no trace would hide a loop that is probing.
 */
export async function serveToolCall(
  registry: AgentToolRegistryOptions,
  request: ToolCallRequest,
): Promise<ToolCallOutcome> {
  const at = registry.now();
  const refuse = (code: string, detail: string, httpStatus: number): ToolCallOutcome => ({
    ok: false,
    code,
    detail,
    httpStatus,
    audit: auditToolCall({
      admitted: false,
      tokenIdentity: request.tokenIdentity,
      tool: request.tool,
      target: request.correlationId,
      correlationId: request.correlationId,
      budgetConsumed: 0,
      at,
      reason: code,
    }),
  });

  if (request.audience !== MCP_AUDIENCE) {
    return refuse('TOKEN_AUDIENCE_MISMATCH', 'this surface serves the MCP audience only; a portal or service token is refused here', 401);
  }

  const loop = checkLoopCap(registry.loop);
  if (!loop.allow) {
    return refuse('EFFECT_BUDGET_EXCEEDED', loop.detail, 409);
  }

  const modelFields = (request.modelFields ?? []).map((name) => ({ name, trusted: true }));
  const decision = decideToolCall({
    tool: request.tool,
    heldScopes: request.heldScopes,
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
    modelFields,
  });
  if (!decision.allow) {
    const httpStatus = decision.code === 'IDEMPOTENCY_KEY_REQUIRED' ? 400 : decision.code === 'TOOL_UNKNOWN' ? 404 : 403;
    return refuse(decision.code ?? 'TOOL_UNKNOWN', decision.detail ?? 'refused', httpStatus);
  }

  // THE SCHEMA RUNS BEFORE THE APPLICATION LAYER. A missing required field or an undeclared field is refused here, so no
  // handler ever interprets an input this adapter has not checked.
  const schema = TOOL_SCHEMAS[request.tool];
  if (schema === undefined) {
    return refuse('TOOL_UNKNOWN', `no schema is declared for ${request.tool}`, 500);
  }
  const missing = schema.required.filter((field) => request.input[field] === undefined);
  if (missing.length > 0) {
    return refuse('TOOL_INPUT_INVALID', `the call is missing ${missing.join(', ')}`, 422);
  }
  const undeclared = Object.keys(request.input).filter((field) => !schema.allowed.includes(field));
  if (undeclared.length > 0) {
    return refuse('TOOL_INPUT_INVALID', `the call carries undeclared fields: ${undeclared.join(', ')}`, 422);
  }
  if (request.input['legalBasis'] !== undefined) {
    // A MODEL-AUTHORED LEGAL BASIS IS REFUSED, AND NO DECISION IS CREATED (VG-AUTH-029/VG-API-072).
    assertNotControlField('legalBasis');
    return refuse('LEGAL_BASIS_NOT_AUTHORABLE', 'the API authors no legal basis, and a model may not supply one', 422);
  }

  const budget = checkAgentBudget(
    { tokenIdentity: request.tokenIdentity, subjectRef: request.subjectRef, sourceId: request.sourceId },
    registry.budgetReader,
  );
  if (!budget.allow) {
    return refuse(budget.code ?? 'EFFECT_BUDGET_EXCEEDED', budget.detail, budget.code === 'DEPENDENCY_UNAVAILABLE' ? 503 : 409);
  }

  const admitted = auditToolCall({
    admitted: true,
    tokenIdentity: request.tokenIdentity,
    tool: request.tool,
    target: request.correlationId,
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
    correlationId: request.correlationId,
    budgetConsumed: 1,
    at,
  });
  const tool = AGENT_TOOLS.find((candidate) => candidate.name === request.tool);
  return {
    ok: true,
    audit: admitted,
    dispatch: async () => {
      if (tool === undefined) throw new Error(`the tool ${request.tool} passed the policy but is not in the enumeration`);
      return registry.dispatch(tool, request.input);
    },
  };
}

/** The tool list an MCP client may discover. It is the enumeration, verbatim, and nothing is filtered at runtime. */
export function discoverableTools(): readonly { readonly name: string; readonly route: string; readonly effectBearing: boolean }[] {
  return AGENT_TOOLS.map((tool) => ({ name: tool.name, route: tool.route, effectBearing: tool.effectBearing }));
}

/** Whether this surface serves a route at all: the adapter is MCP-exposed routes only. */
export function isMcpExposedRoute(route: string): boolean {
  return AGENT_TOOLS.some((tool) => tool.route === route);
}
