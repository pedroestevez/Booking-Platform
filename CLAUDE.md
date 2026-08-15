# CLAUDE.md — Booking Platform

This file orients an AI coding agent (or a new contributor) working in this
repository. It describes what the app is, how it's built, and the
non-negotiable rules that keep multi-tenant data isolated.

## What this is

A single, centrally-hosted, **multi-tenant** booking application: service
selection → live availability calendar → guest details → **Stripe** payment →
confirmation with a downloadable `.ics` calendar invite, plus a business-owner
`/admin` dashboard (services, availability, bookings, Stripe Connect payout
setup). One deployment serves every tenant — improve it once, every tenant
benefits automatically.

Quality bar: it should feel like a high-end SaaS product — premium,
white-labeled, fast, accessible, and excellent on mobile.

## Stack

- **Next.js 15 (App Router) + React 19 + TypeScript (strict).** A live
  calendar, payments, auth, and a dashboard are an *application*, not static
  content — Next.js gives the React runtime, server actions, and SSR for it.
- **Tailwind CSS v4 + shadcn/ui (Radix primitives)** for the UI.
- **Supabase** (PostgreSQL + Row Level Security). The app talks to it
  exclusively through `@supabase/supabase-js` (PostgREST) — never a raw
  Postgres wire connection from application code.
- **Clerk** for business-owner auth on `/admin`. The customer-facing booking
  flow (and its iframe embed) is intentionally Clerk-free — see the auth
  section below.
- **Stripe** (Connect, Express accounts) for multi-tenant payments.
- **date-fns** for date handling.

## Integration model — one deployment, many tenants

Hosted once, addressed per tenant by slug: `<your-domain>/<tenant-slug>`. A
consuming site embeds it via a responsive **iframe** or a dedicated `/book`
page/link. One deploy upgrades every tenant — no per-site code, no version
drift. (A distributable package or framework island would require updating
every embedding site individually to ship an improvement, which breaks that
guarantee.)

Each tenant's brand color re-skins the whole booking flow at runtime via a
single `--brand` CSS variable driven by `branding_json` — no rebuild, no
per-tenant fork.

## Auth model

- **`/admin`** (business-owner dashboard): **Clerk**. A signed-in Clerk user
  is mapped to the tenant(s) they manage via the `tenant_members` table
  (migration `0004`) — `auth_subject` (Clerk user id) → `customer_id`.
- **The booking flow itself has no end-user auth.** Guests are identified by
  email through `end_customers` (see data model below), not by signing in.
- Auth is **decoupled from Row Level Security**. The app never passes an
  end-user JWT to PostgREST. RLS is driven entirely server-side: trusted
  server code resolves the current tenant, sets the `app.current_customer_id`
  context GUC for the transaction, and the service-role client (which
  bypasses RLS by design) does the actual reads/writes, filtered by
  `customer_id` in application code as well. RLS is defense in depth on top
  of the app's own scoping, not the sole gate on it — but it is never
  optional; see below.

## Data model (Supabase / Postgres)

Every row is isolated by `customer_id` (UUID → `customers`, the tenant). Seven
tables, built up across migrations `0001`–`0005`:

| Table | Purpose |
| --- | --- |
| `customers` | The tenant. `slug` addresses the booking page at `/<slug>`. `branding_json` holds white-label config (brand color, tagline, currency, timezone). Also carries `stripe_account_id`, `stripe_charges_enabled`, `platform_fee_bps` for Stripe Connect (migration `0005`). |
| `services` | `id, customer_id, name, description, duration_minutes, price_cents, active`. |
| `availability_rules` | Weekly recurring open hours: `id, customer_id, day_of_week, start_time, end_time, buffer_minutes`. Concrete bookable slots are derived from these minus `blocked_slots` and existing `bookings`. |
| `end_customers` | The guest as a **reusable identity**, unique per tenant by email (`unique (customer_id, email)`) so repeat bookings resolve to the same person. `resolve_or_create_end_customer()` (migration `0003`) does the atomic lookup-or-insert. |
| `bookings` | `id, customer_id, service_id, end_customer_id, start_time, end_time, notes, status, custom_fields, stripe_payment_intent_id`. References `end_customer_id` (not a loose name/email pair). `custom_fields` JSONB holds variable per-vertical intake (e.g. party size, pet breed) as data, not new columns. `status` ∈ `pending / confirmed / cancelled / completed`. |
| `blocked_slots` | One-off windows (holidays, breaks) that override availability: `id, customer_id, start_time, end_time, reason`. |
| `tenant_members` | Maps a signed-in admin (Clerk `auth_subject`) to a tenant they manage: `id, customer_id, auth_subject, email, role`. `role` ∈ `owner / admin / staff`. `unique (customer_id, auth_subject)`. |

