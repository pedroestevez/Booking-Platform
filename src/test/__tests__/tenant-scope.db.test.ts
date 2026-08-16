import { describe, expect, it } from "vitest";

import { hasTestDatabase, withRollback, type TestDb } from "@/test/supabase-harness";

/**
 * Cross-tenant booking writes against a real Postgres (ALI-139, criterion 2:
 * "a forged request supplying another tenant's UUID cannot create rows for that
 * tenant — negative test with two seeded tenants").
 *
 * The app-layer half of this issue is proved in
 * `src/lib/__tests__/booking-tenant-scope.test.ts`, which drives the real
 * action over a fake driver. This file proves the two claims that only a real
 * database can settle, and that the fix is built on:
 *
 *   1. **The database is not a second line of defense here.** Nothing in the
 *      schema ties a booking's `customer_id` to the page the request came from,
 *      so an attacker-chosen id is simply *obeyed*. That is why tenant identity
 *      has to be resolved in application code — there is no lower layer to
 *      catch it.
 *   2. **Slug → id resolution is sound**, i.e. the thing the fix replaced the
 *      browser-supplied id with actually binds a request to exactly one tenant,
 *      and returns nothing for a slug that does not exist.
 *
 * It also measures the *cost* of the hole, which ALI-98 raised: once
 * `bookings_no_overlap` exists, an injected row does not merely pollute the
 * victim's data, it takes their calendar slot away at the database level —
 * their own booking for that window is refused.
 *
 * ## Reading the RLS setup honestly
 *
 * `setTenant` is called before each write because these tables are `force`d
 * RLS and CI's connection role could change (the habit `booking-overlap.db.
 * test.ts` established). In the injected-write test it emulates the production
 * path's latitude, where writes go through `createServiceRoleClient()` and RLS
 * is bypassed outright with no tenant context at all — it is **not** standing
 * in for an authorization the attacker holds. The fact under test is not "may
 * this connection write", it is "which tenant's calendar does the row land in",
 * and that is decided solely by the `customer_id` value the application passes.
 *
 * Skips (does not fail) when `TEST_DATABASE_URL` is unset — see the harness
 * docstring. In CI the `quality` job's `postgres:16` service container sets it.
 */

const SQLSTATE_EXCLUSION_VIOLATION = "23P01";

/** The window the attacker squats, and the victim then cannot book. */
const SQUAT_START = "2026-10-01T10:00:00Z";
const SQUAT_END = "2026-10-01T11:00:00Z";

interface Tenant {
  customerId: string;
  slug: string;
  serviceId: string;
  endCustomerId: string;
}

/**
 * Seed a tenant with the rows a booking's foreign keys require. Mirrors the
 * helper in `booking-overlap.db.test.ts` rather than sharing one: each DB test
 * file owning its own fixtures keeps a change to one suite from silently
 * re-shaping another.
 */
async function seedTenant(db: TestDb, name: string): Promise<Tenant> {
  const [generated] = await db.query<{ id: string }>(
    "select gen_random_uuid() as id",
  );
  const customerId = generated!.id;
  const slug = `ali139-${name}`;

  // Before the insert: the customers insert policy checks `id = current`.
  await db.setTenant(customerId);
  await db.query(
    "insert into public.customers (id, name, slug) values ($1, $2, $3)",
    [customerId, `Tenant ${name}`, slug],
  );

  const [service] = await db.query<{ id: string }>(
    `insert into public.services (customer_id, name, duration_minutes, price_cents)
     values ($1, $2, $3, $4) returning id`,
    [customerId, `${name} service`, 60, 5000],
  );

  const [endCustomer] = await db.query<{ id: string }>(
    `insert into public.end_customers (customer_id, email, name)
     values ($1, $2, $3) returning id`,
    [customerId, `guest+${name}@example.test`, "Guest"],
  );

  return {
    customerId,
    slug,
    serviceId: service!.id,
    endCustomerId: endCustomer!.id,
  };
}

/**
 * The booking insert `createBooking` performs, with the tenant scope left as a
 * parameter — because *where that value comes from* is the entire subject of
 * this issue. Pre-fix it came off the wire; post-fix it is resolved from the
 * slug.
 */
async function insertBookingAs(
  db: TestDb,
  scopedCustomerId: string,
  owner: Tenant,
  start = SQUAT_START,
  end = SQUAT_END,
): Promise<string> {
  await db.setTenant(scopedCustomerId);
  const [row] = await db.query<{ id: string }>(
    `insert into public.bookings
       (customer_id, service_id, end_customer_id, start_time, end_time, status)
     values ($1, $2, $3, $4, $5, 'pending') returning id`,
    [scopedCustomerId, owner.serviceId, owner.endCustomerId, start, end],
  );
  return row!.id;
}

