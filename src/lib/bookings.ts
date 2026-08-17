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
import type {
  Booking,
  BookingStatus,
  CreateBookingInput,
  CustomFields,
  GuestSupplied,
} from "@/lib/types";

/**
 * The reserved `custom_fields` key the **server** owns (ALI-167).
 *
 * `custom_fields` is browser-supplied end to end — `request.customFields` is
 * passed straight through by `createBookingAction` — so this key has to be
 * server-authoritative or it proves nothing. A browser value for it is
 * discarded, never merged: see `withGuestSupplied`.
 */
export const GUEST_SUPPLIED_FIELD = "guest_supplied";

/** The `end_customers` projection the write path reads back after resolving. */
interface EndCustomerIdentityRow {
  id: string;
  name: string;
  phone: string | null;
}

/** A value the request actually supplied, as `resolve_or_create_end_customer` judges it. */
function supplied(value: string | null | undefined): string | null {
  // Mirrors `nullif(excluded.name, '')` in 0003/0007: the empty string is
  // "supplied nothing", and nothing else is. Deliberately no trimming — the SQL
  // does none, and a mirror that normalises more than the original is a mirror
  // that disagrees with it.
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * What this request supplied for the guest, kept only where it **differs** from
 * the identity the RPC resolved to.
 *
 * Returns `null` when there is nothing to record, which is the case on first
 * contact without any need to ask whether the identity pre-existed: 0007
 * creates the row *from* the supplied values, so supplied and stored are equal
 * by construction and every leg falls away. That is why this is a pure
 * comparison rather than a second round trip asking "was it already there?".
 */
export function diffGuestSupplied(
  request: { name?: string | null; phone?: string | null },
  stored: { name: string | null; phone: string | null },
): GuestSupplied | null {
  const record: GuestSupplied = {};

  const name = supplied(request.name);
  if (name !== null && name !== stored.name) record.name = name;

  const phone = supplied(request.phone);
  if (phone !== null && phone !== stored.phone) record.phone = phone;

  return Object.keys(record).length > 0 ? record : null;
}

/**
 * Merge the server's `guest_supplied` into browser-supplied `custom_fields`.
 *
 * The browser's own value for the reserved key is **always** dropped first —
 * including when the server has nothing to record. Merging the two, or
 * defaulting to the browser's when the server is silent, would let a request
 * that supplied `name: 'Bob'` ship `guest_supplied: { name: 'Alice' }` and make
 * the per-booking record lie in exactly the way the identity no longer can.
 */
export function withGuestSupplied(
  customFields: CustomFields,
  guestSupplied: GuestSupplied | null,
): CustomFields {
  const merged: CustomFields = { ...customFields };
  delete merged[GUEST_SUPPLIED_FIELD];
  if (guestSupplied !== null) merged[GUEST_SUPPLIED_FIELD] = guestSupplied;
  return merged;
}

/**
 * The status a new booking is inserted with, decided by its price (ALI-176
 * criterion 4).
 *
 * A free service has nothing left to wait for, so it is `confirmed` on insert.
 * A paid one stays `pending` until payment succeeds — that transition is
 * ALI-27/ALI-70's, and inserting a paid booking as `confirmed` would confirm a
 * meeting nobody has paid for.
 *
 * ## `confirmed` still occupies the slot
 *
 * This changes *which* live status the row carries, never whether the row is
 * live. `bookings_no_overlap` (migration 0006) exempts `status <> 'cancelled'`
 * and `getUpcomingBookings` subtracts the same set — `SLOT_FREEING_STATUS` in
 * `src/lib/tenants.ts` — so `pending` and `confirmed` are equally occupying on
 * both sides. Were that not true, the free flow would either offer ghost slots
 * the database then refuses, or silently double-book.
 * `booking-overlap.db.test.ts` asserts the two sets are identical, derived from
 * the live schema; `free-service-status.db.test.ts` asserts the status this
 * function returns is inside them.
 *
 * ## Why a function and not an inline ternary
 *
 * ALI-69's confirmation email fires on `confirmed` ("post-payment, or
 * immediately for free services"), so this predicate is the trigger condition
 * for a side effect that reaches a real person. Naming it gives that rule one
 * definition and one place to test.
 */
export function initialBookingStatus(priceCents: number): BookingStatus {
  return priceCents === 0 ? "confirmed" : "pending";
}

/**
 * Booking writes.
 *
 * Resolves-or-creates the guest's identity (`end_customers`) by email, then
 * inserts a booking referencing `end_customer_id` and storing per-vertical
 * `custom_fields`. The status comes from `initialBookingStatus` — `confirmed`
 * for a free service, `pending` for a paid one, whose payment lands with
 * ALI-27.
 *
 * ## Resolving an identity never mutates it (ALI-167)
 *
 * `createBookingAction` is a public unauthenticated endpoint and nothing on
 * this path proves the requester controls the email they typed, so an existing
 * guest's stored `name`/`phone` are immutable to it — enforced in SQL by
 * migration 0007, not here, because the phone leg is unreachable from
 * application code. What the request supplied is recorded on the booking
 * instead, under the reserved `custom_fields.guest_supplied` key.
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

  // Read back the identity this request resolved to, so what the request itself
  // supplied can be recorded next to the booking (ALI-167). Since 0007 the RPC
  // never mutates an existing row, so the supplied name/phone would otherwise
  // be discarded silently — and that is the same release-0.1 failure from the
  // other side: the owner reads the dashboard, sees "Alice", and has no trace
  // that Bob is the one arriving.
  //
  // Deliberately *after* the RPC, not folded into the availability reads above.
  // Read before, and a concurrent first contact for the same email decides
  // whether this request "resolved to a pre-existing identity" — the recording
  // would be a coin flip. Read after, and `stored` is the authoritative value
  // at the moment of resolution, which is what the criterion is about.
  const { data: identity, error: identityReadError } = await supabase
    .from("end_customers")
    .select("id, name, phone")
    .eq("customer_id", customerId)
    .eq("id", endCustomerId as string)
    .maybeSingle<EndCustomerIdentityRow>();
  if (identityReadError) throw identityReadError;

  // `phone: null` mirrors `p_phone: null` above — no call site collects a guest
  // phone yet. When one does, both halves are already correct: the identity is
  // protected in SQL (unbypassable) and the divergence is recorded here.
  //
  // If no identity row is readable — it was just resolved, so this should not
  // happen — record nothing, but still drop the browser's reserved key below.
  // The safe failure direction is a booking with no `guest_supplied`, never a
  // rejected booking: refusing it would turn a data-integrity bug into a denial
  // of service on a legitimate returning guest.
  const guestSupplied = identity
    ? diffGuestSupplied({ name: guest.name, phone: null }, identity)
    : null;

  const { data: booking, error: insertError } = await supabase
    .from("bookings")
    .insert({
      customer_id: customerId,
      service_id: serviceId,
      end_customer_id: endCustomerId as string,
      start_time: slot.start,
      end_time: slot.end,
      notes: guest.notes ?? null,
      // From the service row read above — the tenant's own price, never a
      // browser-supplied one. `service` is already scoped to `customerId`, so a
      // request cannot name another tenant's free service to skip payment.
      status: initialBookingStatus(service.price_cents),
      custom_fields: withGuestSupplied(customFields, guestSupplied),
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
