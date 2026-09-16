# Per-criterion accessibility report — EP-005 M4

**Artefact measured:** `ui/dist` (the Vite build output, served by `vite preview`), entry document digest recorded in
`axe-results.json` and in `human-gate-request.json`.
**Tooling:** `@axe-core/playwright` with `axe-core`, rule tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22a`,
`wcag22aa`; Playwright with Chrome Headless Shell. Exact versions are in `axe-results.json`.
**Routes scanned:** every route SPEC-004 §1 declares (25), found from `ui/src/route-manifest.json`, with the
parameterised routes opened at the all-zero UUID.

## The four statuses, and what each one means here

| Status | Meaning in this report |
|---|---|
| `PASS` | The criterion was assessed for this artefact by executed evidence, and no failure was found. It is **not** a conformance claim: automated and DOM evidence cannot establish a perceptual criterion. |
| `FAIL` | The criterion was assessed and the artefact does not meet it. The row names the milestone that owns the fix. |
| `PARTIAL` | Some of the criterion's applicable aspects were assessed and passed; the rest cannot be assessed until a named surface, request or human procedure exists. |
| `EXTERNAL_REQUIRED` | The criterion cannot be assessed by automation or by the implementer at all. It requires the named human procedure in `human-gate-request.json`. |
| `N/A` | The criterion has no subject in this artefact — for example, criteria about audio, images, or time limits, in a portal that has none. Recorded rather than omitted, so an absence cannot be read as a pass. |

**NO CONFORMANCE CLAIM IS MADE — not for any surface, not for any criterion, and not on the basis of automated tooling
(VG-UI-056).** Automated output is a necessary and insufficient input; the manual gate VG-UI-064 is `EXTERNAL_REQUIRED`
and unsigned.

## Per-criterion checklist

| Criterion | Level | Status | Executed evidence, and what is missing |
|---|---|---|---|
| 1.1.1 Non-text Content | A | PASS | Every non-text element is decorative or labelled: the state glyph is `aria-hidden="true"` with the label and machine value beside it (`tests/contract/truth-state-copy.test.ts`, `tests/ui/states.spec.ts`); no `<img>`, `<svg>` or icon font exists in the bundle; axe reports no `image-alt`/`svg-img-alt` violation on any route. |
| 1.2.1 Audio-only and Video-only (Prerecorded) | A | N/A | The portal contains no prerecorded audio or video. |
| 1.2.2 Captions (Prerecorded) | A | N/A | No prerecorded media exists. |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | A | N/A | No prerecorded media exists. |
| 1.2.4 Captions (Live) | AA | N/A | No live audio or video exists. |
| 1.2.5 Audio Description (Prerecorded) | AA | N/A | No prerecorded media exists. |
| 1.3.1 Info and Relationships | A | PASS | Structure is carried by real elements: `main`, `h1`/`h2`/`h3`, `dl`/`dt`/`dd`, `ol`/`li`, `figure`/`figcaption`, `details`/`summary` (`tests/contract/coverage-presentation.test.ts`, `tests/contract/region-states.test.ts`), and axe reports no `list`/`definition-list`/`heading-order` violation on any route. |
| 1.3.2 Meaningful Sequence | A | PASS | Rendered order equals reading order and is asserted, including that the partial-coverage banner precedes the content it qualifies (`tests/contract/coverage-presentation.test.ts`). |
| 1.3.3 Sensory Characteristics | A | PASS | No instruction in the copy refers to shape, size, position or sound. The state is carried by label, glyph and machine value. |
| 1.3.4 Orientation | AA | PASS | No orientation lock: there is no orientation media query and no `screen.orientation` use in `ui/src`; the 320×640 viewport test asserts the layout reflows rather than requiring a width (`tests/ui/reduced-motion.spec.ts`). |
| 1.3.5 Identify Input Purpose | AA | PARTIAL | No input exists in the artefact yet; the rule binds the forms M5/M6 build, and `ErrorState`, `EmptyState` and the gate notice carry no inputs. |
| 1.4.1 Use of Color | A | PASS | Every state is distinguishable with colour removed: label text, a unique glyph and the machine token, plus a forced-grayscale image comparison of all eleven states (`tests/ui/states.spec.ts`). |
| 1.4.2 Audio Control | A | N/A | No audio plays. |
| 1.4.3 Contrast (Minimum) | AA | PASS | Computed in two independent ways: from the stylesheet tokens (`tests/contract/contrast-tokens.test.ts`, all eleven tints ≥ 4.5:1 against `--vg-ink-900`) and from the browser's computed styles for every rendered element of every region state (`tests/ui/states.spec.ts`). |
| 1.4.4 Resize Text | AA | EXTERNAL_REQUIRED | Automated checks can confirm relative units (`rem`, no fixed `px` root font size) but not that text resizes to 200% legibly in the reader's own configuration. Owned by the VG-UI-064 manual gate. |
| 1.4.5 Images of Text | AA | PASS | No raster or vector text exists: every label is a text node, and the bundle contains no image asset. |
| 1.4.10 Reflow | AA | PARTIAL | The region states reflow at 320 CSS pixels with no horizontal scrolling (`tests/ui/reduced-motion.spec.ts`); the 400% reflow of the full surfaces is part of the VG-UI-064 manual gate. |
| 1.4.11 Non-text Contrast | AA | PASS | Every state hue is ≥ 3:1 against its own tint and the focus ring, border and accents are ≥ 3:1 against the surface, computed from the tokens (`tests/contract/contrast-tokens.test.ts`) and from computed styles in the browser (`tests/ui/states.spec.ts`). |
| 1.4.12 Text Spacing | AA | PARTIAL | The stylesheet uses no fixed line-height, letter-spacing or word-spacing, and no `text-overflow` clamp on the qualifier (`ui/src/tokens/truth-state.css`); the reader-applied spacing override of the criterion is part of the manual gate. |
| 1.4.13 Content on Hover or Focus | AA | PASS | No hover- or focus-only content exists: the mandatory qualifier is always-visible prose and VG-UI-010's four hiding shapes are asserted absent (`tests/contract/vocabulary-ui.test.ts`). |
| 2.1.1 Keyboard | A | PARTIAL | Native elements only; the disclosure, the cancel, the retry and the "Stay signed in" controls are `<button>`/`<details>`/`<a>`; focus identity is asserted after client-side navigation and the browser Back button (`tests/ui/keyboard.spec.ts`). The five end-to-end keyboard flows are `BLOCKED_PREREQUISITE` on M5/M6 and are recorded as such in that suite. |
| 2.1.2 No Keyboard Trap | A | PARTIAL | Tab is asserted never to leave the page (`tests/ui/keyboard.spec.ts`); the artifact renders no modal, so the modal-trap rule has no subject yet and is M5/M6's to assert. |
| 2.1.4 Character Key Shortcuts | A | PASS | No single-character keyboard shortcut is registered anywhere in `ui/src`. |
| 2.2.1 Timing Adjustable | A | PARTIAL | The session-expiry notice warns 120 seconds before expiry with a keyboard-operable refresh (`tests/contract/region-states.test.ts`); no session manager mounts it yet, so no live timing behaviour was measured. |
| 2.2.2 Pause, Stop, Hide | A | PASS | Nothing moves, blinks or auto-updates: the stylesheet declares one 120ms tint transition and no animation, asserted from computed durations (`tests/ui/reduced-motion.spec.ts`). |
| 2.3.1 Three Flashes or Below Threshold | A | PASS | No flashing content exists; the only transition is a 120ms colour change. |
| 2.4.1 Bypass Blocks | A | N/A | No repeated block exists to bypass: the root layout renders no navigation (deliberately, until M5/M6 own the chrome). Re-assess when chrome arrives. |
| 2.4.2 Page Titled | A | PASS | The document has a `<title>`, and axe reports no `document-title` violation on any route. Per-route titles are declared in `ui/src/copy/catalogue.ts` for the surfaces that will use them. |
| 2.4.3 Focus Order | A | PARTIAL | Focus moves to the page heading after navigation and preserves meaning order (`tests/ui/keyboard.spec.ts`, `tests/contract/region-states.test.ts`); a full multi-control order needs the surfaces. |
| 2.4.4 Link Purpose (In Context) | A | PARTIAL | Every rendered link has a distinct accessible name from its text (`Back to your portal`, `Sign in again`); the artifact renders no link in the app shell yet. |
| 2.4.5 Multiple Ways | AA | **FAIL** | The 25 declared routes are reachable only by typing a URL: this artifact renders no in-product navigation, so a reader cannot locate a page within the set by any route other than the address bar. **Owner: M5/M6**, which own the surface chrome. Recorded as a failure of this artefact rather than deferred silently. |
| 2.4.6 Headings and Labels | AA | PASS | Every route renders one `h1` carrying its path, and each region renders a labelled `h2`; the axe pass reports no `heading-order` or `empty-heading` violation. |
| 2.4.7 Focus Visible | AA | PASS | A 2px `:focus-visible` outline with a 1px offset (a non-colour indicator), measured in the browser for the cancel control, and the only outline suppression in the built stylesheet is the programmatically focused heading (`tests/ui/keyboard.spec.ts`, `tests/ui/states.spec.ts`). |
| 2.4.11 Focus Not Obscured (Minimum) | AA | PASS | No overlay, sticky header or toast exists to obscure the focused element; the shell renders no fixed-position element. |
| 2.5.1 Pointer Gestures | A | PASS | No path-based or multi-point gesture exists; every affordance is a native control operable with a single pointer action. |
| 2.5.2 Pointer Cancellation | A | PASS | Actions fire on the control's activation event (`click` via `onClick`), not on pointer-down; no drag interaction exists. |
| 2.5.3 Label in Name | A | PASS | Every control's visible text is contained in its accessible name (`Cancel the case queue`, `Stay signed in`), asserted by role queries in `tests/ui/states.spec.ts`. |
| 2.5.4 Motion Actuation | A | N/A | No device-motion or user-motion actuation exists. |
| 2.5.7 Dragging Movements | AA | PASS | No drag interaction exists anywhere in `ui/src`; every action is a click or a keypress. |
| 2.5.8 Target Size (Minimum) | AA | PARTIAL | No target is smaller than its text at the default font size, but the criterion depends on the reader's zoom and pointer; part of the VG-UI-064 manual gate. |
| 3.1.1 Language of Page | A | PASS | `ui/index.html` declares `lang="en"`, and axe reports no `html-has-lang`/`html-lang-valid` violation on any route. |
| 3.1.2 Language of Parts | AA | PASS | No passage in another language exists; the interface copy is English throughout. |
| 3.2.1 On Focus | A | PASS | No control changes context on focus: the focus effect only moves focus to a heading and changes no state. |
| 3.2.2 On Input | A | PASS | No input changes context; the artifact has no form control that submits on change. |
| 3.2.3 Consistent Navigation | AA | PARTIAL | No navigation exists yet, so there is nothing to be inconsistent; M5/M6 own the chrome and this row must be re-assessed then. |
| 3.2.4 Consistent Identification | AA | PASS | One component per concept, with one copy source: the truth-state mapping and the coverage renderer are single-sourced and asserted (`tests/contract/truth-state-copy.test.ts`, `tests/contract/coverage-presentation.test.ts`). |
| 3.2.6 Consistent Help | A | N/A | No help mechanism exists in the artifact; recorded rather than claimed. |
| 3.3.1 Error Identification | A | PARTIAL | `ErrorState` names the failed operation in plain language, states retryability and shows a selectable correlation identifier (`tests/contract/region-states.test.ts`, `tests/ui/states.spec.ts`); no request exists yet to fail, so no in-app error was produced. |
| 3.3.2 Labels or Instructions | A | PARTIAL | The components render labels and instructions for every control they own; the surfaces' forms arrive in M5/M6. |
| 3.3.3 Error Suggestion | AA | PARTIAL | The error state states whether a retry is possible and why not; suggestions for form-level errors need the forms. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | AA | PARTIAL | No destructive or data-changing action is rendered; the confirm-before-submit behaviour is M5/M6's and must be asserted there. |
| 3.3.7 Redundant Entry | A | PARTIAL | Nothing is entered twice because nothing is entered yet; the rule binds the multi-step flows in M5. |
| 3.3.8 Accessible Authentication (Minimum) | AA | EXTERNAL_REQUIRED | The authentication flow is Keycloak's (ADR, `KEYCLOAK_ISSUER` unprovisioned). Neither the cognitive-function-test rule nor the paste/autofill allowance can be assessed against a flow this artifact does not contain, and the assessment is a human one. |
| 4.1.2 Name, Role, Value | A | PASS | Every rendered component exposes name, role and state through native semantics or explicit ARIA: regions are labelled sections, the timeline is an `ol` with a list-level name, badges carry `data-truth-state`, live regions are `role="status"`, and axe reports no `aria-*` violation on any route. |
| 4.1.3 Status Messages | AA | PARTIAL | Live regions exist and are asserted for the loading, delayed, session and timeline states (`tests/contract/region-states.test.ts`, `tests/contract/coverage-presentation.test.ts`); no app-level status message is produced yet, because no request runs. |

## Summary of statuses

| Status | Count |
|---|---|
| PASS | 24 |
| FAIL | 1 |
| PARTIAL | 16 |
| EXTERNAL_REQUIRED | 2 |
| N/A | 11 |

**The FAIL is 2.4.5 Multiple Ways, and it is owned by M5/M6.** It is recorded rather than deferred because the
acceptance criterion for a per-criterion report is that an unassessed or unmet criterion is visible, not that the report
is clean (VG-UI-056's negative case).

## What this report is not

* It is **not** a conformance claim, and it is not an accessibility sign-off. No human has judged this interface.
* It is **not** complete: sixteen criteria are `PARTIAL` because the surfaces that carry them do not exist yet, and two
  are `EXTERNAL_REQUIRED` because no automated check can assess them.
* The manual gate VG-UI-064 — NVDA with Firefox/Chrome, VoiceOver with Safari, keyboard-only operation, 200% zoom, 400%
  reflow, and a documented colour-vision-deficiency review, signed by named authorized human participants — remains
  **open**. Its request is recorded in `human-gate-request.json`.
