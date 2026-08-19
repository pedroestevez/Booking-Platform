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
| `migrations/0008_custom_domain.sql` | Adds a nullable `customers.custom_domain` column plus a unique index, so a tenant can be resolved by request host as well as by slug. Foundation only — see below. Part of ALI-115. |
| `seed.sql` | Two demo tenants + their services/availability, for local dev and demos. |

### Custom domains (ALI-115) are a database column, not a DNS action

`migrations/0008_custom_domain.sql` and `scripts/provision-tenant.mjs`'s
`--custom-domain` flag only ever write `customers.custom_domain` — a text
value the app can later match a request host against. Neither one calls
Vercel, a registrar, or any DNS API. Actually serving a tenant on
`booking.<their-domain>.com` still requires two manual, out-of-band ops steps
that happen outside this repo: adding the domain to the Vercel project (so
Vercel accepts and routes the incoming host), and the tenant (or whoever
manages their DNS) pointing a `CNAME`/`A` record at Vercel. Until both of
those are done by hand, setting `custom_domain` in the database has no
externally visible effect — it just makes the row ready for the day
middleware (a later phase) starts resolving tenants by host.

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
# Required. Must name BOTH a host and a database — there is no fallback, and a
# degenerate value like `postgres://` is rejected rather than completed from the
# ambient PGHOST/PGUSER/PGDATABASE. Needs a role with BYPASSRLS (see below).
export PROVISION_DATABASE_URL='postgresql://user:pass@host:5432/dbname'

# Always dry-run first: does every read and write, then rolls back.
node scripts/provision-tenant.mjs --dry-run

# The P4 draft, with each value overridable. --confirm is required to commit.
node scripts/provision-tenant.mjs --confirm \
  --slug pedroestevez --name 'Pedro Estevez' \
  --timezone America/New_York --currency USD \
  --service 'Interview — 30 min|30|0' \
  --service 'Intro consultation — 30 min|30|0' \
  --rule '1-5|10:00|18:00|15'

node scripts/provision-tenant.mjs --help     # full flag list
node scripts/provision-tenant.mjs --spec tenant.json --confirm
```

Five properties matter more than the flags:

- **It deletes nothing.** `customers` is matched on its unique `slug`,
  `services` on `(customer_id, name)`, `availability_rules` on
  `(customer_id, day_of_week, start_time, end_time)`; each match is an update,
  each miss an insert. Rows the spec does not mention are reported and left in
  place. This is why it is a separate script from `scripts/seed-test-tenant.mjs`,
  whose convergence is `delete from services` — fine for a throwaway CI
  database, data loss for a real tenant (and blocked outright by
  `bookings.service_id`'s `on delete restrict` the moment one booking exists).
- **The defaults are a CREATE template, not an UPDATE instruction.** On a tenant
  that already exists, only what *this invocation* supplied is written: an
  unsupplied `branding_json` key, `name`, service list or rule list is left
  byte-identical. The built-in P4 draft fills a tenant being created and nothing
  else. Without that distinction every re-run rewrote `timezone`, `currency`,
  `brandColor` and `name` from the draft — silently moving every slot and every
  confirmed booking for an owner who had corrected their timezone. Deleting
  nothing is not enough; a converging writer must also preserve every column it
  does not mean to write.
- **It fails closed on the connection.** `PROVISION_DATABASE_URL` and nothing
  else: no `DATABASE_URL`, no `TEST_DATABASE_URL`, no localhost default, and no
  completing a partial URL from `PG*`. Unset or degenerate means a non-zero exit
  before a socket opens. After connecting it also compares `current_database()`
  with the database the variable named and refuses to write on a mismatch. The
  connection string itself is never printed — it can carry a credential in the
  userinfo *or* in a `?password=` parameter — so the run reports `database=`,
  `role=` and `bypassrls=` from the server instead.
- **Committing is opt-in.** `--dry-run` writes nothing; anything else needs
  `--confirm`. And creating a tenant under a slug other than the draft's
  requires explicit `--service` and `--rule`: inheriting the draft's free,
  active services would publish a bookable calendar nobody configured, and a
  free service books as `confirmed`.
- **It validates before it connects.** Slug shape, IANA timezone, ISO 4217
  currency, `duration_minutes > 0`, `price_cents >= 0`, `day_of_week` 0–6,
  `start_time < end_time`, `buffer_minutes >= 0`, and no duplicate convergence
  keys. The numeric rules mirror migration 0001's CHECK constraints, so an
  invalid spec is rejected with a named field instead of a driver error — and
  `src/test/__tests__/provision-tenant.db.test.ts` asserts Postgres rejects the
  same rows, so the two cannot drift apart silently.

**Run it with a `BYPASSRLS` role.** `0002_rls_policies.sql` uses `force row
level security`, which applies the policies to the table owner too — so
ownership is *not* sufficient. The tenant lookup by slug necessarily runs before
`app.current_customer_id` can be set (the id is what it is looking up), so a
role without `BYPASSRLS` sees no rows, takes the create path, and fails on the
unique `slug` with a 23505. That is fail-closed and self-diagnosing, but it
cannot converge: a re-run against production needs `BYPASSRLS` (CI's superuser,
Supabase's `postgres`). The script warns at startup when the role lacks it.

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
