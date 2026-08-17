import { PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBookingAction } from "@/app/[customerSlug]/actions";
import { generateDaySlots } from "@/lib/availability";
import { createBooking } from "@/lib/bookings";
import { genericFailureMessage } from "@/lib/errors";
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
 *
 * ## What ALI-140 added here, and what it changed
 *
 * ALI-140 closed the other half of this contract: a non-23P01 failure was not
 * only *not* disguised as a conflict, it was handed to the guest verbatim —
 * constraint names, table names, env-var names, and (via a migration's own
 * `raise exception`) an interpolated tenant UUID. So the same arrangement now
 * carries three further claims:
 *
 *   • The 23P01 path is **unchanged**: the same constant sentence, and no log
 *     record, because a lost race is an expected outcome and not a fault.
 *   • Every other failure reaches the guest as the generic message with a
 *     correlation id, and produces exactly one server-side log record holding
 *     the original error.
 *   • `createBooking` still propagates those failures *verbatim* — that is what
 *     delivers the original error to the boundary, which is the only thing that
 *     reaches the log. The sanitising happens at the boundary, once.
 *
 * The 23503 test that used to state "the raw PostgREST wording does reach the
 * caller; sanitising that is ALI-140's job" is reworked rather than deleted: the
 * claim it really guarded — a real fault is never dressed up as "pick another
 * time" — still holds, and it now also asserts the fault is not leaked.
 */

vi.mock("@/lib/supabase/server", () => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/tenants", () => ({
  getAvailabilityRules: vi.fn(async () => []),
  getBlockedSlots: vi.fn(async () => []),
  getUpcomingBookings: vi.fn(async () => []),
  // ALI-117: the write path resolves the tenant's zone server-side before the
  // availability re-check. `TENANT.branding.timezone` below is the same "UTC",
  // restated here because a `vi.mock` factory cannot reach this module's
  // constants (see the note on `getTenantBySlug`).
  getTenantTimeZone: vi.fn(async () => "UTC"),
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
/** Named because ALI-140 asserts it does **not** appear in what the guest is told. */
const GUEST_EMAIL = "ada@example.test";

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
  guest: { name: "Ada Lovelace", email: GUEST_EMAIL },
};

/**
 * The same booking as `INPUT`, in the shape the browser may send (ALI-139):
 * the tenant is named by its public slug and the action resolves the id.
 */
