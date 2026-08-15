#!/usr/bin/env node
// scripts/seed-test-tenant.mjs — ALI-114
//
// Idempotently seeds ONE tenant for CI/e2e use against `TEST_DATABASE_URL`:
//
//   - a tenant with slug `e2e-test-tenant`
//   - one active 60-minute service
//   - availability rules covering all SEVEN days of the week, 00:00–23:59,
//     buffer 0 — so a bookable slot exists no matter what day (or hour) CI
//     happens to run.
//
// Idempotent: re-running against the same database converges to the same
// state (upserts the tenant by its unique slug, then replaces its services
// and availability rules) rather than accumulating duplicates on every run.
//
// Prints the tenant slug on success as the last line of stdout, so callers
// can capture it, e.g.:
//   E2E_TENANT_SLUG=$(node scripts/seed-test-tenant.mjs | tail -1)

import { Client } from "pg";

const TENANT_SLUG = "e2e-test-tenant";
const TENANT_NAME = "E2E Test Tenant";
const SERVICE_NAME = "E2E Test Service";
const SERVICE_DURATION_MINUTES = 60;
const SERVICE_PRICE_CENTS = 5000; // $50.00 — arbitrary, non-zero.

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "seed-test-tenant: TEST_DATABASE_URL is not set. Point it at a " +
        "disposable Postgres database (never production) and re-run.",
    );
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("begin");

    const { rows } = await client.query(
      `insert into public.customers (name, slug)
       values ($1, $2)
       on conflict (slug) do update set name = excluded.name
       returning id`,
      [TENANT_NAME, TENANT_SLUG],
    );
    const customerId = rows[0].id;

    // Neither table has a natural unique key to upsert on (by design — a
    // tenant can have many services/rules with the same shape), so idempotency
    // here means re-deriving both from scratch for this one tenant, inside the
    // same transaction as the insert above.
    await client.query("delete from public.services where customer_id = $1", [
      customerId,
    ]);
    await client.query(
      "delete from public.availability_rules where customer_id = $1",
      [customerId],
    );

    await client.query(
      `insert into public.services
         (customer_id, name, description, duration_minutes, price_cents, active)
       values ($1, $2, $3, $4, $5, true)`,
      [
        customerId,
        SERVICE_NAME,
        "Seeded for CI end-to-end tests.",
        SERVICE_DURATION_MINUTES,
        SERVICE_PRICE_CENTS,
      ],
    );

    // All seven days (0=Sunday .. 6=Saturday), midnight to one minute before
    // midnight, no buffer: a bookable slot exists whatever day CI runs on.
    await client.query(
      `insert into public.availability_rules
         (customer_id, day_of_week, start_time, end_time, buffer_minutes)
       select $1, d, '00:00', '23:59', 0
       from generate_series(0, 6) as d`,
      [customerId],
    );

    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    console.error("seed-test-tenant: FAILED to seed the test tenant.");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  } finally {
    await client.end();
  }

  console.log(TENANT_SLUG);
}

main().catch((err) => {
  console.error("seed-test-tenant: unexpected failure");
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
