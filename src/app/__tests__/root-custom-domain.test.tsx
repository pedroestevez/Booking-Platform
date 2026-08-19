import { headers } from "next/headers";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

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
 * `/` resolves a tenant from the request Host header (ALI-211), so
 * `booking.pedroestevez.com/` renders that tenant's booking page directly —
 * no `/<slug>` in the URL — while the platform's own hosts keep rendering
 * today's landing page (dev tenant index in development, bare header in
 * production) exactly as before this feature existed.
 *
 * `next/headers` is mocked the same way `tenant-index.test.ts` mocks it.
 * `TenantBookingPage` is mocked to a small marker component: what is under
 * test here is *routing* — which host resolves to which tenant, and which
 * queries fire — not the booking UI itself, which has its own coverage.
 *
 * ## Falsification (done by hand while building this, not re-asserted here)
 *
 * Two defects were deliberately reintroduced against this exact suite and
 * reverted after confirming the failure:
 *   1. Skipping the host check entirely (always falling through to the
 *      landing page) turned "renders the tenant at its own custom domain" red
 *      — the marker never appeared and `getActiveServices` was never called.
 *   2. Removing the `isPlatformSharedHost` short-circuit (calling
 *      `getTenantByHost` unconditionally) turned "does not query the database
 *      for the platform's own host" red — `getTenantByHost` was called when
 *      the assertion required it not to be.
 */

vi.mock("@/lib/tenants", () => ({
  getAllTenants: vi.fn(),
  getTenantByHost: vi.fn(),
  getActiveServices: vi.fn(),
  getAvailabilityRules: vi.fn(),
  getBlockedSlots: vi.fn(),
  getUpcomingBookings: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

vi.mock("@/components/booking/tenant-booking-page", () => ({
  TenantBookingPage: ({ tenant }: { tenant: Tenant }) => (
    <div data-testid="tenant-booking-page">{tenant.name}</div>
  ),
}));

const TENANT: Tenant = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Pedro Estevez Coaching",
  slug: "pedroestevez",
  branding: { brandColor: "oklch(0.55 0.16 250)", currency: "USD", timezone: "America/New_York" },
  customDomain: "booking.pedroestevez.com",
};

function stubHost(host: string): void {
  vi.mocked(headers).mockResolvedValue(
    new Headers({ host }) as unknown as Awaited<ReturnType<typeof headers>>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("the platform root — custom-domain tenant resolution", () => {
  it("renders the tenant's booking page directly at its own custom domain", async () => {
    stubHost("booking.pedroestevez.com");
    vi.mocked(getTenantByHost).mockResolvedValue(TENANT);
    vi.mocked(getActiveServices).mockResolvedValue([]);
    vi.mocked(getAvailabilityRules).mockResolvedValue([]);
    vi.mocked(getBlockedSlots).mockResolvedValue([]);
    vi.mocked(getUpcomingBookings).mockResolvedValue([]);

    const { default: HomePage } = await import("@/app/page");
    const html = renderToStaticMarkup(await HomePage());

    expect(getTenantByHost).toHaveBeenCalledWith("booking.pedroestevez.com");
    expect(getActiveServices).toHaveBeenCalledWith(TENANT.id);
    expect(getAvailabilityRules).toHaveBeenCalledWith(TENANT.id);
    expect(getBlockedSlots).toHaveBeenCalledWith(TENANT.id);
    expect(getUpcomingBookings).toHaveBeenCalledWith(TENANT.id);

    expect(html).toContain("Pedro Estevez Coaching");
    // Not the platform landing page.
    expect(html).not.toContain("Booking Platform");
    expect(getAllTenants).not.toHaveBeenCalled();
  });

  it("does not query the database for the platform's own shared host", async () => {
    stubHost("booking.aligncompass.com");
    vi.stubEnv("NODE_ENV", "production");

    const { default: HomePage } = await import("@/app/page");
    const html = renderToStaticMarkup(await HomePage());

    expect(getTenantByHost).not.toHaveBeenCalled();
    expect(html).toContain("Booking Platform");
    expect(html).not.toContain("tenant-booking-page");
  });

  it("falls through to the landing page for a host no tenant claims", async () => {
    stubHost("unclaimed-host.example");
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(getTenantByHost).mockResolvedValue(null);

    const { default: HomePage } = await import("@/app/page");
    const html = renderToStaticMarkup(await HomePage());

    // The lookup DID happen — this is "asked and got no answer", not
    // "never asked" (that is the platform-shared-host case above).
    expect(getTenantByHost).toHaveBeenCalledWith("unclaimed-host.example");
    expect(html).toContain("Booking Platform");
    expect(getActiveServices).not.toHaveBeenCalled();
  });

  it("never redirects or renders a tenant for booking.aligncompass.com/<slug> traffic (host, not path, decides)", async () => {
    // This suite only exercises `/`; the point recorded here is the contract
    // `isPlatformSharedHost` exists to hold — `booking.aligncompass.com` is
    // never treated as anyone's `custom_domain`, no matter what a tenant row
    // says, because it's a platform host, not a customer's own domain.
    stubHost("booking.aligncompass.com");
    vi.stubEnv("NODE_ENV", "production");

    const { default: HomePage } = await import("@/app/page");
    await HomePage();

    expect(getTenantByHost).not.toHaveBeenCalled();
  });
});

describe("the platform root — generateMetadata", () => {
  it("returns tenant metadata for a tenant's own custom domain", async () => {
    stubHost("booking.pedroestevez.com");
    vi.mocked(getTenantByHost).mockResolvedValue({
      ...TENANT,
      branding: { ...TENANT.branding, tagline: "Book time with Pedro" },
    });

    const { generateMetadata } = await import("@/app/page");
    const metadata = await generateMetadata();

    expect(metadata).toEqual({
      title: "Book with Pedro Estevez Coaching",
      description: "Book time with Pedro",
    });
  });

  it("returns default metadata for the platform's shared host, with no query", async () => {
    stubHost("booking.aligncompass.com");

    const { generateMetadata } = await import("@/app/page");
    const metadata = await generateMetadata();

    expect(metadata).toEqual({});
    expect(getTenantByHost).not.toHaveBeenCalled();
  });

  it("returns default metadata when no tenant claims the host", async () => {
    stubHost("unclaimed-host.example");
    vi.mocked(getTenantByHost).mockResolvedValue(null);

    const { generateMetadata } = await import("@/app/page");
    const metadata = await generateMetadata();

    expect(metadata).toEqual({});
  });
});
