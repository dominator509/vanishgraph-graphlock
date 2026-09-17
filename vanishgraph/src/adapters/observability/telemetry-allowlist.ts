/**
 * The telemetry allowlist as typed, validated data (SPEC-007 §4.1, §4.3; EP-008 M2; DOD-013, DOD-024, DOD-027).
 *
 * §4.3 states the rule this file implements: "The classification of every emitted field is data, not code comment: the
 * telemetry allowlist is versioned configuration containing field_path → EgressClass → disposition, and it is validated
 * in CI. A field with no entry is DENIED at runtime."
 *
 * SO THIS MODULE DOES NOT DECIDE WHAT IS PRIVATE. It reads the decision, validates that the decision is well formed, and
 * answers two questions for the scrub stage — what class is this field, and is this field name prohibited. The validation
 * is deliberately LOUD rather than permissive: a configuration that cannot be trusted yields a refusal that names every
 * defect at once, because a scrub stage that silently skipped a malformed rule would be the failure it exists to prevent.
 *
 * FAIL-CLOSED DIRECTION, STATED: when this module cannot produce a trustworthy allowlist, the scrub stage denies
 * everything with `POLICY_ABSENT`. There is no degraded mode in which unclassified fields are allowed.
 */

import { readFileSync } from 'node:fs';

import { EGRESS_CLASSES, type EgressClass } from '../../domain/values.ts';

