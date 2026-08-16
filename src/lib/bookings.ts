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
 * per-vertical `custom_fields`. No payment here — Stripe lands with ALI-27.
 *
 * ## `input.customerId` must already be server-resolved (ALI-139)
 *
 * Every query below runs through `createServiceRoleClient()`, which bypasses
 * RLS, and each is scoped only by the `customerId` it is handed — the services
 * lookup, the three availability reads, the identity RPC, and the insert. That
 * makes this parameter the sole tenant boundary for six statements, so it must
 * come from `getTenantBySlug` (public flow) or a `tenant_members` lookup
 * (admin), and never from a request payload. `createBookingAction` is where
 * that resolution happens for the guest flow; the app-code `customer_id`
 * filters here are the mandated second layer, not the first.
 *
 * Two layers guard the slot, and they are not interchangeable (ALI-98):
 *
 *   • The availability re-check below is **UX**. It catches the common case
 *     (a stale client picking a slot taken minutes ago) and produces a good
 *     message, but it is a read-check-then-write and two concurrent requests
 *     can both pass it.
 *   • The `bookings_no_overlap` exclusion constraint (migration 0006) is the
 *     **correctness guarantee**. The loser of a real race is rejected by
 *     Postgres with SQLSTATE 23P01, which the insert path below translates
 *     into the same message the re-check produces, so the two paths are
 *     indistinguishable to the guest.
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

  if (insertError) {
    // 23P01 = exclusion_violation: `bookings_no_overlap` rejected this insert
    // because another booking already holds an overlapping window for this
    // tenant. That is the race the pre-check cannot win, and it is the ONLY
    // code translated here — anything else (a foreign-key violation, a lost
    // connection, an RLS denial) must propagate untouched rather than be
    // disguised as "pick another time".
    if (insertError.code === "23P01") {
      throw new Error("Sorry, that time was just taken. Please pick another.");
    }
    throw insertError;
  }
  return mapBooking(booking);
}
