import { headers } from "next/headers";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getActiveServices,
  getAvailabilityRules,
  getBlockedSlots,
  getTenantBySlug,
  getUpcomingBookings,
} from "@/lib/tenants";
import type { Tenant } from "@/lib/types";

/**
 * White-labeling on a tenant's custom domain (ALI-115 criteria 1-2).
 *
 * Middleware sets `x-booking-custom-domain: 1` on the FORWARDED request when
 * a request reached this page via a tenant's own domain rather than the
 * platform's `/<slug>` route (see `src/middleware.ts`). This page reads that
 * header via `headers()` and, when present:
 *   - drops the "Powered by Booking Platform" footer from the HTML entirely
 *     (not just hidden via CSS), and
 *   - returns an `{ absolute }` metadata title that bypasses the root
 *     layout's "%s · Booking Platform" template.
 *
 * `next/headers` has no existing mocking precedent in this repo, so its mock
 * shape here was confirmed by actually running these tests, not assumed —
 * `headers()` is async in Next 15, hence `mockResolvedValue`.
 */

vi.mock("next/headers", () => ({ headers: vi.fn() }));

vi.mock("@/lib/tenants", () => ({
  getTenantBySlug: vi.fn(),
  getActiveServices: vi.fn(),
  getAvailabilityRules: vi.fn(),
  getBlockedSlots: vi.fn(),
  getUpcomingBookings: vi.fn(),
}));

const TENANT: Tenant = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Acme Spa",
  slug: "acme-spa",
  branding: { brandColor: "oklch(0.55 0.16 250)", currency: "USD", timezone: "America/New_York" },
};

function stubTenantReads() {
  vi.mocked(getTenantBySlug).mockResolvedValue(TENANT);
  vi.mocked(getActiveServices).mockResolvedValue([]);
  vi.mocked(getAvailabilityRules).mockResolvedValue([]);
  vi.mocked(getBlockedSlots).mockResolvedValue([]);
  vi.mocked(getUpcomingBookings).mockResolvedValue([]);
}

/** Render the tenant page the way a request does, and return the response body. */
async function renderTenantPage(): Promise<string> {
  const { default: TenantBookingPage } = await import("@/app/[customerSlug]/page");
  const element = await TenantBookingPage({
    params: Promise.resolve({ customerSlug: TENANT.slug }),
  });
  return renderToStaticMarkup(element);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("the 'Powered by Booking Platform' footer", () => {
  it("is present when there is no custom-domain header", async () => {
    stubTenantReads();
    vi.mocked(headers).mockResolvedValue(new Headers());

    const html = await renderTenantPage();

    expect(html).toContain("Powered by");
    expect(html).toContain("Booking Platform");
  });

  it("is absent entirely (not just hidden) when the custom-domain header is set", async () => {
    stubTenantReads();
    vi.mocked(headers).mockResolvedValue(
      new Headers({ "x-booking-custom-domain": "1" }),
    );

    const html = await renderTenantPage();

    expect(html).not.toContain("Powered by");
    expect(html).not.toContain("Booking Platform");
  });
});

describe("generateMetadata", () => {
  it("returns a plain string title when there is no custom-domain header", async () => {
    stubTenantReads();
    vi.mocked(headers).mockResolvedValue(new Headers());

    const { generateMetadata } = await import("@/app/[customerSlug]/page");
    const metadata = await generateMetadata({
      params: Promise.resolve({ customerSlug: TENANT.slug }),
    });

    expect(metadata.title).toBe("Book with Acme Spa");
  });

  it("returns an { absolute } title (bypassing the root layout's template) when the header is set", async () => {
    stubTenantReads();
    vi.mocked(headers).mockResolvedValue(
      new Headers({ "x-booking-custom-domain": "1" }),
    );

    const { generateMetadata } = await import("@/app/[customerSlug]/page");
    const metadata = await generateMetadata({
      params: Promise.resolve({ customerSlug: TENANT.slug }),
    });

    expect(metadata.title).toEqual({ absolute: "Book with Acme Spa" });
  });
});
