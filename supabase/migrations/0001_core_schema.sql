-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0001 — Core schema                                                         ║
-- ║ Five tenant-isolated tables for the booking platform.                      ║
-- ║ Every row is scoped by `customer_id`; RLS + policies live in 0002.         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ── customers ────────────────────────────────────────────────────────────────
-- The tenant. `slug` addresses the booking page at /<slug>. `branding_json`
-- holds white-label config (brand color, logo, tagline, currency, timezone).
create table if not exists public.customers (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text not null unique,
  branding_json       jsonb not null default '{}'::jsonb,
  stripe_customer_id  text,
  created_at          timestamptz not null default now()
);

-- ── services ─────────────────────────────────────────────────────────────────
create table if not exists public.services (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references public.customers (id) on delete cascade,
  name             text not null,
  description      text not null default '',
  duration_minutes integer not null check (duration_minutes > 0),
  price_cents      integer not null check (price_cents >= 0),
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

-- ── availability_rules ───────────────────────────────────────────────────────
-- Weekly recurring open hours. Concrete slots are derived from these minus
-- blocked_slots and existing bookings.
create table if not exists public.availability_rules (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references public.customers (id) on delete cascade,
  day_of_week     smallint not null check (day_of_week between 0 and 6),
  start_time      time not null,
  end_time        time not null,
  buffer_minutes  integer not null default 0 check (buffer_minutes >= 0),
  created_at      timestamptz not null default now(),
  constraint availability_rules_time_order check (start_time < end_time)
);

-- ── bookings ─────────────────────────────────────────────────────────────────
-- A reservation. `customer_email`/`customer_name` are the GUEST's details (per
-- the agreed schema); the owning tenant is `customer_id`.
create table if not exists public.bookings (
  id                        uuid primary key default gen_random_uuid(),
  customer_id               uuid not null references public.customers (id) on delete cascade,
  service_id                uuid not null references public.services (id) on delete restrict,
  start_time                timestamptz not null,
  end_time                  timestamptz not null,
  customer_email            text not null,
  customer_name             text not null,
  notes                     text,
  status                    text not null default 'pending'
                              check (status in ('pending', 'confirmed', 'cancelled', 'completed')),
  stripe_payment_intent_id  text,
  created_at                timestamptz not null default now(),
  constraint bookings_time_order check (end_time > start_time)
);

-- ── blocked_slots ────────────────────────────────────────────────────────────
-- One-off windows (holidays, breaks) that override availability.
create table if not exists public.blocked_slots (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers (id) on delete cascade,
  start_time   timestamptz not null,
  end_time     timestamptz not null,
  reason       text,
  created_at   timestamptz not null default now(),
  constraint blocked_slots_time_order check (end_time > start_time)
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- Non-negotiable: index every column used in an RLS policy (customer_id first).
-- The policies in 0002 filter exclusively on customer_id (and customers.id,
-- already covered by its primary key).
create index if not exists services_customer_id_idx           on public.services (customer_id);
create index if not exists availability_rules_customer_id_idx  on public.availability_rules (customer_id);
create index if not exists bookings_customer_id_idx            on public.bookings (customer_id);
create index if not exists blocked_slots_customer_id_idx       on public.blocked_slots (customer_id);

-- Practical composite/secondary indexes for the common access patterns.
create index if not exists services_customer_active_idx        on public.services (customer_id, active);
create index if not exists availability_rules_customer_day_idx on public.availability_rules (customer_id, day_of_week);
create index if not exists bookings_customer_start_idx         on public.bookings (customer_id, start_time);
create index if not exists bookings_service_id_idx             on public.bookings (service_id);
create index if not exists blocked_slots_customer_start_idx    on public.blocked_slots (customer_id, start_time);