const REQUEST: CreateBookingRequest = {
  customerSlug: TENANT_SLUG,
  serviceId: SERVICE_ID,
  slot: SLOT,
  guest: { name: "Ada Lovelace", email: GUEST_EMAIL },
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
type RpcResult = { data: unknown; error: PostgrestError | null };

/** The identity RPC succeeding, which is what every insert-focused test needs. */
const RPC_OK: RpcResult = { data: END_CUSTOMER_ID, error: null };

/**
 * A Supabase client stub covering exactly the calls `createBooking` makes: the
 * `services` lookup, the identity `rpc`, the identity read-back, and the
 * `bookings` insert. Chainable builders return themselves; only the terminal
 * `maybeSingle`/`single` resolve.
 *
 * `rpcResult` is a parameter (ALI-140) so a failure can also be arranged
 * *before* the insert: migration 0007's `raise exception` surfaces on the
 * identity RPC, not on the insert, and it is the case that proves the mapping
 * covers our own server-side messages and not just the driver's.
 */
function stubSupabase(
  insertResult: InsertResult,
  rpcResult: RpcResult = RPC_OK,
): SupabaseClient {
  const services = {
    select: () => services,
    eq: () => services,
    maybeSingle: async () => ({ data: SERVICE_ROW, error: null }),
  };

  // ALI-167: after resolving the identity, the write path reads it back so what
  // the request supplied can be recorded on the booking. Stubbed to return the
  // guest's own details, i.e. nothing diverges — this suite is about the
  // insert's error handling, and `custom_fields` must not be what decides it.
  const endCustomers = {
    select: () => endCustomers,
    eq: () => endCustomers,
    maybeSingle: async () => ({
      data: { id: END_CUSTOMER_ID, name: INPUT.guest.name, phone: null },
      error: null,
    }),
  };

  const bookings = {
    insert: () => bookings,
    select: () => bookings,
    single: async () => insertResult,
  };

  return {
    from: (table: string) => {
      if (table === "services") return services;
      if (table === "end_customers") return endCustomers;
      return bookings;
    },
    rpc: async () => rpcResult,
  } as unknown as SupabaseClient;
}

/** Everything the write path needs before it reaches the driver at all. */
function arrangeTenantAndSlot(): void {
  // Slug → tenant, the way `getTenantBySlug` really behaves: the fixture slug
  // resolves, anything else resolves to `null` rather than to a tenant.
  vi.mocked(getTenantBySlug).mockImplementation(async (slug: string) =>
    slug === TENANT_SLUG ? TENANT : null,
  );
  // The slot the caller asked for is reported as open, so the pre-check passes
  // and the constraint — not the check — is what rejects the booking. This is
  // precisely the race: availability says free, the database says taken.
  vi.mocked(generateDaySlots).mockReturnValue([{ start: SLOT.start, end: SLOT.end }]);
}

/** Arrange the mocks so control reaches the insert, which then fails with `error`. */
function arrangeInsertFailure(error: PostgrestError): void {
  arrangeTenantAndSlot();
  vi.mocked(createServiceRoleClient).mockReturnValue(
    stubSupabase({ data: null, error }),
  );
}

/**
 * Arrange the mocks so the **identity RPC** fails with `error` (ALI-140/S2).
 *
 * Nothing reaches the insert on this path — `createBooking` throws the RPC's
 * error straight through — which is exactly how migration 0007's own
 * `raise exception` gets to the boundary.
 */
function arrangeIdentityFailure(error: PostgrestError): void {
  arrangeTenantAndSlot();
  vi.mocked(createServiceRoleClient).mockReturnValue(
    stubSupabase({ data: null, error: null }, { data: null, error }),
  );
}

/**
 * Arrange the mocks so building the client itself throws (ALI-140).
 *
 * The misconfiguration case: `createServiceRoleClient` names both env vars in
 * its message, and this is a plain `Error` rather than a `PostgrestError` — so
 * it proves the mapping is not a PostgREST-shaped special case.
 */
function arrangeClientFailure(error: Error): void {
  arrangeTenantAndSlot();
  vi.mocked(createServiceRoleClient).mockImplementation(() => {
    throw error;
  });
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

/**
 * Migration 0007's fallback `raise exception`, as PostgREST delivers it
 * (ALI-167 security pass, S2).
 *
 * This message is **ours**, not the driver's, and it interpolates
 * `p_customer_id` and `v_email` — so a rule that only sanitised driver text
 * would ship a tenant UUID and a guest's email address to the browser. The path
 * is documented-unreachable under READ COMMITTED; the mapping is not permitted
 * to depend on that, which is what this fixture exists to check.
 */
const raisedIdentityException = () =>
  new PostgrestError({
    message:
      "resolve_or_create_end_customer: identity for " +
      `(${CUSTOMER_ID}, ${GUEST_EMAIL}) neither found nor created`,
    details: "",
    hint: "A concurrent insert is not visible to this snapshot; retry the request.",
    code: "40001",
  });

/** `createServiceRoleClient`'s own message, verbatim from `src/lib/supabase/server.ts`. */
const misconfiguration = () =>
  new Error(
    "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and " +
      "SUPABASE_SERVICE_ROLE_KEY in the environment (see .env.example).",
  );

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

function spyOnConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

let consoleError: ReturnType<typeof spyOnConsoleError>;

beforeEach(() => {
  consoleError = spyOnConsoleError();
});

afterEach(() => {
  consoleError.mockRestore();
});

/**
 * Assert the guest got the generic message and the operator got exactly one log
 * record holding `original`, and that the correlation id is the *same* in both.
 *
 * Returns that id. The equality against `genericFailureMessage` is what makes
 * "no identifier leaked" airtight rather than a hand-picked list of substrings:
 * the message is that function's output and nothing else, and
 * `errors.test.ts` sweeps that output against the full forbidden-token list.
 */
function expectSanitised(error: string, original: Error): string {
  const reference = error.match(UUID_PATTERN)?.[0];
  expect(reference).toBeDefined();
  expect(error).toBe(genericFailureMessage(reference!));

  expect(consoleError).toHaveBeenCalledTimes(1);
  const [summary, payload] = consoleError.mock.calls[0]!;
  expect(String(summary)).toContain(reference!);
  expect(payload).toMatchObject({
    reference,
    operation: "createBookingAction",
    error: { message: original.message },
  });

  return reference!;
}

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

    // ALI-140 did not change this, and depends on it: verbatim propagation to
    // the boundary is the only thing that puts the original error in the log
    // record. Sanitising *here* would leave the operator with a generic message
    // too. And this layer logs nothing — the boundary logs, exactly once, which
    // is what makes "exactly one record" countable.
    expect(consoleError).not.toHaveBeenCalled();
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

    // The 23P01 path is unchanged by ALI-140, in both halves: the guest gets
    // the same constant sentence (asserted above, byte for byte), and losing a
    // race is an expected outcome rather than a fault, so it logs nothing. A
    // sanitiser that swallowed this message would also make the constraint
    // distinguishable from the availability pre-check, undoing ALI-98.
    expect(consoleError).not.toHaveBeenCalled();
  });

  // ── Reworked, not deleted (ALI-140) ────────────────────────────────────────
  //
  // This test used to record that the raw PostgREST wording reached the caller
  // and that sanitising it was ALI-140's job. That job is done, so the same
  // test now states the whole contract for a non-23P01 fault: it is neither
  // disguised as a scheduling conflict — the claim this test always guarded, and
  // which still holds — nor leaked verbatim.
  it("reports a non-23P01 failure as neither a conflict nor raw driver text", async () => {
    const fkError = foreignKeyViolation();
    arrangeInsertFailure(fkError);

    const result = await createBookingAction(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // Half one, unchanged: a real fault is not dressed up as "pick another time".
    expect(result.error).not.toBe(CONFLICT_MESSAGE);

    // Generic message + one log record holding the original, same reference.
    const reference = expectSanitised(result.error, fkError);

    // Half two, new: nor is it handed over as the driver wrote it. The table and
    // constraint names are named explicitly, because they are precisely what
    // used to escape. Checked with the reference elided — it is a random UUID,
    // and a hex run inside it could contain a short token like `23503` by
    // chance, which would flake an otherwise sound assertion.
    const shown = result.error.replace(reference, "<reference>");
    expect(shown).not.toContain(fkError.message);
    expect(shown).not.toContain("bookings_service_id_fkey");
    expect(shown).not.toContain("bookings");
    expect(shown).not.toContain("constraint");
    expect(shown).not.toContain("23503");
    // `details` carries the key values and must never travel either.
    expect(shown).not.toContain("is not present in table");
  });
});

