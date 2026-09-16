/**
 * The closed telemetry catalogue (SPEC-004 §12 VG-UI-075; EP-005 M7).
 *
 * A CLOSED CATALOGUE MEANS AN EVENT NAME NOT IN THIS FILE CANNOT BE EMITTED, and that is the whole design: free-form
 * strings are how a PII value ends up in an analytics parameter, and "we filter the payload" is a promise that fails the
 * first time somebody adds a field. Every event declares the exact parameters it accepts, each parameter's value passes
 * the DLP scrub class named here, and anything else is refused before it is sent.
 *
 * NOTHING IS SENT BY THIS MODULE. It builds a validated record and hands it to a sink the composition root supplies;
 * `main.tsx` supplies none, which is why the built application transmits no telemetry at all — VG-UI-075 and VG-UI-076
 * forbid PII in browser telemetry and third-party trackers on PII routes, and having nothing to remove is the cheapest
 * way to comply. (This header cited a RANGE of four VG-UI ids that SPEC-004 does not define until EP-006 M10 replaced it
 * with the two above; `tests/architecture/requirement-ids.test.ts` now enforces the lookup, and that is why the removed
 * ids are not repeated here.)
 */

import { classify } from './url.ts';

/** The egress classes a parameter may belong to, each with the rule its value must satisfy. */
export type EgressClass = 'opaque-id' | 'enum' | 'count' | 'duration-ms';

export interface TelemetryParameter {
  readonly name: string;
  readonly egress: EgressClass;
}

export interface TelemetryEventSpec {
  readonly name: string;
  readonly parameters: readonly TelemetryParameter[];
}

/** The catalogue. An event not listed here cannot be emitted. */
export const TELEMETRY_EVENTS: readonly TelemetryEventSpec[] = [
  { name: 'route.viewed', parameters: [{ name: 'routeName', egress: 'enum' }, { name: 'regionState', egress: 'enum' }] },
  { name: 'region.load_failed', parameters: [{ name: 'routeName', egress: 'enum' }, { name: 'errorCode', egress: 'enum' }, { name: 'durationMs', egress: 'duration-ms' }] },
  { name: 'gate.rendered', parameters: [{ name: 'gateKind', egress: 'enum' }] },
  { name: 'redaction.revealed', parameters: [{ name: 'artifactId', egress: 'opaque-id' }, { name: 'fieldName', egress: 'enum' }] },
  { name: 'coverage.viewed', parameters: [{ name: 'sourcesAttempted', egress: 'count' }, { name: 'sourcesTotal', egress: 'count' }] },
];

const ALLOWED_ENUM_VALUES: readonly string[] = [
  'portal',
  'console',
  'admin',
  'auditor',
  'loading',
  'ready',
  'empty',
  'partial-coverage',
  'error',
  'access-denied',
  'human-gate',
  'session-expiry',
  'identity_verification',
  'authorized_agent_instrument',
  'appeal_review',
  'unknown_route_gate',
  'display_ref',
  'identifier',
  'digest',
  'captured_at',
  'RESOURCE_NOT_FOUND',
  'UNAUTHENTICATED',
  'ACCESS_DENIED',
  'INTERNAL_ERROR',
];

/** A refused payload. */
export class TelemetryRefusedError extends Error {
  constructor(message: string) {
    super(`telemetry: ${message}`);
    this.name = 'TelemetryRefusedError';
  }
}

/** Validate a value against its egress class. Exported so the suite can drive every class directly. */
export function scrub(egress: EgressClass, value: string, name: string): string {
  // THE PII CLASSES COME FIRST, whatever the egress class says: a value that looks like an email is refused even in a
  // parameter declared as an enum, because the declaration is the caller's claim and the pattern is the check.
  const matched = classify(value);
  if (matched !== null) throw new TelemetryRefusedError(`parameter "${name}" matches PII pattern class ${matched}`);
  switch (egress) {
    case 'opaque-id':
      // An opaque reference is not a value: it must be an identifier-shaped token, never a name, an address or free text.
      if (!/^[A-Za-z0-9_-]{6,}$/.test(value)) {
        throw new TelemetryRefusedError(`parameter "${name}" is declared opaque-id but is not an opaque token`);
      }
      return value;
    case 'enum':
      if (!ALLOWED_ENUM_VALUES.includes(value)) {
        throw new TelemetryRefusedError(`parameter "${name}" is declared enum but "${value}" is not an allowlisted value`);
      }
      return value;
    case 'count':
      if (!/^\d+$/.test(value)) throw new TelemetryRefusedError(`parameter "${name}" is declared count but is not a whole number`);
      return value;
    case 'duration-ms':
      if (!/^\d+(\.\d+)?$/.test(value)) throw new TelemetryRefusedError(`parameter "${name}" is declared duration-ms but is not a number`);
      return value;
    default: {
      const never: never = egress;
      throw new TelemetryRefusedError(`unknown egress class ${String(never)}`);
    }
  }
}

export interface TelemetryRecord {
  readonly name: string;
  readonly parameters: Readonly<Record<string, string>>;
}

/** Build a validated record, or refuse the whole emission. */
export function emit(name: string, values: Readonly<Record<string, string | number>>): TelemetryRecord {
  const spec = TELEMETRY_EVENTS.find((event) => event.name === name);
  if (spec === undefined) {
    throw new TelemetryRefusedError(`"${name}" is not in the closed catalogue, so it cannot be emitted`);
  }
  const parameters: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const declared = spec.parameters.find((parameter) => parameter.name === key);
    if (declared === undefined) {
      throw new TelemetryRefusedError(`event "${name}" does not declare a parameter called "${key}"`);
    }
    parameters[key] = scrub(declared.egress, String(value), key);
  }
  for (const parameter of spec.parameters) {
    if (!(parameter.name in parameters)) {
      throw new TelemetryRefusedError(`event "${name}" is missing its declared parameter "${parameter.name}"`);
    }
  }
  return { name, parameters };
}
