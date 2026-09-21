/**
 * The metrics registry (SPEC-007 §6.1, §6.2, §6.6; EP-008 M4(b); DOD-022, DOD-037).
 *
 * THE CATALOGUE IS THE ONLY WAY A METRIC EXISTS. §6.1: "Every metric must be registered with: type, unit, label set,
 * owner service, and a one-line meaning. Unregistered metric names are rejected by the metrics registration check and
 * fail lint." So this module reads `config/metrics/catalogue.json`, validates it, and refuses at REGISTRATION time — not
 * at query time — any of the shapes the specification forbids:
 *
 *   * a name that is not in the catalogue, or that carries a forbidden synonym (§13.3 item 3);
 *   * a label that is not a canonical label name (§6.1) and not declared by the metric's own §6.3-§6.5 row;
 *   * a PROHIBITED label name: `tenantId`, `tenant_id`, `tenant`, `caseId`, `case_id`, `exposureId`, `actionId`,
 *     `evidenceId`, `sourceId`, `recipeInstanceId`, `correlationId`, `trace_id`, `subjectId` (§6.2 — cardinality AND
 *     privacy: a per-tenant series discloses which organization is removing what, and when);
 *   * a label whose value set is not bounded, and a label VALUE outside the bounded set that is declared;
 *   * a float cost, and an implicit currency (§6.5's cost family is integer minor units with an explicit `currency`).
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: it does not aggregate, compute, or render anything. §6.6 makes telemetry
 * downstream of truth — "if the domain event did not occur, the counter does not increment" — so the only way to affect
 * a series here is to RECORD an event that a caller already decided happened. There is no `increment for optimism`.
 */

import { readFileSync } from 'node:fs';

import { DECLARED_SERVICES } from './telemetry-resource.ts';

export const METRIC_TYPES = ['counter', 'gauge', 'histogram'] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

/**
 * The synonyms SPEC-000 §4 forbids, as whole tokens (§13.3 item 3: none of them may appear in a metric name).
 *
 * `provider` IS NOT ON THIS LIST, and that is a deliberate reading rather than an omission: §13.3 item 3 keeps
 * `provider`/`Controller` where SPEC-000 itself uses them, and §6.5 declares `vanishgraph_provider_auth_failures_total`
 * with a `provider` label. Applying the synonym rule to `provider` would contradict the specification's own metric table.
 */
export const FORBIDDEN_NAME_TOKENS = ['site', 'vendor', 'hit', 'listing', 'ticket', 'job', 'task', 'submission', 'request', 'sanitizer', 'scraper', 'bot'] as const;

export interface MetricFamily {
  readonly name: string;
  readonly type: MetricType;
  readonly unit: string;
  readonly labels: readonly string[];
  readonly ownerService: string;
  readonly meaning: string;
}

export interface MetricCatalogue {
  readonly count: number;
  readonly families: readonly MetricFamily[];
  readonly canonicalLabelNames: readonly string[];
  readonly prohibitedLabels: readonly string[];
  readonly labelValueSets: Readonly<Record<string, readonly string[]>>;
  readonly labelValueSetSources: Readonly<Record<string, string>>;
  /**
   * Label bounds that apply to ONE metric family rather than to the label everywhere.
   *
   * SPEC-007 §6.3–§6.5 bound `reason_code` PER METRIC ROW, and the registry could not enforce a bound it could not see,
   * so an out-of-enum reason code was accepted at record time (EP-008 M5 finding). This is where those bounds live.
   */
  readonly perFamilyLabelValueSets: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  readonly prohibitedMetricNames: readonly string[];
  readonly forbiddenNameTokens: readonly string[];
  readonly byName: ReadonlyMap<string, MetricFamily>;
}

export type CatalogueLoadResult =
  | { readonly ok: true; readonly catalogue: MetricCatalogue }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) return null;
  return raw as string[];
}

const PROHIBITED_NAME_PATTERNS: readonly RegExp[] = [
  /(^|_)requests?_sent(_|$)/,
  /(^|_)requests?_submitted(_|$)/,
  /(^|_)submissions?(_|$)/,
  /(^|_)actions?_taken(_|$)/,
  /(^|_)permanent_?(deletion|removal|removed)(_|$)/,
  /(^|_)deletion_rate(_|$)/,
  /(^|_)success_rate(_|$)/,
  /(^|_)deleted(_|$)/,
];

