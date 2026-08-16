-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0006 — No overlapping bookings (enforced by the database)                ║
-- ║                                                                          ║
-- ║ Closes the double-booking race. `createBooking` regenerates the day's    ║
-- ║ open slots, checks the chosen one is still free, and then inserts — a    ║
-- ║ read-check-then-write with nothing holding the slot in between. Two      ║
-- ║ concurrent requests both pass the check and both insert. No amount of    ║
-- ║ application code can close that window; only the database can.           ║
-- ║                                                                          ║
-- ║ Invariant: for any `customer_id`, no two bookings with                   ║
-- ║ `status <> 'cancelled'` have overlapping [start_time, end_time) ranges.  ║
-- ║                                                                          ║
-- ║   • btree_gist — lets one GiST exclusion constraint combine equality on  ║
-- ║     a scalar (`customer_id with =`) with overlap on a range (`&&`).      ║
-- ║     Without it `customer_id with =` has no GiST operator class and the   ║
-- ║     constraint cannot be created.                                        ║
-- ║   • tstzrange(start_time, end_time) takes its default `[)` bounds, and   ║
-- ║     that is load-bearing: back-to-back bookings, where one ends exactly  ║
-- ║     when the next starts, must stay legal.                               ║
-- ║   • The `where (status <> 'cancelled')` predicate exempts cancelled      ║
-- ║     bookings and nothing else. A cancelled slot frees up; a pending one  ║
-- ║     does not.                                                            ║
-- ║                                                                          ║
-- ║ Violations surface as SQLSTATE 23P01 (exclusion_violation). The insert   ║
-- ║ path in `src/lib/bookings.ts` translates that one code into the same     ║
-- ║ friendly "pick another time" message the pre-check already produces,     ║
-- ║ and lets every other error propagate unchanged — a real fault must       ║
-- ║ never be disguised as a scheduling message.                              ║
-- ║                                                                          ║
-- ║ The read side must agree with this predicate: `getUpcomingBookings` in   ║
-- ║ `src/lib/tenants.ts` subtracts `status <> 'cancelled'` bookings from the ║
-- ║ slot grid. If it filtered to a narrower set, the difference would render ║
-- ║ as bookable ghost slots that the constraint then rejects at submit time. ║
-- ║ That equality is asserted in `booking-overlap.db.test.ts` (criterion 8). ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── How to apply this file ───────────────────────────────────────────────────
-- Apply it as ONE transaction, and only via:
--
--   npm run db:migrate         (scripts/apply-migrations.mjs wraps each file
--                              in begin/commit and aborts the run on error)
--   psql -1 -f 0006_booking_overlap_constraint.sql
--
-- Never paste the statements in one at a time, and never run them through a
-- console that autocommits per statement. The "no partial state" guarantee
-- below is a property of the transaction, not of the statements: applied
-- separately, `create extension` can commit while `add constraint` fails, and
-- the database is left half-migrated.
--
-- This file deliberately does NOT contain its own `begin;` / `commit;`. The
-- migration runner already opens a transaction per file, so an inner `begin`
-- would be a no-op warning and the inner `commit` would end the runner's
-- transaction early — defeating the very guarantee it looks like it adds.

-- ── Idempotency and rollback ─────────────────────────────────────────────────
-- `add constraint` has no `if not exists` form, so the guard below checks
-- pg_constraint first. That keeps `npm run db:migrate` re-runnable against a
-- database that already carries the constraint, and it means a half-applied
-- file (see above) heals itself on the next run instead of erroring forever.
--
-- To roll back:
--
--   alter table public.bookings drop constraint bookings_no_overlap;
--
-- Leave the extension in place. `drop extension btree_gist` would CASCADE to
-- the constraint's GiST index and drop the constraint with it — a much wider
-- blast radius than intended, and it breaks any other btree_gist user.

-- ── Locking: this is not an online migration ─────────────────────────────────
-- `add constraint ... exclude` takes an ACCESS EXCLUSIVE lock on `bookings`
-- and holds it while it builds the GiST index and validates every existing
-- row. Reads and writes to `bookings` block for the duration. Postgres has no
-- `concurrently` path for EXCLUDE constraints, so this cannot be avoided —
-- only scheduled.
--
-- Apply during low traffic, and keep `lock_timeout` set (below) so the
-- statement fails fast rather than queueing behind a long-running transaction
-- while every booking request piles up behind it. A timeout is SQLSTATE 55P03;
-- the transaction rolls back and the migration can simply be retried.

-- ── Before applying to a database that already holds bookings ────────────────
-- `alter table … add constraint` validates every existing row. If any overlap
-- is already stored, the statement fails with 23P01 and the schema is left
-- unchanged — there is no partial state, so rolling back is a no-op. Run the
-- detection query below against the target database first and resolve any hits
-- by hand; it must return zero rows. The same query is the standing check for
-- the invariant above, on any environment, at any time.
--
--   select a.id as a_id, b.id as b_id, a.customer_id, a.start_time, a.end_time
--   from public.bookings a
--   join public.bookings b
--     on a.customer_id = b.customer_id
--    and a.id < b.id
--    and a.status <> 'cancelled'
--    and b.status <> 'cancelled'
--    and tstzrange(a.start_time, a.end_time) && tstzrange(b.start_time, b.end_time);
--
-- !! A zero-row result is only trustworthy if the reading role can see every
-- row. `bookings` has FORCE row level security and its policies key off the
-- `app.current_customer_id` GUC (see 0002). A role without BYPASSRLS, with no
-- GUC set, reads ZERO rows from a table full of overlaps — a false all-clear
-- that sends you straight into a failed ALTER. Establish visibility first:
--
--   select current_user,
--          (select rolbypassrls from pg_roles where rolname = current_user);
--
-- and/or run a positive control that MUST be non-zero on a populated database:
--
--   select count(*) from public.bookings;
--
-- If the count is zero on a database you know has bookings, you are reading
-- through RLS: reconnect as a BYPASSRLS role (or the table owner) and re-run.
-- `booking-overlap.db.test.ts` asserts the detection query does surface a
-- known-dirty pair, so a silently-always-empty query fails the suite.

-- Fail fast instead of queueing behind a long transaction while `bookings` is
-- locked. `local` scopes it to this migration's transaction.
set local lock_timeout = '3s';

-- Equality on a scalar column inside a GiST index. Not installed by 0001.
create extension if not exists btree_gist;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'bookings_no_overlap'
      and conrelid = 'public.bookings'::regclass
  ) then
    alter table public.bookings
      add constraint bookings_no_overlap
      exclude using gist (
        customer_id with =,
        tstzrange(start_time, end_time) with &&
      ) where (status <> 'cancelled');
  end if;
end
$$;
