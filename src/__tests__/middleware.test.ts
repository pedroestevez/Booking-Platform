import { NextRequest, type NextFetchEvent } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getTenantByHost } from "@/lib/tenants";
import type { Tenant } from "@/lib/types";
import middleware from "@/middleware";

vi.mock("@/lib/tenants", () => ({ getTenantByHost: vi.fn() }));

/**
 * /admin must 404, not 500, when Clerk is unconfigured (ALI-208).
 *
 * ## Why this file exists
 *
 * With no CLERK_* env vars, `clerkMiddleware` throws inside the request
 * handler — not at module scope — so the app builds and boots fine and only
 * `/admin/*` fails, with Vercel's raw `MIDDLEWARE_INVOCATION_FAILED` 500.
 * Measured live on the deployment before this fix:
 *
 *     GET /admin       -> 500      GET /admin/foo -> 500
 *     GET /nonexistent -> 404
 *
 * A 500 claims the feature exists and is broken. On a public demo that is the
 * first conclusion a technical visitor draws, and it is false: the deployment
 * simply has no admin dashboard. 404 is the true answer.
 *
 * These tests assert on the RESPONSE, not on which internal branch ran —
 * status code is what a visitor and a crawler actually observe.
 */

/**
 * `NextRequest` does not synthesize a `host` header from the URL it's built
 * with (verified empirically — constructing one from a URL alone leaves
 * `headers.get("host")` `null`), and the middleware reads the incoming host
 * from headers, not from `nextUrl`. So the header has to be set explicitly.
 *
 * Defaults to a `*.vercel.app` host — unconditionally a platform host per
 * `isPlatformHost`, with no `NEXT_PUBLIC_APP_URL` stub required — so every
 * pre-existing call site keeps exercising "the platform host" exactly as the
 * ALI-208 tests intended, now that host matters to `/admin` too (ALI-115).
 * Callers that need a tenant custom domain pass `host` explicitly.
 */
function req(path: string, host = "booking-platform.vercel.app"): NextRequest {
  return new NextRequest(new URL(path, `https://${host}`), {
    headers: { host },
  });
}

// `clerkMiddleware` is never reached in the unconfigured case; when it IS
// reached, this stub stands in for it so the test needs no Clerk service.
const event = {} as NextFetchEvent;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("when this deployment has no Clerk keys", () => {
  it("answers /admin with 404, not 500", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("CLERK_SECRET_KEY", "");

    const res = await middleware(req("/admin"), event);

    expect(res?.status).toBe(404);
  });

  it("answers nested admin routes with 404 too", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("CLERK_SECRET_KEY", "");

    for (const path of ["/admin/bookings", "/admin/sign-in", "/admin/no-access"]) {
      const res = await middleware(req(path), event);
      expect(res?.status, path).toBe(404);
    }
  });

  it("says the dashboard is not enabled, rather than implying a fault", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("CLERK_SECRET_KEY", "");

    const body = await (await middleware(req("/admin"), event))!.text();

    expect(body).toMatch(/not enabled on this deployment/i);
    // It must not read as a crash — that is the whole point of the change.
    expect(body).not.toMatch(/error|failed|exception/i);
  });

  it("treats a half-configured deployment as unconfigured", async () => {
    // Publishable key alone is not enough: the server SDK needs the secret, so
    // letting this through only moves the same 500 one layer deeper.
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_stub");
    vi.stubEnv("CLERK_SECRET_KEY", "");

    expect((await middleware(req("/admin"), event))?.status).toBe(404);

    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_stub");

    expect((await middleware(req("/admin"), event))?.status).toBe(404);
  });
});

