import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  IDENTITY_CONFLICT_CASES,
  type IdentityConflictCase,
} from "@/test/fake-identity-rpc";
import { hasTestDatabase, withRollback, type TestDb } from "@/test/supabase-harness";

/**
 * `resolve_or_create_end_customer` against a real Postgres (ALI-167).
 *
 * ## Why this file is the load-bearing evidence
 *
 * The guarantee under test is the body of a `security definer` function, so it
 * is tested by talking to the schema — the same reasoning as
 * `booking-overlap.db.test.ts`. It is also the only place the fix *can* be
 * proved. Before ALI-167 the app-layer fake modelled the RPC as "find the row,
 * return its id", which is the desired post-fix behaviour, while the shipped
 * function overwrote the stored name. The whole app suite therefore passed on
 * the vulnerable code. Any evidence for this fix that does not touch a real
 * database is evidence about the fake.
 *
 * ## The PRE-FIX/POST-FIX pair
 *
 * A regression test for this bug that passes against the unfixed commit is not
 * a regression test. So the first test below **installs 0003's definition
 * inside its own transaction**, drives the same path, and watches Alice's name
 * become Bob — then rolls back, restoring 0007. DDL is transactional in
 * Postgres, which makes the vulnerable and fixed semantics observable in one
 * run, against one database, with the fix as the only difference. (The same
 * device as `booking-overlap.db.test.ts` criterion 7, which drops the
 * constraint it is testing inside a transaction.)
 *
 * ## Habits inherited from the existing DB suites
 *
 * `setTenant` before every write: RLS is `force`d on these tables, so a
 * non-superuser connection is subject to it. CI connects as `postgres` (a
 * superuser, which bypasses RLS entirely), and a test leaning on that would
 * quietly stop working the day the role changes.
 *
 * Skips (does not fail) when `TEST_DATABASE_URL` is unset — see the harness
 * docstring. In CI the `quality` job's `postgres:16` service container sets it.
 */

const FIXTURE_EMAIL = "guest@example.com";
const FIXTURE_NAME = "Alice";
const FIXTURE_PHONE = "+15550001";

/** SQLSTATE 40001 — what 0007 raises if a concurrent create stays invisible. */
const SQLSTATE_NOT_NULL_VIOLATION = "23502";
const SQLSTATE_FOREIGN_KEY_VIOLATION = "23503";

/**
 * `public.resolve_or_create_end_customer` exactly as migration 0003 defined it
 * (0003:58-86), so the bug can be reproduced rather than described.
 *
 * Restated here instead of read from `0003_*.sql` on purpose: that file must
 * keep applying unchanged on a fresh database (it is history), and reading it
 * would drag in its RLS policies and table DDL too. Only the function is
 * wanted, and the `on conflict do update` clause below is the whole bug.
 */
const VULNERABLE_FUNCTION_SQL = `
  create or replace function public.resolve_or_create_end_customer(
    p_customer_id uuid,
    p_email       text,
    p_name        text,
    p_phone       text default null
  )
  returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $vuln$
  declare
    v_id uuid;
  begin
    insert into public.end_customers (customer_id, email, name, phone)
    values (p_customer_id, lower(p_email), coalesce(p_name, ''), p_phone)
    on conflict (customer_id, email) do update
      set name  = coalesce(nullif(excluded.name, ''), public.end_customers.name),
          phone = coalesce(excluded.phone, public.end_customers.phone)
    returning id into v_id;

    return v_id;
  end;
  $vuln$;
`;

interface Fixture {
  customerId: string;
  serviceId: string;
  /** The pre-existing identity: (T, guest@example.com, 'Alice', '+15550001'). */
  identityId: string;
  /** Booking `B1`, referencing that identity. */
  b1Id: string;
}

