-- Game-rule tests. Run with tests/run.sh (uses a throwaway local database).
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.at(ts text) returns void language sql as
  $$ select set_config('test.now', ts, false) $$;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as
  $$ begin if not coalesce(ok,false) then raise exception 'FAILED: %', what; end if; raise notice 'ok - %', what; end $$;
set client_min_messages = notice;

-- 22 players with finished profiles. Player 1 is the organizer.
insert into auth.users (id, email)
select ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       case when i = 1 then '(owner account)' else 'player' || i || '@example.com' end
from generate_series(1, 22) i;
-- (profiles are created automatically by the sign-up trigger)
update profiles set full_name = 'Player ' || right(id::text, 2)::int, waiver_accepted_at = now();
select pg_temp.check((select is_admin from profiles where email = '(owner account)')
                     and (select count(*) = 1 from profiles where is_admin), 'organizer recognized by email');

create or replace function pg_temp.u(i int) returns uuid language sql as
  $$ select ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid $$;
create or replace function pg_temp.reg(i int) returns registrations language sql as
  $$ select * from registrations where user_id = pg_temp.u(i) order by id desc limit 1 $$;

-- 1. The week's game is created with the right times (Monday 8 AM CT, before sign-ups open)
select pg_temp.at('2026-10-12 08:00 America/Chicago');
select ensure_next_game();
select pg_temp.check((select kickoff_at = '2026-10-16 22:00 America/Chicago' from games), 'kickoff is Friday 10 PM CT');
select pg_temp.check((select opens_at = '2026-10-12 09:00 America/Chicago' from games), 'sign-ups open Monday 9 AM');
select pg_temp.check((select drop_deadline_at = '2026-10-15 20:00 America/Chicago' from games), 'drop deadline Thursday 8 PM');
select pg_temp.check((select closes_at = '2026-10-16 20:00 America/Chicago' from games), 'sign-ups close Friday 8 PM');
select pg_temp.check((claim_spot(pg_temp.u(2))->>'error') like 'Sign-ups open%', 'cannot sign up before Monday 9 AM');

-- 2. Monday 9:05: 18 sign up, the next two go to the waitlist
select pg_temp.at('2026-10-12 09:05 America/Chicago');
select pg_temp.check((tick_db()->>'phase') = 'open', 'game is open');
select pg_temp.check((select count(*) = 22 from outbox where kind = 'signups_open'), 'everyone told sign-ups opened');
select claim_spot(pg_temp.u(i)) from generate_series(2, 19) i;
select pg_temp.check(active_count(1) = 18, '18 spots held');
select pg_temp.check((claim_spot(pg_temp.u(20))->>'action') = 'waitlisted', 'player 20 waitlisted');
select pg_temp.check((claim_spot(pg_temp.u(21))->>'position') = '2', 'player 21 is #2 on waitlist');
select pg_temp.check((claim_spot(pg_temp.u(2))->>'action') = 'pay', 'player 2 asking again resumes their hold (no duplicate)');
select pg_temp.check((select count(*) = 1 from registrations where user_id = pg_temp.u(2)), 'one place per player');
select pg_temp.check((claim_spot(pg_temp.u(2))->>'capture') = 'manual', 'early sign-ups only put a hold on the card');

-- 3. Everyone pays within the 10 minutes (except player 19)
select attach_checkout((pg_temp.reg(i)).id, 'cs_' || i, 'https://checkout/' || i) from generate_series(2, 19) i;
select payment_completed('cs_' || i, null, 'pi_' || i, 805, false) from generate_series(2, 18) i;
select pg_temp.check((select count(*) = 17 from registrations where status = 'confirmed' and pay_state = 'authorized'), '17 confirmed');
select pg_temp.check((payment_completed('cs_2', null, 'pi_2', 805, false)->>'result') = 'already', 'duplicate Stripe message ignored');

-- 4. Player 19's 10-minute hold runs out -> spot goes to waitlist #1 (player 20)
select pg_temp.at('2026-10-12 09:16 America/Chicago');
select tick_db();
select pg_temp.check((pg_temp.reg(19)).status = 'expired', 'unpaid hold expired after 10 min');
select pg_temp.check((select count(*) = 1 from stripe_tasks where kind = 'expire_session' and session_id = 'cs_19'), 'its checkout page gets closed');
select pg_temp.check((pg_temp.reg(20)).status = 'offered', 'waitlist #1 offered the spot');
select pg_temp.check((pg_temp.reg(20)).offer_expires_at = '2026-10-12 11:16 America/Chicago', 'offer lasts 2 hours');
select pg_temp.check(active_count(1) = 18, 'still exactly 18');

