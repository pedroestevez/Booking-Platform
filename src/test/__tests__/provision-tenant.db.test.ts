import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasTestDatabase, TEST_DATABASE_URL } from "@/test/supabase-harness";

/**
 * `scripts/provision-tenant.mjs` against a real Postgres (ALI-176 criteria 1–2).
 *
 * ## Criterion 1 is the one that can be green while being wrong
 *
 * A script that converges by `delete from services` passes a naive "run it
 * twice, count the rows" test perfectly — and destroys a real tenant's
 * catalogue. So the idempotency test below seeds **tenant-owned data the script
 * does not manage** before the second run — a `bookings` row and an
 * `end_customers` row — and asserts they are still there afterwards, by id. It
 * also asserts the provisioned `services` row keeps its **identity**: a
 * delete-then-reinsert converges the counts while silently changing the primary
 * key every booking references. Counts alone cannot tell the two apart.
 *
 * ## Why not `withRollback`
 *
 * The harness's transaction-per-test wrapper cannot be used here: the script is
 * a separate process with its own connection and it commits. So this suite owns
 * its writes and cleans them up in `afterAll`, in foreign-key-safe order, under
 * a slug prefix nothing else uses.
 *
 * ## Why this cannot touch production
 *
 * The script reads `PROVISION_DATABASE_URL` and nothing else, and this suite
 * sets that variable to `TEST_DATABASE_URL` — the same disposable database every
 * other DB test uses. Criterion 2's test asserts the no-fallback rule for real:
 * it runs the script with `TEST_DATABASE_URL` *and* `DATABASE_URL` set and
 * `PROVISION_DATABASE_URL` unset, and requires a non-zero exit with nothing
 * written.
 *
 * Skips (does not fail) without `TEST_DATABASE_URL` — see the harness docstring.
 */

const exec = promisify(execFile);

const SCRIPT = fileURLToPath(
  new URL("../../../scripts/provision-tenant.mjs", import.meta.url),
);

/** Slug prefix owned by this suite. `afterAll` deletes everything under it. */
const SLUG_PREFIX = "ali176-provision";

const SLUG = `${SLUG_PREFIX}-${process.pid}`;
/** A slug this suite never provisions — used to prove a rejected run wrote nothing. */
const NEVER_PROVISIONED_SLUG = `${SLUG_PREFIX}-never-${process.pid}`;

/** The spec every successful run below provisions, all values passed as input. */
const BASE_ARGS = [
  "--slug",
  SLUG,
  "--name",
  "Provision Fixture",
  "--timezone",
  "America/New_York",
  "--currency",
  "USD",
  "--service",
  "Interview — 30 min|30|0",
  "--service",
  "Intro consultation — 30 min|30|0",
  "--rule",
  "1-5|10:00|18:00|15",
];

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the script as the operator would: a child process, its own connection.
 *
 * `env` is built explicitly rather than inherited-and-patched so each test states
 * exactly which variables were visible to the run.
 */
