# Runbook - Budget exhaustion; Budget exhausted

Alert ids: A-07, A-07b. Source: SPEC-007 §8 (EP-008 M6).

## What fires

* **A-07 - Budget exhaustion** (severity warning, routing ticket, for 15m)
  * expression: `max by (tenant_class, budget_key) (vanishgraph_action_budget_consumption_ratio) > 0.8`
  * threshold: 80 % of allowed effects
  * WHAT IT MEANS: an effect budget passed 80 per cent consumption for a tenant class and budget key.
  * WHAT IT DOES NOT MEAN: the budget is exhausted; the refusal alert is A-07b.
* **A-07b - Budget exhausted** (severity critical, routing page, for 0m)
  * expression: `sum by (budget_key) (increase(vanishgraph_action_budget_refusals_total{reason_code="BUDGET_EXHAUSTED"}[15m]))`
  * threshold: > 0
  * WHAT IT MEANS: a write was refused because a budget was exhausted, so the external effect did not happen.
  * WHAT IT DOES NOT MEAN: the product failed. Refusing to exceed the budget is the intended behaviour.

## First five minutes

1. Read the alert's LABELS before its value: they name the source class, channel, provider, sink, layer or objective the series is grouped by, and that is where the incident is.
2. Confirm the series is real and not an artefact: check the same series over a longer window, and check that the metric is registered in `config/metrics/catalogue.json` (an alert on an unregistered metric fails the catalogue guard).
3. Open the dashboard panel for the family (`config/dashboards/removal-effectiveness.json`) and read the DENOMINATOR of any ratio before the ratio itself: a ratio rendered without its denominator is a defect, not evidence.
4. Nothing here is a success notification. An alert about unverified claims means an unverified claim is in the data; it is never phrased, labelled or annotated as good news (SPEC-007 §8 coverage rule 2).

## Evidence to capture

* the alert's own payload (labels, value, timestamps);
* the metric series over the alert window and one window before it;
* the structured log records for the same window, filtered by the label the alert grouped on;
* for anything touching verification or removal: the `VerificationObservation` reference and the transition record, because a removal claim without one is the defect itself.

## Containment and resolution

* Containment never means suppressing the alert. Silencing a firing alert to clear an incident is a truthfulness defect (DOD-037).
* Resolve only when the underlying condition has changed and the series has returned to its steady state; an alert that stopped firing because its rule was disabled is NOT resolved, and the alert-catalogue guard requires each alert to be shown resolving after remediation.

**State of this runbook: the alert row is DATA in `config/alerts/catalogue.json` and the induced fire-and-resolve proof of EP-008 M6 has NOT yet been run for this alert. No firing, no resolution and no measurement is claimed by this document.**
