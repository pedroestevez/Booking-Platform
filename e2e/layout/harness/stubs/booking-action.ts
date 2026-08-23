import type { CreateBookingResult } from "@/app/[customerSlug]/actions";

/**
 * Stands in for the `"use server"` module `BookingFlow` imports.
 *
 * A server action cannot be bundled for the browser, and this suite never
 * reaches step 3 anyway — it measures the schedule step's geometry. The stub is
 * deliberately at the *edge* of the shell: it replaces a submit handler, not
 * any element that occupies space.
 */
export async function createBookingAction(): Promise<CreateBookingResult> {
  return { ok: false, error: "Not available in the layout harness." };
}