/** The four dispositions of §4.3. A fifth value is a configuration defect, not a new posture. */
export const DISPOSITIONS = ['ALLOW', 'ALLOW_WITH_REDACTION', 'DENY_BY_DEFAULT', 'DENY'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** How a §4.2 rule class is enforced. See `dlp_rule_classes_note` in the configuration. */
export const RULE_ENFORCEMENTS = ['VALUE_PATTERN', 'FIELD_NAME', 'EGRESS_CLASS'] as const;
export type RuleEnforcement = (typeof RULE_ENFORCEMENTS)[number];

export interface FieldClassification {
  readonly egressClass: EgressClass;
  readonly disposition: Disposition;
  /** Present on the nine canonical resource keys: the §2.1 fail-closed reason code. */
  readonly onResolutionFailure?: string;
}

export interface DlpRuleClass {
  readonly ruleClass: string;
  readonly enforcement: RuleEnforcement;
  readonly egressClass: EgressClass;
  readonly representation: string;
  readonly enabled: boolean;
  readonly pattern?: string;
  readonly note?: string;
}

export interface ConditionalLogField {
  readonly field: string;
  readonly when: string;
  readonly scopeKey: string;
}

/** SPEC-007 §5 as data: the vocabularies and rules the logger and the guard both read (EP-008 M3). */
export interface LogContract {
  readonly severities: readonly string[];
  readonly outcomes: readonly string[];
  readonly mandatoryFields: readonly string[];
  readonly conditionalFields: readonly ConditionalLogField[];
  readonly neverSampled: readonly string[];
  readonly neverDroppedEvents: readonly string[];
  readonly successNamingProhibitedFor: readonly string[];
  readonly verifiedRemovedRequires: readonly string[];
  readonly timestampFormat: string;
}

export interface TelemetryAllowlist {
  readonly version: string;
  readonly defaultDisposition: Disposition;
  readonly sinks: readonly string[];
  readonly outcomes: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly resourceKeys: Readonly<Record<string, FieldClassification>>;
  readonly spanAttributes: Readonly<Record<string, FieldClassification>>;
  readonly logFields: Readonly<Record<string, FieldClassification>>;
  readonly prohibitedFieldNames: readonly string[];
  readonly canonicalEvents: readonly string[];
  readonly ruleClasses: readonly DlpRuleClass[];
  readonly logContract: LogContract;
  /** Every field name the allowlist knows about, so "no entry means denied" is answerable in one lookup. */
  readonly classifiedFields: ReadonlySet<string>;
}

export type AllowlistLoadResult =
  | { readonly ok: true; readonly allowlist: TelemetryAllowlist }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readClassifications(
  raw: unknown,
  section: string,
  errors: string[],
  withFailClosedMark: boolean,
): Record<string, FieldClassification> {
  const out: Record<string, FieldClassification> = {};
  if (!isRecord(raw)) {
    errors.push(`${section} must be an object of field_path → EgressClass → disposition`);
    return out;
  }
  for (const [field, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      errors.push(`${section}.${field} must be an object`);
      continue;
    }
    const egressClass = entry['egress_class'];
    const disposition = entry['disposition'];
    if (typeof egressClass !== 'string' || !(EGRESS_CLASSES as readonly string[]).includes(egressClass)) {
      errors.push(`${section}.${field}: egress_class ${JSON.stringify(egressClass)} is not one of ${EGRESS_CLASSES.join(', ')}`);
      continue;
    }
    if (typeof disposition !== 'string' || !(DISPOSITIONS as readonly string[]).includes(disposition)) {
      errors.push(`${section}.${field}: disposition ${JSON.stringify(disposition)} is not one of ${DISPOSITIONS.join(', ')}`);
      continue;
    }
    const mark = entry['on_resolution_failure'];
    if (withFailClosedMark && (typeof mark !== 'string' || mark.trim().length === 0)) {
      // A canonical resource key without its fail-closed behaviour is the one classification defect that would let an
      // unresolved attribute through, so it is an error here rather than a note.
      errors.push(`${section}.${field}: a resource key must carry on_resolution_failure`);
      continue;
    }
    out[field] = typeof mark === 'string'
      ? { egressClass: egressClass as EgressClass, disposition: disposition as Disposition, onResolutionFailure: mark }
      : { egressClass: egressClass as EgressClass, disposition: disposition as Disposition };
  }
  return out;
}

function readRuleClasses(raw: unknown, errors: string[]): DlpRuleClass[] {
  if (!Array.isArray(raw)) {
    errors.push('dlp_rule_classes must be an array of §4.2 rule classes');
    return [];
  }
  const seen = new Set<string>();
  const out: DlpRuleClass[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      errors.push(`dlp_rule_classes[${String(index)}] must be an object`);
      continue;
    }
    const ruleClass = entry['rule_class'];
    const enforcement = entry['enforcement'];
    const egressClass = entry['egress_class'];
    if (typeof ruleClass !== 'string' || ruleClass.trim().length === 0) {
      errors.push(`dlp_rule_classes[${String(index)}]: rule_class must be a non-empty string`);
      continue;
    }
    if (seen.has(ruleClass)) {
      errors.push(`dlp_rule_classes: ${ruleClass} appears twice; one class, one enforcement`);
      continue;
    }
    seen.add(ruleClass);
    if (typeof enforcement !== 'string' || !(RULE_ENFORCEMENTS as readonly string[]).includes(enforcement)) {
      errors.push(`dlp_rule_classes.${ruleClass}: enforcement must be one of ${RULE_ENFORCEMENTS.join(', ')}`);
      continue;
    }
    if (typeof egressClass !== 'string' || !(EGRESS_CLASSES as readonly string[]).includes(egressClass)) {
      errors.push(`dlp_rule_classes.${ruleClass}: egress_class ${JSON.stringify(egressClass)} is not a declared EgressClass`);
      continue;
    }
    if (entry['enabled'] !== true && entry['enabled'] !== false) {
      errors.push(`dlp_rule_classes.${ruleClass}: enabled must be true or false, stated explicitly`);
      continue;
    }
    const pattern = entry['pattern'];
    if (enforcement === 'VALUE_PATTERN') {
      if (typeof pattern !== 'string' || pattern.length === 0) {
        errors.push(`dlp_rule_classes.${ruleClass}: a VALUE_PATTERN class must carry a pattern`);
        continue;
      }
      try {
        new RegExp(pattern);
      } catch {
        errors.push(`dlp_rule_classes.${ruleClass}: the pattern is not a compilable regular expression`);
        continue;
      }
    } else if (pattern !== undefined) {
      errors.push(`dlp_rule_classes.${ruleClass}: enforcement is ${enforcement}, so a pattern would be dead configuration`);
      continue;
    }
    const note = entry['note'];
    const representation = entry['representation'];
    if (typeof representation !== 'string' || representation.trim().length === 0) {
      errors.push(`dlp_rule_classes.${ruleClass}: representation must say what may leave instead`);
      continue;
    }
    out.push({
      ruleClass,
      enforcement: enforcement as RuleEnforcement,
      egressClass: egressClass as EgressClass,
      representation,
      enabled: entry['enabled'],
      ...(typeof pattern === 'string' ? { pattern } : {}),
      ...(typeof note === 'string' ? { note } : {}),
    });
  }
  return out;
}

