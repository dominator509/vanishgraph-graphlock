/**
 * Telemetry resource identity (SPEC-007 §2.1, §2.2; EP-008 M1; DOD-029, DOD-037).
 *
 * THE NINE CANONICAL KEYS ARE THE ONLY ONES, and every emitted record carries all nine with non-empty values. Three
 * properties are the whole point of this module:
 *
 *   1. **RESOLUTION IS FAIL-CLOSED.** A producer that cannot resolve a key emits NOTHING: the refusal is a returned
 *      fact plus a counter increment, never a record with `unknown`, `n/a`, `latest` or a zero digest substituted in.
 *      Substitution is the failure this file exists to make impossible, because a substituted value looks like a
 *      measurement and is not one.
 *   2. **THE SERVICE NAME IS A CLOSED SET.** A process that cannot map itself to one of the seven declared services
 *      refuses to emit rather than emitting unattributed telemetry (§2.2: it fails startup). An unattributed record
 *      cannot be routed, alerted on or billed, and it is indistinguishable from a record produced by something nobody
 *      declared.
 *   3. **THE TWO ENUM ATTRIBUTES ARE VALIDATED AS ENUMS.** `deployment.environment.name` and `vanishgraph.tenant.class`
 *      are closed sets in §2.1, and a value outside the set is an unresolved attribute, not a free-form label. A
 *      misspelled environment would otherwise partition every series it touches.
 *
 * WHERE THE VALUES COME FROM: the deployment manifest, `RUN_MANIFEST.json`, the build output and the versioned policy
 * data — passed IN as a resolved input record so this module has no environment access and no file access of its own and
 * can be asserted without either. The composition root (`src/infrastructure/observability/compose-telemetry.ts`) is what
 * reads the files, and `.agent/verification/state/RUN_MANIFEST.json` records which key this repository can resolve
 * statically, which the process supplies, and which needs a source that does not exist yet.
 */

/** The nine canonical resource keys. Nothing else is a canonical resource attribute. */
export const CANONICAL_RESOURCE_KEYS = [
  'service.name',
  'service.version',
  'deployment.environment.name',
  'vanishgraph.tenant.class',
  'vanishgraph.candidate_epoch',
  'vanishgraph.artifact.digest',
  'vanishgraph.build.inputs_digest',
  'vanishgraph.policy.version',
  'vanishgraph.recipe.set_digest',
] as const;

export type CanonicalResourceKey = (typeof CANONICAL_RESOURCE_KEYS)[number];

/** The seven declared services. A process that is not one of these refuses to emit. */
export const DECLARED_SERVICES = [
  'vanishgraph-api',
  'vanishgraph-web',
  'vanishgraph-worker-discovery',
  'vanishgraph-worker-action',
  'vanishgraph-worker-verify',
  'vanishgraph-scheduler',
  'vanishgraph-mcp',
] as const;

export type DeclaredService = (typeof DECLARED_SERVICES)[number];

/**
 * The five environment tokens of §2.1. Everything else — including `dev`, `test`, `prod` and an empty string — is
 * unresolved, because the differences between environments are declared in this attribute and nowhere else (§1).
 */
export const ENVIRONMENT_NAMES = ['local', 'ci', 'preview', 'staging', 'production'] as const;

export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

/**
 * The five tenant classes of §2.1. This is an ENUM and never a tenant identifier (§2.1 rule 3): per-tenant telemetry is
 * produced by per-tenant recording scopes, not by a tenant label.
 */
export const TENANT_CLASSES = [
  'INTERNAL',
  'TEST',
  'PILOT_TENANT',
  'PRODUCTION_TENANT',
  'EXTERNAL_REQUIRED',
] as const;

export type TenantClass = (typeof TENANT_CLASSES)[number];

/**
 * Values that are PROHIBITED as a substitute for a resolved attribute (§2.1 rule 1).
 *
 * THEY ARE REJECTED BY VALUE, NOT BY SHAPE, because each of them is a plausible-looking answer that means "I do not
 * know": `latest` is a tag rather than a version, and a zero digest is a digest-shaped string that names nothing.
 */
const PROHIBITED_VALUES: readonly string[] = [
  'unknown',
  'n/a',
  'na',
  'latest',
  'none',
  'null',
  'undefined',
  '-',
  '0'.repeat(64),
];

/** Whether a value may serve as a canonical attribute: non-empty, not a prohibited substitute. */
export function isResolvedValue(value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return !PROHIBITED_VALUES.includes(trimmed.toLowerCase());
}

/** The counter and reason code the specification names, exported so a caller cannot misspell them. */
export const RESOURCE_ATTR_MISSING_COUNTER = 'vanishgraph_telemetry_egress_failures_total';
export const RESOURCE_ATTR_MISSING_REASON = 'RESOURCE_ATTR_MISSING';

/** The counter series, exactly as the alerting rule A-11 selects it. */
export const RESOURCE_ATTR_MISSING_SERIES =
  `${RESOURCE_ATTR_MISSING_COUNTER}{reason_code="${RESOURCE_ATTR_MISSING_REASON}"}`;

