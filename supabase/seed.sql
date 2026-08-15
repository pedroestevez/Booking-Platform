-- Two demo tenants + their services and availability, for local dev and demos.
-- Run by `supabase db reset` (after the migrations).
-- Inserts run as the migration superuser (bypasses RLS).

insert into public.customers (id, name, slug, branding_json) values
  (
    '11111111-1111-1111-1111-111111111111',
    'Northwind Therapy',
    'northwind-therapy',
    '{"brandColor":"oklch(0.52 0.16 195)","tagline":"Calm, focused sessions for a clearer mind.","currency":"USD","timezone":"America/New_York"}'
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'Lumina Hair Studio',
    'lumina-hair-studio',
    '{"brandColor":"oklch(0.55 0.2 350)","tagline":"Premium cuts & color, by appointment.","currency":"USD","timezone":"America/Los_Angeles"}'
  )
on conflict (id) do nothing;

insert into public.services (customer_id, name, description, duration_minutes, price_cents) values
  ('11111111-1111-1111-1111-111111111111', 'Initial Consultation', 'A relaxed 50-minute first session to understand your goals and map a plan together.', 50, 12000),
  ('11111111-1111-1111-1111-111111111111', 'Standard Session', 'Your regular one-on-one therapy session in a calm, private setting.', 50, 15000),
  ('11111111-1111-1111-1111-111111111111', 'Extended Deep-Dive', 'An 80-minute session for when you need more space to work through things.', 80, 22000),
  ('22222222-2222-2222-2222-222222222222', 'Signature Cut & Style', 'A precision cut finished with a blow-dry and styling tailored to you.', 60, 9000),
  ('22222222-2222-2222-2222-222222222222', 'Full Color & Gloss', 'Single-process color with a shine-boosting gloss and conditioning treatment.', 120, 18000),
  ('22222222-2222-2222-2222-222222222222', 'Express Fringe Trim', 'A quick, complimentary-feeling tidy of your fringe between visits.', 20, 2500);

-- Northwind: Mon–Fri 09:00–17:00. Lumina: Tue–Sat 10:00–18:00.
insert into public.availability_rules (customer_id, day_of_week, start_time, end_time, buffer_minutes)
select '11111111-1111-1111-1111-111111111111', d, '09:00', '17:00', 10
from generate_series(1, 5) as d;

insert into public.availability_rules (customer_id, day_of_week, start_time, end_time, buffer_minutes)
select '22222222-2222-2222-2222-222222222222', d, '10:00', '18:00', 15
from generate_series(2, 6) as d;
