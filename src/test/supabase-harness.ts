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
 * ## Why RLS engages here — corrected 2026-08-22 (ALI-116)
 *
 * ~~`0002_rls_policies.sql` uses `alter table … force row level security`, so
 * policies apply even to the table owner. A direct connection as the project's
 * Postgres role is therefore still subject to them — which is what makes
 * isolation tests meaningful rather than tautological.~~
 *
 * **That reasoning is true of a table *owner* and false of the roles this
 * harness actually connects as.** `FORCE` closes the owner exemption and
 * nothing else: a `SUPERUSER` bypasses RLS unconditionally, and so does any
 * role with `BYPASSRLS`. CI connects as `postgres`, the superuser of its
 * throwaway container; the hosted project's `postgres` is not a superuser but
 * *does* carry `BYPASSRLS` [verified 2026-08-22 against project
 * `xwzxigvgiqsarzfpjqkk`: `rolsuper = f, rolbypassrls = t`]. Either way, an
 * isolation assertion made on the default connection role is **vacuously
 * green** — it would pass against a database with no policies at all.
 *
 * `becomeRequestRole()` is the fix, and `assertNotBypassingRls()` is the guard
 * that stops the mistake being made silently again. Use both in any test whose
 * subject is isolation.
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

/** Makes each `becomeRequestRole()` role name unique within this process. */
let requestRoleCounter = 0;

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
   *
   * This is the **GUC** leg of `app.current_customer_id()`. It is the leg the
   * app does *not* use — see `setJwtClaims` for the one a real request drives.
   */
  setTenant(customerId: string | null): Promise<void>;
  /**
   * Set `request.jwt.claims` — the GUC PostgREST populates from the verified
   * bearer token before running a request's transaction, and the leg of
   * `app.current_customer_id()` that migration 0009 added.
   *
   * This is what makes a DB test exercise the *production* reader rather than a
   * test-only one. Pass `null` for "no token at all" and assert fail-closed.
   */
  setJwtClaims(claims: Record<string, unknown> | null): Promise<void>;
  /**
   * Switch to a freshly created, granted, non-superuser role for the rest of
   * this transaction — what a PostgREST request actually runs as.
   *
   * `CREATE ROLE` and `GRANT` are transactional in Postgres, so the role is
   * created inside the test's transaction and vanishes with the rollback. It is
   * granted the same privileges Supabase's default privileges give
   * `authenticated` on a hosted project, so it can reach the tables and is
   * stopped only by the policies.
   *
   * Without this, an isolation test proves nothing: see the corrected note at
   * the top of this file.
   */
  becomeRequestRole(): Promise<void>;
  /**
   * Fail loudly if the current role can bypass RLS (ALI-116 criterion 1).
   *
   * Call it *after* `becomeRequestRole()` and before any isolation assertion.
   * An isolation suite that skips this check cannot tell "the policies work"
   * from "nothing was ever filtering".
   */
  assertNotBypassingRls(): Promise<void>;
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
    async setJwtClaims(claims) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        claims === null ? "" : JSON.stringify(claims),
      ]);
    },
    async becomeRequestRole() {
      // Unique per call: role names are cluster-global, so two suites running
      // against the same database must not collide on one.
      const role = `rls_probe_${requestRoleCounter++}_${process.pid}`;
      await client.query(`create role "${role}"`);
      await client.query(`grant usage on schema public, app to "${role}"`);
      await client.query(`grant all on all tables in schema public to "${role}"`);
      await client.query(
        `grant execute on all functions in schema public, app to "${role}"`,
      );
      // `auth` only exists once 0009's shim is bootstrapped (hosted Supabase
      // provides it). Tolerate its absence so this helper stays usable against
      // a database that predates it, rather than failing for an unrelated
      // reason.
      await client
        .query(`grant usage on schema auth to "${role}"`)
        .then(() =>
          client.query(`grant execute on all functions in schema auth to "${role}"`),
        )
        .catch(() => undefined);
      // `local` so the switch dies with the transaction like everything else.
      await client.query(`set local role "${role}"`);
    },
    async assertNotBypassingRls() {
      const { rows } = await client.query<{
        current_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        "select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
      );
      const me = rows[0];
      if (!me) {
        throw new Error(
          `RLS guard: current_user has no pg_roles row — cannot prove it is subject to RLS.`,
        );
      }
      if (me.rolsuper || me.rolbypassrls) {
        throw new Error(
          `RLS guard: connected as "${me.current_user}" (rolsuper=${me.rolsuper}, ` +
            `rolbypassrls=${me.rolbypassrls}), which bypasses row level security ` +
            `even with FORCE. Every isolation assertion below would pass ` +
            `vacuously. Call becomeRequestRole() first.`,
        );
      }
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
