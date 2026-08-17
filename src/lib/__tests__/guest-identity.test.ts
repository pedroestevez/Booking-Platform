import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBookingAction } from "@/app/[customerSlug]/actions";
import { getAdminBookings, getAdminOverview } from "@/lib/admin/bookings";
import { generateDaySlots } from "@/lib/availability";
import {
  GUEST_SUPPLIED_FIELD,
  diffGuestSupplied,
  withGuestSupplied,
} from "@/lib/bookings";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  IDENTITY_CONFLICT_CASES,
  fakeResolveOrCreateEndCustomer,
  type FakeEndCustomerRow,
} from "@/test/fake-identity-rpc";
import type { CreateBookingRequest } from "@/lib/types";

/**
 * The guest identity is immutable on the anonymous path — app layer (ALI-167).
 *
 * The load-bearing proof for this issue is `guest-identity.db.test.ts`, which
 * runs against a real Postgres, because the guarantee itself is a `security
 * definer` function and the previous version of this app-layer fake reported
 * the vulnerable production behaviour as green. What *this* suite owns is the
 * half that lives in TypeScript and cannot be asserted in SQL:
 *
 *   • AC2 — the booking still attaches to the existing identity, through the
 *     real `createBookingAction` → `createBooking` path.
 *   • AC3 — the supplied values are recorded per-booking, and the reserved
 *     `custom_fields.guest_supplied` key is server-authoritative.
 *   • AC5 — the paths that were already correct still are.
 *   • AC7 — the admin read path renders the *stored* identity, never the
 *     recorded `guest_supplied` value.
 *
 * The fake driver is `@/test/fake-identity-rpc` — one shared model, pinned to
 * the real function by the DB suite. See that module's docstring for why the
 * fake is a module rather than a closure.
 */

vi.mock("@/lib/supabase/server", () => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/availability", () => ({
  generateDaySlots: vi.fn(() => []),
}));

const TENANT = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  slug: "tenant-one",
  serviceId: "c5e40001-0000-4000-8000-000000000001",
};

const B1_SLOT = {
  start: "2026-09-01T09:00:00.000Z",
  end: "2026-09-01T10:00:00.000Z",
};

const SLOT = {
  start: "2026-09-01T10:00:00.000Z",
  end: "2026-09-01T11:00:00.000Z",
};

/** The fixture identity: `(T, guest@example.com, 'Alice', '+15550001')`. */
const ALICE = {
  id: "end-customer-alice",
  email: "guest@example.com",
  name: "Alice",
  phone: "+15550001",
} as const;

interface Row {
  [column: string]: unknown;
}

/**
 * The tables this path touches. Deliberately the same shape as the ALI-139
 * suite's fake — the two differ only in the fixtures they seed, and both drive
 * the identity RPC through the one shared model.
 */
class FakeDatabase {
  readonly customers: Row[] = [
    { id: TENANT.id, name: "Tenant One", slug: TENANT.slug, branding_json: {} },
  ];

  readonly services: Row[] = [
    {
      id: TENANT.serviceId,
      customer_id: TENANT.id,
      name: "Interview",
      description: "",
      duration_minutes: 60,
      price_cents: 0,
      active: true,
    },
  ];

  readonly availability_rules: Row[] = [];
  readonly blocked_slots: Row[] = [];
  readonly end_customers: FakeEndCustomerRow[] = [];
  readonly bookings: Row[] = [];

  table(name: string): Row[] {
    const t = (this as unknown as Record<string, Row[]>)[name];
    if (!Array.isArray(t)) throw new Error(`fake: unknown table "${name}"`);
    return t;
  }

  /** Seed the fixture: Alice's identity plus booking `B1` referencing it. */
  seedAliceAndB1(): { b1: Row } {
    this.end_customers.push({ ...ALICE, customer_id: TENANT.id });
    const b1: Row = {
      id: "booking-b1",
      customer_id: TENANT.id,
      service_id: TENANT.serviceId,
      end_customer_id: ALICE.id,
      start_time: B1_SLOT.start,
      end_time: B1_SLOT.end,
      notes: null,
      status: "pending",
      custom_fields: {},
    };
    this.bookings.push(b1);
    return { b1 };
  }

