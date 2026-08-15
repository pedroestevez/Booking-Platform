import "server-only";

import { createServiceRoleClient } from "@/lib/supabase/server";
import type { BookingStatus } from "@/lib/types";

/**
 * Admin booking data-access.
 *
 * Owner-facing reads/writes for a single tenant. Like the public layer, every
 * query goes through the server-only service-role client and is *always*
 * filtered by `customerId` — the mandated defense-in-depth filter — so an owner
 * can only ever see or mutate their own tenant's rows. The `customerId` here is
 * the one resolved from the signed-in user's membership (see `admin/auth.ts`),
 * never a browser-supplied value.
 */

/** A booking flattened with its service + guest, for the admin tables. */
export interface AdminBooking {
  id: string;
  /** ISO 8601 instant. */
  start: string;
  /** ISO 8601 instant. */
  end: string;
  status: BookingStatus;
  notes?: string;
  serviceName: string;
  priceCents: number;
  durationMinutes: number;
  guestName: string;
  guestEmail: string;
  guestPhone?: string;
}

interface AdminBookingRow {
  id: string;
  start_time: string;
  end_time: string;
  status: BookingStatus;
  notes: string | null;
  service: { name: string; price_cents: number; duration_minutes: number } | null;
  guest: { name: string; email: string; phone: string | null } | null;
}

function mapAdminBooking(row: AdminBookingRow): AdminBooking {
  return {
    id: row.id,
    start: row.start_time,
    end: row.end_time,
    status: row.status,
    notes: row.notes ?? undefined,
    serviceName: row.service?.name ?? "(deleted service)",
    priceCents: row.service?.price_cents ?? 0,
    durationMinutes: row.service?.duration_minutes ?? 0,
    guestName: row.guest?.name?.trim() || row.guest?.email || "Guest",
    guestEmail: row.guest?.email ?? "",
    guestPhone: row.guest?.phone ?? undefined,
  };
}

/**
 * Every booking for a tenant (all statuses), with service + guest joined,
 * ordered chronologically. The page splits these into upcoming vs. past.
 */
export async function getAdminBookings(
  customerId: string,
): Promise<AdminBooking[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("bookings")
    .select(
      "id, start_time, end_time, status, notes, " +
        "service:services(name, price_cents, duration_minutes), " +
        "guest:end_customers(name, email, phone)",
    )
    .eq("customer_id", customerId)
    .order("start_time", { ascending: true })
    .returns<AdminBookingRow[]>();

  if (error) throw error;
  return (data ?? []).map(mapAdminBooking);
}

/** Headline numbers for the admin overview. */
export interface AdminOverview {
  upcomingCount: number;
  todayCount: number;
  activeServices: number;
  /** Sum of service price for upcoming pending/confirmed bookings (cents). */
  revenueBookedCents: number;
  /** The next few upcoming bookings, soonest first. */
  nextBookings: AdminBooking[];
}

export async function getAdminOverview(
  customerId: string,
): Promise<AdminOverview> {
  const supabase = createServiceRoleClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const endOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  ).toISOString();

  const [upcomingRes, servicesRes] = await Promise.all([
    supabase
      .from("bookings")
      .select(
        "id, start_time, end_time, status, notes, " +
          "service:services(name, price_cents, duration_minutes), " +
          "guest:end_customers(name, email, phone)",
      )
      .eq("customer_id", customerId)
      .in("status", ["pending", "confirmed"])
      .gte("end_time", nowIso)
      .order("start_time", { ascending: true })
      .returns<AdminBookingRow[]>(),
    supabase
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customerId)
      .eq("active", true),
  ]);

  if (upcomingRes.error) throw upcomingRes.error;
  if (servicesRes.error) throw servicesRes.error;

  const upcoming = (upcomingRes.data ?? []).map(mapAdminBooking);
  const revenueBookedCents = upcoming.reduce((sum, b) => sum + b.priceCents, 0);
  const todayCount = upcoming.filter((b) => b.start <= endOfToday).length;

  return {
    upcomingCount: upcoming.length,
    todayCount,
    activeServices: servicesRes.count ?? 0,
    revenueBookedCents,
    nextBookings: upcoming.slice(0, 5),
  };
}

const ALLOWED_STATUSES: readonly BookingStatus[] = [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
];

/**
 * Change a booking's status. Scoped by `customerId` so an owner can never
 * mutate another tenant's booking, even with a guessed id.
 */
export async function updateBookingStatus(
  customerId: string,
  bookingId: string,
  status: BookingStatus,
): Promise<void> {
  if (!ALLOWED_STATUSES.includes(status)) {
    throw new Error(`Invalid booking status: ${status}`);
  }
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("bookings")
    .update({ status })
    .eq("id", bookingId)
    .eq("customer_id", customerId);

  if (error) throw error;
}
