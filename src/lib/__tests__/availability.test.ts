import { describe, expect, it } from "vitest";

import {
  assertIanaTimeZone,
  availableWeekdays,
  civilDateInTimeZone,
  generateDaySlots,
  instantForCivilDate,
  InvalidTimeZoneError,
  weekdayInTimeZone,
  type CivilDate,
} from "@/lib/availability";
import type {
  AvailabilityRule,
  BlockedSlot,
  Booking,
  TimeSlot,
} from "@/lib/types";

/**
 * Tests for the slot engine — the one piece of genuinely non-trivial domain
 * logic in the app. It turns weekly recurring rules into concrete bookable
 * slots, subtracting blocked windows and existing bookings (each padded by the
 * rule's buffer), then dedupes and sorts.
 *
 * ## What changed here, and why the old shape proved nothing (ALI-117)
 *
 * Every case below now passes an **explicit** `timeZone`. Before, the times
 * were UTC "because the npm script pins `TZ=UTC`" — which meant this suite
 * inherited the very assumption the fix removes. A green run under `TZ=UTC`
 * cannot distinguish an engine that reads the tenant's zone from one that reads
 * the server's, because under that pin the two agree on every input.
 *
 * So the suite is run twice: pinned (`npm test`) and under a **hostile** process
 * zone (`npm run test:tz`, `TZ=Pacific/Kiritimati`, UTC+14 — neither UTC nor any
 * zone appearing in these fixtures). `npm test` chains both. Any assertion below
 * that quietly depended on the process zone fails one of the two runs.
 *
 * Nothing in this file reads an ambient clock. `starts()` slices ISO-8601 UTC
 * text; `localStarts()` formats through an explicit `timeZone`. Neither
 * `Date#getHours` nor `Date#getDay` appears.
 *
 * ## The cases that have teeth
 *
 * The DST blocks. A `09:00–17:00` rule on a transition date exercises nothing —
 * the transition happens at 02:00 and never touches the window — so it passes
 * while the arithmetic is wrong, on 365 days a year. Every DST fixture here uses
 * a rule that **spans** the transition, and each one records what a wrong
 * implementation would have emitted instead.
 */

const TENANT = "11111111-1111-1111-1111-111111111111";

const NEW_YORK = "America/New_York";
const AUCKLAND = "Pacific/Auckland";

/** 2026-08-17 is a Monday — `dayOfWeek` 1. Asserted below so a wrong date fails loudly. */
const MONDAY = new Date("2026-08-17T00:00:00.000Z");

/** An instant before every slot in these fixtures, so nothing is filtered as "past". */
const BEFORE_ALL = new Date("2026-08-17T00:00:00.000Z");

/** Before every DST fixture below, all of which sit in 2026. */
const BEFORE_2026 = new Date("2025-12-31T00:00:00.000Z");

function rule(
  startTime: string,
  endTime: string,
  bufferMinutes = 0,
  dayOfWeek = 1,
  id = "rule-1",
): AvailabilityRule {
  return { id, customerId: TENANT, dayOfWeek, startTime, endTime, bufferMinutes };
}

function booking(start: string, end: string, status: Booking["status"] = "confirmed"): Booking {
  return {
    id: `booking-${start}`,
    customerId: TENANT,
    serviceId: "service-1",
    endCustomerId: "end-customer-1",
    start: `2026-08-17T${start}:00.000Z`,
    end: `2026-08-17T${end}:00.000Z`,
    status,
    customFields: {},
  };
}

function blocked(start: string, end: string): BlockedSlot {
  return {
    id: `blocked-${start}`,
    customerId: TENANT,
    start: `2026-08-17T${start}:00.000Z`,
    end: `2026-08-17T${end}:00.000Z`,
  };
}

/** Slot starts as UTC "HH:mm", for readable assertions. */
function starts(slots: { start: string }[]): string[] {
  return slots.map((s) => s.start.slice(11, 16));
}

/** Slot starts as the wall clock reads them **in `timeZone`** — the round trip. */
function localStarts(slots: TimeSlot[], timeZone: string): string[] {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
  return slots.map((s) => formatter.format(new Date(s.start)));
}

/** The first and last slot, refusing an empty list rather than reading `undefined`. */
function ends(slots: TimeSlot[]): { first: TimeSlot; last: TimeSlot } {
  const first = slots.at(0);
  const last = slots.at(-1);
  if (!first || !last) throw new Error("expected at least one slot");
  return { first, last };
}

/** Real elapsed hours from the first slot's start to the last slot's end. */
function spanHours(slots: TimeSlot[]): number {
  const { first, last } = ends(slots);
  return (Date.parse(last.end) - Date.parse(first.start)) / 3_600_000;
}