  identity(email: string): FakeEndCustomerRow | undefined {
    return this.end_customers.find(
      (r) => r.customer_id === TENANT.id && r.email === email,
    );
  }

  /** Bookings other than the `B1` fixture, in insertion order. */
  newBookings(): Row[] {
    return this.bookings.filter((r) => r.id !== "booking-b1");
  }
}

type Filter = (row: Row) => boolean;

/** A chainable PostgREST-shaped builder over `FakeDatabase` (see ALI-139's). */
class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  private readonly filters: Filter[] = [];
  private pendingInsert: Row | null = null;

  constructor(
    private readonly db: FakeDatabase,
    private readonly tableName: string,
  ) {}

  select(): this {
    return this;
  }

  order(): this {
    return this;
  }

  returns<T>(): FakeQuery & PromiseLike<{ data: T; error: null }> {
    return this as unknown as FakeQuery & PromiseLike<{ data: T; error: null }>;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push((row) => String(row[column]) >= String(value));
    return this;
  }

  insert(row: Row): this {
    this.pendingInsert = row;
    return this;
  }

  private rows(): Row[] {
    return this.db
      .table(this.tableName)
      .filter((row) => this.filters.every((f) => f(row)));
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return { data: this.rows()[0] ?? null, error: null };
  }

  async single(): Promise<{ data: Row | null; error: null }> {
    if (this.pendingInsert) {
      const stored: Row = {
        id: `${this.tableName}-${this.db.table(this.tableName).length + 1}`,
        ...this.pendingInsert,
      };
      this.db.table(this.tableName).push(stored);
      this.pendingInsert = null;
      return { data: stored, error: null };
    }
    return { data: this.rows()[0] ?? null, error: null };
  }

  then<R1 = { data: unknown; error: null }, R2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: null }) => R1 | PromiseLike<R1>)
      | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve({ data: this.rows(), error: null }).then(
      onfulfilled,
      onrejected,
    );
  }
}

function fakeSupabase(db: FakeDatabase): SupabaseClient {
  return {
    from: (table: string) => new FakeQuery(db, table),
    rpc: async (_fn: string, args: Record<string, unknown>) =>
      fakeResolveOrCreateEndCustomer(db, args),
  } as unknown as SupabaseClient;
}

let db: FakeDatabase;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDatabase();
  vi.mocked(createServiceRoleClient).mockReturnValue(fakeSupabase(db));
  vi.mocked(generateDaySlots).mockReturnValue([
    { start: SLOT.start, end: SLOT.end },
  ]);
});

/** A booking request from the public page, as the browser sends it. */
function request(
  overrides: Partial<CreateBookingRequest> = {},
): CreateBookingRequest {
  return {
    customerSlug: TENANT.slug,
    serviceId: TENANT.serviceId,
    slot: SLOT,
    guest: { name: "Bob", email: ALICE.email },
    ...overrides,
  };
}