/**
 * Validate a parsed catalogue.
 *
 * PURE, so the guard, the registry and the suite share ONE definition of a valid catalogue and the negative cases are
 * cheap: every rule below is asserted against a document that has the defect.
 */
export function parseMetricCatalogue(raw: unknown): CatalogueLoadResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['the metric catalogue must be a JSON object'] };

  const familiesRaw = raw['families'];
  if (!Array.isArray(familiesRaw)) return { ok: false, errors: ['the metric catalogue must carry a families array'] };

  const prohibitedLabels = stringArray(raw['prohibited_labels']) ?? [];
  const canonicalLabelNames = stringArray(raw['canonical_label_names']) ?? [];
  const prohibitedMetricNames = stringArray(raw['prohibited_metric_names']) ?? [];
  const valueSetsRaw = raw['label_value_sets'];
  const labelValueSets: Record<string, readonly string[]> = {};
  if (isRecord(valueSetsRaw)) {
    for (const [label, values] of Object.entries(valueSetsRaw)) {
      const parsed = stringArray(values);
      if (parsed === null) errors.push(`label_value_sets.${label} must be an array of strings`);
      else labelValueSets[label] = parsed;
    }
  } else {
    errors.push('label_value_sets must be an object of label to bounded values');
  }
  const sourcesRaw = raw['label_value_set_sources'];
  const labelValueSetSources: Record<string, string> = {};
  if (isRecord(sourcesRaw)) {
    for (const [label, source] of Object.entries(sourcesRaw)) {
      if (label.startsWith('$')) continue;
      if (typeof source !== 'string' || source.trim().length === 0) errors.push(`label_value_set_sources.${label} must name where the bound comes from`);
      else labelValueSetSources[label] = source;
    }
  }

  const families: MetricFamily[] = [];
  const byName = new Map<string, MetricFamily>();
  for (const [index, entry] of familiesRaw.entries()) {
    if (!isRecord(entry)) {
      errors.push(`families[${String(index)}] must be an object`);
      continue;
    }
    const name = entry['name'];
    const type = entry['type'];
    const unit = entry['unit'];
    const labels = stringArray(entry['labels']);
    const owner = entry['owner_service'];
    const meaning = entry['meaning'];
    if (typeof name !== 'string' || name.trim().length === 0) {
      errors.push(`families[${String(index)}]: name must be a non-empty string`);
      continue;
    }
    if (!name.startsWith('vanishgraph_') || !/^[a-z0-9_]+$/.test(name)) {
      errors.push(`${name}: a metric name is lower_snake_case and begins with vanishgraph_ (§6.1)`);
      continue;
    }
    if (typeof type !== 'string' || !(METRIC_TYPES as readonly string[]).includes(type)) {
      errors.push(`${name}: type must be one of ${METRIC_TYPES.join(', ')}`);
      continue;
    }
    if (typeof unit !== 'string' || unit.trim().length === 0) {
      errors.push(`${name}: unit must be declared (§6.1)`);
      continue;
    }
    if (labels === null) {
      errors.push(`${name}: labels must be an array of label names`);
      continue;
    }
    if (typeof owner !== 'string' || !(DECLARED_SERVICES as readonly string[]).includes(owner)) {
      // THE OWNER IS ONE OF THE SEVEN DECLARED SERVICES, NOT MERELY A NAME THAT LOOKS LIKE ONE. MEASURED: the first
      // version accepted any `vanishgraph-` prefix, so `vanishgraph-worker` — a service that does not exist — passed as
      // an owner. §6.1 requires an owner service, and §2.2 is the list of services there are.
      errors.push(`${name}: owner_service must be one of the seven declared services (§2.2); "${String(owner)}" is not`);
      continue;
    }
    if (typeof meaning !== 'string' || meaning.trim().length < 20) {
      errors.push(`${name}: meaning must be a real one-line meaning of at least 20 characters (§6.1)`);
      continue;
    }
    if (byName.has(name)) {
      errors.push(`${name}: appears twice; one family, one entry`);
      continue;
    }
    for (const token of FORBIDDEN_NAME_TOKENS) {
      if (name.split('_').includes(token)) errors.push(`${name}: "${token}" is a forbidden synonym for a canonical concept (§13.3 item 3)`);
    }
    for (const pattern of PROHIBITED_NAME_PATTERNS) {
      if (pattern.test(name)) errors.push(`${name}: a metric asserting this is prohibited (§6.3) and no such series may exist`);
    }
    for (const label of labels) {
      if (prohibitedLabels.includes(label)) {
        errors.push(`${name}: label "${label}" is prohibited (§6.2 — cardinality and privacy)`);
      } else if (!canonicalLabelNames.includes(label)) {
        errors.push(`${name}: label "${label}" is declared in neither §6.1 nor the metric's own §6.3-§6.5 row`);
      } else if (labelValueSets[label] === undefined && labelValueSetSources[label] === undefined) {
        errors.push(`${name}: label "${label}" has no bounded value set and no declared source for its bound (§6.2)`);
      }
    }
    if (unit === 'minor_units' && !labels.includes('currency')) {
      errors.push(`${name}: a cost in minor units must carry an explicit currency (§6.5, and §6.1 forbids an implicit unit)`);
    }
    const family: MetricFamily = { name, type: type as MetricType, unit, labels, ownerService: owner, meaning };
    families.push(family);
    byName.set(name, family);
  }

  const declaredCount = raw['count'];
  if (typeof declaredCount !== 'number' || declaredCount !== families.length) {
    errors.push(`count says ${String(declaredCount)} and the catalogue carries ${String(families.length)} families`);
  }
  if (families.length !== 42) {
    // THE NUMBER IS PART OF THE CONTRACT: §6.3-§6.5 name exactly 42 families, and the milestone's own check greps for 42.
    errors.push(`the catalogue must carry exactly 42 metric families (§6.3-§6.5) and carries ${String(families.length)}`);
  }

  // THE PER-FAMILY BOUNDS ARE READ BEFORE THE ERROR CHECK, AND THAT ORDER IS THE WHOLE POINT: the first version called
  // this inside the return object below, so its errors were pushed AFTER `if (errors.length > 0) return …` had already
  // run — a malformed bound would have been reported into an array nobody read and the document would have validated.
  // The suite's three negative cases caught it. A validation whose findings are collected after the verdict is not a
  // validation.
  const perFamilyLabelValueSets = readPerFamilyLabelValueSets(raw['per_family_label_value_sets'], families, errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    catalogue: Object.freeze({
      count: families.length,
      families: Object.freeze(families),
      canonicalLabelNames,
      prohibitedLabels,
      labelValueSets,
      labelValueSetSources,
      perFamilyLabelValueSets,
      prohibitedMetricNames,
      forbiddenNameTokens: [...FORBIDDEN_NAME_TOKENS],
      byName,
    }),
  };
}

