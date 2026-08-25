-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0011 — customers.custom_domain: drop the hard-coded platform domain       ║
-- ║                                                                           ║
-- ║ `customers_custom_domain_not_platform_host` (migration 0008) named one     ║
-- ║ specific deployment's production domain as a SQL literal, alongside the    ║
-- ║ two structural rules. The literal is removed here; `localhost` and         ║
-- ║ `%.vercel.app` stay.                                                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── Why a literal was the wrong place for it ────────────────────────────────
-- A deployment's own production domain is configuration. Baked into a check
-- constraint it can only be changed by a migration, it is wrong for every
-- other deployment of this schema (a fork, a second environment, a rename),
-- and — the reason it is being removed now — it publishes that domain to
-- everyone who reads the repository.
--
-- The app-side rule moved to `PLATFORM_HOSTS` (see `platformSharedHosts()` in
-- `src/lib/request-host.ts`). Postgres cannot read that environment, so the
-- constraint keeps only what is true of ANY deployment of this app.
--
-- ── What this costs, stated plainly ────────────────────────────────────────
-- 0008's point 3 (NEVER A PLATFORM HOST) had two enforcement layers for the
-- configured domain: this constraint, and `isPlatformSharedHost`. After this
-- migration the configured domain is enforced by the app layer alone. The
-- guarantee itself is intact, because the app layer is the one that decides
-- reachability: `isPlatformSharedHost` is checked BEFORE `getTenantByHost`
-- (see `src/app/page.tsx`), so a row storing the platform's own domain is
-- never consulted rather than being consulted and winning. The constraint was
-- the backstop against a bad *write*; the short-circuit is what makes the bad
-- write harmless. `scripts/provision-tenant.mjs` — the only writer of this
-- column today — reads `PLATFORM_HOSTS` and still rejects it outright.
--
-- The two structural values keep their constraint because they need no
-- configuration to be known: `localhost` is never a public tenant domain, and
-- `%.vercel.app` hosts belong to the deployment platform, not to a tenant.
--
-- ── Idempotent from either starting point ──────────────────────────────────
-- Production applied 0008 when it still carried the literal, so the live
-- constraint has the three-way body. A database migrated from scratch after
-- this change gets 0008's two-way body (its `if not exists` guard means the
-- name is taken either way). Dropping and recreating unconditionally lands
-- both on the same definition, and `if exists` makes a re-run a no-op.

alter table public.customers
  drop constraint if exists customers_custom_domain_not_platform_host;

alter table public.customers
  add constraint customers_custom_domain_not_platform_host
    check (
      custom_domain is null
      or (
        custom_domain <> 'localhost'
        and custom_domain not like '%.vercel.app'
      )
    );

-- ── Apply-time self-check ───────────────────────────────────────────────────
-- 0008 asserts what it guarantees at apply time; this migration changes one of
-- those guarantees, so it re-asserts the narrowed version rather than leaving
-- 0008's (still name-based, and therefore still satisfied) check to stand in.
--
-- Asserted by reading the constraint's own definition rather than by trying an
-- insert: `customers` carries `force row level security`, so a probe insert
-- either needs a BYPASSRLS role or fails with `insufficient_privilege` — an
-- error that looks nothing like the rejection being tested for, and would turn
-- this self-check into a coin flip on which role ran the migration. The
-- definition text is the thing that drifted; check that directly, and write
-- nothing.
do $$
declare
  def text;
begin
  select pg_get_constraintdef(oid) into def
  from pg_constraint
  where conname = 'customers_custom_domain_not_platform_host'
    and conrelid = 'public.customers'::regclass
    and contype = 'c';

  if def is null then
    raise exception
      '0011: check constraint customers_custom_domain_not_platform_host is '
      'missing after being recreated. The drop above must be paired with the '
      'add; without it a *.vercel.app host could be stored, silently making '
      'that tenant unreachable via BOTH the slug route and the shared host.';
  end if;

  -- The two structural rules must both survive the rewrite.
  if def not like '%localhost%' or def not like '%.vercel.app%' then
    raise exception
      '0011: customers_custom_domain_not_platform_host no longer covers both '
      'structural hosts. Definition is: %', def;
  end if;

  -- And the point of the migration: no deployment-specific domain literal is
  -- left in the constraint. Anything beyond the two structural rules means the
  -- drop-and-recreate did not take, or a later edit reintroduced one.
  if (
    select count(*)
    from regexp_matches(def, '''[^'']+''', 'g')
  ) <> 2 then
    raise exception
      '0011: customers_custom_domain_not_platform_host carries a literal '
      'other than the two structural hosts — a deployment domain belongs in '
      'PLATFORM_HOSTS, not in this constraint. Definition is: %', def;
  end if;
end
$$;
