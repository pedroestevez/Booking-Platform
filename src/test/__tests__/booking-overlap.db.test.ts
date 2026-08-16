import { describe, expect, it } from "vitest";

import { SLOT_FREEING_STATUS } from "@/lib/tenants";
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

/**
 * The pre-apply overlap-detection query, verbatim from 0006's header comment.
 *
 * Copied rather than imported because the header is a SQL comment — which is
 * exactly why it needs a test. An operator runs this against production and
 * reads "zero rows" as "safe to apply". A query that can never return rows
 * would give that same answer on a database full of overlaps.
 */
const DETECTION_QUERY = `
  select a.id as a_id, b.id as b_id, a.customer_id, a.start_time, a.end_time
  from public.bookings a
  join public.bookings b
    on a.customer_id = b.customer_id
   and a.id < b.id
   and a.status <> 'cancelled'
   and b.status <> 'cancelled'
   and tstzrange(a.start_time, a.end_time) && tstzrange(b.start_time, b.end_time)
`;

/**
 * Every value `bookings.status` may hold, per 0001's CHECK. Sorted.
 *
 * Criterion 8 asserts the live schema still matches this list. A fifth status
 * added without updating both the constraint predicate and the availability
 * filter is precisely how ghost slots come back, so it must fail loudly here
 * rather than be inferred at runtime.
 */
const KNOWN_BOOKING_STATUSES = [
  "cancelled",
  "completed",
  "confirmed",
  "pending",
] as const;

type BookingStatus = (typeof KNOWN_BOOKING_STATUSES)[number];

/**
 * The filter `getUpcomingBookings` (`src/lib/tenants.ts`) applies when deciding
 * which bookings occupy a slot.
 *
 * The exempt status is **imported from the module under test**, not retyped, so
 * changing it there changes it here and this test moves with it. Only the SQL
 * shape around it is restated — the real function reaches the table through
 * PostgREST, which the hermetic container does not run. The predicate is then
 * *executed* against the live table below, so the occupied-set is measured
 * against the same schema the blocked-set is measured against.
 */
const AVAILABILITY_OCCUPIED_PREDICATE = `status <> '${SLOT_FREEING_STATUS}'`;

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
  status: BookingStatus = "pending",
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

/** Rows in `pg_constraint` for `bookings_no_overlap` on `public.bookings`. */
async function constraintRows(db: TestDb) {
  return db.query<{ contype: string }>(
    `select contype from pg_constraint
     where conname = 'bookings_no_overlap'
       and conrelid = 'public.bookings'::regclass`,
  );
}

/**
 * Assert no trace of the constraint remains — neither the catalog entry nor the
 * GiST index relation `ADD CONSTRAINT ... EXCLUDE` builds to back it. An apply
 * that half-unwound would leave the second behind.
 */
