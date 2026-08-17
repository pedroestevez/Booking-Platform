import { type SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateDaySlots } from "@/lib/availability";
import { createBooking } from "@/lib/bookings";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getTenantTimeZone } from "@/lib/tenants";
import type { CreateBookingInput } from "@/lib/types";

/**
 * The tenant boundary around the availability timezone (ALI-117 criterion 7,
 * second negative case — ALI-139's lesson applied to a second value).
 *
 * `createBooking` runs on the **RLS-bypassing service-role client**. The zone it
 * re-validates a slot against decides which wall-clock times exist at all, so a
 * request that could supply it could slide the whole availability window and be
 * handed a time the business never opened — on a client where the database will
 * not object. That makes the zone the same class of value as `customerId` was
 * before ALI-139: it must be read from the tenant's own row, keyed by an
 * already-resolved `customerId`, and from nowhere else.
 *
 * ## What is faked, and how faithfully (ALI-155)
 *
 * Only the **driver** is faked — `@/lib/supabase/server`. `getTenantTimeZone`,
 * `mapTenant` and `createBooking`'s own resolution all execute for real against
 * it, so what is under test is production code rather than a restatement of it.
 * `generateDaySlots` is a spy so the argument it receives can be read directly;
 * its real behaviour is proved in `availability.test.ts`.
 *
 * The fake encodes the rejections the real system makes, not the ones that
 * would make these assertions pass:
 *
 *   • **Filters are applied.** `.eq("id", …)` on `customers` really selects, so
 *     asking for tenant A returns tenant A's `branding_json` and nothing else.
 *     A fake that returned "the tenant" regardless of the filter could not tell
 *     a correctly-scoped read from a leaking one, which is the only question
 *     here.
 *   • **A miss returns `{ data: null }`, not an error** — PostgREST's
 *     `maybeSingle` semantics. The application is what must refuse; if the fake
 *     invented an error the refusal below would be the fake's, not the code's.
 *   • **The insert does not police `customer_id`**, matching the real schema
 *     (see `booking-tenant-scope.test.ts`, which owns that half).
 *
 * The fixture service is priced, so the booking inserts `pending` and ALI-69's
 * confirmation email never fires — this suite has nothing to say about it.
 */

vi.mock("@/lib/supabase/server", () => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/availability", () => ({
  generateDaySlots: vi.fn(() => []),
}));

// ── Two real tenants, in deliberately incompatible zones ────────────────────
// 19 hours apart, so a leak cannot hide inside a plausible-looking offset.

const ALPHA = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  slug: "alpha-clinic",
  serviceId: "a5e40001-0000-4000-8000-000000000001",
  timezone: "America/New_York",
};

const BETA = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  slug: "beta-studio",
  serviceId: "b5e40002-0000-4000-8000-000000000002",
  timezone: "Pacific/Kiritimati",
};

const UNKNOWN_TENANT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const END_CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const BOOKING_ID = "55555555-5555-4555-8555-555555555555";

const SLOT = {
  start: "2026-09-01T10:00:00.000Z",
  end: "2026-09-01T11:00:00.000Z",
};

interface Row {
  [column: string]: unknown;
}

/**
 * The tables this path reads, plus a ledger of every `customers` id actually
 * filtered on — so a test can assert the victim's row was never even queried,
 * not merely that its zone did not surface.
 */
class FakeDatabase {
  readonly customerIdsQueried: string[] = [];

  readonly customers: Row[] = [
    {
      id: ALPHA.id,
      name: "Alpha Clinic",
      slug: ALPHA.slug,
      branding_json: { timezone: ALPHA.timezone, currency: "USD" },
    },
    {
      id: BETA.id,
      name: "Beta Studio",
      slug: BETA.slug,
      branding_json: { timezone: BETA.timezone, currency: "USD" },
    },
  ];

  readonly services: Row[] = [
    {
      id: ALPHA.serviceId,
      customer_id: ALPHA.id,
      name: "Alpha Consultation",
      description: "",
      duration_minutes: 60,
      price_cents: 5000,
      active: true,
    },
    {
      id: BETA.serviceId,
      customer_id: BETA.id,
      name: "Beta Session",
      description: "",
      duration_minutes: 60,
      price_cents: 5000,
      active: true,
    },
  ];

  readonly insertedBookings: Row[] = [];
}

/**
 * One query builder for every table, which actually applies the `.eq(…)`
 * filters it is handed. Thenable, because the list reads in `tenants.ts` await
 * the builder itself (`.returns<T[]>()`) rather than a terminal method.
 */