// ── The shared model matches the contract table (AC4b) ───────────────────────
//
// The same table runs against a live Postgres in
// `src/test/__tests__/guest-identity.db.test.ts`. Running one table through
// both is what stops the fake drifting away from the function it models — which
// is the defect that let this bug live undetected in a green suite.
describe("ALI-167 — the fake models 0007's conflict semantics", () => {
  it.each(IDENTITY_CONFLICT_CASES.map((c) => [c.label, c] as const))(
    "%s",
    (_label, testCase) => {
      const store = {
        customers: [{ id: TENANT.id }],
        end_customers: [] as FakeEndCustomerRow[],
      };
      if (testCase.stored) {
        store.end_customers.push({
          id: "existing",
          customer_id: TENANT.id,
          email: ALICE.email,
          name: testCase.stored.name,
          phone: testCase.stored.phone,
        });
      }

      const { data, error } = fakeResolveOrCreateEndCustomer(store, {
        p_customer_id: TENANT.id,
        p_email: ALICE.email,
        p_name: testCase.supplied.name,
        p_phone: testCase.supplied.phone,
      });

      expect(error).toBeNull();
      expect(data).toEqual(expect.any(String));

      // Never a fork: one identity per (tenant, email), whatever happened.
      expect(store.end_customers).toHaveLength(1);
      const row = store.end_customers[0]!;
      expect(row.id).toBe(data);
      expect({ name: row.name, phone: row.phone }).toEqual(testCase.expected);
    },
  );

  // A fake that only says yes is a model of success, not of the system. The
  // real function sits over a `not null` email and a foreign key to
  // `customers`; the DB suite proves Postgres rejects both of these for real.
  it("rejects a missing email with 23502, like the not-null constraint", () => {
    const store = { customers: [{ id: TENANT.id }], end_customers: [] };
    const { data, error } = fakeResolveOrCreateEndCustomer(store, {
      p_customer_id: TENANT.id,
      p_email: null,
      p_name: "Bob",
    });

    expect(data).toBeNull();
    expect(error?.code).toBe("23502");
    expect(store.end_customers).toHaveLength(0);
  });

  it("rejects an unknown tenant with 23503, like the foreign key", () => {
    const store = { customers: [{ id: TENANT.id }], end_customers: [] };
    const { data, error } = fakeResolveOrCreateEndCustomer(store, {
      p_customer_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      p_email: ALICE.email,
      p_name: "Bob",
    });

    expect(data).toBeNull();
    expect(error?.code).toBe("23503");
    expect(store.end_customers).toHaveLength(0);
  });
});

