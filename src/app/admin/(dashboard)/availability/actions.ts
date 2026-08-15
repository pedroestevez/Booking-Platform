"use server";

import { revalidatePath } from "next/cache";

import { resolveAdminContext } from "@/lib/admin/auth";
import {
  createAvailabilityRule,
  createBlockedSlot,
  deleteAvailabilityRule,
  deleteBlockedSlot,
} from "@/lib/admin/config";

function revalidateAvailability(slug: string) {
  revalidatePath("/admin/availability");
  revalidatePath(`/${slug}`);
}

// ── Availability rules ──────────────────────────────────────────────────────────

export async function createAvailabilityRuleAction(
  formData: FormData,
): Promise<void> {
  const { tenant } = await resolveAdminContext();

  const dayOfWeek = Number(formData.get("dayOfWeek"));
  const startTime = String(formData.get("startTime") ?? "");
  const endTime = String(formData.get("endTime") ?? "");
  const bufferMinutes = Number(formData.get("bufferMinutes") ?? 0);

  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    throw new Error("Pick a valid day of the week.");
  }
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
    throw new Error("Start and end times are required.");
  }
  if (startTime >= endTime) {
    throw new Error("End time must be after start time.");
  }
  if (!Number.isFinite(bufferMinutes) || bufferMinutes < 0) {
    throw new Error("Buffer must be 0 or more minutes.");
  }

  await createAvailabilityRule(tenant.id, {
    dayOfWeek,
    startTime,
    endTime,
    bufferMinutes: Math.round(bufferMinutes),
  });
  revalidateAvailability(tenant.slug);
}

export async function deleteAvailabilityRuleAction(id: string): Promise<void> {
  const { tenant } = await resolveAdminContext();
  await deleteAvailabilityRule(tenant.id, id);
  revalidateAvailability(tenant.slug);
}

// ── Blocked slots ───────────────────────────────────────────────────────────────

export async function createBlockedSlotAction(
  formData: FormData,
): Promise<void> {
  const { tenant } = await resolveAdminContext();

  const startRaw = String(formData.get("start") ?? "");
  const endRaw = String(formData.get("end") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();

  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Start and end date/time are required.");
  }
  if (end <= start) {
    throw new Error("End must be after start.");
  }

  await createBlockedSlot(tenant.id, {
    // NOTE: datetime-local has no timezone; like the rest of v0.1 this treats
    // the entered wall-clock time as the instant. Tenant-timezone correctness
    // lands with the broader timezone work.
    start: start.toISOString(),
    end: end.toISOString(),
    reason: reason || undefined,
  });
  revalidateAvailability(tenant.slug);
}

export async function deleteBlockedSlotAction(id: string): Promise<void> {
  const { tenant } = await resolveAdminContext();
  await deleteBlockedSlot(tenant.id, id);
  revalidateAvailability(tenant.slug);
}
