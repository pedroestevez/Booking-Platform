"use client";

import { useMemo, useState } from "react";
import { CalendarOff, ChevronLeft, ChevronRight } from "lucide-react";

import {
  addCivilMonths,
  assertIanaTimeZone,
  availableWeekdays,
  civilDateInTimeZone,
  civilMonthGrid,
  compareCivilDates,
  generateDaySlots,
  instantForCivilDate,
  sameCivilDate,
  weekdayOfCivilDate,
  type CivilDate,
  type CivilMonth,
} from "@/lib/availability";
import type {
  AvailabilityRule,
  BlockedSlot,
  Booking,
  Service,
  TenantBranding,
  TimeSlot,
} from "@/lib/types";
import { cn, formatTime } from "@/lib/utils";

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * Labels for civil dates.
 *
 * `timeZone: "UTC"` here is **not** a timezone conversion — it is an identity
 * read-back. The value being formatted is a `Date.UTC`-built carrier whose UTC
 * fields *are* the civil date's `year`/`month`/`day`, so reading it in UTC
 * returns exactly those numbers. Formatting the same carrier in the process's
 * zone, or the tenant's, would shift it — which is the whole class of bug this
 * component was rewritten to remove.
 */
const LONG_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "long",
  day: "numeric",
});
const SHORT_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "short",
  day: "numeric",
});
const MONTH_AND_YEAR = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});

function carrier(date: CivilDate): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

/**
 * The accessible label on a slot button, e.g. `"Monday, September 7 at 9:00 AM"`.
 *
 * The visible text is the time alone, because the date is already the heading
 * above the list. The accessible name carries **both**, in the tenant's zone,
 * for two reasons:
 *
 *   1. A screen-reader user tabbing into the list hears only "9:00 AM" otherwise,
 *      with the date announced somewhere they may never have been.
 *   2. It makes invariant check (e) observable in the product rather than only
 *      in a test: the day this slot actually falls on, on the business's clock,
 *      is now rendered next to the day the guest clicked. If the two ever
 *      disagree the page says so out loud, instead of the disagreement living
 *      invisibly between a cell and an ISO string.
 */
function formatSlotLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * The accessible label a day cell carries, e.g. `"Monday, August 17"`.
 *
 * Exported so the calendar's tests read the *rendered* label through the same
 * function that produced it, rather than re-deriving what they hope it says.
 */
export function formatCivilDate(date: CivilDate): string {
  return LONG_DAY.format(carrier(date));
}

/** Stable React key for a cell. */
function civilKeyString(date: CivilDate): string {
  return `${date.year}-${date.month}-${date.day}`;
}

interface AvailabilityCalendarProps {
  rules: AvailabilityRule[];
  blocked: BlockedSlot[];
  bookings: Booking[];
  service: Service;
  branding: TenantBranding;
  selectedSlot?: TimeSlot;
  onSelectSlot: (slot: TimeSlot) => void;
}

/**
 * The guest-facing month grid and slot list.
 *
 * ## Every date here is the tenant's, not the visitor's (ALI-117 B1)
 *
 * Cells are `CivilDate`s in `branding.timezone`, walked with civil-calendar
 * arithmetic. Nothing in this component builds a date from the browser's clock
 * and then interprets it — the previous version did, and for any visitor east
 * of the tenant it enabled the wrong cell: a Monday-only New York business
 * showed **Tuesday** enabled under UTC (Vercel's SSR zone) and Europe/London,
 * and clicking it produced a correct Monday instant. The guest read Tuesday,
 * booked, and got a Monday appointment on their calendar.
 *
 * The single conversion point is `instantForCivilDate`, which turns the clicked
 * cell into the instant `generateDaySlots` resolves rules against. Slot times
 * are rendered with `formatTime(..., branding.timezone)` so the clock the guest
 * reads is the clock the business keeps — the same one named beside the list.
 */
