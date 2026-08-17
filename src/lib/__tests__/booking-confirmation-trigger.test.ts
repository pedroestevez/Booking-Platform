import { type SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateDaySlots } from "@/lib/availability";
import { createBooking } from "@/lib/bookings";
import { sendBookingConfirmation } from "@/lib/email/booking-confirmation";
import { createServiceRoleClient } from "@/lib/supabase/server";
import type { CreateBookingInput } from "@/lib/types";

/**
 * The **call site** of the confirmation email, pinned on its own (ALI-69 AC1).
 *
 * ## Why this file exists separately from the email suite
 *
 * `booking-confirmation.test.ts` drives the whole path and asserts on what the
 * vendor received. That is the right test for the behaviour — but it cannot
 * fail if the guard in `createBooking` is deleted, because the email module
 * carries a second guard of its own and would refuse a `pending` booking
 * anyway. Measured, not assumed: removing `if (created.status ===
 * "confirmed")` from `createBooking` turned **zero** tests red before this file
 * existed.
 *
 * Two guards is the right design — the module has to be safe for ALI-181 to
 * reuse — but defense in depth is only defense while both layers are held up by
 * something. So this suite mocks the email module away entirely and asserts the
 * one thing the other suite structurally cannot: **whether `createBooking`
 * calls it at all**, and after what.
 */

vi.mock("@/lib/supabase/server", () => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/tenants", () => ({
  getAvailabilityRules: vi.fn(async () => []),
  getBlockedSlots: vi.fn(async () => []),
  getUpcomingBookings: vi.fn(async () => []),
  // ALI-117: the write path resolves the tenant's zone server-side before the
  // availability re-check. `generateDaySlots` is mocked below, so this only has
  // to exist — what it returns never reaches any arithmetic in this suite.
  getTenantTimeZone: vi.fn(async () => "UTC"),
}));

vi.mock("@/lib/availability", () => ({
  generateDaySlots: vi.fn(() => []),
}));

vi.mock("@/lib/email/booking-confirmation", () => ({
  EMAIL_OPERATION: "booking-confirmation-email",
  redactSensitive: (text: string) => text,
  sendBookingConfirmation: vi.fn(async () => ({ sent: 1, failed: 0 })),
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
  guest: { name: "Ada Lovelace", email: "ada@example.com" },
};

interface Arrangement {
  priceCents?: number;
  insertError?: { code: string; message: string } | null;
}

function arrange({ priceCents = 0, insertError = null }: Arrangement = {}) {
  let inserted: Record<string, unknown> | undefined;

  const services = {
    select: () => services,
    eq: () => services,
    maybeSingle: async () => ({
      data: {
        id: SERVICE_ID,
        customer_id: CUSTOMER_ID,
        name: "Interview — 30 min",
        description: "",
        duration_minutes: 30,
        price_cents: priceCents,
        active: true,
      },
      error: null,
    }),
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
    insert: (row: Record<string, unknown>) => {
      inserted = row;
      return bookings;
    },
    select: () => bookings,
    single: async () =>
      insertError
        ? { data: null, error: insertError }
        : { data: { id: BOOKING_ID, custom_fields: {}, ...inserted }, error: null },
  };

  vi.mocked(createServiceRoleClient).mockReturnValue({
    from: (table: string) => {
      if (table === "services") return services;
      if (table === "end_customers") return endCustomers;
      return bookings;
    },
    rpc: async () => ({ data: END_CUSTOMER_ID, error: null }),
  } as unknown as SupabaseClient);

  vi.mocked(generateDaySlots).mockReturnValue([
    { start: SLOT.start, end: SLOT.end },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AC1 — createBooking's own guard on the returned status", () => {
  it("invokes the send exactly once for a confirmed row", async () => {
    arrange({ priceCents: 0 });

    const booking = await createBooking(INPUT);

    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1);
    // It is handed the row the database returned, not the request.
    expect(vi.mocked(sendBookingConfirmation).mock.calls[0]![0]).toMatchObject({
      booking: { id: booking.id, status: "confirmed", customerId: CUSTOMER_ID },
      guest: { email: INPUT.guest.email },
    });
  });

  it("does not invoke the send for a pending row", async () => {
    arrange({ priceCents: 5000 });

    const booking = await createBooking(INPUT);

    expect(booking.status).toBe("pending");
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });

  // The ordering half of the invariant, asserted where it lives: the call is
  // reached only after `.single()` resolved without error.
  it("does not invoke the send when the insert loses the overlap race", async () => {
    arrange({
      insertError: {
        code: "23P01",
        message: 'conflicting key value violates exclusion constraint "bookings_no_overlap"',
      },
    });

    await expect(createBooking(INPUT)).rejects.toThrow(
      "Sorry, that time was just taken. Please pick another.",
    );
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });

  it("does not invoke the send when the insert fails for any other reason", async () => {
    arrange({
      insertError: { code: "23503", message: "foreign key violation" },
    });

    await expect(createBooking(INPUT)).rejects.toBeTruthy();
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });

  it("does not invoke the send when the slot is refused before the insert", async () => {
    arrange();
    vi.mocked(generateDaySlots).mockReturnValue([]);

    await expect(createBooking(INPUT)).rejects.toThrow(
      "Sorry, that time was just taken. Please pick another.",
    );
    expect(sendBookingConfirmation).not.toHaveBeenCalled();
  });

  // The redundant outer `catch`: even if the module's own containment were
  // removed, a booking that is stored is still returned.
  it("returns the booking even if the send rejects outright", async () => {
    arrange({ priceCents: 0 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(sendBookingConfirmation).mockRejectedValueOnce(
      new Error("the email module itself threw"),
    );

    const booking = await createBooking(INPUT);

    expect(booking.id).toBe(BOOKING_ID);
    expect(booking.status).toBe("confirmed");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0]![0] as string)).toContain(BOOKING_ID);
    spy.mockRestore();
  });
});
