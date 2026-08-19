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
 * `/<slug>` permanently redirects to `/` once a tenant has a custom domain —
 * but ONLY for a request that arrived ON that tenant's own domain (ALI-211).
 * `booking.aligncompass.com/<slug>` must never redirect, even for a tenant
 * that also has a `customDomain` set: the redirect is host-scoped, comparing
 * the RESOLVED REQUEST HOST against `tenant.customDomain`, never acting on
 * `tenant.customDomain`'s mere presence.
 *
 * `next/navigation`'s `permanentRedirect`/`notFound` both signal control flow
 * by throwing (Next's router catches a magic error internally); mocked here
 * to throw an inspectable marker instead, so a test can assert *that* a
 * redirect was requested and to *where*, without a real Next request/response
 * cycle.
 *
 * ## Falsification (done by hand while building this, reverted after)
 *
 * Making the redirect unconditional on host — i.e. `if (tenant.customDomain)
 * permanentRedirect("/")` with the host comparison deleted — turned "does NOT
 * redirect booking.aligncompass.com/<slug>" red: the mocked
 * `permanentRedirect` fired where the test requires it not to.
 */

vi.mock("@/lib/tenants", () => ({
  getActiveServices: vi.fn(),
  getAvailabilityRules: vi.fn(),
  getBlockedSlots: vi.fn(),
  getTenantBySlug: vi.fn(),
  getUpcomingBookings: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

class MockRedirect extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  permanentRedirect: vi.fn((url: string) => {
    throw new MockRedirect(url);
  }),
}));

vi.mock("@/components/booking/tenant-booking-page", () => ({
  TenantBookingPage: ({ tenant }: { tenant: Tenant }) => (
    <div data-testid="tenant-booking-page">{tenant.name}</div>
  ),
}));

const TENANT_WITH_CUSTOM_DOMAIN: Tenant = {
  id: "66666666-6666-4666-8666-666666666666",
  name: "Pedro Estevez Coaching",
  slug: "pedroestevez",
  branding: { brandColor: "oklch(0.55 0.16 250)", currency: "USD", timezone: "America/New_York" },
  customDomain: "booking.pedroestevez.com",
};

const TENANT_WITHOUT_CUSTOM_DOMAIN: Tenant = {
  id: "77777777-7777-4777-8777-777777777777",
  name: "Slug Only Studio",
  slug: "slug-only-studio",
  branding: { brandColor: "oklch(0.55 0.16 250)", currency: "USD", timezone: "UTC" },
};

function stubHost(host: string): void {
  vi.mocked(headers).mockResolvedValue(
    new Headers({ host }) as unknown as Awaited<ReturnType<typeof headers>>,
  );
}

function mockReads(): void {
  vi.mocked(getActiveServices).mockResolvedValue([]);
  vi.mocked(getAvailabilityRules).mockResolvedValue([]);
  vi.mocked(getBlockedSlots).mockResolvedValue([]);
  vi.mocked(getUpcomingBookings).mockResolvedValue([]);
}

async function renderSlugPage(slug: string): Promise<string> {
  const { default: CustomerSlugPage } = await import("@/app/[customerSlug]/page");
  const element = await CustomerSlugPage({
    params: Promise.resolve({ customerSlug: slug }),
  });
  return renderToStaticMarkup(element);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("/<slug> — host-scoped redirect to the tenant's custom domain", () => {
  it("redirects (308/permanentRedirect) when the request arrived on the tenant's own custom domain", async () => {
    stubHost("booking.pedroestevez.com");
    vi.mocked(getTenantBySlug).mockResolvedValue(TENANT_WITH_CUSTOM_DOMAIN);
    mockReads();

    await expect(renderSlugPage("pedroestevez")).rejects.toThrow(MockRedirect);

    try {
      await renderSlugPage("pedroestevez");
    } catch (err) {
      expect((err as MockRedirect).url).toBe("/");
    }
    // The redirect happens before any tenant-scoped read.
    expect(getActiveServices).not.toHaveBeenCalled();
  });

  it("does NOT redirect booking.aligncompass.com/<slug>, even though the tenant has a customDomain set", async () => {
    stubHost("booking.aligncompass.com");
    vi.mocked(getTenantBySlug).mockResolvedValue(TENANT_WITH_CUSTOM_DOMAIN);
    mockReads();

    const html = await renderSlugPage("pedroestevez");

    expect(html).toContain("Pedro Estevez Coaching");
    expect(getActiveServices).toHaveBeenCalledWith(TENANT_WITH_CUSTOM_DOMAIN.id);
  });

  it("does not redirect a tenant with no customDomain, regardless of host", async () => {
    stubHost("booking.aligncompass.com");
    vi.mocked(getTenantBySlug).mockResolvedValue(TENANT_WITHOUT_CUSTOM_DOMAIN);
    mockReads();

    const html = await renderSlugPage("slug-only-studio");

    expect(html).toContain("Slug Only Studio");
  });

  it("does not redirect when the request host cannot be resolved at all", async () => {
    stubHost(""); // no usable host
    vi.mocked(getTenantBySlug).mockResolvedValue(TENANT_WITH_CUSTOM_DOMAIN);
    mockReads();

    const html = await renderSlugPage("pedroestevez");

    expect(html).toContain("Pedro Estevez Coaching");
  });

  it("still 404s an unknown slug, unaffected by the redirect logic", async () => {
    stubHost("booking.aligncompass.com");
    vi.mocked(getTenantBySlug).mockResolvedValue(null);

    await expect(renderSlugPage("no-such-tenant")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
