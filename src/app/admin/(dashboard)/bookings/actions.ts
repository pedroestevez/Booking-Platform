"use server";

import { revalidatePath } from "next/cache";

import { resolveAdminContext } from "@/lib/admin/auth";
import { updateBookingStatus } from "@/lib/admin/bookings";
import type { BookingStatus } from "@/lib/types";

/**
 * Change a booking's status from the admin UI. Re-resolves the admin context
 * server-side (never trusting a client-supplied tenant) and scopes the write to
 * the resolved tenant, then revalidates the affected pages.
 */
export async function setBookingStatusAction(
  bookingId: string,
  status: BookingStatus,
): Promise<void> {
  const { tenant } = await resolveAdminContext();
  await updateBookingStatus(tenant.id, bookingId, status);
  revalidatePath("/admin/bookings");
  revalidatePath("/admin");
}
