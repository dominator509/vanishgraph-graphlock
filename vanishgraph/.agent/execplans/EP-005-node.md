NODE-META-BEGIN
ID: EP-005
DEPS: EP-004
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/ep005-gate.sh
VERIFY_SENTINEL: ep005 ui gate: ok
GREEN_TAG: green/EP-005
NODE-META-END

# EP-005 — UI / Client

## 1. Purpose / Big Picture

Build the four SPEC-004 surfaces — Subject portal (`/portal`), Operations console
(`/console`), Tenant admin console (`/admin`), Auditor view (`/auditor`) — as a real
Next.js/React application that consumes the EP-004 `/v1` contract and **cannot tell a
comfortable lie about removal**.

The product risk this node exists to close is specific and well documented in the
category: a privacy-removal service that renders "removed" for a submitted request is
not merely inaccurate, it is the mechanism by which the whole evidence-first thesis
becomes decorative. SPEC-000 §5.1 and SPEC-004 §2 therefore make the presentation layer
a safety surface, not a styling exercise:

- `REQUEST_SUBMITTED` must never read as removal. Its label is
  **"Submitted — outcome unknown"** and its mandatory qualifier says
  "This is not removal."
- `ACKNOWLEDGED` must never read as deleted. Its label is **"Acknowledged — not
  deleted"** and its qualifier says a claim is not an observation.
- `SEARCH_DELISTED` must never merge with source deletion. It renders its own glyph
  (`≁`) and its own unit with its own denominator.
- `VERIFIED_NOT_PRESENT` must always display its coverage bounds, and the phrase
  "not found" never appears without them.
- No percentage ever appears without its denominator, and `0 / 0` renders
  **"0 / 0 — not computable"**, never `0%` and never `NaN`.

At the end of this node a reviewer can open any surface and check whether the interface
is telling the truth, because the truth vocabulary is mapped once, tested for byte
equality against the specification, and gated on the built output.

**Honest boundary, stated before any milestone.** Two things in this node cannot be
finished by an agent and are not written as if they can:

1. **Manual assistive-technology validation (VG-UI-064, DOD-039) is
   `EXTERNAL_REQUIRED`.** Screen-reader, keyboard-only, 200%/400% reflow, and
   colour-vision-deficiency review must be performed and signed by named authorized
   human participants. Automated accessibility tooling is a *necessary but
   insufficient* input (VG-UI-056); WCAG 2.2 AA conformance is **not claimed** by this
   node, and no generated or agent-authored "accessibility sign-off" may exist
   (VG-UI-064 negative case).
2. **Real-data E2E is `BLOCKED_CREDENTIALS`/`BLOCKED_PREREQUISITE`.** `DATABASE_URL`
   (EP-003, unstarted) and `KEYCLOAK_ISSUER` are `REQUIRED` in `PREFLIGHT.md` and
   unprovisioned. Surfaces can be built, server-rendered, and tested against typed
   fixtures and against the real `/v1` boundary in-process; the "golden path on a real
   database with a real session" proof is recorded as blocked, not simulated.

## 2. Scope

In scope:

- The Next.js/React application shell, its build, and its route manifest for the 24
  declared routes of SPEC-004 §1.
- The canonical eleven-token truth-state module and `TruthStateBadge` /
  `StateQualifier` / `TruthTimeline` components with the §2.3 colour tokens, glyphs,
  and `data-truth-group` values.
- Coverage honesty presentation: `CoveragePanel` / `CoverageSummaryInline`,
  `MetricFigure`, confidence-with-basis, and the partial-coverage banner.
- The subject portal routes and flows (onboarding stepper, authority management,
  exposure review, case detail + timeline, evidence viewer, reappearance alerts,
  appeal/escalation request, limitations page).
- The operations console routes and flows (queue, case work, match review inside the
  `HumanGate`, `HUMAN_REQUIRED` triage, recipe/source freshness, coverage reports).
- The tenant admin console routes (tenant settings, jurisdiction policy assignment,
  authority issue/revoke, catalogue and recipe enablement, users and roles, metrics).
- The auditor view, strictly read-only, with claim → requirement → case → artifact →
  digest resolution.
- The seven state treatments for every data-bearing region (loading, empty,
  partial-coverage, error, access-denied, human-gate, session-expiry).
- Automated accessibility checks (WCAG 2.2 AA rulesets), with results reported as
  partial input only.
- Browser privacy: no PII in URLs, masked-by-default rendering with explicit audited
  reveal, no third-party trackers on PII routes, no PII in browser telemetry, session
  handling with `HttpOnly`/`Secure`/`SameSite` cookies.
- The copy-lint / vocabulary / permanent-claim / PII-pattern gate over built output.
- Additions to `COMMANDS.md` for every new command this node introduces.

## 3. Non-goals

- **No truth-state mutation control on any surface.** Transitions occur only through
  domain commands reached via `/v1`. A "Mark as removed", "Confirm deletion", or
  "Force verify" control is a defect on every surface, including for administrators
  (VG-UI-001, SPEC-001 §4.3 SM-6).
- **No `/v1` route changes.** This node consumes the EP-004 contract. If a surface needs
  data the contract does not expose, the correct action is to stop and record the gap —
  not to add a route here, and not to reach around the API to a database.
- **No domain or adapter import from the UI.** The UI imports application contracts
  only (`ARCHITECTURE.md` code law, SPEC-004 §0.3).
- **No second status vocabulary.** No browser-side enum, no `friendlyStatus`, no
  per-screen label override, no locale string that rewrites a qualifier (VG-UI-007).
- **No marketing copy.** No claim stronger than executed evidence, no permanent-removal
  phrasing anywhere including page titles, meta descriptions, empty states, and message
  templates (VG-UI-020, VG-UI-069, VG-UI-082).
- **No advertising, upsell, false urgency, or pre-checked consent-shaped control**
  (VG-UI-065, VG-UI-066, VG-UI-072).
- **No accessibility conformance claim.** Automated tooling output is reported as
  partial input; the lived-use gate is `EXTERNAL_REQUIRED` (VG-UI-056, VG-UI-064).
- **No analytics, session replay, or third-party runtime fetch on PII routes**
  (VG-UI-075, VG-UI-076).
- No production deployment (VG-SCOPE-009, ADR-005).

## 4. Context and Orientation

**Repository reality, as of this plan.** Do not overstate it:

| Element | Real state |
|---|---|
| UI source | **Does not exist.** No `src/ui`, `app/`, `pages/`, `components/`, or Next.js config anywhere. |
| `package.json` | Two devDependencies. **No React, no Next.js, no Playwright, no axe-core.** |
| EP-004 (API) | ExecPlan authored; **not executed.** The `/v1` contract is specified (SPEC-003) but no route exists. |
| EP-003 (persistence) | **Largely unstarted**; `DATABASE_URL` unprovisioned. |
| `scripts/copy-lint-gate.sh` | Introduced by **EP-004 M8** (`copy lint gate: ok`). If EP-004 is incomplete it does not exist yet; see M2. |
| `scripts/verify.sh` | 15 mandated stages; `test-e2e.sh` is a loud-fail placeholder explicitly unblocked by **EP-005**. It prints `verify: ok` only when all fifteen genuinely pass. |
| `scripts/test-e2e.sh` | Loud-fail placeholder. This node gives it a real implementation that runs the browser suites against the **built** application, and fails closed (non-zero, no sentinel) when the browser runtime is unavailable. |
| Browser runtimes (Chromium/Firefox/WebKit) | Not verified present. M1 probes them and records the result honestly. |

**Cross-cutting reality that shapes the milestones.**

- SPEC-004 §1 declares **24 routes** across four surfaces. The route manifest is
  asserted as a **set equality in both directions** (VG-UI-004): an undeclared route
  must fail the manifest check, and a declared route that does not exist must fail too.
- SPEC-004 enumerates **83 requirements** (`VG-UI-001`…`VG-UI-083`), including four
  gate requirements in §14. Eleven truth states × several contexts × several region
  states is a large matrix; the milestones below build it in dependency order so that
  each one is independently closable.
- The four surfaces carry **conflicting vocabulary pressure**: the operations console
  wants terse professional labels, and terseness is exactly how "Submitted" becomes
  "Submitted for removal". The single canonical mapping (VG-UI-007) is the control, and
  `showQualifier` may only be `false` where `StateQualifier` renders immediately adjacent
  in the same container.
- Per SPEC-004 §15.1, the upstream specs it lists as "currently a stub" are now
  authored (SPEC-003, SPEC-005), so the `BLOCKED_PREREQUISITE` that clause contemplated
  for `/console`, `/admin`, and `/auditor` is **superseded** — but it is superseded by
  *specification*, not by *implementation*. The role model exists on paper (SPEC-005 §2,
  §5) and the routes exist on paper (SPEC-003 §5); the running services do not. Surfaces
  are therefore built against contracts and typed fixtures, with real-boundary proof
  recorded as blocked on EP-004/EP-006.

## 5. Files to Read First

Governance and law:

- `AGENTS.md`, `.agent/EXECUTION_RULES.md`, `.agent/PLANS.md`, `.agent/LOOPS.md`,
  `.agent/GRAPH.md`
- `.agent/DONE_LAW.md` — DOD-004, DOD-006, DOD-007, DOD-011, DOD-013, DOD-018, DOD-019,
  DOD-024, DOD-025, DOD-026, DOD-027, DOD-039
- `.agent/state/LEDGER.md`, `.agent/checklists/implementation.md`,
  `.agent/checklists/validation.md`
- `COMMANDS.md`

Specifications:

- `.agent/specs/SPEC-004-ui-ux.md` — **the whole of it**: §1 surfaces and the 24 routes,
  §2 truth-state presentation (2.2 copy table, 2.3 tokens, 2.4 component contract), §3
  coverage honesty, §4–§8 surface flows, §9 state handling, §10 accessibility, §11 trust
  and anti-dark-pattern, §12 browser privacy, §13 requirement index, §14 gate lists,
  §15 conflicts, §16 acceptance
