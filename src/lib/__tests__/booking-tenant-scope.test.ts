import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBookingAction } from "@/app/[customerSlug]/actions";
import { generateDaySlots } from "@/lib/availability";
import { createBooking } from "@/lib/bookings";
import { createServiceRoleClient } from "@/lib/supabase/server";
import type { CreateBookingInput, CreateBookingRequest } from "@/lib/types";

/**
 * Tenant scoping of the booking write path (ALI-139, acceptance criteria 1–3).
 *
 * The hole: `createBookingAction` took a `customerId` off the wire and handed
 * it to `createBooking`, which keys all six of its queries — services lookup,
 * three availability reads, the identity RPC, the insert — on that value
 * through the **service-role client, which bypasses RLS**. A visitor on tenant
 * A's public booking page could post tenant B's UUID and write `end_customers`
 * and `bookings` rows into tenant B.
 *
 * The fix resolves the tenant server-side from the slug and never reads a
 * client-supplied id. These tests hold that line **in both directions**: the
 * same forged payload is shown landing in the victim tenant through the old
 * code shape, and being refused through the new one. A one-directional test
 * ("the fix denies it") proves nothing on its own — a fake that cannot express
 * the attack would pass it while asserting nothing.
 *
 * ## What is faked, and how faithfully
 *
 * Only the **driver** is faked: `@/lib/supabase/server` (so no live PostgREST)
 * and `@/lib/availability` (so the slot re-check does not reject the fixture
 * time). `getTenantBySlug`, the three availability reads and `createBooking`
 * itself all execute for real against the fake, so what is under test is the
 * production resolution and scoping code, not a restatement of it.
 *
 * Per the faithful-fakes rule, `fakeSupabase` encodes the behaviours that make
 * the assertions mean something rather than the ones that make them pass:
 *
 *   • **Filters are actually applied.** A `services` lookup scoped to tenant A
 *     asking for tenant B's service id returns no row — the same denial
 *     Postgres gives — instead of cheerfully returning the row.
 *   • **The insert does NOT police `customer_id`.** It stores whatever the app
 *     supplies, because that is exactly what the real database does: nothing in
 *     the schema ties a booking's tenant to the request's tenant. If this fake
 *     "helpfully" rejected the mismatch, it would be simulating a guard that
 *     does not exist, and the vulnerability could not be demonstrated at all.
 *   • **Every tenant scope is recorded**, so a test can assert the victim was
 *     never so much as queried — not merely that no row was written.
 *
 * The database-level half of this issue — that Postgres really does accept a
 * cross-tenant `customer_id`, and what it costs the victim once ALI-98's
 * exclusion constraint is in place — is proved against a real Postgres in
 * `src/test/__tests__/tenant-scope.db.test.ts`.
 */

vi.mock("@/lib/supabase/server", () => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/availability", () => ({
  generateDaySlots: vi.fn(() => []),
}));

// ── The two tenants ─────────────────────────────────────────────────────────
// "alpha" is the page the guest is on. "beta" is the victim: a real, unrelated
// tenant whose id and service id are public knowledge, since both are shipped
// to the browser by beta's own public booking page.

const ALPHA = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  slug: "alpha-clinic",
  serviceId: "a5e40001-0000-4000-8000-000000000001",
};

const BETA = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  slug: "beta-studio",
  serviceId: "b5e40002-0000-4000-8000-000000000002",
};

const SLOT = {
  start: "2026-09-01T10:00:00.000Z",
  end: "2026-09-01T11:00:00.000Z",
};

const GUEST = { name: "Mallory", email: "mallory@example.test" };

const SERVICE_UNAVAILABLE = "That service is no longer available.";
const UNKNOWN_TENANT = "This booking page is no longer available.";

interface Row {
  [column: string]: unknown;
}

/**
 * An in-memory stand-in for the tables this path touches, plus a ledger of
 * every tenant scope the app asked for.
 */
class FakeDatabase {
  readonly customers: Row[] = [
    { id: ALPHA.id, name: "Alpha Clinic", slug: ALPHA.slug, branding_json: {} },
    { id: BETA.id, name: "Beta Studio", slug: BETA.slug, branding_json: {} },
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
      price_cents: 9000,
      active: true,
    },
  ];

  readonly availability_rules: Row[] = [];
  readonly blocked_slots: Row[] = [];
  readonly end_customers: Row[] = [];
  readonly bookings: Row[] = [];

  /** Every `customer_id` the app scoped a query, RPC or insert by, in order. */
  readonly tenantScopes: string[] = [];

  /**
   * Every value the app looked a tenant up by slug with. Lets a test assert
   * that a malformed payload was rejected *before* reaching the query layer,
   * rather than merely producing the same message on the way back out.
   */
  readonly slugLookups: unknown[] = [];

  table(name: string): Row[] {
    const t = (this as unknown as Record<string, Row[]>)[name];
    if (!Array.isArray(t)) throw new Error(`fake: unknown table "${name}"`);
    return t;
  }

  bookingsFor(customerId: string): Row[] {
    return this.bookings.filter((r) => r.customer_id === customerId);
  }

  noteScope(value: unknown): void {
    if (typeof value === "string") this.tenantScopes.push(value);
  }
}

