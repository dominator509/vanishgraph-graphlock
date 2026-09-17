# Runbook - incident response

The entry point for any page. Source: SPEC-007 §8, `.agent/checklists/incident-response.md` (EP-008 M6).

## Lanes and their objectives

| Lane | Meaning | Objective |
|---|---|---|
| `page` | on-call paging | acknowledge within 5 minutes |
| `page-security` | security on-call | acknowledge within 5 minutes |
| `ticket` | operations queue | review within 1 business day |
| `advisory` | business-hours channel | working response within 4 hours |

## Order of operations

1. **Identify the lane from the alert's routing field** in `config/alerts/catalogue.json`. The lane sets the clock, not the severity word.
2. **Open the alert's own runbook** (the `runbook` path on the row) and follow it. Every alert row points at a document, and the alert-catalogue guard refuses a row whose document is missing or empty.
3. **Read labels, then values.** For an observability alert the labels name the sink, layer, provider, channel or objective where the incident is.
4. **Distinguish a refusal from a failure.** Several of these alerts fire on a control WORKING: a DLP denial, a stale-recipe refusal, a budget refusal and a cross-tenant refusal are the system declining to do something, and the runbook for each says so explicitly.
5. **Never silence to clear.** Suppressing an alert, lowering a threshold or disabling a rule to end an incident is a truthfulness defect (DOD-037) and, for the SLO and alert catalogues, a gate failure.

## What is NOT built, stated so nobody assumes it

No alert has been demonstrated firing, and none has been demonstrated resolving after remediation: the induced fire-and-resolve proof belongs to EP-008 M6 and has not been run. The catalogue is data with expressions, thresholds, `for` durations, severities, lanes and runbook paths; the evaluation engine and the notification transport are not part of this repository's current state. `OPERATIONS.md` names the same limits.
