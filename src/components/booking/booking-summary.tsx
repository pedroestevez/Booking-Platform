"use client";

import { format } from "date-fns";
import { CalendarDays, Clock, Tag } from "lucide-react";

import { Separator } from "@/components/ui/separator";
import type { Service, TenantBranding, TimeSlot } from "@/lib/types";
import { formatDuration, formatPrice } from "@/lib/utils";

interface BookingSummaryProps {
  service?: Service;
  slot?: TimeSlot;
  branding: TenantBranding;
}

/** Persistent at-a-glance summary of the in-progress booking. */
export function BookingSummary({ service, slot, branding }: BookingSummaryProps) {
  if (!service) {
    return (
      <p className="text-sm text-muted-foreground">
        Choose a service to get started.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold tracking-tight">{service.name}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {service.description}
        </p>
      </div>

      <Separator />

      <dl className="space-y-3 text-sm">
        <div className="flex items-center gap-2.5">
          <Clock className="size-4 shrink-0 text-muted-foreground" />
          <dt className="sr-only">Duration</dt>
          <dd>{formatDuration(service.durationMinutes)}</dd>
        </div>

        {slot && (
          <div className="flex items-center gap-2.5">
            <CalendarDays className="size-4 shrink-0 text-muted-foreground" />
            <dt className="sr-only">Date and time</dt>
            <dd>
              {format(new Date(slot.start), "EEE, MMM d")} ·{" "}
              {format(new Date(slot.start), "h:mm a")}
            </dd>
          </div>
        )}

        <div className="flex items-center gap-2.5">
          <Tag className="size-4 shrink-0 text-muted-foreground" />
          <dt className="sr-only">Price</dt>
          <dd className="font-medium">
            {formatPrice(service.priceCents, branding.currency)}
          </dd>
        </div>
      </dl>

      <Separator />

      <div className="flex items-baseline justify-between">
        <span className="text-sm text-muted-foreground">Total</span>
        <span className="text-lg font-semibold tabular-nums">
          {formatPrice(service.priceCents, branding.currency)}
        </span>
      </div>
    </div>
  );
}
