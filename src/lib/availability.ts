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
 * ## Timezone contract (ALI-117)
 *
 * Every bookable slot is derived from the tenant's configured IANA timezone and
 * from no other clock. Changing the process timezone changes no slot this
 * function offers; changing `timeZone` changes every one of them.
 *
 *   • **In:** `timeZone` is a *required* IANA zone name. `day` is an instant,
 *     and the calendar date it names is the one that instant falls on **in
 *     `timeZone`** — so is the weekday matched against `rule.dayOfWeek`.
 *     `rule.startTime` / `rule.endTime` are wall-clock times in `timeZone`
 *     (`availability_rules.start_time` is a Postgres `time`, per `types.ts`).
 *   • **Out:** `TimeSlot.start` / `.end` stay ISO 8601 **UTC** instants. The
 *     storage boundary is unchanged, which is why `bookings.start_time`
 *     (`timestamptz`), the `bookings_no_overlap` exclusion constraint
 *     (migration 0006) and `ics.ts`'s `toIcsUtc` all keep working untouched.
 *
 * Nothing below reads `Date#getDay`, `#getHours`, `#getMinutes` or any other
 * accessor whose answer depends on `process.env.TZ`. Instant arithmetic is done
 * in epoch milliseconds; civil arithmetic is done on integers produced by
 * `Intl.DateTimeFormat` for `timeZone`. `Date.UTC` and `#getUTCDay` appear, and
 * are process-independent by definition.
 *
 * ## The two DST edges, and why they resolve the way they do
 *
 * | Local wall clock | Result |
 * | -- | -- |
 * | Does not exist (spring-forward gap, e.g. `02:30` US) | slot **skipped** — never shifted |
 * | Occurs twice (fall-back, e.g. `01:30` US) | the **first (earlier)** occurrence, exactly one slot |
 *
 * Both follow the same corollary: *the safe failure direction is offering fewer
 * slots, never offering a wrong instant.* A skipped nonexistent hour costs one
 * bookable slot. A shifted instant puts a real meeting in the wrong hour on two
 * real calendars, and emitting the doubled hour twice silently doubles the
 * day's capacity.
 *
 * Slot **starts** are therefore enumerated in wall-clock minutes and converted
 * one at a time, rather than by stepping an instant forward — stepping instants
 * walks the wall clock off by an hour the moment it crosses a transition.
 * Slot **durations** are real elapsed time (`start + durationMinutes`), because
 * a 60-minute meeting is 60 real minutes on both sides of a transition.
 */

/** How the caller learns that a configured zone is unusable. See `assertIanaTimeZone`. */
export class InvalidTimeZoneError extends Error {
  /** The rejected value, for logging. Not interpolated into user-facing copy. */
  readonly timeZone: string;

  constructor(timeZone: string) {
    super(
      `Not a usable IANA timezone name: ${JSON.stringify(timeZone)}. ` +
        `Slot generation has no default zone — see TenantBranding.timezone.`,
    );
    this.name = "InvalidTimeZoneError";
    this.timeZone = timeZone;
  }
}

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;

/**
 * `Intl.DateTimeFormat` construction is expensive and this runs per slot, so
 * formatters are memoised per zone. Bounded because the key is external data
 * (`branding_json.timezone`): tenant config, not a request value, but an
 * unbounded module-level map keyed by anything outside this file is a leak
 * waiting for its first careless call site.
 */
const FORMATTER_CACHE_LIMIT = 64;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * The formatter for `timeZone`, or `InvalidTimeZoneError` if there isn't one.
 *
 * Two rejections, and the second is the less obvious one:
 *
 *   1. `Intl` itself refuses the name (`"Miami"`, `"EST5EDT4"`, `""`).
 *   2. `Intl` accepts it but resolves it to a fixed **offset** rather than a
 *      zone (`"+05:00"`, `"-05:00"`). An offset is not an IANA zone: it has no
 *      DST rules, so a tenant configured `"-05:00"` would get correct Miami
 *      slots all winter and slots an hour wrong all summer — silently, which is
 *      precisely the defect this function exists to remove.
 */
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new InvalidTimeZoneError(timeZone);
  }

  const resolved = formatter.resolvedOptions().timeZone;
  if (resolved.startsWith("+") || resolved.startsWith("-")) {
    throw new InvalidTimeZoneError(timeZone);
  }

  if (formatterCache.size >= FORMATTER_CACHE_LIMIT) formatterCache.clear();
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * Throw unless `timeZone` is a usable IANA zone name.
 *
 * Exported so a call site can validate a configured zone at its own boundary.
 * There is deliberately **no** `?? "UTC"` anywhere in this module: a silent
 * fallback is the bug, and an empty slot list is indistinguishable from a
 * closed day, so the only loud outcome is a throw.
 */
