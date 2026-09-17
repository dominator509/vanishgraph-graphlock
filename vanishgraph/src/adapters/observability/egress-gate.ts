/**
 * The mandatory DLP scrubbing stage and the five egress sink adapters (SPEC-007 §4.1-§4.4, §2.3; EP-008 M2; DOD-013,
 * DOD-024, DOD-027).
 *
 * THE PIPELINE THIS FILE IMPLEMENTS, VERBATIM FROM §4.1:
 *
 *   producer → record(...) → classify → scrub (deny-by-default) → [accepted payload + scrub token] → sink adapter → egress
 *
 * FOUR PROPERTIES ARE ENFORCED HERE RATHER THAN DOCUMENTED, because each of them is a way the product could disclose
 * something while appearing to be careful:
 *
 *   1. **A SINK CANNOT BE REACHED WITHOUT A TOKEN.** `AcceptedPayload` carries a brand that only this module can apply,
 *      and every sink adapter's `send` takes that type. Passing a hand-built object is a compile error, not a code
 *      review finding, and the runtime refusal exists underneath the type in case something is cast.
 *   2. **THE DEFAULT IS DENY.** A field with no entry in `config/telemetry/allowlist.json` is denied (NOT_ALLOWLISTED);
 *      a prohibited field NAME at any depth is denied (PROHIBITED_FIELD_NAME); a field whose `EgressClass` is not
 *      permitted is denied (PROHIBITED_CLASS). Nothing is "best-effort cleaned" (§4.1).
 *   3. **AN ENCODED PROHIBITED VALUE IS REFUSED, NOT DECODED AND CLEANED.** A base64-, percent- or truncation-encoded
 *      address is a deliberate attempt to cross the boundary with a value the scanner is meant to miss, so the outcome
 *      is DENIED with CANARY_DETECTED and no payload at all. Redacting a decoded region would be a judgement call made
 *      by the same code that was just evaded.
 *   4. **FAILED BEHAVES AS DENIED, AND AN UNUSABLE POLICY DENIES EVERYTHING.** A configuration that cannot be validated
 *      produces POLICY_ABSENT and no payload, never a partially applied policy.
 *
 * WHAT THIS FILE DOES NOT DO, STATED SO IT IS NOT ASSUMED: it does not talk to a network. Four of the five sinks have no
 * reachable endpoint in this environment and one of them — the log forwarder — is the platform agent reading standard
 * output. Each sink therefore serialises to the exact bytes its transport would send and hands them to a local capture
 * through the SAME code path, and each sink's row carries `BLOCKED_ENVIRONMENT` with the reason, which is the FALLBACK
 * the node plan prescribes. The canary assertion in the suite runs on those captured bytes; no sink is assumed clean.
 *
 * RELATIONSHIP TO `src/application/security/egress-gate.ts`: that gate decides whether a PRODUCT payload (a source fetch,
 * controller correspondence) may leave. This one is the telemetry plane's scrub stage. They are separate because their
 * classes, outcomes and reason codes are separate vocabularies, and merging them would make one module's default the
 * other's policy.
 */

import { createHash } from 'node:crypto';

import { EGRESS_CLASSES, type EgressClass } from '../../domain/values.ts';
import {
  loadTelemetryAllowlist,
  type DlpRuleClass,
  type TelemetryAllowlist,
} from './telemetry-allowlist.ts';

/** The five egress sinks of §4.1. There are exactly five, and this list is the whole of them. */
export const DLP_SINKS = [
  'OTLP_TRACE_EXPORTER',
  'LOG_FORWARDER',
  'ERROR_REPORTER',
  'PR_ISSUE_EXPORTER',
  'DEBUG_BUNDLE',
] as const;

export type DlpSinkName = (typeof DLP_SINKS)[number];

/** §4.1: the outcomes are exactly these four, and FAILED behaves as DENIED. */
export const SCRUB_OUTCOMES = ['ALLOWED_OPAQUE', 'REDACTED', 'DENIED', 'FAILED'] as const;
export type ScrubOutcome = (typeof SCRUB_OUTCOMES)[number];