function readLogContract(raw: unknown, errors: string[]): LogContract {
  if (!isRecord(raw)) {
    errors.push('log_contract must be an object carrying the §5 vocabularies and rules');
    return { severities: [], outcomes: [], mandatoryFields: [], conditionalFields: [], neverSampled: [], neverDroppedEvents: [], successNamingProhibitedFor: [], verifiedRemovedRequires: [], timestampFormat: '' };
  }
  const contract: LogContract = {
    severities: readStringArray(raw['severities'], 'log_contract.severities', errors),
    outcomes: readStringArray(raw['outcomes'], 'log_contract.outcomes', errors),
    mandatoryFields: readStringArray(raw['mandatory_fields'], 'log_contract.mandatory_fields', errors),
    conditionalFields: [],
    neverSampled: readStringArray(raw['never_sampled'], 'log_contract.never_sampled', errors),
    neverDroppedEvents: readStringArray(raw['never_dropped_events'], 'log_contract.never_dropped_events', errors),
    successNamingProhibitedFor: readStringArray(raw['success_naming_prohibited_for'], 'log_contract.success_naming_prohibited_for', errors),
    verifiedRemovedRequires: readStringArray(raw['verified_removed_requires'], 'log_contract.verified_removed_requires', errors),
    timestampFormat: typeof raw['timestamp_format'] === 'string' ? raw['timestamp_format'] : '',
  };
  if (contract.timestampFormat.trim().length === 0) errors.push('log_contract.timestamp_format must state the required form');
  // THE MANDATORY FIELDS OF §5.2 ARE NAMED HERE RATHER THAN TRUSTED FROM THE DOCUMENT: a configuration that dropped one
  // of them would make every record valid against a contract that no longer matches the specification.
  for (const required of ['timestamp', 'severity', 'service', 'correlationId', 'tenantId', 'event', 'outcome', 'message', 'candidateEpoch', 'artifactDigest']) {
    if (!contract.mandatoryFields.includes(required)) errors.push(`log_contract.mandatory_fields must include ${required} (§5.2)`);
  }
  for (const required of ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']) {
    if (!contract.severities.includes(required)) errors.push(`log_contract.severities must include ${required} (§5.1)`);
  }
  const conditional = raw['conditional_fields'];
  if (!Array.isArray(conditional)) {
    errors.push('log_contract.conditional_fields must be an array');
    return contract;
  }
  const fields: ConditionalLogField[] = [];
  for (const entry of conditional) {
    if (!isRecord(entry) || typeof entry['field'] !== 'string' || typeof entry['when'] !== 'string' || typeof entry['scope_key'] !== 'string') {
      errors.push('log_contract.conditional_fields entries must carry field, when and scope_key');
      continue;
    }
    fields.push({ field: entry['field'], when: entry['when'], scopeKey: entry['scope_key'] });
  }
  return { ...contract, conditionalFields: fields };
}

function readStringArray(raw: unknown, section: string, errors: string[]): string[] {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    errors.push(`${section} must be an array of strings`);
    return [];
  }
  return raw as string[];
}

/**
 * Validate a parsed allowlist document.
 *
 * PURE, SO IT CAN BE TESTED WITHOUT A FILE AND SO THE NEGATIVE CASES ARE CHEAP: every check below is exercised by the
 * canary suite against a document that has the defect, which is what proves the validation is not decoration.
 */