type Filter = (row: Row) => boolean;

/**
 * A chainable PostgREST-shaped query builder over `FakeDatabase`.
 *
 * `eq`/`neq`/`gte` accumulate real predicates and the terminals apply them, so
 * a query scoped to the wrong tenant comes back empty exactly as it would from
 * the database. `select`, `order` and `returns` are shape-only, and the builder
 * is thenable because the production code awaits it directly (`await
 * supabase.from(…).select(…).eq(…).returns<T>()`).
 */
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
    return this as unknown as FakeQuery &
      PromiseLike<{ data: T; error: null }>;
  }

  eq(column: string, value: unknown): this {
    if (column === "customer_id") this.db.noteScope(value);
    if (this.tableName === "customers" && column === "slug") {
      this.db.slugLookups.push(value);
    }
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
    // Deliberately unpoliced: the real `bookings` table has no constraint
    // tying `customer_id` to anything about the request, so neither does this.
    this.db.noteScope(row.customer_id);
    this.pendingInsert = row;
    return this;
  }

  private rows(): Row[] {
    return this.db.table(this.tableName).filter((row) =>
      this.filters.every((f) => f(row)),
    );
  }

  private commitInsert(): Row {
    const stored: Row = {
      id: `${this.tableName}-${this.db.table(this.tableName).length + 1}`,
      ...this.pendingInsert,
    };
    this.db.table(this.tableName).push(stored);
    this.pendingInsert = null;
    return stored;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return { data: this.rows()[0] ?? null, error: null };
  }

  async single(): Promise<{ data: Row | null; error: null }> {
    if (this.pendingInsert) return { data: this.commitInsert(), error: null };
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
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      // `resolve_or_create_end_customer` — scoped by tenant, like the real one.
      db.noteScope(args.p_customer_id);
      const customerId = args.p_customer_id as string;
      const email = args.p_email as string;
      const existing = db.end_customers.find(
        (r) => r.customer_id === customerId && r.email === email,
      );
      if (existing) return { data: existing.id, error: null };
      const created = {
        id: `end-customer-${db.end_customers.length + 1}`,
        customer_id: customerId,
        email,
      };
      db.end_customers.push(created);
      return { data: created.id, error: null };
    },
  } as unknown as SupabaseClient;
}

let db: FakeDatabase;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDatabase();
  vi.mocked(createServiceRoleClient).mockReturnValue(fakeSupabase(db));
  // The chosen time is open, so the availability re-check is not what decides
  // these tests — tenant scoping is.
  vi.mocked(generateDaySlots).mockReturnValue([{ start: SLOT.start, end: SLOT.end }]);
});

/**
 * The payload a forged request carries: alpha's public slug (the page the
 * attacker is really on) plus beta's tenant id smuggled in a field the fixed
 * type does not declare. `serviceId` is beta's, because the pre-fix path scopes
 * the services lookup by the forged id — an attacker reads both values off
 * beta's own public booking page.
 */
function forgedPayload() {
  return {
    customerSlug: ALPHA.slug,
    customerId: BETA.id,
    serviceId: BETA.serviceId,
    slot: SLOT,
    guest: GUEST,
    customFields: {},
  };
}