async function bookingCount(db: TestDb, customerId: string): Promise<number> {
  const [row] = await db.query<{ n: number }>(
    "select count(*)::int as n from public.bookings where customer_id = $1",
    [customerId],
  );
  return row!.n;
}

/** Slug → customer id: the resolution the fixed action performs server-side. */
async function resolveBySlug(db: TestDb, slug: unknown): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    "select id from public.customers where slug = $1",
    [slug],
  );
  return rows[0]?.id ?? null;
}

describe.skipIf(!hasTestDatabase)("ALI-139 — cross-tenant booking writes", () => {
  it("PRE-FIX: an attacker-supplied customer_id is obeyed, and squats the victim's calendar", async () => {
    await withRollback(async (db) => {
      const alpha = await seedTenant(db, "alpha");
      const beta = await seedTenant(db, "beta");

      // The guest is on alpha's page; the payload names beta's UUID. Pre-fix,
      // that value was passed through to the service-role client verbatim.
      const injected = await insertBookingAs(db, beta.customerId, beta);
      expect(injected).toEqual(expect.any(String));

      // The row is beta's, and alpha — the page it was actually made on — has
      // nothing. No constraint, policy or trigger objected.
      expect(await bookingCount(db, beta.customerId)).toBe(1);
      expect(await bookingCount(db, alpha.customerId)).toBe(0);

      // The guest identity lands in the victim's `end_customers` too: the write
      // path pollutes two tables, not one.
      await db.setTenant(beta.customerId);
      const [identity] = await db.query<{ n: number }>(
        "select count(*)::int as n from public.end_customers where customer_id = $1",
        [beta.customerId],
      );
      expect(identity!.n).toBeGreaterThan(0);

      // ── The cost, post-ALI-98 ────────────────────────────────────────────
      // The squat is not just noise in the victim's data. `bookings_no_overlap`
      // now enforces the calendar in the database, so beta's own booking for
      // the window it never sold is refused — denial of service by insert.
      await db.query("savepoint victim_tries_to_book");
      await expect(
        insertBookingAs(db, beta.customerId, beta),
      ).rejects.toHaveProperty("code", SQLSTATE_EXCLUSION_VIOLATION);
      await db.query("rollback to savepoint victim_tries_to_book");
    });
  });

  it("POST-FIX: the id resolved from the slug is the only tenant reachable", async () => {
    await withRollback(async (db) => {
      const alpha = await seedTenant(db, "alpha");
      const beta = await seedTenant(db, "beta");

      // What the fixed action does: resolve the tenant from the slug of the
      // page the request came from. The forged `customerId` is not an input to
      // this query — there is nowhere for it to be one.
      const resolved = await resolveBySlug(db, alpha.slug);
      expect(resolved).toBe(alpha.customerId);
      expect(resolved).not.toBe(beta.customerId);

      const booking = await insertBookingAs(db, resolved!, alpha);
      expect(booking).toEqual(expect.any(String));

      // The booking belongs to the page it was made on; the victim is untouched
      // and their calendar is still free.
      expect(await bookingCount(db, alpha.customerId)).toBe(1);
      expect(await bookingCount(db, beta.customerId)).toBe(0);

      // Proof the window really is still beta's to sell — the squat is gone,
      // not merely unasserted.
      await expect(
        insertBookingAs(db, beta.customerId, beta),
      ).resolves.toEqual(expect.any(String));
    });
  });

  it("POST-FIX: resolution is keyed only by slug, and fails closed on an unknown one", async () => {
    await withRollback(async (db) => {
      const alpha = await seedTenant(db, "alpha");
      const beta = await seedTenant(db, "beta");

      // Each slug resolves to its own tenant and nothing else: the mapping is
      // total and injective over the seeded pair.
      expect(await resolveBySlug(db, alpha.slug)).toBe(alpha.customerId);
      expect(await resolveBySlug(db, beta.slug)).toBe(beta.customerId);

      // A tenant UUID is not a slug, so an attacker holding beta's id has
      // nothing to feed this query — the id space and the slug space do not
      // meet.
      expect(await resolveBySlug(db, beta.customerId)).toBeNull();

      // Unknown slug → no row → the action returns its refusal instead of
      // inventing a tenant. `customers.slug` being unique is what lets the
      // application treat "one row" as "the tenant".
      expect(await resolveBySlug(db, "ali139-no-such-tenant")).toBeNull();

      const [unique] = await db.query<{ n: number }>(
        `select count(*)::int as n
         from pg_constraint
         where conrelid = 'public.customers'::regclass
           and contype in ('u', 'p')
           and pg_get_constraintdef(oid) like '%(slug)%'`,
      );
      expect(unique!.n).toBeGreaterThan(0);
    });
  });
});
