"use client";

import { format } from "date-fns";
import { CalendarPlus, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { buildIcs, icsFilename } from "@/lib/ics";
import type { GuestDetails, Service, Tenant, TimeSlot } from "@/lib/types";
import { formatServicePrice } from "@/lib/utils";

interface BookingConfirmationProps {
  tenant: Tenant;
  service: Service;
  slot: TimeSlot;
  guest: GuestDetails;
  /** The created booking id, used as the calendar invite UID. */
  bookingId?: string;
  onBookAnother: () => void;
}

export function BookingConfirmation({
  tenant,
  service,
  slot,
  guest,
  bookingId,
  onBookAnother,
}: BookingConfirmationProps) {
  const start = new Date(slot.start);

  function handleAddToCalendar() {
    const descriptionParts = [`Booked for ${guest.name} (${guest.email}).`];
    if (guest.notes) descriptionParts.push(guest.notes);

    const ics = buildIcs({
      uid: `${bookingId ?? crypto.randomUUID()}@booking-platform`,
      start: slot.start,
      end: slot.end,
      summary: `${service.name} with ${tenant.name}`,
      description: descriptionParts.join("\n\n"),
      location: tenant.name,
    });

    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = icsFilename(`${service.name}-${tenant.name}`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-md text-center">
      <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-primary/10">
        <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-5" />
        </span>
      </div>

      <h2 className="mt-5 text-xl font-semibold tracking-tight">
        You&apos;re booked in!
      </h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        We&apos;ve held your spot with {tenant.name}. Add it to your calendar
        below so you don&apos;t miss it.
      </p>

      <div className="mt-6 rounded-xl border bg-card p-5 text-left">
        <p className="font-semibold tracking-tight">{service.name}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {format(start, "EEEE, MMMM d, yyyy")}
        </p>
        <p className="text-sm text-muted-foreground">
          {format(start, "h:mm a")} · {format(new Date(slot.end), "h:mm a")}
        </p>

        <Separator className="my-4" />

        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Booked for</dt>
            <dd className="font-medium">{guest.name}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Total</dt>
            <dd className="font-medium tabular-nums">
              {formatServicePrice(service.priceCents, tenant.branding.currency)}
            </dd>
          </div>
        </dl>
      </div>

      <Button
        variant="outline"
        onClick={handleAddToCalendar}
        className="mt-4 w-full"
      >
        <CalendarPlus className="size-4" />
        Add to calendar
      </Button>
      <p className="mt-2 text-xs text-muted-foreground">
        Online payment and email confirmations arrive in an upcoming release.
      </p>

      <Button variant="ghost" onClick={onBookAnother} className="mt-5">
        Book another appointment
      </Button>
    </div>
  );
}
