/**
 * Test-support re-exports for the envelope contract suite.
 *
 * A thin module so `error-envelope.test.ts` reads as a contract test rather than as an import
 * puzzle. It re-exports only what the suite needs and adds two small helpers whose behaviour is
 * itself worth pinning.
 */

export {
  ERROR_CODE_REGISTRY,
  WIRE_STATUS_AMBIGUITY,
  indexRegistry,
  messageFor,
  statusesFor,
} from '../../src/http/errors/code-registry.ts';

import {
  ERROR_CODE_REGISTRY,
  WIRE_STATUS_AMBIGUITY,
  statusFor,
} from '../../src/http/errors/code-registry.ts';

/** Every distinct WIRE code a response body may carry, deduplicated and sorted. */
export function wireCodes(): readonly string[] {
  return [...new Set(ERROR_CODE_REGISTRY.map((r) => r.wireCode))].sort();
}

/**
 * The status the boundary should send for a code, honouring a declared multi-status code.
 *
 * Deliberately re-implemented here from the registry rather than imported from the envelope
 * module: if this helper and `statusForEnvelope` ever disagree, the contract test is asserting
 * against the same code it is testing, which proves nothing. This reads the registry directly.
 */
export function statusForEnvelopeSafe(code: string, override?: number): number {
  const declared = WIRE_STATUS_AMBIGUITY[code];
  if (override !== undefined && declared !== undefined && declared.includes(override)) {
    return override;
  }
  return statusFor(code);
}