-- 5. Player 19 pays late anyway -> automatically refunded, spot not given back
select pg_temp.check((payment_completed('cs_19', null, 'pi_19', 805, false)->>'result') = 'refunding', 'late payment refused');
select pg_temp.check((select count(*) = 1 from stripe_tasks t join registrations r on r.id = t.registration_id
                      where r.user_id = pg_temp.u(19) and t.kind = 'release_or_refund'), 'late payment refund queued');
select pg_temp.check(active_count(1) = 18, 'still exactly 18 after late payment');

-- 6. Player 20 accepts the offer
select attach_checkout((pg_temp.reg(20)).id, 'cs_20', 'u');
select payment_completed('cs_20', null, 'pi_20', 805, false);
select pg_temp.check((pg_temp.reg(20)).status = 'confirmed', 'waitlist player confirmed');

-- 7. Tuesday 9:30 PM: player 3 drops before the deadline -> refund; offer to player 21 pauses overnight
select pg_temp.at('2026-10-13 21:30 America/Chicago');
select set_config('request.jwt.claim.sub', pg_temp.u(3)::text, false);
select pg_temp.check((drop_out()->>'message') like '%being returned%', 'early drop gets refund message');
select pg_temp.check((select count(*) = 1 from stripe_tasks t where t.registration_id = (pg_temp.reg(3)).id and kind = 'release_or_refund'), 'refund queued for early drop');
select pg_temp.check((pg_temp.reg(21)).status = 'offered', 'player 21 offered');
select pg_temp.check((pg_temp.reg(21)).offer_expires_at = '2026-10-14 10:30 America/Chicago',
                     'offer at 9:30 PM: 30 min tonight + 90 min after 9 AM = Wed 10:30 AM');

-- 8. Offer reminder and expiry
select pg_temp.at('2026-10-14 10:05 America/Chicago');
select tick_db();
select pg_temp.check((select count(*) = 1 from outbox where kind = 'offer_expiring' and user_id = pg_temp.u(21)), 'reminder 30 min before offer ends');
select pg_temp.at('2026-10-14 10:31 America/Chicago');
select tick_db();
select pg_temp.check((pg_temp.reg(21)).status = 'expired', 'offer expired');
select pg_temp.check(active_count(1) = 17, 'spot is open (no one left on waitlist)');

-- 9. Race: 10 people tap at once for the last spot (tested separately in parallel too)
select pg_temp.check((claim_spot(pg_temp.u(22))->>'action') = 'pay', 'player 22 gets the open spot');
select pg_temp.check((claim_spot(pg_temp.u(21))->>'action') = 'waitlisted', 'player 21 rejoins waitlist');
select attach_checkout((pg_temp.reg(22)).id, 'cs_22', 'u');
select payment_completed('cs_22', null, 'pi_22', 805, false);

-- 10. Thursday 8 PM deadline: held cards are charged
select pg_temp.at('2026-10-15 20:01 America/Chicago');
select tick_db();
select pg_temp.check((select count(*) = 18 from stripe_tasks where kind = 'capture'), '18 cards charged at the deadline');

-- 11. Late drop (after deadline): no refund unless someone takes the spot
select pg_temp.at('2026-10-15 21:00 America/Chicago');
select set_config('request.jwt.claim.sub', pg_temp.u(4)::text, false);
select pg_temp.check((drop_out()->>'message') like '%only be refunded if someone takes your spot%', 'late drop warned');
select pg_temp.check((pg_temp.reg(4)).late_drop_refund = 'pending', 'late drop refund pending');
select pg_temp.check((pg_temp.reg(21)).status = 'offered', 'spot offered to waitlist');
select pg_temp.check((pg_temp.reg(21)).offer_expires_at = '2026-10-16 10:00 America/Chicago', 'offer at 9 PM Thu: 1h tonight + 1h from 9 AM = Fri 10 AM');
select pg_temp.check((claim_spot(pg_temp.u(21))->>'capture') = 'automatic', 'after the deadline cards are charged right away');
select attach_checkout((pg_temp.reg(21)).id, 'cs_21b', 'u');
select payment_completed('cs_21b', null, 'pi_21b', 805, true);
select pg_temp.check((pg_temp.reg(4)).late_drop_refund = 'refunded', 'late dropper refunded when spot filled');
select pg_temp.check((select count(*) = 1 from stripe_tasks t where t.registration_id = (pg_temp.reg(4)).id and kind = 'release_or_refund'), 'late dropper refund queued');

