"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";

import { createBookingAction } from "@/app/[customerSlug]/actions";
import { AvailabilityCalendar } from "@/components/booking/availability-calendar";
import { BookingConfirmation } from "@/components/booking/booking-confirmation";
import { BookingStepper, type BookingStepKey } from "@/components/booking/booking-stepper";
import { BookingSummary } from "@/components/booking/booking-summary";
import { GuestDetailsForm } from "@/components/booking/guest-details-form";
import { ServiceSelector } from "@/components/booking/service-selector";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  AvailabilityRule,
  BlockedSlot,
  Booking,
  GuestDetails,
  Service,
  Tenant,
  TimeSlot,
} from "@/lib/types";

const FORM_ID = "guest-details-form";

const STEP_COPY: Record<BookingStepKey, { title: string; description: string }> = {
  service: {
    title: "Choose a service",
    description: "Pick the appointment that's right for you.",
  },
  schedule: {
    title: "Pick a time",
    description: "Select a date, then choose from the available times.",
  },
  details: {
    title: "Your details",
    description: "Tell us where to send your confirmation.",
  },
  confirmation: {
    title: "Confirmation",
    description: "",
  },
};

interface BookingFlowProps {
  tenant: Tenant;
  services: Service[];
  rules: AvailabilityRule[];
  blocked: BlockedSlot[];
  /** Existing bookings, used only to filter taken slots (none in v0.1). */
  bookings?: Booking[];
}

export function BookingFlow({
  tenant,
  services,
  rules,
  blocked,
  bookings = [],
}: BookingFlowProps) {
  const [step, setStep] = useState<BookingStepKey>("service");
  const [service, setService] = useState<Service>();
  const [slot, setSlot] = useState<TimeSlot>();
  const [guest, setGuest] = useState<GuestDetails>();
  const [bookingId, setBookingId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  function selectService(next: Service) {
    setService(next);
    // Changing service invalidates any previously chosen time.
    if (service && next.id !== service.id) setSlot(undefined);
    setStep("schedule");
  }

  async function submitGuest(details: GuestDetails) {
    if (!service || !slot) return;
    setGuest(details);
    setError(undefined);
    setSubmitting(true);

    // Persist the booking: resolves-or-creates the guest identity and reserves
    // the slot (status 'pending'). Payment + invite arrive with Stripe (ALI-27).
    const result = await createBookingAction({
      customerId: tenant.id,
      serviceId: service.id,
      slot,
      guest: details,
      customFields: {},
    });

    setSubmitting(false);
    if (result.ok) {
      setBookingId(result.bookingId);
      setStep("confirmation");
    } else {
      setError(result.error);
    }
  }

  function reset() {
    setService(undefined);
    setSlot(undefined);
    setGuest(undefined);
    setBookingId(undefined);
    setError(undefined);
    setStep("service");
  }

  const copy = STEP_COPY[step];

  return (
    <Card className="overflow-hidden shadow-xl shadow-black/5">
      {step !== "confirmation" && (
        <div className="border-b bg-muted/30 px-6 py-4">
          <BookingStepper current={step} />
        </div>
      )}

      <div className="grid lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="order-2 lg:order-1">
          <CardHeader>
            <CardTitle className="text-lg">{copy.title}</CardTitle>
            {copy.description && (
              <CardDescription>{copy.description}</CardDescription>
            )}
          </CardHeader>

          <CardContent>
            {step === "service" && (
              <ServiceSelector
                services={services}
                branding={tenant.branding}
                selectedId={service?.id}
                onSelect={selectService}
              />
            )}

            {step === "schedule" && service && (
              <AvailabilityCalendar
                rules={rules}
                blocked={blocked}
                bookings={bookings}
                service={service}
                branding={tenant.branding}
                selectedSlot={slot}
                onSelectSlot={setSlot}
              />
            )}

            {step === "details" && (
              <>
                <GuestDetailsForm
                  formId={FORM_ID}
                  defaultValues={guest}
                  onSubmit={submitGuest}
                />
                {error && (
                  <p
                    role="alert"
                    className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                  >
                    {error}
                  </p>
                )}
              </>
            )}

            {step === "confirmation" && service && slot && guest && (
              <BookingConfirmation
                tenant={tenant}
                service={service}
                slot={slot}
                guest={guest}
                bookingId={bookingId}
                onBookAnother={reset}
              />
            )}
          </CardContent>

          {step !== "confirmation" && (
            <div className="flex items-center justify-between gap-3 border-t px-6 py-4">
              {step !== "service" ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setStep(step === "details" ? "schedule" : "service")
                  }
                >
                  <ArrowLeft className="size-4" />
                  Back
                </Button>
              ) : (
                <span />
              )}

              {step === "schedule" && (
                <Button
                  onClick={() => setStep("details")}
                  disabled={!slot}
                  size="lg"
                >
                  Continue
                  <ArrowRight className="size-4" />
                </Button>
              )}

              {step === "details" && (
                <Button
                  type="submit"
                  form={FORM_ID}
                  size="lg"
                  disabled={submitting}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Reserving…
                    </>
                  ) : (
                    <>
                      Confirm booking
                      <ArrowRight className="size-4" />
                    </>
                  )}
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Summary rail — sticky context as the guest moves through the flow. */}
        {step !== "confirmation" && (
          <aside className="order-1 border-b bg-muted/20 p-6 lg:order-2 lg:border-b-0 lg:border-l">
            <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Summary
            </p>
            <BookingSummary
              service={service}
              slot={slot}
              branding={tenant.branding}
            />
          </aside>
        )}
      </div>
    </Card>
  );
}
