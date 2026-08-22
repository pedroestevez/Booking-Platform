-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0009 — Tenant identity from the JWT `customer_id` claim (ALI-116)         ║
-- ║                                                                          ║
-- ║ Implements the ALI-138 decision (mechanism #1, "JWT claim"). The 28       ║
-- ║ policies created by 0002/0003/0004 all call `app.current_customer_id()`,  ║
-- ║ so redefining that one function switches every one of them at once — no   ║
-- ║ policy is touched here.                                                   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ## Why this exists
--
-- `0002` resolved the tenant from `current_setting('app.current_customer_id')`
-- — a GUC that trusted server code was supposed to set per transaction. The app
-- reaches Postgres only through PostgREST, where **each call is its own
-- transaction**, so a transaction-local GUC dies before the query it was meant
-- to scope, and a session-local one leaks to the next request on a pooled
-- connection. ALI-138 recorded the decision to move to a signed JWT claim; this
-- is the migration that makes the database read it.
--
-- Until this ran, the policies were live but **inert**: nothing in the request
-- path ever set the GUC, so `app.current_customer_id()` returned NULL for every
-- caller and every policy failed closed. See ALI-150 and the vault note
-- "A positive control must cover the reader, not the data".
--
-- ## The three behaviours this definition buys
--
-- 1. **GUC keeps precedence.** `coalesce(GUC, claim)` — so the direct-`pg` test
--    harness (`src/test/supabase-harness.ts`), which sets the GUC
--    transaction-locally, keeps working unchanged, and ALI-138's option #3
--    (direct Postgres on the request path) stays available without another
--    migration.
-- 2. **A malformed claim denies rather than raises.** A bare `v::uuid` on
--    attacker-influenced text raises `22P02`, which PostgREST returns as a 500
--    — an error where the correct answer is "no rows". The regex guard makes a
--    malformed claim resolve to NULL, so every policy fails closed instead.
-- 3. **`set search_path = ''`** so neither `auth.jwt` nor any operator in the
--    body can be shadowed by a schema a caller controls.
--
-- ## Applied out of band — recorded here after the fact
--
-- This SQL was applied to the live project (`xwzxigvgiqsarzfpjqkk`) from a
-- session with no repo access on 2026-08-22, and the database ran ahead of the
-- repo until this file landed. It is `create or replace`, so re-applying it is
-- a no-op against a database that already has it.
--
-- **Naming correction.** The remote migration history records this as
-- `0007_tenant_identity_from_jwt_claim`, but `0007` and `0008` were already
-- taken in this tree (`0007_guest_identity_no_overwrite`,
-- `0008_custom_domain`). The file is therefore `0009`: `apply-migrations.mjs`
-- applies files in filename order, and a duplicate `0007` would make that order
-- ambiguous. The remote label is the one that is wrong; it is left alone rather
-- than rewritten, because the applied SQL is identical either way.

create or replace function app.current_customer_id()
returns uuid language sql stable set search_path = ''
as $$
  select case when v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then v::uuid end
  from (select coalesce(
                 nullif(current_setting('app.current_customer_id', true), ''),
                 nullif(auth.jwt() ->> 'customer_id', '')
               ) as v) s;
$$;
