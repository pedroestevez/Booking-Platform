-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0007 — A guest identity is immutable to an anonymous request              ║
-- ║                                                                          ║
-- ║ Closes ALI-167. `resolve_or_create_end_customer` is reached from          ║
-- ║ `createBookingAction` — a server action, i.e. a public unauthenticated    ║
-- ║ HTTP endpoint — and its 0003 conflict clause was                          ║
-- ║ keep-if-blank/replace-if-provided:                                       ║
-- ║                                                                          ║
-- ║     on conflict (customer_id, email) do update                           ║
-- ║       set name  = coalesce(nullif(excluded.name, ''), …name),             ║
-- ║           phone = coalesce(excluded.phone, …phone)                        ║
-- ║                                                                          ║
-- ║ So a second booker who typed an email already known to the tenant        ║
-- ║ REPLACED the first person's stored name (any non-empty incoming name     ║
-- ║ won), and would replace their phone the moment any call site passed one. ║
-- ║ Because `bookings` references `end_customer_id` rather than carrying      ║
-- ║ loose name/email (the ALI-38 decision, 0003:38-48), and the admin views  ║
-- ║ join `guest:end_customers(name, email, phone)`, that overwrite was       ║
-- ║ RETROACTIVE: it rewrote the displayed guest name on every past booking   ║
-- ║ of that person. The owner's dashboard stopped being a record of who      ║
-- ║ booked what.                                                             ║
-- ║                                                                          ║
-- ║ Invariant: a request that has not proven control of an email address can ║
-- ║ never change the `name` or `phone` stored on that email's existing       ║
-- ║ `end_customers` row. Both legs, without exception — blank-to-populated   ║
-- ║ is still a mutation and is still out.                                    ║
-- ║                                                                          ║
-- ║ This is WITHIN-tenant integrity, not cross-tenant isolation, so no RLS   ║
-- ║ work fixes it (ALI-116 landing would not help) and single tenancy makes  ║
-- ║ it MORE likely to bite, not less: with one real tenant, the              ║
-- ║ `unique (customer_id, email)` partition that would otherwise bound the   ║
-- ║ blast radius does not exist.                                             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── What changes, and why it has to be DDL ───────────────────────────────────
-- The function goes from "insert, or update on conflict" to "resolve, or
-- insert on first contact" — it now performs NO WRITE AT ALL when the identity
-- already exists. An application-only fix was not available: the phone leg is
-- unreachable from application code (`src/lib/bookings.ts` cannot stop a
-- future caller from passing a phone, and cannot alter the `do update`
-- clause), and reading-then-writing around the RPC would reintroduce exactly
-- the race the function exists to eliminate (0003:53-54).
--
-- What the request supplied is NOT discarded — silently dropping it produces
-- the same failure from the other side (the owner prepares for the wrong
-- person with no surviving trace of the right one). The supplied values are
-- per-request facts, so they are recorded on the per-request row:
-- `bookings.custom_fields.guest_supplied`, written server-side by
-- `createBooking`. `guest_supplied` is a RESERVED, server-authoritative key —
-- `custom_fields` is browser-supplied end to end, so a browser value for that
-- key is discarded, never merged.
--
-- Out of scope, deliberately: proving that the requester CONTROLS the email
-- they typed. An anonymous actor can still attach a booking to a stranger's
-- identity by typing their address — they simply can no longer alter it. That
-- is ALI-179 (spam/impersonation), a product decision, not this migration.
-- Also out of scope but deliberately NOT precluded: a trusted "update your
-- details" path for an admin or a verified owner. Immutability here is a
-- property of THIS function, not a trigger no role can bypass, so a future
-- trusted path remains buildable.
--
-- ── How to apply this file ───────────────────────────────────────────────────
-- Apply it as ONE transaction, and only via:
--
--   npm run db:migrate         (scripts/apply-migrations.mjs wraps each file
--                              in begin/commit and aborts the run on error)
--   psql -1 -f 0007_guest_identity_no_overwrite.sql
--
-- Re-runnable: `create or replace` plus the idempotent revoke/grant below
-- leave the same single function with the same grants, and touch no row in
-- `end_customers` or `bookings`. The production apply is tracked separately as
-- ALI-178 — until that lands, this hole is closed in the repo and OPEN in
-- production.
--
-- ── Two ways a fix like this ships green with the hole still open ────────────
-- Both are invisible to every behavioural test of the new function, so the
-- self-check block at the bottom asserts them at apply time, and
-- `src/test/__tests__/guest-identity.db.test.ts` asserts them in CI:
--
--   1. A SHADOWING OVERLOAD. `create or replace function` with a *changed
--      argument list* creates a SECOND function and leaves the old 4-arg one
--      in place, still overwriting. PostgREST resolves `.rpc()` by named
--      arguments, so `src/lib/bookings.ts` would keep binding to the old
--      vulnerable one while every test of the new one passed. This file
--      therefore keeps the signature — argument names, types, order and
--      default — byte-identical to 0003:58-63. Nothing to drop; nothing to
--      re-point.
--   2. PUBLIC REGAINING EXECUTE. `create or replace` preserves privileges,
--      but `drop function` + `create` does NOT: a recreated function gets the
--      default PUBLIC EXECUTE, which would let the `anon` PostgREST role call
--      the identity RPC directly and bypass the server action entirely — a
--      strictly worse hole than the one being fixed. This file does not drop,
--      and re-asserts 0003:85-86 verbatim anyway so the end state is
--      guaranteed rather than inherited.