- `.agent/specs/SPEC-000-product-scope.md` — §4 vocabulary lock, §5 truth model, §5.1
  non-collapse, §7 coverage honesty, §8 channel priority, §9 acceptance oracle, §11
  open human items
- `.agent/specs/SPEC-003-api-contracts.md` — §2 conventions, §5 route catalogue, §7 DTO
  rules, §8 error envelope (the UI renders `code`, `requestId`, `correlationId`,
  `retryable`)
- `.agent/specs/SPEC-005-auth-permissions.md` — §2 roles, §4 identity levels, §5
  authorization matrix, §6 step-up (the UI renders access-denied and human-gate states
  from these)
- `.agent/specs/SPEC-006-errors.md` — §2 classification (an outcome is not an error; the
  UI must not render it in an error region), §4.1 statuses
- `.agent/specs/SPEC-007-observability.md` — correlation ID display, redaction, egress
- `.agent/specs/SPEC-008-production-readiness.md` — §9 mandatory external gates (the AT
  gate), §13 honest status

Existing code and scripts:

- `src/domain/truth-state.ts`, `src/domain/values.ts` (read for the canonical eleven
  tokens and their non-collapse facts — do **not** import them from the UI)
- `package.json`, `tsconfig.json`, `tsconfig.build.json`
- `scripts/verify.sh`, `scripts/test-e2e.sh`, `scripts/copy-lint-gate.sh` (if present),
  `scripts/import-boundary.sh`, `scripts/ep004-gate.sh`, `scripts/lib/loud-fail.sh`
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt`

Project documents:

- `ARCHITECTURE.md`, `SECURITY.md`, `PREFLIGHT.md`, `.env.example`,
  `DATA_EGRESS_MATRIX.md`, `REMOVAL_EFFECTIVENESS_METRICS.md`, `TESTING.md`,
  `OBSERVABILITY.md`, `DECISIONS.md` (ADR-002 source/search separation)
- `PROJECT_RESEARCH_BRIEF.md` §2 (the market's coverage-claim language this product must
  not imitate)
- `.agent/verification/GRAPH.md`,
  `.agent/verification/stage-plans/V-015-usability-accessibility-dx-visual-docs.md`,
  `.agent/verification/reports/RESIDUAL_RISK_AND_EXTERNAL_GATES.md`

## 6. Expected Changed Files

Created:

- `src/ui/app/**` — the Next.js App Router tree for the 24 declared routes.
- `src/ui/components/truth/**` — `TruthStateBadge.tsx`, `StateQualifier.tsx`,
  `TruthTimeline.tsx`.
- `src/ui/components/coverage/**` — `CoveragePanel.tsx`, `CoverageSummaryInline.tsx`,
  `MetricFigure.tsx`, `ConfidenceBasis.tsx`, `PartialCoverageBanner.tsx`.
- `src/ui/components/evidence/**` — `EvidenceViewer.tsx`, `DigestDisplay.tsx`,
  `RedactionDisclosure.tsx`, `PiiRedactor.tsx`.
- `src/ui/components/states/**` — `LoadingRegion.tsx`, `EmptyState.tsx`, `ErrorState.tsx`,
  `AccessDenied.tsx`, `HumanGateNotice.tsx`, `SessionExpiryNotice.tsx`.
- `src/ui/components/scope/**` — `ServiceScopeStatement.tsx` (the verbatim VG-UI-070
  block).
- `src/ui/copy/truth-state.ts` — **the single canonical mapping** (VG-UI-007).
- `src/ui/copy/service-scope.ts`, `src/ui/copy/catalogue.ts` — the closed copy catalogues.
- `src/ui/tokens/**` — the §2.3 CSS custom properties.
- `src/ui/lib/url.ts` — the only URL builder (no PII may enter a URL), and
  `src/ui/lib/telemetry.ts` — the closed event catalogue emitter.
- `src/ui/route-manifest.json` — the emitted manifest used by the equality check.
- `tests/contract/truth-state-copy.test.ts`, `tests/contract/route-manifest.test.ts`,
  `tests/contract/coverage-presentation.test.ts`, `tests/contract/vocabulary-ui.test.ts`,
  `tests/contract/pii-url.test.ts`, `tests/contract/portal-surfaces.test.ts`,
  `tests/contract/surface-ownership.test.ts`, `tests/contract/auditor-readonly.test.ts`.
- `tests/ui/**` — Playwright + axe-core suites (browser-runtime dependent).
- `scripts/ep005-gate.sh` — this node's gate.
- `playwright.config.ts`, `next.config.mjs`, `postcss.config.mjs`.
- `.agent/evidence/EP-005/**`.

Modified:

- `package.json`, `package-lock.json` — pinned `next`, `react`, `react-dom`,
  `@playwright/test`, `axe-core`, `@axe-core/playwright`.
- `COMMANDS.md` — every command this node introduces, with its sentinel.
- `scripts/test-e2e.sh` — real implementation replacing the loud-fail placeholder.
- `scripts/import-boundary.sh` — add the `src/ui/**` rule.
- `tsconfig.ui.json` (created) — JSX settings; keep the strict flags.
- `ARCHITECTURE.md`, `ASSUMPTIONS.md`, `TESTING.md`.
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt`.
- `.agent/state/LEDGER.md`.

Nothing else may change. Any other diff is a scope violation.

## 7. Interfaces and Contracts

**Truth-state presentation contract (SPEC-004 §2.2) — exact copy.** These strings are
normative. Labels are rendered verbatim and are never abbreviated, iconified without
their text, pluralised, re-capitalised, or replaced by a synonym. Qualifiers render
immediately adjacent to the label, in the same reading order, never inside a tooltip,
popover, disclosure widget, or truncated text, and are never replaced by an info icon
alone (VG-UI-009, VG-UI-010).

| `data-truth-state` | Label | Mandatory qualifier (`StateQualifier`, exact copy) | `data-truth-group` | Glyph | Token |
|---|---|---|---|---|---|
| `DISCOVERED_CANDIDATE` | Discovered — not yet confirmed as you | A record was found that may relate to you. Subject identity is not confirmed, and removal has not been assessed. | `uncounted` | `◇` | `--vg-state-candidate` |
| `MATCH_CONFIRMED` | Confirmed as you | Recorded evidence supports that this record is about you. This does not mean removal is possible or lawful. | `uncounted` | `◆` | `--vg-state-confirmed` |
| `REQUEST_READY` | Ready to submit | Authority, a policy decision, and a current RemovalRecipe all exist. No external action has occurred yet. | `uncounted` | `◐` | `--vg-state-ready` |
| `REQUEST_SUBMITTED` | Submitted — outcome unknown | A channel accepted the action. This does not mean the Controller received it, read it, or will act. This is not removal. | `uncounted` | `↑` | `--vg-state-submitted` |
| `ACKNOWLEDGED` | Acknowledged — not deleted | The Controller or Source responded acknowledging the request. This does not mean deletion occurred. | `uncounted` | `✓` | `--vg-state-acknowledged` |
| `VERIFIED_REMOVED` | Verified not found at this Source | Independent re-observation did not find this record at this Source, by the method the RemovalRecipe requires, within the observation window shown. This does not cover backups, downstream copies, or other Sources. | `verified` | `~` | `--vg-state-verified` |
| `SEARCH_DELISTED` | Delisted from search results | A search engine no longer returns this result. The page at the Source has not been shown to be removed. Search and Source are separate effects. | `verified` | `≁` | `--vg-state-delisted` |
| `VERIFIED_NOT_PRESENT` | Not found in the coverage checked | A valid scan observed no confirmed listing. Coverage was partial: what was and was not checked is shown with this result. This does not mean the record never existed or does not exist outside the checked scope. | `verified` | `∅` | `--vg-state-absent` |
| `NOT_REMOVABLE` | Not removable — lawful limit | A lawful, public-interest, or technical limit prevents removal, with the recorded basis shown. This is a final outcome, not a failure, and not an unfinished attempt. | `forbidden` | `⊘` | `--vg-state-notremovable` |
| `HUMAN_REQUIRED` | Human step required | A legitimate human, identity, legal, or provider-permitted gate blocks automation. This is a normal outcome, not a defect or an error. | `action` | `☖` | `--vg-state-human` |
| `REAPPEARED` | Appeared again | This exposure was independently verified as not found and has since been observed again. The earlier verification was not necessarily wrong; it was accurate for its scope and window. | `reopened` | `↻` | `--vg-state-reappeared` |

Group semantics that must not be conflated: `verified` = independently observed effects;
`uncounted` = in-flight or unverified steps that must never enter a success metric;
`reopened` = `REAPPEARED`; `forbidden` and `action` = the two legitimate non-automatable
outcomes. Border hues and tint fills are the SPEC-004 §2.3 values; text colour is always
`--vg-ink-900` so label contrast does not depend on a per-state pairing.

**`TruthStateBadge` component contract (SPEC-004 §2.4).**

| Prop | Type | Rule |
|---|---|---|
| `state` | the eleven-member union | Required. No `string` overload exists. |
| `scope` | `{ sourceId?: SourceId; windowDays?: number; checkedAt?: string }` | Required for `VERIFIED_REMOVED`, `VERIFIED_NOT_PRESENT`, `SEARCH_DELISTED`; renders as a scope suffix inside the label. |
| `variant` | `'badge' \| 'block'` | `badge` for lists, `block` for detail headers. |
| `showQualifier` | boolean, default `true` | `false` permitted only where `StateQualifier` renders immediately adjacent in the same container. |

Rendered output contract — all three channels mandatory (label text, unique glyph, and
machine value, VG-UI-057):

```html
<span data-truth-state="VERIFIED_REMOVED" data-truth-group="verified"
      class="vg-truth-badge vg-truth-badge--verified">
  <span class="vg-truth-badge__glyph" aria-hidden="true">~</span>
  <span class="vg-truth-badge__label">Verified not found at this Source · Source: EXAMPLE_BROKER · window 30d</span>
  <span class="vg-truth-badge__machine">VERIFIED_REMOVED</span>
</span>
```

The machine value renders visually in a monospace face so a reader can cross-check the
exact token. Paraphrase drift is a defect.

**Coverage honesty contract (SPEC-004 §3, SPEC-000 §7).**

- `CoveragePanel` (or `CoverageSummaryInline`) is the **only** coverage renderer and
  always renders `sources_attempted`, `sources_total`, the declared catalogue version,
  the run window, and the count of skipped Sources with a control revealing each skipped
  Source and its reason (VG-UI-017).
- Every percentage or ratio renders as `<num> / <denom> (<pct>)` in a single
  `MetricFigure` unit with a denominator label. A zero denominator renders
  `0 / 0 — not computable` — not `0%`, not `NaN` (VG-UI-018).
- `Confidence` always renders as a 0.00–1.00 decimal together with its recorded `basis[]`
  (feature name plus contribution) and the policy threshold applied. A bare percentage
  is a defect (VG-UI-019).
- Partial coverage renders a persistent banner **above** the affected content and marks
  affected rows; no absence statement renders unqualified (VG-UI-022, VG-UI-050).

**Seven region states (SPEC-004 §9).** Loading (dimension-preserving skeleton,
`aria-hidden`, one polite live region, delayed state at 10 s with a cancel control);
Empty (names what was searched, over what coverage, in what window, and one next
action); Partial-coverage (banner + row markers + skipped list); Error (names the failed
operation, shows a selectable `correlationId`, states retryability, offers retry only
where idempotent under VG-ACTION-001, `role="alert"`); Access-denied (distinct state,
names the required role conceptually, states the attempt was recorded, renders **zero**
fields from the denied resource); Human-gate (`HumanGateNotice` naming gate kind, who
must act, what happens after, what has been recorded — and no bypass, solver, or skip
control); Session-expiry (warning 120 s before expiry, keyboard-operable stay-signed-in
performing a real refresh, browser-held PII cleared on expiry).

**Fixed service-scope statement (SPEC-004 VG-UI-070) — verbatim, the only permitted
service-scope summary.** Rendered on `/portal/limitations`, in the footer of every
`/portal` route, on `/admin/metrics`, and in the header of the removal-effectiveness
dashboard, covered by a copy-equality test:

> What VanishGraph does: it submits privacy removal requests through lawful channels,
> records what happened, and independently verifies the result at each Source.
> What VanishGraph cannot do: it cannot guarantee that a record is removed. It does
> not control what a Controller does after a request is accepted, it cannot remove
> copies held in backups or by other parties it did not check, and it does not act
> for anyone who is not a verified subject or an authorized dependent.

**Gate contract (SPEC-004 VG-UI-080/081/082/083).** The copy-lint/vocabulary gate runs
over the **built browser bundle**, the server-rendered HTML for every declared route, the
route manifest, and every message template reachable from the UI. It exits non-zero on
any unallowlisted hit and names file, line, and token. It fails on a zero-file scan, and
its allowlist self-test fails on an entry with no owner or reason. The permanent-claim
list is case-insensitive and includes at minimum: `removed from the internet`,
`delete you from the internet`, `permanently deleted`, `permanent deletion`,
`deleted everywhere`, `erased from the web`, `guaranteed removal`, `guaranteed deleted`,
`100% removed`, `fully removed`, `completely removed`, `removed from all sites`,
`removed from all sources`, `we delete your data`, `gone forever`, `never comes back`.
The PII pattern set covers eight classes: email addresses; telephone numbers in E.164 and
common national formats; government identifier shapes per supported jurisdiction; postal
addresses with street number plus street name; full personal names matched against the
subject's `Alias` values including case-folded and diacritic-folded forms; dates of birth
in numeric and long forms; any `Identifier` value matched by **digest comparison**
against the encrypted store rather than plaintext scan; and any value already recorded as
`EvidenceArtifact` content (VG-UI-083).

**Two vocabulary allowlists, exact (SPEC-004 §0.3).** `PermissionClass` (a `Source`
property, never a synonym for `AuthorityGrant`) and the compounds `provider-permitted`
and `ProviderTransportRun`. Bare *permission* and bare *provider* remain forbidden for
`AuthorityGrant` and `Source` respectively. An allowlist entry with no reason fails the
gate's own self-test.

**Accessibility contract (SPEC-004 §10).** Binding target WCAG 2.2 Level AA for all four
surfaces at 200% zoom and 320 CSS px width, in the two latest major releases of each
browser. Truth state is never encoded by colour alone (label text + unique glyph +
`data-truth-state` + `data-truth-group`). Body text ≥ 4.5:1, large text ≥ 3:1, non-text
state borders and focus indicators ≥ 3:1; state text always `--vg-ink-900` on the state
tint. Focus is visible and managed across route navigation, submit, modal close, and
region refresh. Every task is completable by keyboard alone. `TruthTimeline` is an
ordered list with per-row accessible names combining timestamp, actor, event, and state
label, with ordering exposed. Reduced motion disables non-essential animation. Accessible
authentication permits paste, does not split one-time codes, and declares
`username`/`current-password`/`one-time-code` autocomplete tokens. **No accessibility
requirement may be reported as passing on automated-tool output alone, and no
conformance claim may be made without the manual gate of VG-UI-064.**

## 8. Milestones

### M1: UI foundation, route manifest, and this node's gate

GOAL: A Next.js/React application builds from a pinned, locked dependency set; its route
tree emits a manifest that equals the 24 declared SPEC-004 §1 routes as a set in both
directions; and this node has a gate that genuinely fails when the UI contract suites
fail.

READ: `ARCHITECTURE.md`, `package.json`, `tsconfig.json`, `scripts/verify.sh`,
`scripts/test-e2e.sh`, `scripts/import-boundary.sh`, `scripts/ep004-gate.sh`,
`COMMANDS.md`, `PREFLIGHT.md`, `SPEC-004` §0.1/§0.3/§1, `SPEC-003` §2.1,
`.agent/DONE_LAW.md` DOD-007/DOD-024.

CHANGE: `package.json`, `package-lock.json`, `next.config.mjs`, `postcss.config.mjs`,
`playwright.config.ts`, `tsconfig.ui.json`, `src/ui/app/layout.tsx`,
`src/ui/app/not-found.tsx`, `src/ui/app/portal/page.tsx`,
`src/ui/app/console/queue/page.tsx`, `src/ui/app/admin/tenant/page.tsx`,
`src/ui/app/auditor/claims/page.tsx`, `src/ui/route-manifest.json`,
`tests/contract/route-manifest.test.ts`, `scripts/ep005-gate.sh`,
`scripts/test-e2e.sh`, `scripts/import-boundary.sh`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `COMMANDS.md`, `ARCHITECTURE.md`,
`ASSUMPTIONS.md`, `.agent/state/LEDGER.md`.

CONTENT:

1. `package.json` — add runtime dependencies pinned to exact versions (no `^`/`~`):
   `next`, `react`, `react-dom`; devDependencies `@playwright/test`, `axe-core`,
   `@axe-core/playwright`. Add scripts `build:web` (`next build`), `test:ui`
   (`playwright test`), `test:a11y` (the axe-only Playwright project). Record the
   resolved versions in `ARCHITECTURE.md` with the reason each is present.
2. `src/ui/app/not-found.tsx` — the not-found state for an undeclared route
   (VG-UI-004 negative case). It must not disclose whether a route exists.
3. `src/ui/route-manifest.json` — written by a post-build script that walks
   `src/ui/app/**/page.tsx` and derives the declared path. The manifest is compared, as a
   set in both directions, against the 24 rows of SPEC-004 §1, which the test parses from
   the specification file (do not hand-copy the list into the test; a hand-copied list
   drifts and stops being a check). The 24 declared routes are:
   `/portal`, `/portal/authority`, `/portal/onboarding`, `/portal/exposures`,
   `/portal/cases/[caseId]`, `/portal/cases/[caseId]/evidence/[evidenceId]`,
   `/portal/alerts`, `/portal/requests`, `/portal/limitations`,
   `/console/queue`, `/console/cases/[caseId]`, `/console/exposures/[exposureId]`,
   `/console/gates`, `/console/recipes`, `/console/coverage`,
   `/admin/tenant`, `/admin/policy`, `/admin/authority`, `/admin/catalog`,
   `/admin/users`, `/admin/metrics`,
   `/auditor/claims`, `/auditor/cases/[caseId]`, `/auditor/evidence/[evidenceId]`,
   `/auditor/exports`.
4. `scripts/import-boundary.sh` — add rule (c): `src/ui/**` may import only `node:*`,
   relative paths, the generated application-contract types the UI consumes, and the UI's
   own modules. It may **not** import `src/domain/**`, `src/adapters/**`, `src/http/**`,
   or `src/infrastructure/**`. Print `import boundary: ok` only when all four rules hold
   (the three from EP-004 M1 plus this one).
5. `scripts/test-e2e.sh` — replace the loud-fail body with a real runner that
   (a) requires a completed `next build` output, (b) checks the browser runtime,
   (c) runs `playwright test` against the **built** application, and (d) fails closed
   with `end-to-end tests: BLOCKED_ENVIRONMENT - <missing property>` and exit 1 when the
   browser runtime cannot be provisioned after a real attempt, or
   `end-to-end tests: FAIL - <reason>` when a suite genuinely fails. It prints
   `end-to-end tests: ok` only after the suites actually ran and passed against the built
   artefact. It must never run against a dev server and call that acceptance
   (SPEC-008 VG-SHIP-021/022), and it must never skip a suite to go green.
6. `scripts/ep005-gate.sh` — this node's gate. Real content:

```sh
#!/usr/bin/env sh
# EP-005 UI/client node gate.
#
# SCOPE, STATED HONESTLY: this gate verifies what can be verified without a
# provisioned browser runtime or a provisioned database: that the UI type-checks,
# that the layer import boundary holds, that the built route manifest equals the
# SPEC-004 declared route set, that the truth-state copy equals the SPEC-004 copy
# table, and that the credential-free contract suites pass. It does NOT verify
# lived-use accessibility, and it does NOT verify real-data flows. It says so in its
# own output on every run and never reports those as passing.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

[ -f src/ui/copy/truth-state.ts ] || { echo "ep005 ui gate: FAIL - canonical truth-state mapping is missing" >&2; exit 1; }
[ -f src/ui/route-manifest.json ] || { echo "ep005 ui gate: FAIL - route manifest is missing; run npm run build:web" >&2; exit 1; }

npx --no-install tsc -p tsconfig.ui.json --noEmit || { echo "ep005 ui gate: FAIL - UI typecheck failed" >&2; exit 1; }
sh scripts/import-boundary.sh || { echo "ep005 ui gate: FAIL - layer import boundary violated" >&2; exit 1; }

node --test "tests/contract/**/*.test.ts" || { echo "ep005 ui gate: FAIL - UI contract suites failed" >&2; exit 1; }