/**
 * The mapping at the boundary, on the three classes of fault that reach it
 * (ALI-140, including the S2 scope extension).
 *
 * Each case asserts the same two things — the guest is told nothing about the
 * machinery, the operator is told everything — against a fault that leaked a
 * *different* kind of identifier before the fix.
 */
describe("createBookingAction — an unexpected failure is generic and logged once", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not leak a migration's raise exception, tenant UUID and all (S2)", async () => {
    const raised = raisedIdentityException();
    arrangeIdentityFailure(raised);

    const result = await createBookingAction(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const reference = expectSanitised(result.error, raised);

    // The interpolated values are the disclosure: a tenant's UUID (which the
    // ALI-139 fix exists to keep out of the browser's hands entirely) and the
    // email address the guest typed. Reference elided, as above.
    const shown = result.error.replace(reference, "<reference>");
    expect(shown).not.toContain(CUSTOMER_ID);
    expect(shown).not.toContain(GUEST_EMAIL);
    expect(shown).not.toContain("resolve_or_create_end_customer");
    expect(shown).not.toContain("40001");

    // The operator gets what the guest did not, keyed by the same reference.
    const [, payload] = consoleError.mock.calls[0]!;
    expect(payload).toMatchObject({
      reference,
      error: { code: "40001", message: expect.stringContaining(CUSTOMER_ID) },
    });
  });

  it("does not leak the env-var names behind a misconfiguration", async () => {
    const configError = misconfiguration();
    arrangeClientFailure(configError);

    const result = await createBookingAction(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const reference = expectSanitised(result.error, configError);

    // A plain `Error`, not a `PostgrestError` — the mapping is not a
    // PostgREST-shaped special case. And an unconfigured deployment must not
    // answer an anonymous visitor with the names of the variables to attack.
    const shown = result.error.replace(reference, "<reference>");
    expect(shown).not.toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(shown).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(shown).not.toContain("Supabase");
    expect(shown).not.toContain(".env");
  });

  it("still lets a guest-facing refusal through untouched", async () => {
    // The counterweight to all of the above: the product's own copy is not
    // collateral damage. Here the availability pre-check refuses a slot it no
    // longer sees as open — an allowlisted sentence — so the guest reads what the
    // code wrote, and it is the *same* sentence a 23P01 produces, which is the
    // ALI-98 property a blanket sanitiser would have destroyed.
    arrangeTenantAndSlot();
    vi.mocked(createServiceRoleClient).mockReturnValue(
      stubSupabase({ data: null, error: null }),
    );
    // Overrides the open slot arranged above: nothing is free, so the pre-check
    // is what refuses the booking and the driver is never reached.
    vi.mocked(generateDaySlots).mockReturnValue([]);

    const result = await createBookingAction(REQUEST);

    expect(result).toEqual({ ok: false, error: CONFLICT_MESSAGE });
    expect(consoleError).not.toHaveBeenCalled();
  });
});
