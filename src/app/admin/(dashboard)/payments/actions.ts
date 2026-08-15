"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { resolveAdminContext } from "@/lib/admin/auth";
import {
  createDashboardLink,
  refreshAccountStatus,
  setPlatformFeeBps,
  startOnboarding,
} from "@/lib/admin/payments";

/** Absolute origin for Stripe return URLs — prefer the real request host. */
async function getOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`;
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export async function startOnboardingAction(): Promise<void> {
  const { tenant } = await resolveAdminContext();
  const url = await startOnboarding(tenant.id, await getOrigin());
  redirect(url);
}

export async function refreshStatusAction(): Promise<void> {
  const { tenant } = await resolveAdminContext();
  await refreshAccountStatus(tenant.id);
  revalidatePath("/admin/payments");
}

export async function openDashboardAction(): Promise<void> {
  const { tenant } = await resolveAdminContext();
  const url = await createDashboardLink(tenant.id);
  redirect(url);
}

export async function setPlatformFeeAction(formData: FormData): Promise<void> {
  const { tenant } = await resolveAdminContext();
  const percent = Number(formData.get("feePercent"));
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("Fee must be between 0 and 100%.");
  }
  // Percent → basis points (2.5% → 250).
  await setPlatformFeeBps(tenant.id, Math.round(percent * 100));
  revalidatePath("/admin/payments");
}
