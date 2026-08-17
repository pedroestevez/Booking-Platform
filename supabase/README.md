# Supabase schema

SQL migrations for the booking platform's Postgres database. The app now reads
services + availability and writes bookings through this database (the old
`src/lib/mock-data.ts` is gone). Configure `.env.local` from `.env.example`.

## Files

| File | Purpose |
| --- | --- |
| `migrations/0001_core_schema.sql` | The five core tenant-isolated tables + indexes. |
| `migrations/0002_rls_policies.sql` | RLS enabled/forced on every table + per-command policies. |
| `migrations/0003_end_customers_and_custom_fields.sql` | Unified per-tenant `end_customers` identity (bookings reference `end_customer_id`), `bookings.custom_fields` JSONB for per-vertical intake, and the atomic `resolve_or_create_end_customer()` helper. Implements the ALI-38 data-architecture decision. |
| `migrations/0004_tenant_members.sql` | Maps a signed-in admin (Clerk `auth_subject`) to the tenant(s) they manage. |
| `migrations/0005_stripe_connect.sql` | Per-tenant Stripe Connect (Express) account columns on `customers`. |
| `migrations/0007_guest_identity_no_overwrite.sql` | Makes an existing `end_customers` row immutable to the anonymous booking path: `resolve_or_create_end_customer()` now resolves-or-creates and never updates, so a second booker who types a known email can no longer overwrite that guest's stored `name`/`phone` (which, because bookings reference `end_customer_id`, rewrote the guest name on their past bookings too). What the request supplied is recorded on the booking instead, under the reserved server-authoritative `custom_fields.guest_supplied` key. Closes ALI-167. |
| `seed.sql` | Two demo tenants + their services/availability, for local dev and demos. |

## Applying

With the [Supabase CLI](https://supabase.com/docs/guides/local-development):

```bash
supabase start          # local stack
supabase db reset       # runs migrations/ then seed.sql
```

Against a hosted project: `supabase db push`.

## Hermetic test database (ALI-114)

CI's `quality` job runs the migrations from scratch against a throwaway
`postgres:16` **service container** (not the Supabase CLI stack — a plain
Postgres, created and destroyed with the job) and seeds one known tenant, so
the Vitest DB harness (`src/test/supabase-harness.ts`) and its tests run for
real instead of self-skipping. See `.github/workflows/ci.yml` for the exact
steps and `scripts/apply-migrations.mjs` / `scripts/seed-test-tenant.mjs` for
what each does.

### Reproducing it locally, in one command per step

You need Docker and Node (the repo's usual toolchain — no new dependency;
both scripts use the `pg` package already in `devDependencies`).

```bash
# 1. Start a disposable Postgres 16, matching CI's service container exactly.
docker run --rm -d --name booking-platform-test-db \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres \
  -p 5432:5432 postgres:16

# 2. Point the scripts at it (same value CI uses).
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres

# 3. Apply migrations, then seed the e2e-test-tenant fixture.
npm run db:migrate
npm run db:seed

# 4. Run the suite — the DB-backed harness tests now run instead of skipping.
npm test

# When done:
docker stop booking-platform-test-db
```

This reproduces exactly what CI does: `db:migrate` applies every
`supabase/migrations/*.sql` file in filename order (failing loudly, naming
the file, on any error), and `db:seed` idempotently creates a tenant with
slug `e2e-test-tenant`, one active 60-minute service, and availability rules
covering all seven days 00:00–23:59 with no buffer, so a bookable slot exists
regardless of the day you run it.

**This does not stand up PostgREST.** The scripts and the test harness talk
to Postgres directly via `pg`; the Next.js app itself talks to Supabase
through `@supabase/supabase-js` (PostgREST) and still needs a real Supabase
project's URL/keys in `.env.local` to run (see `.env.example`) — a raw
`postgres:16` container cannot serve the app layer. That's also why the
Playwright e2e job in CI is unchanged by this: it still targets a real
Supabase preview project via repository secrets.

## Provisioning a real tenant (ALI-176)

`scripts/provision-tenant.mjs` provisions **one** tenant — its `customers` row,
its `services`, and its `availability_rules` — from values passed in. It is the
mechanism ALI-177 P5 fires at production once Pedro confirms P4's content
inputs; **nothing in ALI-176 runs it against production**.

```bash
export PROVISION_DATABASE_URL='postgresql://…'   # required; no fallback

# Always dry-run first: does every read and write, then rolls back.
node scripts/provision-tenant.mjs --dry-run

# The P4 draft, with each value overridable:
node scripts/provision-tenant.mjs \
  --slug pedroestevez --name 'Pedro Estevez' \
  --timezone America/New_York --currency USD \
  --service 'Interview — 30 min|30|0' \
  --service 'Intro consultation — 30 min|30|0' \
  --rule '1-5|10:00|18:00|15'

node scripts/provision-tenant.mjs --help     # full flag list
node scripts/provision-tenant.mjs --spec tenant.json
```

Three properties matter more than the flags:

- **It deletes nothing.** `customers` is matched on its unique `slug`,
  `services` on `(customer_id, name)`, `availability_rules` on
  `(customer_id, day_of_week, start_time, end_time)`; each match is an update,
  each miss an insert, and `branding_json` is merged rather than replaced. Rows
  the spec does not mention are reported and left in place. This is why it is a
  separate script from `scripts/seed-test-tenant.mjs`, whose convergence is
  `delete from services` — fine for a throwaway CI database, data loss for a
  real tenant (and blocked outright by `bookings.service_id`'s
  `on delete restrict` the moment one booking exists).
- **It fails closed on the connection.** `PROVISION_DATABASE_URL` and nothing
  else: no `DATABASE_URL`, no `TEST_DATABASE_URL`, no localhost default. Unset
  means exit 1 before a socket opens.
- **It validates before it connects.** Slug shape, IANA timezone, ISO 4217
  currency, `duration_minutes > 0`, `price_cents >= 0`, `day_of_week` 0–6,
  `start_time < end_time`, `buffer_minutes >= 0`, and no duplicate convergence
  keys. The numeric rules mirror migration 0001's CHECK constraints, so an
  invalid spec is rejected with a named field instead of a driver error — and
  `src/test/__tests__/provision-tenant.db.test.ts` asserts Postgres rejects the
  same rows, so the two cannot drift apart silently.

It also sets `app.current_customer_id` as soon as the tenant id is known, so it
works whether or not the connecting role holds `BYPASSRLS`. A role that reads
through RLS cannot see an existing tenant, so the run would try to insert one —
the unique index on `slug` turns that into a loud error naming the cause rather
than a duplicate.

## Tenancy & security model

Every row is isolated by `customer_id`. The non-negotiables from `CLAUDE.md`:

- **RLS is enabled _and_ forced on every table.** A table without RLS is
  publicly readable through the auto-generated API.
- **Tenant identity is server-set, never browser-supplied.** Policies read the
  active tenant from a context GUC via `app.current_customer_id()`. Trusted
  server code sets it per transaction:

  ```sql
  select set_config('app.current_customer_id', '<tenant-uuid>', true);
  ```

  With no context set, the function returns `NULL` and every policy **fails
  closed** — no rows leak.
- **Writes are checked.** `SELECT`/`DELETE` use `USING`; `INSERT` uses
  `WITH CHECK`; `UPDATE` uses both.
- **Every column used in a policy is indexed** (`customer_id` first).
- **The service-role key is server-only.** It bypasses RLS to bootstrap the
  `slug → customer` lookup, after which the request context is set and all
  further access is policy-enforced. Defense in depth: app code _also_ filters
  by `customer_id`.