/** What the composition root resolved. Every key is present in the input, possibly as `null`. */
export type ResolvedResourceInput = Readonly<Record<CanonicalResourceKey, string | null>>;

export interface TelemetryResource {
  readonly attributes: Readonly<Record<CanonicalResourceKey, string>>;
}

/** Why one key could not be resolved, in the terms the spec uses. */
export interface UnresolvedResourceKey {
  readonly key: CanonicalResourceKey;
  /** `MISSING`, `PROHIBITED_SUBSTITUTE`, `UNDECLARED_SERVICE`, `UNKNOWN_ENVIRONMENT`, `UNKNOWN_TENANT_CLASS`. */
  readonly reason: string;
  readonly detail: string;
}

/** A refusal: the keys that could not be resolved, and the counter increment the caller must apply. */
export interface TelemetryIdentityRefusal {
  readonly ok: false;
  readonly reasonCode: typeof RESOURCE_ATTR_MISSING_REASON;
  readonly counter: typeof RESOURCE_ATTR_MISSING_COUNTER;
  readonly series: typeof RESOURCE_ATTR_MISSING_SERIES;
  readonly unresolved: readonly UnresolvedResourceKey[];
  readonly unresolvedKeys: readonly CanonicalResourceKey[];
  readonly detail: string;
}

export type TelemetryIdentityResult = ({ readonly ok: true } & TelemetryResource) | TelemetryIdentityRefusal;

/** Which keys are enum-validated, and against which members. Used by the refusal path and by the test suite. */
export const ENUM_RESOURCE_KEYS: readonly {
  readonly key: CanonicalResourceKey;
  readonly members: readonly string[];
  readonly reason: string;
}[] = Object.freeze([
  { key: 'service.name', members: DECLARED_SERVICES, reason: 'UNDECLARED_SERVICE' },
  { key: 'deployment.environment.name', members: ENVIRONMENT_NAMES, reason: 'UNKNOWN_ENVIRONMENT' },
  { key: 'vanishgraph.tenant.class', members: TENANT_CLASSES, reason: 'UNKNOWN_TENANT_CLASS' },
]);

/**
 * Resolve the nine attributes, or refuse.
 *
 * EVERY KEY IS CHECKED, NOT THE FIRST ONE: a refusal names all the unresolved keys, because a caller that fixed one
 * missing key per restart would take nine restarts to emit its first record.
 */
export function resolveTelemetryResource(input: ResolvedResourceInput): TelemetryIdentityResult {
  const unresolved: UnresolvedResourceKey[] = [];

  for (const key of CANONICAL_RESOURCE_KEYS) {
    const raw = input[key];
    // THE TRIMMED TEXT IS COMPUTED ONCE, IN A VARIABLE OF ITS OWN: `isResolvedValue` is a type predicate, so a `raw`
    // tested by it inside the failing branch narrows to `never` and the next property access does not compile. The suite
    // passed 35 of 35 while this did not typecheck, which is why the lint stage runs a compiler rather than a formatter.
    const text = raw === null || raw === undefined ? '' : raw.trim();
    if (text.length === 0) {
      unresolved.push({ key, reason: 'MISSING', detail: `${key} has no value` });
      continue;
    }
    if (!isResolvedValue(text)) {
      unresolved.push({
        key,
        reason: 'PROHIBITED_SUBSTITUTE',
        detail: `${key} is "${text}", which §2.1 rule 1 prohibits as a substitute for a resolved value`,
      });
    }
  }

  // THE ENUM KEYS ARE CHECKED ONLY WHEN THEY RESOLVED, so a missing key is reported once, as missing, rather than twice.
  for (const { key, members, reason } of ENUM_RESOURCE_KEYS) {
    if (unresolved.some((entry) => entry.key === key)) continue;
    const value = (input[key] ?? '').trim();
    if (!members.includes(value)) {
      unresolved.push({
        key,
        reason,
        detail: `${key} is "${value}", which is not one of ${members.join(', ')}`,
      });
    }
  }

  if (unresolved.length > 0) {
    return Object.freeze({
      ok: false as const,
      reasonCode: RESOURCE_ATTR_MISSING_REASON,
      counter: RESOURCE_ATTR_MISSING_COUNTER,
      series: RESOURCE_ATTR_MISSING_SERIES,
      unresolved: Object.freeze(unresolved),
      unresolvedKeys: Object.freeze(unresolved.map((entry) => entry.key)),
      detail: `${String(unresolved.length)} of the nine canonical resource attributes could not be resolved: ` +
        unresolved.map((entry) => `${entry.key} (${entry.reason})`).join(', '),
    });
  }

  const attributes = Object.fromEntries(
    CANONICAL_RESOURCE_KEYS.map((key) => [key, (input[key] ?? '').trim()]),
  ) as Record<CanonicalResourceKey, string>;
  return { ok: true, attributes: Object.freeze(attributes) };
}
