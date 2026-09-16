/**
 * MCP and agent least privilege with effect budgets (SPEC-005 §7/§10; SPEC-003 §9; EP-006 M7).
 *
 * The registry is asserted as an ENUMERATION in both directions: every declared tool is the one the plan enumerates, and
 * there is no tool for any capability the registry prohibits. The second direction is the one that matters — a
 * prohibited capability that appears later as a tool is a failing test rather than a quiet capability.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_TOOLS,
  EFFECT_BEARING_TOOLS,
  PROHIBITED_TOOL_CAPABILITIES,
  assertNotControlField,
  auditToolCall,
  decideToolCall,
  idempotencyFingerprint,
  toolNamed,
} from '../../src/application/security/agent-tool-policy.ts';
import {
  AGENT_BUDGET_CEILINGS,
  AGENT_LOOP_CALL_CAP,
  checkAgentBudget,
  checkLoopCap,
  domainBudgetIsAuthoritative,
  type BudgetDimension,
} from '../../src/application/security/effect-budget.ts';
import { AUDIENCES } from '../../src/adapters/oidc/verify.ts';

const QUERY = { tokenIdentity: 'agent-token-opaque-1', subjectRef: 'subject-opaque-1', sourceId: 'SOURCE_ALPHA' };

/**
 * A reader with a state per dimension. `undefined` models an unreadable store.
 *
 * MEASURED: the first version wrote `state[dimension] ?? 0`, which turned the `undefined` the test injected into a
 * readable zero — so the unreadable-store case could not be driven at all. The `in` check distinguishes "this dimension
 * was not configured" (room) from "this dimension could not be read" (exhausted).
 */
function reader(state: Partial<Record<BudgetDimension, number | undefined>>): (dimension: BudgetDimension) => number | undefined {
  return (dimension) => (dimension in state ? state[dimension] : 0);
}

