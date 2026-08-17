import { type SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateDaySlots } from "@/lib/availability";
import { createBooking, initialBookingStatus } from "@/lib/bookings";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { formatPrice, formatServicePrice, FREE_PRICE_LABEL } from "@/lib/utils";
import type { CreateBookingInput } from "@/lib/types";

/**
 * A free service produces a booking a confirmation can fire on
 * (ALI-176 criteria 4 and 5).
 *
 * Release 0.1's two services are both `price_cents = 0`, and ALI-69's
 * confirmation email fires on `confirmed`. Before this change every booking was
 * inserted `pending` with no path out of it, so a free booking could never reach
 * a state that trigger could observe.
 *
 * ## Why the insert payload, not just the helper
 *
 * `initialBookingStatus` is asserted directly *and* through `createBooking`,
 * because the failure this guards against is not a wrong ternary — it is a right
 * ternary that the insert never consults. So the stub captures what actually
 * reaches `.insert(...)` and the status is read off that row.
 *
 * The Supabase client, tenant reads and availability are mocked (the same
 * arrangement `bookings.conflict.test.ts` uses) so control reaches the insert
 * without a live PostgREST. That `confirmed` genuinely occupies its slot in the
 * database is a schema claim and is proved against real Postgres in
 * `src/test/__tests__/free-service-status.db.test.ts`.
 */

vi.mock("@/lib/supabase/server", () => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/tenants", () => ({
  getAvailabilityRules: vi.fn(async () => []),
  getBlockedSlots: vi.fn(async () => []),
  getUpcomingBookings: vi.fn(async () => []),
}));

vi.mock("@/lib/availability", () => ({
  generateDaySlots: vi.fn(() => []),
}));

// A `confirmed` insert now triggers the confirmation email (ALI-69), which this
// suite's arrangement cannot serve — `@/lib/tenants` is mocked down to three
// functions. Left unmocked the send path is exercised, fails, contains its own
// failure and logs it, which is correct behaviour but is noise here: what this
// suite is about is the status on the inserted row. The email path is proved in
// `src/lib/email/__tests__/booking-confirmation.test.ts`.
vi.mock("@/lib/email/booking-confirmation", () => ({
  EMAIL_OPERATION: "booking-confirmation-email",
  redactSensitive: (text: string) => text,
  sendBookingConfirmation: vi.fn(async () => ({ sent: 0, failed: 0 })),
}));

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const END_CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const BOOKING_ID = "55555555-5555-4555-8555-555555555555";

const SLOT = {
  start: "2026-09-01T10:00:00.000Z",
  end: "2026-09-01T10:30:00.000Z",
};

const INPUT: CreateBookingInput = {
  customerId: CUSTOMER_ID,
  serviceId: SERVICE_ID,
  slot: SLOT,
  guest: { name: "Ada Lovelace", email: "ada@example.test" },
};

/** The row handed to `.insert(...)`, captured from the last arrangement. */
type InsertedRow = Record<string, unknown>;

/**
 * Arrange the write path over a service priced at `priceCents`, and return the
 * row the insert received.
 */
async function bookServicePriced(priceCents: number): Promise<InsertedRow> {
  let inserted: InsertedRow | undefined;

  const serviceRow = {
    id: SERVICE_ID,
    customer_id: CUSTOMER_ID,
    name: "Interview — 30 min",
    description: "",
    duration_minutes: 30,
    price_cents: priceCents,
    active: true,
  };

  const services = {
    select: () => services,
    eq: () => services,
    maybeSingle: async () => ({ data: serviceRow, error: null }),
  };

  const endCustomers = {
    select: () => endCustomers,
    eq: () => endCustomers,
    maybeSingle: async () => ({
      data: { id: END_CUSTOMER_ID, name: INPUT.guest.name, phone: null },
      error: null,
    }),
  };

  const bookings = {
    insert: (row: InsertedRow) => {
      inserted = row;
      return bookings;
    },
    select: () => bookings,
    // Echo back what was inserted, the way PostgREST's `returning` does, so the
    // mapped `Booking` carries the same status the row did.
    single: async () => ({
      data: { id: BOOKING_ID, custom_fields: {}, ...inserted },
      error: null,
    }),
  };

  const client = {
    from: (table: string) => {
      if (table === "services") return services;
      if (table === "end_customers") return endCustomers;
      return bookings;
    },
    rpc: async () => ({ data: END_CUSTOMER_ID, error: null }),
  } as unknown as SupabaseClient;

  vi.mocked(createServiceRoleClient).mockReturnValue(client);
  // The chosen slot is open, so the pre-check passes and the insert is reached.
  vi.mocked(generateDaySlots).mockReturnValue([{ start: SLOT.start, end: SLOT.end }]);

  const booking = await createBooking(INPUT);
  expect(inserted).toBeDefined();
  // The status the caller observes and the status stored are the same value.
  expect(booking.status).toBe(inserted!.status);
  return inserted!;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("initialBookingStatus", () => {
  it("confirms a free service", () => {
    expect(initialBookingStatus(0)).toBe("confirmed");
  });

  it.each([1, 50, 5000, 999_999])(
    "leaves a service priced at %i cents pending",
    (priceCents) => {
      expect(initialBookingStatus(priceCents)).toBe("pending");
    },
  );

  // `confirmed` must never be reachable for a priced service: it is the status
  // ALI-69 emails on and ALI-27/ALI-70 will set only after Stripe succeeds.
  it("never confirms anything but exactly zero", () => {
    expect(initialBookingStatus(0.5)).toBe("pending");
    expect(initialBookingStatus(-0)).toBe("confirmed"); // -0 === 0
  });
});

describe("createBooking", () => {
  it("inserts a free service's booking as confirmed", async () => {
    const row = await bookServicePriced(0);
    expect(row.status).toBe("confirmed");
  });

  it("still inserts a paid service's booking as pending", async () => {
    const row = await bookServicePriced(5000);
    expect(row.status).toBe("pending");
  });

  // The status comes from the tenant's own service row, so the two cases above
  // differ *only* in `price_cents` — nothing about the request decides it.
  it("does not let the request influence the status", async () => {
    const free = await bookServicePriced(0);
    const paid = await bookServicePriced(5000);
    expect(free.customer_id).toBe(paid.customer_id);
    expect(free.service_id).toBe(paid.service_id);
    expect(free.status).not.toBe(paid.status);
  });
});

describe("formatServicePrice", () => {
  it("renders a free service as free", () => {
    expect(formatServicePrice(0)).toBe(FREE_PRICE_LABEL);
    expect(formatServicePrice(0, "EUR")).toBe(FREE_PRICE_LABEL);
  });

  // The failure the criterion names: never malformed, never empty. Checked as a
  // property rather than by eyeballing one string.
  it.each([0, 1, 50, 100, 2999, 5000])(
    "renders %i cents as a non-empty, well-formed label",
    (cents) => {
      const label = formatServicePrice(cents, "USD");
      expect(label.trim()).not.toBe("");
      expect(label).not.toMatch(/NaN|undefined|null|Infinity/);
    },
  );

  it("is unchanged from formatPrice for any non-zero price", () => {
    for (const cents of [1, 50, 100, 2999, 5000]) {
      expect(formatServicePrice(cents, "USD")).toBe(formatPrice(cents, "USD"));
    }
  });

  // A zero *amount* is still an amount: the admin revenue KPI reads `formatPrice`
  // and must keep saying "$0", not "Free".
  it("does not change how a zero amount formats", () => {
    expect(formatPrice(0, "USD")).toBe("$0");
  });
});