echo "ep005 ui gate: UNVERIFIED-BY-THIS-GATE:"
echo "  - browser-runtime suites (keyboard, screen-reader tree, reduced motion, zoom/reflow): run 'npm run test:ui'; BLOCKED_ENVIRONMENT until a browser runtime is provisioned"
echo "  - manual assistive-technology validation (VG-UI-064, DOD-039): EXTERNAL_REQUIRED, human participants only; automation cannot satisfy or substitute for this gate"
echo "  - real-data flows: BLOCKED_CREDENTIALS (DATABASE_URL, KEYCLOAK_ISSUER) and BLOCKED_PREREQUISITE (EP-003, EP-004)"

echo "ep005 ui gate: ok"
```

7. `COMMANDS.md` — add, each with its sentinel: `sh scripts/ep005-gate.sh`
   (`ep005 ui gate: ok`); `npm run build:web`; `npm run test:ui`; `npm run test:a11y`;
   `sh scripts/test-e2e.sh` (`end-to-end tests: ok`);
   `node --test "tests/contract/**/*.test.ts"` (the credential-free UI contract suites,
   which is what the node gate runs); `npx playwright --version` and
   `npx --no-install tsc -p tsconfig.ui.json --noEmit` (whose purpose is self-evident in
   the `RUN` blocks that use them). Also record `sh scripts/copy-lint-gate.sh`
   (`copy lint gate: ok`) here **if** EP-004 did not already declare it, so the command
   exists in `COMMANDS.md` before this node uses it (SPEC-004 VG-UI-080 explicitly
   requires exactly this ordering).
8. `.agent/verification/EXPECTED_TEST_MANIFEST.txt` — add
   `tests/contract/route-manifest.test.ts`.
9. `ARCHITECTURE.md` — add the UI layer to the layer map with its import rule.
   `ASSUMPTIONS.md` — record the browser-runtime probe result.

RUN:
```
node --version
npm install --no-audit --no-fund
npm run build:web
node --test "tests/contract/route-manifest.test.ts"
npx playwright --version
sh scripts/ep005-gate.sh
git status --short
```

EXPECT: `next build` succeeds and writes `src/ui/route-manifest.json`; the manifest
suite passes; `playwright --version` prints a version (browser binaries are a separate
question, probed in M4); the final line `ep005 ui gate: ok`; `git status --short` listing
only files from §6. `verify.sh` does **not** print `verify: ok` at this node and must not
be made to.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-005 MILESTONE_PASS "M1 ep005 ui gate: ok; route manifest equals SPEC-004 route set"`