// ─────────────────────────────────────────────────────────────────────────────
// The pre-existing case families, re-expressed with an explicit zone (AC6).
//
// Every assertion is the one it was before. `timeZone: "UTC"` is what the
// `TZ=UTC` pin used to supply implicitly, so these still describe exactly the
// same behaviour — the difference is that they now say so, and therefore hold
// under any process zone.
// ─────────────────────────────────────────────────────────────────────────────

describe("generateDaySlots", () => {
  it("uses a Monday fixture (guards every dayOfWeek assertion below)", () => {
    expect(weekdayInTimeZone(MONDAY, "UTC")).toBe(1);
  });

  it("generates slots across the window and stops when a slot would overrun it", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "12:00")],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      now: BEFORE_ALL,
    });

    // 11:00 + 60min lands exactly on 12:00 and is kept; 11:30 would overrun.
    expect(starts(slots)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00"]);
  });

  it("includes a slot whose end lands exactly on the window boundary", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "10:00")],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      now: BEFORE_ALL,
    });

    expect(starts(slots)).toEqual(["09:00"]);
  });

  it("returns nothing when no rule matches the weekday", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "17:00", 0, 3)], // Wednesday only
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      now: BEFORE_ALL,
    });

    expect(slots).toEqual([]);
  });

  it("returns an empty list, rather than throwing, on a day with no rules at all", () => {
    expect(
      generateDaySlots({
        day: MONDAY,
        rules: [],
        service: { durationMinutes: 60 },
        timeZone: "UTC",
        now: BEFORE_ALL,
      }),
    ).toEqual([]);
  });

  it("excludes slots overlapping a blocked window", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "13:00")],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      blocked: [blocked("10:00", "11:00")],
      now: BEFORE_ALL,
    });

    // 09:30, 10:00, 10:30 all intersect 10:00–11:00; everything after 11:00 is free.
    expect(starts(slots)).toEqual(["09:00", "11:00", "11:30", "12:00"]);
  });

  it("excludes slots around a blocked window that falls wholly inside the rule", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "13:00")],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      blocked: [blocked("10:15", "10:45")],
      now: BEFORE_ALL,
    });

    // The block is strictly interior, so it takes out every slot touching it —
    // and nothing outside 09:15–11:45 worth of coverage.
    expect(starts(slots)).toEqual(["09:00", "11:00", "11:30", "12:00"]);
  });

  it("excludes slots overlapping a block that only partially overlaps the rule", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "13:00")],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      // Starts before the window opens and reaches into it.
      blocked: [blocked("07:00", "10:00")],
      now: BEFORE_ALL,
    });

    expect(starts(slots)).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00"]);
  });

  it("clears the day when a blocked window exactly matches the rule", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "13:00")],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      blocked: [blocked("09:00", "13:00")],
      now: BEFORE_ALL,
    });

    expect(slots).toEqual([]);
  });

  it("excludes slots overlapping an existing booking padded by the rule's buffer", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "13:00", 15)],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      bookings: [booking("10:00", "11:00")],
      now: BEFORE_ALL,
    });

    // Booking is padded to 09:45–11:15, so everything from 09:00 to 11:00 clashes.
    expect(starts(slots)).toEqual(["11:30", "12:00"]);
  });

  it("pads a booking on BOTH sides, not just after it", () => {
    // A 60-minute buffer around an 11:00–12:00 booking blocks 10:00–13:00. The
    // discriminating half is the slot *before*: 09:30–10:30 does not touch the
    // booking itself and is excluded only because the buffer reaches backwards.
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("08:00", "15:00", 60)],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      bookings: [booking("11:00", "12:00")],
      now: BEFORE_ALL,
    });

    expect(starts(slots)).toContain("09:00"); // ends 10:00, touches the pad's edge
    expect(starts(slots)).not.toContain("09:30"); // before the booking — pad reaches back
    expect(starts(slots)).not.toContain("12:00"); // after the booking — pad reaches forward
    expect(starts(slots)).toContain("13:00"); // starts on the pad's far edge
  });

  it("allows back-to-back bookings when the buffer is zero", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "13:00", 0)],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      bookings: [booking("10:00", "11:00")],
      now: BEFORE_ALL,
    });

    // 09:00–10:00 and 11:00–12:00 touch the booking but do not overlap it.
    expect(starts(slots)).toContain("09:00");
    expect(starts(slots)).toContain("11:00");
    expect(starts(slots)).not.toContain("10:00");
  });

  it("excludes slots that start before `now`", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "13:00")],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      now: new Date("2026-08-17T10:15:00.000Z"),
    });

    expect(starts(slots)).toEqual(["10:30", "11:00", "11:30", "12:00"]);
  });

  it("collapses duplicate slots produced by two overlapping rules", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [
        rule("09:00", "12:00", 0, 1, "rule-a"),
        rule("09:00", "12:00", 0, 1, "rule-b"),
      ],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      now: BEFORE_ALL,
    });

    expect(starts(slots)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00"]);
    expect(new Set(starts(slots)).size).toBe(slots.length);
  });

  it("returns slots in chronological order when rules are supplied out of order", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [
        rule("14:00", "16:00", 0, 1, "afternoon"),
        rule("09:00", "11:00", 0, 1, "morning"),
      ],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      now: BEFORE_ALL,
    });

    expect(starts(slots)).toEqual(["09:00", "09:30", "10:00", "14:00", "14:30", "15:00"]);
  });

  it("honours a custom stepMinutes cadence", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "11:00")],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      stepMinutes: 15,
      now: BEFORE_ALL,
    });

    expect(starts(slots)).toEqual(["09:00", "09:15", "09:30", "09:45", "10:00"]);
  });

  it("blocks on every booking it is given — status filtering is the caller's job", () => {
    // Documents where the responsibility lives: `getUpcomingBookings` in
    // src/lib/tenants.ts filters to status <> 'cancelled'. This pure function
    // deliberately does not re-check status, so passing a cancelled booking here
    // still blocks the slot.
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "12:00")],
      service: { durationMinutes: 60 },
      timeZone: "UTC",
      bookings: [booking("09:00", "10:00", "cancelled")],
      now: BEFORE_ALL,
    });

    expect(starts(slots)).not.toContain("09:00");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — timezone-explicit, and process-timezone-independent