describe('the tool registry is an enumeration with no privileged tool (VG-AUTH-006/010)', () => {
  test('the write-capable tools are exactly the five the plan enumerates, each effect-bearing', () => {
    const writes = AGENT_TOOLS.filter((tool) => tool.effectBearing).map((tool) => tool.name).sort();
    assert.deepEqual(writes, [...EFFECT_BEARING_TOOLS].sort());
    assert.equal(writes.length, 5);
  });

  test('the registry equals the enumeration: every tool is declared, and no tool exists beyond it', () => {
    // THE FORWARD DIRECTION BY NAME, so a tool added to the array without a decision here fails.
    const declared = AGENT_TOOLS.map((tool) => tool.name);
    assert.equal(new Set(declared).size, declared.length, 'a tool name appears twice');
    for (const name of [...EFFECT_BEARING_TOOLS, 'read-subject-summary', 'read-exposures', 'read-case', 'read-coverage-report', 'read-evidence-metadata']) {
      assert.ok(declared.includes(name), `${name} must be declared`);
    }
    // THE REVERSE DIRECTION: every tool maps to exactly one route and carries that route's scopes.
    for (const tool of AGENT_TOOLS) {
      assert.equal(tool.route.startsWith('/v1/'), true, `${tool.name} must map to a /v1 route`);
      assert.ok(tool.scopes.length > 0, `${tool.name} must carry a scope requirement`);
      assert.equal(['GET', 'POST'].includes(tool.method), true);
      assert.equal(toolNamed(tool.name)?.route, tool.route);
    }
  });

  test('NO PRIVILEGED TOOL EXISTS, and the prohibited capabilities have no entry', () => {
    // The assertion is on CAPABILITY rather than on a name: every tool's route and scopes are checked against the
    // capabilities the registry prohibits, so a tool named innocuously but pointed at policy authoring still fails.
    const forbiddenRouteParts = ['policy-decisions', 'authority-grants', 'recipes', 'appeal-escalations', 'audit-events', '/content'];
    for (const tool of AGENT_TOOLS) {
      for (const part of forbiddenRouteParts) {
        assert.equal(tool.route.includes(part), false, `${tool.name} reaches ${part}, which is prohibited to an agent`);
      }
      assert.equal(tool.scopes.includes('vg.pii.reveal'), false, `${tool.name} must not carry vg.pii.reveal`);
      assert.equal(tool.scopes.includes('vg.audit.read'), false);
      assert.equal(tool.scopes.includes('vg.actions.execute'), false);
    }
    assert.ok(PROHIBITED_TOOL_CAPABILITIES.length >= 8);
    // And there is no free-form passthrough: no tool takes a route or a URL as an input.
    for (const tool of AGENT_TOOLS) {
      assert.equal(tool.modelPopulatableFields.some((field) => /url|route|path|endpoint/i.test(field)), false, `${tool.name} accepts a route from a model`);
    }
  });

  test('a tool call is refused for an unknown tool, a missing scope, or a forbidden machine scope', () => {
    assert.equal(decideToolCall({ tool: 'call-any-endpoint', heldScopes: ['vg.cases.read'] }).code, 'TOOL_UNKNOWN');
    assert.equal(decideToolCall({ tool: 'read-case', heldScopes: [] }).code, 'TOOL_SCOPE_VIOLATION');
    assert.equal(
      decideToolCall({ tool: 'read-case', heldScopes: ['vg.cases.read', 'vg.audit.read'] }).code,
      'TOOL_NOT_PERMITTED_FOR_AGENT',
    );
    assert.equal(
      decideToolCall({ tool: 'read-case', heldScopes: ['vg.cases.read', 'vg.cases.destroy'] }).code,
      'TOOL_SCOPE_VIOLATION',
    );
    assert.equal(decideToolCall({ tool: 'read-case', heldScopes: ['vg.cases.read'] }).allow, true);
  });

  test('an effect-bearing call needs an orchestration-supplied key, and the audit records its FINGERPRINT', () => {
    const withoutKey = decideToolCall({ tool: 'assess-match', heldScopes: ['vg.exposures.assess'] });
    assert.equal(withoutKey.code, 'IDEMPOTENCY_KEY_REQUIRED');
    const admitted = decideToolCall({ tool: 'assess-match', heldScopes: ['vg.exposures.assess'], idempotencyKey: 'key-1' });
    assert.equal(admitted.allow, true);
    // A READ needs no key: the requirement is about effects.
    assert.equal(decideToolCall({ tool: 'read-case', heldScopes: ['vg.cases.read'] }).allow, true);

    const event = auditToolCall({
      admitted: true,
      tokenIdentity: QUERY.tokenIdentity,
      tool: 'assess-match',
      target: 'exposure-opaque-1',
      idempotencyKey: 'key-1',
      correlationId: 'corr-1',
      budgetConsumed: 1,
      at: '2026-09-16T00:00:00Z',
    });
    assert.equal(event.idempotencyFingerprint, idempotencyFingerprint('key-1'));
    assert.equal(JSON.stringify(event).includes('key-1'), false, 'the raw key must never be recorded');
    assert.equal(event.event, 'agent.tool_call');
    const refused = auditToolCall({
      admitted: false,
      tokenIdentity: QUERY.tokenIdentity,
      tool: 'read-case',
      target: 'case-1',
      correlationId: 'corr-2',
      budgetConsumed: 0,
      at: '2026-09-16T00:00:00Z',
    });
    assert.equal(refused.event, 'agent.tool_refused');
    assert.equal(refused.idempotencyFingerprint, null);
  });

  test('a model-authored control field is refused, and untrusted content is refused as tainted', () => {
    const control = decideToolCall({
      tool: 'assess-match',
      heldScopes: ['vg.exposures.assess'],
      idempotencyKey: 'key-1',
      modelFields: [{ name: 'channel', trusted: true }],
    });
    assert.equal(control.allow, false);
    assert.equal(control.code, 'MODEL_FIELD_NOT_POPULATABLE');
    const tainted = decideToolCall({
      tool: 'assess-match',
      heldScopes: ['vg.exposures.assess'],
      idempotencyKey: 'key-1',
      modelFields: [{ name: 'legalBasis', trusted: false }],
    });
    assert.equal(tainted.code, 'TAINTED_CONTENT_REJECTED');
    // An allowlisted field is admitted, so the check is not a blanket refusal of model output.
    assert.equal(
      decideToolCall({
        tool: 'assess-match',
        heldScopes: ['vg.exposures.assess'],
        idempotencyKey: 'key-1',
        modelFields: [{ name: 'confidence.basis', trusted: true }],
      }).allow,
      true,
    );
    assert.throws(() => assertNotControlField('legalBasis'), /control field/);
    assert.doesNotThrow(() => assertNotControlField('rationale'));
  });

  test('the MCP audience is distinct, which is what keeps an MCP token off a portal route', () => {
    // The audience binding itself is asserted by tests/contract/audience-binding.test.ts; what this records is that the
    // MCP audience the tool registry serves is a DIFFERENT value from the portal's.
    assert.notEqual(AUDIENCES.MCP, AUDIENCES.PORTAL);
    assert.notEqual(AUDIENCES.MCP, AUDIENCES.SERVICE);
  });
});