describe("ALI-139 — the attack, in both directions", () => {
  // ── Direction 1: the vulnerability, reproduced ─────────────────────────────
  //
  // The pre-fix action was, in full:
  //
  //     export async function createBookingAction(input: CreateBookingInput) {
  //       const booking = await createBooking(input);   // ← wire payload, as-is
  //
  // so calling `createBooking` with the wire payload *is* the old code path.
  // This test is the reason the next one means anything.
  it("PRE-FIX: the forged payload writes a booking into the victim tenant", async () => {
    const forged = forgedPayload();

    const booking = await createBooking(forged as unknown as CreateBookingInput);

    // The row landed in beta — a tenant the request has no relationship with.
    expect(booking.customerId).toBe(BETA.id);
    expect(db.bookingsFor(BETA.id)).toHaveLength(1);
    expect(db.bookingsFor(ALPHA.id)).toHaveLength(0);

    // And the guest identity was written into beta's `end_customers` too.
    expect(db.end_customers).toHaveLength(1);
    expect(db.end_customers[0]!.customer_id).toBe(BETA.id);

    // Every scope the write path used was the attacker's chosen tenant.
    expect(new Set(db.tenantScopes)).toEqual(new Set([BETA.id]));
  });

  // ── Direction 2: the same payload, through the fixed boundary ──────────────
  it("POST-FIX: the identical payload cannot touch the victim tenant", async () => {
    const forged = forgedPayload();

    const result = await createBookingAction(
      forged as unknown as CreateBookingRequest,
    );

    // The smuggled id is ignored, so the tenant is alpha — and beta's service
    // id does not exist within alpha, which is where the request now dies.
    expect(result).toEqual({ ok: false, error: SERVICE_UNAVAILABLE });

    // Nothing was written anywhere…
    expect(db.bookings).toHaveLength(0);
    expect(db.end_customers).toHaveLength(0);

    // …and beta was never even queried: the victim's id reached no statement.
    expect(db.tenantScopes).not.toContain(BETA.id);
    expect(new Set(db.tenantScopes)).toEqual(new Set([ALPHA.id]));
  });

  // The same forgery with a service the attacker *can* legitimately book: the
  // booking succeeds, but it belongs to the tenant whose page it was made on.
  // A smuggled `customerId` does not redirect it — it is simply not read.
  it("POST-FIX: a smuggled customerId cannot redirect an otherwise valid booking", async () => {
    const forged = { ...forgedPayload(), serviceId: ALPHA.serviceId };

    const result = await createBookingAction(
      forged as unknown as CreateBookingRequest,
    );

    expect(result.ok).toBe(true);
    expect(db.bookingsFor(ALPHA.id)).toHaveLength(1);
    expect(db.bookingsFor(BETA.id)).toHaveLength(0);
    expect(db.bookings[0]!.customer_id).toBe(ALPHA.id);
    expect(db.end_customers[0]!.customer_id).toBe(ALPHA.id);
    expect(db.tenantScopes).not.toContain(BETA.id);
  });
});

describe("ALI-139 — tenant resolution fails closed", () => {
  it("refuses a slug that resolves to no tenant, writing nothing", async () => {
    const result = await createBookingAction({
      customerSlug: "no-such-tenant",
      serviceId: ALPHA.serviceId,
      slot: SLOT,
      guest: GUEST,
    });

    expect(result).toEqual({ ok: false, error: UNKNOWN_TENANT });
    expect(db.bookings).toHaveLength(0);
    expect(db.end_customers).toHaveLength(0);
    // The lookup did happen and came back empty — this path fails closed on a
    // real answer from the database, which is what distinguishes it from the
    // malformed-input cases below.
    expect(db.slugLookups).toEqual(["no-such-tenant"]);
  });

  it.each([
    ["a non-string slug", { customerSlug: { toString: () => ALPHA.slug } }],
    ["an empty slug", { customerSlug: "" }],
    ["a missing slug", {}],
  ])(
    "refuses %s before any query runs",
    async (_label, slugField) => {
      // Types are erased at runtime and this value came off the wire, so the
      // guard is what stands between a malformed payload and the query layer.
      const result = await createBookingAction({
        ...slugField,
        serviceId: ALPHA.serviceId,
        slot: SLOT,
        guest: GUEST,
      } as unknown as CreateBookingRequest);

      expect(result).toEqual({ ok: false, error: UNKNOWN_TENANT });
      expect(db.bookings).toHaveLength(0);
      expect(db.tenantScopes).toHaveLength(0);
      // Discriminating: without the guard the malformed value reaches the
      // `customers` query and this ledger is non-empty, even though the
      // user-visible result would be the same message either way.
      expect(db.slugLookups).toHaveLength(0);
    },
  );
});

describe("ALI-139 — the legitimate flow is unchanged (criterion 3)", () => {
  it("books through the slug the guest is actually on", async () => {
    const result = await createBookingAction({
      customerSlug: ALPHA.slug,
      serviceId: ALPHA.serviceId,
      slot: SLOT,
      guest: GUEST,
      customFields: { referral: "instagram" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bookingId).toEqual(expect.any(String));

    const [row] = db.bookingsFor(ALPHA.id);
    expect(row).toBeDefined();
    expect(row!.customer_id).toBe(ALPHA.id);
    expect(row!.service_id).toBe(ALPHA.serviceId);
    expect(row!.status).toBe("pending");
    // Per-vertical intake still rides along untouched.
    expect(row!.custom_fields).toEqual({ referral: "instagram" });
  });
});
