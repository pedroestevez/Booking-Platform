import { describe, expect, it } from "vitest";

import { initialBookingStatus } from "@/lib/bookings";
import { SLOT_FREEING_STATUS } from "@/lib/tenants";
import { hasTestDatabase, withRollback, type TestDb } from "@/test/supabase-harness";

/**
 * The status a **free** booking is inserted with still occupies its slot
 * (ALI-176 criterion 4, negative case).
 *
 * Criterion 4 changes which live status a free booking carries — `confirmed`
 * instead of `pending`. The invariant it must not break: the set of statuses
 * that free a slot in application code is identical to the set
 * `bookings_no_overlap` (migration 0006) exempts. If `confirmed` freed a slot on
 * one side and occupied it on the other, the free flow would either offer ghost
 * slots the database then refuses at submit time, or silently double-book Pedro.
 *
 * ## What is derived and what is asserted
 *
 * Nothing here restates a predicate. Every set is measured against the live
 * schema in the same transaction:
 *
 *   • the status **domain** comes from 0001's CHECK, read out of `pg_constraint`;
 *   • the **constraint's** verdict on the free status comes from attempting an
 *     overlapping insert and observing whether Postgres raises 23P01;
 *   • **availability's** verdict comes from executing its own filter —
 *     `status <> SLOT_FREEING_STATUS`, with the constant imported from
 *     `src/lib/tenants.ts`, not retyped — against the same rows.
 *
 * The full set-equality across all four statuses is asserted by ALI-98's
 * criterion 8 in `booking-overlap.db.test.ts`. This file asserts the narrower,
 * change-specific claim: whatever `initialBookingStatus` returns for a free
 * service is a member of both sets, so ALI-176 cannot be the change that pulls
 * them apart.
 *
 * Skips (does not fail) without `TEST_DATABASE_URL` — see the harness docstring.
 * CI's `postgres:16` service container sets it, so this runs for real there.
 */

const SQLSTATE_EXCLUSION_VIOLATION = "23P01";

/** The status a free (`price_cents = 0`) service books at, from the app itself. */
const FREE_SERVICE_STATUS = initialBookingStatus(0);

/** The status a paid service books at, for contrast. */
const PAID_SERVICE_STATUS = initialBookingStatus(5000);

interface Fixture {
  customerId: string;
  serviceId: string;
  endCustomerId: string;
}

/**
 * A tenant with the rows `bookings`' foreign keys require. Deliberately local
 * rather than shared with `booking-overlap.db.test.ts`: that file's fixtures
 * belong to ALI-98's criteria, and a shared helper would couple two suites that
 * assert different things about the same table.
 *
 * `setTenant` before every write because 0002 `force`s RLS — CI happens to
 * connect as a superuser, and a test that leaned on that would quietly stop
 * working the day the role changes.
 */
async function seedTenant(db: TestDb, label: string): Promise<Fixture> {
  const [generated] = await db.query<{ id: string }>(
    "select gen_random_uuid() as id",
  );
  const customerId = generated!.id;
  await db.setTenant(customerId);

  await db.query(
    "insert into public.customers (id, name, slug) values ($1, $2, $3)",
    [customerId, `Free Service Fixture ${label}`, `ali176-${label}`],
  );

  // A genuinely free service, which is the case under test.
  const [service] = await db.query<{ id: string }>(
    `insert into public.services (customer_id, name, duration_minutes, price_cents)
     values ($1, $2, $3, $4) returning id`,
    [customerId, "Interview — 30 min", 30, 0],
  );

  const [endCustomer] = await db.query<{ id: string }>(
    `insert into public.end_customers (customer_id, email, name)
     values ($1, $2, $3) returning id`,
    [customerId, `guest+${label}@example.test`, "Guest"],
  );

  return {
    customerId,
    serviceId: service!.id,
    endCustomerId: endCustomer!.id,
  };
}

async function insertBooking(
  db: TestDb,
  fixture: Fixture,
  start: string,
  end: string,
  status: string,
): Promise<void> {
  await db.setTenant(fixture.customerId);
  await db.query(
    `insert into public.bookings
       (customer_id, service_id, end_customer_id, start_time, end_time, status)
     values ($1, $2, $3, $4, $5, $6)`,
    [fixture.customerId, fixture.serviceId, fixture.endCustomerId, start, end, status],
  );
}

describe.skipIf(!hasTestDatabase)("a free service's booking status", () => {
  it("is a status the live schema allows", async () => {
    await withRollback(async (db) => {
      const checks = await db.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def
         from pg_constraint
         where conrelid = 'public.bookings'::regclass and contype = 'c'`,
      );
      const statusCheck = checks
        .map((c) => c.def)
        .find((def) => def.includes("status"));
      expect(statusCheck).toBeDefined();

      const domain = [...statusCheck!.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);

      // A status the CHECK forbids would fail every insert at runtime — the app
      // would appear to work in unit tests and reject every real free booking.
      expect(domain).toContain(FREE_SERVICE_STATUS);
      expect(domain).toContain(PAID_SERVICE_STATUS);
      // And it must not be the status that frees a slot.
      expect(FREE_SERVICE_STATUS).not.toBe(SLOT_FREEING_STATUS);
    });
  });

  it("occupies its slot for `bookings_no_overlap`", async () => {
    await withRollback(async (db) => {
      const fixture = await seedTenant(db, "constraint");
      await insertBooking(
        db,
        fixture,
        "2026-09-10T10:00:00Z",
        "2026-09-10T10:30:00Z",
        FREE_SERVICE_STATUS,
      );

      // Back-to-back is legal — `[)` bounds — so the overlap has to be real for
      // this assertion to be about occupancy rather than about adjacency.
      await insertBooking(
        db,
        fixture,
        "2026-09-10T10:30:00Z",
        "2026-09-10T11:00:00Z",
        FREE_SERVICE_STATUS,
      );

      // The failing statement goes last: it aborts the transaction in Postgres.
      await expect(
        insertBooking(
          db,
          fixture,
          "2026-09-10T10:15:00Z",
          "2026-09-10T10:45:00Z",
          PAID_SERVICE_STATUS,
        ),
      ).rejects.toHaveProperty("code", SQLSTATE_EXCLUSION_VIOLATION);
    });
  });

  it("occupies its slot for availability's own filter", async () => {
    await withRollback(async (db) => {
      const fixture = await seedTenant(db, "availability");
      await insertBooking(
        db,
        fixture,
        "2026-09-11T10:00:00Z",
        "2026-09-11T10:30:00Z",
        FREE_SERVICE_STATUS,
      );
      // A cancelled booking, as the control: the filter must drop this one, or
      // "the filter selects the free status" would prove nothing.
      await insertBooking(
        db,
        fixture,
        "2026-09-11T11:00:00Z",
        "2026-09-11T11:30:00Z",
        SLOT_FREEING_STATUS,
      );

      // `getUpcomingBookings`' predicate, built from the constant it uses. The
      // real function reaches the table through PostgREST, which the hermetic
      // container does not run, so only the SQL shape around the imported value
      // is restated — and it is executed against the live table.
      const occupied = await db.query<{ status: string }>(
        `select status from public.bookings
          where customer_id = $1 and status <> $2
          order by start_time`,
        [fixture.customerId, SLOT_FREEING_STATUS],
      );

      expect(occupied.map((r) => r.status)).toEqual([FREE_SERVICE_STATUS]);
    });
  });
});