export function parseTelemetryAllowlist(raw: unknown): AllowlistLoadResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['the allowlist must be a JSON object'] };

  // THE NARROWING IS DONE BY BUILDING A TYPED VALUE, NOT BY A GUARD THAT PUSHES AN ERROR: a guard that only records a
  // problem does not narrow the variable afterwards, which the compiler reported as `version: unknown` at the return.
  const rawVersion = raw['version'];
  const version = typeof rawVersion === 'string' && rawVersion.trim().length > 0 ? rawVersion : '';
  if (version.length === 0) errors.push('version must be a non-empty string');

  const defaultDisposition = raw['default_disposition'];
  if (defaultDisposition !== 'DENY') {
    // §4.1: "an input that is not explicitly permitted by the telemetry allowlist is denied". A default of ALLOW is the
    // one change that would silently invert the whole stage, so it is refused rather than warned about.
    errors.push(`default_disposition must be DENY (a field with no entry is denied); found ${JSON.stringify(defaultDisposition)}`);
  }

  const sinks = readStringArray(raw['dlp_sinks'], 'dlp_sinks', errors);
  const outcomes = readStringArray(raw['dlp_outcomes'], 'dlp_outcomes', errors);
  const reasonCodes = readStringArray(raw['dlp_reason_codes'], 'dlp_reason_codes', errors);

  const resourceKeys = readClassifications(raw['resource_keys'], 'resource_keys', errors, true);
  const spanAttributes = readClassifications(raw['span_attributes'], 'span_attributes', errors, false);
  const logFields = readClassifications(raw['log_fields'], 'log_fields', errors, false);
  const prohibitedFieldNames = readStringArray(raw['prohibited_field_names'], 'prohibited_field_names', errors);
  const canonicalEvents = readStringArray(raw['canonical_events'], 'canonical_events', errors);
  const ruleClasses = readRuleClasses(raw['dlp_rule_classes'], errors);
  const logContract = readLogContract(raw['log_contract'], errors);

  const classifiedFields = new Set([
    ...Object.keys(resourceKeys),
    ...Object.keys(spanAttributes),
    ...Object.keys(logFields),
  ]);

  for (const name of prohibitedFieldNames) {
    if (classifiedFields.has(name)) {
      errors.push(`"${name}" is prohibited by SPEC-007 §5.3 and is also classified as an emittable field`);
    }
  }
  // A CLASSIFIED FIELD MAY CARRY A DENIED DISPOSITION, AND THAT IS NOT A DEFECT: §4.3's model is that a field can be
  // classified CUSTOMER_PII with disposition DENY_BY_DEFAULT — the entry records the decision that the field is denied.
  // What the scrub stage must never do is emit it, and that is enforced at run time by the gate, not here.

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    allowlist: Object.freeze({
      version,
      defaultDisposition: 'DENY' as Disposition,
      sinks,
      outcomes,
      reasonCodes,
      resourceKeys,
      spanAttributes,
      logFields,
      prohibitedFieldNames,
      canonicalEvents,
      ruleClasses,
      logContract,
      classifiedFields,
    }),
  };
}

/** Read and validate the allowlist from a path. A missing or unparseable file is a refusal, never an empty policy. */
export function loadTelemetryAllowlist(path: string): AllowlistLoadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, errors: [`the telemetry allowlist at ${path} could not be read`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`the telemetry allowlist at ${path} is not valid JSON: ${(error as Error).message}`] };
  }
  const result = parseTelemetryAllowlist(parsed);
  if (!result.ok && result.errors.length > 0) {
    return { ok: false, errors: result.errors.map((entry) => `${path}: ${entry}`) };
  }
  return result;
}

/** The classification of a field, or `undefined` — and `undefined` means DENIED (§4.3). */
export function classifyField(allowlist: TelemetryAllowlist, fieldPath: string): FieldClassification | undefined {
  return allowlist.resourceKeys[fieldPath] ?? allowlist.spanAttributes[fieldPath] ?? allowlist.logFields[fieldPath];
}

/**
 * Every prohibited field NAME at any nesting depth, in the order encountered (§5.3, second line of defence).
 *
 * THE EXEMPTION IS EXACTLY THE NINE RESOURCE KEYS and it is applied by the CALLER through the path it passes: a resource
 * attribute named `service.name` is not a record field, which is the conflict the configuration records in its own
 * `resource_key_note`. This function is not given the resource, so it cannot exempt anything by accident.
 */
export function findProhibitedFieldNames(allowlist: TelemetryAllowlist, value: unknown, prefix = ''): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) found.push(...findProhibitedFieldNames(allowlist, entry, `${prefix}[${String(index)}]`));
    return found;
  }
  if (typeof value !== 'object' || value === null) return found;
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix.length === 0 ? name : `${prefix}.${name}`;
    if (allowlist.prohibitedFieldNames.includes(name)) found.push(path);
    found.push(...findProhibitedFieldNames(allowlist, entry, path));
  }
  return found;
}