FALLBACK: if the App Router's route emission proves awkward to introspect, generate the
manifest from a single declarative route table that the app tree imports, and make the
equality test assert that every table entry resolves to a real page module (so the table
cannot drift from the tree). A hand-maintained duplicate list is not an acceptable
fallback.

COMMIT: `git add -A && git commit -m "[EP-005][M1] UI foundation, route manifest, and node gate"`

### M2: Canonical truth-state module, badge, qualifier, and the copy gate

GOAL: The eleven states render the SPEC-004 §2.2 label and qualifier byte-for-byte, with
the machine value, group, glyph, and scope suffix, from exactly one mapping; and a
screen-level label override fails the copy gate.

READ: `SPEC-004` §0.3, §2.1, §2.2, §2.3, §2.4, §11, §14 (VG-UI-080…083);
`SPEC-000` §4, §5, §5.1; `src/domain/truth-state.ts` (read for the token list and the
non-collapse facts; do not import it).

CHANGE: `src/ui/copy/truth-state.ts`, `src/ui/copy/catalogue.ts`,
`src/ui/tokens/truth-state.css`, `src/ui/components/truth/TruthStateBadge.tsx`,
`src/ui/components/truth/StateQualifier.tsx`,
`src/ui/components/scope/ServiceScopeStatement.tsx`, `src/ui/copy/service-scope.ts`,
`tests/contract/truth-state-copy.test.ts`, `tests/contract/vocabulary-ui.test.ts`,
`scripts/copy-lint-gate.sh` (only if EP-004 has not created it), `COMMANDS.md`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `src/ui/copy/truth-state.ts` — the **only** declaration of the mapping (VG-UI-007).
  Structure:

```ts
/**
 * The single canonical truth-state presentation mapping (SPEC-004 §2.2/§2.3).
 *
 * This is the only place in the application where a truth-state label, qualifier,
 * glyph, group, or token is declared. A second mapping, a per-screen override, or a
 * locale string that rewrites a qualifier is a defect (VG-UI-007).
 *
 * The labels and qualifiers below are normative copy from SPEC-004 §2.2 and are
 * asserted byte-for-byte against the specification table by
 * tests/contract/truth-state-copy.test.ts. Do not paraphrase, shorten, or "improve"
 * them.
 */
export type TruthStateToken =
  | 'DISCOVERED_CANDIDATE' | 'MATCH_CONFIRMED' | 'REQUEST_READY' | 'REQUEST_SUBMITTED'
  | 'ACKNOWLEDGED' | 'VERIFIED_REMOVED' | 'SEARCH_DELISTED' | 'VERIFIED_NOT_PRESENT'
  | 'NOT_REMOVABLE' | 'HUMAN_REQUIRED' | 'REAPPEARED';

export type TruthGroup = 'verified' | 'uncounted' | 'reopened' | 'forbidden' | 'action';

export interface TruthStateCopy {
  readonly token: TruthStateToken;
  readonly label: string;
  readonly qualifier: string;
  readonly description: string;
  readonly glyph: string;
  readonly group: TruthGroup;
  readonly cssVar: string;
  readonly requiresScope: boolean;
}

export const TRUTH_STATE_COPY: Readonly<Record<TruthStateToken, TruthStateCopy>> = Object.freeze({
  // One entry per SPEC-004 §2.2 row, transcribed exactly. In particular:
  // REQUEST_SUBMITTED: label 'Submitted — outcome unknown', group 'uncounted',
  //   qualifier 'A channel accepted the action. This does not mean the Controller
  //   received it, read it, or will act. This is not removal.'
  // ACKNOWLEDGED: label 'Acknowledged — not deleted', group 'uncounted',
  //   qualifier 'The Controller or Source responded acknowledging the request. This
  //   does not mean deletion occurred.'
  // SEARCH_DELISTED: group 'verified', glyph '≁', requiresScope true.
  // VERIFIED_REMOVED, VERIFIED_NOT_PRESENT, SEARCH_DELISTED: requiresScope true.
});
```

- `src/ui/components/truth/TruthStateBadge.tsx` — the §2.4 props and rendered output
  contract, including the scope suffix template
  `` ` · Source: ${sourceId} · window ${windowDays}d` `` appended inside the label when
  `scope` is supplied. `state` is the eleven-member union with no `string` overload, so a
  mistyped token cannot compile. The machine value renders in a monospace class. The
  component reads nothing but `TRUTH_STATE_COPY`.
- `src/ui/components/truth/StateQualifier.tsx` — renders the qualifier as visible,
  untruncated prose, never inside `[hidden]`, `aria-hidden="true"`, a closed `<details>`,
  or a tooltip role subtree (VG-UI-010).
- `src/ui/copy/service-scope.ts` — the VG-UI-070 block as a single exported constant, used
  by `/portal/limitations`, the `/portal` footer, `/admin/metrics`, and the dashboard
  header. One constant, four consumers, one equality test.
- `scripts/copy-lint-gate.sh` — **if EP-004 M8 already created it, do not duplicate it**:
  read it, and if it already scans the built browser bundle and the server-rendered HTML,
  extend it in this milestone only with the UI-specific allowlist entries (the two §0.3
  allowlists, each with an owner and a reason) rather than writing a second scanner. If
  it does not exist (EP-004 incomplete), create it here with the full VG-UI-080…083
  behaviour and record the cross-node dependency in §12. One gate, one command.
- `tests/contract/truth-state-copy.test.ts` — parses the SPEC-004 §2.2 table from the
  specification file, then asserts for each of the eleven tokens that (a) the module's
  `label` and `qualifier` equal the specification cell text after whitespace
  normalisation, (b) the module's `group`, `glyph`, and `cssVar` equal the §2.3 table
  row, and (c) `TRUTH_STATE_COPY` has exactly eleven keys with no extras. It also scans
  `src/ui/**` and asserts the mapping object is declared exactly once. **Required negative
  case:** rendering `REQUEST_SUBMITTED` with the label "Submitted for removal" must fail
  the copy-equality test — implement this as a test-local override fixture asserted to
  fail, not as a permanent second mapping.
- `tests/contract/vocabulary-ui.test.ts` — asserts the §14 VG-UI-082 permanent-claim
  phrases appear in no rendered string, page title, meta description, empty state, or
  message template in the source tree, and that the §0.3 allowlists contain exactly two
  entries each carrying an owner and a reason.
- Also assert, mechanically, the non-collapse rules checkable at the copy layer: the
  `REQUEST_SUBMITTED` qualifier contains "This is not removal.", the `ACKNOWLEDGED`
  qualifier contains "This does not mean deletion occurred.", both are `uncounted`, and
  no ancestor heading containing "removed", "deleted", "success", or "complete" is used
  for an `uncounted` group container (VG-UI-011, VG-UI-012).

RUN:
```
node --test "tests/contract/truth-state-copy.test.ts"
node --test "tests/contract/vocabulary-ui.test.ts"
sh scripts/copy-lint-gate.sh
sh scripts/ep005-gate.sh
```

