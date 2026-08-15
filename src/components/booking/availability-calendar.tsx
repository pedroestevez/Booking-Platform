"use client";

import { useMemo, useState } from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isBefore,
  isSameDay,
  isSameMonth,
  isToday,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { CalendarOff, ChevronLeft, ChevronRight } from "lucide-react";

import {
  availableWeekdays,
  generateDaySlots,
} from "@/lib/availability";
import type {
  AvailabilityRule,
  BlockedSlot,
  Booking,
  Service,
  TenantBranding,
  TimeSlot,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

interface AvailabilityCalendarProps {
  rules: AvailabilityRule[];
  blocked: BlockedSlot[];
  bookings: Booking[];
  service: Service;
  branding: TenantBranding;
  selectedSlot?: TimeSlot;
  onSelectSlot: (slot: TimeSlot) => void;
}

export function AvailabilityCalendar({
  rules,
  blocked,
  bookings,
  service,
  branding,
  selectedSlot,
  onSelectSlot,
}: AvailabilityCalendarProps) {
  const today = useMemo(() => startOfDay(new Date()), []);
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(today));
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  const openWeekdays = useMemo(() => availableWeekdays(rules), [rules]);

  const days = useMemo(() => {
    const gridStart = startOfWeek(startOfMonth(visibleMonth));
    const gridEnd = endOfWeek(endOfMonth(visibleMonth));
    return eachDayOfInterval({ start: gridStart, end: gridEnd });
  }, [visibleMonth]);

  const slots = useMemo<TimeSlot[]>(() => {
    if (!selectedDay) return [];
    return generateDaySlots({
      day: selectedDay,
      rules,
      service,
      blocked,
      bookings,
    });
  }, [selectedDay, rules, service, blocked, bookings]);

  const canGoBack = !isSameMonth(visibleMonth, today);

  function isDayBookable(day: Date): boolean {
    if (isBefore(day, today)) return false;
    if (!openWeekdays.has(day.getDay())) return false;
    return true;
  }

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_18rem]">
      {/* Month grid */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold" aria-live="polite">
            {format(visibleMonth, "MMMM yyyy")}
          </h3>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setVisibleMonth((m) => addMonths(m, -1))}
              disabled={!canGoBack}
              aria-label="Previous month"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setVisibleMonth((m) => addMonths(m, 1))}
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
            const inMonth = isSameMonth(day, visibleMonth);
            const selected = selectedDay && isSameDay(day, selectedDay);
            return (
              <button
                key={day.toISOString()}
                type="button"
                disabled={!bookable}
                onClick={() => setSelectedDay(day)}
                aria-label={format(day, "EEEE, MMMM d")}
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
                    isToday(day) &&
                    "ring-1 ring-inset ring-primary/40",
                )}
              >
                {format(day, "d")}
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
                {format(selectedDay, "EEEE, MMM d")}
              </h3>
              <span className="text-xs text-muted-foreground">
                {branding.timezone.replace(/_/g, " ")}
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
                      onClick={() => onSelectSlot(slot)}
                      className={cn(
                        "rounded-lg border px-3 py-2.5 text-sm font-medium tabular-nums transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input hover:border-primary/50 hover:bg-accent",
                      )}
                    >
                      {format(new Date(slot.start), "h:mm a")}
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
