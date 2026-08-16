"use server";

import { createBooking } from "@/lib/bookings";
import { getTenantBySlug } from "@/lib/tenants";
import type { CreateBookingRequest } from "@/lib/types";

export type CreateBookingResult =
  | { ok: true; bookingId: string }
  | { ok: false; error: string };

/**
 * Shown when the slug resolves to no tenant. Deliberately says nothing about
 * why: a booking page that has been removed and a slug that never existed read
 * the same. (This leaks nothing either way — slug existence is already public
 * from the page itself, which 404s — but there is no reason to add a second,
 * chattier oracle.)
 */
const UNKNOWN_TENANT_MESSAGE = "This booking page is no longer available.";

/**
 * Create a (pending) booking from the guest flow. Stripe is deferred (ALI-27);
 * this resolves-or-creates the guest identity and reserves the slot.
 *
 * ## This function is the trust boundary (ALI-139)
 *
 * A server action is a public HTTP endpoint. Its argument is whatever the
 * caller serialized — the exported TypeScript signature documents the contract
 * but enforces nothing at runtime, so every field below arrives attacker-
 * controlled and unvalidated.
 *
 * The tenant is therefore **resolved here, from the slug, against the
 * database** — and the resolved id is the only one that reaches `createBooking`,
 * which runs every one of its six queries through the service-role client
 * (`createServiceRoleClient`), a client that bypasses RLS by design. Before
 * this, `customerId` came in on the request and went straight to that client:
 * a visitor on tenant A's page could post tenant B's UUID and write
 * `end_customers` and `bookings` rows into tenant B — and, since ALI-98 made
 * overlap a database-enforced constraint, squat tenant B's calendar so its own
 * bookings are refused. This satisfies the CLAUDE.md non-negotiable that tenant
 * identity comes from server-side context, never a browser-supplied value.
 *
 * ## Two rules this function must keep
 *
 * 1. **Never spread the request into `createBooking`.** The fields are copied
 *    across one at a time, on purpose. `...request` would carry any extra
 *    property the browser invented — including a `customerId` the type says
 *    cannot be there — back into the trusted shape at runtime, where the type
 *    system is long gone. Excess-property checking only fires on object
 *    literals the compiler can see; it does nothing to a JSON payload.
 * 2. **Resolution must fail closed.** No tenant, no booking. There is no
 *    fallback to a supplied id, because a fallback is the hole reopened.
 */
export async function createBookingAction(
  request: CreateBookingRequest,
): Promise<CreateBookingResult> {
  try {
    // The declared type is erased at runtime and this value came off the wire,
    // so the one field the whole tenant decision rests on is checked for real.
    // Scope: deliberately only this field — validating the rest of the payload
    // is worth doing, but it is a separate concern from tenant identity and is
    // not what this issue changes.
    const slug = request?.customerSlug;
    if (typeof slug !== "string" || slug.length === 0) {
      return { ok: false, error: UNKNOWN_TENANT_MESSAGE };
    }

    const tenant = await getTenantBySlug(slug);
    if (!tenant) {
      return { ok: false, error: UNKNOWN_TENANT_MESSAGE };
    }

    const booking = await createBooking({
      // Server-resolved, from the database, keyed by the public slug. This is
      // the only place a `customer_id` enters the write path.
      customerId: tenant.id,
      // Copied field-by-field — see rule 1 above. Do not replace with a spread.
      serviceId: request.serviceId,
      slot: request.slot,
      guest: request.guest,
      customFields: request.customFields,
    });
    return { ok: true, bookingId: booking.id };
  } catch (err) {
    const error =
      err instanceof Error
        ? err.message
        : "Something went wrong creating your booking.";
    return { ok: false, error };
  }
}