EXPECT: both contract suites pass and report the eleven-state matrix;
`copy lint gate: ok`; `ep005 ui gate: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-005 MILESTONE_PASS "M2 truth-state copy equality and copy lint gate: ok"`

FALLBACK: if the specification table cannot be parsed reliably because a qualifier cell
contains a pipe character, switch the test to a line-anchored assertion that each
qualifier string exists in the specification file verbatim, in addition to the module
equality check. Never hand-copy the expected strings into the test as the only source of
truth — that is how a copy drift becomes green.

COMMIT: `git add -A && git commit -m "[EP-005][M2] canonical truth-state presentation and copy gate"`

### M3: Coverage honesty — panels, denominators, confidence basis, partial-coverage state

GOAL: No percentage renders without its denominator, `0 / 0` renders "0 / 0 — not
computable", `VERIFIED_NOT_PRESENT` and every discovery-derived listing shows its
coverage bounds, and `Confidence` always renders with its basis and threshold.

READ: `SPEC-004` §2.2 row 8, §3, §8, §9 (partial-coverage), `SPEC-000` §7 (all six
rules), `REMOVAL_EFFECTIVENESS_METRICS.md`, `SPEC-003` §7.4.

CHANGE: `src/ui/components/coverage/CoveragePanel.tsx`,
`src/ui/components/coverage/CoverageSummaryInline.tsx`,
`src/ui/components/coverage/MetricFigure.tsx`,
`src/ui/components/coverage/ConfidenceBasis.tsx`,
`src/ui/components/coverage/PartialCoverageBanner.tsx`,
`src/ui/components/truth/TruthTimeline.tsx`, `tests/contract/coverage-presentation.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `CoveragePanel` — the only coverage renderer (VG-UI-017). Renders, always:
  `sources_attempted`, `sources_total`, the declared catalogue version, the run window,
  and the skipped-Source count with a keyboard-operable control revealing each skipped
  Source and its reason. It never renders a coverage sentence without the
  attempted/total pair.
- `MetricFigure` — renders `<num> / <denom> (<pct>)` in one unit with a denominator
  label; a zero denominator renders the literal `0 / 0 — not computable`. It exposes
  numerator, denominator, and label as separate accessible text so a screen reader reads
  the pair, not just the percentage (VG-UI-018).
- `ConfidenceBasis` — renders the 0.00–1.00 decimal, every basis entry as feature name
  plus contribution, and the policy threshold applied. It **refuses to render** a score
  with an empty or absent basis rather than displaying a bare number (VG-UI-019).
- `PartialCoverageBanner` — renders before content in DOM order and reading order, and
  marks affected rows with a plain-text "partial coverage" marker (VG-UI-022, VG-UI-050).
- Source-effect and search-effect figures render as **separate labelled units with
  separate denominators**; no element carries both states' values in one figure
  (VG-UI-013). `ExternalAction` and `RequestCase` counts render as submitted or
  in-flight work and never in the same visual unit as `VERIFIED_REMOVED` counts
  (VG-UI-021).
- `TruthTimeline` — an ordered list with a list-level accessible name, one list item per
  event, a per-row accessible name combining timestamp, actor, event, and state label,
  the ordering exposed, and live updates announced once through a polite live region
  (VG-UI-034, VG-UI-036, VG-UI-061). It offers no edit, delete, or reorder affordance
  (VG-UI-035).
- `tests/contract/coverage-presentation.test.ts` — DOM-scan assertions over
  server-rendered fixtures: (a) zero `%` text nodes outside a `MetricFigure` carrying a
  numeric denominator and a denominator label; (b) a `0 / 0 — not computable` fixture
  renders no `0%` and no `NaN`; (c) a `VERIFIED_NOT_PRESENT` fixture's region accessible
  text includes the attempted/total figures and at least the skipped count; (d) with
  `sources_attempted < sources_total` the banner precedes the content in DOM order; (e) a
  hand-written string containing "of our sources" without the pair fails a
  component-usage scan. Required negative cases: rendering "98% removed" alone, or
  rendering `NaN%`, must fail.

RUN:
```
node --test "tests/contract/coverage-presentation.test.ts"
sh scripts/ep005-gate.sh
```

EXPECT: the coverage suite passes; `ep005 ui gate: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-005 MILESTONE_PASS "M3 coverage honesty presentation: ok"`

FALLBACK: if a component's rendered output is not available for server-render assertion
at this point in the build, assert the same properties against the component's rendered
output in a Node-based render harness rather than weakening the assertion to a
source-text grep. A source grep is not an oracle (SPEC-004 §0.2).

COMMIT: `git add -A && git commit -m "[EP-005][M3] coverage honesty panels, denominators, and confidence basis"`

### M4: Seven region states, keyboard operation, and automated accessibility

GOAL: Every data-bearing region implements loading, empty, partial-coverage, error,
access-denied, human-gate, and session-expiry; every task is keyboard-completable; and
automated WCAG 2.2 AA checks run with recorded tool versions and are reported as
**partial input only**.

READ: `SPEC-004` §9 (VG-UI-048…055), §10 (VG-UI-056…064), `SPEC-005` §2 (roles), §6
(step-up), `SPEC-006` §2 (an outcome is not an error), `.agent/DONE_LAW.md` DOD-039,
`SPEC-008` §9.

CHANGE: `src/ui/components/states/LoadingRegion.tsx`,
`src/ui/components/states/EmptyState.tsx`, `src/ui/components/states/ErrorState.tsx`,
`src/ui/components/states/AccessDenied.tsx`,
`src/ui/components/states/HumanGateNotice.tsx`,
`src/ui/components/states/SessionExpiryNotice.tsx`, `src/ui/app/**` (state wiring),
`tests/ui/states.spec.ts`, `tests/ui/keyboard.spec.ts`, `tests/ui/a11y.spec.ts`,
`tests/ui/reduced-motion.spec.ts`, `scripts/test-e2e.sh`, `COMMANDS.md`,
`.agent/evidence/EP-005/accessibility/**`, `.agent/state/LEDGER.md`.

CONTENT:

- Loading: a dimension-preserving skeleton marked `aria-hidden="true"` plus exactly one
  polite live region announcing `Loading <region name>.`; after 10 s, a delayed state
  naming the operation with a keyboard-operable cancel control. No bare spinner without
  text exists anywhere (VG-UI-048).
- Empty: names what was searched, over what coverage, in what window, and one next
  action. "No exposure found" without coverage context is a defect (VG-UI-049).
- Error: names the failed operation in plain language, displays a **selectable**
  `correlationId`, states whether the failure is retryable, and offers retry only where
  retry is idempotent under VG-ACTION-001; renders with `role="alert"` (VG-UI-051). A
  legitimate product outcome (`NOT_REMOVABLE`, `HUMAN_REQUIRED`) must **never** render in
  this region — it renders in the truth-state region with its qualifier (SPEC-006 §2.1
  rule 1, VG-UI-015, VG-UI-016).
- Access-denied: a distinct state, never the forbidden synonym *permission*, naming the
  required role conceptually, stating the attempt was recorded, and rendering **zero**
  fields from the denied resource — not even counts, and not in a disabled form
  (VG-UI-052).
- Human-gate: `HumanGateNotice` names the gate kind, who must act, what happens after the
  human acts, and what has been recorded so far; renders the `HUMAN_REQUIRED`
  presentation and offers **no** bypass, solver, or "skip" control (VG-UI-053). A control
  inventory test asserts zero bypass controls on any route.
- Session-expiry: warning 120 s before expiry with a keyboard-operable "Stay signed in"
  performing a real token refresh; on expiry, browser-held PII is cleared and the
  re-authentication route renders with **no case identifiers in the URL** (VG-UI-054).
- `tests/ui/keyboard.spec.ts` — a keyboard-only scripted path completing onboarding,
  exposure review, evidence reveal, appeal request, and queue filtering with no mouse
  events, recording the focused element and accessible name at each step, plus focus
  identity assertions after navigation, submit, modal close, and region refresh
  (VG-UI-059, VG-UI-060).
- `tests/ui/a11y.spec.ts` — `@axe-core/playwright` with the WCAG 2.2 A/AA rule tags over
  every declared route, plus token-pairing contrast computation for every declared
  foreground/background pair (body ≥ 4.5:1, large ≥ 3:1, non-text ≥ 3:1) and a
  grayscale-distinguishability check across the eleven states (VG-UI-057, VG-UI-058).
  Write the results to `.agent/evidence/EP-005/accessibility/` with the tool version and
  rule set recorded, and write the per-criterion report that marks each applicable
  criterion `PASS`, `FAIL`, `PARTIAL`, or **`EXTERNAL_REQUIRED`** — never a conformance
  claim (VG-UI-056).
- `tests/ui/reduced-motion.spec.ts` — under `prefers-reduced-motion: reduce`, computed
  animation and transition durations are ≤ 1 ms and a state-change snapshot shows the
  final presentation with no intermediate frames (VG-UI-062).
- **The human gate, written down where the executor will see it.** VG-UI-064 (manual
  assistive-technology validation: NVDA with Firefox/Chrome, VoiceOver with Safari,
  keyboard-only operation, 200% zoom, 400% reflow, and a documented
  colour-vision-deficiency review) is `EXTERNAL_REQUIRED` and must be signed by named
  authorized human participants. Automation cannot satisfy, impersonate, or substitute
  for it, and any generated or agent-authored accessibility sign-off is a fabrication
  defect (DOD-027, DOD-039). This milestone therefore records the affected items as
  `EXTERNAL_REQUIRED` with `externalPartyRole: accessibility practitioner`,
  `requestedArtifactDigest` of the built UI artefact, and a request evidence path — and
  makes **no** WCAG conformance claim. Note also that `verify.sh`'s `test-e2e.sh` stage
  is unblocked by this node: it must now run the browser suites against the built
  application, and it must fail closed (non-zero, no sentinel) if the browser runtime
  cannot be provisioned, recording `BLOCKED_ENVIRONMENT` with the provisioning attempt
  log rather than silently passing (DOD-033, SPEC-006 §4.1).

RUN:
```
npm run build:web
sh scripts/test-e2e.sh
npm run test:ui
npm run test:a11y
sh scripts/ep005-gate.sh
```

EXPECT: the browser suites run and pass against the built application, or `test-e2e.sh`
exits non-zero with `end-to-end tests: BLOCKED_ENVIRONMENT - …` and a recorded
provisioning attempt if no browser runtime can be installed (that outcome is legitimate
and must be recorded, not hidden); the accessibility report exists with per-criterion
statuses including `EXTERNAL_REQUIRED`; `ep005 ui gate: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-005 MILESTONE_PASS "M4 seven region states, keyboard, automated a11y; VG-UI-064 EXTERNAL_REQUIRED"`

FALLBACK: if a browser runtime cannot be provisioned on this machine, run the
DOM/accessibility-tree assertions through a server-render + JSDOM harness for the
properties JSDOM can actually establish (DOM order, roles, accessible names, `aria-*`
state, list semantics) and record every property JSDOM **cannot** establish (computed
style, contrast measurement, focus visibility rendering, reduced-motion computed
durations, grayscale distinguishability) as `BLOCKED_ENVIRONMENT` with the missing
property named. Do not report a JSDOM assertion as a browser measurement.

COMMIT: `git add -A && git commit -m "[EP-005][M4] seven region states, keyboard operation, automated accessibility"`

### M5: Subject portal surfaces

GOAL: `/portal` and its eight sibling routes implement their SPEC-004 §4/§5/§6/§7 jobs
and render **no** control that advances a truth state.

READ: `SPEC-004` §1 (subject portal rows), §4 (VG-UI-023…028), §5 (VG-UI-029…033), §6
(VG-UI-034…040), §7 (VG-UI-041…044), §11; `SPEC-003`
§5.1/§5.2/§5.5/§5.7/§5.10/§5.11/§5.12; `SPEC-005` §3 (grant kinds and scope), §4
(identity levels).

CHANGE: `src/ui/app/portal/**`, `src/ui/components/portal/**`,
`tests/contract/portal-surfaces.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- Onboarding (`/portal/onboarding`) is the ordered stepper of VG-UI-023 — (1) what this
  service does and does not do, (2) identity verification, (3) authority confirmation,
  (4) review of discovered exposures, (5) coverage summary — and renders **no** discovered
  data before step 3 completes with a valid `AuthorityGrant`. A pre-consent disclosure
  step renders no pre-selected control (VG-UI-024). Every step offers a non-punitive exit
  reachable in at most two interactions, with no progress-loss scare copy and no
  requirement to contact support (VG-UI-071).
- Authority (`/portal/authority`): displays kind, scope, issue/expiry, evidence presence,
  and revocation state; the authorized-agent path requires signed evidence and states what
  is missing when it is absent (VG-UI-025, VG-UI-026); revocation is available to the
  subject and states its effect on in-flight work (VG-UI-027); the scope boundary is
  stated and enforced server-side (VG-UI-028).
- Exposure review (`/portal/exposures`): renders provenance, the `Confidence` object with
  basis and threshold (VG-UI-029); `HumanApproveAffordance` is the **only** approval
  control (VG-UI-030); rejection routes to `VERIFIED_NOT_PRESENT` **only** with complete
  coverage bounds and states the bounds (VG-UI-031); ambiguous matches cannot be
  bulk-confirmed (VG-UI-032); quarantined aliases and tainted records are visible with
  their taint disclosed (VG-UI-033, SPEC-003 §5.4.5).
- Case detail (`/portal/cases/[caseId]`): `TruthTimeline` renders the append-only audit as
  history with no edit, delete, or reorder affordance (VG-UI-034, VG-UI-035); state
  changes are legible as transitions naming the transition code (VG-UI-036); deadlines
  render as policy-derived dates with their source and never as urgency (VG-UI-037,
  VG-UI-065); a `ControllerResponse` renders its `claimedOutcome` **labelled as a claim**
  (VG-UI-012).
- Evidence viewer (`/portal/cases/[caseId]/evidence/[evidenceId]`): shows the digest, its
  immutability, and the `redactionState` disclosure naming what class was redacted and
  that the digest covers the stored artefact as redacted (VG-UI-038, VG-UI-078);
  sensitive artefacts require explicit disclosure (VG-UI-039); exposure is bounded and no
  bulk or "export all" control exists (VG-UI-040).
- Alerts (`/portal/alerts`): alerts render only for true reappearances carrying a linked
  prior `VERIFIED_REMOVED` event (VG-UI-041); re-removal preserves prior history and shows
  it (VG-UI-042); the copy never blames the earlier verification (VG-UI-043).
- Requests (`/portal/requests`): appeal/escalation is human-gated, states that counsel
  review is pending, and creates no external effect on creation (VG-UI-044, SPEC-003
  §5.14.1).
- Limitations (`/portal/limitations`): renders the VG-UI-070 statement verbatim plus the
  truth-state legend built from `TRUTH_STATE_COPY` (not a second copy table).
- `tests/contract/portal-surfaces.test.ts` — a route-and-control inventory over the
  server-rendered `/portal` tree asserting (a) every `/portal` route resolves, (b) each
  route's owning surface against the declared manifest, and (c) **zero** rendered controls
  bound to a truth-state transition handler outside the domain-command path. Required
  negative case: injecting a "Mark as removed" control on a case route must fail the
  inventory test and must be refused by the application layer if invoked anyway
  (VG-UI-001).

RUN:
```
node --test "tests/contract/portal-surfaces.test.ts"
sh scripts/copy-lint-gate.sh
sh scripts/ep005-gate.sh
```

EXPECT: the portal inventory suite passes; `copy lint gate: ok`; `ep005 ui gate: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-005 MILESTONE_PASS "M5 subject portal surfaces and control inventory: ok"`

FALLBACK: if live `/v1` data is unavailable (EP-004 not executed, `DATABASE_URL`
unprovisioned), render the surfaces against typed fixtures that satisfy the SPEC-003 DTO
schemas and record the real-boundary proof as `BLOCKED_PREREQUISITE` (EP-004) and
`BLOCKED_CREDENTIALS` (`DATABASE_URL`, `KEYCLOAK_ISSUER`). Do not stub a fetch layer that
returns fabricated success shapes in a production build — the production build must
resolve the real client, and the fixtures must be test-only (DOD-020).

COMMIT: `git add -A && git commit -m "[EP-005][M5] subject portal surfaces"`

### M6: Operations console, tenant admin console, and the read-only auditor view

GOAL: `/console`, `/admin`, and `/auditor` implement their SPEC-004 §1 jobs; no surface
offers a truth-state edit or a "mark as removed" control; and every `/auditor` route
returns `405` for a write method and renders zero interactive controls beyond navigation,
filter, and pagination.

READ: `SPEC-004` §1 (all four surface rows), §9 (VG-UI-055), §11, §12, `SPEC-005` §2
(roles), §5 (authorization matrix), `SPEC-003` §5.3/§5.6/§5.12/§5.15/§5.16.

CHANGE: `src/ui/app/console/**`, `src/ui/app/admin/**`, `src/ui/app/auditor/**`,
`src/ui/components/console/**`, `src/ui/components/admin/**`,
`src/ui/components/auditor/**`, `tests/contract/surface-ownership.test.ts`,
`tests/contract/auditor-readonly.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `/console/queue` (VG-UI-055) implements all seven region states and renders
  `HUMAN_REQUIRED` and `NOT_REMOVABLE` counts **by default** as first-class queue columns
  with their own labels. Required negative case: a default queue that omits the
  `NOT_REMOVABLE` column fails (VG-UI-016, VG-UI-068).
- `/console/cases/[caseId]` supports case work and reconciliation; it renders the truth
  state and its qualifier and offers no state-editing control.
- `/console/exposures/[exposureId]` is match review **inside** the `HumanGate`: the only
  approval control is `HumanApproveAffordance`, and the route renders the gate notice when
  a gate is open (VG-UI-030, VG-UI-053).
- `/console/gates`, `/console/recipes`, and `/console/coverage` render `HUMAN_REQUIRED`
  triage, recipe/source freshness with `writesEnabled` and its named `disabledReason`,
  and per-run coverage reports through `CoveragePanel`.
- `/admin/metrics` renders the VG-UI-070 statement, numerator, denominator, interval, and
  the confidence interval through `MetricFigure`, with `NOT_REMOVABLE` and
  `HUMAN_REQUIRED` accounted for in the denominator composition and never dropped to
  improve a rate (VG-UI-045, VG-UI-046, VG-UI-047, VG-UI-068).
- `/admin/authority` issues and revokes `AuthorityGrant` records and must not offer
  self-approval (SPEC-005 VG-AUTHZ-016); `/admin/policy` assigns jurisdiction policy and
  must not offer a route that authors a legal basis (SPEC-003 §5.6.4, §10 item 10).
- `/auditor/**` is strictly read-only (VG-UI-002). No POST/PUT/PATCH/DELETE handler is
  registered under `/auditor`; the rendered snapshot contains zero `button[type=submit]`,
  `form`, or control bound to a mutation handler beyond navigation, filter, and
  pagination. `/auditor/claims` resolves claim → requirement → case → artefact → digest
  (VG-EVIDENCE-002); `/auditor/exports` records an export request and creates no bulk
  download.
- `tests/contract/surface-ownership.test.ts` — asserts every declared route's owning
  surface against the manifest and that a job owned by another surface is not rendered,
  linked, or reachable on a surface that does not own it (VG-UI-001).
- `tests/contract/auditor-readonly.test.ts` — HTTP method matrix returns `405` for write
  methods on every `/auditor` route, and the rendered snapshot contains zero interactive
  mutation controls. Required negative case: a direct POST to
  `/auditor/cases/[caseId]/evidence` returns `405` and creates no `AuditEvent` and no
  state change (VG-UI-002).

RUN:
```
node --test "tests/contract/surface-ownership.test.ts"
node --test "tests/contract/auditor-readonly.test.ts"
sh scripts/copy-lint-gate.sh
sh scripts/ep005-gate.sh
```

EXPECT: both suites pass; `copy lint gate: ok`; `ep005 ui gate: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-005 MILESTONE_PASS "M6 console, admin, auditor surfaces; auditor write methods 405"`

FALLBACK: if Next.js route-handler registration makes a method matrix awkward to assert
at build time, assert it against the running built application in the Playwright API
project, and keep a build-time assertion that no route module under
`src/ui/app/auditor/**` exports any write method. Both assertions are required; neither
alone is sufficient.

COMMIT: `git add -A && git commit -m "[EP-005][M6] operations console, tenant admin console, read-only auditor view"`

### M7: Browser privacy — no PII in URLs, redaction with audited reveal, no trackers

GOAL: No PII reaches a URL, `history.state`, `document.title`, breadcrumb, telemetry
event, DOM attribute, or export filename; PII renders masked by default with an explicit,
audited reveal; and no third-party tracker loads on a PII route.

READ: `SPEC-004` §12 (VG-UI-073…079), §14 (VG-UI-083), `SPEC-000` VG-EGRESS-001/002,
`DATA_EGRESS_MATRIX.md`, `SECURITY.md`, `SPEC-003` §7.1/§7.2.

CHANGE: `src/ui/lib/url.ts`, `src/ui/lib/telemetry.ts`,
`src/ui/components/evidence/PiiRedactor.tsx`,
`src/ui/components/evidence/DigestDisplay.tsx`, `src/ui/middleware.ts`,
`tests/contract/pii-url.test.ts`, `tests/ui/privacy.spec.ts`, `COMMANDS.md`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

- `src/ui/lib/url.ts` — the **only** URL builder in the UI. Every path segment, query
  value, fragment, and `history.state` write goes through a guard that tests the value
  against the VG-UI-083 PII pattern set (eight classes, including alias matching with
  case-folding and diacritic folding, and `Identifier` values matched by **digest
  comparison** against the encrypted store rather than plaintext scan). A match **throws
  in development and refuses in production** — a match is a defect, not a warning.
- `src/ui/middleware.ts` — server-side refusal of a non-allowlisted filter value in a
  path or query before rendering (VG-UI-005, VG-UI-073). Required negative case: a
  request to `/portal/cases?email=<value>` is refused server-side with the
  invalid-parameter response and renders no case (VG-UI-005).
- `PiiRedactor` — renders identifiers masked by last-four with the remainder replaced and
  documents hidden entirely; reveals only after an explicit user action, which is
  recorded as an audit event (actor, artefact, field, timestamp). Before reveal, no
  unmasked PII exists in text nodes, accessible names, `title`, `alt`, `aria-label`,
  `data-*`, or serialized props — including in the server payload (VG-UI-074).
- `src/ui/lib/telemetry.ts` — a closed event catalogue. Event names come from the
  catalogue; free-form strings are never emitted; only allowlisted opaque ID classes are
  attached; every emitted value passes the DLP scrub class for its egress class
  (VG-UI-075). An unlisted event name is rejected in tests.
- No third-party marketing, advertising, social, or session-replay script, no
  third-party runtime font or icon fetch, and no third-party iframe on any PII route;
  CSP restricts `script-src`, `style-src`, `font-src`, `img-src`, and `frame-src` to the
  application origin plus a reviewed allowlist with no wildcard host and no `unsafe-eval`;
  forms post same-origin only (VG-UI-076).
- Session handling (VG-UI-077): tokens in `HttpOnly`, `Secure`, `SameSite=Lax`-or-stricter
  cookies and never readable by browser script; no PII in `localStorage` or a non-session
  cache; idle timeout default 15 minutes with the §9 warning; sign-out clears
  session-scoped browser state, cancels in-flight work, clears PII the application placed
  on the clipboard, and invalidates the server session; `Cache-Control: no-store` on PII
  responses so back-navigation after sign-out renders no cached PII. Copying an
  `EvidenceDigest` copies only the digest (VG-UI-079).
- `tests/contract/pii-url.test.ts` — drives the URL builder with one fixture per PII
  pattern class and asserts every class is refused; asserts the fixture set itself covers
  all eight classes (a missing class fails the self-test); and asserts the URL builder is
  the only place in `src/ui/**` that constructs a path or query string. Required negative
  case: a pattern set that misses case-folded alias forms fails its own coverage
  self-test.
- `tests/ui/privacy.spec.ts` — browser-runtime dependent (M4 records the runtime status):
  an instrumented crawl asserting no PII pattern in `location.href`, `history.state`, or
  `document.title`; a request capture listing all external origins against the reviewed
  allowlist; a post-sign-out back-navigation assertion; a `localStorage` and clipboard
  inspection. If the runtime is unavailable, record these as `BLOCKED_ENVIRONMENT` with
  the missing property and keep the credential-free contract assertions green.

RUN:
```
node --test "tests/contract/pii-url.test.ts"
sh scripts/ep005-gate.sh
```

EXPECT: the PII-pattern suite passes; `ep005 ui gate: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-005 MILESTONE_PASS "M7 browser privacy: no PII in URLs, audited reveal, no third-party trackers on PII routes"`

FALLBACK: if digest-comparison matching for `Identifier` values cannot be implemented in
the browser without shipping the encrypted store to the client, move that class of the
check to the **server** boundary (the middleware refuses the value before it can reach a
URL) and record the client-side class as server-enforced in the pattern-set self-test.
Never ship the encrypted identifier store to the browser to make a client check possible.

COMMIT: `git add -A && git commit -m "[EP-005][M7] browser privacy: URL guard, redaction, tracker and CSP controls"`

### M8: Node-level acceptance, external-gate accounting, and close-out

GOAL: The node's gate passes, the accessibility external gate is recorded as
`EXTERNAL_REQUIRED` with a request artefact and digest, every blocked row carries its
exact SPEC-006 §4.1 status and blocking reference, and no claim is stronger than its
evidence.

READ: `.agent/DONE_LAW.md` (DOD-025, DOD-026, DOD-029, DOD-032, DOD-039); `SPEC-008` §1,
§2, §3, §9, §13; `SPEC-006` §4.1; `SPEC-004` §16;
`.agent/verification/reports/RESIDUAL_RISK_AND_EXTERNAL_GATES.md`.

CHANGE: `scripts/ep005-gate.sh` (final form), `.agent/evidence/EP-005/**`,
`.agent/verification/state/TEST_LEDGER.jsonl`,
`.agent/verification/state/NEXT_ACTION.md`, `.agent/state/LEDGER.md`, `COMMANDS.md`.

CONTENT:

- Run the full credential-free UI suite in a single pass and capture raw logs under
  `.agent/evidence/EP-005/` with content hashes in
  `.agent/verification/state/EVIDENCE_INDEX.jsonl` (DOD-025).
- Record every `VG-UI-*` ID this node owns in `TEST_LEDGER.jsonl` with the SPEC-006 §4.1
  required fields. Expect at minimum: the copy, manifest, coverage, ownership, auditor,
  and PII-pattern rows as `PASS` with command, exit code, sentinel, and evidence digest;
  the browser-runtime rows as `PASS` if the suites ran, otherwise `BLOCKED_ENVIRONMENT`
  with `missingProperty` and a `provisioningAttemptLogPath`; the real-data flow rows as
  `BLOCKED_CREDENTIALS` (`DATABASE_URL`, `KEYCLOAK_ISSUER`) and `BLOCKED_PREREQUISITE`
  (EP-003, EP-004); and **VG-UI-064 as `EXTERNAL_REQUIRED`** with
  `externalPartyRole: accessibility practitioner`, `requestedArtifactDigest` of the built
  UI artefact, `requestEvidencePath`, `requestedAt`, and an `ownerContactRef`.
- Write the accessibility report so that no criterion depending on lived use is `PASS`:
  it distinguishes `PASS`, `FAIL`, `PARTIAL`, and `EXTERNAL_REQUIRED` per criterion, and
  a criterion whose only evidence is an automated scan exit code of 0 is rejected as
  insufficient (VG-UI-056 negative case).
- Update `NEXT_ACTION.md` to name EP-006 and to list the provisioning and human actions
  that unblock the recorded rows.
- Append `NODE_DONE` for EP-005 **only** if every milestone above has a `MILESTONE_PASS`
  event carrying a real observed sentinel. Tag `green/EP-005`. Do **not** modify
  `.agent/verification/state/RELEASE_GATE.json`: the verdict remains `INCONCLUSIVE`,
  because the manual accessibility gate is open and no verification subgraph run or
  external gate exists (SPEC-008 §13, VG-SHIP-030).
- Do **not** write "the UI is complete", "accessible", "WCAG compliant", or "production
  ready". The honest statement is: the four surfaces are built against the SPEC-004
  contract; the copy, route, coverage, ownership, auditor-readonly, and PII-pattern
  contract suites pass; automated accessibility checks ran with recorded tool versions;
  and lived-use accessibility validation is `EXTERNAL_REQUIRED`.

RUN:
```
sh scripts/ep005-gate.sh
node --test "tests/contract/**/*.test.ts"
sh scripts/ledger.sh append <AGENT_ID> EP-005 NODE_DONE "EP-005 closed: ep005 ui gate: ok; VG-UI-064 EXTERNAL_REQUIRED; real-data flows BLOCKED_CREDENTIALS"
sh scripts/ledger.sh status EP-005
git tag green/EP-005
git log --oneline -1
sh scripts/graph-next.sh
```

EXPECT: `ep005 ui gate: ok`; `DONE` from `ledger.sh status EP-005`; tag `green/EP-005`
created; `graph-next.sh` prints `NEXT EP-006`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-005 NODE_DONE "EP-005 closed: ep005 ui gate: ok; VG-UI-064 EXTERNAL_REQUIRED; DATABASE_URL/KEYCLOAK_ISSUER BLOCKED_CREDENTIALS"`

