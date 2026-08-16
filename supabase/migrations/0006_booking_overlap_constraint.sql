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
-- ║ Forward-only: `add constraint` has no `if not exists` form, so this      ║
-- ║ file is applied once against a database that does not already carry      ║
-- ║ `bookings_no_overlap`.                                                   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── Before applying to a database that already holds bookings ─────────────
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

-- Equality on a scalar column inside a GiST index. Not installed by 0001.
create extension if not exists btree_gist;

alter table public.bookings
  add constraint bookings_no_overlap
  exclude using gist (
    customer_id with =,
    tstzrange(start_time, end_time) with &&
  ) where (status <> 'cancelled');
