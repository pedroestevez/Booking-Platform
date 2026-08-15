"use server";

import { revalidatePath } from "next/cache";

import { resolveAdminContext } from "@/lib/admin/auth";
import {
  createService,
  setServiceActive,
  updateService,
  type ServiceInput,
} from "@/lib/admin/config";

/** Parse + validate the service form. Mirrors the DB checks (duration > 0, price ≥ 0). */
function parseServiceForm(formData: FormData): ServiceInput {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const durationMinutes = Number(formData.get("durationMinutes"));
  const priceDollars = Number(formData.get("price"));

  if (!name) throw new Error("Service name is required.");
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new Error("Duration must be greater than 0 minutes.");
  }
  if (!Number.isFinite(priceDollars) || priceDollars < 0) {
    throw new Error("Price must be 0 or more.");
  }

  return {
    name,
    description,
    durationMinutes: Math.round(durationMinutes),
    priceCents: Math.round(priceDollars * 100),
  };
}

/** Revalidate the admin pages this change affects plus the public booking page. */
function revalidateService(slug: string) {
  revalidatePath("/admin/services");
  revalidatePath("/admin");
  revalidatePath(`/${slug}`);
}

export async function createServiceAction(formData: FormData): Promise<void> {
  const { tenant } = await resolveAdminContext();
  await createService(tenant.id, parseServiceForm(formData));
  revalidateService(tenant.slug);
}

export async function updateServiceAction(
  id: string,
  formData: FormData,
): Promise<void> {
  const { tenant } = await resolveAdminContext();
  await updateService(tenant.id, id, parseServiceForm(formData));
  revalidateService(tenant.slug);
}

export async function setServiceActiveAction(
  id: string,
  active: boolean,
): Promise<void> {
  const { tenant } = await resolveAdminContext();
  await setServiceActive(tenant.id, id, active);
  revalidateService(tenant.slug);
}
