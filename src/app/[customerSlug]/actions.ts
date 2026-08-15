"use server";

import { createBooking } from "@/lib/bookings";
import type { CreateBookingInput } from "@/lib/types";

export type CreateBookingResult =
  | { ok: true; bookingId: string }
  | { ok: false; error: string };

/**
 * Create a (pending) booking from the guest flow. Stripe is deferred (ALI-27);
 * this resolves-or-creates the guest identity and reserves the slot. Inputs are
 * trusted only after server-side re-validation in `createBooking`.
 */
export async function createBookingAction(
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  try {
    const booking = await createBooking(input);
    return { ok: true, bookingId: booking.id };
  } catch (err) {
    const error =
      err instanceof Error
        ? err.message
        : "Something went wrong creating your booking.";
    return { ok: false, error };
  }
}
