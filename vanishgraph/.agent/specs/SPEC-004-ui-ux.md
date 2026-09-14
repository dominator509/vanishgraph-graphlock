# SPEC-004 — UI/UX, Truth-State Presentation, Accessibility, and Browser Privacy

Status: SPECIFICATION (normative). Supersedes the 155-byte stub of the same path.
Depends on: SPEC-000 (oracle: vocabulary lock §4, truth model §5, non-collapse §5.1,
coverage honesty §7, channel priority §8), SPEC-001 (entities, state machine T1–T21,
invariants SM-1…SM-6). **SPEC-000 wins on conflict.** Contradiction is a defect
(DOD-027).

Scope of this document: the presentation layer only — `ui` surfaces described in
`ARCHITECTURE.md`. It defines what an implementer must build, what every screen must
say, and how each requirement is judged. It contains no implementation claims.

Requirement-ID scheme: `VG-UI-<NNN>`. IDs are permanent, never renumbered, never
reused. A withdrawn requirement keeps its row and moves to `WITHDRAWN`.

---

## 0. Reading rules, current reality, and non-claims

### 0.1 Current reality (honest state, DOD-026)

| Item | Status |
|---|---|
| This document | `BLUEPRINT_ONLY` — a specification contract. |
| Subject/consumer portal | `NOT_IMPLEMENTED` |
| Operations console | `NOT_IMPLEMENTED` |
| Tenant admin console | `NOT_IMPLEMENTED` |
| Auditor / evidence read-only view | `NOT_IMPLEMENTED` |
| Automated accessibility checks (axe-core / Playwright) | `NOT_RUN` |
| Manual assistive-technology validation | `EXTERNAL_REQUIRED` (DOD-039, VG-UI-064) |
| Screenshots, visual baselines, colour-contrast measurements | `NOT_PRODUCED` |

No screen is asserted to exist. No test result, screenshot, or measurement is
asserted anywhere in this file. Any future claim that a VG-UI requirement passes
must resolve to executed evidence in the current candidate epoch per SPEC-000 §9.

### 0.2 How IDs are judged

Every requirement row in §1–§12 and §14 carries an **acceptance oracle** (how a pass is
judged) and a **required negative case** (DOD-014). An oracle that only reads a source
file is not an oracle. Oracles here are expressed as: rendered-DOM assertions against a
production build, route-level HTTP assertions, persisted-record readback, or
gate-script exit codes that fail closed (non-zero) on violation.

### 0.3 Terminology and layering

- Canonical vocabulary from SPEC-000 §4 is mandatory in all UI copy, component
  names, props, test ids, `data-*` hooks, and route segments. Forbidden synonyms
  (§4) must not appear in production identifiers or in user-visible strings.
- Two narrowly-scoped exceptions are recorded explicitly so the vocabulary gate can
  allowlist them (VG-UI-008):
  1. `PermissionClass` is a value object in SPEC-001 §2 and is referenced by its
     exact name. The bare noun *permission* is never used as a synonym for
     `AuthorityGrant`.
  2. `provider-permitted` (SPEC-000 §1) and `ProviderTransportRun` (SPEC-001 §3.5)
     are exact defined terms. The bare noun *provider* is never used to mean a
     `Source`; when a `Source`'s own text is what was received, copy says
     "the Source's own text".
- The UI layer imports **application contracts only** (SPEC-001 §1). It must not
  import `domain` internals or `adapters`.
- There is no browser-side status vocabulary. The eleven truth-state tokens are the
  only status vocabulary in the build (SPEC-000 §4).

---

## 1. Surfaces

Four surfaces, four audiences. A surface may not borrow another surface's jobs.

| Surface | Audience | Primary jobs | Explicit non-goals |
|---|---|---|---|
| **Subject portal** (`/portal`) | The verified `ProtectedSubject`; a guardian for a minor subject under the strict lane (VG-POLICY-004); a holder of an `AuthorityGrant` of kind `AGENT` acting within its recorded `scope[]` | Verify identity and authority; review discovered `Exposure` records and confirm or reject matches; see case history and truth state; open and read `EvidenceArtifact` entries; receive and act on `Reappearance`; request human review or escalation; read the coverage and limitations statements | No bulk campaign tooling; no queue operations; no tenant configuration; no audit export; no metric administration; no ability to advance a truth state by any control (VG-UI-024) |
| **Operations console** (`/console`) | Tenant `OPERATOR` and `REVIEWER` roles | Work the `RequestCase` queue; review and disposition match candidates inside the `HumanGate` (VG-UI-030); triage `HUMAN_REQUIRED` gates; monitor `RemovalRecipe` freshness and `Source` `PermissionClass`; read coverage reports per run; reconcile ambiguous `ExternalAction` results | No tenant-wide policy authoring; no authority issuance; no truth-state editing; no deletion of cases; no "mark as removed" control |
| **Tenant admin console** (`/admin`) | Tenant `ADMIN` | Manage tenant settings and jurisdiction policy assignments; issue and revoke `AuthorityGrant` records; manage `SourceCatalogEntry` enablement and `RemovalRecipe` enable/disable; manage users and roles; read tenant-scoped coverage and metric configuration | No case work; no subject-level PII browsing beyond administration needs; no ability to alter recorded evidence; no ability to change a truth state |
| **Auditor / evidence view** (`/auditor`) | Named external or internal auditor holding a read-only `AUDITOR` role | Resolve a claim to requirement → case → artifact → digest (VG-EVIDENCE-002); read the append-only `AuditEvent` history for a case; verify `EvidenceArtifact` digests and `redactionState`; export a read-only evidence bundle on request | Strictly read-only: no control on any `/auditor` route mutates state; no PII reveal control; no download of unredacted `IDENTITY_DOCUMENT`; no metric authoring |

**VG-UI-001 — Surface jobs are implemented only by their owning surface**
Requirement: The jobs in §1 are reachable only from the owning surface; a job owned
by another surface is not rendered, linked, or reachable on a surface that does not
own it. Truth-state mutation controls exist on no surface; transitions occur only
through domain commands (SPEC-001 SM-6).
Acceptance oracle: A route-and-control inventory test crawls every route in
`/portal`, `/console`, `/admin`, `/auditor` in a production build, asserts each
route's owning surface against a declared manifest, and asserts zero rendered
controls with a truth-state transition handler outside the domain-command path.
Required negative case: Injecting a "Mark as removed" button on `/console/cases/[caseId]`
must fail the inventory test and must be refused by the application layer if the
control is nonetheless invoked.

**VG-UI-002 — Auditors cannot write**
Requirement: Every `/auditor` route is read-only. No POST/PUT/PATCH/DELETE handler
is registered under `/auditor`; the console renders zero interactive controls other
than navigation, filter, and pagination.
Acceptance oracle: HTTP method matrix over all `/auditor` routes returns 405 for
write methods; the rendered route snapshot contains zero elements matching
`button[type=submit]`, `form`, or any control bound to a mutation handler.
Required negative case: A direct POST to `/auditor/cases/[caseId]/evidence` must
return 405 and must create no `AuditEvent` and no state change.

**VG-UI-003 — Tenant isolation is visible and is not simulated in the browser**
Requirement: Every route is tenant-scoped server-side and enforced by PostgreSQL RLS
plus the service layer (VG-TENANT-001, VG-TENANT-002). The browser holds no
tenant-switching control, and a tenant identifier supplied by the browser is never
the basis for scope selection.
Acceptance oracle: Cross-tenant route request with a valid session for tenant B and
tenant A's case ID returns the access-denied state (VG-UI-052) with zero rows
rendered; the service-layer and RLS denials are both observable in logs.
Required negative case: Forging a tenant identifier in a cookie, header, or query
parameter must not cause any cross-tenant row to render.

**VG-UI-004 — Surface shell and declared routes**
Requirement: The four surfaces are served at these exact route paths, and no others
are introduced without amending this section:

| Route | Surface | Purpose |
|---|---|---|
| `/portal` | Subject portal | Landing and case list for the session's subject |
| `/portal/authority` | Subject portal | `AuthorityGrant` verification and management |
| `/portal/onboarding` | Subject portal | Onboarding stepper (VG-UI-023) |
| `/portal/exposures` | Subject portal | Exposure review and match confirmation |
| `/portal/cases/[caseId]` | Subject portal | Case detail and append-only timeline |
| `/portal/cases/[caseId]/evidence/[evidenceId]` | Subject portal | Evidence viewer |
| `/portal/alerts` | Subject portal | `Reappearance` alerts and re-removal |
| `/portal/requests` | Subject portal | Appeal / escalation request |
| `/portal/limitations` | Subject portal | What the service cannot do (VG-UI-070) |
| `/console/queue` | Operations console | `RequestCase` work queue |
| `/console/cases/[caseId]` | Operations console | Case work and reconciliation |
| `/console/exposures/[exposureId]` | Operations console | Match review inside the `HumanGate` |
| `/console/gates` | Operations console | `HUMAN_REQUIRED` triage |
| `/console/recipes` | Operations console | `RemovalRecipe` and `Source` freshness |
| `/console/coverage` | Operations console | Per-run coverage reports |
| `/admin/tenant` | Tenant admin console | Tenant settings |
| `/admin/policy` | Tenant admin console | `JurisdictionPolicy` assignment |
| `/admin/authority` | Tenant admin console | `AuthorityGrant` issue/revoke |
| `/admin/catalog` | Tenant admin console | `SourceCatalogEntry` and `RemovalRecipe` enablement |
| `/admin/users` | Tenant admin console | Users and roles |
| `/admin/metrics` | Tenant admin console | Metric configuration and denominators |
| `/auditor/claims` | Auditor view | Claim → requirement → case → artifact → digest |
| `/auditor/cases/[caseId]` | Auditor view | Read-only case history |
| `/auditor/evidence/[evidenceId]` | Auditor view | Read-only artifact and digest |
| `/auditor/exports` | Auditor view | Evidence bundle export requests |

Acceptance oracle: A build-time route manifest emitted from the framework's route
tree equals this table exactly (set equality, both directions).
Required negative case: An undeclared route renders the not-found state and appears
in the manifest diff, failing the equality check.

**VG-UI-005 — Route parameters are opaque identifiers only**
Requirement: Every dynamic route segment and every query parameter value is an
opaque identifier from SPEC-001 §2 (`SubjectId`, `CaseId`, `ExposureId`, `SourceId`,
`RecipeId`, `ActionId`, `EvidenceId`). Raw PII never appears in a path segment, a
query string, a fragment, a route state value, or a breadcrumb.
Acceptance oracle: A crawl over every route with instrumentation of
`location.href`, `history.state`, and `document.referrer` for the session finds only
allowlisted opaque identifiers; a server-side validator rejects any request whose
path or query matches the PII pattern set of VG-UI-083.
Required negative case: A request to `/portal/cases?email=…` (any PII value) must be
refused server-side with the invalid-parameter error and must not render the case.

