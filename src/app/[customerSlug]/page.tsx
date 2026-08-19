import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import { TenantBookingPage } from "@/components/booking/tenant-booking-page";
import { resolveRequestHost } from "@/lib/request-host";
import {
  getActiveServices,
  getAvailabilityRules,
  getBlockedSlots,
  getTenantBySlug,
  getUpcomingBookings,
} from "@/lib/tenants";

interface PageProps {
  params: Promise<{ customerSlug: string }>;
}

// Availability is live and time-sensitive, and reads hit Supabase at request
// time — render per request rather than statically pre-building tenant pages.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { customerSlug } = await params;
  const tenant = await getTenantBySlug(customerSlug);
  if (!tenant) return { title: "Not found" };
  return {
    title: `Book with ${tenant.name}`,
    description: tenant.branding.tagline,
  };
}

export default async function CustomerSlugPage({ params }: PageProps) {
  const { customerSlug } = await params;
  const tenant = await getTenantBySlug(customerSlug);
  if (!tenant) notFound();

  // ALI-211: once a tenant has its own custom domain, the `/<slug>` URL is a
  // permanent redirect to `/` — but ONLY when the request actually arrived on
  // THAT tenant's own domain. `tenant.customDomain` being set is a fact about
  // the tenant, not about this request: `booking.aligncompass.com/<slug>`
  // must keep working exactly as it does today for a tenant that also has a
  // custom domain, so the redirect is host-scoped, comparing the resolved
  // request host against `tenant.customDomain` rather than acting on
  // `tenant.customDomain`'s mere presence.
  //
  // `permanentRedirect` (308), not `redirect` (307): this is a URL that has
  // permanently moved, matching how browsers and search engines should treat
  // it going forward — a distinction ALI-211 calls out explicitly.
  if (tenant.customDomain) {
    const host = await resolveRequestHost();
    if (host && host === tenant.customDomain) {
      permanentRedirect("/");
    }
  }

  // Tenant-scoped reads — every query is keyed by the resolved customer id.
  const [services, rules, blocked, bookings] = await Promise.all([
    getActiveServices(tenant.id),
    getAvailabilityRules(tenant.id),
    getBlockedSlots(tenant.id),
    getUpcomingBookings(tenant.id),
  ]);

  return (
    <TenantBookingPage
      tenant={tenant}
      services={services}
      rules={rules}
      blocked={blocked}
      bookings={bookings}
    />
  );
}
