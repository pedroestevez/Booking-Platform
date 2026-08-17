import { PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBookingAction } from "@/app/[customerSlug]/actions";
import { generateDaySlots } from "@/lib/availability";
import { createBooking } from "@/lib/bookings";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getTenantBySlug } from "@/lib/tenants";
import type {
  CreateBookingInput,
  CreateBookingRequest,
  Tenant,
} from "@/lib/types";

/**
 * The insert path's error handling (ALI-98, criteria 5 and 6).
 *
 * `bookings_no_overlap` (migration 0006) makes Postgres the arbiter of slot
 * collisions, and it reports one by rejecting the insert with SQLSTATE 23P01.
 * These tests pin the two halves of the contract that follows from that:
 *
 *   • 23P01 becomes the friendly, user-facing "pick another time" message —
 *     the same one the availability pre-check produces, so a guest cannot tell
 *     which layer caught the clash.
 *   • Every other code propagates untouched. A blanket catch here would turn a
 *     foreign-key violation, an RLS denial, or a dropped connection into a
 *     false scheduling message and hide real breakage behind a plausible one.
 *
 * ## What is mocked, and what that costs
 *
 * `@/lib/supabase/server`, `@/lib/tenants` and `@/lib/availability` are mocked
 * so control reaches the insert without a live Supabase endpoint. The error
 * object is built from the library's **own exported** `PostgrestError` class,
 * so the client-side shape is compile-time checked rather than hand-waved.
 *
 * The one thing these tests assume rather than prove is PostgREST's documented
 * SQLSTATE → `PostgrestError.code` mapping — that a Postgres 23P01 arrives at
 * the client as `code === "23P01"`. Proving that needs a real PostgREST in CI,
 * which the hermetic `postgres:16` container does not provide; it is recorded
 * as a deferred item on ALI-114's open question. The database half of the
 * contract — that 23P01 is what Postgres actually raises — is proved for real
 * in `src/test/__tests__/booking-overlap.db.test.ts`.
 */

vi.mock("@/lib/supabase/server", () => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/tenants", () => ({
  getAvailabilityRules: vi.fn(async () => []),
  getBlockedSlots: vi.fn(async () => []),
  getUpcomingBookings: vi.fn(async () => []),
  // ALI-139: the action now resolves the tenant from the slug before it writes
  // anything, so this suite would not reach the insert without it. The
  // implementation is attached in `arrangeInsertFailure` rather than here —
  // `vi.mock` factories run during import, before this module's constants
  // exist, so referencing `TENANT` from inside one would throw.
  getTenantBySlug: vi.fn(),
}));

vi.mock("@/lib/availability", () => ({
  generateDaySlots: vi.fn(() => []),
}));

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const END_CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const TENANT_SLUG = "conflict-fixture";

const TENANT: Tenant = {
  id: CUSTOMER_ID,
  name: "Conflict Fixture",
  slug: TENANT_SLUG,
  branding: {
    brandColor: "#000000",
    currency: "USD",
    timezone: "UTC",
  },
};

const SLOT = {
  start: "2026-09-01T10:00:00.000Z",
  end: "2026-09-01T11:00:00.000Z",
};

const INPUT: CreateBookingInput = {
  customerId: CUSTOMER_ID,
  serviceId: SERVICE_ID,
  slot: SLOT,
  guest: { name: "Ada Lovelace", email: "ada@example.test" },
};

/**
 * The same booking as `INPUT`, in the shape the browser may send (ALI-139):
 * the tenant is named by its public slug and the action resolves the id.
 */
const REQUEST: CreateBookingRequest = {
  customerSlug: TENANT_SLUG,
  serviceId: SERVICE_ID,
  slot: SLOT,
  guest: { name: "Ada Lovelace", email: "ada@example.test" },
};

const SERVICE_ROW = {
  id: SERVICE_ID,
  customer_id: CUSTOMER_ID,
  name: "Consultation",
  description: "",
  duration_minutes: 60,
  price_cents: 5000,
  active: true,
};

const CONFLICT_MESSAGE = "Sorry, that time was just taken. Please pick another.";

type InsertResult = { data: unknown; error: PostgrestError | null };

/**
 * A Supabase client stub covering exactly the calls `createBooking` makes: the
 * `services` lookup, the identity `rpc`, and the `bookings` insert. Chainable
 * builders return themselves; only the terminal `maybeSingle`/`single` resolve.
 */
