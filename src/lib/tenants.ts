import "server-only";

import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  mapAvailabilityRule,
  mapBlockedSlot,
  mapBooking,
  mapService,
  mapTenant,
  type AvailabilityRuleRow,
  type BlockedSlotRow,
  type BookingRow,
  type CustomerRow,
  type ServiceRow,
} from "@/lib/supabase/rows";
import type {
  AvailabilityRule,
  BlockedSlot,
  Booking,
  Service,
  Tenant,
} from "@/lib/types";

/**
 * Tenant data-access layer.
 *
 * The single chokepoint for tenant-scoped reads. Every query goes through the
 * server-only service-role client (`createServiceRoleClient`) and *always*
 * filters by `customer_id` — the mandated defense-in-depth filter. Resolving the
 * tenant by slug is the one lookup that isn't yet customer-scoped (it produces
 * the id everything else is scoped by). Keeping this behind `server-only`
 * guarantees tenant resolution never ships to the browser.
 */

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("customers")
    .select("id, name, slug, branding_json")
    .eq("slug", slug)
    .maybeSingle<CustomerRow>();

  if (error) throw error;
  return data ? mapTenant(data) : null;
}

/** Resolve a tenant by its id (used by the admin layer after a membership lookup). */
export async function getTenantById(customerId: string): Promise<Tenant | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("customers")
    .select("id, name, slug, branding_json")
    .eq("id", customerId)
    .maybeSingle<CustomerRow>();

  if (error) throw error;
  return data ? mapTenant(data) : null;
}

export async function getActiveServices(customerId: string): Promise<Service[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("services")
    .select("id, customer_id, name, description, duration_minutes, price_cents, active")
    .eq("customer_id", customerId)
    .eq("active", true)
    .order("price_cents", { ascending: true })
    .returns<ServiceRow[]>();

  if (error) throw error;
  return (data ?? []).map(mapService);
}

export async function getAvailabilityRules(
  customerId: string,
): Promise<AvailabilityRule[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("availability_rules")
    .select("id, customer_id, day_of_week, start_time, end_time, buffer_minutes")
    .eq("customer_id", customerId)
    .returns<AvailabilityRuleRow[]>();

  if (error) throw error;
  return (data ?? []).map(mapAvailabilityRule);
}

export async function getBlockedSlots(
  customerId: string,
): Promise<BlockedSlot[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("blocked_slots")
    .select("id, customer_id, start_time, end_time, reason")
    .eq("customer_id", customerId)
    .gte("end_time", new Date().toISOString())
    .returns<BlockedSlotRow[]>();

  if (error) throw error;
  return (data ?? []).map(mapBlockedSlot);
}

/**
 * Upcoming live bookings for a tenant, used to subtract taken times from the
 * slot grid. Only active reservations (pending/confirmed) block a slot.
 */
export async function getUpcomingBookings(
  customerId: string,
): Promise<Booking[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("bookings")
    .select(
      "id, customer_id, service_id, end_customer_id, start_time, end_time, notes, status, custom_fields",
    )
    .eq("customer_id", customerId)
    .in("status", ["pending", "confirmed"])
    .gte("end_time", new Date().toISOString())
    .returns<BookingRow[]>();

  if (error) throw error;
  return (data ?? []).map(mapBooking);
}

/** All tenants, for the dev index at `/`. */
export async function getAllTenants(): Promise<Tenant[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("customers")
    .select("id, name, slug, branding_json")
    .order("name", { ascending: true })
    .returns<CustomerRow[]>();

  if (error) throw error;
  return (data ?? []).map(mapTenant);
}