export function assertIanaTimeZone(timeZone: string): void {
  zoneFormatter(timeZone);
}

/** A wall clock reading in some zone. Plain integers — no `Date`, no ambient zone. */
interface ZonedClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** What the clock in `timeZone` reads at `instantMs`. */
function clockInZone(timeZone: string, instantMs: number): ZonedClock {
  const parts = new Map<string, number>();
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts.set(part.type, Number(part.value));
  }

  // Unreachable given the options `zoneFormatter` fixes, but a missing field
  // must not become a silent `NaN`: that would flow through the offset
  // arithmetic and out as a slot at an arbitrary instant, which is the one
  // failure mode this module exists to make impossible.
  const read = (field: string): number => {
    const value = parts.get(field);
    if (value === undefined || Number.isNaN(value)) {
      throw new Error(
        `Intl returned no "${field}" for timezone ${JSON.stringify(timeZone)}.`,
      );
    }
    return value;
  };

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * A wall clock reading re-encoded as the epoch ms it *would* be if that reading
 * were UTC. Not an instant — a comparable integer, used to measure offsets and
 * to check whether a requested local time survived a round trip.
 */
function pseudoUtcMs(clock: ZonedClock): number {
  return Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
}

/** `timeZone`'s UTC offset in ms at `instantMs` (negative west of Greenwich). */
function zoneOffsetMs(timeZone: string, instantMs: number): number {
  return pseudoUtcMs(clockInZone(timeZone, instantMs)) - instantMs;
}

/** The calendar date `instant` falls on in `timeZone`, as a civil date. */
function civilDateInZone(
  timeZone: string,
  instant: Date,
): Pick<ZonedClock, "year" | "month" | "day"> {
  const { year, month, day } = clockInZone(timeZone, instant.getTime());
  return { year, month, day };
}

/**
 * The weekday (0 = Sunday … 6 = Saturday) that `instant` falls on in
 * `timeZone` — the value `rule.dayOfWeek` is matched against.
 *
 * `getUTCDay` on a `Date.UTC`-built date is a pure civil-calendar lookup: both
 * halves are UTC, so the process zone cannot reach it. That is the whole point
 * — `instant.getDay()` answered for the *server's* zone, which is how a Monday
 * 22:00 appointment in Miami became a Tuesday on a UTC Vercel box.
 *
 * Exported so the guest calendar grid dims days with this exact function rather
 * than a second implementation of it (ALI-117 invariant (d): the grid's offered
 * set and the write path's re-validated set must agree by construction).
 */
