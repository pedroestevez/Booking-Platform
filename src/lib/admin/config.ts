import "server-only";

import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  mapBlockedSlot,
  mapService,
  type BlockedSlotRow,
  type ServiceRow,
} from "@/lib/supabase/rows";
import { getAvailabilityRules } from "@/lib/tenants";
import type { AvailabilityRule, BlockedSlot, Service } from "@/lib/types";

/**
 * Admin configuration data-access — the tenant's own settings that drive the
 * public booking flow: services, weekly availability, and one-off blocks. Like
 * every data path, these go through the server-only service-role client and are
 * always scoped by `customerId` (the value resolved from the signed-in user's
 * membership, never browser input).
 */

// ── Services ──────────────────────────────────────────────────────────────────

/** All services for a tenant, including inactive ones (the public side hides those). */
export async function listServices(customerId: string): Promise<Service[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("services")
    .select("id, customer_id, name, description, duration_minutes, price_cents, active")
    .eq("customer_id", customerId)
    .order("name", { ascending: true })
    .returns<ServiceRow[]>();

  if (error) throw error;
  return (data ?? []).map(mapService);
}

export interface ServiceInput {
  name: string;
  description: string;
  durationMinutes: number;
  priceCents: number;
}

export async function createService(
  customerId: string,
  input: ServiceInput,
): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("services").insert({
    customer_id: customerId,
    name: input.name,
    description: input.description,
    duration_minutes: input.durationMinutes,
    price_cents: input.priceCents,
    active: true,
  });
  if (error) throw error;
}

export async function updateService(
  customerId: string,
  id: string,
  input: ServiceInput,
): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("services")
    .update({
      name: input.name,
      description: input.description,
      duration_minutes: input.durationMinutes,
      price_cents: input.priceCents,
    })
    .eq("id", id)
    .eq("customer_id", customerId);
  if (error) throw error;
}

/** Soft enable/disable. Services are deactivated, not deleted (bookings reference them). */
export async function setServiceActive(
  customerId: string,
  id: string,
  active: boolean,
): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("services")
    .update({ active })
    .eq("id", id)
    .eq("customer_id", customerId);
  if (error) throw error;
}

// ── Availability rules ──────────────────────────────────────────────────────────

/** Weekly recurring open hours for a tenant (reuses the public read; same scope). */
export async function listAvailabilityRules(
  customerId: string,
): Promise<AvailabilityRule[]> {
  return getAvailabilityRules(customerId);
}

export interface AvailabilityRuleInput {
  dayOfWeek: number;
  /** "HH:mm". */
  startTime: string;
  /** "HH:mm". */
  endTime: string;
  bufferMinutes: number;
}

export async function createAvailabilityRule(
  customerId: string,
  input: AvailabilityRuleInput,
): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("availability_rules").insert({
    customer_id: customerId,
    day_of_week: input.dayOfWeek,
    start_time: input.startTime,
    end_time: input.endTime,
    buffer_minutes: input.bufferMinutes,
  });
  if (error) throw error;
}

export async function deleteAvailabilityRule(
  customerId: string,
  id: string,
): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("availability_rules")
    .delete()
    .eq("id", id)
    .eq("customer_id", customerId);
  if (error) throw error;
}

// ── Blocked slots ───────────────────────────────────────────────────────────────

/** All blocked windows for a tenant, soonest-expiring last (most recent start first). */
export async function listBlockedSlots(
  customerId: string,
): Promise<BlockedSlot[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("blocked_slots")
    .select("id, customer_id, start_time, end_time, reason")
    .eq("customer_id", customerId)
    .order("start_time", { ascending: false })
    .returns<BlockedSlotRow[]>();

  if (error) throw error;
  return (data ?? []).map(mapBlockedSlot);
}

export interface BlockedSlotInput {
  /** ISO 8601 instant. */
  start: string;
  /** ISO 8601 instant. */
  end: string;
  reason?: string;
}

export async function createBlockedSlot(
  customerId: string,
  input: BlockedSlotInput,
): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("blocked_slots").insert({
    customer_id: customerId,
    start_time: input.start,
    end_time: input.end,
    reason: input.reason ?? null,
  });
  if (error) throw error;
}

export async function deleteBlockedSlot(
  customerId: string,
  id: string,
): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("blocked_slots")
    .delete()
    .eq("id", id)
    .eq("customer_id", customerId);
  if (error) throw error;
}