describe("when Clerk IS configured", () => {
  it("hands the request to clerkMiddleware instead of 404ing it", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_c3R1Yi5leGFtcGxlLmNvbSQ");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_stub");

    // The real Clerk middleware will reject this unauthenticated request
    // somehow — redirect, 401, or throw. Any of those is proof it was reached.
    // What must NOT happen is the flat 404 from the unconfigured branch.
    let status: number | undefined;
    try {
      status = (await middleware(req("/admin"), event))?.status;
    } catch {
      // Clerk threw — it ran, which is the assertion.
      return;
    }
    expect(status).not.toBe(404);
  });

  it("still 404s /admin on a tenant custom domain — admin is platform-host-only (ALI-115)", async () => {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_c3R1Yi5leGFtcGxlLmNvbSQ");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_stub");

    // A fully-configured deployment must still refuse /admin on a tenant's
    // own address — the shared admin login has no business being reachable
    // there, configured or not.
    const res = await middleware(req("/admin", "booking.tenant-inc.com"), event);

    expect(res?.status).toBe(404);
    // getTenantByHost must not even be consulted for /admin — the guard is a
    // pure host check, not a tenant lookup.
    expect(getTenantByHost).not.toHaveBeenCalled();
  });
});

/**
 * Custom-domain tenant routing (ALI-115) — every non-`/admin` path.
 *
 * `getTenantByHost` is mocked so these tests never construct a real Supabase
 * client; each case controls its own resolved value.
 */
describe("public-route host resolution", () => {
  const TENANT: Tenant = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Acme Spa",
    slug: "acme-spa",
    branding: { brandColor: "oklch(0.55 0.16 250)", currency: "USD", timezone: "America/New_York" },
  };

  it("passes a platform-host request through unchanged, and never calls getTenantByHost", async () => {
    const res = await middleware(req("/"), event);

    // NextResponse.next() carries this header and no rewrite header — see the
    // "observed wire format" comment below for how these were confirmed
    // rather than assumed.
    expect(res?.headers.get("x-middleware-next")).toBe("1");
    expect(res?.headers.get("x-middleware-rewrite")).toBeNull();
    expect(getTenantByHost).not.toHaveBeenCalled();
  });

  /**
   * Observed wire format (Next.js 15.5.23) — confirmed by running an
   * exploratory assertion against real `NextResponse.rewrite()` output
   * rather than assumed from memory:
   *
   *   x-middleware-rewrite: <the full rewritten URL>
   *   x-middleware-override-headers: host,x-booking-custom-domain
   *   x-middleware-request-host: <original host>
   *   x-middleware-request-x-booking-custom-domain: 1
   *
   * The per-header `x-middleware-request-<name>` values are how
   * `NextResponse.rewrite(url, { request: { headers } })` carries headers on
   * the FORWARDED request rather than the response — this is what makes them
   * visible to `headers()` in the destination page, which plain response
   * headers would not be.
   */
  it("rewrites a resolved custom domain to /<slug>, forwarding the custom-domain header", async () => {
    vi.mocked(getTenantByHost).mockResolvedValue(TENANT);

    const res = await middleware(req("/", "booking.acme-spa.com"), event);

    expect(getTenantByHost).toHaveBeenCalledWith("booking.acme-spa.com");
    expect(res?.headers.get("x-middleware-rewrite")).toBe(
      "https://booking.acme-spa.com/acme-spa",
    );
    expect(res?.headers.get("x-middleware-request-x-booking-custom-domain")).toBe(
      "1",
    );
  });

  it("rewrites a deeper path to /<slug>/<rest>", async () => {
    vi.mocked(getTenantByHost).mockResolvedValue(TENANT);

    const res = await middleware(req("/foo", "booking.acme-spa.com"), event);

    expect(res?.headers.get("x-middleware-rewrite")).toBe(
      "https://booking.acme-spa.com/acme-spa/foo",
    );
  });

  it("404s an unrecognized custom domain, and this is NOT a rewrite", async () => {
    vi.mocked(getTenantByHost).mockResolvedValue(null);

    const res = await middleware(req("/", "booking.unknown-tenant.com"), event);

    expect(res?.status).toBe(404);
    // The never-falls-through guard: an unrecognized host must never resolve
    // to any tenant's data, so there must be no rewrite header at all.
    expect(res?.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("503s when the lookup itself throws, rather than 404ing or falling through", async () => {
    vi.mocked(getTenantByHost).mockRejectedValue(new Error("connection reset"));

    const res = await middleware(req("/", "booking.acme-spa.com"), event);

    expect(res?.status).toBe(503);
    expect(res?.headers.get("x-middleware-rewrite")).toBeNull();
  });
});