Data-architecture choices, for context: one shared Postgres + RLS (not
DB-per-tenant), `custom_fields` JSONB for per-vertical variability (not EAV,
not a NoSQL store), and a unified `end_customers` identity so a guest's
history follows them across bookings within a tenant.

### RLS non-negotiables

- **RLS is enabled *and forced* on every table** (`force row level security`
  — policies apply even to the table owner, which is what makes isolation
  tests meaningful rather than tautological). A table without RLS is publicly
  readable through the auto-generated PostgREST API.
- **`USING` for reads/deletes, `WITH CHECK` for writes; `UPDATE` needs both.**
- **Index every column used in an RLS policy** (`customer_id` first).
- **Tenant identity comes from a server-side context GUC**
  (`app.current_customer_id()`), set per-transaction by trusted server code —
  **never** a browser-supplied value. With no context set, the function
  returns `NULL` and every policy fails closed (no rows leak).
- **Also filter by `customer_id` in application code** — defense in depth and
  clear intent, on top of (not instead of) RLS.
- **The service-role key is server-only**, never sent to the browser or
  imported into a Client Component. It bypasses RLS to do the one lookup that
  can't yet be tenant-scoped (the slug → tenant lookup), after which the
  request context is set and further access is policy-enforced.

## Testing conventions

- **Vitest** for unit + integration tests (`npm test`). Config excludes `e2e/`
  so the fast suite stays fast; `TZ=UTC` is pinned via the npm script so
  timezone-sensitive availability logic is deterministic across machines.
- **Database-backed tests use a transaction-per-test harness**
  (`src/test/supabase-harness.ts`): each test runs inside a transaction that
  is *always* rolled back in a `finally`, so tests share one database without
  leaking state — including on a failing assertion. It connects via `pg`
  directly (not the Supabase JS client) because RLS testing needs to set the
  `app.current_customer_id` GUC transaction-locally and have later statements
  in the *same* session observe it; the Supabase client's HTTP/PostgREST calls
  are each their own implicit transaction, so there's nothing to hold or roll
  back.
- **Hermetic CI database**: the CI `quality` job runs a throwaway `postgres:16`
  service container — created and destroyed with the job, no persistent
  state, no secret backing it. Before tests run, `npm run db:migrate` applies
  every `supabase/migrations/*.sql` file from scratch (so a broken migration
  fails CI loudly) and `npm run db:seed` creates one known tenant with
  availability wide enough that a bookable slot exists regardless of what day
  CI runs. `TEST_DATABASE_URL` then points the harness at that database so
  its DB-backed tests run for real instead of self-skipping. Without
  `TEST_DATABASE_URL` set (e.g. running locally with no Postgres up), those
  tests skip rather than fail — an honest skip, not a false green. See
  `supabase/README.md` for the one-command local reproduction.
- **Playwright** for end-to-end tests (`npm run test:e2e`), separate from the
  hermetic-database job above: the app talks to Supabase exclusively through
  PostgREST, which a bare `postgres:16` container doesn't provide, so e2e
  targets a real Supabase preview project via repository secrets/variables
  instead. The suite skips (rather than fails) when `E2E_TENANT_SLUG` isn't
  set.

## Principles

Favor composition and reusability — improve the shared system, never
hard-code tenant data (everything flows through `customer_id` and config).
Make it feel expensive: smooth, instant, trustworthy. Think long-term
maintainability over one-off fixes.
