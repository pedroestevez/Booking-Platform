import { addMinutes, isBefore, parse, set } from "date-fns";

import type {
  AvailabilityRule,
  BlockedSlot,
  Booking,
  Service,
  TimeSlot,
} from "@/lib/types";

/**
 * Turn weekly availability rules into concrete, bookable time slots for a single
 * day, subtracting blocked windows and existing bookings (each padded by the
 * rule's buffer). This is a *pure* function so it can run on the server for SSR
 * and in the browser as the guest scrubs the calendar.
 *
 * NOTE: v0.1 treats times as the runtime's local time. Correct per-tenant
 * timezone handling (using `branding.timezone`) lands with the live data wiring;
 * the rule times are already stored tenant-local to make that swap clean.
 */

export interface GenerateSlotsArgs {
  day: Date;
  rules: AvailabilityRule[];
  service: Pick<Service, "durationMinutes">;
  blocked?: BlockedSlot[];
  bookings?: Booking[];
  /** Cadence the slot grid steps on, in minutes. */
  stepMinutes?: number;
  /** Slots starting before this instant are excluded (no booking in the past). */
  now?: Date;
}

function timeOnDay(day: Date, hhmm: string): Date {
  const parsed = parse(hhmm, "HH:mm", day);
  return set(day, {
    hours: parsed.getHours(),
    minutes: parsed.getMinutes(),
    seconds: 0,
    milliseconds: 0,
  });
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function generateDaySlots({
  day,
  rules,
  service,
  blocked = [],
  bookings = [],
  stepMinutes = 30,
  now = new Date(),
}: GenerateSlotsArgs): TimeSlot[] {
  const dayOfWeek = day.getDay();
  const dayRules = rules.filter((r) => r.dayOfWeek === dayOfWeek);
  if (dayRules.length === 0) return [];

  const slots: TimeSlot[] = [];

  for (const rule of dayRules) {
    const windowStart = timeOnDay(day, rule.startTime);
    const windowEnd = timeOnDay(day, rule.endTime);

    for (
      let start = windowStart;
      !isBefore(windowEnd, addMinutes(start, service.durationMinutes));
      start = addMinutes(start, stepMinutes)
    ) {
      const end = addMinutes(start, service.durationMinutes);

      // Can't book in the past.
      if (isBefore(start, now)) continue;

      // Respect one-off blocked windows.
      const isBlocked = blocked.some((b) =>
        overlaps(start, end, new Date(b.start), new Date(b.end)),
      );
      if (isBlocked) continue;

      // Respect existing bookings, padded by the rule's buffer on each side.
      const clashesBooking = bookings.some((bk) => {
        const bkStart = addMinutes(new Date(bk.start), -rule.bufferMinutes);
        const bkEnd = addMinutes(new Date(bk.end), rule.bufferMinutes);
        return overlaps(start, end, bkStart, bkEnd);
      });
      if (clashesBooking) continue;

      slots.push({ start: start.toISOString(), end: end.toISOString() });
    }
  }

  // De-dupe (overlapping rules) and order chronologically.
  const seen = new Set<string>();
  return slots
    .filter((s) => (seen.has(s.start) ? false : seen.add(s.start)))
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** Which weekdays (0–6) the tenant ever has availability — for calendar dimming. */
export function availableWeekdays(rules: AvailabilityRule[]): Set<number> {
  return new Set(rules.map((r) => r.dayOfWeek));
}