/**
 * Read the per-family label bounds, and REFUSE a document that bounds a label the family does not declare.
 *
 * THE CROSS-CHECK MATTERS AS MUCH AS THE BOUND: a bound attached to a family that does not carry the label would be dead
 * configuration, which is a rule that looks enforced and is not — the same defect the rule-class validation refuses.
 */
function readPerFamilyLabelValueSets(
  raw: unknown,
  families: readonly MetricFamily[],
  errors: string[],
): Record<string, Record<string, readonly string[]>> {
  const out: Record<string, Record<string, readonly string[]>> = {};
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    errors.push('per_family_label_value_sets must be an object of metric name to label to values');
    return out;
  }
  for (const [metric, labels] of Object.entries(raw)) {
    // `$comment` IS DATA ABOUT THE FILE, NOT A FAMILY. A `$`-prefixed key is skipped for the same reason
    // `label_value_set_sources` skips it: prose must not have to masquerade as a metric.
    if (metric.startsWith('$')) continue;
    const family = families.find((candidate) => candidate.name === metric);
    if (family === undefined) {
      errors.push(`per_family_label_value_sets.${metric}: no such metric family, so the bound would be dead configuration`);
      continue;
    }
    if (!isRecord(labels)) {
      errors.push(`per_family_label_value_sets.${metric} must be an object of label to values`);
      continue;
    }
    const parsedLabels: Record<string, readonly string[]> = {};
    for (const [label, values] of Object.entries(labels)) {
      const parsed = stringArray(values);
      if (parsed === null) {
        errors.push(`per_family_label_value_sets.${metric}.${label} must be an array of strings`);
        continue;
      }
      if (parsed.length === 0) {
        // AN EMPTY BOUND WOULD FORBID EVERY VALUE, which is never what a bound is for; it is a defect in the document.
        errors.push(`per_family_label_value_sets.${metric}.${label} is empty, so no value could ever be recorded`);
        continue;
      }
      if (!family.labels.includes(label)) {
        errors.push(`per_family_label_value_sets.${metric}.${label}: ${metric} does not declare that label, so the bound could never apply`);
        continue;
      }
      parsedLabels[label] = parsed;
    }
    out[metric] = parsedLabels;
  }
  return out;
}

