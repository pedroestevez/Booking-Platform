import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { BookingFlow } from "@/components/booking/booking-flow";
import { TenantTheme } from "@/components/booking/tenant-theme";
import { isEmailConfigured } from "@/lib/email/provider";
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

  // On a tenant's custom domain, the platform's own branding (the root
  // layout's "%s · Booking Platform" title template) has no business
  // showing up in the tab title — an `{ absolute }` title bypasses the
  // template entirely (ALI-115).
  const onCustomDomain = (await headers()).get("x-booking-custom-domain") === "1";
  return {
    title: onCustomDomain
      ? { absolute: `Book with ${tenant.name}` }
      : `Book with ${tenant.name}`,
    description: tenant.branding.tagline,
  };
}

export default async function TenantBookingPage({ params }: PageProps) {
  const { customerSlug } = await params;
  const tenant = await getTenantBySlug(customerSlug);
  if (!tenant) notFound();

  // White-labeled: a tenant reached via their own custom domain gets no
  // "Powered by Booking Platform" attribution (ALI-115).
  const onCustomDomain = (await headers()).get("x-booking-custom-domain") === "1";

  // Tenant-scoped reads — every query is keyed by the resolved customer id.
  const [services, rules, blocked, bookings] = await Promise.all([
    getActiveServices(tenant.id),
    getAvailabilityRules(tenant.id),
    getBlockedSlots(tenant.id),
    getUpcomingBookings(tenant.id),
  ]);

  return (
    <TenantTheme
      branding={tenant.branding}
      className="min-h-dvh bg-mesh bg-background"
    >
      <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-8 sm:py-12">
        <header className="mb-8 text-center">
          {tenant.branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={tenant.branding.logoUrl}
              alt={tenant.name}
              className="mx-auto mb-3 h-10 w-auto"
            />
          ) : (
            <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl bg-primary text-base font-bold text-primary-foreground shadow-sm">
              {tenant.name.charAt(0)}
            </div>
          )}
          <h1 className="text-2xl font-semibold tracking-tight">
            {tenant.name}
          </h1>
          {tenant.branding.tagline && (
            <p className="mt-1 text-sm text-muted-foreground">
              {tenant.branding.tagline}
            </p>
          )}
        </header>

        <main className="flex-1">
          <BookingFlow
            tenant={tenant}
            services={services}
            rules={rules}
            blocked={blocked}
            bookings={bookings}
            notificationsEnabled={isEmailConfigured()}
          />
        </main>

        {!onCustomDomain && (
          <footer className="mt-10 text-center">
            <p className="text-xs text-muted-foreground">
              Powered by{" "}
              <span className="font-medium text-foreground/70">Booking Platform</span>
            </p>
          </footer>
        )}
      </div>
    </TenantTheme>
  );
}
