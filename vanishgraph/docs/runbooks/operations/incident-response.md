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

## Retention, deletion and access incidents

**A data class with no window, or a window that looks unbounded.** `sh scripts/retention-config-guard.sh` refuses both, and the refusal names the class. Do not "fix" it by adding a large number: an unbounded window is what turns a retention policy into a permanent record, and a very large window is the same defect with a slower clock.

**A deletion that did not happen.** Deletion is never silent: every deletion writes one **INFO** record naming the class, the window and the outcome, and increments `vanishgraph_telemetry_deletions_total{data_class,outcome}`. So an absent record is itself the signal — start from the counter (`outcome="FAILED"`), then the log record, then the partition. `REFUSED_SEALED_REWRITE` is NOT a failure to investigate as a bug: it is the store refusing to rewrite a **sealed** partition, which is the property that makes the artifact evidence.

**A privileged raw-telemetry read.** It requires an authenticated caller, an observability role and an MFA-backed assurance level, and it writes an `AuditEvent` with the actor, purpose code, query scope and result count — but **no result contents**. A read that produced no audit row is treated as a **failure**, not a warning: an unaudited read of raw telemetry is indistinguishable from exfiltration. Start from the audit row, not from the query.

**A cross-tenant telemetry read returned nothing.** That is the designed answer, not an error: absence rather than a distinguishable refusal, which would tell the caller that the other tenant's data exists. Check `vanishgraph_tenant_scope_refusals_total{layer="EVIDENCE_READBACK"}` — a non-zero rate is a security signal with its own alert.

**Measured state: no expiry job and no partitioned telemetry store exist in this environment.** The propagation rows are `BLOCKED_ENVIRONMENT` with their attempt log at `.agent/evidence/EP-008/retention/provisioning-attempts.txt`, and **no deletion has been observed executing**. Do not treat the configuration validation as evidence that deletion works.