async function expectNoConstraintArtifacts(db: TestDb): Promise<void> {
  expect(await constraintRows(db)).toHaveLength(0);
  const relations = await db.query(
    "select relname from pg_class where relname = 'bookings_no_overlap'",
  );
  expect(relations).toHaveLength(0);
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
  //
  // One transaction, with a savepoint. The earlier two-transaction form was
  // circular: its second transaction asserted "constraint present, dirty rows
  // gone", which is true of the *committed* state whether the ALTER failed or
  // succeeded — it passed either way and so discriminated nothing. A savepoint
  // both recovers the aborted transaction and lets the aftermath be observed
  // where it is actually visible: inside the transaction that produced it.
  it("fails atomically when applied to a table that already holds overlaps", async () => {
    await withRollback(async (db) => {
      const tenant = await seedTenant(db, "dirty-data");

      // Start from a table without the constraint, so the ALTER below is the
      // real event being modelled: a first application of 0006 against data
      // that is already dirty.
      await db.query(
        "alter table public.bookings drop constraint bookings_no_overlap",
      );
      await expectNoConstraintArtifacts(db);

      await db.query("savepoint before_apply");

      // The overlap production is only *believed* not to have.
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

      // The discriminating assertion: `ADD CONSTRAINT` validates existing rows
      // and must refuse. If a constraint could be created over overlapping
      // data, the whole guarantee is void and this test fails right here.
      await expectSqlState(
        db.query(ADD_CONSTRAINT_SQL),
        SQLSTATE_EXCLUSION_VIOLATION,
      );

      // The failed statement aborted the transaction; the savepoint is what
      // makes it recoverable.
      await db.query("rollback to savepoint before_apply");
      await db.setTenant(tenant.customerId);

      // No partial state: no catalog entry, and no orphaned GiST index.
      await expectNoConstraintArtifacts(db);

      // The transaction is usable again rather than poisoned, and the rows that
      // provoked the failure went with the savepoint.
      const remaining = await db.query<{ n: number }>(
        "select count(*)::int as n from public.bookings where customer_id = $1",
        [tenant.customerId],
      );
      expect(remaining[0]?.n).toBe(0);

      // And the table is genuinely restorable, not wedged: with the overlap
      // gone the very same ALTER now succeeds. This is what makes "rollback is
      // a no-op" a claim about the schema rather than about the catalog query.
      await db.query(ADD_CONSTRAINT_SQL);
      const restored = await constraintRows(db);
      expect(restored).toHaveLength(1);
      expect(restored[0]?.contype).toBe("x");
    });
  });

  // ── Criterion 8 ────────────────────────────────────────────────────────────
  it("availability's occupied-set equals the constraint's blocked-set", async () => {
    await withRollback(async (db) => {
      // (a) The status domain, read from 0001's CHECK rather than assumed. A
      // fifth status must fail here, forcing a decision about both sets.
      const checks = await db.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def
         from pg_constraint
         where conrelid = 'public.bookings'::regclass and contype = 'c'`,
      );
      const statusCheck = checks
        .map((c) => c.def)
        .find((def) => def.includes("status"));
      expect(statusCheck).toBeDefined();

      const domain = [...statusCheck!.matchAll(/'([a-z_]+)'::text/g)]
        .map((m) => m[1]!)
        .sort();
      expect(domain).toEqual([...KNOWN_BOOKING_STATUSES]);

      // (b) The constraint's blocked-set, derived by probing the live
      // constraint once per status against an existing confirmed booking —
      // not by re-reading its predicate.
      const anchor = await seedTenant(db, "sets-anchor");
      await insertBooking(
        db,
        anchor,
        "2026-09-05T09:00:00Z",
        "2026-09-05T10:00:00Z",
        "confirmed",
      );

      const blocked: string[] = [];
      for (const status of domain) {
        await db.query("savepoint probe");
        try {
          await insertBooking(
            db,
            anchor,
            "2026-09-05T09:30:00Z",
            "2026-09-05T10:30:00Z",
            status as BookingStatus,
          );
        } catch (err) {
          expect(err).toHaveProperty("code", SQLSTATE_EXCLUSION_VIOLATION);
          blocked.push(status);
        }
        await db.query("rollback to savepoint probe");
      }

      // (c) Availability's occupied-set, derived by running its filter against
      // one booking of every status.
      const grid = await seedTenant(db, "sets-grid");
      let hour = 9;
      for (const status of domain) {
        await insertBooking(
          db,
          grid,
          `2026-09-06T${String(hour).padStart(2, "0")}:00:00Z`,
          `2026-09-06T${String(hour + 1).padStart(2, "0")}:00:00Z`,
          status as BookingStatus,
        );
        hour += 1;
      }

      const occupiedRows = await db.query<{ status: string }>(
        `select status from public.bookings
         where customer_id = $1 and ${AVAILABILITY_OCCUPIED_PREDICATE}`,
        [grid.customerId],
      );
      const occupied = occupiedRows.map((r) => r.status).sort();

      // The point of the whole criterion. Narrower availability = ghost slots
      // the guest can pick and the database then rejects; wider = real
      // availability silently vanishing.
      expect(occupied).toEqual(blocked);
      expect(blocked).toEqual(["completed", "confirmed", "pending"]);
    });
  });

  // ── The detection query in 0006's header actually detects ──────────────────
  it("the pre-apply detection query surfaces a known-dirty overlap", async () => {
    await withRollback(async (db) => {
      const tenant = await seedTenant(db, "detection");
      // Scope assertions to this test's tenant. The detection query is run
      // verbatim (no tenant filter — that is the query an operator pastes into
      // production), so anything else in the database is filtered out here
      // rather than by editing the SQL under test.
      const mine = <T extends { customer_id: string }>(rows: T[]): T[] =>
        rows.filter((r) => r.customer_id === tenant.customerId);

      await db.query(
        "alter table public.bookings drop constraint bookings_no_overlap",
      );

      // Clean baseline: the query is quiet when there is nothing to find.
      const clean = await db.query<{ customer_id: string }>(DETECTION_QUERY);
      expect(mine(clean)).toHaveLength(0);

      const first = await insertBooking(
        db,
        tenant,
        "2026-09-07T09:00:00Z",
        "2026-09-07T10:00:00Z",
        "confirmed",
      );
      const second = await insertBooking(
        db,
        tenant,
        "2026-09-07T09:30:00Z",
        "2026-09-07T10:30:00Z",
        "confirmed",
      );

      // The assertion that matters: on genuinely dirty data the query must
      // speak up. A query that always returns zero rows — because of a typo,
      // or because RLS is hiding everything from the reading role — reads as
      // "safe to apply" and walks the operator into a failed ALTER.
      const hits = await db.query<{
        a_id: string;
        b_id: string;
        customer_id: string;
      }>(DETECTION_QUERY);
      const ours = mine(hits);
      expect(ours).toHaveLength(1);
      expect([ours[0]!.a_id, ours[0]!.b_id].sort()).toEqual(
        [first, second].sort(),
      );

      // And it must not cry wolf: back-to-back bookings are legal, and
      // cancelled rows are exempt. Either false positive would send an
      // operator hand-editing production rows that were never a problem.
      await db.query("savepoint quiet_cases");
      await db.query(
        "update public.bookings set status = 'cancelled' where id = $1",
        [second],
      );
      expect(
        mine(await db.query<{ customer_id: string }>(DETECTION_QUERY)),
      ).toHaveLength(0);
      await db.query("rollback to savepoint quiet_cases");

      await db.query("savepoint back_to_back");
      await db.query("delete from public.bookings where id = $1", [second]);
      await insertBooking(
        db,
        tenant,
        "2026-09-07T10:00:00Z",
        "2026-09-07T11:00:00Z",
        "confirmed",
      );
      expect(
        mine(await db.query<{ customer_id: string }>(DETECTION_QUERY)),
      ).toHaveLength(0);
      await db.query("rollback to savepoint back_to_back");
    });
  });
});
