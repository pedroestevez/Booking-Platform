# Booking Platform

A single, centrally-hosted, **multi-tenant** booking application. Deploy it
once; every tenant (business) gets a white-labeled booking page addressed by
slug, embeddable in their own site via iframe. Improve the app in one place
and every tenant benefits automatically — no per-tenant forks, no version
drift.

Built with **Next.js 15 (App Router) · React 19 · TypeScript (strict) ·
Tailwind CSS v4 · shadcn/ui**, backed by **Supabase** (Postgres + Row Level
Security), **Clerk** for admin auth, and **Stripe Connect** for payments.

> See [`CLAUDE.md`](./CLAUDE.md) for the full architecture, data model, and
> testing conventions.

## Features

- **Guest booking flow** — service selection → live availability calendar →
  guest details → confirmation, four steps, mobile-first.
- **Availability engine** — bookable slots are derived from weekly
  recurring rules, minus one-off blocked windows and existing bookings.
- **Per-tenant white-labeling** — each tenant's brand color re-skins the
  whole flow at runtime via a single CSS variable; no rebuild required.
- **`.ics` calendar invite** — guests can add their confirmed booking to
  their own calendar with one click; no server dependency to generate it.
- **Admin dashboard (`/admin`)** — manage services, availability rules, and
  bookings, scoped to the signed-in owner's tenant.
- **Stripe Connect onboarding** — each tenant connects their own Stripe
  Express account from `/admin/payments` and receives booking payments
  directly, with an optional platform fee.
- **Tenant data isolation via Postgres Row Level Security** — every table is
  scoped by `customer_id`, RLS is enabled *and forced* on all of them, and
  tenant identity is always set server-side, never taken from the browser.

## Getting started

```bash
npm ci
cp .env.example .env.local   # then fill in the values you need (see below)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment variables

Copy [`.env.example`](./.env.example) to `.env.local` and fill in what you
need. It's grouped by concern — Supabase (required for any real data),
Clerk (required to use `/admin`), Stripe (required to accept payments), and
the app's own canonical URL. Every value is a placeholder in the example
file; nothing in this repository is a real credential.

For a fully working local setup you'll also need a Supabase project (or a
local one via the Supabase CLI) with the schema applied — see
[`supabase/README.md`](./supabase/README.md).

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the dev server. |
| `npm run build` | Production build. |
| `npm run start` | Serve the production build. |
| `npm run lint` | ESLint (`next/core-web-vitals` + TypeScript). |
| `npm run typecheck` | `tsc --noEmit` in strict mode. |
| `npm test` | Unit + integration tests (Vitest). |
| `npm run test:e2e` | End-to-end tests (Playwright). |
| `npm run db:migrate` | Apply `supabase/migrations/*.sql` against `TEST_DATABASE_URL`. |
| `npm run db:seed` | Seed a known test tenant against `TEST_DATABASE_URL`. |

## Running the tests

`npm test` runs the Vitest suite. Most tests are pure unit tests with no
external dependencies and always run. A handful are database-backed
integration tests (they exercise real Row Level Security policies against a
live Postgres) and only run when `TEST_DATABASE_URL` is set — without it,
they skip cleanly rather than failing, so the suite stays green on a machine
with no database.

To run the full suite, including the database-backed tests, in one command
per step:

```bash
# 1. Start a disposable Postgres 16 (matches what CI uses).
docker run --rm -d --name booking-platform-test-db \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres \
  -p 5432:5432 postgres:16

# 2. Point the scripts and test harness at it.
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres

# 3. Apply migrations, then seed a test tenant.
npm run db:migrate
npm run db:seed

# 4. Run the suite — the database-backed tests now run instead of skipping.
npm test

# When done:
docker stop booking-platform-test-db
```

This is exactly what CI's `quality` job does, with a throwaway Postgres
service container instead of a local Docker one. See
[`supabase/README.md`](./supabase/README.md) for the full details, and
[`CLAUDE.md`](./CLAUDE.md) for why the harness talks to Postgres directly
(via `pg`) rather than through the Supabase client.

End-to-end tests (`npm run test:e2e`, Playwright) need a real Supabase
project and a live tenant with open availability; set `E2E_TENANT_SLUG` to
that tenant's slug, plus the Supabase/Clerk env vars. Without
`E2E_TENANT_SLUG` set, the e2e suite skips rather than failing.

## Project structure

```
src/
  app/
    page.tsx                 # platform root — tenant index
    [customerSlug]/          # per-tenant booking page (slug routing)
    admin/                   # business-owner dashboard (Clerk-protected)
  components/
    booking/                 # the guest booking flow
    admin/                   # dashboard UI
    ui/                      # shadcn/ui primitives
  lib/
    types.ts                 # domain types (mirror the DB schema)
    availability.ts          # pure slot-generation engine
    tenants.ts                # server-only tenant data access
    bookings.ts               # booking creation + slot-collision handling
    ics.ts                    # dependency-free .ics builder
    admin/                     # admin-only data access (auth, payments, bookings)
    stripe/                    # Stripe Connect helpers
    supabase/                  # Supabase client construction (server-only)
  test/
    supabase-harness.ts       # transaction-per-test DB harness
supabase/
  migrations/                # schema + RLS policies, applied in order
  seed.sql                   # demo tenants for local dev
e2e/
  booking-flow.spec.ts       # Playwright end-to-end guest flow
```

## Multi-tenancy

Everything flows through `customer_id` / per-tenant config — no tenant data
is ever hard-coded. A tenant is resolved from the URL slug on the server, its
data is read scoped to that tenant, and its branding is applied via a single
`--brand` CSS variable. Database isolation is enforced by Row Level Security
keyed on a server-set context (`app.current_customer_id`), never a
browser-supplied value. See [`supabase/README.md`](./supabase/README.md) and
[`CLAUDE.md`](./CLAUDE.md) for the full model.
