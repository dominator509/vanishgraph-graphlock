{
  "environment": "local",
  "sample_window": {
    "from": "1970-01-01T00:00:00.000Z",
    "to": "2026-09-17T16:52:55.639Z",
    "complete": false
  },
  "revoked": false,
  "verdicts": [
    {
      "id": "VG-SLO-001",
      "objective": "availability",
      "verdict": "DEFERRED_LONG_RUNNING",
      "reason": "the sample window 1970-01-01T00:00:00.000Z … 2026-09-17T16:52:55.639Z is not complete, and a shortened trial is never reported as PASS (DOD-038)",
      "badEvents": null,
      "allowedBadEvents": null,
      "burnRatio": null,
      "window": "rolling 30d",
      "sampleWindow": "1970-01-01T00:00:00.000Z … 2026-09-17T16:52:55.639Z",
      "workload": "WL-1"
    },
    {
      "id": "VG-SLO-002",
      "objective": "verification_latency",
      "verdict": "DEFERRED_LONG_RUNNING",
      "reason": "the sample window 1970-01-01T00:00:00.000Z … 2026-09-17T16:52:55.639Z is not complete, and a shortened trial is never reported as PASS (DOD-038)",
      "badEvents": null,
      "allowedBadEvents": null,
      "burnRatio": null,
      "window": "rolling 30d",
      "sampleWindow": "1970-01-01T00:00:00.000Z … 2026-09-17T16:52:55.639Z",
      "workload": "WL-1"
    },
    {
      "id": "VG-SLO-003",
      "objective": "workflow_completion",
      "verdict": "DEFERRED_LONG_RUNNING",
      "reason": "the sample window 1970-01-01T00:00:00.000Z … 2026-09-17T16:52:55.639Z is not complete, and a shortened trial is never reported as PASS (DOD-038)",
      "badEvents": null,
      "allowedBadEvents": null,
      "burnRatio": null,
      "window": "rolling 30d",
      "sampleWindow": "1970-01-01T00:00:00.000Z … 2026-09-17T16:52:55.639Z",
      "workload": "WL-1"
    },
    {
      "id": "VG-SLO-004",
      "objective": "reconciliation_latency",
      "verdict": "DEFERRED_LONG_RUNNING",
      "reason": "the sample window 1970-01-01T00:00:00.000Z … 2026-09-17T16:52:55.639Z is not complete, and a shortened trial is never reported as PASS (DOD-038)",
      "badEvents": null,
      "allowedBadEvents": null,
      "burnRatio": null,
      "window": "rolling 30d",
      "sampleWindow": "1970-01-01T00:00:00.000Z … 2026-09-17T16:52:55.639Z",
      "workload": "WL-1"
    },
    {
      "id": "VG-SLO-005",
      "objective": "evaluation_integrity",
      "verdict": "INCONCLUSIVE",
      "reason": "the integrity matrix needs at least one induced run and one undisturbed run and carries 0 and 0",
      "badEvents": null,
      "allowedBadEvents": null,
      "burnRatio": null,
      "window": "per evaluation campaign",
      "sampleWindow": "1970-01-01T00:00:00.000Z … 2026-09-17T16:52:55.639Z",
      "workload": "WL-1"
    }
  ]
}