export function loadMetricCatalogue(path: string): CatalogueLoadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, errors: [`the metric catalogue at ${path} could not be read`] };
  }
  try {
    return parseMetricCatalogue(JSON.parse(text));
  } catch (error) {
    return { ok: false, errors: [`the metric catalogue at ${path} is not valid JSON: ${(error as Error).message}`] };
  }
}

export class MetricRegistrationError extends Error {
  readonly code: string;
  readonly metric: string;
  constructor(code: string, metric: string, detail: string) {
    super(`metric registration refused (${code}): ${metric}: ${detail}`);
    this.name = 'MetricRegistrationError';
    this.code = code;
    this.metric = metric;
  }
}

export interface MetricSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface MetricsRegistry {
  /** Register a family. The catalogue is the authority; this refuses anything it does not declare. */
  register(name: string): MetricFamily;
  /** Record an observation of an already-registered family, validating its label set and values. */
  record(name: string, labels: Readonly<Record<string, string>>, value: number): MetricSample;
  value(name: string, labels?: Readonly<Record<string, string>>): number | undefined;
  families(): readonly MetricFamily[];
  samples(): readonly MetricSample[];
}

/** The label key used inside this registry's own maps: a deterministic serialisation of a label set. */
function labelKey(labels: Readonly<Record<string, string>>): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key] ?? ''}`)
    .join(',');
}

export function createMetricsRegistry(catalogue: MetricCatalogue): MetricsRegistry {
  const registered = new Set<string>();
  const values = new Map<string, number>();
  const samples: MetricSample[] = [];

  return {
    register: (name) => {
      const family = catalogue.byName.get(name);
      if (family === undefined) {
        throw new MetricRegistrationError('NOT_CATALOGUED', name, 'no catalogue entry declares this metric, and an unregistered metric name fails lint (§6.1)');
      }
      registered.add(name);
      return family;
    },
    record: (name, labels, value) => {
      const family = catalogue.byName.get(name);
      if (family === undefined) {
        throw new MetricRegistrationError('NOT_CATALOGUED', name, 'no catalogue entry declares this metric (§6.1)');
      }
      if (!registered.has(name)) {
        throw new MetricRegistrationError('NOT_REGISTERED', name, 'the family was never registered, and recording into an unregistered family is how a series appears with no owner');
      }
      for (const label of Object.keys(labels)) {
        if (catalogue.prohibitedLabels.includes(label)) {
          throw new MetricRegistrationError('PROHIBITED_LABEL', name, `label "${label}" is prohibited by §6.2`);
        }
        if (!family.labels.includes(label)) {
          throw new MetricRegistrationError('UNDECLARED_LABEL', name, `label "${label}" is not declared for this family`);
        }
        // THE PER-FAMILY BOUND WINS WHERE ONE IS DECLARED, because SPEC-007 §6.3-§6.5 bound `reason_code` per metric row
        // rather than globally. MEASURED: before this, an out-of-enum reason code was ACCEPTED here, because the label's
        // only declared bound was a prose source the registry could not read — a rule that looked enforced and was not.
        const allowed = catalogue.perFamilyLabelValueSets[name]?.[label] ?? catalogue.labelValueSets[label];
        const emitted = labels[label] ?? '';
        if (allowed !== undefined && !allowed.includes(emitted)) {
          throw new MetricRegistrationError('UNBOUNDED_LABEL_VALUE', name, `label "${label}" value "${emitted}" is outside the bounded set declared for it (§6.2)`);
        }
      }
      if (!Number.isFinite(value)) {
        throw new MetricRegistrationError('NON_FINITE_VALUE', name, `value ${String(value)} is not a finite number`);
      }
      if (family.unit === 'minor_units' && !Number.isInteger(value)) {
        throw new MetricRegistrationError('FLOAT_COST', name, `a cost in minor units must be an integer and received ${String(value)} (§6.5, SPEC-001 §2 Money)`);
      }
      if (family.unit === 'minor_units' && (labels['currency'] ?? '').trim().length === 0) {
        throw new MetricRegistrationError('IMPLICIT_CURRENCY', name, 'a cost must carry an explicit currency (§6.5)');
      }
      const sample: MetricSample = Object.freeze({ name, labels: Object.freeze({ ...labels }), value });
      samples.push(sample);
      values.set(`${name}{${labelKey(labels)}}`, value);
      return sample;
    },
    value: (name, labels) => (labels === undefined ? values.get(`${name}{}`) : values.get(`${name}{${labelKey(labels)}}`)),
    families: () => catalogue.families,
    samples: () => samples,
  };
}

/** Build the registry from the versioned catalogue; a catalogue that cannot be validated is a startup failure. */
export function createMetricsRegistryFromFile(path: string): MetricsRegistry {
  const loaded = loadMetricCatalogue(path);
  if (!loaded.ok) {
    throw new MetricRegistrationError('CATALOGUE_INVALID', path, loaded.errors.join('; '));
  }
  return createMetricsRegistry(loaded.catalogue);
}

/* ----------------------------------------------------------------------------------------------------------------
 * The dashboard schema
 *
 * WHY THIS IS HERE RATHER THAN IN A DASHBOARD TOOL: §6.3's rule — "Emitted together, always: numerator, denominator,
 * and interval. A ratio without its denominator is a defect (SPEC-000 §7.4)" — is a rule about DATA, and a dashboard
 * panel that renders a ratio series without naming the denominator series it is a ratio OF is the defect the rule
 * describes. The validator is small, pure, and lives beside the catalogue so a panel can only reference declared
 * metrics.
 * ---------------------------------------------------------------------------------------------------------------- */

export interface DashboardPanel {
  readonly id: string;
  readonly title: string;
  readonly metric: string;
  readonly denominatorMetric?: string;
  readonly components?: readonly string[];
  readonly ci?: readonly string[];
}

export interface DashboardDocument {
  readonly title: string;
  readonly panels: readonly DashboardPanel[];
}

export interface DashboardValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * Validate a dashboard against the catalogue.
 *
 * A RATIO PANEL MUST NAME ITS DENOMINATOR. It must also render the interval, because §6.3 requires the point estimate and
 * both ends together, and an effectiveness panel must render all four `component` values, because the exclusion
 * components are what stop an exclusion from becoming a silently smaller cohort.
 */
export function validateDashboard(document: unknown, catalogue: MetricCatalogue): DashboardValidation {
  const errors: string[] = [];
  if (!isRecord(document)) return { ok: false, errors: ['a dashboard must be a JSON object'] };
  const panels = document['panels'];
  if (!Array.isArray(panels)) return { ok: false, errors: ['a dashboard must carry a panels array'] };
  const ids = new Set<string>();
  for (const [index, panelRaw] of panels.entries()) {
    if (!isRecord(panelRaw)) {
      errors.push(`panels[${String(index)}] must be an object`);
      continue;
    }
    const id = panelRaw['id'];
    const metric = panelRaw['metric'];
    if (typeof id !== 'string' || id.trim().length === 0) {
      errors.push(`panels[${String(index)}]: id must be a non-empty string`);
      continue;
    }
    if (ids.has(id)) errors.push(`panels[${id}]: appears twice`);
    ids.add(id);
    if (typeof metric !== 'string') {
      errors.push(`panels[${id}]: metric must name a metric family`);
      continue;
    }
    const family = catalogue.byName.get(metric);
    if (family === undefined) {
      errors.push(`panels[${id}]: "${metric}" is not a registered metric family, and an unregistered metric fails lint (§6.1)`);
      continue;
    }
    const denominator = panelRaw['denominatorMetric'];
    if (family.unit === 'ratio') {
      if (typeof denominator !== 'string' || denominator.trim().length === 0) {
        errors.push(`panels[${id}]: a ratio panel must name the denominator series it is a ratio of (SPEC-000 §7.4, SPEC-007 §6.3)`);
      } else if (!catalogue.byName.has(denominator)) {
        errors.push(`panels[${id}]: denominatorMetric "${denominator}" is not a registered metric family`);
      }
    }
    if (metric === 'vanishgraph_removal_effectiveness_ratio') {
      const ci = panelRaw['ci'];
      if (!Array.isArray(ci) || [...CONFIDENCE_LABELS].some((label) => !(ci as unknown[]).includes(label))) {
        errors.push(`panels[${id}]: an effectiveness ratio panel must render ci for ${CONFIDENCE_LABELS.join(', ')}, because a point estimate alone is not the interval §6.3 requires`);
      }
    }
    if (metric === 'vanishgraph_removal_effectiveness_events_total') {
      const components = panelRaw['components'];
      if (!Array.isArray(components) || !(components as unknown[]).includes('denominator')) {
        errors.push(`panels[${id}]: an effectiveness events panel must render the denominator component; exclusions without it read as a smaller cohort`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The three interval labels §6.3 requires together. Declared here so the dashboard validator and the metric agree. */
export const CONFIDENCE_LABELS = ['point', 'lower', 'upper'] as const;

/* ----------------------------------------------------------------------------------------------------------------
 * The exposition writer (SPEC-007 §2.3 rule 2; EP-008 M4 FALLBACK, used by M5(b))
 *
 * WHY A HAND-WRITTEN WRITER: the plan's FALLBACK for "if a Prometheus client library cannot be added" is to expose the
 * same registered catalogue through a hand-written exposition writer driven by the registry, with the registration,
 * naming, label and prohibition checks unchanged and NO metric dropped to make the writer simpler. That is what this is:
 * it renders what the registry already accepted, and it can render nothing else.
 *
 * HISTOGRAMS ARE RENDERED AS `_count` AND `_sum`, NEVER AS `_bucket`, AND THAT IS STATED IN THE OUTPUT. A Prometheus
 * histogram needs declared bucket boundaries; the catalogue declares none for the histogram families, so emitting
 * `_bucket` series would mean inventing them. The two series that are emitted are exactly what the registry observed.
 * ---------------------------------------------------------------------------------------------------------------- */

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatLabels(labels: Readonly<Record<string, string>>): string {
  const names = Object.keys(labels).sort();
  if (names.length === 0) return '';
  return `{${names.map((name) => `${name}="${escapeLabelValue(labels[name] ?? '')}"`).join(',')}}`;
}

/**
 * Render the registry in the Prometheus text exposition format.
 *
 * ONLY WHAT WAS RECORDED APPEARS: there is no path here that invents a zero for a family nobody observed, because a
 * fabricated zero is indistinguishable from a measured zero once it is in the TSDB (§6.6: telemetry is downstream of
 * truth).
 */
export function renderExposition(registry: MetricsRegistry, options?: { readonly environment?: string }): string {
  const lines: string[] = [];
  if (options?.environment !== undefined) {
    lines.push(`# environment: ${options.environment}`);
  }
  const byFamily = new Map<string, MetricSample[]>();
  for (const sample of registry.samples()) {
    const list = byFamily.get(sample.name) ?? [];
    list.push(sample);
    byFamily.set(sample.name, list);
  }
  for (const family of registry.families()) {
    const samples = byFamily.get(family.name);
    if (samples === undefined || samples.length === 0) continue;
    lines.push(`# HELP ${family.name} ${family.meaning.replace(/\n/g, ' ')}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    if (family.type === 'histogram') {
      // THE LIMIT IS IN THE OUTPUT, not only in this comment: a reader of the scrape must be able to see that the
      // bucket series are absent because no boundaries are declared.
      lines.push(`# NOTE ${family.name} bucket boundaries are not declared in the metric catalogue, so only _count and _sum are exposed`);
      for (const sample of samples) {
        lines.push(`${family.name}_count${formatLabels(sample.labels)} 1`);
        lines.push(`${family.name}_sum${formatLabels(sample.labels)} ${String(sample.value)}`);
      }
      continue;
    }
    for (const sample of samples) {
      lines.push(`${family.name}${formatLabels(sample.labels)} ${String(sample.value)}`);
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
