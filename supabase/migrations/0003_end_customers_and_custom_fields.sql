-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0003 — Unified end-customer identity + per-vertical custom fields           ║
-- ║                                                                            ║
-- ║ Implements the data-architecture decision (Linear ALI-38): one shared      ║
-- ║ Postgres isolated by `customer_id` + RLS, a unified per-tenant identity     ║
-- ║ table, and JSONB for variable per-vertical intake — not DB-per-tenant,      ║
-- ║ not endless columns, not EAV.                                               ║
-- ║                                                                            ║
-- ║   • end_customers — the GUEST as a reusable identity, keyed per tenant by   ║
-- ║     email. Future orders/courses reference the same person.                ║
-- ║   • bookings.end_customer_id — replaces the loose customer_email/_name.     ║
-- ║   • bookings.custom_fields — JSONB intake (e.g. bags/passengers, pet        ║
-- ║     breed) that varies by vertical: data, not new columns.                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── end_customers ─────────────────────────────────────────────────────────────
-- A guest of a tenant. Unique per tenant by email so the same person resolves to
-- one identity across bookings (and, later, orders/courses). `metadata` holds
-- non-identifying profile extras without schema churn.
create table if not exists public.end_customers (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers (id) on delete cascade,
  email        text not null,
  name         text not null default '',
  phone        text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  constraint end_customers_customer_email_unique unique (customer_id, email)
);

-- Non-negotiable: index every column used in an RLS policy (customer_id first).
-- The (customer_id, email) unique above already serves resolve-by-email lookups.
create index if not exists end_customers_customer_id_idx on public.end_customers (customer_id);

-- ── bookings: reference the identity, add per-vertical intake ──────────────────
-- The guest's identity now lives in end_customers; bookings point at it rather
-- than carrying loose name/email. `custom_fields` captures variable intake.
alter table public.bookings
  add column if not exists end_customer_id uuid references public.end_customers (id) on delete restrict;

alter table public.bookings
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

-- Greenfield: no existing bookings, so the loose columns can go and
-- end_customer_id becomes mandatory.
alter table public.bookings drop column if exists customer_email;
alter table public.bookings drop column if exists customer_name;
alter table public.bookings alter column end_customer_id set not null;

create index if not exists bookings_end_customer_id_idx on public.bookings (end_customer_id);

-- ── Resolve-or-create helper ──────────────────────────────────────────────────
-- Atomically returns the end_customer for (tenant, email), creating it on first
-- contact and refreshing name/phone on return visits. One round trip, no race.
-- Lives in `public` so trusted server code can reach it via PostgREST `.rpc()`.
-- SECURITY DEFINER so it can write past RLS; it scopes every write to the passed
-- customer_id (callers pass the server-resolved tenant id, never browser input).
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
as $$
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
$$;

-- Only trusted server code (service role) may resolve identities; revoke the
-- default PUBLIC execute grant so the anon/authenticated API can't call it.
revoke execute on function public.resolve_or_create_end_customer(uuid, text, text, text) from public;
grant execute on function public.resolve_or_create_end_customer(uuid, text, text, text) to service_role;

-- ── Row Level Security (mirrors 0002) ─────────────────────────────────────────
-- A table without RLS is publicly readable through the auto-generated API.
alter table public.end_customers enable row level security;
alter table public.end_customers force  row level security;

drop policy if exists end_customers_select on public.end_customers;
create policy end_customers_select on public.end_customers
  for select using (customer_id = app.current_customer_id());

drop policy if exists end_customers_insert on public.end_customers;
create policy end_customers_insert on public.end_customers
  for insert with check (customer_id = app.current_customer_id());

drop policy if exists end_customers_update on public.end_customers;
create policy end_customers_update on public.end_customers
  for update using (customer_id = app.current_customer_id())
            with check (customer_id = app.current_customer_id());

drop policy if exists end_customers_delete on public.end_customers;
create policy end_customers_delete on public.end_customers
  for delete using (customer_id = app.current_customer_id());
