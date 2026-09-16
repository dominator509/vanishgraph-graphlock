/**
 * `PiiRedactor` and `DigestDisplay` — masked by default, revealed only by an audited action (SPEC-004 §12 VG-UI-074/079).
 *
 * BEFORE A REVEAL, NO UNMASKED PII EXISTS IN THE DOM. The component is given the full value and renders only the masked
 * form, so there is no `data-*` attribute, no `title`, no `aria-label` and no serialized prop carrying the value: a
 * masked presentation that keeps the value in an attribute is the defect VG-UI-074 names, because the attribute is in
 * the DOM, in a screenshot of the inspector, and in anything that serialises the node.
 *
 * THE REVEAL IS AN ACTION WITH A RECORD. `onReveal` is REQUIRED: the component refuses to render the reveal control
 * without a callback that records the reveal — actor, artifact, field and time — because a reveal that leaves no trace
 * is an unlogged disclosure of a data subject's record. There is no "reveal all" and no remember-my-choice: each reveal
 * is one decision about one field.
 *
 * THE DIGEST IS THE ONE VALUE THAT MAY BE COPIED (VG-UI-079, VG-UI-078): a digest identifies bytes without disclosing
 * them, so `DigestDisplay` renders it in full and copies exactly it — never the artefact, and never the storage
 * reference.
 */

import { useState } from 'react';

import { documentTitle } from '../../lib/url.ts';

/** Mask a value by its last four characters. Short values are masked entirely rather than shown mostly. */
export function maskValue(value: string): string {
  if (value.length <= 4) return '•'.repeat(value.length);
  return `${'•'.repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

export interface PiiRedactorProps {
  /** The field's name, as the record names it. Rendered, because a masked value with no label is unusable. */
  readonly fieldName: string;
  /** The full value. It is NEVER rendered unmasked before a reveal. */
  readonly value: string;
  /**
   * Records the reveal: actor, artifact, field, timestamp. REQUIRED — a reveal that leaves no trace is an unlogged
   * disclosure, and the component refuses to offer the control without it.
   */
  readonly onReveal: () => void;
  /** The artifact the value belongs to, for the record the caller writes. */
  readonly artifactId: string;
  /** Whether the caller has already recorded a reveal for this field in this session. */
  readonly revealed?: boolean;
}

export function PiiRedactor({
  fieldName,
  value,
  onReveal,
  artifactId,
  revealed = false,
}: PiiRedactorProps): React.JSX.Element {
  const [isRevealed, setIsRevealed] = useState(revealed);
  if (typeof onReveal !== 'function') {
    throw new Error(
      'PiiRedactor: onReveal is required; a reveal control without a recorded audit event is an unlogged disclosure',
    );
  }
  return (
    <span className="vg-pii" data-pii-field={fieldName} data-pii-artifact={artifactId} data-pii-revealed={String(isRevealed)}>
      <span className="vg-pii__label">{`${fieldName}: `}</span>
      {isRevealed ? (
        <span className="vg-pii__value" data-pii-value="true">
          {value}
        </span>
      ) : (
        <span className="vg-pii__masked" data-pii-masked={maskValue(value)}>
          {maskValue(value)}
        </span>
      )}
      {isRevealed ? null : (
        <button
          type="button"
          onClick={() => {
            onReveal();
            setIsRevealed(true);
          }}
          data-pii-reveal={fieldName}
        >
          {`Show ${fieldName}`}
        </button>
      )}
    </span>
  );
}

export interface DigestDisplayProps {
  readonly digest: string;
  /** What the digest covers, rendered so a reader knows what they are looking at. */
  readonly covers: string;
  /** Called after the digest is placed on the clipboard, so the copy is recorded like any other disclosure. */
  readonly onCopy?: (() => void) | undefined;
}

export function DigestDisplay({ digest, covers, onCopy }: DigestDisplayProps): React.JSX.Element {
  return (
    <span className="vg-digest" data-evidence-digest-display="true">
      <code className="vg-digest__value" data-digest-value="true">
        {digest}
      </code>
      <span className="vg-digest__covers" data-digest-covers="true">
        {`This digest covers ${covers}. Copying it copies the digest only, never the artefact.`}
      </span>
      {onCopy === undefined ? null : (
        <button
          type="button"
          onClick={() => {
            // ONLY THE DIGEST IS PLACED ON THE CLIPBOARD. Putting anything else there — a reference, an excerpt, a
            // filename — would leak a data subject's record into whatever the reader pastes into next.
            void globalThis.navigator?.clipboard?.writeText(digest).then(onCopy);
          }}
          data-digest-copy="true"
        >
          Copy the digest
        </button>
      )}
    </span>
  );
}

/**
 * The document title, built through the URL guard's title writer: a title reaches history, tab strips and screenshots, so
 * it is one of the surfaces VG-UI-083 covers.
 */
export function titled(text: string): string {
  return documentTitle(text);
}