/** Create tenant `T` with Alice's identity and booking `B1` referencing it. */
async function seedFixture(db: TestDb, slug: string): Promise<Fixture> {
  const [generated] = await db.query<{ id: string }>(
    "select gen_random_uuid() as id",
  );
  const customerId = generated!.id;

  // Before the insert: the customers insert policy checks `id = current`.
  await db.setTenant(customerId);

  await db.query(
    "insert into public.customers (id, name, slug) values ($1, $2, $3)",
    [customerId, `Guest Identity Fixture ${slug}`, `ali167-${slug}`],
  );

  const [service] = await db.query<{ id: string }>(
    `insert into public.services (customer_id, name, duration_minutes, price_cents)
     values ($1, $2, $3, $4) returning id`,
    [customerId, "Interview", 60, 0],
  );

  const [identity] = await db.query<{ id: string }>(
    `insert into public.end_customers (customer_id, email, name, phone)
     values ($1, $2, $3, $4) returning id`,
    [customerId, FIXTURE_EMAIL, FIXTURE_NAME, FIXTURE_PHONE],
  );

  const [b1] = await db.query<{ id: string }>(
    `insert into public.bookings
       (customer_id, service_id, end_customer_id, start_time, end_time, status)
     values ($1, $2, $3, $4, $5, 'pending') returning id`,
    [
      customerId,
      service!.id,
      identity!.id,
      "2026-09-01T09:00:00Z",
      "2026-09-01T10:00:00Z",
    ],
  );

  return {
    customerId,
    serviceId: service!.id,
    identityId: identity!.id,
    b1Id: b1!.id,
  };
}

/**
 * Call the RPC with **exactly** the arguments `createBooking` passes it
 * (`src/lib/bookings.ts:90-99` — `p_phone` hardcoded `null`), so what is
 * exercised is the anonymous booking path and not a hand-tuned variant of it.
 *
 * The app reaches this function through PostgREST, which the hermetic
 * `postgres:16` container does not run (see `supabase/README.md`), so the call
 * is made over the same `pg` connection the rest of the suite uses. The
 * argument list is the contract between the two.
 */
async function resolveAsCreateBookingDoes(
  db: TestDb,
  customerId: string,
  email: string,
  name: string | null,
): Promise<string> {
  await db.setTenant(customerId);
  const [row] = await db.query<{ id: string }>(
    `select public.resolve_or_create_end_customer(
       p_customer_id => $1, p_email => $2, p_name => $3, p_phone => $4
     ) as id`,
    [customerId, email, name, null],
  );
  return row!.id;
}

/** The stored `(name, phone)` for one identity, or `null` if absent. */
async function storedIdentity(
  db: TestDb,
  customerId: string,
  email: string,
): Promise<{ name: string; phone: string | null } | null> {
  const rows = await db.query<{ name: string; phone: string | null }>(
    "select name, phone from public.end_customers where customer_id = $1 and email = $2",
    [customerId, email],
  );
  return rows[0] ?? null;
}

async function identityCount(
  db: TestDb,
  customerId: string,
  email: string,
): Promise<number> {
  const [row] = await db.query<{ n: number }>(
    `select count(*)::int as n from public.end_customers
     where customer_id = $1 and email = $2`,
    [customerId, email],
  );
  return row!.n;
}

/** The catalog facts AC6 is about, for the one routine under test. */
async function routineFacts(db: TestDb) {
  return db.query<{
    routine_count: number;
    public_execute: boolean;
    service_role_execute: boolean;
    anon_execute: boolean;
    acl_is_null: boolean;
    public_acl_items: number;
    proacl: string | null;
  }>(
    `select count(*) over ()::int              as routine_count,
            has_function_privilege('public', p.oid, 'EXECUTE')        as public_execute,
            has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role_execute,
            has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_execute,
            p.proacl is null                   as acl_is_null,
            (select count(*)::int from unnest(coalesce(p.proacl, '{}'::aclitem[])) a
              where a::text like '=%')         as public_acl_items,
            p.proacl::text                     as proacl
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'resolve_or_create_end_customer'`,
  );
}

/** Read migration 0007 off disk, so the test executes the shipped file. */
async function readMigration0007(): Promise<string> {
  const dir = path.resolve(process.cwd(), "supabase", "migrations");
  const file = (await readdir(dir)).find((f) => f.startsWith("0007_"));
  if (!file) throw new Error(`no 0007_* migration found in ${dir}`);
  return readFile(path.join(dir, file), "utf8");
}