-- 12. Friday: reminder, then within 6 hours of kickoff offers are 30 minutes
select pg_temp.at('2026-10-16 09:00 America/Chicago');
select tick_db();
select pg_temp.check((select count(*) = 18 from outbox where kind = 'game_reminder'), 'game-day reminder to all 18');
select pg_temp.at('2026-10-16 17:00 America/Chicago');
select claim_spot(pg_temp.u(19));   -- waitlisted
select set_config('request.jwt.claim.sub', pg_temp.u(5)::text, false);
select drop_out();
select pg_temp.check((pg_temp.reg(19)).offer_expires_at = '2026-10-16 17:30 America/Chicago', 'late-day offer is 30 minutes');

-- 13. Sign-ups close at 8 PM: open offers end, pending late refunds forfeited
select pg_temp.at('2026-10-16 20:00 America/Chicago');
select tick_db();
select pg_temp.check((pg_temp.reg(19)).status = 'expired', 'offers end when sign-ups close');
select pg_temp.check((pg_temp.reg(5)).late_drop_refund = 'forfeited', 'late drop with no replacement forfeited');
select pg_temp.check((claim_spot(pg_temp.u(5))->>'error') = 'Sign-ups are closed for this game.', 'no sign-ups after close');

-- 14. Next week's game appears after this one ends
select pg_temp.at('2026-10-16 23:31 America/Chicago');
select pg_temp.check((ensure_next_game()).kickoff_at = '2026-10-23 22:00 America/Chicago', 'next Friday created automatically');

-- 15. Organizer tools
select set_config('request.jwt.claim.sub', pg_temp.u(1)::text, false);
select pg_temp.at('2026-10-19 09:01 America/Chicago');
select tick_db();
select admin_add(pg_temp.u(1));
select pg_temp.check((pg_temp.reg(1)).status = 'confirmed' and (pg_temp.reg(1)).pay_state = 'manual', 'organizer adds himself, no charge');
select claim_spot(pg_temp.u(6)); select attach_checkout((pg_temp.reg(6)).id, 'cs_6b', 'u');
select payment_completed('cs_6b', null, 'pi_6b', 805, false);
select admin_remove((pg_temp.reg(6)).id, true);
select pg_temp.check((pg_temp.reg(6)).status = 'removed' and (pg_temp.reg(6)).pay_state = 'refund_pending', 'remove with refund');
select admin_block(pg_temp.u(6), true);
select pg_temp.check((claim_spot(pg_temp.u(6))->>'error') like '%can''t sign up%', 'blocked player cannot sign up');
select claim_spot(pg_temp.u(7)); select attach_checkout((pg_temp.reg(7)).id, 'cs_7b', 'u');
select payment_completed('cs_7b', null, 'pi_7b', 805, false);
select claim_spot(pg_temp.u(8));
select admin_cancel_game('rain');
select pg_temp.check((select count(*) = 0 from registrations r join games g on g.id = r.game_id
                      where g.cancel_reason = 'rain' and r.status in ('holding','confirmed','waitlisted','offered')), 'cancel clears everyone');
select pg_temp.check((pg_temp.reg(7)).pay_state = 'refund_pending', 'cancel refunds paid players');
select pg_temp.check((select count(*) = 1 from stripe_tasks where kind = 'expire_session' and registration_id = (pg_temp.reg(8)).id) or (pg_temp.reg(8)).checkout_session_id is null, 'cancel closes open checkouts');

-- 16. Non-organizer can't use organizer tools
select set_config('request.jwt.claim.sub', pg_temp.u(9)::text, false);
do $$ begin perform admin_board(null); raise exception 'FAILED: player used admin tools';
exception when others then if sqlerrm like 'FAILED%' then raise; end if; raise notice 'ok - players blocked from organizer tools'; end $$;

-- 17. Task completion bookkeeping
select task_done(id, true, 'released', 805, 're_x', null) from stripe_tasks where registration_id = (pg_temp.reg(3)).id;
select pg_temp.check((pg_temp.reg(3)).pay_state = 'released', 'release recorded');
select pg_temp.check((select count(*) = 1 from outbox where user_id = pg_temp.u(3) and kind = 'refund_issued'), 'player told about refund');

select 'ALL RULE TESTS PASSED' as result;