// ── AC2 + AC3 ────────────────────────────────────────────────────────────────
describe("ALI-167 — an anonymous repeat booking through createBookingAction", () => {
  it("attaches to the existing identity without forking or mutating it (AC2)", async () => {
    const { b1 } = db.seedAliceAndB1();

    const result = await createBookingAction(request());

    // The corollary that matters as much as the fix: the booking SUCCEEDS.
    // Refusing it would convert a data-integrity bug into a denial of service
    // on a legitimate returning guest.
    expect(result.ok).toBe(true);

    // One identity, byte-identical to before the call.
    expect(
      db.end_customers.filter(
        (r) => r.customer_id === TENANT.id && r.email === ALICE.email,
      ),
    ).toHaveLength(1);
    const identity = db.identity(ALICE.email)!;
    expect({ name: identity.name, phone: identity.phone }).toEqual({
      name: "Alice",
      phone: "+15550001",
    });

    // …and the new booking hangs off that same identity, not a new one.
    const created = db.newBookings();
    expect(created).toHaveLength(1);
    expect(created[0]!.end_customer_id).toBe(ALICE.id);
    expect(created[0]!.end_customer_id).toBe(b1.end_customer_id);
  });

  it("records the supplied name on the new booking only (AC3a)", async () => {
    const { b1 } = db.seedAliceAndB1();

    await createBookingAction(request());

    expect(db.newBookings()[0]!.custom_fields).toEqual({
      [GUEST_SUPPLIED_FIELD]: { name: "Bob" },
    });
    // First contact writes nothing, so the earlier booking is untouched — the
    // record of who booked B1 does not move retroactively.
    expect(b1.custom_fields).toEqual({});
  });

  it("keeps per-vertical intake alongside the recorded value (AC3a)", async () => {
    db.seedAliceAndB1();

    await createBookingAction(request({ customFields: { referral: "instagram" } }));

    expect(db.newBookings()[0]!.custom_fields).toEqual({
      referral: "instagram",
      [GUEST_SUPPLIED_FIELD]: { name: "Bob" },
    });
  });

  it("records nothing when the supplied name matches the stored one (AC3a)", async () => {
    db.seedAliceAndB1();

    await createBookingAction(
      request({ guest: { name: ALICE.name, email: ALICE.email } }),
    );

    expect(db.newBookings()[0]!.custom_fields).toEqual({});
  });

  it("records nothing on first contact with an unknown email (AC3a)", async () => {
    const result = await createBookingAction(
      request({ guest: { name: "Carol", email: "carol@example.com" } }),
    );

    expect(result.ok).toBe(true);
    // The identity was created FROM the supplied name, so there is no
    // divergence to record — no separate "did it pre-exist?" round trip needed.
    expect(db.newBookings()[0]!.custom_fields).toEqual({});
    expect(db.identity("carol@example.com")!.name).toBe("Carol");
  });

  // ── AC3b: the reserved key is the server's ─────────────────────────────────
  it("discards a browser-supplied guest_supplied and stores the server's (AC3b)", async () => {
    db.seedAliceAndB1();

    // `custom_fields` is browser-supplied end to end — `request.customFields`
    // is passed straight through by the action — so a forged value for the
    // reserved key is the obvious next move once the identity is protected.
    await createBookingAction(
      request({
        customFields: { [GUEST_SUPPLIED_FIELD]: { name: ALICE.name } },
      }),
    );

    const stored = db.newBookings()[0]!.custom_fields as Record<string, unknown>;
    // The server's value ('Bob', what the request actually supplied) wins.
    expect(stored[GUEST_SUPPLIED_FIELD]).toEqual({ name: "Bob" });
    expect(JSON.stringify(stored)).not.toContain(ALICE.name);
  });

  it("discards a browser guest_supplied even when the server records nothing (AC3b)", async () => {
    db.seedAliceAndB1();

    // The dangerous case for a merge-based implementation: the server has
    // nothing to say, so a "default to what the browser sent" fallback would
    // let the forged value straight through.
    await createBookingAction(
      request({
        guest: { name: ALICE.name, email: ALICE.email },
        customFields: { [GUEST_SUPPLIED_FIELD]: { name: "Bob" }, bags: 2 },
      }),
    );

    expect(db.newBookings()[0]!.custom_fields).toEqual({ bags: 2 });
  });

  it("does not fork the identity when the same email arrives in a different case", async () => {
    db.seedAliceAndB1();

    await createBookingAction(
      request({ guest: { name: "Bob", email: "GUEST@Example.com" } }),
    );

    expect(db.end_customers).toHaveLength(1);
    expect(db.newBookings()[0]!.end_customer_id).toBe(ALICE.id);
  });
});

