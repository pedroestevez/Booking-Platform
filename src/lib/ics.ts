/**
 * Minimal RFC 5545 (iCalendar) builder — no dependencies, runs on client and
 * server. Kept framework-free so the booking confirmation can offer a download
 * today and the confirmation email (ALI-69) attaches the very same invite.
 */

/**
 * The right-hand side of every `UID` this codebase emits.
 *
 * One constant because the same booking is now serialized to iCalendar by two
 * emitters — the guest's "Add to calendar" download and the confirmation email
 * (ALI-69) — and `UID` is what a calendar client uses to decide whether it is
 * looking at a new event or an update to one it already has. Two spellings for
 * one booking means the guest who both clicks the button and opens the email
 * ends up with the appointment twice.
 */
export const ICS_UID_DOMAIN = "booking-platform";

/** The `UID` for a booking, stable across every emitter. */
export function icsUid(bookingId: string): string {
  return `${bookingId}@${ICS_UID_DOMAIN}`;
}

/**
 * A start or end that does not name a real instant (ALI-69 AC5).
 *
 * Distinctly named so the email path can tell "this invite is unbuildable" from
 * any other failure and refuse the send, rather than attaching a document whose
 * `DTSTART` reads `NaNNaNNaNTNaNNaNNaNZ`. An email cannot be recalled, so the
 * only safe direction is to not send one.
 */
export class InvalidIcsInstantError extends Error {
  readonly name = "InvalidIcsInstantError";

  constructor(readonly value: string) {
    super(`Not a valid calendar instant: ${JSON.stringify(value)}`);
  }
}

export interface IcsEvent {
  /** Globally-unique id for the event (e.g. the booking id). */
  uid: string;
  /** ISO 8601 instant for the start. */
  start: string;
  /** ISO 8601 instant for the end. */
  end: string;
  /** Short title, e.g. "Standard Session with Northwind Therapy". */
  summary: string;
  /** Optional longer description (guest, notes). */
  description?: string;
  /** Optional location (e.g. the business name or address). */
  location?: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Format an ISO instant as iCalendar UTC date-time, e.g. 20260623T143000Z.
 *
 * Throws `InvalidIcsInstantError` rather than formatting an invalid `Date`
 * (ALI-69 AC5). `new Date("not-a-date")` is not an error in JavaScript, it is a
 * `Date` whose every getter returns `NaN` — so before this guard the template
 * literal below happily produced the string `"NaNNaNNaNTNaNNaNNaNZ"` and put it
 * in `DTSTART`. Failing here is the only place the difference can still be
 * acted on: one line later it is an ordinary string in a valid-looking
 * VCALENDAR, and by the time it is an attachment it is in someone's inbox.
 */
function toIcsUtc(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) throw new InvalidIcsInstantError(iso);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Escape per RFC 5545 §3.3.11 (backslash, semicolon, comma, newline).
 *
 * The alternation matches a lone `\r` as well as `\r\n` and `\n`. `/\r?\n/`
 * could not: it requires the `\n`, so a bare carriage return in guest `notes`
 * survived into `DESCRIPTION` as a raw control character, splitting the line in
 * a document that is defined in terms of CRLF-delimited lines (ALI-196
 * rider 4). Parser-dependent rather than a demonstrated forgery, and wrong
 * either way.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Build a single-event VCALENDAR document with CRLF line endings. */
export function buildIcs(event: IcsEvent): string {
  const stamp = toIcsUtc(new Date().toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Booking Platform//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${toIcsUtc(event.start)}`,
    `DTEND:${toIcsUtc(event.end)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    ...(event.description
      ? [`DESCRIPTION:${escapeText(event.description)}`]
      : []),
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

/** A filesystem-safe .ics filename derived from a label. */
export function icsFilename(label: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "booking";
  return `${slug}.ics`;
}