**VG-UI-006 — Subject-scoped access is resolved server-side from the session**
Requirement: A hidden or read-only control is never the access control. Every route
resolves the session's subject scope server-side before any data is returned.
Rendering a control the current session may not use is a defect even if the control
is disabled.
Acceptance oracle: Route snapshot for a session without a role returns the
access-denied state with zero data-bearing controls in the DOM.
Required negative case: Hiding a control with CSS while leaving its handler reachable
must fail the snapshot assertion and must return a denial from the server when called.

---

## 2. Truth-state presentation contract (safety-critical)

This section is the UI half of SPEC-000 §5.1. The eleven states are the only status
vocabulary; none may be collapsed, softened, or summarised away.

### 2.1 Rendering units

- **Label** — the user-visible name of the state, rendered inside
  `TruthStateBadge`. Non-negotiable text (VG-UI-009).
- **Qualifier** — the mandatory sentence stating what the state does **not** mean.
  Rendered by `StateQualifier` immediately adjacent to the label, in the same
  reading order, never inside a tooltip-only surface, never truncated, never
  collapsed behind a "more" control (VG-UI-010).
- **Machine value** — the exact SPEC-000 §5 token, always present on the rendering
  element as `data-truth-state` (VG-UI-007).
- **Description** — one additional neutral sentence used in the state legend
  (`/portal/limitations`, `/console/queue` help, `/auditor/claims`) and as the
  accessible description when the qualifier is already visible.

### 2.2 The eleven states

| # | Machine value (`data-truth-state`) | Label | Mandatory qualifier (exact copy) | Description (legend copy) |
|---|---|---|---|---|
| 1 | `DISCOVERED_CANDIDATE` | Discovered — not yet confirmed as you | "A record was found that may relate to you. Subject identity is not confirmed, and removal has not been assessed." | A candidate record retrieved from a permitted read path. |
| 2 | `MATCH_CONFIRMED` | Confirmed as you | "Recorded evidence supports that this record is about you. This does not mean removal is possible or lawful." | Identity match above the policy threshold, with a recorded basis. |
| 3 | `REQUEST_READY` | Ready to submit | "Authority, a policy decision, and a current RemovalRecipe all exist. No external action has occurred yet." | Prepared to act; nothing has been sent. |
| 4 | `REQUEST_SUBMITTED` | Submitted — outcome unknown | "A channel accepted the action. This does not mean the Controller received it, read it, or will act. This is not removal." | An ExternalAction was accepted by a channel. |
| 5 | `ACKNOWLEDGED` | Acknowledged — not deleted | "The Controller or Source responded acknowledging the request. This does not mean deletion occurred." | A response was received; it is a claim, not an observation. |
| 6 | `VERIFIED_REMOVED` | Verified not found at this Source | "Independent re-observation did not find this record at this Source, by the method the RemovalRecipe requires, within the observation window shown. This does not cover backups, downstream copies, or other Sources." | Independently verified absence at one Source, for one observation window. |
| 7 | `SEARCH_DELISTED` | Delisted from search results | "A search engine no longer returns this result. The page at the Source has not been shown to be removed. Search and Source are separate effects." | Search-result removal only; the Source page is a separate case. |
| 8 | `VERIFIED_NOT_PRESENT` | Not found in the coverage checked | "A valid scan observed no confirmed listing. Coverage was partial: what was and was not checked is shown with this result. This does not mean the record never existed or does not exist outside the checked scope." | No confirmed listing observed in a bounded scan. |
| 9 | `NOT_REMOVABLE` | Not removable — lawful limit | "A lawful, public-interest, or technical limit prevents removal, with the recorded basis shown. This is a final outcome, not a failure, and not an unfinished attempt." | A recorded basis states why no lawful path exists. |
| 10 | `HUMAN_REQUIRED` | Human step required | "A legitimate human, identity, legal, or provider-permitted gate blocks automation. This is a normal outcome, not a defect or an error." | A HumanGate must be completed by a person. |
| 11 | `REAPPEARED` | Appeared again | "This exposure was independently verified as not found and has since been observed again. The earlier verification was not necessarily wrong; it was accurate for its scope and window." | A previously VERIFIED_REMOVED exposure observed again. |

For row 10 the qualifier token `provider-permitted` is the exact SPEC-000 §1 term and
is allowlisted by VG-UI-008.

### 2.3 Colour tokens, glyph, and non-colour channels

Tokens are CSS custom properties. Text colour is always `--vg-ink-900` so that label
contrast is ≥ 4.5:1 by construction; the state hue is carried by a 2px inline-start
border plus a tinted fill (VG-UI-058).

| Machine value | Token | Border hue | Tint fill | Glyph | `data-truth-group` |
|---|---|---|---|---|---|
| `DISCOVERED_CANDIDATE` | `--vg-state-candidate` | `#6B7280` | `#EFF1F4` | `◇` hollow diamond | `uncounted` |
| `MATCH_CONFIRMED` | `--vg-state-confirmed` | `#1D4ED8` | `#E8EEFD` | `◆` filled diamond | `uncounted` |
| `REQUEST_READY` | `--vg-state-ready` | `#0E7490` | `#E6F4F7` | `◐` half disc | `uncounted` |
| `REQUEST_SUBMITTED` | `--vg-state-submitted` | `#0369A1` | `#E7F1FA` | `↑` arrow up | `uncounted` |
| `ACKNOWLEDGED` | `--vg-state-acknowledged` | `#6D28D9` | `#F1EBF9` | `✓` check | `uncounted` |
| `VERIFIED_REMOVED` | `--vg-state-verified` | `#15803D` | `#E9F6EC` | `~` single tilde | `verified` |
| `SEARCH_DELISTED` | `--vg-state-delisted` | `#4D7C0F` | `#F0F7E3` | `≁` not-tilde | `verified` |
| `VERIFIED_NOT_PRESENT` | `--vg-state-absent` | `#374151` | `#ECEEF1` | `∅` empty set | `verified` |
| `NOT_REMOVABLE` | `--vg-state-notremovable` | `#B45309` | `#FDF3E3` | `⊘` barred circle | `forbidden` |
| `HUMAN_REQUIRED` | `--vg-state-human` | `#A16207` | `#FBF3DC` | `☖` human marker | `action` |
| `REAPPEARED` | `--vg-state-reappeared` | `#B91C1C` | `#FBE9E9` | `↻` cycle | `reopened` |

`data-truth-group` distinguishes the sets that must never be conflated:
`verified` = independently observed effects (`VERIFIED_REMOVED`, `SEARCH_DELISTED`,
`VERIFIED_NOT_PRESENT`); `uncounted` = in-flight or unverified steps that must never
enter a success metric; `reopened` = `REAPPEARED`; `forbidden` and `action` = the two
legitimate non-automatable outcomes.

### 2.4 Component contract

The only implementation of state rendering is `TruthStateBadge`, declared in
`{app}/ui/truth/TruthStateBadge.tsx` with:

| Prop | Type | Rule |
|---|---|---|
| `state` | the eleven-member union, imported from the generated canonical token module | Required. No `string` overload exists. |
| `scope` | `{ sourceId?: SourceId; windowDays?: number; checkedAt?: string }` | Required for `VERIFIED_REMOVED`, `VERIFIED_NOT_PRESENT`, `SEARCH_DELISTED`; renders inside the label as a scope suffix. |
| `variant` | `'badge' \| 'block'` | `badge` for lists, `block` for detail headers. |
| `showQualifier` | boolean, default `true` | Setting `false` is permitted only where `StateQualifier` is rendered immediately adjacent in the same container. |

Rendered output contract (all three channels are mandatory: label text, unique glyph,
and machine value — VG-UI-057):

```html
<span data-truth-state="VERIFIED_REMOVED" data-truth-group="verified"
      class="vg-truth-badge vg-truth-badge--verified">
  <span class="vg-truth-badge__glyph" aria-hidden="true">~</span>
  <span class="vg-truth-badge__label">Verified not found at this Source · Source: EXAMPLE_BROKER · window 30d</span>
  <span class="vg-truth-badge__machine">VERIFIED_REMOVED</span>
</span>
```

The machine value is rendered visually in a monospace face so a reader can always
cross-check the exact token — paraphrase drift is a defect, not a style choice.

Accessible-name rules: when `showQualifier` is `true` the qualifier is visible text
and the badge's accessible description references that visible node via
`aria-describedby` (so it is announced once, not twice). When `showQualifier` is
`false` the qualifier is supplied as the accessible description by `StateQualifier`,
which is still visible in the same container. The badge never carries the qualifier
only in a `title` attribute (VG-UI-010).

**VG-UI-007 — One canonical truth-state mapping**
Requirement: The eleven-token mapping (label, qualifier, description, token, glyph,
group, scope requirement) exists in exactly one module and is consumed by the badge,
the legend, exports, and tests. No second mapping, no per-screen override, no
locale string that omits or rewrites a qualifier.
Acceptance oracle: A single-source test iterates the eleven machine values and
asserts the rendered DOM for each equals the §2.2 copy after whitespace normalisation;
a duplicate-mapping scan finds exactly one declaration of the mapping object.
Required negative case: Adding a screen-level label override (for example rendering
`REQUEST_SUBMITTED` as "Submitted for removal") must fail the copy-equality test.

**VG-UI-008 — Vocabulary conformance in UI strings and identifiers**
Requirement: UI copy, component names, props, `data-*` hooks, test ids, and route
segments use only canonical SPEC-000 §4 tokens. Forbidden synonyms appear nowhere in
production identifiers or rendered text. The two allowlists of §0.3 are the only
permitted occurrences of their constituent nouns.
Acceptance oracle: A vocabulary gate scans the built browser bundle, server-rendered
HTML fixtures, and the route manifest for the §4 forbidden-synonym list plus the
permanent claim list of VG-UI-082; unallowlisted hits exit non-zero and name the file and
line.
Required negative case: Introducing `class="client-summary"` or the copy "we removed
you from the internet" must make the gate exit non-zero.

**VG-UI-009 — Exact labels and machine values**
Requirement: The labels and machine values in §2.2/§2.3 are rendered verbatim. Labels
are never abbreviated, iconified without their text, pluralised, capitalised
differently, or replaced by a synonym. The machine value is always present as
`data-truth-state`.
Acceptance oracle: Rendered-DOM assertions compare the label text and the
`data-truth-state` attribute for all eleven states in the list, detail, timeline,
export, and dashboard contexts.
Required negative case: Rendering "Verified removed" without the
"at this Source" scope suffix, or emitting `data-truth-state="REMOVED"`, must fail.

