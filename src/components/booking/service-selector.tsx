"use client";

import { ArrowRight, Clock } from "lucide-react";

import type { Service, TenantBranding } from "@/lib/types";
import { cn, formatDuration, formatPrice } from "@/lib/utils";

interface ServiceSelectorProps {
  services: Service[];
  branding: TenantBranding;
  selectedId?: string;
  onSelect: (service: Service) => void;
}

export function ServiceSelector({
  services,
  branding,
  selectedId,
  onSelect,
}: ServiceSelectorProps) {
  if (services.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No services are available to book right now.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      {services.map((service) => {
        const selected = service.id === selectedId;
        return (
          <button
            key={service.id}
            type="button"
            onClick={() => onSelect(service)}
            aria-pressed={selected}
            className={cn(
              "group relative flex items-start gap-4 rounded-xl border bg-card p-4 text-left transition-all hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:p-5",
              selected
                ? "border-primary ring-2 ring-primary/15"
                : "border-border",
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="truncate font-semibold tracking-tight">
                  {service.name}
                </h3>
                <span className="shrink-0 font-semibold tabular-nums">
                  {formatPrice(service.priceCents, branding.currency)}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                {service.description}
              </p>
              <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Clock className="size-3.5" />
                {formatDuration(service.durationMinutes)}
              </div>
            </div>
            <ArrowRight
              className={cn(
                "mt-1 size-5 shrink-0 transition-all",
                selected
                  ? "text-primary"
                  : "text-muted-foreground/40 group-hover:translate-x-0.5 group-hover:text-primary",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
