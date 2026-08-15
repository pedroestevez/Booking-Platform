import "server-only";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { createServiceRoleClient } from "@/lib/supabase/server";
import { mapTenantMember, type TenantMemberRow } from "@/lib/supabase/rows";
import { getTenantById } from "@/lib/tenants";
import type { Tenant, TenantMember } from "@/lib/types";

/**
 * Admin auth resolution.
 *
 * Auth (Clerk) is deliberately decoupled from RLS. We never hand an end-user JWT
 * to PostgREST; instead the signed-in Clerk user is mapped to a tenant via
 * `tenant_members`, and from there every query uses the existing pattern — the
 * server-only service-role client scoped by `customer_id`. Keeping this behind
 * `server-only` guarantees the resolution never ships to the browser.
 */

export interface AdminContext {
  /** The Clerk user id ("user_…"). */
  userId: string;
  /** The tenant this owner administers, scoped by `tenant.id` everywhere after. */
  tenant: Tenant;
  /** The membership row linking the user to the tenant. */
  member: TenantMember;
}

/**
 * Resolve the membership for an auth subject. Uses the service-role client,
 * which bypasses RLS — the one lookup that can't yet be customer-scoped (it
 * produces the `customer_id` everything else is scoped by), mirroring the
 * slug → customer lookup. A user may belong to several tenants; for now we
 * take the earliest membership (a tenant switcher is future work).
 */
export async function getMembershipBySubject(
  authSubject: string,
): Promise<TenantMember | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("tenant_members")
    .select("id, customer_id, auth_subject, email, role")
    .eq("auth_subject", authSubject)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<TenantMemberRow>();

  if (error) throw error;
  return data ? mapTenantMember(data) : null;
}

/**
 * Resolve the full admin context for the current request, or redirect:
 *   • not signed in            → /admin/sign-in
 *   • signed in, no membership → /admin/no-access
 * Call this at the top of every protected admin page/layout and action.
 */
export async function resolveAdminContext(): Promise<AdminContext> {
  const { userId } = await auth();
  if (!userId) redirect("/admin/sign-in");

  const member = await getMembershipBySubject(userId);
  if (!member) redirect("/admin/no-access");

  const tenant = await getTenantById(member.customerId);
  if (!tenant) redirect("/admin/no-access");

  return { userId, tenant, member };
}
