import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CalendarCheck } from "lucide-react";

import { TenantBookingPage } from "@/components/booking/tenant-booking-page";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isPlatformSharedHost, resolveRequestHost } from "@/lib/request-host";
import { tenantIndexEnabled } from "@/lib/tenant-index";
import {
  getActiveServices,
  getAllTenants,
  getAvailabilityRules,
  getBlockedSlots,
  getTenantByHost,
  getUpcomingBookings,
} from "@/lib/tenants";
import type { Tenant } from "@/lib/types";

/**
 * Kept `force-dynamic` deliberately, even though the production render below
 * reads nothing for the platform's own hosts (ALI-176 criterion 3). The route
 * is rendered per request, so no build can ever bake a tenant list — or now, a
 * custom-domain tenant's booking page — into a static artifact. The
 * platform-host path issues no query, so there is nothing to cache anyway.
 */
export const dynamic = "force-dynamic";

/**
 * ALI-211: a tenant on its own custom domain gets the slug route's metadata
 * (same title/description shape) with no `/<slug>` in the URL. The platform's
 * own hosts (`booking.aligncompass.com`, `*.vercel.app`, `localhost`) never
 * reach `getTenantByHost` — `isPlatformSharedHost` short-circuits first, so
 * there is no query and this falls through to Next's default metadata, same
 * as before this feature existed.
 */
export async function generateMetadata(): Promise<Metadata> {
  const host = await resolveRequestHost();
  if (!host || isPlatformSharedHost(host)) return {};

  const tenant = await getTenantByHost(host);
  if (!tenant) return {};

  return {
    title: `Book with ${tenant.name}`,
    description: tenant.branding.tagline,
  };
}

/**
 * Platform root. This app is addressed per tenant at `/<slug>` (unchanged) OR,
 * since ALI-211, directly at `/` on a tenant's own custom domain — resolved
 * from the request's Host header via `getTenantByHost`. The tenant list
 * further down is a **development-only** index, gated by
 * `tenantIndexEnabled()`.
 *
 * Host resolution happens here, in the page, not in `src/middleware.ts`: the
 * matcher there is scoped to `/admin` on purpose (widening it to `/` 404s the
 * homepage whenever Clerk env vars are absent — see that file), and this needs
 * no edge-runtime behavior, only a header read plus a Supabase call — which
 * edge middleware cannot make either.
 *
 * `isPlatformSharedHost` is checked BEFORE any database call: the platform's
 * own hosts are never a tenant's `custom_domain` (see `request-host.ts`), so
 * skipping the query there is not an optimization that could go stale — it is
 * the same fact both branches already know.
 */
export default async function HomePage() {
  const host = await resolveRequestHost();

  if (host && !isPlatformSharedHost(host)) {
    const tenant = await getTenantByHost(host);
    if (tenant) {
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
    // No tenant claims this host — fall through to the landing page below,
    // exactly as if the host had been a platform-shared one.
  }

  const tenants = tenantIndexEnabled() ? await getAllTenants() : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-4 py-16">
      <div className="mb-10 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
          <CalendarCheck className="size-6" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Booking Platform
        </h1>
        <p className="mx-auto mt-2 max-w-md text-balance text-muted-foreground">
          One centrally-hosted, white-labeled booking experience that every
          customer site embeds at{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-sm">
            /your-slug
          </code>
          .
        </p>
      </div>

      {tenants !== null && <TenantIndex tenants={tenants} />}
    </main>
  );
}

/**
 * The development index. Not exported: nothing outside this file should be able
 * to render a tenant list, and a page module's exports are its route contract.
 */
function TenantIndex({ tenants }: { tenants: Tenant[] }) {
  return (
    <>
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Tenants
      </p>
      {tenants.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No tenants yet. Add one to the <code>customers</code> table to see it
          here.
        </p>
      )}
      <div className="grid gap-3">
        {tenants.map((tenant) => (
          <Card key={tenant.id} className="transition-shadow hover:shadow-md">
            <CardContent className="flex items-center gap-4 p-4">
              <div
                className="flex size-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white"
                style={{ backgroundColor: tenant.branding.brandColor }}
              >
                {tenant.name.charAt(0)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{tenant.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  /{tenant.slug}
                </p>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={`/${tenant.slug}`}>
                  Open
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
