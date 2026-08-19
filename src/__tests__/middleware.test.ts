import { NextRequest, type NextFetchEvent } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import middleware from "@/middleware";

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

function req(path: string): NextRequest {
  return new NextRequest(new URL(path, "https://booking.example.com"));
}

// `clerkMiddleware` is never reached in the unconfigured case; when it IS
// reached, this stub stands in for it so the test needs no Clerk service.
const event = {} as NextFetchEvent;

afterEach(() => {
  vi.unstubAllEnvs();
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
});
