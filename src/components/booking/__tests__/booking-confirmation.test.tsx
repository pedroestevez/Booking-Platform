// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BookingConfirmation } from "@/components/booking/booking-confirmation";
import type { GuestDetails, Service, Tenant, TimeSlot } from "@/lib/types";

/**
 * The confirmation screen must not imply a message nobody received (ALI-205).
 *
 * ## Why this file exists
 *
 * With no `RESEND_API_KEY`, `createBooking` catches `EmailNotConfiguredError`,
 * commits the booking anyway, and shows this screen (ALI-69 AC6). That is the
 * deployed state of `booking.aligncompass.com` today — so the one sentence a
 * guest reads after booking is the entire notification story, and until now it
 * said only that email "arrives in an upcoming release" beneath a heading that
 * reads "You're booked in!".
 *
 * The tests below therefore assert against **rendered text**, not props: what a
 * visitor can actually read is the only thing that can be honest or dishonest.
 * Restoring the old single-footnote screen turns every case in the first
 * describe block red.
 */

const CUSTOMER_ID = "11111111-1111-1111-1111-111111111111";

const TENANT: Tenant = {
  id: CUSTOMER_ID,
  name: "Pedro Estevez",
  slug: "pedroestevez",
  branding: {
    brandColor: "oklch(0.55 0.16 250)",
    currency: "USD",
    timezone: "America/New_York",
    contactEmail: "someone@example.com",
  },
};

const SERVICE: Service = {
  id: "22222222-2222-2222-2222-222222222222",
  customerId: CUSTOMER_ID,
  name: "Interview",
  description: "A 30-minute conversation.",
  durationMinutes: 30,
  priceCents: 0,
  active: true,
};

const SLOT: TimeSlot = {
  start: "2026-09-07T14:00:00.000Z",
  end: "2026-09-07T14:30:00.000Z",
};

const GUEST: GuestDetails = { name: "Sam Rivera", email: "sam@example.com" };

function renderConfirmation(
  overrides: {
    notificationsEnabled?: boolean;
    tenant?: Tenant;
  } = {},
) {
  return render(
    <BookingConfirmation
      tenant={overrides.tenant ?? TENANT}
      service={SERVICE}
      slot={SLOT}
      guest={GUEST}
      bookingId="33333333-3333-3333-3333-333333333333"
      notificationsEnabled={overrides.notificationsEnabled ?? false}
      onBookAnother={() => {}}
    />,
  );
}

afterEach(cleanup);

describe("when this deployment cannot send email", () => {
  it("says plainly that no email was sent and nobody was notified", () => {
    renderConfirmation({ notificationsEnabled: false });

    // Both halves, because "no email was sent" alone still leaves a reader
    // free to assume the business was pinged some other way.
    expect(screen.getByText(/no email was sent/i)).toBeTruthy();
    expect(screen.getByText(/nobody was notified/i)).toBeTruthy();
  });

  it("frames it as a work in progress, not as a failure", () => {
    const { container } = renderConfirmation({ notificationsEnabled: false });
    const text = container.textContent ?? "";

    expect(text).toMatch(/work in progress/i);
    // The booking is real — the screen must keep saying so, or the honesty
    // notice reads as "your booking did not go through".
    expect(text).toMatch(/booking itself is real/i);
  });

  it("offers a mailto to the tenant's own contact address, naming the service", () => {
    renderConfirmation({ notificationsEnabled: false });

    const link = screen.getByRole("link", { name: /email pedro estevez/i });
    const href = link.getAttribute("href") ?? "";

    expect(href.startsWith("mailto:someone@example.com?subject=")).toBe(true);
    // Decoded, so the assertion is about what the mail client shows.
    const subject = decodeURIComponent(href.split("subject=")[1] ?? "");
    expect(subject).toContain("Interview");
  });

  it("renders no contact button when the tenant configured no address", () => {
    const noContact: Tenant = {
      ...TENANT,
      branding: { ...TENANT.branding, contactEmail: undefined },
    };
    renderConfirmation({ notificationsEnabled: false, tenant: noContact });

    // The shared component carries no address of its own: a tenant that set
    // none must get no button, never a fallback into somebody else's inbox.
    expect(screen.queryByRole("link", { name: /email/i })).toBeNull();
    expect(screen.getByText(/nobody was notified/i)).toBeTruthy();
  });

  it("still shows the booking details and the calendar download", () => {
    renderConfirmation({ notificationsEnabled: false });

    expect(screen.getByText("Interview")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /add to calendar/i }),
    ).toBeTruthy();
  });
});

describe("when this deployment can send email", () => {
  it("makes no claim about email either way", () => {
    const { container } = renderConfirmation({ notificationsEnabled: true });
    const text = container.textContent ?? "";

    expect(text).not.toMatch(/no email was sent/i);
    expect(text).not.toMatch(/nobody was notified/i);
    // The remaining gap is payment, and only payment.
    expect(text).toMatch(/online payment arrives in an upcoming release/i);
  });

  it("does not offer the fallback contact button", () => {
    renderConfirmation({ notificationsEnabled: true });
    expect(screen.queryByRole("link", { name: /email/i })).toBeNull();
  });
});