export const DLP_REASON_CODES = [
  'NOT_ALLOWLISTED',
  'PROHIBITED_CLASS',
  'PROHIBITED_FIELD_NAME',
  'POLICY_ABSENT',
  'SCRUB_FAILED',
  'CANARY_DETECTED',
] as const;
export type DlpReasonCode = (typeof DLP_REASON_CODES)[number];

/** The counters §4.1 and §8 (A-06, A-06c) name. */
export const SCRUB_OUTCOME_COUNTER = 'vanishgraph_dlp_scrub_outcome_total';
export const EGRESS_DENIED_COUNTER = 'vanishgraph_dlp_egress_denied_total';
export const CANARY_DETECTIONS_COUNTER = 'vanishgraph_dlp_canary_detections_total';

/**
 * The `sink` LABEL VALUES ARE THE CATALOGUE'S, NOT THIS MODULE'S NAMES.
 *
 * `vanishgraph_dlp_scrub_outcome_total`, `vanishgraph_dlp_egress_denied_total` and
 * `vanishgraph_dlp_canary_detections_total` declare `sink` ∈ {TRACE, LOG, ERROR_REPORT, PR_ISSUE, DEBUG_BUNDLE}
 * (SPEC-007 §6.5), and §6.2 prohibits a label whose value set is not a bounded enum. MEASURED: this module's first
 * version emitted its own identifiers (`LOG_FORWARDER`, `OTLP_TRACE_EXPORTER`, …) as the label value, which is outside
 * that bounded set — a series the alerts A-06/A-06c would match on the metric name and then fail to group correctly, and
 * a catalogue violation the metrics guard reports. The adapter's internal name and the metric's label value are
 * therefore two values, with one mapping between them, and `tests/observability/metrics-catalogue.test.ts` asserts the
 * mapping lands inside the catalogue's declared set.
 */
export const SINK_LABEL_VALUES: Readonly<Record<DlpSinkName, string>> = Object.freeze({
  OTLP_TRACE_EXPORTER: 'TRACE',
  LOG_FORWARDER: 'LOG',
  ERROR_REPORTER: 'ERROR_REPORT',
  PR_ISSUE_EXPORTER: 'PR_ISSUE',
  DEBUG_BUNDLE: 'DEBUG_BUNDLE',
});

/**
 * The brand that makes a payload acceptable to a sink. It is declared here and applied only by `accept()`, so an object
 * literal cannot satisfy `AcceptedPayload`: the type system refuses it before the runtime does.
 */
declare const scrubTokenBrand: unique symbol;

export interface AcceptedPayload {
  readonly [scrubTokenBrand]: 'ACCEPTED_BY_SCRUB_STAGE';
  readonly sink: DlpSinkName;
  readonly outcome: 'ALLOWED_OPAQUE' | 'REDACTED';
  /** Digest over the accepted content. It is the auditable proof that a sink received the scrubbed payload. */
  readonly scrubToken: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly resource: Readonly<Record<string, string>>;
  readonly redactionRuleClass: string | null;
  readonly redactionCount: number;
}

export interface ScrubRefusal {
  readonly ok: false;
  readonly outcome: 'DENIED' | 'FAILED';
  readonly reasonCode: DlpReasonCode;
  readonly detail: string;
  /** The field path the refusal is about, when there is one. A denial names where it happened. */
  readonly fieldPath: string | null;
  /** The §4.2 rule class involved, when there is one. */
  readonly ruleClass: string | null;
}

export interface ScrubAcceptance {
  readonly ok: true;
  readonly outcome: 'ALLOWED_OPAQUE' | 'REDACTED';
  readonly payload: AcceptedPayload;
}

export type ScrubResult = ScrubAcceptance | ScrubRefusal;

export interface GateInput {
  /** The producer's fields. Each NAME must be classified by the allowlist, or the record is denied. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** The nine canonical resource attributes (EP-008 M1). Their values are scanned, never rewritten. */
  readonly resource: Readonly<Record<string, string>>;
}

export interface EgressGate {
  scrub(sink: DlpSinkName, input: GateInput): ScrubResult;
  counters(): Readonly<Record<string, number>>;
  /** The §4.2 classes this gate does NOT apply. Empty in every shipped configuration; non-empty is a control state. */
  disabledRuleClasses(): readonly string[];
  /** Every refusal this gate produced, in order, so a caller can observe denials rather than infer them. */
  refusals(): readonly ScrubRefusal[];
}