function fakeClient(db: FakeDatabase): SupabaseClient {
  function table(rows: Row[], onQuery?: (column: string, value: unknown) => void) {
    const filters: [string, unknown][] = [];
    const matches = () =>
      rows.filter((row) => filters.every(([column, value]) => row[column] === value));

    const builder = {
      select: () => builder,
      returns: () => builder,
      eq: (column: string, value: unknown) => {
        onQuery?.(column, value);
        filters.push([column, value]);
        return builder;
      },
      neq: () => builder,
      gte: () => builder,
      order: () => builder,
      // PostgREST returns no row, not an error, when nothing matches.
      maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
      insert: (row: Row) => {
        // Deliberately stores whatever it is given: nothing in the real schema
        // ties a booking's tenant to the request's tenant.
        db.insertedBookings.push(row);
        return builder;
      },
      single: async () => ({
        data: {
          id: BOOKING_ID,
          custom_fields: {},
          ...db.insertedBookings[db.insertedBookings.length - 1],
        },
        error: null,
      }),
      then: (
        resolve: (value: { data: Row[]; error: null }) => unknown,
      ) => Promise.resolve({ data: matches(), error: null }).then(resolve),
    };
    return builder;
  }

  return {
    from: (name: string) => {
      if (name === "customers") {
        return table(db.customers, (column, value) => {
          if (column === "id") db.customerIdsQueried.push(String(value));
        });
      }
      if (name === "services") return table(db.services);
      if (name === "end_customers") {
        return table([
          { id: END_CUSTOMER_ID, customer_id: ALPHA.id, name: "Mallory", phone: null },
          { id: END_CUSTOMER_ID, customer_id: BETA.id, name: "Mallory", phone: null },
        ]);
      }
      // `availability_rules`, `blocked_slots` and `bookings`: no fixture rows,
      // so the slot re-check has nothing to subtract. `generateDaySlots` is a
      // spy here anyway — what this suite reads is the zone it was handed.
      return table([]);
    },
    rpc: async () => ({ data: END_CUSTOMER_ID, error: null }),
  } as unknown as SupabaseClient;
}

let db: FakeDatabase;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDatabase();
  vi.mocked(createServiceRoleClient).mockReturnValue(fakeClient(db));
  // The chosen slot is open, so the pre-check passes and the flow completes.
  vi.mocked(generateDaySlots).mockReturnValue([{ start: SLOT.start, end: SLOT.end }]);
});

/** The `timeZone` the availability re-check was actually run with. */
function zoneUsedForRecheck(): unknown {
  expect(generateDaySlots).toHaveBeenCalledTimes(1);
  const call = vi.mocked(generateDaySlots).mock.calls.at(0);
  if (!call) throw new Error("generateDaySlots was never called");
  return call[0].timeZone;
}

describe("createBooking resolves the availability zone server-side", () => {
  it("uses the tenant's own configured zone", async () => {
    const input: CreateBookingInput = {
      customerId: ALPHA.id,
      serviceId: ALPHA.serviceId,
      slot: SLOT,
      guest: { name: "Mallory", email: "mallory@example.test" },
    };

    await createBooking(input);

    expect(zoneUsedForRecheck()).toBe(ALPHA.timezone);
    expect(db.customerIdsQueried).toEqual([ALPHA.id]);
  });

  it("reads it per tenant, so it is not a constant that only looks correct", async () => {
    // The discriminating control for the case above: a hard-coded
    // "America/New_York" would satisfy that assertion and fail this one.
    await createBooking({
      customerId: BETA.id,
      serviceId: BETA.serviceId,
      slot: SLOT,
      guest: { name: "Mallory", email: "mallory@example.test" },
    });

    expect(zoneUsedForRecheck()).toBe(BETA.timezone);
    expect(db.customerIdsQueried).toEqual([BETA.id]);
  });

  it("ignores a zone smuggled in through the browser-supplied customFields", async () => {
    // `customFields` is browser-supplied end to end — `createBookingAction`
    // passes `request.customFields` straight through — so this is the realistic
    // shape of the attack, not a hypothetical one.
    await createBooking({
      customerId: ALPHA.id,
      serviceId: ALPHA.serviceId,
      slot: SLOT,
      guest: { name: "Mallory", email: "mallory@example.test" },
      customFields: {
        timezone: BETA.timezone,
        timeZone: BETA.timezone,
        tz: "Etc/GMT-14",
      },
    });

    expect(zoneUsedForRecheck()).toBe(ALPHA.timezone);
    expect(zoneUsedForRecheck()).not.toBe(BETA.timezone);
    // Beta's row was never so much as read.
    expect(db.customerIdsQueried).not.toContain(BETA.id);
  });

  it("ignores a zone set directly on the input, however it got there", async () => {
    // `CreateBookingInput` has no `timeZone` field, and the cast is the point:
    // if one is ever added, this asserts the write path still does not read it.
    // Type-level absence is the first defence; this is the second.
    const forged = {
      customerId: ALPHA.id,
      serviceId: ALPHA.serviceId,
      slot: SLOT,
      guest: { name: "Mallory", email: "mallory@example.test" },
      timeZone: BETA.timezone,
      timezone: BETA.timezone,
    } as unknown as CreateBookingInput;

    await createBooking(forged);

    expect(zoneUsedForRecheck()).toBe(ALPHA.timezone);
    expect(db.customerIdsQueried).toEqual([ALPHA.id]);
  });

  it("scopes the read by customer_id — one tenant's id never returns another's zone", async () => {
    await expect(getTenantTimeZone(ALPHA.id)).resolves.toBe(ALPHA.timezone);
    await expect(getTenantTimeZone(BETA.id)).resolves.toBe(BETA.timezone);
  });

  it("refuses an unknown tenant instead of guessing a zone", async () => {
    // The fake returns `{ data: null }`, exactly as PostgREST does for a filter
    // that matches nothing. Falling back to UTC here would put every booking for
    // a vanished tenant on the server's clock — silently, which is the failure
    // mode this whole issue exists to remove.
    await expect(getTenantTimeZone(UNKNOWN_TENANT_ID)).rejects.toThrow(
      /no longer available/i,
    );
  });
});
