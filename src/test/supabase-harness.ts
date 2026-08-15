import { Client } from "pg";

/**
 * Transaction-per-test harness for database tests.
 *
 * Every test runs inside a transaction that is **always rolled back**, so tests
 * share one database without leaking state into each other or into the project.
 *
 * ## Why a direct Postgres connection rather than the Supabase JS client
 *
 * The Supabase JS client talks to PostgREST over HTTP. Each call is its own
 * implicit transaction, so a `BEGIN` issued through it cannot span later calls —
 * there is nothing to roll back. Testing RLS also requires setting the
 * `app.current_customer_id` GUC *transaction-locally* and having subsequent
 * statements observe it, which again needs one held session. Hence `pg`.
 *
 * ## Why RLS actually engages here
 *
 * `0002_rls_policies.sql` uses `alter table … force row level security`, so
 * policies apply even to the table owner. A direct connection as the project's
 * Postgres role is therefore still subject to them — which is what makes
 * isolation tests meaningful rather than tautological.
 *
 * ## Configuration
 *
 * Set `TEST_DATABASE_URL` to a Postgres connection string for a **disposable**
 * database — a Supabase branch, not production. Without it, database tests skip
 * rather than fail, so `npm test` stays green on a machine with no database.
 * Never point this at a project holding real customer data: the harness writes
 * before it rolls back, and a crashed process can leave a transaction open.
 */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** True when database tests can run. Use with `describe.skipIf(!hasTestDatabase)`. */
export const hasTestDatabase = Boolean(TEST_DATABASE_URL);

export interface TestDb {
  /** Run a statement inside the test's transaction. */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  /**
   * Set the tenant context RLS policies key off, for the rest of this
   * transaction. Pass `null` to clear it and assert the fail-closed path.
   */
  setTenant(customerId: string | null): Promise<void>;
}

/**
 * Run `fn` inside a transaction and roll it back afterwards, whatever happens.
 *
 * The rollback is in a `finally`, so a failing assertion still leaves the
 * database untouched — a test that throws must not poison the next one.
 */
export async function withRollback(
  fn: (db: TestDb) => Promise<void>,
): Promise<void> {
  if (!TEST_DATABASE_URL) {
    throw new Error(
      "withRollback requires TEST_DATABASE_URL. Guard the suite with " +
        "`describe.skipIf(!hasTestDatabase)` so it skips instead of failing.",
    );
  }

  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();

  const db: TestDb = {
    async query(sql, params) {
      const result = await client.query(sql, params as unknown[]);
      return result.rows;
    },
    async setTenant(customerId) {
      // `true` = transaction-local, so the setting dies with the rollback.
      await client.query("select set_config('app.current_customer_id', $1, true)", [
        customerId ?? "",
      ]);
    },
  };

  try {
    await client.query("begin");
    await fn(db);
  } finally {
    try {
      await client.query("rollback");
    } finally {
      await client.end();
    }
  }
}
