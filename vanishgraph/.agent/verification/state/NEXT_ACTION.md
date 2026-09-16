# Next action

**EP-005 (UI/client node) is closed.** `graph-next.sh` names **EP-006**.

## What EP-005 verified, exactly — and what it does not claim

The four surfaces SPEC-004 §1 declares are built against the specification's contract: the subject portal, the
operations console, the tenant admin console, and the read-only auditor view. `sh scripts/gate-ui.sh` → `gate-ui: ok`,
the credential-free contract suites pass, the browser suite passes against the built artefact, and the copy,
route-manifest, coverage, ownership, auditor-readonly and PII-pattern contract suites all pass with recorded tool
versions.

**THE HONEST STATEMENT, IN THE PLAN'S OWN WORDS: this does NOT mean the UI is complete, accessible, WCAG compliant, or
production ready.** It means:

* the copy, route, coverage, ownership, auditor-readonly and PII-pattern contract suites pass;
* automated accessibility checks ran with recorded tool versions (axe-core over all 25 declared routes, focus
  management, reduced motion, 320-pixel reflow);
* **lived-use accessibility validation is `EXTERNAL_REQUIRED`** (VG-UI-064): NVDA with Firefox and Chrome, VoiceOver
  with Safari, keyboard-only operation, 200% zoom, 400% reflow and a documented colour-vision-deficiency review, signed
  by named authorized human participants. The request is
  `.agent/evidence/EP-005/accessibility/human-gate-request.json`; the per-criterion report beside it records 21 `PASS`,
  1 `FAIL`, 19 `PARTIAL`, 2 `EXTERNAL_REQUIRED` and 11 `N/A`, and **no criterion depending on lived use is `PASS`**;
* `RELEASE_GATE.json` remains `INCONCLUSIVE`. Do not change it.

The one `FAIL` is **2.4.5 Multiple Ways**: this artefact renders no in-product navigation, so its routes are reachable
only by URL. Owner: the surface chrome that M5/M6 would have built had the chrome been in scope.

## The provisioning actions that unblock the credential-dependent rows

Unchanged in substance from EP-004, and each is an environment action rather than code. None is simulated anywhere.

1. **`DATABASE_URL`** — export the PostgreSQL DSN. Unblocks the `BLOCKED_CREDENTIALS` rows whose probe is
   `sh scripts/probes/database_url.sh`.
2. **`VALKEY_URL`** — provision the coordination store. The durable FILE replay store is proven; the Valkey binding has
   never been exercised against a real store.
3. **`KEYCLOAK_ISSUER`** — point the service at a real identity provider. This is the one that matters most for the UI
   node: **every subject-scoped and principal-scoped route renders a system error naming this gap**, because the portal
   cannot tell which subject or tenant is asking without a session. It also blocks the five keyboard flows
   (`BLOCKED_CREDENTIALS`) and the post-sign-out back-navigation assertion (VG-UI-077).

## The human action

**VG-UI-064 (DOD-039)** is the node's open external gate. An automated tool, an agent or the implementer cannot satisfy,
impersonate or substitute for it, and the sign-off block in the request file is deliberately `false` with `signedBy:
null`. Any generated accessibility sign-off would be a fabrication defect.

## What EP-006 inherits from this node

* The UI's data boundary is real but has never rendered a real response: every surface is asserted against fixtures and
  against the contract. When the three variables above are exported, the first honest test of these surfaces is a real
  response — and the fixtures must not be mistaken for that test.
* Two contract gaps found while naming fields, recorded rather than papered over: SPEC-003 §5.4.3 declares no catalogue
  version for a discovery run (SPEC-004 §3 requires one beside every coverage figure), and SPEC-003 declares no endpoint
  at all for SPEC-004 §1's `/auditor/exports`.
* The alerts surface (`ReappearanceAlerts`) is built and asserted but mounted nowhere, because SPEC-003 §5.11.3 names no
  row fields for its list.