function stubSupabase(insertResult: InsertResult): SupabaseClient {
  const services = {
    select: () => services,
    eq: () => services,
    maybeSingle: async () => ({ data: SERVICE_ROW, error: null }),
  };

  const bookings = {
    insert: () => bookings,
    select: () => bookings,
    single: async () => insertResult,
  };

  return {
    from: (table: string) => (table === "services" ? services : bookings),
    rpc: async () => ({ data: END_CUSTOMER_ID, error: null }),
  } as unknown as SupabaseClient;
}

/** Arrange the mocks so control reaches the insert, which then fails with `error`. */
function arrangeInsertFailure(error: PostgrestError): void {
  // Slug → tenant, the way `getTenantBySlug` really behaves: the fixture slug
  // resolves, anything else resolves to `null` rather than to a tenant.
  vi.mocked(getTenantBySlug).mockImplementation(async (slug: string) =>
    slug === TENANT_SLUG ? TENANT : null,
  );
  // The slot the caller asked for is reported as open, so the pre-check passes
  // and the constraint — not the check — is what rejects the booking. This is
  // precisely the race: availability says free, the database says taken.
  vi.mocked(generateDaySlots).mockReturnValue([{ start: SLOT.start, end: SLOT.end }]);
  vi.mocked(createServiceRoleClient).mockReturnValue(
    stubSupabase({ data: null, error }),
  );
}

const exclusionViolation = () =>
  new PostgrestError({
    message:
      'conflicting key value violates exclusion constraint "bookings_no_overlap"',
    details: "Key (customer_id, tstzrange(start_time, end_time))=(…) conflicts",
    hint: "",
    code: "23P01",
  });

const foreignKeyViolation = () =>
  new PostgrestError({
    message:
      'insert or update on table "bookings" violates foreign key constraint "bookings_service_id_fkey"',
    details: 'Key (service_id)=(…) is not present in table "services".',
    hint: "",
    code: "23503",
  });

describe("createBooking — slot-collision error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("translates a 23P01 exclusion violation into the friendly message", async () => {
    arrangeInsertFailure(exclusionViolation());

    await expect(createBooking(INPUT)).rejects.toThrow(
      new Error(CONFLICT_MESSAGE),
    );
  });

  it("throws a plain Error, not the raw PostgrestError, for 23P01", async () => {
    arrangeInsertFailure(exclusionViolation());

    // The action layer surfaces `err.message` verbatim to the guest, so the
    // database's own wording ("conflicting key value violates exclusion
    // constraint …") must not be what escapes.
    const err = await createBooking(INPUT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PostgrestError);
    expect((err as Error).message).toBe(CONFLICT_MESSAGE);
  });

  it("propagates a non-23P01 error unchanged (23503 foreign-key violation)", async () => {
    const fkError = foreignKeyViolation();
    arrangeInsertFailure(fkError);

    // Identity, not just shape: the very object the client returned is what
    // escapes. A real failure must never be disguised as "pick another time".
    const err = await createBooking(INPUT).catch((e: unknown) => e);

    expect(err).toBe(fkError);
    expect((err as PostgrestError).code).toBe("23503");
    expect((err as PostgrestError).message).not.toBe(CONFLICT_MESSAGE);
  });
});

describe("createBookingAction — the shape the guest's browser receives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { ok: false, error } with the friendly message on 23P01", async () => {
    arrangeInsertFailure(exclusionViolation());

    await expect(createBookingAction(REQUEST)).resolves.toEqual({
      ok: false,
      error: CONFLICT_MESSAGE,
    });
  });

  it("reports a non-23P01 failure as a failure, not as a scheduling conflict", async () => {
    arrangeInsertFailure(foreignKeyViolation());

    const result = await createBookingAction(REQUEST);

    // Scope, stated plainly: this asserts only that a real fault is NOT
    // disguised as "that time was just taken". It does not assert the message
    // is fit for a guest to read — the action maps any thrown Error to its
    // `message`, so today the raw PostgREST wording does reach the caller.
    // Sanitising that is ALI-140's job, not this issue's; asserting it here
    // would pin behaviour ALI-140 is meant to change.
    expect(result.ok).toBe(false);
    expect(result).not.toEqual({ ok: false, error: CONFLICT_MESSAGE });
  });
});