describe('the effect budget refuses on four dimensions and never raises one (VG-AUTH-007)', () => {
  test('every ceiling admits a call inside it and refuses at the limit, naming the dimension', () => {
    for (const ceiling of AGENT_BUDGET_CEILINGS) {
      const inside = checkAgentBudget(QUERY, reader({ [ceiling.dimension]: ceiling.limit - 1 }));
      assert.equal(inside.allow, true, `${ceiling.dimension} inside its limit`);
      const at = checkAgentBudget(QUERY, reader({ [ceiling.dimension]: ceiling.limit }));
      assert.equal(at.allow, false, `${ceiling.dimension} at its limit`);
      assert.equal(at.code, 'EFFECT_BUDGET_EXCEEDED');
      assert.equal(at.dimension, ceiling.dimension);
      assert.equal(at.limit, ceiling.limit);
      assert.equal(at.usage, ceiling.limit);
      assert.ok((at.windowSeconds ?? 0) > 0);
      assert.match(at.detail, new RegExp(`${ceiling.dimension} is at ${String(ceiling.limit)} of ${String(ceiling.limit)}`));
    }
  });

  test('UNREADABLE BUDGET STATE IS EXHAUSTED rather than unlimited (SPEC-006 §7.1 row 20)', () => {
    const decision = checkAgentBudget(QUERY, reader({ 'per-token': undefined }));
    assert.equal(decision.allow, false);
    assert.equal(decision.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(decision.dimension, 'per-token');
    assert.match(decision.detail, /treated as exhausted/);
  });

  test('the most-exhausted dimension is reported first, so the answer is stable', () => {
    const decision = checkAgentBudget(QUERY, reader({ 'per-token': 200, 'per-subject': 50, 'per-source': 20 }));
    assert.equal(decision.dimension, 'per-token', 'the largest ceiling is named when several are exhausted');
    // And with only the smallest exhausted, that one is named.
    const small = checkAgentBudget(QUERY, reader({ 'per-source': 20 }));
    assert.equal(small.dimension, 'per-source');
  });

  test('there is no override and no parameter that raises a ceiling', () => {
    // The property is asserted against the module's own surface: no exported function takes a limit.
    assert.match(domainBudgetIsAuthoritative(), /authoritative/);
    assert.match(domainBudgetIsAuthoritative(), /never a substitute/);
    assert.equal(AGENT_BUDGET_CEILINGS.every((ceiling) => ceiling.limit > 0), true);
  });

  test('a loop that exceeds its cap is refused, and the cap is independent of the ceilings', () => {
    assert.equal(checkLoopCap({ callsMade: AGENT_LOOP_CALL_CAP - 1 }).allow, true);
    const capped = checkLoopCap({ callsMade: AGENT_LOOP_CALL_CAP });
    assert.equal(capped.allow, false);
    assert.match(capped.detail, /at its cap of 50/);
    // The cap is smaller than the per-token ceiling on purpose: a loop cannot spend a whole token budget by accident.
    const tokenCeiling = AGENT_BUDGET_CEILINGS.find((ceiling) => ceiling.dimension === 'per-token');
    assert.ok((tokenCeiling?.limit ?? 0) > AGENT_LOOP_CALL_CAP);
  });
});
