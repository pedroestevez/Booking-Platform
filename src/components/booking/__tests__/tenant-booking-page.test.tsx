// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TenantBookingPage } from "@/components/booking/tenant-booking-page";
import type { Tenant } from "@/lib/types";

/**
 * ALI-115: the "Powered by Booking Platform" footer is the free tier's
 * attribution. A tenant's own custom domain (ALI-211) is what the white-label
 * upgrade buys, so the caller passing `hideBranding` must actually remove the
 * footer from the rendered output — not merely style it away — and every
 * other part of the page must render identically either way.
 *
 * `BookingFlow` is mocked to a marker: this suite is about the footer, not
 * the booking flow itself, which has its own coverage.
 */

vi.mock("@/components/booking/booking-flow", () => ({
  BookingFlow: () => <div data-testid="booking-flow" />,
}));

vi.mock("@/lib/email/provider", () => ({
  isEmailConfigured: () => false,
}));

const TENANT: Tenant = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Luz Beauty Spa",
  slug: "luz-beauty-spa",
  branding: { brandColor: "oklch(0.55 0.16 250)", currency: "USD", timezone: "America/New_York" },
};

const PROPS = {
  tenant: TENANT,
  services: [],
  rules: [],
  blocked: [],
  bookings: [],
};

afterEach(cleanup);

describe("TenantBookingPage — branding footer", () => {
  it("renders the platform footer by default (no hideBranding)", () => {
    render(<TenantBookingPage {...PROPS} />);

    expect(screen.getByText("Booking Platform")).toBeTruthy();
  });

  it("renders the platform footer when hideBranding is explicitly false", () => {
    render(<TenantBookingPage {...PROPS} hideBranding={false} />);

    expect(screen.getByText("Booking Platform")).toBeTruthy();
  });

  it("omits the footer from the rendered output when hideBranding is true", () => {
    render(<TenantBookingPage {...PROPS} hideBranding />);

    expect(screen.queryByText("Booking Platform")).toBeNull();
  });

  it("still renders the tenant header and booking flow when branding is hidden", () => {
    render(<TenantBookingPage {...PROPS} hideBranding />);

    expect(screen.getByText("Luz Beauty Spa")).toBeTruthy();
    expect(screen.getByTestId("booking-flow")).toBeTruthy();
  });
});
