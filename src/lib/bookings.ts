import "server-only";

import { generateDaySlots } from "@/lib/availability";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  mapBooking,
  type BookingRow,
  type ServiceRow,
} from "@/lib/supabase/rows";
import {
  getAvailabilityRules,
  getBlockedSlots,
  getUpcomingBookings,
} from "@/lib/tenants";
import type { Booking, CreateBookingInput } from "@/lib/types";

/**
 * Booking writes.
 *
 * Resolves-or-creates the guest's identity (`end_customers`) by email, then
 * inserts a `status='pending'` booking referencing `end_customer_id` and storing
 * per-vertical `custom_fields`. No payment here — Stripe + an atomic
 * slot-collision constraint land with ALI-27. The collision check below is a
 * best-effort re-validation against current availability.
 */
export async function createBooking(
  input: CreateBookingInput,
): Promise<Booking> {
  const { customerId, serviceId, slot, guest, customFields = {} } = input;
  const supabase = createServiceRoleClient();

  // Fetch the service (scoped to the tenant) for its duration.
  const { data: service, error: serviceError } = await supabase
    .from("services")
    .select("id, customer_id, name, description, duration_minutes, price_cents, active")
    .eq("customer_id", customerId)
    .eq("id", serviceId)
    .maybeSingle<ServiceRow>();

  if (serviceError) throw serviceError;
  if (!service || !service.active) {
    throw new Error("That service is no longer available.");
  }

  // Re-validate the chosen slot against current availability so a stale client
  // can't book a time that's been taken or blocked since the page loaded.
  const day = new Date(slot.start);
  const [rules, blocked, bookings] = await Promise.all([
    getAvailabilityRules(customerId),
    getBlockedSlots(customerId),
    getUpcomingBookings(customerId),
  ]);

  const open = generateDaySlots({
    day,
    rules,
    service: { durationMinutes: service.duration_minutes },
    blocked,
    bookings,
  });
  const stillFree = open.some(
    (s) => s.start === slot.start && s.end === slot.end,
  );
  if (!stillFree) {
    throw new Error("Sorry, that time was just taken. Please pick another.");
  }

  // Resolve-or-create the guest identity atomically (one round trip, no race).
  const { data: endCustomerId, error: identityError } = await supabase.rpc(
    "resolve_or_create_end_customer",
    {
      p_customer_id: customerId,
      p_email: guest.email,
      p_name: guest.name,
      p_phone: null,
    },
  );
  if (identityError) throw identityError;

  const { data: booking, error: insertError } = await supabase
    .from("bookings")
    .insert({
      customer_id: customerId,
      service_id: serviceId,
      end_customer_id: endCustomerId as string,
      start_time: slot.start,
      end_time: slot.end,
      notes: guest.notes ?? null,
      status: "pending",
      custom_fields: customFields,
    })
    .select(
      "id, customer_id, service_id, end_customer_id, start_time, end_time, notes, status, custom_fields",
    )
    .single<BookingRow>();

  if (insertError) throw insertError;
  return mapBooking(booking);
}
