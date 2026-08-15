-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0004 — Tenant membership (business-owner ↔ tenant mapping)                  ║
-- ║                                                                            ║
-- ║ The /admin dashboard authenticates business owners with Clerk. Auth is     ║
-- ║ deliberately decoupled from RLS: the app never passes an end-user JWT to    ║
-- ║ PostgREST. Instead the server resolves the signed-in Clerk user to a        ║
-- ║ tenant via this table, then keeps using the existing pattern — the          ║
-- ║ service-role client + per-`customer_id` scoping (and the                    ║
-- ║ `app.current_customer_id()` GUC as defense-in-depth).                       ║
-- ║                                                                            ║
-- ║   • auth_subject — the external auth identity (Clerk user id, "user_…").    ║
-- ║     A user may belong to more than one tenant (unique per tenant).          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists public.tenant_members (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers (id) on delete cascade,
  auth_subject text not null,
  email        text not null,
  role         text not null default 'owner'
                 check (role in ('owner', 'admin', 'staff')),
  created_at   timestamptz not null default now(),
  constraint tenant_members_customer_subject_unique unique (customer_id, auth_subject)
);

-- Resolve-by-subject is the hot path (every admin request): index it. The
-- customer_id index keeps the RLS predicate cheap (non-negotiable per CLAUDE.md).
create index if not exists tenant_members_auth_subject_idx on public.tenant_members (auth_subject);
create index if not exists tenant_members_customer_id_idx  on public.tenant_members (customer_id);

-- ── Row Level Security (mirrors the other tenant tables) ──────────────────────
-- The server-side service-role client bypasses RLS to resolve subject → tenant
-- (the one lookup that can't yet be customer-scoped, like the slug lookup);
-- these policies are defense-in-depth for any anon/authenticated API surface.
alter table public.tenant_members enable row level security;
alter table public.tenant_members force  row level security;

drop policy if exists tenant_members_select on public.tenant_members;
create policy tenant_members_select on public.tenant_members
  for select using (customer_id = app.current_customer_id());

drop policy if exists tenant_members_insert on public.tenant_members;
create policy tenant_members_insert on public.tenant_members
  for insert with check (customer_id = app.current_customer_id());

drop policy if exists tenant_members_update on public.tenant_members;
create policy tenant_members_update on public.tenant_members
  for update using (customer_id = app.current_customer_id())
            with check (customer_id = app.current_customer_id());

drop policy if exists tenant_members_delete on public.tenant_members;
create policy tenant_members_delete on public.tenant_members
  for delete using (customer_id = app.current_customer_id());