-- ── The function ─────────────────────────────────────────────────────────────
-- `create or replace`, NOT drop-and-create: it preserves the ACL and cannot
-- leave a second overload behind. The signature below is identical to
-- 0003:58-63 — changing even a parameter *name* would make this a new overload
-- (and Postgres would reject the replace), so it is copied exactly.
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
  v_email text := lower(p_email);
  v_id    uuid;
begin
  -- Fast path, and the whole point of this migration: an identity that already
  -- exists is READ, never written. Not "only fill the blanks", not "replace if
  -- provided" — no write at all, so there is no clause an anonymous request can
  -- steer into a mutation.
  select id into v_id
  from public.end_customers
  where customer_id = p_customer_id
    and email = v_email;

  if v_id is not null then
    return v_id;
  end if;

  -- First contact: create the identity with what the request supplied. This is
  -- the one path on which an anonymous request may set `name`/`phone`, and it
  -- is unchanged from 0003 (the insert values, including `coalesce(p_name,'')`
  -- and `lower(p_email)`, are verbatim).
  --
  -- `do nothing` rather than `do update` is the fix. It cannot mutate, and it
  -- still keeps the whole resolve-or-create atomic in one round trip: the
  -- unique index on (customer_id, email) is what arbitrates a concurrent
  -- first contact, exactly as before.
  insert into public.end_customers (customer_id, email, name, phone)
  values (p_customer_id, v_email, coalesce(p_name, ''), p_phone)
  on conflict (customer_id, email) do nothing
  returning id into v_id;

  if v_id is not null then
    return v_id;
  end if;

  -- A concurrent request created the identity between the select and the
  -- insert, so `do nothing` returned no row. Read theirs — still without
  -- writing. Non-destructive must not become non-resolving: refusing to
  -- resolve would convert a data-integrity bug into a denial of service on a
  -- legitimate returning guest.
  select id into v_id
  from public.end_customers
  where customer_id = p_customer_id
    and email = v_email;

  if v_id is null then
    -- Unreachable under READ COMMITTED (each statement in a plpgsql function
    -- takes a fresh snapshot, so the committed conflicting row is visible by
    -- now). Raised rather than returned as NULL so a stricter isolation level
    -- fails loudly and retryably here, instead of surfacing downstream as a
    -- baffling NOT NULL violation on `bookings.end_customer_id`.
    raise exception
      'resolve_or_create_end_customer: identity for (%, %) neither found nor created',
      p_customer_id, v_email
      using errcode = '40001',
            hint = 'A concurrent insert is not visible to this snapshot; retry the request.';
  end if;

  return v_id;
end;
$$;

-- ── Grants (0003:85-86, verbatim) ────────────────────────────────────────────
-- Only trusted server code (service role) may resolve identities; revoke the
-- default PUBLIC execute grant so the anon/authenticated API can't call it.
--
-- `create or replace` above already preserved these, so both statements are
-- no-ops on a database where 0003 applied cleanly. They are re-asserted so the
-- end state is guaranteed by this file rather than inherited from another —
-- including on a database where the function was at some point dropped and
-- recreated, which silently hands PUBLIC its default EXECUTE back.
revoke execute on function public.resolve_or_create_end_customer(uuid, text, text, text) from public;
grant  execute on function public.resolve_or_create_end_customer(uuid, text, text, text) to service_role;

-- ── Apply-time self-check ────────────────────────────────────────────────────
-- The two silent failure modes above, asserted where they would actually bite:
-- during the apply, inside the migration's transaction, so a bad outcome rolls
-- the whole file back instead of shipping a green hole. Cheap, and it makes the
-- production apply (ALI-178) self-verifying rather than trusting a checklist.
do $$
declare
  v_oid   oid;
  v_count int;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'resolve_or_create_end_customer';

  if v_count <> 1 then
    raise exception
      '0007: expected exactly 1 public.resolve_or_create_end_customer, found %. '
      'A second overload means PostgREST may still bind the old, overwriting one.',
      v_count;
  end if;

  select p.oid into v_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'resolve_or_create_end_customer';

  -- `has_function_privilege`, not a scan of `proacl` for an item beginning
  -- '=': a freshly recreated function has proacl NULL, which contains no such
  -- item yet still grants PUBLIC execute by default. The privilege inquiry is
  -- the only check that reads NULL correctly.
  if has_function_privilege('public', v_oid, 'EXECUTE') then
    raise exception
      '0007: PUBLIC holds EXECUTE on resolve_or_create_end_customer. The anon '
      'PostgREST role could call the identity RPC directly, bypassing the '
      'server action entirely.';
  end if;

  if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception
      '0007: service_role lost EXECUTE on resolve_or_create_end_customer — the '
      'booking write path would fail closed for every guest.';
  end if;
end
$$;
