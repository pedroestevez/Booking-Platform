import { describe, expect, it } from "vitest";

import {
  hasTestDatabase,
  withRollback,
  type TestDb,
} from "@/test/supabase-harness";

/**
 * Tenant isolation, proved through the reader production actually uses
 * (ALI-116; extends ALI-99's scope to all seven tables).
 *
 * ## What makes this suite different from an ordinary isolation test
 *
 * Every tenant-scoped query in the app carries `.eq("customer_id", …)`. An
 * isolation test written the ordinary way therefore **passes with RLS
 * completely inert** — it measures the filter, not the policy. So every
 * assertion here is issued with *no* `customer_id` predicate in the SQL at all.
 * If a row comes back, a policy let it.
 *
 * ## Three controls, because a zero-row result has three explanations
 *
 * "Zero rows" can mean the policy worked, or that the connection could not see
 * anything anyway, or that nothing was ever there. Each is closed explicitly:
 *
 *   1. **Not bypassing RLS** — `assertNotBypassingRls()` fails the test if the
 *      current role is `SUPERUSER` or `BYPASSRLS`, either of which ignores
 *      policies even under `FORCE`. CI's default connection role is exactly
 *      that, which is why `becomeRequestRole()` runs first.
 *   2. **The reader is present** — `expectClaimIsRead` asserts
 *      `app.current_customer_id()` returns the claim's value before any
 *      isolation assertion. Without it, a database where nothing reads the
 *      claim returns zero rows for *every* tenant and the suite is green while
 *      proving nothing. That is the ALI-150 defect, and the vault note
 *      "A positive control must cover the reader, not the data" is its writeup.
 *   3. **The data exists** — each table's fixture inserts one row for A and one
 *      for B, and the B row is re-read under B's own claim.
 *
 * ## Why `request.jwt.claims` and not the GUC
 *
 * That GUC is what PostgREST sets from the verified bearer token before running
 * the request's transaction, so driving it here exercises the same leg of
 * `app.current_customer_id()` that a real request does (migration 0009). The
 * older `app.current_customer_id` GUC still works and still takes precedence,
 * but nothing on the request path sets it — testing only that leg would test a
 * path the app never takes.
 *
 * Skips (does not fail) when `TEST_DATABASE_URL` is unset. In CI the `quality`
 * job's `postgres:16` service container sets it.
 */

const TENANT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

/** Every table whose rows belong to exactly one tenant. */
const TENANT_SCOPED_TABLES = [
  "customers",
  "services",
  "availability_rules",
  "bookings",
  "blocked_slots",
  "end_customers",
  "tenant_members",
] as const;

type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];

/** The column that identifies the row itself, for `customers` its own id. */
const identityColumn = (table: TenantScopedTable): string =>
  table === "customers" ? "id" : "customer_id";

/**
 * Seed one row per tenant in every tenant-scoped table.
 *
 * Written as the connection's own (RLS-exempt) role, before `becomeRequestRole`
 * switches away from it — the fixture is arrangement, not the thing under test,
 * and it needs to be able to write B's rows precisely so the test can prove A
 * cannot see them.
 */
async function seedTwoTenants(db: TestDb): Promise<void> {
  for (const [id, slug] of [
    [TENANT_A, "rls-tenant-a"],
    [TENANT_B, "rls-tenant-b"],
  ]) {
    await db.query("insert into customers (id, name, slug) values ($1, $2, $3)", [
      id,
      `RLS ${slug}`,
      slug,
    ]);
    await db.query(
      `insert into services (id, customer_id, name, duration_minutes, price_cents)
       values (gen_random_uuid(), $1, 'Consultation', 30, 5000)`,
      [id],
    );
    await db.query(
      `insert into availability_rules (customer_id, day_of_week, start_time, end_time)
       values ($1, 1, '09:00', '17:00')`,
      [id],
    );
    await db.query(
      `insert into blocked_slots (customer_id, start_time, end_time, reason)
       values ($1, now() + interval '1 day', now() + interval '1 day 1 hour', 'lunch')`,
      [id],
    );
    await db.query(
      `insert into end_customers (customer_id, email, name)
       values ($1, 'guest@example.test', 'Guest')`,
      [id],
    );
    await db.query(
      `insert into tenant_members (customer_id, auth_subject, email, role)
       values (
         $1::uuid,
         'user_' || replace($1::uuid::text, '-', ''),
         'owner@example.test',
         'owner'
       )`,
      [id],
    );
    await db.query(
      `insert into bookings (customer_id, service_id, end_customer_id, start_time, end_time, status)
       values (
         $1,
         (select id from services where customer_id = $1 limit 1),
         (select id from end_customers where customer_id = $1 limit 1),
         now() + interval '2 days',
         now() + interval '2 days 30 minutes',
         'confirmed'
       )`,
      [id],
    );
  }
}

/** Put the suite on the footing a real PostgREST request runs on. */
async function asRequest(db: TestDb, customerId: string | null): Promise<void> {
  await db.becomeRequestRole();
  await db.assertNotBypassingRls();
  await db.setJwtClaims(
    customerId === null
      ? null
      : { role: "authenticated", customer_id: customerId },
  );
}

/**
 * Control 2: prove something in the database actually reads the claim.
 *
 * If `app.current_customer_id()` resolves to the claim, a later empty result
 * means the policy denied the row. If it resolves to NULL, every table returns
 * nothing no matter what the policies say, and the suite below is measuring the
 * absence of a mechanism rather than the presence of one.
 */
