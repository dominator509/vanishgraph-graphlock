# REMOVAL_EFFECTIVENESS_METRICS.md

The primary effectiveness metric of VanishGraph, as specified in SPEC-007 §6.3 and published by SPEC-003 §5.16.3.
**This document describes the defined metric and states plainly what is built and what is not.** No number here is a
measurement: the figures in this repository are computed from domain events and from provisioned data, and no run has
produced a published ratio yet.

## The definition

```
independently verified removals ÷ eligible confirmed matches
```

- **Denominator — eligible confirmed match.** An exposure that reached `MATCH_CONFIRMED` or a later state within the
  measurement interval and for which a complete `PolicyDecision` in force exists (jurisdiction, legal basis, channel,
  policy version — VG-POLICY-002) and an enabled fresh signed `RemovalRecipe` exists. Counted **once per exposure per
  measurement interval**. This is the SPEC-003 §5.16.3 definition verbatim. **The metric plane and the API use ONE
  computation**: `src/adapters/observability/effectiveness-metric.ts` calls the same `figure()` and the same
  `DENOMINATOR_DEFINED_AS` constant that the `GET /v1/metrics/removal-effectiveness` route uses, and a parity test
  asserts they agree at every boundary. A second, divergent denominator definition anywhere is a defect — §13.3 item 9
  records that exactly that divergence once produced two different published numbers from one dataset.
- **Numerator — independently verified removal.** A denominator member that reached `VERIFIED_REMOVED` with a linked
  `VerificationObservation` produced by a path distinct from the acting path (VG-VERIFY-001), with the required
  observation window elapsed (VG-VERIFY-002) and the recipe's declared verification method satisfied (VG-VERIFY-003).
  Each exposure contributes **at most once per observation window**; a removal after `REAPPEARED` is a new event in a new
  window.
- **Emitted together, always: numerator, denominator and interval.** A ratio without its denominator is a defect
  (SPEC-000 §7.4). **When the denominator is zero the interval is not computed and the series is reported as `no_data`
  with the denominator present** — the ratio is `null`, never `0`, because a bare `0%` would read as "nothing was
  removed" in an interval where nothing was eligible, and a bare `100%` is the same defect in the other direction. The
  implementation refuses both rather than rounding them into a number.

## The series

| Metric | Type | Unit | Labels |
|---|---|---|---|
| `vanishgraph_removal_effectiveness_events_total` | counter | count | `environment`, `tenant_class`, `source_class`, `window`, `component` ∈ {`numerator`, `denominator`, `excluded_not_removable`, `excluded_human_required`} |
| `vanishgraph_removal_effectiveness_ratio` | gauge | ratio | the same labels minus `component`, plus `ci` ∈ {`point`, `lower`, `upper`} |

Both families are registered in `config/metrics/catalogue.json` with their type, unit, labels, owner service and meaning.
The interval is the **Wilson score interval at 95 % confidence**, chosen because it stays inside [0, 1] at the extremes,
which is where this metric lives: a window with no verified removals has a numerator of 0, and a normal approximation
would report a negative lower bound — a confidence interval that cannot be true.

## Exclusions are first-class, never silent

`HUMAN_REQUIRED` and `NOT_REMOVABLE` outcomes are counted in the `excluded_*` **components** and are never subtracted
into an unlabelled residual (SPEC-001 SM-5, SPEC-000 §7.6). A denominator that quietly dropped them would read as a
smaller cohort and a **higher** ratio for the same outcomes. The API response additionally discloses `acknowledged`,
`requestSubmitted`, `searchDelisted` and `ambiguous` in `excludedFromNumerator`; those four are **API response fields,
not metric label values**, and adding them as metric components would require a specification change and a cardinality
review.

## Prohibited

The following are forbidden in the registry, in dashboards, in reports, and in API responses: any metric named or
aliased as "requests sent", "requests submitted", "submissions", "actions taken", "permanent deletion", "permanently
removed", "deleted", "deletion rate", or "success rate"; and any removal-named series that lacks a
verification-observation linkage in its definition. `REQUEST_SUBMITTED` volume may exist **only** as
`vanishgraph_truth_state_transitions_total{truth_state="REQUEST_SUBMITTED"}`, which is an activity metric and must never
be presented as a removal count (SPEC-000 §5.1, §7.3). **A metric that would assert permanent deletion does not exist**,
because the strongest available state is `VERIFIED_REMOVED`, scoped to one `Source` and one observation window.
`SEARCH_DELISTED` never adds to any source-removal numerator.

`sh scripts/metrics-catalogue-guard.sh` enforces all of this: the catalogue's 42 families, every label's bound, every
dashboard panel's denominator, every alert and SLO reference (VG-OBS-016), and a repository-wide scan for a prohibited
metric identifier — and that scan is shown to fire by planting one and requiring the refusal. The guard also reports, in
its own output, which checks did not run because the file they need does not exist yet.

## What is built, and what is not

**Built:** the catalogue (`config/metrics/catalogue.json`, 42 families), the registry with its refusals
(`src/adapters/observability/metrics-registry.ts`), the effectiveness figure with the four components and the three
interval series (`src/adapters/observability/effectiveness-metric.ts`), the dashboard schema and the shipped dashboard
(`config/dashboards/removal-effectiveness.json`), and the guard above.

**Not built:** no Prometheus client and no `GET /metrics` endpoint, so none of these series is scraped yet; no recording
rule evaluates the ratio outside this process; the alert and SLO catalogues that must reference these metrics arrive in
EP-008 M7 and M8, and until they exist the guard reports those two checks as `PENDING` rather than as passes. The API
route that publishes the same figure exists and is served from the database; the metric-plane computation is asserted to
agree with it, and no live end-to-end comparison of the two has been run in this environment.