export function weekdayInTimeZone(instant: Date, timeZone: string): number {
  const { year, month, day } = civilDateInZone(timeZone, instant);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * `"HH:mm"` (or Postgres's `"HH:mm:ss"`) as minutes past local midnight, or
 * `null` if it is not a wall-clock time this engine can place.
 *
 * `"24:00"` — which a Postgres `time` column accepts — is rejected rather than
 * wrapped to the next day, matching the previous `date-fns` `parse(…, "HH:mm")`
 * behaviour: an unparseable rule contributes no slots. A malformed rule silently
 * offering *fewer* times is the safe direction, and the column type makes the
 * case unreachable from real data anyway.
 */
function wallClockMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * The instant at which the clock in `timeZone` reads `minuteOfDay` on `date`,
 * or `null` when that reading **does not exist** (a spring-forward gap).
 *
 * Two passes then a verification. The first pass guesses with the offset in
 * force at the naive instant; the second re-guesses with the offset in force at
 * that result, which is the correct one on either side of a transition. The
 * verification formats the answer back into `timeZone` and compares: if the
 * clock does not read what was asked for, the asked-for reading is in the gap.
 *
 * On a *fall-back* day the same two passes land on the *first* (earlier, still
 * pre-transition) occurrence of an ambiguous reading, which is the decided
 * semantics — the second occurrence is simply never produced, so a doubled hour
 * yields one slot rather than two.
 */
function instantForWallClock(
  timeZone: string,
  date: Pick<ZonedClock, "year" | "month" | "day">,
  minuteOfDay: number,
): number | null {
  const target = Date.UTC(date.year, date.month - 1, date.day, 0, minuteOfDay);
  const firstPass = target - zoneOffsetMs(timeZone, target);
  const candidate = target - zoneOffsetMs(timeZone, firstPass);

  // Round trip: does the clock in `timeZone` actually read what we asked for?
  const readsBack = pseudoUtcMs(clockInZone(timeZone, candidate)) === target;
  return readsBack ? candidate : null;
}

/**
 * The instant a rule's window closes.
 *
 * Normally that is just the window's closing wall-clock time. When *that* time
 * is itself inside a spring-forward gap (a rule ending at `02:30` on the US
 * spring-forward date), the window closes when the clock next reads that time
 * or later — i.e. the moment the gap ends. Scanning forward a minute at a time
 * finds it without a second transition-hunting algorithm; the scan is bounded
 * by the end of the local day and normally exits on its first iteration.
 *
 * This bound is what stops a long service from running past a window it appears
 * to fit inside: four wall-clock hours on a spring-forward day are only three
 * real hours, so a 240-minute booking starting at `01:00` would end an hour
 * after the business stopped taking appointments.
 */
function windowCloseInstant(
  timeZone: string,
  date: Pick<ZonedClock, "year" | "month" | "day">,
  endMinute: number,
): number | null {
  for (let minute = endMinute; minute <= MINUTES_PER_DAY; minute += 1) {
    const instant = instantForWallClock(timeZone, date, minute);
    if (instant !== null) return instant;
  }
  return null;
}

export interface GenerateSlotsArgs {
  /**
   * Any instant on the day to generate. The calendar date is the one this
   * instant falls on **in `timeZone`**, not in the process's zone.
   */
  day: Date;
  rules: AvailabilityRule[];
  service: Pick<Service, "durationMinutes">;
  /**
   * The tenant's IANA zone (`TenantBranding.timezone`), e.g. `America/New_York`.
   *
   * **Required, with no default, on purpose.** TypeScript makes it impossible
   * for a call site to forget, and there is no `?? "UTC"` below to quietly
   * rescue one that tries. It must be resolved server-side from the tenant's
   * own record — never taken from a request payload (ALI-139).
   */
  timeZone: string;
  blocked?: BlockedSlot[];
  bookings?: Booking[];
  /** Cadence the slot grid steps on, in minutes. */
  stepMinutes?: number;
  /** Slots starting before this instant are excluded (no booking in the past). */
  now?: Date;
}

function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function generateDaySlots({
  day,
  rules,
  service,
  timeZone,
  blocked = [],
  bookings = [],
  stepMinutes = 30,
  now = new Date(),
}: GenerateSlotsArgs): TimeSlot[] {
  // Validate first, and unconditionally: an unusable zone must fail loudly here
  // rather than fall through to `return []`, which a caller cannot distinguish
  // from a day the business is closed.
  assertIanaTimeZone(timeZone);

  // A non-advancing cadence never terminates. Not reachable from a request —
  // no call site passes this from the wire — but a hang is a worse way to find
  // out than a throw.
  if (!Number.isFinite(stepMinutes) || stepMinutes <= 0) {
    throw new RangeError(`stepMinutes must be a positive number, got ${stepMinutes}`);
  }

  const date = civilDateInZone(timeZone, day);
  const dayOfWeek = weekdayInTimeZone(day, timeZone);
  const dayRules = rules.filter((r) => r.dayOfWeek === dayOfWeek);
  if (dayRules.length === 0) return [];

  const durationMs = service.durationMinutes * MINUTE_MS;
  const nowMs = now.getTime();
  const blockedWindows = blocked.map((b) => ({
    start: Date.parse(b.start),
    end: Date.parse(b.end),
  }));

  const slots: TimeSlot[] = [];

  for (const rule of dayRules) {
    const startMinute = wallClockMinutes(rule.startTime);
    const endMinute = wallClockMinutes(rule.endTime);
    if (startMinute === null || endMinute === null) continue;

    const windowCloseMs = windowCloseInstant(timeZone, date, endMinute);
    if (windowCloseMs === null) continue;

    const bookedWindows = bookings.map((bk) => ({
      start: Date.parse(bk.start) - rule.bufferMinutes * MINUTE_MS,
      end: Date.parse(bk.end) + rule.bufferMinutes * MINUTE_MS,
    }));

    for (
      let minute = startMinute;
      minute + service.durationMinutes <= endMinute;
      minute += stepMinutes
    ) {
      // The wall clock is walked; the instant is derived. Never the reverse.
      const startMs = instantForWallClock(timeZone, date, minute);

      // The local time does not exist on this date — a spring-forward gap.
      // Skipped, never shifted onto a time the business did not choose.
      if (startMs === null) continue;

      const endMs = startMs + durationMs;

      // Real elapsed time can overrun a window that fits in wall-clock terms;
      // see `windowCloseInstant`. `continue` rather than `break` so the loop
      // stays correct in zones whose transitions are not a tidy hour forward.
      if (endMs > windowCloseMs) continue;

      // Can't book in the past.
      if (startMs < nowMs) continue;

      // Respect one-off blocked windows.
      const isBlocked = blockedWindows.some((b) =>
        overlaps(startMs, endMs, b.start, b.end),
      );
      if (isBlocked) continue;

      // Respect existing bookings, padded by the rule's buffer on each side.
      const clashesBooking = bookedWindows.some((bk) =>
        overlaps(startMs, endMs, bk.start, bk.end),
      );
      if (clashesBooking) continue;

      slots.push({
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
      });
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
