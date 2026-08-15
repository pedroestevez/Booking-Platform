-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0002 — Row Level Security                                                  ║
-- ║                                                                            ║
-- ║ Tenant identity is NEVER taken from the browser. It comes from a           ║
-- ║ server-set context GUC, `app.current_customer_id`, which trusted          ║
-- ║ server-side code sets per request/transaction:                            ║
-- ║                                                                            ║
-- ║     select set_config('app.current_customer_id', '<uuid>', true);         ║
-- ║     -- (true = local to the current transaction)                          ║
-- ║                                                                            ║
-- ║ The service-role key (server-only) bypasses RLS to bootstrap the          ║
-- ║ slug → customer lookup, then sets the context for everything after.       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create schema if not exists app;

-- Resolves the active tenant from the server-set GUC. Returns NULL when unset
-- (so policies fail closed — no context means no rows). STABLE: constant within
-- a statement. Lives in `app` so it can't be confused with table columns.
create or replace function app.current_customer_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.current_customer_id', true), '')::uuid;
$$;

grant usage on schema app to anon, authenticated, service_role;
grant execute on function app.current_customer_id() to anon, authenticated, service_role;

-- ── Enable + force RLS on every table ────────────────────────────────────────
-- A table without RLS is publicly readable via the API. FORCE applies the
-- policies even to the table owner (defense in depth).
alter table public.customers          enable row level security;
alter table public.services           enable row level security;
alter table public.availability_rules enable row level security;
alter table public.bookings           enable row level security;
alter table public.blocked_slots      enable row level security;

alter table public.customers          force row level security;
alter table public.services           force row level security;
alter table public.availability_rules force row level security;
alter table public.bookings           force row level security;
alter table public.blocked_slots      force row level security;

-- ── customers ────────────────────────────────────────────────────────────────
-- Scoped by the row's own id matching the active tenant.
drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers
  for select using (id = app.current_customer_id());

drop policy if exists customers_insert on public.customers;
create policy customers_insert on public.customers
  for insert with check (id = app.current_customer_id());

drop policy if exists customers_update on public.customers;
create policy customers_update on public.customers
  for update using (id = app.current_customer_id())
            with check (id = app.current_customer_id());

drop policy if exists customers_delete on public.customers;
create policy customers_delete on public.customers
  for delete using (id = app.current_customer_id());

-- ── services ─────────────────────────────────────────────────────────────────
drop policy if exists services_select on public.services;
create policy services_select on public.services
  for select using (customer_id = app.current_customer_id());

drop policy if exists services_insert on public.services;
create policy services_insert on public.services
  for insert with check (customer_id = app.current_customer_id());

drop policy if exists services_update on public.services;
create policy services_update on public.services
  for update using (customer_id = app.current_customer_id())
            with check (customer_id = app.current_customer_id());

drop policy if exists services_delete on public.services;
create policy services_delete on public.services
  for delete using (customer_id = app.current_customer_id());

-- ── availability_rules ───────────────────────────────────────────────────────
drop policy if exists availability_rules_select on public.availability_rules;
create policy availability_rules_select on public.availability_rules
  for select using (customer_id = app.current_customer_id());

drop policy if exists availability_rules_insert on public.availability_rules;
create policy availability_rules_insert on public.availability_rules
  for insert with check (customer_id = app.current_customer_id());

drop policy if exists availability_rules_update on public.availability_rules;
create policy availability_rules_update on public.availability_rules
  for update using (customer_id = app.current_customer_id())
            with check (customer_id = app.current_customer_id());

drop policy if exists availability_rules_delete on public.availability_rules;
create policy availability_rules_delete on public.availability_rules
  for delete using (customer_id = app.current_customer_id());

-- ── bookings ─────────────────────────────────────────────────────────────────
drop policy if exists bookings_select on public.bookings;
create policy bookings_select on public.bookings
  for select using (customer_id = app.current_customer_id());

drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings
  for insert with check (customer_id = app.current_customer_id());

drop policy if exists bookings_update on public.bookings;
create policy bookings_update on public.bookings
  for update using (customer_id = app.current_customer_id())
            with check (customer_id = app.current_customer_id());

drop policy if exists bookings_delete on public.bookings;
create policy bookings_delete on public.bookings
  for delete using (customer_id = app.current_customer_id());

-- ── blocked_slots ────────────────────────────────────────────────────────────
drop policy if exists blocked_slots_select on public.blocked_slots;
create policy blocked_slots_select on public.blocked_slots
  for select using (customer_id = app.current_customer_id());

drop policy if exists blocked_slots_insert on public.blocked_slots;
create policy blocked_slots_insert on public.blocked_slots
  for insert with check (customer_id = app.current_customer_id());

drop policy if exists blocked_slots_update on public.blocked_slots;
create policy blocked_slots_update on public.blocked_slots
  for update using (customer_id = app.current_customer_id())
            with check (customer_id = app.current_customer_id());

drop policy if exists blocked_slots_delete on public.blocked_slots;
create policy blocked_slots_delete on public.blocked_slots
  for delete using (customer_id = app.current_customer_id());