// ─────────────────────────────────────────────────────────────────────────────

describe("AC1: slots are absolute instants derived from the tenant's zone", () => {
  /**
   * ⚠️ The issue body's AC1 transposes its two example instants. It reads
   * "13:00Z … in winter (EST, UTC−5) and 14:00Z … in summer (EDT, UTC−4)", but
   * the arithmetic runs the other way and the parenthetical offsets are the
   * correct half:
   *
   *     09:00 EST (UTC−5) → 09:00 + 5h = 14:00Z   (winter)
   *     09:00 EDT (UTC−4) → 09:00 + 4h = 13:00Z   (summer)
   *
   * The behaviour AC1 specifies is not in doubt — same wall clock, two different
   * instants an hour apart, tracking the tenant's actual offset — and tzdata
   * leaves no freedom about which is which. Asserted correctly here; flagged on
   * the issue rather than silently reinterpreted.
   */
  const NINE_TO_NOON = [rule("09:00", "12:00")];

  it("resolves a winter Monday against EST (UTC−5)", () => {
    const slots = generateDaySlots({
      // 2026-01-05 is a Monday. The instant is midday UTC, which is the 5th in
      // New York either way — the point is that the *rule* is read in the zone.
      day: new Date("2026-01-05T12:00:00.000Z"),
      rules: NINE_TO_NOON,
      service: { durationMinutes: 60 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });

    expect(slots.map((s) => s.start)).toEqual([
      "2026-01-05T14:00:00.000Z",
      "2026-01-05T14:30:00.000Z",
      "2026-01-05T15:00:00.000Z",
      "2026-01-05T15:30:00.000Z",
      "2026-01-05T16:00:00.000Z",
    ]);
    expect(localStarts(slots, NEW_YORK)[0]).toBe("09:00");
  });

  it("resolves a summer Monday against EDT (UTC−4) — one hour earlier in UTC", () => {
    const slots = generateDaySlots({
      day: new Date("2026-08-17T12:00:00.000Z"),
      rules: NINE_TO_NOON,
      service: { durationMinutes: 60 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });

    expect(slots.map((s) => s.start)).toEqual([
      "2026-08-17T13:00:00.000Z",
      "2026-08-17T13:30:00.000Z",
      "2026-08-17T14:00:00.000Z",
      "2026-08-17T14:30:00.000Z",
      "2026-08-17T15:00:00.000Z",
    ]);
    // Same wall clock the business configured, both times.
    expect(localStarts(slots, NEW_YORK)[0]).toBe("09:00");
  });

  it("changing only the tenant's zone changes every instant it offers", () => {
    const args = {
      day: new Date("2026-08-17T12:00:00.000Z"),
      rules: NINE_TO_NOON,
      service: { durationMinutes: 60 },
      now: BEFORE_2026,
    };
    const utc = generateDaySlots({ ...args, timeZone: "UTC" });
    const newYork = generateDaySlots({ ...args, timeZone: NEW_YORK });

    expect(starts(utc)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00"]);
    expect(starts(newYork)).toEqual(["13:00", "13:30", "14:00", "14:30", "15:00"]);
    expect(newYork.map((s) => s.start)).not.toEqual(utc.map((s) => s.start));
    // Same wall clock in each tenant's own zone — the invariant, both halves.
    expect(localStarts(utc, "UTC")).toEqual(localStarts(newYork, NEW_YORK));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — no silent fallback, in either direction
// ─────────────────────────────────────────────────────────────────────────────

describe("AC2: an unusable zone throws; it never falls back", () => {
  it("makes omitting `timeZone` a compile error", () => {
    // If `timeZone` ever gains a default or becomes optional, TypeScript reports
    // this directive as unused and `npm run typecheck` fails. That is the
    // criterion — "omitting it is a compile error" — checked by the compiler
    // rather than described in prose.
    const omitted = () =>
      // @ts-expect-error — `timeZone` is required and has no default.
      generateDaySlots({
        day: MONDAY,
        rules: [rule("09:00", "12:00")],
        service: { durationMinutes: 60 },
        now: BEFORE_ALL,
      });

    expect(omitted).toBeTypeOf("function");
  });

  it.each([
    ["a POSIX-ish string that is not a zone", "EST5EDT4"],
    ["a city that is not an IANA name", "Miami"],
    ["the empty string", ""],
    ["a fixed UTC offset, which has no DST rules", "+05:00"],
    ["a negative fixed offset", "-05:00"],
    ["whitespace", "   "],
  ])("throws InvalidTimeZoneError for %s", (_label, value) => {
    const call = () =>
      generateDaySlots({
        day: MONDAY,
        rules: [rule("09:00", "12:00")],
        service: { durationMinutes: 60 },
        timeZone: value,
        now: BEFORE_ALL,
      });

    expect(call).toThrow(InvalidTimeZoneError);
    // Distinctly named, so a caller can tell a misconfigured tenant from any
    // other failure without string-matching a message.
    expect(call).toThrow(/not a usable iana timezone name/i);
  });

  it("does NOT fall back to UTC, to the process zone, or to an empty list", () => {
    // The negative case in full. A wrong-but-plausible zone that silently
    // produced slots at the server's offset is the exact defect this issue
    // removes — and an empty list would be indistinguishable from a closed day,
    // which is why "return []" is not an acceptable answer either.
    let result: TimeSlot[] | undefined;
    let thrown: unknown;
    try {
      result = generateDaySlots({
        day: MONDAY,
        rules: [rule("09:00", "12:00")],
        service: { durationMinutes: 60 },
        timeZone: "Miami",
        now: BEFORE_ALL,
      });
    } catch (err) {
      thrown = err;
    }

    expect(result).toBeUndefined();
    expect(thrown).toBeInstanceOf(InvalidTimeZoneError);
    expect((thrown as InvalidTimeZoneError).timeZone).toBe("Miami");
  });

  it("throws even when the day has no matching rule, so a bad zone can't hide", () => {
    // Validation is unconditional and happens before the weekday filter. Were it
    // lazy, a misconfigured tenant would look exactly like a closed Sunday.
    expect(() =>
      generateDaySlots({
        day: MONDAY,
        rules: [],
        service: { durationMinutes: 60 },
        timeZone: "Miami",
        now: BEFORE_ALL,
      }),
    ).toThrow(InvalidTimeZoneError);
  });

  it("accepts the real IANA names the seed data uses", () => {
    for (const zone of [NEW_YORK, "America/Los_Angeles", AUCKLAND, "UTC"]) {
      expect(() => assertIanaTimeZone(zone)).not.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — weekday derived in the tenant zone, across the day boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("AC3: the weekday is the tenant's, on both sides of UTC", () => {
  /**
   * Two instants, chosen so each disagrees with the process clock in the
   * opposite direction. A sign error — adding the offset where it should be
   * subtracted — swaps them, so it cannot pass both.
   *
   *   2026-08-18T02:00Z  UTC/Kiritimati: Tue · New York: **Mon 22:00**
   *   2026-08-17T22:00Z  UTC: Mon        · Auckland:  **Tue 10:00**
   */
  const LATE_MONDAY_IN_NEW_YORK = new Date("2026-08-18T02:00:00.000Z");
  const EARLY_TUESDAY_IN_AUCKLAND = new Date("2026-08-17T22:00:00.000Z");

  it("reads a zone behind UTC: 02:00Z is still Monday in New York", () => {
    expect(weekdayInTimeZone(LATE_MONDAY_IN_NEW_YORK, NEW_YORK)).toBe(1);
    expect(weekdayInTimeZone(LATE_MONDAY_IN_NEW_YORK, "UTC")).toBe(2);
  });

  it("matches the Monday rule and not the Tuesday rule for a New York tenant", () => {
    const monday = generateDaySlots({
      day: LATE_MONDAY_IN_NEW_YORK,
      rules: [rule("09:00", "11:00", 0, 1, "monday")],
      service: { durationMinutes: 60 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });
    const tuesday = generateDaySlots({
      day: LATE_MONDAY_IN_NEW_YORK,
      rules: [rule("09:00", "11:00", 0, 2, "tuesday")],
      service: { durationMinutes: 60 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });

    // Monday 09:00 EDT — the 17th in New York, not the 18th.
    expect(monday.map((s) => s.start)).toEqual([
      "2026-08-17T13:00:00.000Z",
      "2026-08-17T13:30:00.000Z",
      "2026-08-17T14:00:00.000Z",
    ]);
    expect(tuesday).toEqual([]);
  });

  it("reads a zone ahead of UTC: 22:00Z is already Tuesday in Auckland", () => {
    expect(weekdayInTimeZone(EARLY_TUESDAY_IN_AUCKLAND, AUCKLAND)).toBe(2);
    expect(weekdayInTimeZone(EARLY_TUESDAY_IN_AUCKLAND, "UTC")).toBe(1);
  });

  it("matches the Tuesday rule and not the Monday rule for an Auckland tenant", () => {
    const tuesday = generateDaySlots({
      day: EARLY_TUESDAY_IN_AUCKLAND,
      rules: [rule("09:00", "11:00", 0, 2, "tuesday")],
      service: { durationMinutes: 60 },
      timeZone: AUCKLAND,
      now: BEFORE_2026,
    });
    const monday = generateDaySlots({
      day: EARLY_TUESDAY_IN_AUCKLAND,
      rules: [rule("09:00", "11:00", 0, 1, "monday")],
      service: { durationMinutes: 60 },
      timeZone: AUCKLAND,
      now: BEFORE_2026,
    });

    // Tuesday 09:00 NZST (UTC+12) — the 18th in Auckland, the 17th in UTC.
    expect(tuesday.map((s) => s.start)).toEqual([
      "2026-08-17T21:00:00.000Z",
      "2026-08-17T21:30:00.000Z",
      "2026-08-17T22:00:00.000Z",
    ]);
    expect(monday).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — spring forward: the nonexistent hour yields no slot
// ─────────────────────────────────────────────────────────────────────────────

describe("AC4: spring-forward skips the nonexistent hour", () => {
  /**
   * 2026-03-08 is the US spring-forward Sunday: New York clocks jump
   * 01:59:59 EST → 03:00:00 EDT, so **02:00–02:59 local does not exist**.
   *
   * The rule spans it. A `09:00–17:00` rule on this same date would pass while
   * the arithmetic was wrong, because the transition is at 02:00 and never
   * touches that window — which is the whole reason this fixture looks like
   * this.
   */
  const SPRING_FORWARD = new Date("2026-03-08T12:00:00.000Z"); // Sunday, dayOfWeek 0
  const OVERNIGHT = [rule("01:00", "05:00", 0, 0, "overnight")];

  it("emits no slot at a local time that does not exist", () => {
    const slots = generateDaySlots({
      day: SPRING_FORWARD,
      rules: OVERNIGHT,
      service: { durationMinutes: 60 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });

    // 02:00 and 02:30 are simply absent — not shifted onto 03:00, which would
    // offer a time the business did not choose and collide with the real 03:00.
    expect(localStarts(slots, NEW_YORK)).toEqual([
      "01:00",
      "01:30",
      "03:00",
      "03:30",
      "04:00",
    ]);
    expect(localStarts(slots, NEW_YORK)).not.toContain("02:00");
    expect(localStarts(slots, NEW_YORK)).not.toContain("02:30");
  });

  it("emits the 3 real hours in the window, not 4", () => {
    const transitionDay = generateDaySlots({
      day: SPRING_FORWARD,
      rules: OVERNIGHT,
      service: { durationMinutes: 60 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });
    // The following Sunday: same rule, same zone, no transition.
    const ordinaryDay = generateDaySlots({
      day: new Date("2026-03-15T12:00:00.000Z"),
      rules: OVERNIGHT,
      service: { durationMinutes: 60 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });

    // 01:00 EST = 06:00Z through 05:00 EDT = 09:00Z — three real hours.
    expect(transitionDay.map((s) => s.start)).toEqual([
      "2026-03-08T06:00:00.000Z",
      "2026-03-08T06:30:00.000Z",
      "2026-03-08T07:00:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "2026-03-08T08:00:00.000Z",
    ]);
    expect(spanHours(transitionDay)).toBe(3);
    expect(spanHours(ordinaryDay)).toBe(4);
    // A wrong implementation walks instants and emits the ordinary day's seven
    // slots here too, spanning four hours the clock never had.
    expect(transitionDay).toHaveLength(5);
    expect(ordinaryDay).toHaveLength(7);
  });

  it("round-trips: every emitted instant reads back as the wall clock it claims", () => {
    const slots = generateDaySlots({
      day: SPRING_FORWARD,
      rules: OVERNIGHT,
      service: { durationMinutes: 60 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });

    // Invariant (c). The 30-minute cadence must survive the round trip, which it
    // cannot if any instant was nudged off the grid to dodge the gap.
    for (const local of localStarts(slots, NEW_YORK)) {
      expect(local).toMatch(/^\d{2}:(00|30)$/);
    }
    expect(new Set(slots.map((s) => s.start)).size).toBe(slots.length);
  });

  it("skips the gap rather than shifting it, on a cadence the shift cannot hide in", () => {
    // The discriminating fixture for "skipped, not shifted".
    //
    // At a 30-minute cadence the two are nearly indistinguishable from outside:
    // a one-hour spring-forward shifts 02:00 → 03:00 and 02:30 → 03:30, both of
    // which are already in the set, so the de-dupe silently absorbs them and the
    // count comes out the same either way. That is exactly the kind of green a
    // wrong implementation earns.
    //
    // A 25-minute cadence does not divide the gap. Shifted, 02:15 and 02:40
    // land on 01:15 and 01:40 — off the grid the window start defines, and in
    // the set nowhere else. Skipping leaves the grid intact.
    const slots = generateDaySlots({
      day: SPRING_FORWARD,
      rules: OVERNIGHT,
      service: { durationMinutes: 30 },
      timeZone: NEW_YORK,
      stepMinutes: 25,
      now: BEFORE_2026,
    });

    expect(localStarts(slots, NEW_YORK)).toEqual([
      "01:00",
      "01:25",
      "01:50",
      "03:05",
      "03:30",
      "03:55",
      "04:20",
    ]);
    expect(slots.map((s) => s.start)).toEqual([
      "2026-03-08T06:00:00.000Z",
      "2026-03-08T06:25:00.000Z",
      "2026-03-08T06:50:00.000Z",
      "2026-03-08T07:05:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "2026-03-08T07:55:00.000Z",
      "2026-03-08T08:20:00.000Z",
    ]);
  });

  it("does not let a long service run past the window the clock never reached", () => {
    // Four wall-clock hours are only three real hours today, so a 240-minute
    // booking starting at 01:00 would end at 06:00 local — an hour after the
    // business stopped taking appointments.
    const transitionDay = generateDaySlots({
      day: SPRING_FORWARD,
      rules: OVERNIGHT,
      service: { durationMinutes: 240 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });
    const ordinaryDay = generateDaySlots({
      day: new Date("2026-03-15T12:00:00.000Z"),
      rules: OVERNIGHT,
      service: { durationMinutes: 240 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });

    expect(transitionDay).toEqual([]);
    expect(ordinaryDay.map((s) => s.end)).toEqual(["2026-03-15T09:00:00.000Z"]);
  });

  it("closes a window whose own end time falls inside the gap", () => {
    // A rule ending at 02:30 names a time that never arrives. The window closes
    // when the clock next reads 02:30 or later — i.e. when the gap ends, 03:00.
    const slots = generateDaySlots({
      day: SPRING_FORWARD,
      rules: [rule("01:00", "02:30", 0, 0, "ends-in-the-gap")],
      service: { durationMinutes: 30 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });

    expect(slots.map((s) => s.start)).toEqual([
      "2026-03-08T06:00:00.000Z",
      "2026-03-08T06:30:00.000Z",
    ]);
    expect(ends(slots).last.end).toBe("2026-03-08T07:00:00.000Z");
  });

  it("applies the same rule in the southern hemisphere, where the dates differ", () => {
    // Auckland springs forward on 2026-09-27: 02:00 NZST → 03:00 NZDT. Proof the
    // engine reads tzdata rather than hard-coding the US calendar.
    const slots = generateDaySlots({
      day: new Date("2026-09-27T00:00:00.000Z"), // 13:00 NZDT, Sunday the 27th
      rules: [rule("01:00", "05:00", 0, 0, "nz-overnight")],
      service: { durationMinutes: 60 },
      timeZone: AUCKLAND,
      now: BEFORE_2026,
    });

    expect(localStarts(slots, AUCKLAND)).toEqual([
      "01:00",
      "01:30",
      "03:00",
      "03:30",
      "04:00",
    ]);
    expect(slots.map((s) => s.start)).toEqual([
      "2026-09-26T13:00:00.000Z",
      "2026-09-26T13:30:00.000Z",
      "2026-09-26T14:00:00.000Z",
      "2026-09-26T14:30:00.000Z",
      "2026-09-26T15:00:00.000Z",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — fall back: the doubled hour yields exactly one slot
// ─────────────────────────────────────────────────────────────────────────────

describe("AC5: fall-back emits the doubled hour once, at its first occurrence", () => {
  /**
   * 2026-11-01 is the US fall-back Sunday: New York clocks repeat
   * 01:00:00–01:59:59, first as EDT (UTC−4) and again as EST (UTC−5). The rule
   * spans the transition for the same reason AC4's does.
   */
  const FALL_BACK = new Date("2026-11-01T12:00:00.000Z"); // Sunday, dayOfWeek 0
  const OVERNIGHT = [rule("01:00", "05:00", 0, 0, "overnight")];

  function fallBackSlots(): TimeSlot[] {
    return generateDaySlots({
      day: FALL_BACK,
      rules: OVERNIGHT,
      service: { durationMinutes: 60 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });
  }

  it("resolves the ambiguous local time to the earlier occurrence", () => {
    const slots = fallBackSlots();

    // 01:00 EDT is 05:00Z. 01:00 EST — the second time the clock reads 01:00 —
    // is 06:00Z, and is never offered. Choosing the later one would move a real
    // appointment an hour without telling anybody.
    expect(ends(slots).first.start).toBe("2026-11-01T05:00:00.000Z");
    expect(slots.map((s) => s.start)).not.toContain("2026-11-01T06:00:00.000Z");
    expect(slots.map((s) => s.start)).not.toContain("2026-11-01T06:30:00.000Z");
  });

  it("emits each start exactly once, as an instant and as a wall clock", () => {
    const slots = fallBackSlots();
    const instants = slots.map((s) => s.start);
    const local = localStarts(slots, NEW_YORK);

    // Unique as instants — the weaker of the two claims, and the one a naive
    // implementation still satisfies while double-booking the repeated hour.
    expect(new Set(instants).size).toBe(instants.length);
    // Unique as wall-clock labels — this is the one that catches it. Emitting
    // the doubled hour twice shows up here as two "01:00"s an hour apart.
    expect(new Set(local).size).toBe(local.length);
    expect(local).toEqual([
      "01:00",
      "01:30",
      "02:00",
      "02:30",
      "03:00",
      "03:30",
      "04:00",
    ]);
  });

  it("covers the 5 real hours the window lasts today, not 4", () => {
    const transitionDay = fallBackSlots();
    const ordinaryDay = generateDaySlots({
      day: new Date("2026-11-08T12:00:00.000Z"), // the following Sunday
      rules: OVERNIGHT,
      service: { durationMinutes: 60 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });

    // 01:00 EDT = 05:00Z through 05:00 EST = 10:00Z — five real hours.
    expect(transitionDay.map((s) => s.start)).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T07:30:00.000Z",
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T08:30:00.000Z",
      "2026-11-01T09:00:00.000Z",
    ]);
    expect(spanHours(transitionDay)).toBe(5);
    expect(spanHours(ordinaryDay)).toBe(4);
    // The window really does close at the wall clock the rule named. An
    // instant-walking implementation stops an hour early, at 09:00Z.
    expect(ends(transitionDay).last.end).toBe("2026-11-01T10:00:00.000Z");
    expect(localStarts(transitionDay, NEW_YORK)).toEqual(
      localStarts(ordinaryDay, NEW_YORK),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 (b) — the same answers under any process timezone
// ─────────────────────────────────────────────────────────────────────────────

describe("AC6: the process timezone changes nothing", () => {
  it("does not consult the ambient clock for any fixture in this file", () => {
    // The whole file is the assertion — it runs under `TZ=UTC` (`npm test`) and
    // again under `TZ=Pacific/Kiritimati` (`npm run test:tz`, UTC+14, chained
    // into `npm test` so CI cannot take one without the other). This case just
    // records what the harness is doing, so a reader of a single job log can see
    // which of the two runs they are looking at.
    const processZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown";
    expect(typeof processZone).toBe("string");

    // Whatever it is, a New York tenant's 09:00 is 13:00Z on this August Monday.
    const slots = generateDaySlots({
      day: new Date("2026-08-17T12:00:00.000Z"),
      rules: [rule("09:00", "10:00")],
      service: { durationMinutes: 60 },
      timeZone: NEW_YORK,
      now: BEFORE_2026,
    });
    expect(slots.map((s) => s.start)).toEqual(["2026-08-17T13:00:00.000Z"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — the grid's offered set equals the write path's re-validated set
// ─────────────────────────────────────────────────────────────────────────────

describe("AC7: no ghost slots — the grid and the write path agree", () => {
  /**
   * Invariant (d), in the form the two call sites actually take:
   *
   *   • the guest grid calls `generateDaySlots({ day: selectedDay, … })`
   *   • `createBooking` re-validates with `day: new Date(slot.start)`
   *
   * So for every slot the grid offers, re-deriving the day from *that slot's own
   * instant* must reproduce the identical set. If it does not, the guest is
   * offered a time the write path then refuses.
   *
   * (The other half of AC7 — that the zone reaching `createBooking` is resolved
   * server-side from `customerId` and never from the request — needs the write
   * path itself, and lives in `booking-timezone-scope.test.ts`.)
   */
  function offeredThenRevalidated(day: Date, timeZone: string, rules: AvailabilityRule[]) {
    const args = {
      rules,
      service: { durationMinutes: 60 },
      timeZone,
      now: BEFORE_2026,
    };
    const offered = generateDaySlots({ ...args, day });
    const revalidated = offered.map((slot) =>
      generateDaySlots({ ...args, day: new Date(slot.start) }),
    );
    return { offered, revalidated };
  }

  it.each([
    ["an ordinary day", new Date("2026-08-17T12:00:00.000Z"), NEW_YORK, 1],
    ["the spring-forward day", new Date("2026-03-08T12:00:00.000Z"), NEW_YORK, 0],
    ["the fall-back day", new Date("2026-11-01T12:00:00.000Z"), NEW_YORK, 0],
    ["an Auckland transition day", new Date("2026-09-27T00:00:00.000Z"), AUCKLAND, 0],
  ])("re-validating any offered slot reproduces the same set on %s", (_label, day, zone, weekday) => {
    const { offered, revalidated } = offeredThenRevalidated(day, zone, [
      rule("01:00", "05:00", 0, weekday, "overnight"),
      rule("09:00", "12:00", 0, weekday, "morning"),
    ]);

    expect(offered.length).toBeGreaterThan(0);
    for (const set of revalidated) {
      expect(set).toEqual(offered);
    }
  });

  it("the grid dims a day exactly when the engine has nothing to offer on it", () => {
    // `isDayBookable` uses `weekdayInTimeZone`; the engine filters rules by the
    // weekday from the same function. Sharing it is what makes them agree by
    // construction rather than by two implementations that happen to match.
    const rules = [rule("09:00", "12:00", 0, 1, "monday-only")];
    const openWeekdays = availableWeekdays(rules);

    for (const iso of [
      "2026-08-17T02:00:00.000Z", // Sun 22:00 in New York
      "2026-08-18T02:00:00.000Z", // Mon 22:00 in New York
      "2026-08-19T02:00:00.000Z", // Tue 22:00 in New York
    ]) {
      const day = new Date(iso);
      const gridSaysBookable = openWeekdays.has(weekdayInTimeZone(day, NEW_YORK));
      const engineOffers =
        generateDaySlots({
          day,
          rules,
          service: { durationMinutes: 60 },
          timeZone: NEW_YORK,
          now: BEFORE_2026,
        }).length > 0;

      expect(gridSaysBookable).toBe(engineOffers);
    }
  });
});

describe("instantForCivilDate lands on the day it was asked for", () => {
  /**
   * The contract, pinned over the zones that make it hard (ALI-117 N4).
   *
   * These five are the complete set — measured over all 418 zones
   * `Intl.supportedValuesOf("timeZone")` reports, across every date in 2026 — for
   * which **local midnight does not exist** on some date, because they shift at
   * midnight itself. No zone lacks a local noon.
   *
   * This does *not* pin the midday anchor, and is deliberately not written to:
   * the fallback scan rescues a midnight anchor too, so changing `12 * 60` to `0`
   * leaves this green. That is recorded honestly rather than papered over with an
   * assertion that would only look discriminating. What it does pin is the thing
   * a caller actually relies on — that the instant comes back on the requested
   * calendar date — which fails the moment the anchor moves to a nonexistent time
   * *and* the fallback stops covering for it.
   */
  const MIDNIGHT_SKIPPING_ZONES: [string, CivilDate][] = [
    ["Africa/Cairo", { year: 2026, month: 4, day: 24 }],
    ["America/Havana", { year: 2026, month: 3, day: 8 }],
    ["America/Santiago", { year: 2026, month: 9, day: 6 }],
    ["Asia/Beirut", { year: 2026, month: 3, day: 29 }],
    ["Atlantic/Azores", { year: 2026, month: 3, day: 29 }],
  ];

  it.each(MIDNIGHT_SKIPPING_ZONES)(
    "%s has no local midnight on its transition date, and still resolves",
    (zone, date) => {
      const instant = instantForCivilDate(date, zone);
      expect(civilDateInTimeZone(instant, zone)).toEqual(date);
    },
  );

  it("round-trips ordinary dates in ordinary zones too", () => {
    for (const zone of [NEW_YORK, AUCKLAND, "UTC", "Asia/Kathmandu"]) {
      for (const date of [
        { year: 2026, month: 1, day: 1 },
        { year: 2026, month: 3, day: 8 },
        { year: 2026, month: 8, day: 17 },
        { year: 2026, month: 11, day: 1 },
        { year: 2026, month: 12, day: 31 },
      ]) {
        expect(civilDateInTimeZone(instantForCivilDate(date, zone), zone)).toEqual(date);
      }
    }
  });

  it("refuses an unusable zone rather than guessing a day", () => {
    expect(() =>
      instantForCivilDate({ year: 2026, month: 8, day: 17 }, "Miami"),
    ).toThrow(InvalidTimeZoneError);
  });
});

describe("availableWeekdays", () => {
  it("returns the distinct weekdays covered by the rules", () => {
    const weekdays = availableWeekdays([
      rule("09:00", "12:00", 0, 1, "mon"),
      rule("13:00", "17:00", 0, 1, "mon-afternoon"),
      rule("09:00", "12:00", 0, 5, "fri"),
    ]);

    expect([...weekdays].sort()).toEqual([1, 5]);
  });

  it("returns an empty set when there are no rules", () => {
    expect(availableWeekdays([]).size).toBe(0);
  });
});
