-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0008 — customers.custom_domain (ALI-211)                                   ║
-- ║                                                                            ║
-- ║ Lets a tenant be resolved by HTTP Host instead of only by `/<slug>`, so    ║
-- ║ `booking.pedroestevez.com/` renders that tenant directly — no slug in the  ║
-- ║ URL — while `booking.aligncompass.com/<slug>` is completely unaffected.    ║
-- ║ This migration adds the column and its constraints ONLY; the read path     ║
-- ║ (`getTenantByHost`) and page wiring live in application code, and no admin ║
-- ║ UI writes this column yet (that is ALI-212, domain ownership verification, ║
-- ║ which has to land first).                                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── Why this column is a hijack primitive, and what closes it ────────────────
-- `custom_domain` is compared directly against an inbound `Host`/
-- `x-forwarded-host` header (`src/lib/request-host.ts`,
-- `getTenantByHost` in `src/lib/tenants.ts`) to decide WHICH TENANT'S DATA a
-- request at `/` sees — services, availability, upcoming bookings, branding.
-- Get any of the three properties below wrong and a value in this column
-- becomes a way to point another tenant's traffic at yourself, to make two
-- tenants silently share one identity, or to make a tenant's booking page
-- unreachable by either URL:
--
--   1. UNIQUENESS. Two `customers` rows sharing one `custom_domain` would make
--      `getTenantByHost`'s `.maybeSingle()` resolve nondeterministically
--      between them (whichever Postgres happens to return), so a host that was
--      supposed to identify one tenant's booking page could unpredictably
--      serve another tenant's services, availability and upcoming bookings —
--      the same class of cross-tenant leak the `customers.slug` unique
--      constraint already prevents for the path-based route. This migration
--      closes the identical gap for the host-based route.
--   2. NORMALIZED FORM. Header comparison happens after
--      `resolveRequestHost()` lowercases and trims the incoming value (hosts
--      are case-insensitive per RFC 4343, and browsers/proxies normalize case
--      themselves — but nothing guarantees an operator typing a value into
--      this column does). Allowing `Booking.Example.com` and
--      `booking.example.com` to both exist would let a second row claim what
--      is, at the HTTP layer, the same host the first row already claims —
--      defeating point 1 without ever tripping a duplicate-key error, since
--      the two strings are byte-distinct. The lowercase check constraint below
--      makes the column's own byte representation the normalized form, so the
--      partial unique index can actually enforce uniqueness of the HOST, not
--      merely of one spelling of it.
--   3. NEVER A PLATFORM HOST. `src/lib/request-host.ts`'s `isPlatformSharedHost`
--      treats `booking.aligncompass.com`, `localhost`, and every `*.vercel.app`
--      host as never a tenant's `custom_domain` — `getTenantByHost` is never
--      even called for those hosts, `/` skips straight to the shared landing
--      page. If one of them were EVER stored here anyway (this column has no
--      request-facing writer today, but the constraint should not depend on
--      that staying true), the affected tenant becomes unreachable by BOTH
--      routes at once: `/<slug>` on that host permanently-redirects to `/`
--      (`tenant.customDomain === host`), and `/` on that same host never
--      resolves a tenant to redirect *to*, because the shared-host
--      short-circuit runs first. That is an availability bug, not a data leak
--      — no other tenant's data is exposed — but it is silent (no error,
--      just a booking page that quietly stops resolving) and this migration
--      is the one place positioned to make it impossible rather than merely
--      unlikely. The check constraint below is the DB-level mirror of
--      `isPlatformSharedHost`; keep the two in sync by hand — Postgres has no
--      way to import a TypeScript predicate.
--
-- Nullable, because most tenants have none (the `customer_id` there is
-- resolved from `/<slug>` and never touches this column) — the partial index
-- (`where custom_domain is not null`) is what lets many rows share `NULL`
-- while still forbidding any two from sharing a real value.
--
-- ── Precedent ──────────────────────────────────────────────────────────────
-- Plain `alter table ... add column`, matching 0005_stripe_connect.sql's
-- style for adding columns to `customers` outside a full-table rewrite.
-- `add column if not exists` / `add constraint` guarded by the self-check
-- below (rather than `if not exists` on the constraint, which Postgres does
-- not support) keeps this file re-runnable the same way 0005 is.
--
-- ── Explicitly out of scope here ─────────────────────────────────────────────
-- No RLS change: `customers` policies (0002) are keyed on `customers.id`, and
-- `getTenantByHost`, like `getTenantBySlug`, must use the service-role client
-- because the tenant is not known yet — there is no `customer_id` to satisfy
-- an RLS predicate with. No admin UI, no domain-ownership verification
-- (ALI-212) — this column is populated only by `scripts/provision-tenant.mjs`
-- until that lands.
--
-- ── How to apply this file ───────────────────────────────────────────────────
--   npm run db:migrate     (scripts/apply-migrations.mjs; each file runs in
--                           its own begin/commit and aborts the run on error)
--   psql -1 -f 0008_custom_domain.sql
--
-- Re-runnable: `if not exists` on the column and the index, and the
-- self-check below tolerates the constraint already existing. Applying this
-- to production is a separate, later step by someone else — this PR is the
-- schema + application code only.