**VG-UI-010 — Mandatory qualifiers are never hidden**
Requirement: Every rendering of a truth state shows the §2.2 qualifier in the same
reading order, outside tooltips, popovers, disclosure widgets, or truncated text. The
qualifier is never replaced by an "info" icon alone.
Acceptance oracle: For each state, an accessibility-tree snapshot of the containing
region includes the qualifier string in the accessible text and the element is not
inside a `[hidden]`, `[aria-hidden="true"]`, `<details>` closed, or tooltip role
subtree.
Required negative case: Moving the qualifier into a `title` attribute must fail the
accessibility-tree assertion.

**VG-UI-011 — `REQUEST_SUBMITTED` never renders as a removal**
Requirement: `REQUEST_SUBMITTED` renders the §2.2 label and qualifier and is
categorised `data-truth-group="uncounted"`. In any list, table, or export it appears
under headings that do not contain "removed", "deleted", "success", or "complete",
and it is never styled with `--vg-state-verified`.
Acceptance oracle: A snapshot of every container that renders the state asserts the
label, the group, and the absence of removal language in ancestor headings and in the
row's accessible name; a metric-input test asserts the state contributes zero to any
numerator whose name contains "removed".
Required negative case: Rendering `REQUEST_SUBMITTED` with the success token or in a
"Removed" column must fail.

**VG-UI-012 — `ACKNOWLEDGED` never renders as deleted**
Requirement: `ACKNOWLEDGED` renders the §2.2 label and qualifier, group `uncounted`,
and is never presented as satisfying a removal acceptance criterion. Where a
`ControllerResponse` is displayed, its `claimedOutcome` is labelled as a claim
(SPEC-001 §3.4).
Acceptance oracle: The case detail and list renderings assert the label, the
qualifier, and that the response region's accessible name contains "claim"; the
dashboard input test asserts zero contribution to removal numerators.
Required negative case: Labelling a `ControllerResponse` as "Deletion confirmed" must
fail.