FALLBACK: none. If the gate fails, the node stays open — do not tag, and do not narrow
the gate to make it pass.

COMMIT: `git add -A && git commit -m "[EP-005][M8] close UI/client node with external-gate accounting"`

## 9. Validation and Acceptance

1. `sh scripts/ep005-gate.sh` prints `ep005 ui gate: ok` and exits 0.
2. `src/ui/route-manifest.json` equals the 24 SPEC-004 §1 routes as a set in both
   directions; an undeclared route renders the not-found state and appears in the
   manifest diff (VG-UI-004).
3. All eleven states render the §2.2 label and qualifier byte-for-byte, with the §2.3
   machine value, group, and glyph, from exactly one mapping; a screen-level label
   override fails the copy-equality test (VG-UI-007, VG-UI-009, VG-UI-010).
4. `REQUEST_SUBMITTED` renders as "Submitted — outcome unknown" with group `uncounted`,
   never appears under a heading containing "removed", "deleted", "success", or
   "complete", and is never styled with the verified token (VG-UI-011).
5. `ACKNOWLEDGED` renders as "Acknowledged — not deleted", a `ControllerResponse` is
   labelled a claim, and neither satisfies a removal acceptance criterion (VG-UI-012).
6. `SEARCH_DELISTED` renders its own label, glyph `≁`, and unit, with a denominator
   separate from source removal; no single figure carries both (VG-UI-013).
