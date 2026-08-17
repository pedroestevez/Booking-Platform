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
/** A second, non-draft tenant, for the "does not inherit the draft catalogue" case. */
const NON_DRAFT_SLUG = `${SLUG_PREFIX}-acme-${process.pid}`;

/**
 * The spec every successful run below provisions, all values passed as input.
 *
 * `--confirm` is part of it because committing is opt-in since the security
 * pass (S4): a bare invocation must not be a complete production write.
 */
const BASE_ARGS = [
  "--confirm",
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

  // ── Criterion 1, column preservation (security pass round 1, S1) ──────────
  /**
   * The round-1 blocker, and the generalised lesson with it: **a converging
   * writer must be tested for preservation of every column it writes, not only
   * for row-count and row-id stability.**
   *
   * The first round's teeth asserted that `bookings` and `end_customers` rows
   * survive, and they did. One column over, every re-run silently rewrote
   * `branding_json.timezone`, `currency`, `brandColor` and `name` — because the
   * P4 draft sat at the floor of the precedence chain and was therefore never
   * "absent from the spec", so the `||` merge that protects an unmentioned
   * `logoUrl` protected none of them. An owner who corrected their timezone in
   * `/admin` had it reset by the next `--service` run: every slot and every
   * already-`confirmed` booking shifted, exit 0, no warning.
   *
   * So this asserts the whole row, not a chosen key: `branding_json` is compared
   * as its **serialized text**, which is what makes "byte-identical" literal
   * rather than a spot-check of the keys someone thought to name.
   */
  it("preserves every branding key and column the invocation did not supply", async () => {
    const customerId = await tenantIdBySlug(SLUG);
    expect(customerId).toBeDefined();
    await setTenant(customerId!);

    // Stand in for the owner editing their own configuration after
    // provisioning: a non-default timezone, a hand-set logo, a custom colour, a
    // different currency, and a display name nobody passed on the command line.
    await query(
      `update public.customers
          set name = $2,
              branding_json = branding_json || $3::jsonb
        where id = $1`,
      [
        customerId,
        "Owner Edited Name",
        JSON.stringify({
          timezone: "America/Los_Angeles",
          currency: "EUR",
          brandColor: "oklch(0.7 0.2 30)",
          logoUrl: "https://cdn.example.test/logo.png",
        }),
      ],
    );

    const [before] = await query<{ branding: string; name: string }>(
      "select branding_json::text as branding, name from public.customers where id = $1",
      [customerId],
    );

    // A re-run that supplies nothing about the tenant itself — the documented,
    // expected way to touch the catalogue and nothing else.
    const rerun = await run(["--confirm", "--slug", SLUG], provisioningEnv());
    expect(rerun.code, rerun.stderr).toBe(0);

    const [after] = await query<{ branding: string; name: string }>(
      "select branding_json::text as branding, name from public.customers where id = $1",
      [customerId],
    );

    expect(after!.branding).toBe(before!.branding);
    expect(after!.name).toBe(before!.name);
    // And it says so, rather than reporting a write it did not make.
    expect(rerun.stdout).toContain("tenant unchanged");

    // The catalogue is not silently rewritten either: an unsupplied service list
    // means "leave it", not "converge it to the draft". Same failure, one table
    // over — a run meant to fix a tagline would otherwise reset every price.
    expect(rerun.stdout).toContain("no services supplied");
    expect(rerun.stdout).toContain("no availability rules supplied");

    // The discriminating control: preservation must not be "the script does
    // nothing". Supplying one key writes exactly that key and leaves the rest.
    const targeted = await run(
      ["--confirm", "--slug", SLUG, "--timezone", "Europe/Madrid"],
      provisioningEnv(),
    );
    expect(targeted.code, targeted.stderr).toBe(0);

    const [patched] = await query<{ branding: Record<string, string>; name: string }>(
      "select branding_json as branding, name from public.customers where id = $1",
      [customerId],
    );
    expect(patched!.branding.timezone).toBe("Europe/Madrid");
    expect(patched!.branding.currency).toBe("EUR");
    expect(patched!.branding.brandColor).toBe("oklch(0.7 0.2 30)");
    expect(patched!.branding.logoUrl).toBe("https://cdn.example.test/logo.png");
    expect(patched!.name).toBe("Owner Edited Name");

    // Restore the fixture for the tests that follow.
    const restored = await run(BASE_ARGS, provisioningEnv());
    expect(restored.code, restored.stderr).toBe(0);
  });

  it("updates an edited spec in place rather than adding rows", async () => {
    const customerId = await tenantIdBySlug(SLUG);
    expect(customerId).toBeDefined();
    const before = await servicesOf(customerId!);
    const interviewBefore = before.find((s) => s.name.startsWith("Interview"))!;
    expect(interviewBefore.duration_minutes).toBe(30);

    const edited = await run(
      [
        "--confirm",
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

  // ── Criterion 1 / S4: creating is opt-in, and never inherits the draft ────
  it("refuses to commit without --confirm", async () => {
    // A bare invocation used to be a complete, valid production write.
    const result = await run(
      BASE_ARGS.filter((a) => a !== "--confirm"),
      provisioningEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--confirm");
    expect(result.stderr).toContain("Nothing was written.");
  });

  it("refuses to create a non-draft tenant from the draft catalogue", async () => {
    // The S4 scenario exactly: a new tenant, a name, and a forgotten --service.
    // Inheriting the draft would give them two active `price_cents = 0`
    // services — which, since criterion 4, book as `confirmed` — on a calendar
    // nobody configured.
    const result = await run(
      ["--confirm", "--slug", NON_DRAFT_SLUG, "--name", "Acme Legal"],
      provisioningEnv(),
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--service");
    expect(await tenantIdBySlug(NON_DRAFT_SLUG)).toBeUndefined();

    // Supplying them explicitly is allowed — the refusal is about inheritance,
    // not about non-draft tenants.
    const explicit = await run(
      [
        "--confirm",
        "--slug",
        NON_DRAFT_SLUG,
        "--name",
        "Acme Legal",
        "--service",
        "Consultation|60|15000",
        "--rule",
        "2|09:00|17:00|0",
      ],
      provisioningEnv(),
    );
    expect(explicit.code, explicit.stderr).toBe(0);
    const acmeId = await tenantIdBySlug(NON_DRAFT_SLUG);
    expect(acmeId).toBeDefined();
    const acmeServices = await servicesOf(acmeId!);
    expect(acmeServices.map((s) => s.name)).toEqual(["Consultation"]);
    expect(acmeServices[0]!.price_cents).toBe(15000);
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

  /**
   * Criterion 2, the set-but-degenerate case (security pass round 1, S2).
   *
   * `if (!databaseUrl)` only proves the variable is non-empty. `postgres://` is
   * truthy, and node-postgres then fills host, user and database from ambient
   * `PGHOST`/`PGUSER`/`PGDATABASE` — a fallback by another name, and exactly
   * what the guard's own error text promises does not happen. The realistic
   * shape is a secret template that renders empty (`postgres://$DB_SECRET` with
   * the secret unset) inside a container whose `PG*` point at production.
   */
  it.each([
    ["no host", "postgres://"],
    ["no host but a database", "postgres:///somedb"],
    ["no database", "postgres://127.0.0.1:5432"],
    ["not a URL at all", "this is not a url"],
    ["the wrong scheme", "mysql://127.0.0.1:5432/somedb"],
  ])(
    "refuses a connection variable naming %s, with PG* pointed at a live database",
    async (_label, value) => {
      const ambient = new URL(TEST_DATABASE_URL!);
      const result = await run(
        [...BASE_ARGS, "--slug", NEVER_PROVISIONED_SLUG],
        {
          PROVISION_DATABASE_URL: value,
          // A live, working target reachable entirely from libpq's env vars.
          PGHOST: ambient.hostname,
          PGPORT: ambient.port,
          PGUSER: decodeURIComponent(ambient.username),
          PGPASSWORD: decodeURIComponent(ambient.password),
          PGDATABASE: ambient.pathname.replace(/^\//, ""),
        },
      );

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("PROVISION_DATABASE_URL");
      expect(result.stderr).toContain("Nothing was written.");
      // The assertion that matters: no tenant reached the database the variable
      // never named.
      expect(await tenantIdBySlug(NEVER_PROVISIONED_SLUG)).toBeUndefined();
    },
  );

  /**
   * The connection string never reaches a log (security pass round 1, S3).
   *
   * `redact()` rewrote `url.password` — the `user:pass@host` userinfo form — but
   * libpq and `pg-connection-string` also accept `?password=`, which sailed
   * through and printed a working credential on line 1 of stdout, into CI job
   * logs and any log shipper. Secrets live in env, never in logs.
   */
  it("never prints a credential carried in the connection string", async () => {
    const ambient = new URL(TEST_DATABASE_URL!);
    const password = decodeURIComponent(ambient.password);
    const queryParamUrl =
      `postgresql://${ambient.username}@${ambient.hostname}:${ambient.port}` +
      `${ambient.pathname}?password=${encodeURIComponent(password)}`;

    const result = await run(
      [...BASE_ARGS, "--slug", NEVER_PROVISIONED_SLUG, "--dry-run"],
      { PROVISION_DATABASE_URL: queryParamUrl },
    );

    // It authenticated — otherwise "no credential in the output" would be true
    // for the boring reason that nothing worked, and the test would pass
    // forever while proving nothing.
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("connected to database=");
    expect(password).not.toBe("");

    const output = `${result.stdout}\n${result.stderr}`;

    // Asserted as "no connection string is printed" rather than "this password
    // string is absent", deliberately. Scanning for the value alone is unstable
    // in both directions — a harness password may legitimately equal another
    // token in the output (locally it equals the role name), and a *redacted*
    // URL would pass a value-scan while still publishing the host, user and
    // database. No scheme token means no URL in any form, which is the property
    // that actually holds the guarantee, and it covers the `?password=` form
    // `redact()` missed as well as the `user:pass@host` form it handled.
    expect(output).not.toMatch(/postgres(ql)?:\/\//);
    expect(output).not.toContain("password");
    expect(output).not.toContain(queryParamUrl);

    // What an operator actually needs is reported instead, and from the server's
    // own answer rather than from the string they typed.
    expect(result.stdout).toContain(
      `database=${ambient.pathname.replace(/^\//, "")}`,
    );
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