describe.skipIf(!hasTestDatabase)("resolve_or_create_end_customer — identity is immutable", () => {
  // ── AC1, negative case: the bug, executed ──────────────────────────────────
  it("PRE-FIX: 0003's conflict clause overwrites the stored name and phone", async () => {
    await withRollback(async (db) => {
      const t = await seedFixture(db, "prefix");

      // Swap in the vulnerable definition. Transactional DDL means this is
      // undone by the rollback, so the rest of the run sees 0007 again.
      await db.query(VULNERABLE_FUNCTION_SQL);

      // Leg 1 — live today: the second booker types a different name.
      const resolved = await resolveAsCreateBookingDoes(
        db,
        t.customerId,
        FIXTURE_EMAIL,
        "Bob",
      );
      expect(resolved).toBe(t.identityId);
      // Alice is gone, and because `bookings` references `end_customer_id`, she
      // is gone from B1's displayed guest name too — retroactively.
      expect(await storedIdentity(db, t.customerId, FIXTURE_EMAIL)).toEqual({
        name: "Bob",
        phone: FIXTURE_PHONE,
      });

      // Leg 2 — latent today, armed for whoever adds phone collection.
      await db.query(
        `select public.resolve_or_create_end_customer(
           p_customer_id => $1, p_email => $2, p_name => $3, p_phone => $4)`,
        [t.customerId, FIXTURE_EMAIL, "Bob", "+15559999"],
      );
      expect(await storedIdentity(db, t.customerId, FIXTURE_EMAIL)).toEqual({
        name: "Bob",
        phone: "+15559999",
      });
    });
  });

  // ── AC1 + AC2: the same path, on the shipped function ──────────────────────
  it("POST-FIX: an anonymous repeat booking leaves the identity bit-for-bit unchanged", async () => {
    await withRollback(async (db) => {
      const t = await seedFixture(db, "postfix");
      const before = await storedIdentity(db, t.customerId, FIXTURE_EMAIL);

      const resolved = await resolveAsCreateBookingDoes(
        db,
        t.customerId,
        FIXTURE_EMAIL,
        "Bob",
      );

      // AC1: exactly ('Alice', '+15550001'), identical to before the call.
      expect(await storedIdentity(db, t.customerId, FIXTURE_EMAIL)).toEqual({
        name: FIXTURE_NAME,
        phone: FIXTURE_PHONE,
      });
      expect(await storedIdentity(db, t.customerId, FIXTURE_EMAIL)).toEqual(before);

      // AC2: resolved, not forked — and to the identity B1 already references.
      expect(await identityCount(db, t.customerId, FIXTURE_EMAIL)).toBe(1);
      expect(resolved).toBe(t.identityId);

      const [b1] = await db.query<{ end_customer_id: string }>(
        "select end_customer_id from public.bookings where id = $1",
        [t.b1Id],
      );
      expect(resolved).toBe(b1!.end_customer_id);

      // AC2, the corollary: the booking must succeed. A refusal here would be a
      // denial of service on a legitimate returning guest.
      const [created] = await db.query<{ id: string; end_customer_id: string }>(
        `insert into public.bookings
           (customer_id, service_id, end_customer_id, start_time, end_time, status)
         values ($1, $2, $3, $4, $5, 'pending')
         returning id, end_customer_id`,
        [
          t.customerId,
          t.serviceId,
          resolved,
          "2026-09-01T10:00:00Z",
          "2026-09-01T11:00:00Z",
        ],
      );
      expect(created!.end_customer_id).toBe(b1!.end_customer_id);
    });
  });

  // ── AC1 both legs: the latent phone leg, at the RPC ────────────────────────
  it("POST-FIX: a non-null p_phone cannot change the stored phone either", async () => {
    await withRollback(async (db) => {
      const t = await seedFixture(db, "phone-leg");

      // No app call site passes a phone today (`bookings.ts:96` hardcodes
      // null), so this leg is only reachable by calling the function directly.
      // Tested here anyway — that is the latent regression, and closing only
      // the reachable leg would leave it armed.
      await db.setTenant(t.customerId);
      const [row] = await db.query<{ id: string }>(
        `select public.resolve_or_create_end_customer(
           p_customer_id => $1, p_email => $2, p_name => $3, p_phone => $4) as id`,
        [t.customerId, FIXTURE_EMAIL, "Bob", "+15559999"],
      );

      expect(row!.id).toBe(t.identityId);
      expect(await storedIdentity(db, t.customerId, FIXTURE_EMAIL)).toEqual({
        name: FIXTURE_NAME,
        phone: FIXTURE_PHONE,
      });
    });
  });

  // ── The contract table, against the real function (pins the fake) ──────────
  //
  // The same `IDENTITY_CONFLICT_CASES` the app-layer fake is checked against in
  // `src/lib/__tests__/guest-identity.test.ts`. One table, both worlds: if the
  // fake ever drifts from the function it claims to model, one of the two goes
  // red. That drift is the defect that let this bug live in a green suite.
  it.each(IDENTITY_CONFLICT_CASES.map((c) => [c.label, c] as const))(
    "contract: %s",
    async (_label, testCase: IdentityConflictCase) => {
      await withRollback(async (db) => {
        const [generated] = await db.query<{ id: string }>(
          "select gen_random_uuid() as id",
        );
        const customerId = generated!.id;
        await db.setTenant(customerId);
        await db.query(
          "insert into public.customers (id, name, slug) values ($1, $2, $3)",
          [customerId, "Contract Fixture", `ali167-contract-${customerId}`],
        );

        if (testCase.stored) {
          await db.query(
            `insert into public.end_customers (customer_id, email, name, phone)
             values ($1, $2, $3, $4)`,
            [customerId, FIXTURE_EMAIL, testCase.stored.name, testCase.stored.phone],
          );
        }

        const [row] = await db.query<{ id: string }>(
          `select public.resolve_or_create_end_customer(
             p_customer_id => $1, p_email => $2, p_name => $3, p_phone => $4) as id`,
          [customerId, FIXTURE_EMAIL, testCase.supplied.name, testCase.supplied.phone],
        );

        // Never a fork: one identity per (tenant, email), whatever happened.
        expect(await identityCount(db, customerId, FIXTURE_EMAIL)).toBe(1);
        expect(await storedIdentity(db, customerId, FIXTURE_EMAIL)).toEqual(
          testCase.expected,
        );

        const [resolvedRow] = await db.query<{ id: string }>(
          "select id from public.end_customers where customer_id = $1 and email = $2",
          [customerId, FIXTURE_EMAIL],
        );
        expect(row!.id).toBe(resolvedRow!.id);
      });
    },
  );

  // ── AC5: the paths that were already correct ───────────────────────────────
  it("still lowercases the email, so a differently-cased repeat does not fork", async () => {
    await withRollback(async (db) => {
      const t = await seedFixture(db, "case-fold");

      const resolved = await resolveAsCreateBookingDoes(
        db,
        t.customerId,
        "GUEST@Example.COM",
        "Bob",
      );

      expect(resolved).toBe(t.identityId);
      expect(await identityCount(db, t.customerId, FIXTURE_EMAIL)).toBe(1);
      expect(await storedIdentity(db, t.customerId, FIXTURE_EMAIL)).toEqual({
        name: FIXTURE_NAME,
        phone: FIXTURE_PHONE,
      });
    });
  });

  it("still returns a bare uuid that the bookings insert consumes directly", async () => {
    await withRollback(async (db) => {
      const t = await seedFixture(db, "returns-uuid");

      // AC5: the return type is unchanged, which is what lets
      // `src/lib/bookings.ts:90-99` keep consuming it as-is.
      await db.setTenant(t.customerId);
      const [typed] = await db.query<{ type_name: string }>(
        `select pg_catalog.format_type(p.prorettype, null) as type_name
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'resolve_or_create_end_customer'`,
      );
      expect(typed!.type_name).toBe("uuid");

      const resolved = await resolveAsCreateBookingDoes(
        db,
        t.customerId,
        "brand-new@example.com",
        "Carol",
      );
      const [inserted] = await db.query<{ end_customer_id: string }>(
        `insert into public.bookings
           (customer_id, service_id, end_customer_id, start_time, end_time, status)
         values ($1, $2, $3, $4, $5, 'pending') returning end_customer_id`,
        [
          t.customerId,
          t.serviceId,
          resolved,
          "2026-09-02T10:00:00Z",
          "2026-09-02T11:00:00Z",
        ],
      );
      expect(inserted!.end_customer_id).toBe(resolved);
    });
  });

  // ── The rejections the shared fake claims to model ─────────────────────────
  //
  // A fake that only says yes is a model of success, not of the system. These
  // are the two hard rejections `fake-identity-rpc.ts` encodes; proved here so
  // the fake's `23502`/`23503` are measured against Postgres rather than
  // asserted from memory.
  it("rejects a null email with 23502, whatever the caller intended", async () => {
    await withRollback(async (db) => {
      const t = await seedFixture(db, "null-email");
      await db.setTenant(t.customerId);

      await expect(
        db.query(
          `select public.resolve_or_create_end_customer(
             p_customer_id => $1, p_email => $2, p_name => $3, p_phone => $4)`,
          [t.customerId, null, "Bob", null],
        ),
      ).rejects.toHaveProperty("code", SQLSTATE_NOT_NULL_VIOLATION);
    });
  });

  it("rejects an unknown tenant with 23503 — security definer is not a licence", async () => {
    await withRollback(async (db) => {
      const [generated] = await db.query<{ id: string }>(
        "select gen_random_uuid() as id",
      );
      const strangerId = generated!.id;
      await db.setTenant(strangerId);

      // SECURITY DEFINER lets the function write past RLS. It does not let it
      // write past a foreign key, so an identity cannot be conjured for a
      // tenant that does not exist.
      await expect(
        db.query(
          `select public.resolve_or_create_end_customer(
             p_customer_id => $1, p_email => $2, p_name => $3, p_phone => $4)`,
          [strangerId, FIXTURE_EMAIL, "Bob", null],
        ),
      ).rejects.toHaveProperty("code", SQLSTATE_FOREIGN_KEY_VIOLATION);
    });
  });
});