7. `VERIFIED_NOT_PRESENT` always renders its coverage bounds and the skipped-Source list;
   "not found" never appears without them (VG-UI-014).
8. No percentage renders without a denominator; `0 / 0` renders "0 / 0 — not computable"
   (VG-UI-018).
9. Seven region states exist for every data-bearing region on all four surfaces, and a
   screen implementing only the success path fails the state matrix (VG-UI-048…055).
10. No control on any surface advances a truth state; a control inventory test proves it
    and an injected "Mark as removed" control fails it (VG-UI-001).
11. Every `/auditor` route returns `405` for write methods and renders zero mutation
    controls (VG-UI-002).
12. No PII appears in a URL, query, fragment, `history.state`, `document.title`,
    breadcrumb, telemetry event, DOM attribute, or export filename; each of the eight
    VG-UI-083 pattern classes is detected and refused (VG-UI-073, VG-UI-083).
13. Automated accessibility checks ran with recorded tool versions and rule sets, their
    results are reported as partial input, and **no** WCAG 2.2 AA conformance is claimed;
    `VG-UI-064` is `EXTERNAL_REQUIRED` (VG-UI-056, VG-UI-064, DOD-039).
14. `sh scripts/copy-lint-gate.sh` passes over built output and exits non-zero with a
    named file, line, and token when a forbidden token or permanent claim is injected, and
    fails on a zero-file scan (VG-UI-080, VG-UI-081, VG-UI-082).
