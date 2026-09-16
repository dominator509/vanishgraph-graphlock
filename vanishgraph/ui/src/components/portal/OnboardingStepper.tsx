/**
 * `OnboardingStepper` — the ordered onboarding stepper (SPEC-004 §4 VG-UI-023/024/071; EP-005 M5).
 *
 * FIVE STEPS, IN ONE ORDER, AND THE ORDER IS THE RULE: (1) what this service does and does not do, (2) identity
 * verification, (3) authority confirmation, (4) review of discovered exposures, (5) coverage summary. VG-UI-023 also
 * says what must NOT happen: **no discovered data renders before step 3 completes with a valid `AuthorityGrant`**. That
 * is enforced structurally here — the component takes the exposures as a prop that is only READ on step 4, and
 * `stepIndex` below refuses to advance past step 2 unless the caller passes `authority.state === 'VALID'`. A stepper
 * that let a caller render step 4 early would put a subject's discovered records on screen before they had confirmed
 * who may act for them.
 *
 * NO CONTROL ON THE DISCLOSURE STEP IS PRE-SELECTED (VG-UI-024). Step 1 renders the scope statement and two explicit
 * choices, neither of them a default: there is no `checked`, no `defaultValue`, and no preselected radio — the acceptance
 * criterion is that a reader must choose, so an unselected state is the initial state.
 *
 * THE EXIT IS ALWAYS REACHABLE IN AT MOST TWO INTERACTIONS AND IS NEVER PUNISHED (VG-UI-071). Every step renders one
 * exit link in the same position, the copy states what is kept and what is not, and there is no warning about losing
 * progress, no "are you sure", and no instruction to contact support. The exit is a link, not a button, because leaving
 * is navigation rather than an action on the account.
 */

import type { ReactNode } from 'react';

import { ServiceScopeStatement } from '../scope/ServiceScopeStatement.tsx';

export const ONBOARDING_STEPS: readonly string[] = [
  'What this service does and does not do',
  'Confirm your identity',
  'Confirm who may act for you',
  'Review what was found',
  'Coverage summary',
];

export interface OnboardingExit {
  readonly href: string;
  /** What is kept when the reader leaves — stated as a fact, never as a consequence. */
  readonly keeps: string;
}

export interface OnboardingStepperProps {
  /** The step being shown, 1-based, as the reader sees it. */
  readonly step: number;
  readonly exit: OnboardingExit;
  /** Step 2's content. */
  readonly identity?: ReactNode;
  /** Step 3's outcome: the authority the subject has confirmed. `VALID` is what unlocks step 4. */
  readonly authority?: { readonly state: 'VALID' | 'EXPIRED' | 'REVOKED' | 'NONE'; readonly summary: ReactNode };
  /** Step 4's content: the discovered exposures. NOT read before step 4 (VG-UI-023). */
  readonly exposures?: ReactNode;
  /** Step 5's content: the coverage summary. */
  readonly coverage?: ReactNode;
  /** Step 1's answer, if the reader has made one: `null` means nothing has been chosen yet. */
  readonly disclosureAnswer?: 'CONTINUE' | 'LEAVE' | null;
  readonly onDisclosureAnswer?: (answer: 'CONTINUE' | 'LEAVE') => void;
}

export function OnboardingStepper({
  step,
  exit,
  identity,
  authority,
  exposures,
  coverage,
  disclosureAnswer = null,
  onDisclosureAnswer,
}: OnboardingStepperProps): React.JSX.Element {
  if (!Number.isInteger(step) || step < 1 || step > ONBOARDING_STEPS.length) {
    throw new Error(`OnboardingStepper: step ${String(step)} is outside the ${String(ONBOARDING_STEPS.length)} declared steps`);
  }
  if (step >= 4 && authority?.state !== 'VALID') {
    // VG-UI-023's prohibition, as a refusal rather than a comment: the discovered data must not be reachable while no
    // valid authority grant exists.
    throw new Error(
      `OnboardingStepper: step ${String(step)} shows the results of a discovery run while the authority state is ${String(authority?.state ?? 'not supplied')}; VG-UI-023 requires a VALID AuthorityGrant first`,
    );
  }

  return (
    <section className="vg-onboarding" data-onboarding="true" data-onboarding-step={String(step)} aria-label="Getting started">
      <ol className="vg-onboarding__steps" data-onboarding-step-list="true">
        {ONBOARDING_STEPS.map((title, index) => (
          <li
            key={title}
            data-onboarding-step-item={String(index + 1)}
            {...(index + 1 === step ? { 'aria-current': 'step' as const } : {})}
          >
            {title}
          </li>
        ))}
      </ol>

      {/* THE EXIT IS FIRST IN THE DOM ON EVERY STEP, in the same place, and it is never a confirm dialog. */}
      <p className="vg-onboarding__exit">
        <a href={exit.href} data-onboarding-exit="true">
          Leave and come back later
        </a>
        {` ${exit.keeps}`}
      </p>

      <div className="vg-onboarding__body" data-onboarding-body={String(step)}>
        {step === 1 ? (
          <>
            <ServiceScopeStatement context="onboarding step 1" />
            <fieldset className="vg-onboarding__disclosure">
              <legend>Do you want to continue?</legend>
              {/* NOT PRE-SELECTED: `checked` is bound to an explicit answer that starts as null (VG-UI-024). */}
              <label>
                <input
                  type="radio"
                  name="onboarding-disclosure"
                  value="CONTINUE"
                  checked={disclosureAnswer === 'CONTINUE'}
                  onChange={() => onDisclosureAnswer?.('CONTINUE')}
                  data-onboarding-choice="CONTINUE"
                />
                Yes, continue
              </label>
              <label>
                <input
                  type="radio"
                  name="onboarding-disclosure"
                  value="LEAVE"
                  checked={disclosureAnswer === 'LEAVE'}
                  onChange={() => onDisclosureAnswer?.('LEAVE')}
                  data-onboarding-choice="LEAVE"
                />
                No, not now
              </label>
            </fieldset>
          </>
        ) : null}
        {step === 2 ? identity : null}
        {step === 3 ? authority?.summary : null}
        {step === 4 ? exposures : null}
        {step === 5 ? coverage : null}
      </div>
    </section>
  );
}
