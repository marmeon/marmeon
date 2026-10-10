import { MailError } from './mailer.ts';
import type { Attachment } from './message.ts';

/** One calendar event (RFC 5545) — for `calendarEvent()`. */
export interface CalendarEvent {
  /** Stable across updates and cancellations of the same event, globally unique: `booking-42@app.example`. */
  readonly uid: string;
  readonly summary: string;
  readonly start: Date;
  /** Exclusive. For an all-day event: the day after the last day (default: one day). For a timed event: required. */
  readonly end?: Date;
  /** Dates without a time (`start`'s and `end`'s UTC calendar day). */
  readonly allDay?: boolean;
  readonly description?: string;
  readonly location?: string;
  /** An absolute link (from APP_URL). */
  readonly url?: string;
  readonly organizer?: { readonly address: string; readonly name?: string };
  /**
   * `PUBLISH` (default: an entry to add), `REQUEST` (an invitation — needs `organizer`) or `CANCEL` (with the same `uid`
   * and a higher `sequence`).
   */
  readonly method?: 'PUBLISH' | 'REQUEST' | 'CANCEL';
  /** The revision — raise it with every update of the same `uid` (default 0). */
  readonly sequence?: number;
  /** When this revision was made (`DTSTAMP`, default now). */
  readonly stamp?: Date;
  /** The attachment's file name (default `event.ics`). */
  readonly filename?: string;
}

/**
 * A calendar event as a mail attachment (`.ics`, RFC 5545) — for a mailable's `attachments()`. Text is escaped and
 * folded; a line break in a value that must be one line (a `uid`, an address, a link) is refused, so no value adds
 * properties to the calendar entry. See `docs/mail.md#attachments`.
 */
export function calendarEvent(event: CalendarEvent): Attachment {
  const method = event.method ?? 'PUBLISH';
  if (method === 'REQUEST' && !event.organizer) throw new MailError('An invitation (method REQUEST) needs an organizer.');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Marmeon//Mail//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${single(event.uid, 'uid')}`,
    `DTSTAMP:${dateTime(event.stamp ?? new Date(), 'stamp')}`,
    ...times(event),
    `SEQUENCE:${sequence(event.sequence ?? 0)}`,
    `SUMMARY:${text(event.summary)}`,
    ...(event.description === undefined ? [] : [`DESCRIPTION:${text(event.description)}`]),
    ...(event.location === undefined ? [] : [`LOCATION:${text(event.location)}`]),
    ...(event.url === undefined ? [] : [`URL:${link(event.url)}`]),
    ...(event.organizer ? [organizer(event.organizer)] : []),
    ...(method === 'CANCEL' ? ['STATUS:CANCELLED'] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return {
    filename: single(event.filename ?? 'event.ics', 'filename'),
    content: `${lines.map(fold).join('\r\n')}\r\n`,
    contentType: `text/calendar; charset=utf-8; method=${method}`,
  };
}

function times(event: CalendarEvent): string[] {
  if (event.allDay) {
    const end = event.end ?? new Date(event.start.getTime() + 86_400_000);
    if (end.getTime() <= event.start.getTime()) throw new MailError('A calendar event ends after it starts.');
    return [`DTSTART;VALUE=DATE:${date(event.start, 'start')}`, `DTEND;VALUE=DATE:${date(end, 'end')}`];
  }
  if (!event.end) throw new MailError('A calendar event with a time needs an end (or allDay: true).');
  if (event.end.getTime() <= event.start.getTime()) throw new MailError('A calendar event ends after it starts.');
  return [`DTSTART:${dateTime(event.start, 'start')}`, `DTEND:${dateTime(event.end, 'end')}`];
}

function valid(value: Date, what: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new MailError(`The calendar event's ${what} is not a valid date.`);
  return value;
}

/** `20261224T180000Z` — UTC. */
function dateTime(value: Date, what: string): string {
  return valid(value, what).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** `20261224` — the UTC calendar day. */
function date(value: Date, what: string): string {
  return valid(value, what).toISOString().slice(0, 10).replaceAll('-', '');
}

function sequence(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new MailError(`A calendar event's sequence is a whole number ≥ 0, not ${value}.`);
  return value;
}

/** TEXT (RFC 5545 3.3.11): backslash, semicolon, comma and line breaks escaped. */
function text(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

function single(value: string, what: string): string {
  if (/[\r\n]/.test(value) || value === '') throw new MailError(`The calendar event's ${what} must be a single, non-empty line.`);
  return value;
}

function link(value: string): string {
  single(value, 'url');
  if (!/^https?:\/\//i.test(value)) throw new MailError(`The calendar event's url must be an absolute http(s) link (from APP_URL), not "${value}".`);
  return value;
}

function organizer(value: { readonly address: string; readonly name?: string }): string {
  const address = single(value.address, 'organizer address');
  if (!/^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+$/.test(address)) throw new MailError(`Invalid organizer address "${address}".`);
  // A parameter value: quoted, without quotes and control characters.
  const name = value.name === undefined ? '' : `;CN="${single(value.name, 'organizer name').replace(/["\p{Cc}]/gu, '')}"`;
  return `ORGANIZER${name}:mailto:${address}`;
}

/** Lines longer than 75 octets are folded: a line break and a space, never inside a UTF-8 character. */
function fold(line: string): string {
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char);
    const limit = parts.length === 0 ? 75 : 74; // a continuation starts with a space
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}