15. Every milestone's evidence exists as a `MILESTONE_PASS` ledger row with a real
    observed sentinel, and every unverifiable row carries a SPEC-006 §4.1 status with its
    required fields.

**Node VERIFY narrowing — requires owner ratification (§13 D1).** The stub header
declared `VERIFY: sh scripts/verify.sh` / `VERIFY_SENTINEL: verify: ok`. `verify.sh`
requires all fifteen mandated stages, including `preflight`, `format-check`,
`dependency-audit`, `reality-gate`, `security-check`, `artifact-identity`, and
artifact-bound smoke/E2E/live-fire, which are loud-fail placeholders owned by other nodes
or cannot pass before a production artefact exists (EP-009). Keeping the boilerplate would
make this node permanently unclosable and would create pressure to fake a green. This
plan narrows **this node's** verify to `sh scripts/ep005-gate.sh` / `ep005 ui gate: ok`,
which covers this node's deliverable and genuinely fails when the UI contract suites fail.
No stage is removed from `verify.sh`; M1 and M4 strengthen `scripts/test-e2e.sh` from a
loud-fail placeholder into a real runner. Recorded in §13 D1, needs owner ratification.

**Never claim:** that the interfaces are "accessible", "WCAG 2.2 AA compliant",
"complete", "working", or "production ready"; that the golden path was exercised on real
data; or that any `VG-UI-*` row is satisfied whose dependency is unprovisioned or whose
validation is a human gate. The ship verdict remains `INCONCLUSIVE`, and the manual
assistive-technology gate keeps the ceiling at `CONDITIONAL_EXTERNAL_GATES` even after
everything else passes (SPEC-008 VG-SHIP-030).

## 10. Idempotence and Recovery

To re-enter this node cold:

1. Read `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`,
   `.agent/EXECUTION_RULES.md`, `.agent/DONE_LAW.md`, this plan, the specifications in
   §5, and `sh scripts/ledger.sh tail 30`.
2. Run `sh scripts/ledger.sh status EP-005`. If `DONE`, the node is closed.
3. Resume at the first milestone whose `Progress` checkbox is unchecked and which has no
   `MILESTONE_PASS` row in `.agent/state/LEDGER.md`. The ledger is authoritative if the
   two disagree; record the disagreement in §12.
4. Re-run the **previous** milestone's `RUN` block and confirm its sentinel still appears
   before starting the next one. Cached green is not green (SPEC-008 VG-SHIP-006).
5. Re-read every file named in that milestone's `READ` before editing.

Recovery properties:

- No milestone is destructive. `rm -rf .next src/ui/route-manifest.json` regenerates the
  build output.
- If `.next` or the Playwright browser cache is suspect:
  `rm -rf .next node_modules && npm ci`, then re-provision browsers and record the
  provisioning log.
- A dependency change is a new candidate epoch: prior evidence is invalidated, not reused
  (VG-REL-004, DOD-040).
- If the browser runtime cannot be provisioned, record `BLOCKED_ENVIRONMENT` with the
  missing property and the provisioning attempt log, and continue with independent
  credential-free work. Blanket blocking is invalid (DOD-031).
- If the same failure signature recurs three times, the bounded ladder terminates the
  attempt: stop, record the terminal state with all three attempt artefacts linked, and
  produce the structured blocked report (SPEC-006 §10.3, AGENTS.md STOP list).

## 11. Progress

- [ ] M1: UI foundation, route manifest, and this node's gate
- [ ] M2: Canonical truth-state module, badge, qualifier, and the copy gate
- [ ] M3: Coverage honesty — panels, denominators, confidence basis, partial-coverage state
- [ ] M4: Seven region states, keyboard operation, and automated accessibility
- [ ] M5: Subject portal surfaces
- [ ] M6: Operations console, tenant admin console, and the read-only auditor view
- [ ] M7: Browser privacy — no PII in URLs, redaction with audited reveal, no trackers
- [ ] M8: Node-level acceptance, external-gate accounting, and close-out

## 12. Surprises & Discoveries

<!-- Append only observed, dated findings with the exact command that produced them. -->
<!-- KNOWN BEFORE EXECUTION, recorded so the executor is not surprised:
     - VG-UI-064 (manual assistive-technology validation) is EXTERNAL_REQUIRED and can
       never be closed by an agent. No WCAG conformance claim may be made.
     - Browser runtimes may be unavailable; that is BLOCKED_ENVIRONMENT with a recorded
       provisioning attempt, not a silent skip.
     - EP-003 is largely unstarted and DATABASE_URL is unprovisioned, so real-data flows
       are BLOCKED_CREDENTIALS/BLOCKED_PREREQUISITE.
     - scripts/copy-lint-gate.sh is introduced by EP-004 M8. If EP-004 is incomplete it
       does not exist, and M2 must create it in this node and record the cross-node
       dependency here.
     - The real /v1 boundary may not exist yet; M5/M6 render against typed fixtures with
       the real-boundary proof recorded as blocked, never simulated in a production build.
     - Next.js is a large dependency; if the locked install cannot be completed, that is
       a blocking prerequisite for every UI milestone, not something to work around with
       a hand-rolled renderer. -->

## 13. Decision Log

| # | Decision | Rationale | Status |
|---|---|---|---|
| D1 | Node verify narrowed from `sh scripts/verify.sh` to `sh scripts/ep005-gate.sh`. | The stub header was generic boilerplate; `verify.sh` cannot pass before a production artefact exists and while other nodes' stages are placeholders. Narrowing prevents pressure to fake a green and removes no stage from `verify.sh`. Follows the EP-000 D1 precedent. | PENDING OWNER RATIFICATION |
| D2 | The UI consumes a generated canonical token type rather than importing `src/domain/truth-state.ts`. | SPEC-004 §0.3 and the `ARCHITECTURE.md` code law forbid the UI importing domain internals; the tokens still exist once and are gated for equality against the specification. | ACCEPTED |
| D3 | One copy-lint gate command (`sh scripts/copy-lint-gate.sh`) serves both the API vocabulary rule (SPEC-003 VG-API-067) and the UI copy rules (SPEC-004 VG-UI-080…083). | Two competing scanners would drift and let a hit pass one of them. One gate, one command, one allowlist with owner and reason per entry. | ACCEPTED |
| D4 | The node gate verifies browser-runtime-independent behaviour and names the three things it does not verify. | A gate that silently skips browser or human work is a masking defect (DOD-024); a gate that fails forever on an unprovisioned runtime blocks independent work (DOD-031). Naming the gap in the gate's own output is the honest third option. | ACCEPTED |
| D5 | Accessibility reports use per-criterion `PASS`/`FAIL`/`PARTIAL`/`EXTERNAL_REQUIRED` and carry no conformance claim. | VG-UI-056 requires automated output to be treated as insufficient input, and VG-UI-064 makes the lived-use judgement a human gate that automation cannot satisfy or impersonate. | ACCEPTED |

## 14. Outcomes & Retrospective

<!-- Filled in only after the node closes, with real observed evidence. Include: which
     VG-UI rows reached PASS and on what command; which are BLOCKED_ENVIRONMENT,
     BLOCKED_CREDENTIALS, BLOCKED_PREREQUISITE, EXTERNAL_REQUIRED, or UNVERIFIED and on
     which dependency or participant; the browser-runtime provisioning result; the
     accessibility per-criterion report location; and the exact commands whose sentinels
     were observed. Do not record any claim this node did not execute. -->
