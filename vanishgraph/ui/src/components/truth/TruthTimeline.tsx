/**
 * `TruthTimeline` — the append-only audit rendered as history (SPEC-004 §6 VG-UI-034/035/036, §10 VG-UI-061; EP-005 M3).
 *
 * IT IS A PROJECTION AND IT SAYS SO IN ITS SHAPE. There is no list mutation here — no edit, no delete, no hide, no
 * reorder, no "add note" — because the events it renders are facts that already happened (VG-EVIDENCE-003). The
 * component takes the events it is given and renders one list item each, in order, and it has no code path that can
 * drop one: a row count lower than the event count is the failure mode VG-UI-034 names, and the suite renders a
 * multi-event fixture and asserts the count rather than trusting the map.
 *
 * THE ORDERING IS EXPOSED, NOT IMPLIED. `order` is a prop (oldest-first by default, with newest-first as the documented
 * alternative) and it is rendered as `data-timeline-order`, so a reader — or a test — can tell which order it is looking
 * at instead of inferring it from the first timestamp. The CONTROL that flips it belongs to the surfaces that own URL
 * state (M5/M6); rendering an inert button here would be a control a later inventory could find and could not explain,
 * which is the same rule the M1 page shell follows.
 *
 * EACH ROW'S ACCESSIBLE NAME CARRIES THE FOUR FIELDS VG-UI-061 names: timestamp, actor, event, and the truth-state
 * label where one applies — plus its position ("event 3 of 12"), which is how the ordering reaches a screen reader.
 * The `aria-label` is composed from the same nodes that are rendered, so the name cannot drift from the visible text.
 *
 * LIVE UPDATES ANNOUNCE ONCE. The polite live region is a SIBLING of the list and contains only the message it is
 * given; it never wraps the timeline, because a live region around the list would re-read every row on every update —
 * the behaviour VG-UI-061's negative case names.
 *
 * NO FUTURE-DATED ROW RENDERS. When a caller passes `now`, an event after it is refused rather than rendered: a planned
 * or predicted event presented in a history list is a claim that something happened.
 */

import { TRUTH_STATE_COPY, scopeSuffix, type TruthStateToken } from '../../copy/truth-state.ts';
import { StateQualifier } from './StateQualifier.tsx';
import { TruthStateBadge, type TruthStateScope } from './TruthStateBadge.tsx';

export interface TimelineEvent {
  readonly eventId: string;
  /** ISO 8601 with an offset, exactly as the audit store recorded it. */
  readonly occurredAt: string;
  /** An identity REFERENCE, never a name or an address: the timeline is not a place PII may appear (§12). */
  readonly actorReference: string;
  /** The audit event name, as the API names it. */
  readonly eventName: string;
  /** The resulting truth state, where the event has one (VG-UI-036). */
  readonly state?: TruthStateToken;
  readonly stateScope?: TruthStateScope;
  /** The guard evidence name, so a state change is legible as a transition (VG-UI-036). */
  readonly evidenceName?: string;
  readonly evidenceHref?: string;
}

export interface TruthTimelineProps {
  /** The list-level accessible name (VG-UI-061). */
  readonly label: string;
  readonly events: readonly TimelineEvent[];
  readonly order?: 'oldest-first' | 'newest-first';
  /**
   * The IANA zone the timestamps are presented in. REQUIRED: the viewer's timezone with its UTC offset is part of the
   * row (VG-UI-034), and a component that silently used the server's zone would present one reader's time as another's.
   */
  readonly timeZone: string;
  /** The single polite announcement for a live update, or `undefined` when nothing new arrived. */
  readonly announcement?: string;
  /** When given, an event after this instant is refused (VG-UI-035: no predicted or future event renders). */
  readonly now?: string;
}

