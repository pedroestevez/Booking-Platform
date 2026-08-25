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
  // `isPlatformSharedHost` reads `PLATFORM_HOSTS` per call, so a stub left
  // standing would leak into the next test rather than being harmlessly stale.
  vi.unstubAllEnvs();
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
  // The two structural hosts hold with no configuration at all — that is what
  // makes them structural, and why `PLATFORM_HOSTS` is left unset here.
  it.each([
    ["localhost", "localhost"],
    ["a Vercel preview deployment host", "booking-platform-git-main-foo.vercel.app"],
    ["a bare .vercel.app host", "foo.vercel.app"],
  ])("is true for %s with no PLATFORM_HOSTS set", (_label, host) => {
    vi.stubEnv("PLATFORM_HOSTS", "");
    expect(isPlatformSharedHost(host)).toBe(true);
  });

  it.each([
    ["a tenant's own custom domain", "booking.pedroestevez.com"],
    ["an unrelated host", "example.com"],
    // Not a suffix match to a real platform host — proves the check isn't
    // accidentally satisfied by string containment.
    ["a lookalike host", "notbook.platform.example.com.evil.example"],
  ])("is false for %s", (_label, host) => {
    vi.stubEnv("PLATFORM_HOSTS", "");
    expect(isPlatformSharedHost(host)).toBe(false);
  });

  // ── The configured host (ALI-211 follow-up) ────────────────────────────────
  // The deployment's own production domain is configuration, not a constant.
  // These are the cases a hard-coded literal used to cover for free, and the
  // ones a misread of the variable would silently break.

  it("is true for a host named in PLATFORM_HOSTS", () => {
    vi.stubEnv("PLATFORM_HOSTS", "booking.platform.example");
    expect(isPlatformSharedHost("booking.platform.example")).toBe(true);
  });

  it("is false for that same host once PLATFORM_HOSTS no longer names it", () => {
    // Read per call, never captured at import: a value frozen at module load
    // is one a redeploy cannot correct.
    vi.stubEnv("PLATFORM_HOSTS", "");
    expect(isPlatformSharedHost("booking.platform.example")).toBe(false);
  });

  it("accepts several hosts, so a deployment can move domains", () => {
    vi.stubEnv("PLATFORM_HOSTS", "old.platform.example,new.platform.example");
    expect(isPlatformSharedHost("old.platform.example")).toBe(true);
    expect(isPlatformSharedHost("new.platform.example")).toBe(true);
  });

  it.each([
    ["surrounding whitespace", " booking.platform.example , other.example "],
    ["an uppercase spelling", "Booking.Platform.Example"],
    ["a trailing root-label dot", "booking.platform.example."],
    ["a port", "booking.platform.example:443"],
  ])("normalizes %s, matching how the request host is normalized", (_label, configured) => {
    // `resolveRequestHost` lowercases and strips port/trailing dot, so a
    // configured value spelled any of these ways must still match. A missed
    // match here is silent: the platform's own host starts being treated as a
    // tenant domain and every request costs a pointless database round trip.
    vi.stubEnv("PLATFORM_HOSTS", configured);
    expect(isPlatformSharedHost("booking.platform.example")).toBe(true);
  });

  it("ignores empty entries rather than matching the empty host", () => {
    vi.stubEnv("PLATFORM_HOSTS", ",, ,");
    expect(isPlatformSharedHost("")).toBe(false);
    expect(isPlatformSharedHost("localhost")).toBe(true);
  });

  it("never lets configuration turn a tenant's domain into a platform host by suffix", () => {
    vi.stubEnv("PLATFORM_HOSTS", "platform.example");
    expect(isPlatformSharedHost("tenant.platform.example")).toBe(false);
  });
});
