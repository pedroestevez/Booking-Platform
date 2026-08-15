"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

export const BOOKING_STEPS = [
  { key: "service", label: "Service" },
  { key: "schedule", label: "Date & time" },
  { key: "details", label: "Your details" },
  { key: "confirmation", label: "Confirmation" },
] as const;

export type BookingStepKey = (typeof BOOKING_STEPS)[number]["key"];

export function BookingStepper({ current }: { current: BookingStepKey }) {
  const currentIndex = BOOKING_STEPS.findIndex((s) => s.key === current);

  return (
    <ol className="flex items-center gap-2" aria-label="Booking progress">
      {BOOKING_STEPS.map((step, index) => {
        const isDone = index < currentIndex;
        const isActive = index === currentIndex;
        return (
          <li key={step.key} className="flex flex-1 items-center gap-2">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                  isDone &&
                    "border-transparent bg-primary text-primary-foreground",
                  isActive &&
                    "border-primary text-primary ring-2 ring-primary/20",
                  !isDone &&
                    !isActive &&
                    "border-border text-muted-foreground",
                )}
                aria-current={isActive ? "step" : undefined}
              >
                {isDone ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span
                className={cn(
                  "hidden text-sm font-medium sm:inline",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
            </div>
            {index < BOOKING_STEPS.length - 1 && (
              <span
                className={cn(
                  "h-px flex-1 transition-colors",
                  isDone ? "bg-primary" : "bg-border",
                )}
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
