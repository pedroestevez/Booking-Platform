import "server-only";

import { cache } from "react";

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
    .select("id, name, slug, branding_json, custom_domain")
    .eq("slug", slug)
    .maybeSingle<CustomerRow>();

  if (error) throw error;
  return data ? mapTenant(data) : null;
}

/**
 * Resolve a tenant by the HTTP host it is addressed at directly (ALI-211),
 * e.g. `booking.pedroestevez.com` — no `/<slug>` prefix. Same shape as
 * `getTenantBySlug`: service-role client (the tenant isn't known yet, so
 * there's no `customer_id` to satisfy an RLS predicate with), `mapTenant`.
 *
 * Callers must pass an already-normalized host (see
 * `resolveRequestHost`/`isPlatformSharedHost` in `@/lib/request-host`) — this
 * function does no normalization of its own, matching the column's own
 * lowercase-enforced form (migration 0008).
 *
 * Wrapped in React's `cache()` so `generateMetadata` and the page body — which
 * both need this for the same request — share one query instead of issuing it
 * twice. Per-request only: `cache()` memoizes for the lifetime of one render,
 * never across requests.
 */
export const getTenantByHost = cache(async function getTenantByHost(
  host: string,
): Promise<Tenant | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("customers")
    .select("id, name, slug, branding_json, custom_domain")
    .eq("custom_domain", host)
    .maybeSingle<CustomerRow>();

  if (error) throw error;
  return data ? mapTenant(data) : null;
});

/** Resolve a tenant by its id (used by the admin layer after a membership lookup). */
export async function getTenantById(customerId: string): Promise<Tenant | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("customers")
    .select("id, name, slug, branding_json, custom_domain")
    .eq("id", customerId)
    .maybeSingle<CustomerRow>();

  if (error) throw error;
  return data ? mapTenant(data) : null;
}

/**
 * The IANA timezone a tenant operates in, resolved **server-side** from a
 * `customer_id` (ALI-117 criterion 7).
 *
 * Exists as its own read rather than as a `branding.timezone` lookup at the
 * call site because of where the value ends up: `createBooking` runs on the
 * RLS-bypassing service-role client, so every input it uses to decide *which
 * times exist* has to originate here, from the tenant's own row, and never from
 * a request payload. That is ALI-139's lesson applied to a second
 * browser-reachable value — a guest who could supply the zone could shift the
 * whole availability window and book a time the business never offered.
 *
 * Scoped by `customer_id` in app code (the mandated defense-in-depth filter)
 * even though it is the primary key, matching every other read in this file.
 *
 * Throws when the tenant does not exist: the caller is about to decide whether
 * a slot is real, and there is no safe guess. The `?? "UTC"` inside `mapTenant`
 * for a tenant whose `branding_json` omits `timezone` is a separate, narrower
 * gap tracked in ALI-184 — deliberately not papered over here, where papering
 * would hide it.
 */
export async function getTenantTimeZone(customerId: string): Promise<string> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("customers")
    .select("id, name, slug, branding_json, custom_domain")
    .eq("id", customerId)
    .maybeSingle<CustomerRow>();

  if (error) throw error;
  if (!data) throw new Error("This booking page is no longer available.");
  return mapTenant(data).branding.timezone;
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
 * The one status that frees a booking's slot. Everything else — `pending`,
 * `confirmed`, `completed`, and any status added later — occupies it.
 *
 * Exported so `booking-overlap.db.test.ts` (criterion 8) can build the
 * availability predicate from the same value this query uses, rather than
 * restating it and hoping the two stay in step. It must equal the exemption in
 * `bookings_no_overlap`'s `where (status <> 'cancelled')` predicate (0006).
 */
export const SLOT_FREEING_STATUS = "cancelled";

/**
 * Upcoming live bookings for a tenant, used to subtract taken times from the
 * slot grid.
 *
 * The filter is `status <> 'cancelled'` — **the same predicate as the
 * `bookings_no_overlap` exclusion constraint** in migration 0006 (ALI-98).
 * These two sets must be identical. If this query is the narrower of the two,
 * the difference renders as *ghost slots*: times the grid offers as free that
 * the database then refuses at submit time, so the guest picks a slot, fills
 * in their details, and is told to pick another. If it were the wider of the
 * two, real availability would silently disappear.
 *
 * It was `.in("status", ["pending", "confirmed"])`, which made `completed` a
 * ghost. Stated as an exclusion rather than an allow-list so a future fifth
 * status is treated as occupying by default — the safe direction — instead of
 * silently freeing the slot. `booking-overlap.db.test.ts` (criterion 8) derives
 * both sets from the live schema and fails if they ever diverge.
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
    .neq("status", SLOT_FREEING_STATUS)
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
    .select("id, name, slug, branding_json, custom_domain")
    .order("name", { ascending: true })
    .returns<CustomerRow[]>();

  if (error) throw error;
  return (data ?? []).map(mapTenant);
}