/**
 * `16 Sept 2026, 11:08:58 GMT+00:00` — the date, the time, and the offset the row is expressed in.
 *
 * THE COMPONENTS ARE NAMED INDIVIDUALLY RATHER THAN USING `dateStyle`/`timeStyle`, and that is a MEASURED constraint
 * rather than a preference: `new Intl.DateTimeFormat('en-GB', { timeStyle: 'long', timeZoneName: 'longOffset' })` throws
 * `TypeError: Invalid option : option` on this runtime, because the style shortcuts and `timeZoneName` are mutually
 * exclusive. VG-UI-034 requires the UTC offset in the row, so the explicit form is the one that can carry it.
 */
function formatInstant(iso: string, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone,
    timeZoneName: 'longOffset',
  });
  return formatter.format(new Date(iso));
}

export function TruthTimeline({
  label,
  events,
  order = 'oldest-first',
  timeZone,
  announcement,
  now,
}: TruthTimelineProps): React.JSX.Element {
  const refused = events.filter((event) => !Number.isFinite(Date.parse(event.occurredAt)));
  if (refused.length > 0) {
    throw new Error(
      `TruthTimeline: ${String(refused.length)} event(s) carry an unparseable timestamp, so the ordering it exposes would be wrong`,
    );
  }
  if (now !== undefined) {
    const limit = Date.parse(now);
    const future = events.filter((event) => Date.parse(event.occurredAt) > limit);
    if (future.length > 0) {
      throw new Error(
        `TruthTimeline: refusing to render ${String(future.length)} event(s) dated after ${now}: this is a history of what happened, not a plan`,
      );
    }
  }

  const ordered = order === 'newest-first' ? [...events].reverse() : [...events];
  const total = ordered.length;

  return (
    <section className="vg-timeline" data-truth-timeline="true" data-timeline-order={order}>
      <ol className="vg-timeline__list" aria-label={label} data-timeline-list="true">
        {ordered.map((event, index) => {
          const position = `event ${String(index + 1)} of ${String(total)}`;
          // THE ACCESSIBLE NAME IS COMPOSED FROM THE CANONICAL COPY, not from a per-screen label: the row's name and
          // the badge's visible text are the same sentence, so they cannot disagree (VG-UI-007, VG-UI-061).
          const stateText =
            event.state === undefined
              ? ''
              : ` · ${TRUTH_STATE_COPY[event.state].label}${
                  event.stateScope === undefined ? '' : scopeSuffix(event.stateScope)
                }`;
          return (
            <li
              className="vg-timeline__row"
              key={event.eventId}
              data-timeline-row="true"
              data-event-id={event.eventId}
              aria-label={`${formatInstant(event.occurredAt, timeZone)} · ${event.actorReference} · ${event.eventName}${stateText} · ${position}`}
            >
              <time className="vg-timeline__time" dateTime={event.occurredAt}>
                {formatInstant(event.occurredAt, timeZone)}
              </time>
              <span className="vg-timeline__actor" data-timeline-actor="true">
                {event.actorReference}
              </span>
              <span className="vg-timeline__event" data-timeline-event-name="true">
                {event.eventName}
              </span>
              {event.state !== undefined ? (
                <>
                  <TruthStateBadge
                    state={event.state}
                    scope={event.stateScope}
                    qualifierId={`${event.eventId}-qualifier`}
                  />
                  {/* THE QUALIFIER IS RENDERED ADJACENT AND VISIBLE (VG-UI-010): the badge points its accessible
                      description at this node, so the mandatory sentence is announced once, with the label. */}
                  <StateQualifier state={event.state} id={`${event.eventId}-qualifier`} />
                </>
              ) : null}
              {event.evidenceName !== undefined ? (
                event.evidenceHref === undefined ? (
                  <span className="vg-timeline__evidence" data-timeline-evidence="true">
                    {event.evidenceName}
                  </span>
                ) : (
                  <a className="vg-timeline__evidence" data-timeline-evidence="true" href={event.evidenceHref}>
                    {event.evidenceName}
                  </a>
                )
              ) : null}
              <span className="vg-timeline__position" data-timeline-position="true">
                {position}
              </span>
            </li>
          );
        })}
      </ol>
      {announcement === undefined ? null : (
        <p className="vg-timeline__announcement" role="status" aria-live="polite" data-timeline-announcement="true">
          {announcement}
        </p>
      )}
    </section>
  );
}