**VG-UI-013 — `SEARCH_DELISTED` is visibly distinct from Source removal**
Requirement: `SEARCH_DELISTED` renders its own label, glyph `≁`, and group
`verified` but is never merged with, stacked into, or counted in the same visual or
numeric unit as `VERIFIED_REMOVED`. Source-effect and search-effect figures are
rendered as separate labelled units with separate denominators (SPEC-000 §5.1,
VG-CHANNEL-001 #5).
Acceptance oracle: The dashboard and case-list renderings assert two distinct units
with distinct labels and distinct denominators; a rendered-DOM assertion confirms no
element carries both states' values in one figure.
Required negative case: Adding delistings into the Source-removal figure, or
rendering a single "Removed" tile that includes delistings, must fail.

**VG-UI-014 — `VERIFIED_NOT_PRESENT` displays its coverage bounds**
Requirement: Every rendering of `VERIFIED_NOT_PRESENT` displays the coverage bounds
that produced it: `sources_attempted`, `sources_total`, the observation window, and
the list of skipped Sources with reasons (VG-DISC-002, SPEC-000 §5.1). The phrase
"not found" never appears without the coverage context in the same region.
Acceptance oracle: For a `VERIFIED_NOT_PRESENT` rendering, the containing region's
accessible text includes the attempted/total figures and at least the count of
skipped Sources; a click or keystroke opens the full unchecked list.
Required negative case: A partial scan rendering the state with no coverage bounds,
or with the bounds behind a tooltip only, must fail.

**VG-UI-015 — `HUMAN_REQUIRED` is a legitimate outcome**
Requirement: `HUMAN_REQUIRED` is presented affirmatively with the §2.2 label and
qualifier, never in an error region, never with error semantics
(`role="alert"` for the state itself), never with a red "failed" treatment, and
never removed from case counts. It always carries a next-action affordance naming
who must act: the subject, the operator, or counsel.
Acceptance oracle: A rendering assertion confirms the state is not inside any
`[role="alert"]` or element with `data-severity="error"`, is included in the case
count by default, and has a next-action control whose accessible name names the
actor.
Required negative case: Rendering `HUMAN_REQUIRED` inside the error banner or
excluding it from the default case count must fail.

**VG-UI-016 — `NOT_REMOVABLE` is a legitimate outcome and is never hidden**
Requirement: `NOT_REMOVABLE` is presented with the §2.2 label and qualifier together
with its recorded basis (jurisdiction, legal basis, policy version, reasons), is
included by default in every case count and export, and has no filter that hides it
by default. It is never rendered as unfinished, retryable-by-default, or as an error.
Acceptance oracle: The case list and export include `NOT_REMOVABLE` rows in the
default view; the basis fields are present in the detail region; a default-filter
assertion confirms the state is not excluded without an explicit user action that is
labelled as a filter.
Required negative case: A default filter that hides `NOT_REMOVABLE`, or a
"Try again" primary control on a final lawful refusal, must fail.

---

## 3. Coverage honesty in the UI

These requirements make SPEC-000 §7 visible and testable at the interface.

**VG-UI-017 — `CoveragePanel` is the only coverage presentation**
Requirement: Any coverage figure, count, or statement is rendered by `CoveragePanel`
(or its `CoverageSummaryInline` variant), which always renders
`sources_attempted`, `sources_total`, the declared catalogue version, the run window,
and the count of skipped Sources with a control that reveals each skipped Source and
its reason.
Acceptance oracle: Rendered-DOM assertions on every route that displays coverage
assert all five elements; a component-usage scan finds no second coverage renderer.
Required negative case: A hand-written sentence containing "of our sources" without
the attempted/total pair must fail the scan.

**VG-UI-018 — Denominators accompany every percentage**
Requirement: Every percentage or ratio in the UI renders as
`<num> / <denom> (<pct>)` in a single unit, where the denominator is a real count
from the same source as the numerator, with a denominator label. A percentage
without its denominator is a rendering defect (SPEC-000 §7.4).
Acceptance oracle: A DOM scan of every route finds zero `%` text nodes that are not
within a `MetricFigure` element carrying a numeric denominator and a denominator
label; a fixture with a denominator of zero renders "0 / 0 — not computable", not
`0%` and not `NaN`.
Required negative case: Rendering "98% removed" alone, or rendering `NaN%`, must
fail.

**VG-UI-019 — Confidence is shown with its basis**
Requirement: Every displayed `Confidence` value renders as the 0.00–1.00 decimal
(no bare percentage) together with its recorded `basis[]` (feature name plus
contribution) and the policy threshold applied (VG-IDENT-003, SPEC-001 §2).
Acceptance oracle: For each exposure rendering, the basis list and threshold are
present in the same region's accessible text; a fixture with an empty basis fails
validation rather than rendering a bare score.
Required negative case: Rendering "92% match" with no basis entries must fail.

**VG-UI-020 — No universal or permanent removal claim**
Requirement: The UI never states or implies removal from the internet, permanent
deletion, deletion everywhere, deletion from backups, or deletion from all copies.
The strongest permitted statement is the §2.2 `VERIFIED_REMOVED` label plus
qualifier, scoped to one `Source` and one observation window. This rule binds every
surface, including marketing-adjacent copy, footer copy, email templates linked from
the UI, and page titles.
Acceptance oracle: The copy-lint gate scans rendered HTML, page metadata, and
message templates against the permanent-claim list in VG-UI-082 and exits non-zero on any
hit.
Required negative case: The string "Removed from the internet" in any heading,
`<title>`, meta description, or empty state must fail the gate.

**VG-UI-021 — A request count is never a removal count**
Requirement: `ExternalAction` counts and `RequestCase` counts are labelled as
submitted or in-flight work, never as removals, and are never rendered in the same
visual unit as `VERIFIED_REMOVED` counts (SPEC-000 §7.3, VG-OBS-002).
Acceptance oracle: Rendered-DOM assertions confirm distinct visually-separated units
with distinct labels; a name-based test asserts no element labelled with "removed"
contains an action or case count.
Required negative case: A tile labelled "Removals: 412" fed by a submitted-action
count must fail.

**VG-UI-022 — Partial coverage is labelled above the affected content**
Requirement: When a scan, case list, or case is derived from partial coverage, a
persistent coverage banner renders above the affected content and the affected rows
carry a "partial coverage" marker. No absence statement is rendered unqualified
(VG-DISC-002).
Acceptance oracle: With a fixture run where `sources_attempted < sources_total`, the
banner precedes the content in DOM order and in reading order, and each affected row
carries the marker.
Required negative case: A partial run rendering "No exposure found" with no banner
must fail.

---

## 4. Subject portal and onboarding

**VG-UI-023 — Onboarding states authority and scope before any data**
Requirement: `/portal/onboarding` is an ordered stepper — (1) what this service does
and does not do, (2) identity verification, (3) authority confirmation, (4) review of
discovered exposures, (5) coverage summary — and it renders no discovered data before
step 3 completes with a valid `AuthorityGrant` (VG-IDENT-001).
Acceptance oracle: With an invalid or absent `AuthorityGrant`, steps 4 and 5 render
the withheld state and zero exposure rows; the stepper's current step is exposed via
`aria-current="step"`.
Required negative case: Deep-linking to `/portal/exposures` before authority exists
must render the withheld state, not an empty-but-successful exposure list.

**VG-UI-024 — Pre-authority disclosure with no pre-selected control**
Requirement: The disclosure required before any authorization control renders the
VG-UI-070 scope statement verbatim, and every consent-shaped control starts unchecked
with no default value. Continuing without an explicit user action is impossible
(via a disabled submit control plus a server-side check).
Acceptance oracle: A DOM assertion confirms every checkbox/radio in the onboarding
flow is unchecked on first render across all onboarding routes; the server rejects a
submission whose disclosure acknowledgement is absent.
Required negative case: A pre-checked disclosure control, or a form that submits with
the acknowledgement missing, must fail on both the browser and the server.

**VG-UI-025 — Authority verification display**
Requirement: `/portal/authority` renders, for each `AuthorityGrant`: kind
(`SELF`/`AGENT`/`DEPENDENT`), `scope[]`, `issuedAt`, `expiresAt`, `revokedAt` when
present, and the linked `EvidenceArtifact` digest. Expired or revoked grants render
the expired state and cannot be used to start or continue work (VG-AUTHZ-001).
Acceptance oracle: For fixtures spanning unexpired, expiring, expired, and revoked
grants, each renders its kind, scope, dates, and digest; a case action attempted with
an expired grant is refused and audited.
Required negative case: An expired grant rendering as active, or a grant row with no
visible digest, must fail.

**VG-UI-026 — Authorized-agent path requires signed evidence and review**
Requirement: For an `AuthorityGrant` of kind `AGENT`, `/portal/authority` requires an
uploaded signed instrument, displays its digest, and states that the instrument is
reviewed by a person before any external action. A missing or unsigned instrument
renders the `HUMAN_REQUIRED` presentation with its qualifier (VG-AUTHZ-002).
Acceptance oracle: An `AGENT` grant without an instrument cannot reach a
`REQUEST_READY` presentation; the UI shows the `HUMAN_REQUIRED` state plus qualifier
and stores nothing as evidence.
Required negative case: An unsigned instrument being accepted into an automated
write lane must fail and must be audited as refused.

**VG-UI-027 — Authority can be revoked from the UI**
Requirement: `/portal/authority` provides a revoke control with a confirmation step
that names the consequence ("no further ExternalAction will be taken for this
subject"), refreshes the authority state, and never deletes history.
Acceptance oracle: After revocation, the grant renders revoked, further action
controls render unavailable-with-reason, and the `AuthorityRevoked` audit event is
readable in the case timeline.
Required negative case: Revoking while the UI still offers an action control that
succeeds must fail.

**VG-UI-028 — Scope boundary is enforced and stated**
Requirement: The portal supports actions only for the session's verified
`ProtectedSubject` (including an authorized dependent under the strict lane). Copy
states that the service does not act for any other person, and no control accepts a
third-party name, email, address, or identifier as a target (VG-SCOPE-001,
VG-SCOPE-002).
Acceptance oracle: A form-input inventory finds zero fields whose label or name
accepts a person other than the verified subject; a submission naming a third party
is refused and audited.
Required negative case: A "add another person" control that reaches a discovery or
action path must fail.

---

## 5. Exposure review and match confirmation

**VG-UI-029 — `ExposureReview` renders provenance, basis, and thresholds**
Requirement: Each exposure rendering shows the `Source`, the `SourceRecord`
`observedAt` and `contentHash`, the `Confidence` decimal with its full `basis[]`, the
policy threshold applied, and the `TruthStateBadge`. Untrusted-content taint
(VG-SEC-001) is indicated where present, and tainted content is labelled as untrusted
and cannot be actioned from the UI.
Acceptance oracle: For a tainted fixture, the exposure renders an untrusted marker,
all listed fields are present in the accessible text, and action controls are
unavailable with a stated reason.
Required negative case: An exposure rendering with no basis, no threshold, or an
actionable tainted row must fail.

**VG-UI-030 — `HumanMatchConfirmAffordance` is the only match-confirmation control**
Requirement: Match confirmation at policy threshold is automatic; below threshold the
only path to `MATCH_CONFIRMED` is an explicit human confirmation through
`HumanMatchConfirmAffordance` (the component name avoids the forbidden synonym
*approval*), which requires a mandatory free-text basis of at least 20 characters,
records the confirming actor's identity, and produces a match-basis record
(SPEC-001 T3; the operations console has no match-confirmation job per §1, so this
affordance exists on the subject portal and inside the console's gate review only).
Acceptance oracle: With a below-threshold fixture, the confirmation control is disabled
until the basis field contains ≥ 20 characters; after confirmation a match-basis record
with the actor and timestamp is readable in the timeline and in the audit view.
Required negative case: Confirming with an empty basis, or a code path that reaches
`MATCH_CONFIRMED` without a recorded basis, must fail.

**VG-UI-031 — Rejection routes to `VERIFIED_NOT_PRESENT` with a disproof record**
Requirement: The "This is not me" control records a disproof record and renders
`VERIFIED_NOT_PRESENT` with coverage bounds — never a deletion, never silence. The
current coverage of the scan that produced the candidate is displayed with the
result.
Acceptance oracle: After rejection the exposure renders `VERIFIED_NOT_PRESENT` with
the §2.2 qualifier, the coverage bounds, and a readable disproof record; the state
transition is present in the timeline.
Required negative case: Rejection rendering "Removed", or a rejection that leaves the
state at `DISCOVERED_CANDIDATE` with no record, must fail.

**VG-UI-032 — No bulk confirmation of ambiguous matches**
Requirement: Exposures below the policy threshold cannot be confirmed in bulk; each
requires its own human confirmation through VG-UI-030. Bulk controls may only operate
on rows already at or above threshold, or on rejection.
Acceptance oracle: A select-all-above-threshold control exists and a select-all
control does not; a crafted bulk request containing a below-threshold exposure is
refused at the service layer and audited.
Required negative case: A bulk confirmation that confirms a below-threshold exposure
must fail.

**VG-UI-033 — Duplicate and quarantine states are visible**
Requirement: A quarantined `Alias` (VG-IDENT-002) and a duplicate exposure candidate
are rendered with their own explicit markers and explanation, and are excluded from
action paths until resolved. The alias quarantine marker names the conflicting
subject references by opaque IDs only.
Acceptance oracle: For a quarantined-alias fixture, the marker and explanation
render, no action control is available, and the resolution control records who
resolved the conflict.
Required negative case: A quarantined alias being auto-attached and actionable must
fail.

---

## 6. Case detail, timeline, and evidence

**VG-UI-034 — `TruthTimeline` renders the append-only audit as history**
Requirement: `/portal/cases/[caseId]`, `/console/cases/[caseId]`, and
`/auditor/cases/[caseId]` render the `AuditEvent` history through `TruthTimeline`,
one row per event, ordered oldest-first by default with a documented newest-first
toggle. Each row shows the timestamp in the viewer's timezone with the UTC offset,
the actor identity reference, the event name, the resulting `TruthStateBadge` where
applicable, and links to the linked evidence. The timeline is a read-only projection
of an append-only store (VG-EVIDENCE-003).
Acceptance oracle: For a multi-event fixture, row count equals the `AuditEvent`
count for the case, ordering is deterministic, each row resolves to its event record,
and the rendered order in the DOM matches the reading order.
Required negative case: A row count lower than the audit count, or a timeline built
from a mutable projection that omits an event, must fail.

**VG-UI-035 — The timeline offers no edit, delete, or reorder**
Requirement: `TruthTimeline` renders no control that edits, deletes, hides, or
reorders a recorded event; it renders no predicted or planned future event; it never
back-dates or re-labels a past event with a newer truth state.
Acceptance oracle: A control inventory over the timeline finds no mutation handler;
an attempted audit update or delete through the application layer fails; a snapshot
asserts every rendered row corresponds to a persisted event and that no future-dated
row renders.
Required negative case: An "edit note" or "hide event" control must fail the
inventory, and an update attempt must fail validation.

**VG-UI-036 — State changes are legible as transitions**
Requirement: Where a state changed, the case detail renders the transition as
`<from> → <to>` using two `TruthStateBadge` instances and the guard evidence name
(for example "VerificationObservation"), so a reader can see which transition
occurred and what evidence accompanied it (SPEC-001 §4.1).
Acceptance oracle: For a case that passed T11 then T14, the detail region renders
both transitions with correct labels and the evidence names.
Required negative case: Rendering only the current state with no transition history
for a case with multiple transitions must fail.

**VG-UI-037 — Deadlines render as evidence-derived dates, not urgency**
Requirement: Where a `Deadline` exists it renders the `dueAt` date, its `kind`, and
its policy-version source, with neutral wording. The UI renders no countdown timer,
no "time is running out" language, and no auto-escalating visual severity
(VG-UI-065).
Acceptance oracle: A DOM scan finds no element that updates a remaining-time value
for a `Deadline`; the rendered deadline text states the source version.
Required negative case: A per-second countdown attached to a `Deadline` must fail the
scan.

**VG-UI-038 — Evidence viewer shows the digest and immutability**
Requirement: `/portal/cases/[caseId]/evidence/[evidenceId]` renders the
`EvidenceArtifact` `kind`, `capturedAt`, `redactionState`, and the full
`EvidenceDigest` as selectable monospace text of 64 lowercase hex characters, with
the immutability statement "This artifact is content-addressed. Any change to the
file changes its digest; a changed digest means the file is not this artifact."
Digest verification is performed on read and a mismatch renders the integrity-failure
state (SPEC-001 `EvidenceDigest`, VG-EVIDENCE-001).
Acceptance oracle: For a stored artifact, the rendered digest equals the stored
digest character-for-character; with a tampered fixture, the integrity-failure state
renders with the expected and actual digests and the artifact does not render as
valid.
Required negative case: Rendering an abbreviation of the digest, or rendering a
tampered artifact without the integrity-failure state, must fail.

**VG-UI-039 — Disclosure of sensitive artifact content is explicit**
Requirement: `EvidenceArtifact` content that contains PII is masked by default
through `PiiRedactor`; revealing full content requires an explicit keyboard-operable
action per artifact, which is recorded as an audit event naming actor, artifact, and
timestamp. Reveal state resets on navigation away and on session end.
Acceptance oracle: An accessibility-tree and DOM-text snapshot of the initial render
contains no unmasked PII; after the reveal action, the audit sink holds one reveal
event per artifact per session, and returning to the route renders masked again.
Required negative case: Auto-displaying an unmasked identity document on route load
must fail the snapshot.

**VG-UI-040 — Exposure to source evidence is bounded**
Requirement: Only the minimum content needed to justify the case is displayed; the UI
never renders more of a `SourceRecord` than the recorded exposure fields, and offers
no "download full record" control. Exports from the portal are limited to the
subject's own case summary.
Acceptance oracle: A field-level comparison of the rendered exposure fields against
the declared exposure field allowlist finds no extra field; a download inventory on
`/portal` finds no full-record export.
Required negative case: A "download raw record" control must fail the inventory.

---

## 7. Reappearance, re-removal, and appeal

**VG-UI-041 — `ReappearanceAlert` only for true reappearances**
Requirement: `/portal/alerts` renders `ReappearanceAlert` only for exposures whose
current state is `REAPPEARED` resulting from a persisted `Reappearance` row linked to
a prior `VERIFIED_REMOVED` event (VG-REAPPEAR-001). A first-ever discovery never
renders an alert and never uses the `↻` glyph or the `Appeared again` label.
Acceptance oracle: For a fixture containing one true reappearance and one first-ever
discovery, exactly one alert renders with a link to the prior removal event and its
evidence; the discovery renders no alert.
Required negative case: A first discovery rendering `REAPPEARED`, or an alert with no
prior-removal link, must fail.

**VG-UI-042 — Re-removal preserves history**
Requirement: The re-removal control starts a new attempt with preserved history: it
renders the prior case, the prior `EvidenceArtifact` digests, the prior verification
window, and states that the new attempt is a new `ExternalAction` (VG-REAPPEAR-002).
The control is unavailable while authority is expired or revoked, with the reason
stated.
Acceptance oracle: After initiating re-removal, the prior case's evidence and
timeline remain readable and unchanged, the new attempt renders as a separate
`ExternalAction` with its own attempt number, and the expired-authority fixture
renders the control unavailable with a reason.
Required negative case: Initiating re-removal with an expired grant, or overwriting
or hiding prior history, must fail.

**VG-UI-043 — Reappearance explains scope without blaming verification**
Requirement: `ReappearanceAlert` renders the §2.2 `REAPPEARED` qualifier and the
prior verification's `Source`, method, and window, and renders no copy stating or
implying that the earlier verification was wrong, false, or a failure
(SPEC-000 §5 row 11).
Acceptance oracle: The alert region's accessible text contains the qualifier and the
prior verification's Source, method, and window, and the copy-lint gate finds no
"failed verification" phrasing for this state.
Required negative case: Copy such as "our earlier check was wrong" must fail the
gate.

**VG-UI-044 — Appeal/escalation is human-gated**
Requirement: `/portal/requests` presents appeal and escalation as `AppealEscalation`
requests with `requiresHumanReview = true`, rendered behind `HumanGateNotice`. The
copy states that counsel or a named human reviews the packet before it is sent, that
no regulator or legal threat is delivered by the system, and that the request may be
declined with a reason. The UI renders no legal-basis text authored by anything other
than a versioned policy row (VG-POLICY-001, VG-CHANNEL-001 #7).
Acceptance oracle: Submitting the request creates an `AppealEscalation` row with
`requiresHumanReview = true` and no external effect; a fixture with no matching
policy row renders no legal basis and blocks submission.
Required negative case: A request that produces an immediate external effect, or one
whose legal basis text is model-authored, must fail.

---

## 8. Removal-effectiveness dashboard

**VG-UI-045 — The metric renders numerator, denominator, and interval**
Requirement: The removal-effectiveness figure renders only as
`externally verified removals / eligible confirmed matches`, with the numerator, the
denominator, and the confidence interval displayed, plus the observation interval and
the population definition (VG-OBS-002,
`REMOVAL_EFFECTIVENESS_METRICS.md`). `HUMAN_REQUIRED` and `NOT_REMOVABLE` are
excluded from the numerator and reported in the denominator's composition
(SPEC-001 SM-5).
Acceptance oracle: The rendered figure contains four numeric elements (numerator,
denominator, interval bounds) and two labels (observation interval, population
definition); a fixture with a zero denominator renders "not computable" with the
reason.
Required negative case: A headline figure of requests sent, or of
`ACKNOWLEDGED` cases, must fail the label assertion.

**VG-UI-046 — Conflated metrics are impossible**
Requirement: The dashboard renders no figure that adds `SEARCH_DELISTED` to
`VERIFIED_REMOVED`, no figure that counts `REQUEST_SUBMITTED` or `ACKNOWLEDGED` as a
removal, and no "permanent deletion" figure. Each metric definition's inputs are
declared in the rendered UI.
Acceptance oracle: A metric-definition readback lists the state tokens feeding each
figure; an assertion confirms the verified-removal figure's inputs are exactly
`{VERIFIED_REMOVED}` and that no figure's inputs mix search and Source effects.
Required negative case: A figure whose inputs include `ACKNOWLEDGED` while labelled
"removed" must fail the readback.

**VG-UI-047 — The dashboard states its own limitations**
Requirement: The dashboard renders the VG-UI-070 service-scope statement and a coverage
line naming the catalogue version and the unchecked Sources count for the reporting
period, and labels each figure as tenant-scoped with the observation window.
Acceptance oracle: The dashboard region contains the scope statement, the catalogue
version, the unchecked count, and the window label.
Required negative case: A dashboard rendering figures without a coverage line must
fail.

---

## 9. State handling for every screen

These six states apply to every route in §1 plus every data-fetching region. A screen
that implements only the success path is incomplete (DOD-019).

**VG-UI-048 — Loading state**
Requirement: Every data-bearing region renders a skeleton that preserves the final
layout's box dimensions, is hidden from assistive technology
(`aria-hidden="true"`), and exposes one polite live region announcing
"Loading <region name>." A request exceeding 10 seconds renders the delayed-loading
state naming the operation and offering a cancel control. No indefinite spinner
without text exists anywhere.
Acceptance oracle: With a delayed fixture, the skeleton's dimensions match the loaded
region within 2px, the accessible name of the region is announced once, and after
10s the delayed state renders with a cancel control.
Required negative case: A bare spinner with no text and no live region must fail.

**VG-UI-049 — Empty state**
Requirement: Every region that can return zero rows renders a named empty state that
states what was searched, over what coverage, in what window, and what the user can do
next. An absence statement is never rendered without its coverage context
(VG-DISC-002).
Acceptance oracle: For zero-row fixtures on the exposure list, case list, alerts,
queue, and audit views, each empty state names the searched surface, the coverage
figures, and one next action.
Required negative case: Rendering "No exposure found" with no coverage context must
fail.

**VG-UI-050 — Partial-coverage state**
Requirement: When a run or query is derived from partial coverage, the region renders
the coverage banner of VG-UI-022, marks affected rows, and renders the skipped-Source
list with reasons. Aggregate figures computed over partial coverage are labelled
partial and never rendered as complete.
Acceptance oracle: With a partial fixture, every affected region renders the banner
before its content, the marker on affected rows, and the skipped list with reasons.
Required negative case: A partial run rendering complete-looking totals without a
partial label must fail.

**VG-UI-051 — Error state**
Requirement: Every region renders an error state that (a) names the failed operation
in plain language, (b) displays a correlation identifier, (c) states whether the
failure is retryable, and (d) offers retry only where the retry is idempotent under
VG-ACTION-001. Errors render with `role="alert"`; the correlation identifier is
selectable text.
Acceptance oracle: With an induced failure, the region renders all four elements;
with a non-idempotent action failure, no retry control renders and the copy states
why.
Required negative case: A generic "Something went wrong" with no correlation
identifier and no retryability statement must fail.

**VG-UI-052 — Access-denied state**
Requirement: Insufficient role or scope renders a distinct access-denied state
(VG-AUTHZ-001's authorization concept, rendered as "access denied" — never using the
forbidden synonym *permission*) that names the required role conceptually, states that
the attempt was recorded, and renders no data from the denied resource — not even
counts. It never renders a 404 for an access denial on an existing resource in a way
that hides the reason from an authorized user, and never renders the resource's fields
in a disabled form.
Acceptance oracle: A request with an insufficient role returns the access-denied
state with zero resource fields in the DOM (asserted by field-name absence) and an
audit entry.
Required negative case: A denied user seeing masked-but-present PII fields, or a
denied route rendering partial data, must fail.

**VG-UI-053 — Human-gate state**
Requirement: Every point where a `HumanGate` blocks progress renders
`HumanGateNotice`, which names the gate kind, who must act, what happens after the
human acts, and what has been recorded so far; it renders the `HUMAN_REQUIRED`
presentation per VG-UI-015 and offers no bypass, solver, or "skip" control.
Acceptance oracle: For each gate fixture (identity verification, authorized-agent
instrument review, appeal review, unknown-route gate), the notice renders all four
elements and zero bypass controls exist in the route's control inventory.
Required negative case: A "continue anyway" control on a gate must fail the
inventory, and the service layer must refuse the bypass.

**VG-UI-054 — Session-expiry state**
Requirement: An expiring session renders a warning 120 seconds before expiry with a
keyboard-operable "Stay signed in" control that performs a real token refresh and a
visible re-authentication path if the refresh fails. On expiry, browser-held PII is
cleared and the re-authentication route renders with no case identifiers in the URL
(VG-UI-073, VG-UI-077).
Acceptance oracle: With a shortened idle fixture, the warning renders at the
configured threshold, the refresh control extends the session as observed by a
subsequent authorized request, and after expiry `sessionStorage`, in-memory stores,
and the clipboard-facing controls hold no PII.
Required negative case: A silent expiry that discards unsaved input, or a
re-authentication URL containing a case identifier or PII, must fail.

**VG-UI-055 — `RequestCase` queue renders the six states of §9**
Requirement: `/console/queue` implements loading, empty, partial-coverage, error,
access-denied, and human-gate states, and additionally renders `HUMAN_REQUIRED`
and `NOT_REMOVABLE` counts by default as first-class queue columns
(VG-UI-015, VG-UI-016, SPEC-000 §7.6).
Acceptance oracle: Six state fixtures plus the two outcome fixtures each render their
designated region; the default queue view includes both outcome counts.
Required negative case: A default queue that omits the `NOT_REMOVABLE` column must
fail.

---

## 10. Accessibility

Binding target: **WCAG 2.2 Level AA** for all four surfaces, at 200% zoom and at
320 CSS pixels width, in the current versions of the two latest major browser
releases.

**VG-UI-056 — WCAG 2.2 AA is the binding target, and conformance is not claimed here**
Requirement: All four surfaces must conform to WCAG 2.2 AA. Automated checks are a
necessary but insufficient input: no VG-UI accessibility requirement may be reported
as passing on automated-tool output alone, and no release claim may assert WCAG
conformance without the manual external gate of VG-UI-064. As of this document's
status (`BLUEPRINT_ONLY`, §0.1), **no conformance claim is made** — not for any
surface, not for any criterion, and not on the basis of automated tooling.
Acceptance oracle: A per-route checklist maps each applicable WCAG 2.2 A/AA success
criterion to executed evidence (automated finding plus manual procedure plus
observed result); the report distinguishes `PASS`, `FAIL`, `PARTIAL`, and
`EXTERNAL_REQUIRED` per criterion (DOD-026).
Required negative case: A conformance report whose only evidence is an automated scan
exit code of 0 must be rejected as insufficient and must record the criteria it did
not assess.

**VG-UI-057 — Truth state is never encoded by colour alone**
Requirement: Every truth state is distinguishable with all colour channels removed:
the label text is always present, the glyph is unique per state, and
`data-truth-state` plus `data-truth-group` are present in the DOM. No state is
conveyed by a background tint, a dot, or a border without its text label.
Acceptance oracle: Under a CSS filter forcing grayscale, a rendered snapshot plus an
image-difference check confirms all eleven states remain mutually distinguishable by
glyph and text; a DOM assertion confirms label and machine value for each.
Required negative case: A state rendered as a coloured dot with a tooltip and no text
label must fail under grayscale and must fail the DOM assertion.
*(This requirement is the design rule; the lived-experience judgement of whether the
encoding is usable remains the human gate VG-UI-064 and cannot be closed by a filter
check.)*

**VG-UI-058 — Contrast**
Requirement: Body text meets ≥ 4.5:1; large text meets ≥ 3:1; non-text state borders,
focus indicators, and graphical boundaries meet ≥ 3:1 against their adjacent
colours. State text uses `--vg-ink-900` on every state tint so contrast does not
depend on a per-state pairing. Dark mode, if enabled, satisfies the same thresholds.
Acceptance oracle: A token-pairing test computes contrast for every declared
foreground/background pair and fails on any pair below threshold; measured values are
recorded per token pair.
Required negative case: A state tint pairing that drops body text below 4.5:1 must
fail the pairing test.

**VG-UI-059 — Focus management**
Requirement: Focus is visible (≥ 3:1, ≥ 2px, with a non-colour indicator), is never
trapped outside a modal, moves to the region heading after route-level navigation and
after a successful form submit, returns to the invoking control after a modal closes,
and is restored after a region refresh that removes the focused element. No
`:focus { outline: none }` exists without an equivalent visible substitute.
Acceptance oracle: Keyboard-driven route tests assert the focused element identity
after each navigation, submit, modal open/close, and refresh; the modality style audit
finds no outline suppression without a substitute.
Required negative case: Removing focus outline with no substitute, or leaving focus on
a removed element after a refresh, must fail.

**VG-UI-060 — Full keyboard operation**
Requirement: Every task on all four surfaces is completable with a keyboard alone,
including truth-state inspection, evidence reveal, gate notices, the queue's filter
and pagination, the dashboard's metric-definition disclosure, and modal dialogs.
Native elements are used where they exist; where a custom widget is unavoidable,
`role`, accessible name, state, and key handling follow the ARIA Authoring Practices
for that pattern. No keyboard trap exists outside a modal that offers Escape.
Acceptance oracle: A keyboard-only scripted path completes onboarding, exposure
review, evidence reveal, appeal request, and queue filtering with no mouse events,
and each step's focused element and accessible name are recorded.
Required negative case: A drag-only or mouse-only control on any critical path must
fail the keyboard script.

**VG-UI-061 — Screen-reader semantics for the timeline and status model**
Requirement: `TruthTimeline` is an ordered list with a list-level accessible name,
one list item per event, an accessible name per row combining timestamp, actor, event,
and state label, and the ordering exposed (for example "event 3 of 12"). The current
state is exposed as text, not as a colour. `TruthStateBadge` exposes the label and
qualifier as its accessible description; live updates (a new event, a changed state)
announce once through a polite live region without re-reading the whole timeline.
Acceptance oracle: An accessibility-tree dump asserts the list role, item count,
per-row names containing the four fields, and exactly one polite announcement per
update event.
Required negative case: A timeline built from `div`s with no list semantics, or an
update that announces the full timeline again, must fail the tree assertion.

**VG-UI-062 — Reduced motion**
Requirement: Under `prefers-reduced-motion: reduce`, all non-essential animation is
disabled (durations ≤ 1ms or removed), no parallax or auto-playing motion remains,
state-change transitions are instantaneous, and no meaning is carried by motion. No
content flashes more than three times per second in any mode.
Acceptance oracle: Under the reduced-motion media query, computed animation and
transition durations for all rendered elements are ≤ 1ms and a state-change
snapshot shows the final presentation with no intermediate frames.
Required negative case: A state-change animation that persists under reduced motion
must fail the computed-duration assertion.

**VG-UI-063 — Accessible authentication**
Requirement: No authentication step requires a cognitive function test (transcription,
puzzle, memory, or recall) unless an alternative or assistive mechanism is offered;
paste is permitted into every credential and one-time-code field; one-time codes are
not split into single-character inputs; autocomplete tokens are declared
(`username`, `current-password`, `one-time-code`); MFA supports
`autocomplete="one-time-code"` and does not impose a time limit that loses entered
data (WCAG 2.2 SC 3.3.8).
Acceptance oracle: A DOM assertion on the sign-in and MFA routes confirms paste is not
blocked, no single-character OTP inputs exist, the three autocomplete tokens are
present, and no step requires transcription.
Required negative case: Blocking paste in the password field, or rendering one OTP
input per digit, must fail.

**VG-UI-064 — Manual assistive-technology validation is an external human gate**
Requirement: Manual assistive-technology validation — screen reader (at least NVDA
with Firefox/Chrome and VoiceOver with Safari), keyboard-only operation, 200% zoom,
400% reflow, and a documented colour-vision-deficiency review — is performed and
signed by **named authorized human participants** (DOD-039). Until that sign-off
exists, every accessibility item that depends on lived use is `EXTERNAL_REQUIRED` and
the ship verdict cannot exceed `CONDITIONAL_EXTERNAL_GATES`. Automation cannot
satisfy, impersonate, or substitute for this gate.
Acceptance oracle: A signed record exists naming the participants, the assistive
technology and version, the date, the scenarios exercised, and every unresolved
finding with disposition; the verification accounting shows the affected items as
`EXTERNAL_REQUIRED` until then.
Required negative case: A generated or agent-authored "accessibility sign-off", or a
`PASS` status for a lived-use criterion derived from automated tool output, must be
rejected and recorded as a fabrication defect (DOD-027, DOD-039).

---

## 11. Trust and anti-dark-pattern rules

**VG-UI-065 — No false urgency or scarcity**
Requirement: The UI contains no fake urgency or scarcity: no countdown to an offer, no
"only N subjects can be processed", no artificial deadline, and no auto-escalating
severity styling on a `Deadline` (see VG-UI-037). Real deadlines state their
policy-derived date and source.
Acceptance oracle: A DOM and copy scan finds zero timer-driven offer elements and
zero scarcity phrasing on any route; real deadlines render date plus source.
Required negative case: A "expires in 04:59" banner on a subscription control must
fail the scan.

**VG-UI-066 — No pre-checked consent-shaped controls**
Requirement: Every consent-shaped control (disclosure acknowledgement, marketing
communication, data-sharing opt-in, analytics opt-in) renders unchecked and
unselected by default, is not bundled with a required action, and is not required to
complete a core task. The only default-accepted statements are factual notices with
no opt-out semantics.
Acceptance oracle: A first-render assertion on all routes confirms every
checkbox/radio with consent semantics is unchecked, and a form-submission assertion
confirms no core task is blocked when they remain unchecked.
Required negative case: A pre-checked "share my data with partners" control, or a
core task blocked by an unchecked marketing opt-in, must fail.

**VG-UI-067 — No success celebration for non-terminal states**
Requirement: No confetti, celebratory animation, "Success" banner, or equivalent
positive reinforcement renders for any state other than `VERIFIED_REMOVED`,
`SEARCH_DELISTED`, or `VERIFIED_NOT_PRESENT`, and none renders for
`REQUEST_SUBMITTED` or `ACKNOWLEDGED`. Where celebration renders, the state's
qualifier renders in the same region so the celebration cannot be read as a broader
claim.
Acceptance oracle: A DOM scan asserts no celebratory component instance on routes
rendering `DISCOVERED_CANDIDATE`, `MATCH_CONFIRMED`, `REQUEST_READY`,
`REQUEST_SUBMITTED`, `ACKNOWLEDGED`, `REAPPEARED`; where it renders, the qualifier is
present in the same region.
Required negative case: A "You're removed!" animation after a `REQUEST_SUBMITTED`
transition must fail.

**VG-UI-068 — Negative outcomes are never hidden or softened**
Requirement: `NOT_REMOVABLE` and `HUMAN_REQUIRED` are rendered at equal visual
prominence to positive outcomes, included by default in counts, lists, and exports,
never collapsed into an "other" bucket by default, and never removed from a
denominator to improve an apparent rate (SPEC-000 §7.6, VG-OBS-002).
Acceptance oracle: A default-view assertion confirms both outcomes are present with
their own labels and counts; a denominator-composition assertion confirms both are
accounted for in the population definition.
Required negative case: An "Other: 37" bucket that absorbs `NOT_REMOVABLE` rows by
default, or a denominator that drops them, must fail.

**VG-UI-069 — No marketing claim stronger than the evidence**
Requirement: No UI string, page title, meta description, email template reachable from
the UI, or empty state asserts a capability beyond what a current, executed
verification supports. Where a capability is not verified, the copy states the
verified scope or states that it is not available. The VG-UI-070 scope statement appears
in the subject portal footer on every `/portal` route.
Acceptance oracle: Each capability claim in the rendered copy resolves to a linked
requirement ID, a test ID, and an evidence digest in the claim-to-release traceability
record (SPEC-000 §10); claims with no resolvable evidence fail the gate.
Required negative case: The claim "We remove your data from the internet" must fail
both the copy-lint gate and the traceability resolution.

**VG-UI-070 — The service-scope statement is fixed, verbatim copy**
Requirement: The following statement is the only permitted service-scope summary, is
rendered verbatim on `/portal/limitations`, in the footer of every `/portal` route,
on `/admin/metrics`, and in the header of the removal-effectiveness dashboard, and is
covered by a copy-equality test:

> What VanishGraph does: it submits privacy removal requests through lawful channels,
> records what happened, and independently verifies the result at each Source.
> What VanishGraph cannot do: it cannot guarantee that a record is removed. It does
> not control what a Controller does after a request is accepted, it cannot remove
> copies held in backups or by other parties it did not check, and it does not act
> for anyone who is not a verified subject or an authorized dependent.

Acceptance oracle: The rendered string equals this block after whitespace
normalisation, on every route where it appears.
Required negative case: A paraphrased or shortened variant must fail the equality
test.

**VG-UI-071 — Exit and cancellation are always available**
Requirement: Every multi-step flow offers a non-punitive way to stop: cancel, sign
out, or revoke authority, reachable in at most two interactions, with no confirmation
pattern designed to discourage it, no "are you sure you want to lose your progress"
scare copy, and no requirement to contact support to stop.
Acceptance oracle: A step inventory confirms an exit affordance on every step of
onboarding, exposure review, appeal, and authority management; the affordance's
accessible name names the actual effect.
Required negative case: A flow whose only exit is a support contact form must fail.

**VG-UI-072 — No disguised advertising or cross-surface upsell in a case view**
Requirement: Case, exposure, evidence, and alert views contain no promotional
content, no upsell to a higher tier inside a truth-state region, no third-party
advertising, and no visual element that mimics a system control while performing a
commercial action.
Acceptance oracle: A rendered-content assertion finds zero promotional components in
the case, exposure, evidence, and alert regions, and every control's accessible name
matches its effect.
Required negative case: An "Upgrade to remove faster" button inside a
`RequestCase` header must fail.

---

## 12. Privacy by design in the browser

**VG-UI-073 — No PII in URLs, query strings, or fragments**
Requirement: PII rendered by the presentation layer (`CUSTOMER_PII`, `HIGH_RISK_PII`,
`IDENTITY_DOCUMENT`, `AUTH_SECRET` per SPEC-001 §2) never appears in a path, query
string, fragment, `history.state`, `document.title`, breadcrumb, or referrer-bearing
URL. Filters carry opaque identifiers only, and a filter value that is not allowlisted
is refused server-side.
Acceptance oracle: An instrumented crawl of every route with PII fixtures finds no
PII pattern in `location.href`, `history.state`, or `document.title`; the server
validator refuses non-allowlisted filter values.
Required negative case: A searchable case list that puts a subject name or email into
the query string must fail the crawl and be refused server-side.

**VG-UI-074 — Browser-side redaction with explicit reveal**
Requirement: `PiiRedactor` renders PII masked by default — identifiers by
last-four with the remainder replaced, documents hidden entirely — and reveals only
after an explicit user action, which is recorded as an audit event (actor, artifact,
field, timestamp). Automatically revealed PII, PII in an accessible name before
reveal, and PII in a `title` or `alt` attribute are prohibited.
Acceptance oracle: A DOM-text and accessibility-tree snapshot before reveal contains
no unmasked PII in text nodes, accessible names, `title`, `alt`, `aria-label`,
`data-*`, or serialized props; the audit sink holds one reveal event per action.
Required negative case: A server component serializing a full identifier into the
browser payload while rendering it masked must fail the payload inspection.

**VG-UI-075 — No PII in browser analytics or telemetry**
Requirement: Browser analytics, error reporting, session replay, and performance
beacons emit no PII, no artifact content, no `EvidenceDigest` payload content, and no
case, exposure, or subject identifiers beyond an allowlisted opaque ID class. Events
are named by a closed event catalogue; free-form strings are never emitted. Any
emitted value passes the DLP scrub class for its egress class
(VG-EGRESS-002).
Acceptance oracle: With seeded runtime canaries in every PII field, an egress capture
of all browser telemetry contains zero canary values; a closed-catalogue test rejects
an unlisted event name.
Required negative case: A seeded canary appearing in a browser error report, session
replay frame, or analytics parameter label must fail.

**VG-UI-076 — No third-party trackers on PII routes**
Requirement: Routes rendering subject PII (`/portal/**`, `/console/**`, `/admin/**`,
`/auditor/**`) load no third-party marketing, advertising, social, or session-replay
script, no third-party font or icon fetched at runtime, and no third-party iframe.
Content-Security-Policy restricts `script-src`, `style-src`, `font-src`, `img-src`,
and `frame-src` to the application origin plus an explicitly declared, reviewed
allowlist with no wildcard hosts. Forms post same-origin only.
Acceptance oracle: A request capture for every PII route lists all external origins;
the list equals the reviewed allowlist, and the delivered CSP header for those routes
contains no wildcard host and no `unsafe-eval`.
Required negative case: A session-replay or advertising script on `/portal`, or a CSP
containing `script-src *`, must fail the capture.

**VG-UI-077 — Session, timeout, and data-at-rest in the browser**
Requirement: Session tokens are held in `HttpOnly`, `Secure`, `SameSite=Lax`-or-stricter
cookies and are never readable by browser script; PII is never written to
`localStorage`, to a non-session cache, or to an unencrypted browser store; the idle
timeout defaults to 15 minutes with the §9 warning; sign-out clears session-scoped
browser state, cancels in-flight requests, clears any PII-bearing clipboard content
the application placed, and invalidates the server session; the browser back button
after sign-out never renders cached PII (no-store on PII responses).
Acceptance oracle: After sign-out and a back-navigation attempt, the route renders
the re-authentication state with zero PII in the DOM, `localStorage` holds no PII,
and `document.cookie` exposes no session token; a `Cache-Control` assertion confirms
`no-store` on PII responses.
Required negative case: A token readable by browser script, PII in `localStorage`, or
a back-navigation rendering a cached case must fail.

**VG-UI-078 — Redaction state is disclosed, not implied**
Requirement: Where an `EvidenceArtifact` has been redacted (DLP scrub,
`redactionState`), the viewer states that redaction occurred, names what class was
redacted, and states that the digest covers the stored artifact as redacted. The UI
never presents a redacted artifact as the original.
Acceptance oracle: A redacted fixture renders the disclosure, the redacted class
name, and the digest-of-stored-artifact statement.
Required negative case: Presenting a redacted artifact with no redaction disclosure
must fail.

**VG-UI-079 — No PII persistence outside the case boundary**
Requirement: The UI stores no PII in browser history, autofill-exposed hidden fields,
`sessionStorage` beyond the active session, service-worker caches, or the clipboard
beyond an explicit user copy of a digest. Copying an `EvidenceDigest` copies only the
digest.
Acceptance oracle: After a full session walkthrough, an inspection of
`sessionStorage`, history entries, service-worker caches, and clipboard content finds
no PII and no case-identifying content other than an explicitly copied digest.
Required negative case: A copy control that places artifact content on the clipboard
must fail the inspection.

---

## 13. Requirement index

All 83 requirements are enumerated here, including the four gate requirements defined
in §14.

| ID | Title | Group |
|---|---|---|
| VG-UI-001 | Surface jobs owned by their surface | Surfaces |
| VG-UI-002 | Auditors cannot write | Surfaces |
| VG-UI-003 | Tenant isolation | Surfaces |
| VG-UI-004 | Surface shell and declared routes | Surfaces |
| VG-UI-005 | Opaque route parameters | Surfaces |
| VG-UI-006 | Server-side subject-scope resolution | Surfaces |
| VG-UI-007 | One canonical truth-state mapping | Truth presentation |
| VG-UI-008 | Vocabulary conformance in strings and identifiers | Truth presentation |
| VG-UI-009 | Exact labels and machine values | Truth presentation |
| VG-UI-010 | Qualifiers never hidden | Truth presentation |
| VG-UI-011 | `REQUEST_SUBMITTED` ≠ removal | Truth presentation |
| VG-UI-012 | `ACKNOWLEDGED` ≠ deleted | Truth presentation |
| VG-UI-013 | `SEARCH_DELISTED` distinct from Source removal | Truth presentation |
| VG-UI-014 | `VERIFIED_NOT_PRESENT` shows coverage bounds | Truth presentation |
| VG-UI-015 | `HUMAN_REQUIRED` is a legitimate outcome | Truth presentation |
| VG-UI-016 | `NOT_REMOVABLE` is a legitimate outcome | Truth presentation |
| VG-UI-017 | `CoveragePanel` is the only coverage presentation | Coverage honesty |
| VG-UI-018 | Denominators accompany every percentage | Coverage honesty |
| VG-UI-019 | Confidence shown with basis | Coverage honesty |
| VG-UI-020 | No universal or permanent removal claim | Coverage honesty |
| VG-UI-021 | Request count ≠ removal count | Coverage honesty |
| VG-UI-022 | Partial coverage labelled above content | Coverage honesty |
| VG-UI-023 | Onboarding states authority before data | Subject portal |
| VG-UI-024 | Pre-authority disclosure, no pre-selection | Subject portal |
| VG-UI-025 | Authority verification display | Subject portal |
| VG-UI-026 | Authorized-agent path requires signed evidence | Subject portal |
| VG-UI-027 | Authority revocation in the UI | Subject portal |
| VG-UI-028 | Scope boundary stated and enforced | Subject portal |
| VG-UI-029 | Exposure provenance, basis, thresholds | Exposure review |
| VG-UI-030 | `HumanMatchConfirmAffordance` is the only match-confirmation control | Exposure review |
| VG-UI-031 | Rejection routes to `VERIFIED_NOT_PRESENT` | Exposure review |
| VG-UI-032 | No bulk confirmation of ambiguous matches | Exposure review |
| VG-UI-033 | Quarantine states visible | Exposure review |
| VG-UI-034 | Timeline renders append-only audit as history | Case detail and evidence |
| VG-UI-035 | Timeline offers no edit, delete, or reorder | Case detail and evidence |
| VG-UI-036 | State changes legible as transitions | Case detail and evidence |
| VG-UI-037 | Deadlines are dates, not urgency | Case detail and evidence |
| VG-UI-038 | Evidence digest and immutability shown | Case detail and evidence |
| VG-UI-039 | Sensitive artifact disclosure is explicit | Case detail and evidence |
| VG-UI-040 | Evidence exposure is bounded | Case detail and evidence |
| VG-UI-041 | Reappearance alerts only for true reappearances | Reappearance and appeal |
| VG-UI-042 | Re-removal preserves history | Reappearance and appeal |
| VG-UI-043 | Reappearance does not blame verification | Reappearance and appeal |
| VG-UI-044 | Appeal/escalation is human-gated | Reappearance and appeal |
| VG-UI-045 | Metric renders numerator, denominator, interval | Dashboard |
| VG-UI-046 | Conflated metrics impossible | Dashboard |
| VG-UI-047 | Dashboard states its limitations | Dashboard |
| VG-UI-048 | Loading state | State handling |
| VG-UI-049 | Empty state | State handling |
| VG-UI-050 | Partial-coverage state | State handling |
| VG-UI-051 | Error state | State handling |
| VG-UI-052 | Access-denied state | State handling |
| VG-UI-053 | Human-gate state | State handling |
| VG-UI-054 | Session-expiry state | State handling |
| VG-UI-055 | Console queue renders the six-state treatment | State handling |
| VG-UI-056 | WCAG 2.2 AA binding; no conformance claimed | Accessibility |
| VG-UI-057 | Truth state never colour-only | Accessibility |
| VG-UI-058 | Contrast thresholds | Accessibility |
| VG-UI-059 | Focus management | Accessibility |
| VG-UI-060 | Full keyboard operation | Accessibility |
| VG-UI-061 | Screen-reader semantics for timeline and status | Accessibility |
| VG-UI-062 | Reduced motion | Accessibility |
| VG-UI-063 | Accessible authentication | Accessibility |
| VG-UI-064 | Manual AT validation is an external human gate | Accessibility |
| VG-UI-065 | No false urgency or scarcity | Trust and anti-dark-pattern |
| VG-UI-066 | No pre-checked consent-shaped controls | Trust and anti-dark-pattern |
| VG-UI-067 | No celebration for non-terminal states | Trust and anti-dark-pattern |
| VG-UI-068 | Negative outcomes never hidden | Trust and anti-dark-pattern |
| VG-UI-069 | No claim stronger than the evidence | Trust and anti-dark-pattern |
| VG-UI-070 | Fixed service-scope statement | Trust and anti-dark-pattern |
| VG-UI-071 | Exit and cancellation always available | Trust and anti-dark-pattern |
| VG-UI-072 | No advertising or upsell in case views | Trust and anti-dark-pattern |
| VG-UI-073 | No PII in URLs or query strings | Browser privacy |
| VG-UI-074 | Browser-side redaction with explicit reveal | Browser privacy |
| VG-UI-075 | No PII in analytics or telemetry | Browser privacy |
| VG-UI-076 | No third-party trackers on PII routes | Browser privacy |
| VG-UI-077 | Session, timeout, and browser data | Browser privacy |
| VG-UI-078 | Redaction state disclosed | Browser privacy |
| VG-UI-079 | No PII persistence outside the case boundary | Browser privacy |
| VG-UI-080 | Copy-lint gate is fail-closed over built output | Gate configuration |
| VG-UI-081 | Forbidden token list (normative) | Gate configuration |
| VG-UI-082 | Permanent claim list (normative) | Gate configuration |
| VG-UI-083 | PII pattern set (normative) | Gate configuration |

**Total: 83 requirements, VG-UI-001 … VG-UI-083** (the §14 gate requirements
`VG-UI-080` … `VG-UI-083` are listed here for completeness; `VG-UI-084` …
`VG-UI-094` are reserved and unused per §15.3).

---

## 14. Copy-lint, vocabulary, and PII-pattern gates

Requirements VG-UI-080 … VG-UI-083 define the gates that enforce §2, §3, §11, and §12
mechanically. They are indexed in §13.

**VG-UI-080 — The gate is fail-closed and runs over built output**
Requirement: The copy-lint and vocabulary gate runs over the built browser bundle,
server-rendered HTML for every declared route, the route manifest, and every
message template reachable from the UI. It exits non-zero on any unallowlisted hit
and names the file, line, and matched token. Allowlist entries carry an owner and a
reason; an entry with no reason fails the gate's own self-test.
Acceptance oracle: The gate is invoked by a new entry added to `COMMANDS.md` (per
`AGENTS.md`, agents may not invent commands, so the command name is added to
`COMMANDS.md` before it is used) and by `python3 scripts/anti-gaming-scan.py .`. It
exits 0 on a clean tree and non-zero with a named hit when a forbidden token or
permanent claim is injected; the allowlist self-test fails on an entry lacking a
reason.
Required negative case: A gate with `continue-on-error`, a swallowed non-zero exit, or
an empty-scan pass on zero files must be recorded as a masking defect (DOD-024,
DOD-007).

**VG-UI-081 — Forbidden token list (normative)**
Requirement: The gate's forbidden list contains, at minimum: `client`, `target`,
`victim`, `user_profile`, `consent` (as an `AuthorityGrant` synonym), `permission`
(as an `AuthorityGrant` synonym), `site`, `vendor`, `provider` (as a `Source`
synonym), `scraper`, `script`, `bot`, `automation` (as a `RemovalRecipe` synonym),
`hit`, `listing`, `result`, `lead` (as a `SourceRecord` synonym), `match`, `finding`,
`compromise` (as an `Exposure` synonym), `score`, `probability`, `certainty` (as a
`Confidence` synonym), `ruling`, `verdict`, `ticket`, `job`, `task` (as a
`RequestCase` synonym), `request`, `submission` (as an `ExternalAction` synonym),
`dedupe_key`, `nonce`, `check`, `recheck`, `confirmation` (as a
`VerificationObservation` synonym), `relapse`, `regression` (as a `Reappearance`
synonym), `attachment`, `file`, `screenshot` (as an `EvidenceArtifact` synonym),
`broker`, `company`, `entity` (as a `Controller` synonym), `blocker`,
`captcha_wall` (as a `HumanGate` synonym), `sanitizer`, `cleaner` (as a `DLP`
synonym), and the ad-hoc status tokens `DONE`, `COMPLETE`, `SUCCESS`, `REMOVED` as
status values.
Acceptance oracle: Injecting each token into a component name, a `data-*` hook, and a
visible string each produces a distinct non-zero gate result with a named location;
the allowlist holds exactly two entries (the `PermissionClass` value object and the
`provider-permitted` / `ProviderTransportRun` compounds in §0.3), each with an owner
and a reason.
Required negative case: A gate whose match set omits any listed token must fail its own
fixture-based self-test built from this list.

**VG-UI-082 — Permanent claim list (normative)**
Requirement: The gate's permanent-claim list contains, at minimum, these
case-insensitive phrases: `removed from the internet`, `delete you from the
internet`, `permanently deleted`, `permanent deletion`, `deleted everywhere`,
`erased from the web`, `guaranteed removal`, `guaranteed deleted`, `100% removed`,
`fully removed`, `completely removed`, `removed from all sites`,
`removed from all sources`, `we delete your data`, `gone forever`, and
`never comes back`.
Acceptance oracle: Injecting each phrase into a heading, a `<title>`, a meta
description, an empty state, and a message template each produces a non-zero gate
result.
Required negative case: A gate that only scans visible body text and misses metadata
or templates must fail.

**VG-UI-083 — PII pattern set (normative)**
Requirement: The set of patterns a value must be tested against before it may appear in
a URL, query string, fragment, `history.state`, `document.title`, breadcrumb, telemetry
event, analytics parameter, DOM attribute, or export filename is defined here and
nowhere else. At minimum it covers: (a) email addresses; (b) telephone numbers in
E.164 and common national formats; (c) government identifier shapes configured per
supported jurisdiction; (d) postal addresses containing a street number plus a street
name; (e) full personal names matched against the subject's `Alias` values, including
case-folded and diacritic-folded forms; (f) dates of birth in numeric and long forms;
(g) any `Identifier` value held for a subject, matched against the encrypted store by
digest comparison rather than by plaintext scan; (h) any value already recorded as
`EvidenceArtifact` content. A match is a defect, not a warning.
Acceptance oracle: A fixture set with one valid example per pattern class is passed to
the URL builder, the telemetry emitter, and the attribute writer; every class is
detected and refused, and the fixture set itself is asserted to cover all eight
classes (a missing class fails the self-test).
Required negative case: A pattern set that misses case-folded alias forms, or that scans
only plaintext instead of digest-comparing `Identifier` values, must fail its own
coverage self-test.

---

## 15. Traceability, dependencies, and conflicts

### 15.1 Upstream dependencies

| This spec | Depends on | Nature |
|---|---|---|
| VG-UI-001 … VG-UI-006 | SPEC-005 (auth/permissions — currently a stub), SPEC-003 (API contracts — currently a stub) | Role model and route contracts are not yet normative; UI work on `/console`, `/admin`, `/auditor` is `BLOCKED_PREREQUISITE` until they are |
| VG-UI-007 … VG-UI-016 | SPEC-000 §4, §5, §5.1 | Canonical token set and non-collapse rules |
| VG-UI-013, VG-UI-045, VG-UI-046 | `REMOVAL_EFFECTIVENESS_METRICS.md`, VG-OBS-002 | Metric definition and denominator |
| VG-UI-017 … VG-UI-022, VG-UI-049, VG-UI-050 | VG-DISC-002, SPEC-000 §7 | Coverage reporting contract |
| VG-UI-023 … VG-UI-028 | VG-IDENT-001, VG-AUTHZ-001, VG-AUTHZ-002, VG-AUTHZ-003, VG-POLICY-004 | Authority and identity verification |
| VG-UI-029 … VG-UI-033 | VG-IDENT-003, VG-IDENT-004, VG-SEC-001, SPEC-001 T3/T4 | Match assessment and taint |
| VG-UI-034 … VG-UI-040 | VG-EVIDENCE-001, VG-EVIDENCE-002, VG-EVIDENCE-003, SPEC-001 §3.4–3.5 | Evidence and audit model |
| VG-UI-041 … VG-UI-044 | VG-REAPPEAR-001, VG-REAPPEAR-002, VG-CHANNEL-001 #7, VG-POLICY-001 | Reappearance and escalation |
| VG-UI-056 … VG-UI-064 | DOD-039, `CAPABILITY_MATRIX.md` | External human gate |
| VG-UI-073 … VG-UI-079, VG-UI-083 | VG-EGRESS-001, VG-EGRESS-002, `DATA_EGRESS_MATRIX.md`, VG-TENANT-001 | Egress and tenancy |
| VG-UI-080 … VG-UI-083 | DOD-024, DOD-007, SPEC-000 §4 | Gate integrity |

### 15.2 Conflicts found against SPEC-000 and SPEC-001

No requirement in this document weakens, reinterprets, or contradicts SPEC-000 or
SPEC-001. Three items are recorded for completeness because they are the places a
conflict would most plausibly be introduced:

1. **`PermissionClass` / "permission".** SPEC-000 §4 forbids `permission` as a
   synonym for `AuthorityGrant`, while SPEC-001 §2 defines the `PermissionClass`
   value object with members `READ_ONLY`, `WRITE_PERMITTED`, `WRITE_UNCLEAR`,
   `PROHIBITED`. This is not a contradiction: the value object is a `Source`
   property, not an authority concept. Resolved by the explicit allowlist in §0.3 and
   VG-UI-008. **No source text was changed.**
2. **"provider" in `provider-permitted` and `ProviderTransportRun`.** SPEC-000 §4
   forbids `provider` as a synonym for `Source`, while SPEC-000 §1 and SPEC-001 §3.5
   use those two exact compounds. Resolved by the same allowlist; the bare noun
   remains forbidden for `Source` in UI copy. **No source text was changed.**
3. **Dashboard metric naming.** SPEC-000 §7.6 and VG-OBS-002 require
   `NOT_REMOVABLE` and `HUMAN_REQUIRED` to be visible and not hidden, while the
   primary metric's denominator is "eligible confirmed matches". These are compatible
   only if both outcomes are reported in the denominator's composition rather than as
   numerator contributions; VG-UI-045 and VG-UI-068 bind that reading. **This is an
   interpretation, and if the metric definition is ever restated, SPEC-000 wins.**

No ID collision exists: `VG-UI-*` did not previously appear anywhere in the
repository. IDs `VG-UI-001 … VG-UI-083` are used here — §13's catalogue enumerates
`VG-UI-001 … VG-UI-079` and §14 adds `VG-UI-080`, `VG-UI-081`, `VG-UI-082`, and
`VG-UI-083`, for a total of 83 — and `VG-UI-084 … VG-UI-094` remain reserved.

### 15.3 Reserved-but-unused IDs

`VG-UI-084` … `VG-UI-094` are reserved and intentionally unimplemented. They are not
requirements, carry no oracle, and must not be cited as requirements until this file
assigns them.

---

## 16. Acceptance for this specification

This specification is satisfied only when, for the presentation layer alone and with
executed evidence from the current candidate epoch (SPEC-000 §9):

1. All 83 requirement rows resolve to a test ID, a command, an observed sentinel or
   exit code, an artifact digest, and an evidence path.
2. The `TruthStateBadge` matrix test proves all eleven states render the §2.2 copy,
   the §2.3 machine value and group, and the mandatory qualifier.
3. Each of VG-UI-031's and VG-UI-068's negative cases is demonstrated by a mutation
   that makes at least one test fail (DOD-018).
4. The copy-lint and vocabulary gate of §14 passes over built output and fails on an
   injected forbidden token and an injected permanent claim.
5. Automated accessibility checks run with recorded tool versions and rule sets, and
   their results are reported as a partial input — never as conformance.
6. Every accessibility item that depends on lived use remains `EXTERNAL_REQUIRED`
   until VG-UI-064 is signed by named authorized human participants.
7. No screen, test, screenshot, or measurement is claimed in this document or derived
   from it without executed evidence.
