-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0010 — Take EXECUTE on the guest-identity RPC back off `anon`             ║
-- ║        (ALI-116; closes a drift ALI-167's own test already forbade)       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ## The finding
--
-- `public.resolve_or_create_end_customer` is `security definer` and owned by
-- `postgres`, which on hosted Supabase carries **BYPASSRLS** [verified
-- 2026-08-22 against project `xwzxigvgiqsarzfpjqkk`: `prosecdef = t`, owner
-- `postgres`, `rolsuper = f`, `rolbypassrls = t`]. Its body therefore runs
-- unfiltered by any policy, whatever client calls it, and it takes the tenant
-- as a plain `p_customer_id` argument.
--
-- `0003:86` grants EXECUTE on it to `service_role` alone. The live project
-- grants it to `anon` and `authenticated` as well [verified same date:
-- `proacl` = `postgres=X | anon=X | authenticated=X | service_role=X`], because
-- Supabase's default privileges attach at CREATE time and no migration ever
-- took them back. So the repo says one thing and the database does another, and
-- the database's version means a caller holding only the public anon key can
-- reach an RLS-bypassing function that writes to any tenant.
--
-- `guest-identity.db.test.ts` ("leaves PUBLIC no EXECUTE") has asserted
-- `anon_execute = false` since ALI-167 and stayed green only because the
-- hermetic test database did not reproduce Supabase's default privileges. Once
-- `apply-migrations.mjs` started reproducing them, the test went red — which is
-- the test doing its job on the real configuration for the first time.
--
-- ## Scope of the claim, stated honestly
--
-- What is verified is the **grant chain**: EXECUTE held by `anon` on a
-- BYPASSRLS `security definer` function in the PostgREST-exposed `public`
-- schema. What is *not* verified is an end-to-end call, because the only
-- conclusive test writes a row to production data. Supabase's OpenAPI root
-- returns zero paths for the anon key, so it settles nothing in either
-- direction. Treat this as a reachable path until someone proves otherwise in a
-- disposable project, not as a confirmed exploit.
--
-- ## Why revoke rather than harden the function
--
-- Nothing outside the server action has any business resolving a guest
-- identity: the server action is where the tenant gets resolved from the slug
-- (ALI-139) and where the request is validated. Narrowing the caller set is the
-- smaller and more reversible change; making the function safe to expose would
-- mean giving it its own authorization logic, which is what the app layer
-- already does.
--
-- ## Why `authenticated` keeps EXECUTE, and what that leaves open
--
-- `anon` is the exposure: its key ships to every browser, so anyone can present
-- it. `authenticated` is not the same shape of risk — since ALI-116 the only
-- way to hold that role is to present a token signed with `SUPABASE_JWT_SECRET`,
-- which only the server has, and the server only ever puts a `customer_id` it
-- resolved itself into one. `createBooking` calls this RPC through exactly such
-- a token, so revoking `authenticated` here would break the guest booking path
-- to close a hole `anon` already accounts for.
--
-- What that leaves open, named rather than glossed: **a tenant-scoped token is
-- not a scope on this function.** Its body ignores RLS, so a caller holding
-- tenant A's token can pass tenant B's `p_customer_id` and the function will
-- obey. Today nothing constructs that call — `createBooking` passes the same id
-- it scoped its client with — but "no caller does this" is a promise, not a
-- check. The durable fix is for the function to derive its tenant from
-- `app.current_customer_id()` instead of trusting an argument, which is a
-- behaviour change to `0003`/`0007`'s carefully-reasoned identity semantics and
-- belongs in its own issue rather than riding along here.
--
-- ⚠️ **NOT YET APPLIED to the live project.** Unlike `0009`, this file leads the
-- database rather than recording it. Applying it is a production grant change
-- on a live path and is Pedro's to make.

revoke execute on function
  public.resolve_or_create_end_customer(uuid, text, text, text)
  from anon, public;

-- Restated so the intended end state is legible in one place rather than
-- inferred from what was not revoked.
grant execute on function
  public.resolve_or_create_end_customer(uuid, text, text, text)
  to authenticated, service_role;
