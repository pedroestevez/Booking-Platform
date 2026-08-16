import { describe, expect, it } from "vitest";

import { hasTestDatabase, withRollback, type TestDb } from "@/test/supabase-harness";

/**
 * `bookings_no_overlap` against a real Postgres (ALI-98, criteria 1–4 and 7).
 *
 * These are pure-Postgres assertions: the guarantee under test is a schema
 * object, so it is tested by talking to the schema, not through the app. Every
 * test runs inside `withRollback`, so the database is untouched afterwards.
 *
 * ## Two habits these tests keep deliberately
 *
 * **`setTenant` before every write.** RLS is `force`d on these tables, so a
 * non-superuser connection is subject to it. CI happens to connect as
 * `postgres` (a superuser, which bypasses RLS entirely), and a test written to
 * lean on that would quietly stop working the day the connection role changes.
 * Setting the tenant context makes each test correct either way — and IDs are
 * generated client-side so the `customers` insert policy (`id =
 * app.current_customer_id()`) can be satisfied before the row exists.
 *
 * **Failing statements go last.** A statement that errors aborts its
 * transaction in Postgres; nothing after it can run. So where a criterion pairs
 * "this succeeds" with "this is rejected", the success is asserted first and
 * the rejection closes the transaction — except in criterion 7, where the
 * assertion is explicitly *about* what survives the abort and therefore needs a
 * second transaction.
 *
 * Skips (does not fail) when `TEST_DATABASE_URL` is unset — see the harness
 * docstring. In CI the `quality` job's `postgres:16` service container sets it,
 * so these run for real.
 */

const SQLSTATE_EXCLUSION_VIOLATION = "23P01";

/** The constraint's own definition, re-stated so criterion 7 can re-add it. */
const ADD_CONSTRAINT_SQL = `
  alter table public.bookings
    add constraint bookings_no_overlap
    exclude using gist (
      customer_id with =,
      tstzrange(start_time, end_time) with &&
    ) where (status <> 'cancelled')
`;

interface Tenant {
  customerId: string;
  serviceId: string;
  endCustomerId: string;
}

/**
 * Create a tenant with the rows `bookings`' foreign keys require: a customer, a
 * service, and an end-customer (`end_customer_id` has been `not null` since
 * 0003). Leaves the tenant context set to the new customer.
 */
async function seedTenant(db: TestDb, slug: string): Promise<Tenant> {
  const [generated] = await db.query<{ id: string }>(
    "select gen_random_uuid() as id",
  );
  const customerId = generated!.id;

  // Before the insert: the customers insert policy checks `id = current`.
  await db.setTenant(customerId);

  await db.query(
    "insert into public.customers (id, name, slug) values ($1, $2, $3)",
    [customerId, `Overlap Fixture ${slug}`, `ali98-${slug}`],
  );

  const [service] = await db.query<{ id: string }>(
    `insert into public.services (customer_id, name, duration_minutes, price_cents)
     values ($1, $2, $3, $4) returning id`,
    [customerId, "Consultation", 60, 5000],
  );

  const [endCustomer] = await db.query<{ id: string }>(
    `insert into public.end_customers (customer_id, email, name)
     values ($1, $2, $3) returning id`,
    [customerId, `guest+${slug}@example.test`, "Guest"],
  );

  return {
    customerId,
    serviceId: service!.id,
    endCustomerId: endCustomer!.id,
  };
}