interface CompiledRule {
  readonly ruleClass: string;
  readonly enforcement: DlpRuleClass['enforcement'];
  readonly egressClass: EgressClass;
  readonly regex: RegExp | null;
}

function compileRules(ruleClasses: readonly DlpRuleClass[], disabled: readonly string[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of ruleClasses) {
    if (!rule.enabled || disabled.includes(rule.ruleClass)) continue;
    compiled.push({
      ruleClass: rule.ruleClass,
      enforcement: rule.enforcement,
      egressClass: rule.egressClass,
      regex: rule.pattern === undefined ? null : new RegExp(rule.pattern, 'g'),
    });
  }
  return compiled;
}

/** The field names §5.3 prohibits; a record field by one of these names is denied before its value is looked at. */
function isProhibitedName(allowlist: TelemetryAllowlist, name: string): boolean {
  return allowlist.prohibitedFieldNames.includes(name);
}

/** A value that could be an encoding of a prohibited value, with the encoding named for the refusal detail. */
function encodedForms(value: string): { readonly form: string; readonly encoding: string }[] {
  const forms: { form: string; encoding: string }[] = [];

  // PERCENT-DECODING. `decodeURIComponent` throws on a malformed sequence, which is not an encoding we can read.
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) forms.push({ form: decoded, encoding: 'percent' });
  } catch {
    // A malformed percent sequence is not a decodable form; it is left to the plain scan.
  }

  // BASE64. Every plausible token is decoded and rescanned; a token that decodes to text containing a prohibited class
  // is the smuggling shape this check exists for.
  //
  // THE THRESHOLD AND THE ROUND-TRIP ARE BOTH MEASURED, NOT GUESSED. MEASURED: with a 16-character minimum the base64 of
  // a short value was never examined at all — the base64 of a telephone number ("+1 555-0142") is 15 characters plus
  // padding, so the canary of that class crossed the boundary intact while the check appeared to run. The minimum is
  // therefore eight, and a candidate must survive a CANONICAL ROUND-TRIP (re-encoding the decoded bytes reproduces the
  // token) and decode to printable ASCII before it is treated as base64 at all. Without those two conditions, lowering
  // the threshold would turn every short token in ordinary text into a candidate decoding and deny ordinary records.
  for (const match of value.matchAll(/[A-Za-z0-9+/]{8,}={0,2}/g)) {
    const token = match[0];
    let decoded: string;
    try {
      decoded = Buffer.from(token, 'base64').toString('utf8');
    } catch {
      continue;
    }
    if (decoded.length === 0 || !/^[\x20-\x7e]+$/.test(decoded)) continue;
    if (Buffer.from(decoded, 'utf8').toString('base64') !== token) continue;
    if (decoded === token) continue;
    forms.push({ form: decoded, encoding: 'base64' });
  }

  return forms;
}

/**
 * A TRUNCATED PREFIX OF A CONTACT VALUE IS ITS OWN SHAPE, and it is refused rather than redacted.
 *
 * MEASURED REASONING, NOT A GUESS: `alice.smith@exa` matches no complete email pattern, so a scanner that only looks for
 * well-formed addresses passes it through — and a truncated address still discloses the local part and part of the
 * domain. §4.2 lists a truncated prefix among the encodings that must never leave, so the shape `local@partial` with no
 * established TLD is refused. It errs toward denial, which is the direction §4.1 requires.
 *
 * THE DOMAIN PART IS ALLOWED TO BE EMPTY, AND THAT WAS MEASURED TOO: the first version of this pattern required at least
 * one character after the `@`, so a truncation that cut exactly at the `@` — `renbel.corvor@`, which discloses the whole
 * local part — passed the check and reached the exported bytes. The suite's truncation case caught it.
 */
const TRUNCATED_CONTACT_SHAPE = /[A-Za-z0-9._%+-]{3,}@[A-Za-z0-9-]{0,}(?:\.[A-Za-z0-9-]+)?$/;

