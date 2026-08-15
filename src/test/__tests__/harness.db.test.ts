import { describe, expect, it } from "vitest";

import { hasTestDatabase, withRollback } from "@/test/supabase-harness";

/**
 * Proves the harness itself works: that a write inside `withRollback` is
 * visible within the transaction and is gone afterwards. Everything else that
 * touches the database depends on this being true, so it is tested directly
 * rather than assumed.
 *
 * Skips (does not fail) when `TEST_DATABASE_URL` is unset — see the harness
 * docstring for why.
 */
describe.skipIf(!hasTestDatabase)("supabase test harness", () => {
  const PROBE_SLUG = "harness-rollback-probe";

  it("makes writes visible inside the transaction", async () => {
    await withRollback(async (db) => {
      await db.query(
        "insert into public.customers (name, slug) values ($1, $2)",
        ["Harness Probe", PROBE_SLUG],
      );

      const rows = await db.query<{ slug: string }>(
        "select slug from public.customers where slug = $1",
        [PROBE_SLUG],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.slug).toBe(PROBE_SLUG);
    });
  });

  it("rolls the write back, so the next test sees a clean database", async () => {
    await withRollback(async (db) => {
      const rows = await db.query(
        "select slug from public.customers where slug = $1",
        [PROBE_SLUG],
      );

      // If rollback were broken, the row from the previous test would be here.
      expect(rows).toHaveLength(0);
    });
  });

  it("rolls back even when the test body throws", async () => {
    await expect(
      withRollback(async (db) => {
        await db.query(
          "insert into public.customers (name, slug) values ($1, $2)",
          ["Thrower", `${PROBE_SLUG}-throw`],
        );
        throw new Error("deliberate failure");
      }),
    ).rejects.toThrow("deliberate failure");

    await withRollback(async (db) => {
      const rows = await db.query(
        "select slug from public.customers where slug = $1",
        [`${PROBE_SLUG}-throw`],
      );
      expect(rows).toHaveLength(0);
    });
  });
});
