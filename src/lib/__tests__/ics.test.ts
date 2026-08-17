import { describe, expect, it } from "vitest";

import {
  ICS_UID_DOMAIN,
  InvalidIcsInstantError,
  buildIcs,
  icsFilename,
  icsUid,
} from "@/lib/ics";

/**
 * `buildIcs` refuses an instant it cannot format (ALI-69 AC5).
 *
 * Before this, `toIcsUtc("not-a-date")` returned the string
 * `"NaNNaNNaNTNaNNaNNaNZ"` — verified by execution, not inferred — and put it in
 * `DTSTART`. As a download that was a broken file the guest could delete. As an
 * email attachment it is an unopenable invite that cannot be recalled, which is
 * why the failure has to happen here, before anything is addressed.
 */

const VALID = {
  uid: icsUid("booking-1"),
  start: "2026-09-01T10:00:00.000Z",
  end: "2026-09-01T10:30:00.000Z",
  summary: "Interview with Northwind Therapy",
};

describe("buildIcs", () => {
  it("builds a CRLF-terminated VCALENDAR for a valid event", () => {
    const ics = buildIcs(VALID);

    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(/[^\r]\n/.test(ics)).toBe(false);
    expect(ics).toContain("DTSTART:20260901T100000Z");
    expect(ics).toContain("DTEND:20260901T103000Z");
  });

  it.each([
    ["not a date at all", "not-a-date"],
    ["an empty string", ""],
    ["a number that is not an instant", "Invalid Date"],
    ["a truncated ISO string", "2026-13-45T99:99:99Z"],
  ])("throws on a start that is %s", (_label, start) => {
    expect(() => buildIcs({ ...VALID, start })).toThrow(InvalidIcsInstantError);
  });

  it.each([
    ["not a date at all", "not-a-date"],
    ["an empty string", ""],
  ])("throws on an end that is %s", (_label, end) => {
    expect(() => buildIcs({ ...VALID, end })).toThrow(InvalidIcsInstantError);
  });

  // The regression, stated as the property rather than as one string: no output
  // of this function may ever contain `NaN`.
  it("never returns a document containing NaN", () => {
    for (const bad of ["not-a-date", "", "nonsense"]) {
      let out: string | null = null;
      try {
        out = buildIcs({ ...VALID, start: bad });
      } catch {
        // Refusing is the correct outcome.
      }
      expect(out).toBeNull();
    }
    expect(buildIcs(VALID)).not.toContain("NaN");
  });

  it("names the offending value without inventing a substitute", () => {
    const err = (() => {
      try {
        buildIcs({ ...VALID, start: "not-a-date" });
      } catch (e) {
        return e as InvalidIcsInstantError;
      }
      return null;
    })();

    expect(err).toBeInstanceOf(InvalidIcsInstantError);
    expect(err!.value).toBe("not-a-date");
    expect(err!.name).toBe("InvalidIcsInstantError");
  });

  it("still escapes text per RFC 5545 §3.3.11", () => {
    const ics = buildIcs({ ...VALID, summary: "A; B, C\\D\nE" });

    expect(ics).toContain("SUMMARY:A\\; B\\, C\\\\D\\nE");
  });
});

describe("icsUid", () => {
  // One UID per booking across both emitters — the download button and the
  // confirmation email — so a guest who uses both gets one appointment.
  it("is the booking id under the one shared domain", () => {
    expect(icsUid("booking-1")).toBe(`booking-1@${ICS_UID_DOMAIN}`);
    expect(icsUid("booking-1")).toContain("booking-1");
  });
});

describe("icsFilename", () => {
  it("slugifies a label into an .ics filename", () => {
    expect(icsFilename("Interview — 30 min-Northwind Therapy")).toBe(
      "interview-30-min-northwind-therapy.ics",
    );
  });

  it("falls back rather than producing a nameless file", () => {
    expect(icsFilename("!!!")).toBe("booking.ics");
  });
});