async function insertBooking(
  db: TestDb,
  tenant: Tenant,
  start: string,
  end: string,
  status: "pending" | "confirmed" | "cancelled" = "pending",
): Promise<string> {
  await db.setTenant(tenant.customerId);
  const [row] = await db.query<{ id: string }>(
    `insert into public.bookings
       (customer_id, service_id, end_customer_id, start_time, end_time, status)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      tenant.customerId,
      tenant.serviceId,
      tenant.endCustomerId,
      start,
      end,
      status,
    ],
  );
  return row!.id;
}

/** Assert a promise rejects with a specific Postgres SQLSTATE. */
async function expectSqlState(
  promise: Promise<unknown>,
  sqlstate: string,
): Promise<void> {
  await expect(promise).rejects.toHaveProperty("code", sqlstate);
}

describe.skipIf(!hasTestDatabase)("bookings_no_overlap", () => {
  // ── Criterion 1 ────────────────────────────────────────────────────────────
  it("exists as an exclusion constraint, with btree_gist installed", async () => {
    await withRollback(async (db) => {
      const extension = await db.query(
        "select 1 as present from pg_extension where extname = 'btree_gist'",
      );
      expect(extension).toHaveLength(1);

      const constraint = await db.query<{ contype: string; relname: string }>(
        `select contype, conrelid::regclass::text as relname
         from pg_constraint where conname = 'bookings_no_overlap'`,
      );
      expect(constraint).toHaveLength(1);
      // 'x' = exclusion. A unique or check constraint would not close the race.
      expect(constraint[0]?.contype).toBe("x");
      expect(constraint[0]?.relname).toBe("bookings");
    });
  });

  // ── Criterion 2 ────────────────────────────────────────────────────────────
  it("rejects a same-tenant overlap but allows back-to-back bookings", async () => {
    await withRollback(async (db) => {
      const tenant = await seedTenant(db, "same-tenant");

      await insertBooking(
        db,
        tenant,
        "2026-09-01T10:00:00Z",
        "2026-09-01T11:00:00Z",
      );

      // `[)` half-open bounds: starting exactly when the previous booking ends
      // is not an overlap. Asserted before the failing insert, which would
      // abort the transaction. If this were rejected, every consecutive
      // appointment in a working day would be unbookable.
      await expect(
        insertBooking(
          db,
          tenant,
          "2026-09-01T11:00:00Z",
          "2026-09-01T12:00:00Z",
        ),
      ).resolves.toEqual(expect.any(String));

      // The race, made deterministic: a genuinely overlapping window.
      await expectSqlState(
        insertBooking(
          db,
          tenant,
          "2026-09-01T10:30:00Z",
          "2026-09-01T11:30:00Z",
        ),
        SQLSTATE_EXCLUSION_VIOLATION,
      );
    });
  });

  // ── Criterion 3 ────────────────────────────────────────────────────────────
  it("does not leak across tenants: identical windows for two customers both succeed", async () => {
    await withRollback(async (db) => {
      const alpha = await seedTenant(db, "cross-alpha");
      const beta = await seedTenant(db, "cross-beta");

      const start = "2026-09-02T09:00:00Z";
      const end = "2026-09-02T10:00:00Z";

      await insertBooking(db, alpha, start, end);
      // Same instant, different tenant. An EXCLUDE that omitted
      // `customer_id with =` would block every tenant's calendar against every
      // other tenant's — a silent, total cross-tenant outage.
      await insertBooking(db, beta, start, end);

      await db.setTenant(alpha.customerId);
      const alphaRows = await db.query(
        "select id from public.bookings where customer_id = $1",
        [alpha.customerId],
      );
      expect(alphaRows).toHaveLength(1);

      await db.setTenant(beta.customerId);
      const betaRows = await db.query(
        "select id from public.bookings where customer_id = $1",
        [beta.customerId],
      );
      expect(betaRows).toHaveLength(1);
    });
  });

  // ── Criterion 4 ────────────────────────────────────────────────────────────
  it("exempts cancelled bookings, and only cancelled ones", async () => {
    await withRollback(async (db) => {
      const tenant = await seedTenant(db, "cancelled-exempt");

      const start = "2026-09-03T14:00:00Z";
      const end = "2026-09-03T15:00:00Z";

      const cancelled = await insertBooking(db, tenant, start, end, "confirmed");
      await db.setTenant(tenant.customerId);
      await db.query(
        "update public.bookings set status = 'cancelled' where id = $1",
        [cancelled],
      );

      // A cancelled booking releases its slot; the window must be bookable
      // again, or every cancellation would permanently burn a slot.
      const replacement = await insertBooking(
        db,
        tenant,
        start,
        end,
        "confirmed",
      );
      expect(replacement).toEqual(expect.any(String));

      // …and the exemption stops there. A predicate like `status = 'pending'`
      // would exempt confirmed bookings and reopen the bug wholesale, so a
      // pending booking overlapping a confirmed one must still be rejected.
      await expectSqlState(
        insertBooking(
          db,
          tenant,
          "2026-09-03T14:30:00Z",
          "2026-09-03T15:30:00Z",
          "pending",
        ),
        SQLSTATE_EXCLUSION_VIOLATION,
      );
    });
  });

  // ── Criterion 7 ────────────────────────────────────────────────────────────
  // Two transactions, because part (a) deliberately aborts its own.
  it("fails atomically when applied to a table that already holds overlaps", async () => {
    // Captured in (a), asserted in (b). The rows are addressed by tenant so (b)
    // can scope its read under RLS rather than relying on a superuser.
    let dirtyCustomerId = "";

    // (a) Simulate applying 0006 to dirty data: drop the constraint, create the
    // overlap the production database is only *believed* not to have, and
    // re-add it. `ALTER TABLE … ADD CONSTRAINT` validates existing rows.
    await withRollback(async (db) => {
      const tenant = await seedTenant(db, "dirty-data");
      dirtyCustomerId = tenant.customerId;

      await db.query(
        "alter table public.bookings drop constraint bookings_no_overlap",
      );

      await insertBooking(
        db,
        tenant,
        "2026-09-04T09:00:00Z",
        "2026-09-04T10:00:00Z",
        "confirmed",
      );
      await insertBooking(
        db,
        tenant,
        "2026-09-04T09:30:00Z",
        "2026-09-04T10:30:00Z",
        "confirmed",
      );

      await expectSqlState(
        db.query(ADD_CONSTRAINT_SQL),
        SQLSTATE_EXCLUSION_VIOLATION,
      );
    });

    // (b) The failed ALTER left no partial state: the schema is as it was, and
    // the rows that provoked it are gone with the rollback. This is why the
    // production apply needs no bespoke rollback plan — only the pre-apply
    // detection query in 0006's header, to find the hits before they abort it.
    await withRollback(async (db) => {
      const constraint = await db.query<{ contype: string }>(
        "select contype from pg_constraint where conname = 'bookings_no_overlap'",
      );
      expect(constraint).toHaveLength(1);
      expect(constraint[0]?.contype).toBe("x");

      await db.setTenant(dirtyCustomerId);
      const leftovers = await db.query(
        "select id from public.bookings where customer_id = $1",
        [dirtyCustomerId],
      );
      expect(leftovers).toHaveLength(0);
    });
  });
});