export function AvailabilityCalendar({
  rules,
  blocked,
  bookings,
  service,
  branding,
  selectedSlot,
  onSelectSlot,
}: AvailabilityCalendarProps) {
  const timeZone = branding.timezone;

  // A tenant whose `branding_json.timezone` is missing or malformed must not
  // take their whole booking page down. `generateDaySlots` throws by design —
  // that is criterion 2, and it is right — but a throw during a client render
  // has no error boundary above it here, so the page renders blank. Checked
  // once, up front, and turned into a legible state below.
  //
  // This is containment, not a fix: the real repair is refusing a bad zone at
  // provisioning time, which is ALI-176/ALI-184's `assertIanaTimeZone` call and
  // deliberately not made here.
  const zoneUsable = useMemo(() => {
    try {
      assertIanaTimeZone(timeZone);
      return true;
    } catch {
      return false;
    }
  }, [timeZone]);

  // "Today" is the tenant's today. A visitor in Auckland at 09:00 on the 18th is
  // looking at a New York business on the 17th, and the calendar they are shown
  // is the business's.
  const today = useMemo(
    () => (zoneUsable ? civilDateInTimeZone(new Date(), timeZone) : null),
    [zoneUsable, timeZone],
  );

  // Stored as an offset rather than a month so it cannot drift out of step with
  // the tenant's own current month.
  const [monthOffset, setMonthOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState<CivilDate | null>(null);

  const visibleMonth = useMemo<CivilMonth | null>(
    () => (today ? addCivilMonths(today, monthOffset) : null),
    [today, monthOffset],
  );

  const openWeekdays = useMemo(() => availableWeekdays(rules), [rules]);

  const days = useMemo(
    () => (visibleMonth ? civilMonthGrid(visibleMonth) : []),
    [visibleMonth],
  );

  const slots = useMemo<TimeSlot[]>(() => {
    if (!selectedDay || !zoneUsable) return [];
    return generateDaySlots({
      // The one place a cell becomes an instant.
      day: instantForCivilDate(selectedDay, timeZone),
      rules,
      service,
      timeZone,
      blocked,
      bookings,
    });
  }, [selectedDay, zoneUsable, timeZone, rules, service, blocked, bookings]);

  if (!zoneUsable || !today || !visibleMonth) {
    return (
      <div
        role="status"
        className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center"
      >
        <CalendarOff className="size-5 text-muted-foreground/60" aria-hidden />
        <p className="text-sm font-medium">Online booking is unavailable.</p>
        <p className="text-sm text-muted-foreground">
          This business&rsquo;s calendar is not configured correctly yet. Please
          contact them directly to arrange a time.
        </p>
      </div>
    );
  }

  const canGoBack = monthOffset > 0;

  function isDayBookable(day: CivilDate): boolean {
    if (!today) return false;
    if (compareCivilDates(day, today) < 0) return false;
    // The tenant's weekday for the tenant's calendar date — no instant, and so
    // no browser clock, anywhere in this decision.
    if (!openWeekdays.has(weekdayOfCivilDate(day))) return false;
    return true;
  }

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_18rem]">
      {/* Month grid */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold" aria-live="polite">
            {MONTH_AND_YEAR.format(
              carrier({ year: visibleMonth.year, month: visibleMonth.month, day: 1 }),
            )}
          </h3>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMonthOffset((m) => m - 1)}
              disabled={!canGoBack}
              aria-label="Previous month"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setMonthOffset((m) => m + 1)}
              aria-label="Next month"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1">
          {WEEKDAY_LABELS.map((label, i) => (
            <div
              key={i}
              className="pb-1 text-center text-xs font-medium text-muted-foreground"
              aria-hidden
            >
              {label}
            </div>
          ))}

          {days.map((day) => {
            const bookable = isDayBookable(day);
            const inMonth = day.month === visibleMonth.month && day.year === visibleMonth.year;
            const selected = selectedDay && sameCivilDate(day, selectedDay);
            const isToday = sameCivilDate(day, today);
            return (
              <button
                key={civilKeyString(day)}
                type="button"
                disabled={!bookable}
                onClick={() => setSelectedDay(day)}
                aria-label={formatCivilDate(day)}
                aria-pressed={!!selected}
                className={cn(
                  "relative flex aspect-square items-center justify-center rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  !inMonth && "opacity-40",
                  bookable
                    ? "hover:bg-accent"
                    : "cursor-not-allowed text-muted-foreground/40 line-through",
                  selected &&
                    "bg-primary text-primary-foreground hover:bg-primary",
                  !selected &&
                    bookable &&
                    isToday &&
                    "ring-1 ring-inset ring-primary/40",
                )}
              >
                {day.day}
                {bookable && !selected && (
                  <span
                    className="absolute bottom-1 size-1 rounded-full bg-primary/60"
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Time slots */}
      <div className="md:border-l md:pl-6">
        {!selectedDay ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center rounded-lg border border-dashed text-center">
            <p className="px-6 text-sm text-muted-foreground">
              Select a date to see available times.
            </p>
          </div>
        ) : (
          <div>
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold">
                {SHORT_DAY.format(carrier(selectedDay))}
              </h3>
              <span className="text-xs text-muted-foreground">
                {timeZone.replace(/_/g, " ")}
              </span>
            </div>

            {slots.length === 0 ? (
              <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center">
                <CalendarOff className="size-5 text-muted-foreground/60" />
                <p className="px-6 text-sm text-muted-foreground">
                  No times left on this day. Try another date.
                </p>
              </div>
            ) : (
              <div
                className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-1 md:grid-cols-1 lg:grid-cols-2"
                role="listbox"
                aria-label="Available times"
              >
                {slots.map((slot) => {
                  const active =
                    selectedSlot && selectedSlot.start === slot.start;
                  return (
                    <button
                      key={slot.start}
                      type="button"
                      role="option"
                      aria-selected={!!active}
                      aria-label={formatSlotLabel(slot.start, timeZone)}
                      onClick={() => onSelectSlot(slot)}
                      className={cn(
                        "rounded-lg border px-3 py-2.5 text-sm font-medium tabular-nums transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input hover:border-primary/50 hover:bg-accent",
                      )}
                    >
                      {/* The business's clock — the one named above this list.
                          Rendering the browser's would label a 9:00 AM New York
                          slot "1:00 PM" under a UTC SSR render. */}
                      {formatTime(slot.start, timeZone)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
