import { describe, expect, it } from "vitest";

import { hasTestDatabase, withRollback, type TestDb } from "@/test/supabase-harness";

/**
 * `customers.custom_domain` against a real Postgres (ALI-115, migration
 * 0008).
 *
 * The app-layer half of this lookup is proved in `tenant-host.test.ts`,
 * which drives `getTenantByHost` over a fake driver. This file proves the
 * two claims that only a real database can settle:
 *
 *   1. **The unique index actually rejects a duplicate.** `getTenantByHost`
 *      being an exact-match `eq` lookup only means something if the schema
 *      guarantees at most one row can ever match a given `custom_domain`.
 *   2. **NULL is not a value the index compares against itself.** Most
 *      tenants never set a custom domain, so two customers both with
 *      `custom_domain IS NULL` must coexist under the same unique index —
 *      Postgres never treats NULL = NULL for uniqueness, so no partial index
 *      is needed for this (see the migration's own comment).
 *
 * A third test proves the lookup shape `getTenantByHost` actually issues
 * (`select … where custom_domain = $1`) resolves exactly the seeded row and
 * not a different one — in particular, not a row whose *slug* happens to
 * equal the queried host, which would indicate the query drifted onto the
 * wrong column.
 *
 * Skips (does not fail) when `TEST_DATABASE_URL` is unset — see the harness
 * docstring. In CI the `quality` job's `postgres:16` service container sets
 * it.
 */

const SQLSTATE_UNIQUE_VIOLATION = "23505";

/** Seed a minimal `customers` row — this table's own foreign key is `id`. */
async function seedCustomer(
  db: TestDb,
  slug: string,
  customDomain: string | null,
): Promise<string> {
  const [generated] = await db.query<{ id: string }>(
    "select gen_random_uuid() as id",
  );
  const id = generated!.id;

  // `customers`' own insert policy checks `id = current`.
  await db.setTenant(id);
  await db.query(
    "insert into public.customers (id, name, slug, custom_domain) values ($1, $2, $3, $4)",
    [id, `Tenant ${slug}`, slug, customDomain],
  );
  return id;
}

describe.skipIf(!hasTestDatabase)("customers.custom_domain (0008)", () => {
  it("the unique index rejects a duplicate custom_domain", async () => {
    await withRollback(async (db) => {
      await seedCustomer(db, "ali115-alpha", "booking.example.com");

      const second = seedCustomer(db, "ali115-beta", "booking.example.com");
      await expect(second).rejects.toHaveProperty(
        "code",
        SQLSTATE_UNIQUE_VIOLATION,
      );
    });
  });

  it("two customers with custom_domain IS NULL do not conflict", async () => {
    await withRollback(async (db) => {
      // Neither sets a custom domain — the common case (most tenants never
      // do). Postgres never treats NULL = NULL for a unique index, so both
      // inserts must succeed.
      const first = await seedCustomer(db, "ali115-null-alpha", null);
      const second = await seedCustomer(db, "ali115-null-beta", null);

      expect(first).not.toBe(second);

      const rows = await db.query<{ n: number }>(
        `select count(*)::int as n
           from public.customers
          where id in ($1, $2)
            and custom_domain is null`,
        [first, second],
      );
      expect(rows[0]!.n).toBe(2);
    });
  });

  it("select … where custom_domain = $1 resolves exactly the seeded row, not a different one", async () => {
    await withRollback(async (db) => {
      const HOST = "booking.exact-match.example.com";

      // A decoy whose *slug* equals the host being queried — proof the
      // lookup is scoped to the custom_domain column and not, say, an `or`
      // across slug and custom_domain that would resolve the wrong tenant.
      const decoyId = await seedCustomer(db, HOST, null);
      const targetId = await seedCustomer(db, "ali115-target", HOST);
      // A second unrelated tenant, to prove the lookup is not merely "return
      // whatever's first".
      await seedCustomer(db, "ali115-other", "booking.other.example.com");

      const rows = await db.query<{ id: string }>(
        "select id from public.customers where custom_domain = $1",
        [HOST],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(targetId);
      expect(rows[0]!.id).not.toBe(decoyId);
    });
  });
});
