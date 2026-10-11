-- Game-rule tests. Run with tests/run.sh (uses a throwaway local database).
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create or replace function pg_temp.at(ts text) returns void language sql as
  $$ select set_config('test.now', ts, false) $$;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as
  $$ begin if not coalesce(ok,false) then raise exception 'FAILED: %', what; end if; raise notice 'ok - %', what; end $$;
create or replace function pg_temp.as_user(i int) returns text language sql as
  $$ select set_config('request.jwt.claim.sub', ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0')), false) $$;
set client_min_messages = notice;

-- 24 people. Player 1 is the organizer.
select pg_temp.at('2026-10-09 15:00 America/Chicago');
insert into auth.users (id, email)
select ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       case when i = 1 then 'organizer@example.com' else 'player' || i || '@example.com' end
from generate_series(1, 24) i;
select pg_temp.check((select is_admin from profiles where email = 'organizer@example.com')
                     and (select count(*) = 1 from profiles where is_admin), 'organizer recognized by email');

create or replace function pg_temp.u(i int) returns uuid language sql as
  $$ select ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid $$;
create or replace function pg_temp.reg(i int) returns registrations language sql as
  $$ select * from registrations where user_id = pg_temp.u(i) order by id desc limit 1 $$;
create or replace function pg_temp.fri(d text) returns bigint language sql as
  $$ select id from games where category_id = 'friday' and (kickoff_at at time zone 'America/Chicago')::date = d::date $$;

-- 1. Friday game slots Oct 16 – Dec 25, sign-ups open Monday 2 PM
select pg_temp.as_user(1);
select pg_temp.check((save_profile('The Organizer', null, true, null)->>'ok') = 'true', 'organizer needs no membership request');
select pg_temp.check((admin_add_games('friday', '2026-10-16', '2026-12-25', null)->>'added')::int = 11, '11 Friday games Oct 16 – Dec 25');
select pg_temp.check((select kickoff_at = '2026-10-16 22:00 America/Chicago' from games where id = pg_temp.fri('2026-10-16')), 'game 1 is Fri Oct 16, 10 PM CT');
select pg_temp.check((select opens_at = '2026-10-12 14:00 America/Chicago' from games where id = pg_temp.fri('2026-10-16')), 'sign-ups open Monday Oct 12, 2 PM');
select pg_temp.check((select drop_deadline_at = '2026-10-15 20:00 America/Chicago' from games where id = pg_temp.fri('2026-10-16')), 'drop deadline Thursday 8 PM');
select pg_temp.check((select closes_at = '2026-10-16 20:00 America/Chicago' from games where id = pg_temp.fri('2026-10-16')), 'sign-ups close Friday 8 PM');
select pg_temp.check((select opens_at = '2026-12-21 14:00 America/Chicago' from games where id = pg_temp.fri('2026-12-25')), 'Dec 25 game opens Mon Dec 21, 2 PM');
select pg_temp.check((select kickoff_at = '2026-11-06 22:00 America/Chicago' from games where id = pg_temp.fri('2026-11-06')), 'time stays 10 PM across the daylight-saving change');
select pg_temp.check((admin_add_games('friday', '2026-10-16', '2026-10-16', null)->>'added')::int = 0, 'adding the same game twice does nothing');

-- 2. Membership: request → organizer approves
select pg_temp.as_user(2);
do $$ begin perform save_profile('Player 2', null, true, null); raise exception 'FAILED: no group chosen';
exception when others then if sqlerrm like 'FAILED%' then raise; end if; raise notice 'ok - must choose a game group'; end $$;
select save_profile('Player ' || i, null, true, array['friday']) from generate_series(2, 22) i where pg_temp.as_user(i) is not null;
select pg_temp.as_user(23); select save_profile('Player 23', null, true, array['wednesday']);
select pg_temp.as_user(24); select save_profile('Player 24', null, true, array['friday','wednesday']);
select pg_temp.check((select count(*) = 24 from memberships where status = 'pending'), '24 pending requests (one person asked for both)');
select pg_temp.check((select count(*) = 24 from outbox where kind = 'membership_request'), 'organizer told about each request');
select pg_temp.as_user(2);
select pg_temp.check(jsonb_array_length(get_home()->'sections') = 0, 'pending member sees no games or names');
select pg_temp.check((get_home()->'memberships'->0->>'status') = 'pending', 'pending member sees their request status');
do $$ begin perform admin_set_membership(pg_temp.u(3), 'friday', 'approved'); raise exception 'FAILED: player approved someone';
exception when others then if sqlerrm like 'FAILED%' then raise; end if; raise notice 'ok - players cannot approve members'; end $$;
select pg_temp.as_user(1);
select admin_set_membership(pg_temp.u(i), 'friday', 'approved') from generate_series(2, 21) i;
select admin_set_membership(pg_temp.u(23), 'wednesday', 'approved');
select admin_set_membership(pg_temp.u(24), 'friday', 'approved');
select admin_set_membership(pg_temp.u(24), 'wednesday', 'approved');
select admin_set_membership(pg_temp.u(22), 'friday', 'declined');
select pg_temp.check((select count(*) = 23 from outbox where kind = 'membership_approved'), 'approved people are told');
select pg_temp.check((select count(*) = 1 from outbox where kind = 'membership_declined'), 'declined person is told');
select pg_temp.check(badges_of(pg_temp.u(24)) = '["FRI", "WED"]'::jsonb, 'member of both shows FRI and WED badges');
select pg_temp.as_user(2);
select pg_temp.check((get_home()->'sections'->0->>'category') = 'Friday Games', 'approved member sees Friday Games');
select pg_temp.check((get_home()->'sections'->0->'view'->'game'->>'phase') = 'upcoming', 'before Monday 2 PM the game shows as upcoming');
select pg_temp.check(jsonb_array_length(get_home()->'sections'->0->'upcoming') = 10, 'upcoming schedule lists the next 10 Fridays');
select pg_temp.as_user(23);
select pg_temp.check((get_home()->'sections'->0->>'category') = 'Wednesday Games' and get_home()->'sections'->0->'view' = 'null'::jsonb,
                     'Wednesday member sees Wednesday (no games scheduled yet)');

-- 3. Before opening
select pg_temp.check((claim_spot(pg_temp.u(2), pg_temp.fri('2026-10-16'))->>'error') like 'Sign-ups open%', 'cannot sign up before Monday 2 PM');

-- 4. Monday 2:05 PM: opens; 18 sign up, next to waitlist; non-members refused
select pg_temp.at('2026-10-12 14:05 America/Chicago');
select tick_db();
select pg_temp.check((select count(*) = 22 from outbox where kind = 'signups_open'), 'sign-ups-open email to Friday members + organizer only');
select pg_temp.check((claim_spot(pg_temp.u(23), pg_temp.fri('2026-10-16'))->>'error') like 'Only approved Friday Games members%', 'Wednesday-only member cannot join Friday');
select pg_temp.check((claim_spot(pg_temp.u(22), pg_temp.fri('2026-10-16'))->>'error') like 'Only approved%', 'declined person cannot join');
select claim_spot(pg_temp.u(i), pg_temp.fri('2026-10-16')) from generate_series(2, 19) i;
select pg_temp.check(active_count(pg_temp.fri('2026-10-16')) = 18, '18 spots held');
select pg_temp.check((claim_spot(pg_temp.u(20), pg_temp.fri('2026-10-16'))->>'action') = 'waitlisted', 'player 20 waitlisted');
select pg_temp.check((claim_spot(pg_temp.u(21), pg_temp.fri('2026-10-16'))->>'position') = '2', 'player 21 is #2 on waitlist');
select pg_temp.check((claim_spot(pg_temp.u(2), pg_temp.fri('2026-10-16'))->>'action') = 'pay', 'asking again resumes the hold (no duplicate)');
select pg_temp.check((claim_spot(pg_temp.u(2), pg_temp.fri('2026-10-16'))->>'capture') = 'manual', 'early sign-ups only put a hold on the card');
select pg_temp.check((claim_spot(pg_temp.u(3), pg_temp.fri('2026-10-23'))->>'error') like 'Sign-ups open%', 'next week''s game not open yet');

-- 5. Payments
select attach_checkout((pg_temp.reg(i)).id, 'cs_' || i, 'https://checkout/' || i) from generate_series(2, 19) i;
select payment_completed('cs_' || i, null, 'pi_' || i, 805, false) from generate_series(2, 18) i;
select pg_temp.check((select count(*) = 17 from registrations where status = 'confirmed' and pay_state = 'authorized'), '17 confirmed');
select pg_temp.check((payment_completed('cs_2', null, 'pi_2', 805, false)->>'result') = 'already', 'duplicate Stripe message ignored');
select pg_temp.as_user(2);
select pg_temp.check((get_home()->'sections'->0->'view'->'confirmed'->0->'badges') = '["FRI"]'::jsonb, 'player list shows badges');

-- 6. Hold expires → waitlist #1 offered
select pg_temp.at('2026-10-12 14:16 America/Chicago');
select tick_db();
select pg_temp.check((pg_temp.reg(19)).status = 'expired', 'unpaid hold expired after 10 min');
select pg_temp.check((pg_temp.reg(20)).status = 'offered', 'waitlist #1 offered the spot');
select pg_temp.check((pg_temp.reg(20)).offer_expires_at = '2026-10-12 16:16 America/Chicago', 'offer lasts 2 hours');
select pg_temp.check((payment_completed('cs_19', null, 'pi_19', 805, false)->>'result') = 'refunding', 'late payment refused and refunded');
select attach_checkout((pg_temp.reg(20)).id, 'cs_20', 'u');
select payment_completed('cs_20', null, 'pi_20', 805, false);
select pg_temp.check((pg_temp.reg(20)).status = 'confirmed', 'waitlist player confirmed');

-- 7. Early drop Tuesday 9:30 PM → refund; offer pauses overnight
select pg_temp.at('2026-10-13 21:30 America/Chicago');
select pg_temp.as_user(3);
select pg_temp.check((drop_out(pg_temp.fri('2026-10-16'))->>'message') like '%being returned%', 'early drop gets refund');
select pg_temp.check((pg_temp.reg(21)).offer_expires_at = '2026-10-14 10:30 America/Chicago', 'offer clock pauses 10 PM – 9 AM');

-- 8. Offer reminder + expiry
select pg_temp.at('2026-10-14 10:05 America/Chicago'); select tick_db();
select pg_temp.check((select count(*) = 1 from outbox where kind = 'offer_expiring' and user_id = pg_temp.u(21)), 'reminder before offer ends');
select pg_temp.at('2026-10-14 10:31 America/Chicago'); select tick_db();
select pg_temp.check((pg_temp.reg(21)).status = 'expired', 'offer expired');
select pg_temp.check((claim_spot(pg_temp.u(24), pg_temp.fri('2026-10-16'))->>'action') = 'pay', 'member of both groups takes the open spot');
select attach_checkout((pg_temp.reg(24)).id, 'cs_24', 'u');
select payment_completed('cs_24', null, 'pi_24', 805, false);
select pg_temp.check((claim_spot(pg_temp.u(21), pg_temp.fri('2026-10-16'))->>'action') = 'waitlisted', 'player 21 rejoins waitlist');

-- 9. Deadline capture
select pg_temp.at('2026-10-15 20:01 America/Chicago'); select tick_db();
select pg_temp.check((select count(*) = 18 from stripe_tasks where kind = 'capture'), '18 cards charged at the deadline');

-- 10. Late drop refunded when filled
select pg_temp.at('2026-10-15 21:00 America/Chicago');
select pg_temp.as_user(4);
select pg_temp.check((drop_out(pg_temp.fri('2026-10-16'))->>'message') like '%only be refunded if someone takes your spot%', 'late drop warned');
select pg_temp.check((claim_spot(pg_temp.u(21), pg_temp.fri('2026-10-16'))->>'capture') = 'automatic', 'after deadline cards are charged right away');
select attach_checkout((pg_temp.reg(21)).id, 'cs_21b', 'u');
select payment_completed('cs_21b', null, 'pi_21b', 805, true);
select pg_temp.check((pg_temp.reg(4)).late_drop_refund = 'refunded', 'late dropper refunded when spot filled');

-- 11. Game day, close, next week opens next Monday 2 PM
select pg_temp.at('2026-10-16 09:00 America/Chicago'); select tick_db();
select pg_temp.check((select count(*) = 18 from outbox where kind = 'game_reminder'), 'game-day reminder to all 18');
select pg_temp.at('2026-10-16 20:00 America/Chicago'); select tick_db();
select pg_temp.check((claim_spot(pg_temp.u(5), pg_temp.fri('2026-10-16'))->>'error') = 'Sign-ups are closed for this game.', 'no sign-ups after close');

-- 11b. Man of the Match: voting opens after the game, players who played vote until Monday 10 AM
select pg_temp.at('2026-10-16 23:31 America/Chicago'); select tick_db();
select pg_temp.check((select motm_state = 'open' and motm_closes_at = '2026-10-19 10:00 America/Chicago'
                      from games where id = pg_temp.fri('2026-10-16')), 'MOTM voting opens after the game, closes Monday 10 AM');
select pg_temp.check((select count(*) = 18 from outbox where kind = 'motm_vote'), 'all 18 players asked to vote');
select pg_temp.as_user(3);
do $$ begin perform motm_vote(pg_temp.fri('2026-10-16'), pg_temp.u(2)); raise exception 'FAILED: non-player voted';
exception when others then if sqlerrm like 'FAILED%' then raise; end if; raise notice 'ok - only players who played can vote'; end $$;
select pg_temp.as_user(5);
do $$ begin perform motm_vote(pg_temp.fri('2026-10-16'), pg_temp.u(5)); raise exception 'FAILED: self vote';
exception when others then if sqlerrm like 'FAILED%' then raise; end if; raise notice 'ok - no voting for yourself'; end $$;
do $$ begin perform motm_vote(pg_temp.fri('2026-10-16'), pg_temp.u(22)); raise exception 'FAILED: voted for non-player';
exception when others then if sqlerrm like 'FAILED%' then raise; end if; raise notice 'ok - can only vote for someone who played'; end $$;
select pg_temp.as_user(i), motm_vote(pg_temp.fri('2026-10-16'), pg_temp.u(2)) from generate_series(5, 7) i;
select pg_temp.as_user(i), motm_vote(pg_temp.fri('2026-10-16'), pg_temp.u(10)) from generate_series(8, 9) i;
select pg_temp.as_user(10); select motm_vote(pg_temp.fri('2026-10-16'), pg_temp.u(2)); select motm_vote(pg_temp.fri('2026-10-16'), pg_temp.u(11));
select pg_temp.check((select count(*) = 6 from motm_votes), 'one vote per player (changing a vote replaces it)');
select pg_temp.as_user(5);
select pg_temp.check(jsonb_array_length(get_home()->'motm_ballots') = 1
                     and jsonb_array_length(get_home()->'motm_ballots'->0->'candidates') = 17
                     and (get_home()->'motm_ballots'->0->>'my_vote')::uuid = pg_temp.u(2), 'ballot shows the other 17 players and my vote');
select pg_temp.as_user(3);
select pg_temp.check(jsonb_array_length(get_home()->'motm_ballots') = 0, 'non-players get no ballot');
select pg_temp.at('2026-10-18 10:30 America/Chicago'); select tick_db();
select pg_temp.check((select count(*) = 12 from outbox where kind = 'motm_reminder'), 'reminder a day before to the 12 who haven''t voted');
select pg_temp.at('2026-10-19 10:00 America/Chicago'); select tick_db();
select pg_temp.check((select motm_state = 'closed' from games where id = pg_temp.fri('2026-10-16')), 'voting closes Monday 10 AM');
select pg_temp.check((select user_id = pg_temp.u(2) and votes = 3 from motm_winners), 'Player 2 is Man of the Match with 3 votes');
select pg_temp.check((select count(*) = 1 from outbox where kind = 'motm_won' and user_id = pg_temp.u(2)), 'winner told');
select pg_temp.check((select count(*) = 18 from outbox where kind = 'motm_result'), 'other players + organizer told who won');
select pg_temp.check(badges_of(pg_temp.u(2)) = '["FRI", "MOTM"]'::jsonb, 'winner gets the MOTM badge');
select pg_temp.check((pg_temp.reg(2)).game_id = pg_temp.fri('2026-10-23') and (pg_temp.reg(2)).status = 'offered'
                     and (pg_temp.reg(2)).reserved_by = 'motm' and (pg_temp.reg(2)).pay_state = 'none',
                     'winner has a spot saved in next Friday''s game (not paid yet)');
select pg_temp.check((pg_temp.reg(2)).offer_expires_at = '2026-10-19 16:00 America/Chicago', 'winner must pay within 2 hours of sign-ups opening');
select pg_temp.check((claim_spot(pg_temp.u(2), pg_temp.fri('2026-10-23'))->>'action') = 'pay', 'winner can pay before sign-ups open');
select pg_temp.as_user(5);
do $$ begin perform motm_vote(pg_temp.fri('2026-10-16'), pg_temp.u(2)); raise exception 'FAILED: voted after close';
exception when others then if sqlerrm like 'FAILED%' then raise; end if; raise notice 'ok - no votes after Monday 10 AM'; end $$;
select pg_temp.check(jsonb_array_length(motm_history()->'results') = 1 and (motm_history()->'leaders'->0->>'name') = 'Player 2'
                     and (motm_history()->'leaders'->0->>'wins')::int = 1, 'MOTM history and leaderboard');
select pg_temp.check((get_home()->'sections'->0->'last_motm'->'winners'->0->>'name') = 'Player 2', 'home shows last Man of the Match');
select pg_temp.as_user(2);
select pg_temp.check((get_home()->'sections'->0->'view'->'my'->>'reserved_by') = 'motm', 'winner sees their saved spot');
select pg_temp.as_user(23);
do $$ begin perform motm_history(); exception when others then raise exception 'FAILED: member could not see history'; end $$;
select pg_temp.at('2026-10-17 00:00 America/Chicago');
select pg_temp.as_user(2);
select pg_temp.check((get_home()->'sections'->0->'view'->'game'->>'id')::bigint = pg_temp.fri('2026-10-23'), 'after the game, home shows next Friday');
select pg_temp.at('2026-10-19 14:00 America/Chicago'); select tick_db();
select pg_temp.check((select opened_notified from games where id = pg_temp.fri('2026-10-23')), 'Oct 23 sign-ups open Monday Oct 19, 2 PM');

-- 12. Organizer tools
select pg_temp.as_user(1);
select attach_checkout((pg_temp.reg(2)).id, 'cs_2motm', 'u'); select payment_completed('cs_2motm', null, 'pi_2motm', 805, false);
select pg_temp.check((pg_temp.reg(2)).status = 'confirmed', 'MOTM winner confirmed once they pay');
select admin_add(pg_temp.fri('2026-10-23'), pg_temp.u(1));
select pg_temp.check((pg_temp.reg(1)).status = 'offered' and (pg_temp.reg(1)).reserved_by = 'organizer' and (pg_temp.reg(1)).pay_state = 'none',
                     'organizer add saves a spot that still has to be paid');
select pg_temp.check((select count(*) = 1 from outbox where kind = 'reserved' and user_id = pg_temp.u(1)), 'added player told to pay');
select pg_temp.check((claim_spot(pg_temp.u(1), pg_temp.fri('2026-10-23'))->>'action') = 'pay', 'added player pays like everyone else');
select attach_checkout((pg_temp.reg(1)).id, 'cs_1', 'u'); select payment_completed('cs_1', null, 'pi_1', 805, false);
select pg_temp.check((pg_temp.reg(1)).status = 'confirmed' and (pg_temp.reg(1)).pay_state = 'authorized', 'added player confirmed after paying');
select admin_add(pg_temp.fri('2026-10-23'), pg_temp.u(11));
select pg_temp.as_user(12);
select pg_temp.check(jsonb_array_length(get_home()->'sections'->0->'view'->'reserved') = 1
                     and jsonb_array_length(get_home()->'sections'->0->'view'->'waitlist') = 0, 'saved spots show as reserved, not waitlist');
select pg_temp.at('2026-10-19 16:01 America/Chicago'); select tick_db();
select pg_temp.check((pg_temp.reg(11)).status = 'expired', 'unpaid saved spot is released');
select pg_temp.check((select count(*) = 1 from outbox where kind = 'admin_reserved_expired'), 'organizer told the saved spot wasn''t paid');
select pg_temp.as_user(1);
select claim_spot(pg_temp.u(6), pg_temp.fri('2026-10-23')); select attach_checkout((pg_temp.reg(6)).id, 'cs_6b', 'u');
select payment_completed('cs_6b', null, 'pi_6b', 805, false);
select admin_remove((pg_temp.reg(6)).id, true);
select pg_temp.check((pg_temp.reg(6)).pay_state = 'refund_pending', 'remove with refund');
select admin_set_membership(pg_temp.u(6), 'friday', 'removed');
select pg_temp.check((claim_spot(pg_temp.u(6), pg_temp.fri('2026-10-23'))->>'error') like 'Only approved%', 'removed member cannot sign up');
select admin_block(pg_temp.u(7), true);
select pg_temp.check((claim_spot(pg_temp.u(7), pg_temp.fri('2026-10-23'))->>'error') like '%can''t sign up%', 'blocked player cannot sign up');
select claim_spot(pg_temp.u(8), pg_temp.fri('2026-10-23'));
select admin_cancel_game(pg_temp.fri('2026-10-23'), 'rain');
select pg_temp.check((select count(*) = 0 from registrations where game_id = pg_temp.fri('2026-10-23')
                      and status in ('holding','confirmed','waitlisted','offered')), 'cancel clears everyone');
select pg_temp.check((admin_add_games('wednesday', '2026-11-04', '2026-11-25', '20:00')->>'added')::int = 4, 'organizer adds 4 Wednesday games');
select pg_temp.check((select opens_at = '2026-11-02 14:00 America/Chicago' and drop_deadline_at = '2026-11-03 20:00 America/Chicago'
                      from games where category_id = 'wednesday' order by kickoff_at limit 1), 'Wednesday game opens Mon 2 PM, deadline Tue 8 PM');
select admin_delete_game((select id from games where category_id = 'wednesday' order by kickoff_at desc limit 1));
select pg_temp.check((select count(*) = 3 from games where category_id = 'wednesday'), 'empty game can be deleted');
do $$ begin perform admin_delete_game(pg_temp.fri('2026-10-16')); raise exception 'FAILED: deleted a game with players';
exception when others then if sqlerrm like 'FAILED%' then raise; end if; raise notice 'ok - game with players cannot be deleted (cancel instead)'; end $$;
select admin_set_organizer(pg_temp.u(10), true);
select pg_temp.check((select is_admin from profiles where id = pg_temp.u(10)), 'organizer can add a second organizer');
select pg_temp.check(jsonb_array_length(admin_members()->'people') = 24, 'members list shows everyone');

-- 13. Players can't use organizer tools
select pg_temp.as_user(9);
do $$ begin perform admin_schedule(); raise exception 'FAILED: player used admin tools';
exception when others then if sqlerrm like 'FAILED%' then raise; end if; raise notice 'ok - players blocked from organizer tools'; end $$;

-- 14. Task bookkeeping
select task_done(id, true, 'released', 805, 're_x', null) from stripe_tasks where registration_id = (pg_temp.reg(3)).id and kind = 'release_or_refund';
select pg_temp.check((pg_temp.reg(3)).pay_state = 'released', 'release recorded');
select pg_temp.check((select count(*) = 1 from outbox where user_id = pg_temp.u(3) and kind = 'refund_issued'), 'player told about refund');

-- 15. Free game (e.g. the test game): no payment needed
select pg_temp.at('2026-10-19 16:30 America/Chicago');
select pg_temp.as_user(1);
update games set price_cents = 0 where id = pg_temp.fri('2026-10-30');
update games set opens_at = '2026-10-19 14:00 America/Chicago' where id = pg_temp.fri('2026-10-30');
select pg_temp.check((claim_spot(pg_temp.u(12), pg_temp.fri('2026-10-30'))->>'action') = 'confirmed'
                     and (pg_temp.reg(12)).status = 'confirmed' and (pg_temp.reg(12)).pay_state = 'manual', 'free game: sign-up confirmed with no payment');
select admin_add(pg_temp.fri('2026-10-30'), pg_temp.u(13));
select pg_temp.check((pg_temp.reg(13)).status = 'confirmed', 'free game: organizer add is confirmed straight away');
select pg_temp.as_user(12);
select pg_temp.check((drop_out(pg_temp.fri('2026-10-30'))->>'message') = 'You''re out.', 'free game: dropping needs no refund');

select 'ALL RULE TESTS PASSED' as result;