async function run(args: string[], env: Record<string, string>): Promise<RunResult> {
  // Built from a minimal base rather than from `process.env`, so each test's
  // `env` argument is the whole truth about what that run could see. `NODE_ENV`
  // appears only because the platform's own `ProcessEnv` type requires it.
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV,
    ...env,
  };
  try {
    const { stdout, stderr } = await exec(process.execPath, [SCRIPT, ...args], {
      env: childEnv,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** A run pointed at the disposable test database. */
function provisioningEnv(): Record<string, string> {
  return { PROVISION_DATABASE_URL: TEST_DATABASE_URL! };
}

let db: Client;

/** Row helpers. The tenant context is set per call: 0002 `force`s RLS. */
async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await db.query(sql, params);
  return result.rows as T[];
}

async function setTenant(customerId: string): Promise<void> {
  await db.query("select set_config('app.current_customer_id', $1, false)", [
    customerId,
  ]);
}

async function tenantIdBySlug(slug: string): Promise<string | undefined> {
  const rows = await query<{ id: string }>(
    "select id from public.customers where slug = $1",
    [slug],
  );
  return rows[0]?.id;
}

async function servicesOf(customerId: string) {
  await setTenant(customerId);
  return query<{
    id: string;
    name: string;
    duration_minutes: number;
    price_cents: number;
    active: boolean;
  }>(
    `select id, name, duration_minutes, price_cents, active
       from public.services where customer_id = $1 order by name`,
    [customerId],
  );
}

async function rulesOf(customerId: string) {
  await setTenant(customerId);
  return query<{ id: string; day_of_week: number; buffer_minutes: number }>(
    `select id, day_of_week, buffer_minutes
       from public.availability_rules where customer_id = $1 order by day_of_week`,
    [customerId],
  );
}

/** Delete everything this suite created, in foreign-key-safe order. */
async function destroyOwnedTenants(): Promise<void> {
  const owned = await query<{ id: string }>(
    "select id from public.customers where slug like $1",
    [`${SLUG_PREFIX}%`],
  );
  for (const { id } of owned) {
    await setTenant(id);
    // bookings first: `bookings.service_id` is `on delete restrict`, so services
    // cannot go while a booking references them.
    await query("delete from public.bookings where customer_id = $1", [id]);
    await query("delete from public.end_customers where customer_id = $1", [id]);
    await query("delete from public.services where customer_id = $1", [id]);
    await query("delete from public.availability_rules where customer_id = $1", [id]);
    await query("delete from public.customers where id = $1", [id]);
  }
}

beforeAll(async () => {
  if (!hasTestDatabase) return;
  db = new Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
  // A previous crashed run must not decide this run's counts.
  await destroyOwnedTenants();
});

afterAll(async () => {
  if (!hasTestDatabase) return;
  await destroyOwnedTenants();
  await db.end();
});

describe.skipIf(!hasTestDatabase)("provision-tenant.mjs", () => {
  // ── Criterion 1 ────────────────────────────────────────────────────────────
  it("converges on re-run and destroys no tenant-owned data", async () => {
    const first = await run(BASE_ARGS, provisioningEnv());
    expect(first.code, first.stderr).toBe(0);
    // Last line of stdout is the slug, as `seed-test-tenant.mjs` does.
    expect(first.stdout.trim().split("\n").at(-1)).toBe(SLUG);

    const customerId = await tenantIdBySlug(SLUG);
    expect(customerId).toBeDefined();

    const servicesBefore = await servicesOf(customerId!);
    const rulesBefore = await rulesOf(customerId!);
    expect(servicesBefore).toHaveLength(2);
    expect(rulesBefore).toHaveLength(5);

    // Tenant-owned data the script does not manage, created the way the app
    // creates it: a guest identity and a booking against a provisioned service.
    // This is the whole test — a delete-based converge either fails outright on
    // the `on delete restrict` from `bookings`, or takes the guest's booking
    // with it.
    const bookedService = servicesBefore[0]!;
    const [endCustomer] = await query<{ id: string }>(
      `insert into public.end_customers (customer_id, email, name)
       values ($1, $2, $3) returning id`,
      [customerId, "guest@example.test", "Real Guest"],
    );
    const [booking] = await query<{ id: string }>(
      `insert into public.bookings
         (customer_id, service_id, end_customer_id, start_time, end_time, status)
       values ($1, $2, $3, $4, $5, 'confirmed') returning id`,
      [
        customerId,
        bookedService.id,
        endCustomer!.id,
        "2026-10-05T14:00:00Z",
        "2026-10-05T14:30:00Z",
      ],
    );

    const second = await run(BASE_ARGS, provisioningEnv());
    expect(second.code, second.stderr).toBe(0);

    // Same tenant, not a second one.
    expect(await tenantIdBySlug(SLUG)).toBe(customerId);

    // Nothing accumulated.
    const servicesAfter = await servicesOf(customerId!);
    const rulesAfter = await rulesOf(customerId!);
    expect(servicesAfter).toHaveLength(2);
    expect(rulesAfter).toHaveLength(5);

    // Nothing was destroyed — the guest's booking and identity survive, by id.
    const bookingsAfter = await query<{ id: string; service_id: string }>(
      "select id, service_id from public.bookings where customer_id = $1",
      [customerId],
    );
    expect(bookingsAfter.map((b) => b.id)).toEqual([booking!.id]);
    const identitiesAfter = await query<{ id: string }>(
      "select id from public.end_customers where customer_id = $1",
      [customerId],
    );
    expect(identitiesAfter.map((c) => c.id)).toEqual([endCustomer!.id]);

    // And the catalogue kept its identity. Row *ids* are compared, not counts:
    // delete-then-reinsert would converge the counts while repointing every
    // booking at a row that no longer exists.
    expect(servicesAfter.map((s) => s.id)).toEqual(servicesBefore.map((s) => s.id));
    expect(rulesAfter.map((r) => r.id)).toEqual(rulesBefore.map((r) => r.id));
    expect(bookingsAfter[0]!.service_id).toBe(bookedService.id);
  });

  it("updates an edited spec in place rather than adding rows", async () => {
    const customerId = await tenantIdBySlug(SLUG);
    expect(customerId).toBeDefined();
    const before = await servicesOf(customerId!);
    const interviewBefore = before.find((s) => s.name.startsWith("Interview"))!;
    expect(interviewBefore.duration_minutes).toBe(30);

    const edited = await run(
      [
        "--slug",
        SLUG,
        "--name",
        "Provision Fixture",
        "--service",
        "Interview — 30 min|45|2500",
        "--service",
        "Intro consultation — 30 min|30|0",
        "--rule",
        "1-5|10:00|18:00|30",
      ],
      provisioningEnv(),
    );
    expect(edited.code, edited.stderr).toBe(0);

    const after = await servicesOf(customerId!);
    expect(after).toHaveLength(2);
    const interviewAfter = after.find((s) => s.name.startsWith("Interview"))!;
    expect(interviewAfter.id).toBe(interviewBefore.id);
    expect(interviewAfter.duration_minutes).toBe(45);
    expect(interviewAfter.price_cents).toBe(2500);

    const rules = await rulesOf(customerId!);
    expect(rules).toHaveLength(5);
    expect(rules.every((r) => r.buffer_minutes === 30)).toBe(true);

    // Put the fixture back so later tests read the free-service shape.
    const restored = await run(BASE_ARGS, provisioningEnv());
    expect(restored.code, restored.stderr).toBe(0);
    const restoredServices = await servicesOf(customerId!);
    expect(restoredServices.find((s) => s.name.startsWith("Interview"))!.price_cents).toBe(0);
  });

  it("leaves rows the spec does not mention in place, and says so", async () => {
    const customerId = await tenantIdBySlug(SLUG);
    await setTenant(customerId!);
    const [extra] = await query<{ id: string }>(
      `insert into public.services
         (customer_id, name, description, duration_minutes, price_cents, active)
       values ($1, 'Hand-added service', '', 90, 12000, true) returning id`,
      [customerId],
    );
    const [extraRule] = await query<{ id: string }>(
      `insert into public.availability_rules
         (customer_id, day_of_week, start_time, end_time, buffer_minutes)
       values ($1, 6, '09:00'::time, '12:00'::time, 0) returning id`,
      [customerId],
    );

    const result = await run(BASE_ARGS, provisioningEnv());
    expect(result.code, result.stderr).toBe(0);

    // Still there — an omission is not an instruction to delete.
    const services = await servicesOf(customerId!);
    expect(services.map((s) => s.id)).toContain(extra!.id);
    const rules = await rulesOf(customerId!);
    expect(rules.map((r) => r.id)).toContain(extraRule!.id);

    // And reported, so an operator provisioning production sees what they are
    // leaving behind rather than discovering it later.
    expect(result.stdout).toContain("Hand-added service");
    expect(result.stdout).toContain("day 6 09:00–12:00");
  });

  it("writes nothing under --dry-run", async () => {
    const result = await run(
      [...BASE_ARGS, "--slug", NEVER_PROVISIONED_SLUG, "--dry-run"],
      provisioningEnv(),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("rolled back");
    expect(await tenantIdBySlug(NEVER_PROVISIONED_SLUG)).toBeUndefined();
  });

  // ── Criterion 2 ────────────────────────────────────────────────────────────
  it("fails closed with no connection variable, and never falls back", async () => {
    // Both variables a careless script might reach for are present and point at
    // a live database. The run must still refuse.
    const result = await run([...BASE_ARGS, "--slug", NEVER_PROVISIONED_SLUG], {
      TEST_DATABASE_URL: TEST_DATABASE_URL!,
      DATABASE_URL: TEST_DATABASE_URL!,
      POSTGRES_URL: TEST_DATABASE_URL!,
    });

    expect(result.code).not.toBe(0);
    // It says which variable it wants — an operator should not have to read the
    // source to find out.
    expect(result.stderr).toContain("PROVISION_DATABASE_URL");
    // Nothing written, which is what makes criterion 1's idempotency test unable
    // to reach a database it was not deliberately pointed at.
    expect(await tenantIdBySlug(NEVER_PROVISIONED_SLUG)).toBeUndefined();
  });

  // ── Faithful rejection: the script refuses what the database refuses ───────
  it.each([
    ["a zero-minute service", ["--service", "Zero|0|0"], "durationMinutes"],
    ["a negative price", ["--service", "Negative|30|-1"], "priceCents"],
    ["an out-of-range weekday", ["--rule", "7|10:00|18:00|0"], "dayOfWeek"],
    ["an inverted time window", ["--rule", "1|18:00|10:00|0"], "startTime"],
    ["a negative buffer", ["--rule", "1|10:00|18:00|-5"], "bufferMinutes"],
    ["an unroutable slug", ["--slug", "Not A Slug"], "slug"],
    ["an invalid timezone", ["--timezone", "Mars/Olympus"], "timezone"],
    ["an unknown currency", ["--currency", "US"], "currency"],
  ])("rejects %s before opening a connection", async (_label, args, field) => {
    const result = await run(
      [...BASE_ARGS, "--slug", NEVER_PROVISIONED_SLUG, ...args],
      provisioningEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(field);
    expect(result.stderr).toContain("Nothing was written.");
    expect(await tenantIdBySlug(NEVER_PROVISIONED_SLUG)).toBeUndefined();
  });

  /**
   * The rejections above are not invented strictness: Postgres refuses the same
   * rows. Proving that keeps the script's validation a model of the database
   * rather than a second, divergent opinion — if a CHECK is ever relaxed, this
   * fails and the two are reconciled deliberately.
   */
  it("rejects the same rows the database's own CHECK constraints reject", async () => {
    const customerId = await tenantIdBySlug(SLUG);
    await setTenant(customerId!);

    // 23514 = check_violation.
    await expect(
      query(
        `insert into public.services (customer_id, name, duration_minutes, price_cents)
         values ($1, 'Zero', 0, 0)`,
        [customerId],
      ),
    ).rejects.toHaveProperty("code", "23514");

    await expect(
      query(
        `insert into public.services (customer_id, name, duration_minutes, price_cents)
         values ($1, 'Negative', 30, -1)`,
        [customerId],
      ),
    ).rejects.toHaveProperty("code", "23514");

    await expect(
      query(
        `insert into public.availability_rules
           (customer_id, day_of_week, start_time, end_time, buffer_minutes)
         values ($1, 7, '10:00'::time, '18:00'::time, 0)`,
        [customerId],
      ),
    ).rejects.toHaveProperty("code", "23514");

    await expect(
      query(
        `insert into public.availability_rules
           (customer_id, day_of_week, start_time, end_time, buffer_minutes)
         values ($1, 1, '18:00'::time, '10:00'::time, 0)`,
        [customerId],
      ),
    ).rejects.toHaveProperty("code", "23514");
  });

  // ── Structural: the convergence strategy is not the seeder's ──────────────
  it("contains no delete statement and does not reuse the e2e seeder", async () => {
    const source = await readFile(SCRIPT, "utf8");
    const executable = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    // Criterion 1 forbids the seeder's `delete from services` strategy. A
    // provisioning script with no DELETE in it cannot regress into one.
    expect(executable.toLowerCase()).not.toMatch(/\bdelete\b/);
    expect(executable).not.toContain("seed-test-tenant");
  });
});
