import { describe, expect, it } from "vitest";

import { availableWeekdays, generateDaySlots } from "@/lib/availability";
import type { AvailabilityRule, BlockedSlot, Booking } from "@/lib/types";

/**
 * Tests for the slot engine — the one piece of genuinely non-trivial domain
 * logic in the app. It turns weekly recurring rules into concrete bookable
 * slots, subtracting blocked windows and existing bookings (each padded by the
 * rule's buffer), then dedupes and sorts.
 *
 * All times are UTC because the npm script pins `TZ=UTC` (see vitest.config.ts).
 */

const TENANT = "11111111-1111-1111-1111-111111111111";

/** 2026-08-17 is a Monday — `dayOfWeek` 1. Asserted below so a wrong date fails loudly. */
const MONDAY = new Date("2026-08-17T00:00:00.000Z");

/** An instant before every slot in these fixtures, so nothing is filtered as "past". */
const BEFORE_ALL = new Date("2026-08-17T00:00:00.000Z");

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

/** Slot starts as "HH:mm", for readable assertions. */
function starts(slots: { start: string }[]): string[] {
  return slots.map((s) => s.start.slice(11, 16));
}

describe("generateDaySlots", () => {
  it("uses a Monday fixture (guards every dayOfWeek assertion below)", () => {
    expect(MONDAY.getDay()).toBe(1);
  });

  it("generates slots across the window and stops when a slot would overrun it", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "12:00")],
      service: { durationMinutes: 60 },
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
      now: BEFORE_ALL,
    });

    expect(starts(slots)).toEqual(["09:00"]);
  });

  it("returns nothing when no rule matches the weekday", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "17:00", 0, 3)], // Wednesday only
      service: { durationMinutes: 60 },
      now: BEFORE_ALL,
    });

    expect(slots).toEqual([]);
  });

  it("excludes slots overlapping a blocked window", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "13:00")],
      service: { durationMinutes: 60 },
      blocked: [blocked("10:00", "11:00")],
      now: BEFORE_ALL,
    });

    // 09:30, 10:00, 10:30 all intersect 10:00–11:00; everything after 11:00 is free.
    expect(starts(slots)).toEqual(["09:00", "11:00", "11:30", "12:00"]);
  });

  it("excludes slots overlapping an existing booking padded by the rule's buffer", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "13:00", 15)],
      service: { durationMinutes: 60 },
      bookings: [booking("10:00", "11:00")],
      now: BEFORE_ALL,
    });

    // Booking is padded to 09:45–11:15, so everything from 09:00 to 11:00 clashes.
    expect(starts(slots)).toEqual(["11:30", "12:00"]);
  });

  it("allows back-to-back bookings when the buffer is zero", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "13:00", 0)],
      service: { durationMinutes: 60 },
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
      now: BEFORE_ALL,
    });

    expect(starts(slots)).toEqual(["09:00", "09:30", "10:00", "14:00", "14:30", "15:00"]);
  });

  it("honours a custom stepMinutes cadence", () => {
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "11:00")],
      service: { durationMinutes: 60 },
      stepMinutes: 15,
      now: BEFORE_ALL,
    });

    expect(starts(slots)).toEqual(["09:00", "09:15", "09:30", "09:45", "10:00"]);
  });

  it("blocks on every booking it is given — status filtering is the caller's job", () => {
    // Documents where the responsibility lives: `getUpcomingBookings` in
    // src/lib/tenants.ts filters to status in (pending, confirmed). This pure
    // function deliberately does not re-check status, so passing a cancelled
    // booking here still blocks the slot.
    const slots = generateDaySlots({
      day: MONDAY,
      rules: [rule("09:00", "12:00")],
      service: { durationMinutes: 60 },
      bookings: [booking("09:00", "10:00", "cancelled")],
      now: BEFORE_ALL,
    });

    expect(starts(slots)).not.toContain("09:00");
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
