import { describe, expect, it } from "vitest";

import { isPlatformHost } from "@/lib/platform-host";

/**
 * `isPlatformHost` (ALI-115) — the predicate a later phase's middleware uses
 * to decide whether an incoming request host is the platform's own address
 * (route-based tenant resolution stays in play) or a candidate tenant custom
 * domain (`getTenantByHost` resolution applies instead).
 *
 * `env` is passed explicitly rather than via `vi.stubEnv`/mutating
 * `process.env`, matching `tenantIndexEnabled`'s test style — a pure function
 * over an injected env is simplest to assert the whole truth table against.
 */

const APP_URL_ENV = {
  NODE_ENV: "test",
  NEXT_PUBLIC_APP_URL: "https://booking.aligncompass.com",
} as NodeJS.ProcessEnv;

const NO_APP_URL_ENV = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

describe("isPlatformHost", () => {
  it.each([
    ["localhost, no port", "localhost"],
    ["localhost, with a port", "localhost:3000"],
    ["127.0.0.1, no port", "127.0.0.1"],
    ["127.0.0.1, with a port", "127.0.0.1:54321"],
  ])("resolves true for %s", (_label, host) => {
    expect(isPlatformHost(host)).toBe(true);
  });

  it.each([
    ["a preview deployment", "booking-platform-git-feature-aligncompass.vercel.app"],
    ["the raw production alias", "booking-platform.vercel.app"],
    ["uppercase, mixed case", "Booking-Platform.VERCEL.APP"],
    ["with a port", "booking-platform.vercel.app:443"],
  ])("resolves true for any *.vercel.app host (%s)", (_label, host) => {
    expect(isPlatformHost(host)).toBe(true);
  });

  it("resolves true for the configured NEXT_PUBLIC_APP_URL hostname", () => {
    expect(isPlatformHost("booking.aligncompass.com", APP_URL_ENV)).toBe(true);
  });

  it("resolves true for the configured hostname with a port", () => {
    expect(isPlatformHost("booking.aligncompass.com:3000", APP_URL_ENV)).toBe(
      true,
    );
  });

  it("resolves false for an arbitrary tenant custom domain", () => {
    expect(isPlatformHost("booking.example.com", APP_URL_ENV)).toBe(false);
  });

  it("resolves false for a tenant custom domain even without a configured app URL", () => {
    expect(isPlatformHost("booking.example.com", NO_APP_URL_ENV)).toBe(false);
  });
});