async function expectClaimIsRead(db: TestDb, customerId: string): Promise<void> {
  const [row] = await db.query<{ resolved: string | null }>(
    "select app.current_customer_id()::text as resolved",
  );
  expect(
    row?.resolved,
    "app.current_customer_id() did not resolve the JWT claim — every " +
      "assertion below would pass vacuously (see migration 0009)",
  ).toBe(customerId);
}

describe.skipIf(!hasTestDatabase)("RLS engagement on the request path", () => {
  it("resolves the tenant from the JWT claim, with no GUC set anywhere", async () => {
    await withRollback(async (db) => {
      await seedTwoTenants(db);
      await asRequest(db, TENANT_A);
      await expectClaimIsRead(db, TENANT_A);
    });
  });

  it("refuses to run isolation assertions on an RLS-bypassing role", async () => {
    // Criterion 1, asserted rather than assumed: the guard must actually fire
    // on the connection CI would otherwise use. If this test ever passes
    // because the guard *didn't* throw, the rest of the suite is meaningless.
    await withRollback(async (db) => {
      await expect(db.assertNotBypassingRls()).rejects.toThrow(
        /bypasses row level security/,
      );
    });
  });

  describe.each(TENANT_SCOPED_TABLES)("%s", (table) => {
    const column = identityColumn(table);

    it("returns only tenant A's rows to tenant A — no customer_id predicate in the query", async () => {
      await withRollback(async (db) => {
        await seedTwoTenants(db);
        await asRequest(db, TENANT_A);
        await expectClaimIsRead(db, TENANT_A);

        const rows = await db.query<Record<string, string>>(
          `select ${column} from ${table}`,
        );

        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r[column] === TENANT_A)).toBe(true);
        expect(rows.some((r) => r[column] === TENANT_B)).toBe(false);
      });
    });

    it("returns zero rows when the request carries no claim at all", async () => {
      await withRollback(async (db) => {
        await seedTwoTenants(db);
        await asRequest(db, null);

        // The fail-closed direction: empty, never leaked. Asserting an error
        // instead would pass for the wrong reason — a `USING` clause filters,
        // it does not raise.
        const rows = await db.query(`select ${column} from ${table}`);
        expect(rows).toHaveLength(0);
      });
    });

    it("returns zero rows for a malformed claim rather than raising", async () => {
      await withRollback(async (db) => {
        await seedTwoTenants(db);
        await db.becomeRequestRole();
        await db.assertNotBypassingRls();
        await db.setJwtClaims({ role: "authenticated", customer_id: "../../etc" });

        // 0009's regex guard. A bare `::uuid` cast here would raise 22P02,
        // which PostgREST returns as a 500 — an error where the right answer is
        // "no rows", and an oracle telling an attacker their input was parsed.
        const rows = await db.query(`select ${column} from ${table}`);
        expect(rows).toHaveLength(0);
      });
    });

    it("reports zero rows affected when tenant A updates a tenant B row", async () => {
      await withRollback(async (db) => {
        await seedTwoTenants(db);
        const [target] = await db.query<{ id: string }>(
          `select id from ${table} where ${column} = $1 limit 1`,
          [TENANT_B],
        );
        expect(target?.id).toBeTruthy();

        await asRequest(db, TENANT_A);
        await expectClaimIsRead(db, TENANT_A);

        const updated = await db.query(
          `update ${table} set ${column} = ${column} where id = $1 returning id`,
          [target!.id],
        );
        expect(updated).toHaveLength(0);
      });
    });

    it("reports zero rows affected when tenant A deletes a tenant B row, and the row survives", async () => {
      await withRollback(async (db) => {
        await seedTwoTenants(db);
        const [target] = await db.query<{ id: string }>(
          `select id from ${table} where ${column} = $1 limit 1`,
          [TENANT_B],
        );
        expect(target?.id).toBeTruthy();

        await asRequest(db, TENANT_A);
        await expectClaimIsRead(db, TENANT_A);

        const deleted = await db.query(
          `delete from ${table} where id = $1 returning id`,
          [target!.id],
        );
        expect(deleted).toHaveLength(0);

        // Re-read as B: "zero rows affected" would also be the answer if the
        // row had been deleted a moment earlier, so prove it is still there.
        await db.setJwtClaims({ role: "authenticated", customer_id: TENANT_B });
        const survivors = await db.query(
          `select id from ${table} where id = $1`,
          [target!.id],
        );
        expect(survivors).toHaveLength(1);
      });
    });

    it("refuses a write that would place a row in tenant B while scoped to A", async () => {
      await withRollback(async (db) => {
        await seedTwoTenants(db);
        const [template] = await db.query<Record<string, unknown>>(
          `select * from ${table} where ${column} = $1 limit 1`,
          [TENANT_A],
        );
        expect(template).toBeTruthy();

        await asRequest(db, TENANT_A);
        await expectClaimIsRead(db, TENANT_A);

        // `WITH CHECK` is the write-side half of the policy, and it *does*
        // raise: a row that fails it is an error (42501), not a silent no-op.
        // Both directions are correct and they are not interchangeable — this
        // is the one that stops a cross-tenant write rather than a read.
        await expect(
          db.query(
            `update ${table} set ${column} = $1 where ${column} = $2`,
            [TENANT_B, TENANT_A],
          ),
        ).rejects.toThrow(/row-level security|violates/i);
      });
    });
  });
});