alter table public.customers
  add column if not exists custom_domain text;

-- See "NORMALIZED FORM" above: the column's own bytes must already be the
-- normalized (lowercased) form `resolveRequestHost()` produces, or the
-- partial unique index below only enforces uniqueness of one spelling.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'customers_custom_domain_lowercase'
      and conrelid = 'public.customers'::regclass
  ) then
    alter table public.customers
      add constraint customers_custom_domain_lowercase
        check (custom_domain is null or custom_domain = lower(custom_domain));
  end if;
end
$$;

-- See "NEVER A PLATFORM HOST" above — the DB-level mirror of
-- `isPlatformSharedHost` in src/lib/request-host.ts. Runs after the lowercase
-- constraint above (both are checked on every write regardless of order, but
-- this one's error message assumes an already-lowercased value, since a
-- caller failing the lowercase check fails on that constraint first).
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'customers_custom_domain_not_platform_host'
      and conrelid = 'public.customers'::regclass
  ) then
    alter table public.customers
      add constraint customers_custom_domain_not_platform_host
        check (
          custom_domain is null
          or (
            custom_domain <> 'booking.aligncompass.com'
            and custom_domain <> 'localhost'
            and custom_domain not like '%.vercel.app'
          )
        );
  end if;
end
$$;

-- See "UNIQUENESS" above. Partial (`where custom_domain is not null`) so any
-- number of tenants may share the common case of having none.
create unique index if not exists customers_custom_domain_key
  on public.customers (custom_domain) where custom_domain is not null;

-- ── Apply-time self-check ────────────────────────────────────────────────────
-- Asserts the three things this migration exists to guarantee, at apply time,
-- inside the migration's own transaction — so a bad outcome rolls the whole
-- file back instead of shipping a green hole. Mirrors 0007's convention.
do $$
declare
  v_col_type text;
begin
  select data_type into v_col_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'customers'
    and column_name = 'custom_domain';

  if v_col_type is null then
    raise exception '0008: public.customers.custom_domain does not exist.';
  end if;
  if v_col_type <> 'text' then
    raise exception
      '0008: public.customers.custom_domain has type %, expected text.', v_col_type;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'customers_custom_domain_lowercase'
      and conrelid = 'public.customers'::regclass
      and contype = 'c'
  ) then
    raise exception
      '0008: check constraint customers_custom_domain_lowercase is missing. '
      'Without it, two differently-cased spellings of the same host could '
      'both be stored, defeating the partial unique index below.';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'customers_custom_domain_not_platform_host'
      and conrelid = 'public.customers'::regclass
      and contype = 'c'
  ) then
    raise exception
      '0008: check constraint customers_custom_domain_not_platform_host is '
      'missing. Without it, a value like booking.aligncompass.com or a '
      '*.vercel.app host could be stored, silently making that tenant '
      'unreachable via BOTH the slug route (permanently-redirects to /) and '
      'the shared host (never resolves a tenant to redirect to).';
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'customers'
      and indexname = 'customers_custom_domain_key'
  ) then
    raise exception
      '0008: unique index customers_custom_domain_key is missing. Without it, '
      'two customers rows could share one custom_domain, and '
      'getTenantByHost would resolve a Host header to whichever tenant '
      'Postgres happened to return.';
  end if;
end
$$;
