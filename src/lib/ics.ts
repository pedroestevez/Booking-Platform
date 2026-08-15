/**
 * Minimal RFC 5545 (iCalendar) builder — no dependencies, runs on client and
 * server. Kept framework-free so the booking confirmation can offer a download
 * today and the confirmation email (ALI-69) can attach the very same invite.
 */

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

/** Format an ISO instant as iCalendar UTC date-time, e.g. 20260623T143000Z. */
function toIcsUtc(iso: string): string {
  const d = new Date(iso);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Escape per RFC 5545 §3.3.11 (backslash, semicolon, comma, newline). */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
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
