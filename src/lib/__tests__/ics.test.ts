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

describe("ALI-196 rider 4 — a lone carriage return is escaped, not passed through", () => {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);

  /** The document's own line structure, which CRLF defines. */
  function descriptionLines(document: string): string[] {
    return document.split(CR + LF).filter((line) => line.startsWith("DESCRIPTION:"));
  }

  const base = {
    uid: "b1@example.test",
    start: "2026-09-01T10:00:00.000Z",
    end: "2026-09-01T10:30:00.000Z",
    summary: "Interview",
  };

  // The bug: /\r?\n/ requires the LF, so a bare CR never matched and reached
  // DESCRIPTION as a raw control character — splitting a line in a format
  // defined in terms of CRLF-delimited lines.
  it("escapes a bare CR in guest notes", () => {
    const document = buildIcs({
      ...base,
      description: "before" + CR + "after",
    });

    expect(document).not.toContain("before" + CR + "after");
    expect(descriptionLines(document)).toHaveLength(1);
    expect(descriptionLines(document)[0]).toContain("before\\nafter");
  });

  it("still escapes CRLF and a bare LF", () => {
    const crlf = buildIcs({ ...base, description: "a" + CR + LF + "b" });
    const lf = buildIcs({ ...base, description: "a" + LF + "b" });

    // One \n escape for CRLF, not two: the pair is one line break.
    expect(descriptionLines(crlf)[0]).toBe("DESCRIPTION:a\\nb");
    expect(descriptionLines(lf)[0]).toBe("DESCRIPTION:a\\nb");
  });

  // The whole document must carry no control characters other than the CRLFs
  // that delimit its own lines.
  it("leaves no stray control character anywhere in the document", () => {
    const document = buildIcs({
      ...base,
      description: "x" + CR + "y",
      location: "z" + CR + "w",
    });

    expect(document.split(CR + LF).join("")).not.toContain(CR);
  });
});
