"use client";

import { format } from "date-fns";
import { CalendarPlus, Check, Info, Mail } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { buildIcs, icsFilename, icsUid } from "@/lib/ics";
import type { GuestDetails, Service, Tenant, TimeSlot } from "@/lib/types";
import { formatServicePrice } from "@/lib/utils";

interface BookingConfirmationProps {
  tenant: Tenant;
  service: Service;
  slot: TimeSlot;
  guest: GuestDetails;
  /** The created booking id, used as the calendar invite UID. */
  bookingId?: string;
  /**
   * Whether this deployment can actually send the guest a confirmation email.
   *
   * Required, never defaulted: a caller that forgets to state it would
   * otherwise inherit a screen implying somebody was notified when nobody was.
   * The booking commits either way (ALI-69 AC6) — this decides only whether
   * the screen is allowed to imply a message went out.
   */
  notificationsEnabled: boolean;
  onBookAnother: () => void;
}

export function BookingConfirmation({
  tenant,
  service,
  slot,
  guest,
  bookingId,
  notificationsEnabled,
  onBookAnother,
}: BookingConfirmationProps) {
  const start = new Date(slot.start);

  // The fallback contact path, offered when no automated message could be
  // sent. It is whatever *this tenant* configured — the shared component never
  // carries an address of its own, so a tenant that sets none gets no button
  // rather than somebody else's inbox.
  const contactEmail = tenant.branding.contactEmail;
  const contactMailto = contactEmail
    ? `mailto:${contactEmail}?subject=${encodeURIComponent(
        `Booking — ${service.name} on ${format(start, "EEEE, MMMM d")}`,
      )}`
    : undefined;

  function handleAddToCalendar() {
    const descriptionParts = [`Booked for ${guest.name} (${guest.email}).`];
    if (guest.notes) descriptionParts.push(guest.notes);

    const ics = buildIcs({
      // The same UID the confirmation email's attachment carries (ALI-69), so a
      // guest who both clicks this button and opens the email ends up with one
      // appointment rather than two.
      uid: icsUid(bookingId ?? crypto.randomUUID()),
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
      {notificationsEnabled ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Online payment arrives in an upcoming release.
        </p>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed bg-muted/30 p-4 text-left">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Info aria-hidden="true" className="size-4 shrink-0" />
            No email was sent. Nobody was notified.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            The booking itself is real — it&apos;s saved, and the time is held.
            The notification step just isn&apos;t wired up on this deployment
            yet; it&apos;s a work in progress, being built in the open. Glad
            you&apos;re curious how it works. Use{" "}
            <span className="font-medium text-foreground/80">
              Add to calendar
            </span>{" "}
            above so the time doesn&apos;t get away from you.
          </p>
          {contactMailto ? (
            <Button asChild variant="secondary" className="mt-3 w-full">
              <a href={contactMailto}>
                <Mail className="size-4" />
                Email {tenant.name} directly
              </a>
            </Button>
          ) : null}
          <p className="mt-3 text-xs text-muted-foreground">
            Online payment also arrives in an upcoming release.
          </p>
        </div>
      )}

      <Button variant="ghost" onClick={onBookAnother} className="mt-5">
        Book another appointment
      </Button>
    </div>
  );
}