// ── AC7 ──────────────────────────────────────────────────────────────────────
//
// `src/lib/admin/bookings.ts` is expected to satisfy this WITHOUT a change,
// since its read path already joins the identity. That expectation is asserted
// rather than assumed: surfacing `guest_supplied` as the guest's identity would
// move the same bug from the database into the UI while every database
// assertion stayed green.
describe("ALI-167 — the admin dashboard shows the stored identity (AC7)", () => {
  /**
   * A joined admin row carrying a hostile `custom_fields.guest_supplied`.
   *
   * The production select does not even request `custom_fields`, so this shape
   * is *more* hostile than anything the real query can return — which is the
   * point: the assertion holds even if a later change starts selecting it.
   */
  const hostileRow = {
    id: "booking-b1",
    start_time: B1_SLOT.start,
    end_time: B1_SLOT.end,
    status: "pending",
    notes: null,
    service: { name: "Interview", price_cents: 0, duration_minutes: 60 },
    guest: { name: "Alice", email: ALICE.email, phone: ALICE.phone },
    custom_fields: { [GUEST_SUPPLIED_FIELD]: { name: "Bob", phone: "+15559999" } },
  };

  function stubAdminClient(): { selects: string[] } {
    const selects: string[] = [];
    const builder = {
      select: (projection: string) => {
        selects.push(projection);
        return builder;
      },
      eq: () => builder,
      in: () => builder,
      gte: () => builder,
      order: () => builder,
      returns: () => Promise.resolve({ data: [hostileRow], error: null }),
      then: (onfulfilled: (v: unknown) => unknown) =>
        Promise.resolve({ data: [hostileRow], error: null, count: 1 }).then(
          onfulfilled,
        ),
    };
    vi.mocked(createServiceRoleClient).mockReturnValue(
      { from: () => builder } as unknown as SupabaseClient,
    );
    return { selects };
  }

  it("renders B1's guest name as the stored 'Alice', never the supplied 'Bob'", async () => {
    stubAdminClient();

    const [booking] = await getAdminBookings(TENANT.id);

    expect(booking!.guestName).toBe("Alice");
    expect(booking!.guestEmail).toBe(ALICE.email);
    expect(booking!.guestPhone).toBe(ALICE.phone);
    // Nothing anywhere in the row the dashboard renders carries the supplied
    // value into a guest-identity position.
    expect(JSON.stringify(booking)).not.toContain("Bob");
    expect(JSON.stringify(booking)).not.toContain("+15559999");
  });

  it("holds on the overview's next-bookings list too", async () => {
    stubAdminClient();

    const overview = await getAdminOverview(TENANT.id);

    expect(overview.nextBookings[0]!.guestName).toBe("Alice");
    expect(JSON.stringify(overview.nextBookings)).not.toContain("Bob");
  });

  it("reads the guest name from the joined identity, not from custom_fields", async () => {
    const { selects } = stubAdminClient();

    await getAdminBookings(TENANT.id);

    // Structural, and the reason the assertions above are not merely lucky: the
    // guest name is projected from `end_customers`, and `custom_fields` is not
    // fetched at all, so `guest_supplied` has no route into the admin view.
    expect(selects[0]).toContain("guest:end_customers(name, email, phone)");
    expect(selects[0]).not.toContain("custom_fields");
  });
});

// ── The two pure functions the recording rests on ────────────────────────────
describe("diffGuestSupplied", () => {
  const stored = { name: "Alice", phone: "+15550001" };

  it("records a supplied value that differs from the stored one", () => {
    expect(diffGuestSupplied({ name: "Bob" }, stored)).toEqual({ name: "Bob" });
    expect(diffGuestSupplied({ name: "Bob", phone: "+15559999" }, stored)).toEqual(
      { name: "Bob", phone: "+15559999" },
    );
  });

  it("records nothing when the supplied value matches the stored one", () => {
    expect(diffGuestSupplied({ name: "Alice", phone: "+15550001" }, stored)).toBeNull();
  });

  it("treats an empty or absent value as supplying nothing", () => {
    // Mirrors `nullif(excluded.name, '')`: '' is "supplied nothing", so there is
    // no divergence to record even though '' !== 'Alice'.
    expect(diffGuestSupplied({ name: "" }, stored)).toBeNull();
    expect(diffGuestSupplied({ name: null, phone: null }, stored)).toBeNull();
    expect(diffGuestSupplied({}, stored)).toBeNull();
  });

  it("records a supplied value against a blank stored one", () => {
    // Blank-to-populated is still a mutation and is still refused, so the
    // supplied value has to land somewhere — here.
    expect(diffGuestSupplied({ name: "Bob", phone: "+1555" }, { name: "", phone: null }))
      .toEqual({ name: "Bob", phone: "+1555" });
  });
});

describe("withGuestSupplied", () => {
  it("always drops a browser value for the reserved key", () => {
    expect(
      withGuestSupplied({ [GUEST_SUPPLIED_FIELD]: { name: "Alice" }, bags: 2 }, null),
    ).toEqual({ bags: 2 });
  });

  it("replaces a browser value with the server's rather than merging", () => {
    expect(
      withGuestSupplied(
        { [GUEST_SUPPLIED_FIELD]: { name: "Alice", phone: "+1" }, bags: 2 },
        { name: "Bob" },
      ),
    ).toEqual({ bags: 2, [GUEST_SUPPLIED_FIELD]: { name: "Bob" } });
  });

  it("does not mutate the caller's object", () => {
    const input = { bags: 2 };
    withGuestSupplied(input, { name: "Bob" });
    expect(input).toEqual({ bags: 2 });
  });
});