function truncationRefusal(value: string, compiled: readonly CompiledRule[]): string | null {
  const trimmed = value.trim();
  if (!TRUNCATED_CONTACT_SHAPE.test(trimmed)) return null;
  // THE HEURISTIC BELONGS TO THE EMAIL_ADDRESS CLASS, SO DISABLING THAT CLASS DISABLES IT TOO. That is what makes the
  // disabled-rule control a real control: with the class switched off, a complete address must pass through, and a
  // heuristic that kept firing on complete addresses would keep refusing them and hide the very gap the control measures.
  const email = compiled.find((rule) => rule.ruleClass === 'EMAIL_ADDRESS');
  if (email === undefined || email.regex === null) return null;
  email.regex.lastIndex = 0;
  // A COMPLETE address is not a truncation; it is handled by the class's own scan, which redacts it.
  if (email.regex.test(trimmed)) return null;
  return 'EMAIL_ADDRESS';
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface EgressGateOptions {
  readonly allowlist: TelemetryAllowlist;
  /** §4.2 classes the gate does not apply. Used ONLY by the canary stage's disabled-rule control. */
  readonly disabledRuleClasses?: readonly string[];
}

/**
 * Build the scrub stage.
 *
 * THE COUNTERS ARE LABELLED EXACTLY AS THE ALERTS SELECT THEM: the outcome counter carries `outcome`, the denial counter
 * carries `reason_code`, and the canary counter carries `sink` (A-06, A-06b, A-06c). A counter with a different label set
 * would leave the alert silently matching nothing, which is the failure mode §8 exists to prevent.
 */
export function createEgressGate(options: EgressGateOptions): EgressGate {
  const allowlist = options.allowlist;
  const disabled = options.disabledRuleClasses ?? [];
  const rules = compileRules(allowlist.ruleClasses, disabled);
  const counters: Record<string, number> = {};
  const refusals: ScrubRefusal[] = [];

  const bump = (name: string): void => {
    counters[name] = (counters[name] ?? 0) + 1;
  };

  const refuse = (
    sink: DlpSinkName,
    outcome: 'DENIED' | 'FAILED',
    reasonCode: DlpReasonCode,
    detail: string,
    fieldPath: string | null,
    ruleClass: string | null,
  ): ScrubRefusal => {
    bump(`${SCRUB_OUTCOME_COUNTER}{outcome="${outcome}"}`);
    bump(`${EGRESS_DENIED_COUNTER}{reason_code="${reasonCode}"}`);
    if (reasonCode === 'CANARY_DETECTED') bump(`${CANARY_DETECTIONS_COUNTER}{sink="${SINK_LABEL_VALUES[sink]}"}`);
    const refusal: ScrubRefusal = Object.freeze({ ok: false as const, outcome, reasonCode, detail, fieldPath, ruleClass });
    refusals.push(refusal);
    return refusal;
  };

  const accept = (
    sink: DlpSinkName,
    outcome: 'ALLOWED_OPAQUE' | 'REDACTED',
    fields: Record<string, string>,
    resource: Record<string, string>,
    redactionRuleClass: string | null,
    redactionCount: number,
  ): ScrubAcceptance => {
    bump(`${SCRUB_OUTCOME_COUNTER}{outcome="${outcome}"}`);
    const content = JSON.stringify({ sink, outcome, fields, resource, redactionRuleClass, redactionCount });
    const payload = Object.freeze({
      sink,
      outcome,
      scrubToken: `scrub-${sha256(content).slice(0, 32)}`,
      fields: Object.freeze(fields),
      resource: Object.freeze(resource),
      redactionRuleClass,
      redactionCount,
    }) as AcceptedPayload;
    return { ok: true, outcome, payload };
  };

  return {
    scrub: (sink, input) => {
      // THE POLICY IS CHECKED FIRST. A malformed allowlist denies everything rather than applying the part that parsed.
      if (allowlist.ruleClasses.length === 0) {
        return refuse(sink, 'FAILED', 'POLICY_ABSENT', 'the allowlist carries no §4.2 rule classes, so no scrub could run', null, null);
      }

      const fields: Record<string, string> = {};
      const resource: Record<string, string> = {};
      let redactionRuleClass: string | null = null;
      let redactionCount = 0;

      // RESOURCE ATTRIBUTES FIRST: their values are scanned and a match is a DENIAL rather than a redaction, because
      // rewriting a canonical attribute would produce a record that claims an identity it does not have.
      for (const [key, value] of Object.entries(input.resource)) {
        for (const rule of rules) {
          if (rule.regex === null || rule.enforcement !== 'VALUE_PATTERN') continue;
          rule.regex.lastIndex = 0;
          if (rule.regex.test(value)) {
            return refuse(
              sink,
              'DENIED',
              'PROHIBITED_CLASS',
              `resource attribute ${key} carries the ${rule.ruleClass} class, and a canonical attribute is never rewritten`,
              key,
              rule.ruleClass,
            );
          }
        }
        resource[key] = value;
      }

      for (const [name, raw] of Object.entries(input.fields)) {
        if (isProhibitedName(allowlist, name)) {
          // THE NAME CHECK IS THE SECOND LINE OF DEFENCE (§5.3): a field called `email` is refused whether or not its
          // value looks like an address, because the name is what a downstream consumer trusts.
          return refuse(sink, 'DENIED', 'PROHIBITED_FIELD_NAME', `"${name}" is a prohibited field name`, name, null);
        }
        const classification = allowlist.classifiedFields.has(name)
          ? (allowlist.logFields[name] ?? allowlist.spanAttributes[name] ?? allowlist.resourceKeys[name])
          : undefined;
        if (classification === undefined) {
          return refuse(sink, 'DENIED', 'NOT_ALLOWLISTED', `"${name}" has no classification in the telemetry allowlist`, name, null);
        }
        if (classification.disposition !== 'ALLOW') {
          return refuse(
            sink,
            'DENIED',
            'PROHIBITED_CLASS',
            `"${name}" is classified ${classification.egressClass} with disposition ${classification.disposition}`,
            name,
            null,
          );
        }
        if (typeof raw !== 'string') {
          return refuse(sink, 'FAILED', 'SCRUB_FAILED', `"${name}" is not a string value, so it cannot be scrubbed`, name, null);
        }

        let value = raw;
        const truncated = truncationRefusal(value, rules);
        if (truncated !== null) {
          return refuse(
            sink,
            'DENIED',
            'CANARY_DETECTED',
            `"${name}" carries a truncated form of the ${truncated} class, which §4.2 lists among the encodings that must never leave`,
            name,
            truncated,
          );
        }

        for (const form of encodedForms(value)) {
          for (const rule of rules) {
            if (rule.regex === null || rule.enforcement !== 'VALUE_PATTERN') continue;
            rule.regex.lastIndex = 0;
            if (rule.regex.test(form.form)) {
              return refuse(
                sink,
                'DENIED',
                'CANARY_DETECTED',
                `"${name}" carries the ${rule.ruleClass} class ${form.encoding}-encoded, which is refused rather than decoded and cleaned`,
                name,
                rule.ruleClass,
              );
            }
          }
        }

        for (const rule of rules) {
          if (rule.regex === null || rule.enforcement !== 'VALUE_PATTERN') continue;
          rule.regex.lastIndex = 0;
          if (rule.regex.test(value)) {
            value = value.replace(rule.regex, `[REDACTED:${rule.ruleClass}]`);
            redactionRuleClass = rule.ruleClass;
            redactionCount += 1;
          }
        }
        // A RESIDUAL MATCH AFTER REDACTION IS A FAILURE, NOT A PASS: this is the check that stops a pattern whose
        // replacement reintroduces the class it removed.
        for (const rule of rules) {
          if (rule.regex === null || rule.enforcement !== 'VALUE_PATTERN') continue;
          rule.regex.lastIndex = 0;
          if (rule.regex.test(value)) {
            return refuse(sink, 'FAILED', 'SCRUB_FAILED', `"${name}" still matches ${rule.ruleClass} after redaction`, name, rule.ruleClass);
          }
        }
        fields[name] = value;
      }

      return accept(sink, redactionCount > 0 ? 'REDACTED' : 'ALLOWED_OPAQUE', fields, resource, redactionRuleClass, redactionCount);
    },
    counters: () => Object.freeze({ ...counters }),
    disabledRuleClasses: () => Object.freeze([...disabled]),
    refusals: () => refusals,
  };
}

/** Build the gate from the versioned configuration. A policy that cannot be validated yields a gate that denies all. */
export function createEgressGateFromFile(path: string, options?: { readonly disabledRuleClasses?: readonly string[] }): EgressGate {
  const loaded = loadTelemetryAllowlist(path);
  if (!loaded.ok) {
    // NO DEGRADED MODE: the refusal is carried into every scrub call as POLICY_ABSENT, with the validation errors kept so
    // the reason is readable rather than a bare denial.
    const errors = loaded.errors;
    const detail = `the telemetry allowlist could not be validated: ${errors.join('; ')}`;
    const counters: Record<string, number> = {};
    return {
      scrub: (_sink, _input) => {
        counters[`${SCRUB_OUTCOME_COUNTER}{outcome="FAILED"}`] = (counters[`${SCRUB_OUTCOME_COUNTER}{outcome="FAILED"}`] ?? 0) + 1;
        counters[`${EGRESS_DENIED_COUNTER}{reason_code="POLICY_ABSENT"}`] = (counters[`${EGRESS_DENIED_COUNTER}{reason_code="POLICY_ABSENT"}`] ?? 0) + 1;
        return { ok: false, outcome: 'FAILED', reasonCode: 'POLICY_ABSENT', detail, fieldPath: null, ruleClass: null };
      },
      counters: () => Object.freeze({ ...counters }),
      disabledRuleClasses: () => Object.freeze([]),
      refusals: () => Object.freeze([]),
    };
  }
  return createEgressGate({
    allowlist: loaded.allowlist,
    ...(options?.disabledRuleClasses === undefined ? {} : { disabledRuleClasses: options.disabledRuleClasses }),
  });
}

/** The egress class vocabulary is the domain's; re-exported so a caller of this module does not import two places. */
export const GATE_EGRESS_CLASSES: readonly EgressClass[] = EGRESS_CLASSES;

/* ----------------------------------------------------------------------------------------------------------------
 * The five sink adapters
 *
 * WHY THEY LIVE IN THIS FILE: the node plan lists exactly two source files for the scrub milestone, and the property
 * that matters is not file layout but that a sink's send function cannot be called without a token. Keeping the token
 * type and every function that accepts it in one module makes that property local and checkable rather than spread
 * across five files that each have to be trusted.
 *
 * WHAT IS AND IS NOT CLAIMED: each adapter SERIALISES the exact bytes its transport would send, so the canary assertion
 * runs on exported bytes rather than on an in-process object graph (§4.4 item 4). No adapter opens a network connection
 * in this milestone, and none claims a delivery: the bytes go to a local capture through the same code path, and each
 * sink's row says whether an external endpoint is even configured.
 * ---------------------------------------------------------------------------------------------------------------- */

export interface SinkStatusRow {
  readonly sink: DlpSinkName;
  /** `CONFIGURED` means the environment names an endpoint; `BLOCKED_ENVIRONMENT` means it does not. */
  readonly status: 'CONFIGURED' | 'BLOCKED_ENVIRONMENT';
  readonly envVar: string | null;
  readonly detail: string;
}

export type SinkSendResult =
  | { readonly ok: true; readonly bytes: string; readonly digest: string }
  | { readonly ok: false; readonly reason: 'BLOCKED_ENVIRONMENT'; readonly detail: string };

export interface SinkAdapters {
  /** Requires the token type. There is no overload that accepts a plain object. */
  send(payload: AcceptedPayload): SinkSendResult;
  /** The bytes each sink exported, in order, exactly as the transport would have sent them. */
  exported(sink: DlpSinkName): readonly string[];
  rows(): readonly SinkStatusRow[];
}

const SINK_ENV_VARS: Readonly<Record<DlpSinkName, string | null>> = Object.freeze({
  OTLP_TRACE_EXPORTER: 'OTEL_EXPORTER_OTLP_ENDPOINT',
  LOG_FORWARDER: 'VANISHGRAPH_LOG_FORMAT',
  ERROR_REPORTER: 'VANISHGRAPH_ERROR_REPORTING_DSN',
  // NO SPECIFICATION DECLARES A VARIABLE FOR THESE TWO, and this milestone does not invent one: naming a variable that
  // no specification defines would create a configuration surface with no contract behind it. The rows say so.
  PR_ISSUE_EXPORTER: null,
  DEBUG_BUNDLE: null,
});

/** One sink's transport rendering. Each is deliberately a different shape: five identical serialisations would be one sink. */
function serialize(
  sink: DlpSinkName,
  payload: AcceptedPayload,
  timestamp: string,
): string {
  const attributes = { ...payload.resource, ...payload.fields };
  switch (sink) {
    case 'OTLP_TRACE_EXPORTER':
      return JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: Object.entries(payload.resource).map(([key, value]) => ({ key, value: { stringValue: value } })) },
            scopeSpans: [
              {
                scope: { name: 'vanishgraph.observability' },
                spans: [
                  {
                    name: 'vanishgraph.telemetry.egress',
                    startTimeUnixNano: timestamp,
                    attributes: Object.entries(payload.fields).map(([key, value]) => ({ key, value: { stringValue: value } })),
                  },
                ],
              },
            ],
          },
        ],
      });
    case 'LOG_FORWARDER':
      return JSON.stringify({ timestamp, severity: 'INFO', service: payload.resource['service.name'] ?? '', ...attributes });
    case 'ERROR_REPORTER':
      return JSON.stringify({
        event_id: payload.scrubToken,
        timestamp,
        level: 'error',
        message: payload.fields['message'] ?? '',
        tags: { scrub_outcome: payload.outcome, redaction_rule_class: payload.redactionRuleClass ?? '' },
        extra: attributes,
      });
    case 'PR_ISSUE_EXPORTER':
      return [
        '### Repair capsule (DLP-scrubbed before egress)',
        '',
        `scrub outcome: ${payload.outcome}`,
        `redaction rule class: ${payload.redactionRuleClass ?? 'none'}`,
        '',
        ...Object.entries(payload.fields).map(([key, value]) => `- ${key}: ${value}`),
      ].join('\n');
    case 'DEBUG_BUNDLE':
      return JSON.stringify({ bundle: { resource: payload.resource, fields: payload.fields, scrub: { token: payload.scrubToken, outcome: payload.outcome, redactionCount: payload.redactionCount } } }, null, 2);
  }
}

