import { headers } from "next/headers";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tenantIndexEnabled } from "@/lib/tenant-index";
import { getAllTenants } from "@/lib/tenants";
import type { Tenant } from "@/lib/types";

/**
 * The platform root does not enumerate tenants (ALI-176 criterion 3).
 *
 * ## Why this renders the page instead of reading the gate
 *
 * The criterion is about a **response body**: "a rendered response for `/` in
 * the production configuration contains no tenant name and no slug". A unit test
 * on `tenantIndexEnabled` proves the predicate and nothing about the page — the
 * old page would still pass it while leaking, because it never consulted a
 * predicate at all. So these tests call the real route handler and run its
 * element tree through `react-dom/server`, then assert against the HTML string.
 *
 * `getAllTenants` is mocked to return a tenant whose name and slug are
 * deliberately distinctive. That is what makes the negative case meaningful: the
 * assertion is not "the database happened to be empty", it is "a tenant existed
 * and the production render still does not contain it".
 *
 * The development case is asserted too, as the discriminating control. Without
 * it, a page that rendered a blank `<main>` in every environment — or a broken
 * import — would pass the production assertion perfectly.
 */

vi.mock("@/lib/tenants", () => ({
  getAllTenants: vi.fn(),
  // ALI-211: `/` now also resolves a tenant by request host. These tests are
  // about the ALI-176 tenant-enumeration gate, not host resolution, so every
  // render below uses `booking.aligncompass.com` — a platform-shared host
  // (`isPlatformSharedHost`) — which must short-circuit BEFORE this is ever
  // called. Left unmocked-to-resolve (never given a return value) so a
  // regression that removed that short-circuit fails loudly instead of this
  // mock quietly supplying a tenant.
  getTenantByHost: vi.fn(),
}));

// `src/app/page.tsx` now resolves the request host via `resolveRequestHost`
// (`@/lib/request-host`), which calls `next/headers`' `headers()` — a Next.js
// API that throws outside a real request scope (exactly the "call the route
// handler directly" pattern this file uses). Mocked so `HomePage()` can be
// invoked directly, the same way `getAllTenants` already is.
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

const LEAKY_TENANT: Tenant = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Zzyzx Enumeration Fixture",
  slug: "zzyzx-enumeration-fixture",
  branding: {
    brandColor: "oklch(0.55 0.16 250)",
    currency: "USD",
    timezone: "America/New_York",
  },
};

/**
 * Render `/` the way a request does, and return the response body.
 *
 * `host` defaults to the platform's own shared host (ALI-211) — the value
 * every existing test in this file exercises, and the one under which
 * `getTenantByHost` must never be called (see the mock above). It is a
 * parameter, not a constant, only so a future test in this file can assert
 * the platform-shared-host short-circuit explicitly if it needs to; the
 * dedicated custom-domain routing tests live in
 * `src/app/__tests__/root-custom-domain.test.tsx`.
 */
async function renderRoot(
  nodeEnv: string,
  host = "booking.aligncompass.com",
): Promise<string> {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.mocked(getAllTenants).mockResolvedValue([LEAKY_TENANT]);
  vi.mocked(headers).mockResolvedValue(
    new Headers({ host }) as unknown as Awaited<ReturnType<typeof headers>>,
  );
  // Imported inside the helper so the stubbed env is in place first — the page
  // reads it per render, but importing late also keeps module init honest.
  const { default: HomePage } = await import("@/app/page");
  return renderToStaticMarkup(await HomePage());
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("tenantIndexEnabled", () => {
  // Fail closed: exactly one value opens the index.
  it("is true only for a development build", () => {
    expect(tenantIndexEnabled({ NODE_ENV: "development" })).toBe(true);
  });

  it.each([
    ["production", { NODE_ENV: "production" }],
    ["test", { NODE_ENV: "test" }],
    ["preview (an unrecognised value)", { NODE_ENV: "preview" }],
    ["empty", { NODE_ENV: "" }],
    ["unset", {}],
  ])("is false when NODE_ENV is %s", (_label, env) => {
    expect(tenantIndexEnabled(env as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("the platform root", () => {
  it("leaks no tenant name and no slug in the production render", async () => {
    const html = await renderRoot("production");

    // The response body, not the page's source: this is what a visitor gets.
    expect(html).not.toContain(LEAKY_TENANT.name);
    expect(html).not.toContain(LEAKY_TENANT.slug);
    expect(html).not.toContain(LEAKY_TENANT.id);
    // The index's own chrome is gone with it, so there is no "Tenants" heading
    // hinting at a list that was suppressed.
    expect(html).not.toContain("Tenants");

    // Stronger than absence from the output: the query never ran. A render that
    // fetched every tenant and then declined to print them would still have
    // handed the row set to the process — and the next careless `map` would ship
    // it.
    expect(getAllTenants).not.toHaveBeenCalled();

    // The page still exists. Guards against a "leak fixed" that is really a
    // crash or an empty document.
    expect(html).toContain("Booking Platform");
  });

  it("still lists tenants under a development build", async () => {
    const html = await renderRoot("development");

    expect(html).toContain(LEAKY_TENANT.name);
    expect(html).toContain(`/${LEAKY_TENANT.slug}`);
    expect(getAllTenants).toHaveBeenCalledTimes(1);
  });
});
