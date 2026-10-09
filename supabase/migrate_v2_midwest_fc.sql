-- One-time upgrade (Oct 2026): single Friday game → Midwest FC with categories and memberships.
-- Removes the old test games/sign-ups/payments. Keeps people (profiles), push subscriptions and app keys.
-- Run this, THEN run schema.sql, THEN the seed at the bottom of this file.

do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' loop
    execute 'drop function if exists ' || f || ' cascade';
  end loop;
end $$;

drop table if exists public.stripe_tasks, public.payment_events, public.outbox,
                     public.registrations, public.games, public.settings cascade;

-- ---- after running schema.sql: ----
-- Friday games every week from Fri Oct 16 to Fri Dec 25, 2026 (sign-ups open the Monday before at 2 PM CT):
-- select make_game('friday', d::date) from generate_series('2026-10-16'::date, '2026-12-25'::date, interval '7 days') d;
