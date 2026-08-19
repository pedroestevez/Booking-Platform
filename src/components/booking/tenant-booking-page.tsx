import { BookingFlow } from "@/components/booking/booking-flow";
import { TenantTheme } from "@/components/booking/tenant-theme";
import { isEmailConfigured } from "@/lib/email/provider";
import type { AvailabilityRule, BlockedSlot, Booking, Service, Tenant } from "@/lib/types";

/**
 * The tenant booking page's body — service selector, calendar, guest details,
 * confirmation — shared by BOTH ways a tenant is addressed (ALI-211):
 * `/<slug>` (`src/app/[customerSlug]/page.tsx`) and a tenant's own custom
 * domain at `/` (`src/app/page.tsx`). Extracted so those two routes render
 * identical markup from one component instead of two copies that could drift
 * apart — same header (logo/initial, name, tagline), same `<BookingFlow>`
 * props, same footer.
 *
 * Pure presentation: every read (`getActiveServices`, `getAvailabilityRules`,
 * `getBlockedSlots`, `getUpcomingBookings`) happens in the caller, keyed on
 * the already-resolved `tenant.id` — this component does no data access of
 * its own.
 *
 * `hideBranding` (ALI-115): the "Powered by Booking Platform" footer is the
 * platform attribution the free tier carries. `/<slug>` always shows it — the
 * URL itself already says this is a shared platform. A tenant's own custom
 * domain is what the white-label upgrade actually buys, so the caller passes
 * `hideBranding` there. This component makes no host/tenant decision of its
 * own; it only renders what the caller, which already resolved that, tells it
 * to.
 */
export function TenantBookingPage({
  tenant,
  services,
  rules,
  blocked,
  bookings,
  hideBranding = false,
}: {
  tenant: Tenant;
  services: Service[];
  rules: AvailabilityRule[];
  blocked: BlockedSlot[];
  bookings: Booking[];
  hideBranding?: boolean;
}) {
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

        {!hideBranding && (
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