// ── AC6: migration hygiene ───────────────────────────────────────────────────
//
// These two are how this fix ships green with the hole still open, and both are
// invisible to every behavioural test above.
describe.skipIf(!hasTestDatabase)("migration 0007 — hygiene", () => {
  // ── AC6a ───────────────────────────────────────────────────────────────────
  it("leaves exactly one routine named resolve_or_create_end_customer", async () => {
    await withRollback(async (db) => {
      const facts = await routineFacts(db);

      // `create or replace function` with a *changed argument list* creates a
      // SECOND overload and leaves the old 4-arg one in place, still
      // overwriting. PostgREST resolves `.rpc()` by named arguments, so
      // `bookings.ts:90-99` would keep binding to the old vulnerable function
      // while every test of the new one passed.
      expect(facts).toHaveLength(1);
      expect(facts[0]!.routine_count).toBe(1);
    });
  });

  it("keeps the 4-argument signature the call site binds by name", async () => {
    await withRollback(async (db) => {
      const [row] = await db.query<{ args: string }>(
        `select pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'resolve_or_create_end_customer'`,
      );
      // Names, types and order in one string — all three are part of the
      // signature `create or replace` must not change, and 0003:58-63 is where
      // they come from.
      expect(row!.args).toBe(
        "p_customer_id uuid, p_email text, p_name text, p_phone text",
      );

      // The names again, as the array PostgREST resolves against: it binds
      // `.rpc()` by argument name, so renaming one silently breaks the call site
      // (or, worse, creates an overload that leaves the old function reachable).
      const [names] = await db.query<{ argnames: string[] }>(
        `select p.proargnames as argnames
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'resolve_or_create_end_customer'`,
      );
      expect(names!.argnames).toEqual([
        "p_customer_id",
        "p_email",
        "p_name",
        "p_phone",
      ]);
    });
  });

  // ── AC6b ───────────────────────────────────────────────────────────────────
  it("leaves PUBLIC no EXECUTE, and service_role's intact", async () => {
    await withRollback(async (db) => {
      const [facts] = await routineFacts(db);

      // The discriminating assertion. `drop function` + `create` does NOT
      // preserve privileges: a recreated function gets the default PUBLIC
      // EXECUTE, which would let the `anon` PostgREST role call the identity
      // RPC directly and bypass the server action entirely — strictly worse
      // than the hole being fixed.
      expect(facts!.public_execute).toBe(false);
      expect(facts!.anon_execute).toBe(false);
      expect(facts!.service_role_execute).toBe(true);

      // The literal form the criterion names — no ACL item beginning '=' — is
      // asserted too, but it is NOT sufficient on its own and must not be
      // mistaken for the check: a freshly recreated function has `proacl NULL`,
      // which contains zero such items while PUBLIC holds EXECUTE by default.
      // So the null case is pinned separately.
      expect(facts!.acl_is_null).toBe(false);
      expect(facts!.public_acl_items).toBe(0);
      expect(facts!.proacl).toContain("service_role=X");
    });
  });

  it("the PUBLIC-execute check can actually fail (it is not vacuous)", async () => {
    await withRollback(async (db) => {
      // Inside this transaction only, do the thing the criterion forbids: drop
      // and recreate. If the assertions above could not detect it, they would
      // be decoration. This is also the concrete reason 0007 uses `create or
      // replace` and never drops.
      await db.query(
        "drop function public.resolve_or_create_end_customer(uuid, text, text, text)",
      );
      await db.query(`
        create function public.resolve_or_create_end_customer(
          p_customer_id uuid, p_email text, p_name text, p_phone text default null
        ) returns uuid language sql as $probe$ select null::uuid $probe$;
      `);

      const [facts] = await routineFacts(db);
      expect(facts!.public_execute).toBe(true);
      // …and the literal `=`-item check reports the hole as absent, which is
      // exactly why the privilege inquiry above is the load-bearing one.
      expect(facts!.acl_is_null).toBe(true);
      expect(facts!.public_acl_items).toBe(0);
    });
  });

  // ── AC6c ───────────────────────────────────────────────────────────────────
  it("is re-runnable: applying it twice changes neither the catalog nor any row", async () => {
    await withRollback(async (db) => {
      const migration = await readMigration0007();
      const t = await seedFixture(db, "rerun");

      const [firstApply] = await routineFacts(db);
      const [rowsBefore] = await db.query<{ identities: number; bookings: number }>(
        `select (select count(*)::int from public.end_customers) as identities,
                (select count(*)::int from public.bookings)      as bookings`,
      );

      // The shipped file, executed twice — including its own apply-time
      // self-check block, which raises if either hygiene property is violated.
      await db.query(migration);
      await db.query(migration);

      const [afterApply] = await routineFacts(db);
      expect(afterApply).toEqual(firstApply);

      const [rowsAfter] = await db.query<{ identities: number; bookings: number }>(
        `select (select count(*)::int from public.end_customers) as identities,
                (select count(*)::int from public.bookings)      as bookings`,
      );
      expect(rowsAfter).toEqual(rowsBefore);

      // Data, not just counts: the fixture identity is untouched by the DDL.
      await db.setTenant(t.customerId);
      expect(await storedIdentity(db, t.customerId, FIXTURE_EMAIL)).toEqual({
        name: FIXTURE_NAME,
        phone: FIXTURE_PHONE,
      });

      // And it still behaves after a re-apply, rather than merely existing.
      const resolved = await resolveAsCreateBookingDoes(
        db,
        t.customerId,
        FIXTURE_EMAIL,
        "Bob",
      );
      expect(resolved).toBe(t.identityId);
      expect(await storedIdentity(db, t.customerId, FIXTURE_EMAIL)).toEqual({
        name: FIXTURE_NAME,
        phone: FIXTURE_PHONE,
      });
    });
  });

  it("the apply-time self-check rejects a shadowing overload", async () => {
    await withRollback(async (db) => {
      const migration = await readMigration0007();

      // The failure mode AC6a names, staged for real: a second overload with a
      // different argument list, which PostgREST could still bind to. The
      // migration's own `do` block must refuse to apply over it — so a bad
      // apply aborts instead of shipping a green hole.
      await db.query(`
        create function public.resolve_or_create_end_customer(
          p_customer_id uuid, p_email text
        ) returns uuid language sql as $shadow$ select null::uuid $shadow$;
      `);

      await expect(db.query(migration)).rejects.toThrow(/expected exactly 1/);
    });
  });
});