/**
 * Build the five sink adapters.
 *
 * THE CLOCK IS INJECTED so the exported bytes are reproducible: the redaction evidence records a digest per sink, and a
 * digest over a timestamp the test cannot control would change every run and prove nothing about the payload.
 */
export function createSinkAdapters(options?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
}): SinkAdapters {
  const env = options?.env ?? process.env;
  const now = options?.now ?? (() => new Date().toISOString());
  const captured: Record<string, string[]> = {};
  for (const sink of DLP_SINKS) captured[sink] = [];

  return {
    send: (payload) => {
      // THE RUNTIME HALF OF THE TOKEN RULE. The type system already refuses a hand-built payload; this check refuses a
      // payload whose token does not look like one this module minted, which is what a cast would produce.
      if (typeof payload.scrubToken !== 'string' || !payload.scrubToken.startsWith('scrub-')) {
        return { ok: false, reason: 'BLOCKED_ENVIRONMENT', detail: 'the payload carries no scrub token, so no sink may send it' };
      }
      const timestamp = now();
      const bytes = serialize(payload.sink, payload, timestamp);
      captured[payload.sink]?.push(bytes);
      return { ok: true, bytes, digest: sha256(bytes) };
    },
    exported: (sink) => Object.freeze([...(captured[sink] ?? [])]),
    rows: () =>
      DLP_SINKS.map((sink) => {
        const envVar = SINK_ENV_VARS[sink];
        if (envVar === null) {
          return {
            sink,
            status: 'BLOCKED_ENVIRONMENT' as const,
            envVar: null,
            detail: 'no specification declares an environment variable for this sink, so it has no configured endpoint; the bytes were captured locally through the same code path and no delivery is claimed',
          };
        }
        const configured = (env[envVar] ?? '').trim().length > 0;
        return {
          sink,
          status: configured ? ('CONFIGURED' as const) : ('BLOCKED_ENVIRONMENT' as const),
          envVar,
          detail: configured
            ? `${envVar} is set, so the endpoint is configured; this milestone implements the serialisation and the token requirement and not the transport client, so the bytes were captured locally and no delivery is claimed`
            : `${envVar} is unset, so this sink has no reachable endpoint; the bytes were captured locally through the same code path and no delivery is claimed`,
        };
      }),
  };
}
