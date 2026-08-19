import { headers } from "next/headers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isPlatformSharedHost, resolveRequestHost } from "@/lib/request-host";

/**
 * `resolveRequestHost` / `isPlatformSharedHost` (ALI-211).
 *
 * `next/headers`' `headers()` throws outside a real request scope, so it is
 * mocked here the same way `src/lib/__tests__/tenant-index.test.ts` mocks it
 * for `/`'s own tests.
 */

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

function stubHeaders(entries: Record<string, string>): void {
  vi.mocked(headers).mockResolvedValue(
    new Headers(entries) as unknown as Awaited<ReturnType<typeof headers>>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveRequestHost", () => {
  it("prefers x-forwarded-host over host", async () => {
    stubHeaders({
      "x-forwarded-host": "booking.pedroestevez.com",
      host: "internal-lb.example.internal",
    });
    expect(await resolveRequestHost()).toBe("booking.pedroestevez.com");
  });

  it("falls back to host when x-forwarded-host is absent", async () => {
    stubHeaders({ host: "booking.pedroestevez.com" });
    expect(await resolveRequestHost()).toBe("booking.pedroestevez.com");
  });

  it("takes the FIRST entry of a comma-separated x-forwarded-host", async () => {
    // Each proxy in the chain appends its own value; the first is what the
    // client originally asked for.
    stubHeaders({
      "x-forwarded-host": "booking.pedroestevez.com, internal-proxy-1, internal-proxy-2",
    });
    expect(await resolveRequestHost()).toBe("booking.pedroestevez.com");
  });

  it("lowercases the host", async () => {
    stubHeaders({ host: "Booking.PedroEstevez.com" });
    expect(await resolveRequestHost()).toBe("booking.pedroestevez.com");
  });

  it("strips a trailing dot (root-label FQDN form)", async () => {
    stubHeaders({ host: "booking.pedroestevez.com." });
    expect(await resolveRequestHost()).toBe("booking.pedroestevez.com");
  });

  it("strips a trailing :port", async () => {
    stubHeaders({ host: "booking.pedroestevez.com:3000" });
    expect(await resolveRequestHost()).toBe("booking.pedroestevez.com");
  });

  it("returns null when neither header is present", async () => {
    stubHeaders({});
    expect(await resolveRequestHost()).toBeNull();
  });

  it("returns null when both headers are blank", async () => {
    stubHeaders({ "x-forwarded-host": "", host: "" });
    expect(await resolveRequestHost()).toBeNull();
  });
});

describe("isPlatformSharedHost", () => {
  it.each([
    ["the shared production host", "booking.aligncompass.com"],
    ["localhost", "localhost"],
    ["a Vercel preview deployment host", "booking-platform-git-main-foo.vercel.app"],
    ["a bare .vercel.app host", "foo.vercel.app"],
  ])("is true for %s", (_label, host) => {
    expect(isPlatformSharedHost(host)).toBe(true);
  });

  it.each([
    ["a tenant's own custom domain", "booking.pedroestevez.com"],
    ["an unrelated host", "example.com"],
    // Not a suffix match to a real platform host — proves the check isn't
    // accidentally satisfied by string containment.
    ["a lookalike host", "notbooking.aligncompass.com.evil.example"],
  ])("is false for %s", (_label, host) => {
    expect(isPlatformSharedHost(host)).toBe(false);
  });
});
