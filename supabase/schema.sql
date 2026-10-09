-- =====================================================================
-- Friday Soccer — database schema and game rules
-- Paste this whole file into Supabase → SQL Editor → Run.
-- It is safe to run again: it updates functions in place and only
-- creates tables that don't exist yet.
-- All times are Central Time (America/Chicago).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.settings (
  id                    int primary key default 1 check (id = 1),
  admin_email           text not null default 'organizer@example.com',   -- organizer email(s), comma-separated
  location              text not null default 'Ackerman Soccer',
  price_cents           int  not null default 805 check (price_cents >= 50),
  max_players           int  not null default 18 check (max_players between 2 and 100),
  kickoff_dow           int  not null default 5 check (kickoff_dow between 0 and 6),   -- 0=Sun … 6=Sat
  kickoff_time          time not null default '22:00',
  duration_minutes      int  not null default 90 check (duration_minutes between 15 and 600),
  opens_dow             int  not null default 1 check (opens_dow between 0 and 6),
  opens_time            time not null default '09:00',
  close_minutes_before  int  not null default 120 check (close_minutes_before between 0 and 2880),
  drop_deadline_dow     int  not null default 4 check (drop_deadline_dow between 0 and 6),
  drop_deadline_time    time not null default '20:00',
  hold_minutes          int  not null default 10 check (hold_minutes between 5 and 60),
  offer_minutes         int  not null default 120 check (offer_minutes between 10 and 1440),
  late_offer_minutes    int  not null default 30 check (late_offer_minutes between 5 and 240),
  late_window_hours     int  not null default 6 check (late_window_hours between 0 and 72),
  quiet_start           time not null default '22:00',
  quiet_end             time not null default '09:00',
  reminder_time         time not null default '09:00',
  updated_at            timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  email               text not null,
  full_name           text,
  phone               text,
  waiver_accepted_at  timestamptz,
  is_admin            boolean not null default false,
  blocked             boolean not null default false,
  created_at          timestamptz not null default now()
);

create table if not exists public.games (
  id                bigint generated always as identity primary key,
  kickoff_at        timestamptz not null unique,
  ends_at           timestamptz not null,
  location          text not null,
  price_cents       int  not null,
  max_players       int  not null,
  opens_at          timestamptz not null,
  closes_at         timestamptz not null,
  drop_deadline_at  timestamptz not null,
  cancelled_at      timestamptz,
  cancel_reason     text,
  opened_notified   boolean not null default false,
  reminder_sent     boolean not null default false,
  captured_at       timestamptz,
  closed_processed  boolean not null default false,
  created_at        timestamptz not null default now()
);

create table if not exists public.registrations (
  id                   bigint generated always as identity primary key,
  game_id              bigint not null references public.games (id) on delete cascade,
  user_id              uuid   not null references public.profiles (id) on delete cascade,
  status               text   not null check (status in
                         ('holding','confirmed','waitlisted','offered','dropped','expired','removed','cancelled')),
  sort_at              timestamptz not null default now(),   -- first-come order (admin can reorder)
  created_at           timestamptz not null default now(),
  hold_expires_at      timestamptz,
  offer_started_at     timestamptz,
  offer_expires_at     timestamptz,
  offer_reminded       boolean not null default false,
  checkout_session_id  text unique,
  checkout_url         text,
  payment_intent_id    text,
  amount_cents         int,
  pay_state            text not null default 'none' check (pay_state in
                         ('none','authorized','captured','released','refunded','refund_pending','manual')),
  paid_at              timestamptz,
  ended_at             timestamptz,
  late_drop_refund     text check (late_drop_refund in ('pending','refunded','forfeited')),
  is_manual            boolean not null default false
);
-- A player can hold only one active place per game.
create unique index if not exists registrations_one_active
  on public.registrations (game_id, user_id)
  where status in ('holding','confirmed','waitlisted','offered');
create index if not exists registrations_game_status on public.registrations (game_id, status, sort_at);

create table if not exists public.payment_events (
  id               bigint generated always as identity primary key,
  registration_id  bigint references public.registrations (id) on delete set null,
  game_id          bigint references public.games (id) on delete set null,
  user_id          uuid references public.profiles (id) on delete set null,
  kind             text not null check (kind in ('authorized','charged','captured','released','refunded')),
  amount_cents     int not null default 0,
  stripe_ref       text,
  created_at       timestamptz not null default now()
);

create table if not exists public.stripe_tasks (
  id               bigint generated always as identity primary key,
  registration_id  bigint not null references public.registrations (id) on delete cascade,
  kind             text not null check (kind in ('expire_session','release_or_refund','capture')),
  reason           text,
  session_id       text,
  status           text not null default 'pending' check (status in ('pending','done','failed')),
  attempts         int not null default 0,
  last_error       text,
  created_at       timestamptz not null default now(),
  done_at          timestamptz
);
create index if not exists stripe_tasks_pending on public.stripe_tasks (status, id);

create table if not exists public.outbox (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  kind        text not null,
  title       text not null,
  body        text not null,
  status      text not null default 'pending' check (status in ('pending','sending','sent','failed')),
  attempts    int not null default 0,
  taken_at    timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists outbox_pending on public.outbox (status, id);

create table if not exists public.push_subscriptions (
  endpoint    text primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  p256dh      text,
  auth        text,
  created_at  timestamptz not null default now()
);

create table if not exists public.app_secrets (
  key    text primary key,
  value  text not null,
  updated_at timestamptz not null default now()
);

-- Lock every table down: the website never reads tables directly,
-- only through the functions below.
alter table public.settings            enable row level security;
alter table public.profiles            enable row level security;
alter table public.games               enable row level security;
alter table public.registrations       enable row level security;
alter table public.payment_events      enable row level security;
alter table public.stripe_tasks        enable row level security;
alter table public.outbox              enable row level security;
alter table public.push_subscriptions  enable row level security;
alter table public.app_secrets         enable row level security;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ---------------------------------------------------------------------
-- Time helpers (Central Time)
-- ---------------------------------------------------------------------

create or replace function public.tz() returns text
language sql immutable as $$ select 'America/Chicago'::text $$;

create or replace function public.local_ts(d date, t time) returns timestamptz
language sql stable as $$ select (d + t) at time zone public.tz() $$;

create or replace function public.next_local_time(ts timestamptz, t time) returns timestamptz
language plpgsql stable as $$
declare
  d date := (ts at time zone public.tz())::date;
  c timestamptz := public.local_ts(d, t);
begin
  if c <= ts then c := public.local_ts(d + 1, t); end if;
  return c;
end $$;

create or replace function public.in_quiet(ts timestamptz) returns boolean
language plpgsql stable as $$
declare s public.settings; lt time;
begin
  select * into s from public.settings where id = 1;
  if s.quiet_start = s.quiet_end then return false; end if;
  lt := (ts at time zone public.tz())::time;
  if s.quiet_start > s.quiet_end then
    return lt >= s.quiet_start or lt < s.quiet_end;
  end if;
  return lt >= s.quiet_start and lt < s.quiet_end;
end $$;

-- Adds a duration, but the clock is paused during quiet hours (10 PM – 9 AM).
create or replace function public.add_active_time(start timestamptz, dur interval) returns timestamptz
language plpgsql stable as $$
declare
  s public.settings; t timestamptz := start; remaining interval := dur;
  nq timestamptz; avail interval; i int := 0;
begin
  select * into s from public.settings where id = 1;
  if s.quiet_start = s.quiet_end then return start + dur; end if;
  loop
    i := i + 1;
    exit when i > 60;
    if public.in_quiet(t) then t := public.next_local_time(t, s.quiet_end); end if;
    nq := public.next_local_time(t, s.quiet_start);
    avail := nq - t;
    if remaining <= avail then return t + remaining; end if;
    remaining := remaining - avail;
    t := nq;
  end loop;
  return t + remaining;
end $$;

create or replace function public.fmt_time(ts timestamptz) returns text
language sql stable as $$
  select trim(to_char(ts at time zone public.tz(), 'FMHH12:MI AM')) $$;

create or replace function public.fmt_day(ts timestamptz) returns text
language sql stable as $$
  select trim(to_char(ts at time zone public.tz(), 'FMDay, FMMonth FMDD')) $$;

create or replace function public.fmt_money(cents int) returns text
language sql immutable as $$ select '$' || to_char(coalesce(cents,0) / 100.0, 'FM999990.00') $$;

-- ---------------------------------------------------------------------
-- Game helpers
-- ---------------------------------------------------------------------

create or replace function public.game_phase(g public.games) returns text
language sql stable as $$
  select case
    when g.cancelled_at is not null then 'cancelled'
    when now() < g.opens_at  then 'upcoming'
    when now() < g.closes_at then 'open'
    when now() < g.ends_at   then 'closed'
    else 'done' end $$;

create or replace function public.active_count(p_game bigint) returns int
language sql stable as $$
  select count(*)::int from public.registrations
  where game_id = p_game and status in ('holding','confirmed','offered') $$;

-- The current game: the next one that hasn't finished. Creates it if needed.
create or replace function public.ensure_next_game() returns public.games
language plpgsql security definer set search_path = public as $$
declare
  s settings; g games; d date; base date; k timestamptz; i int;
begin
  select * into g from games where ends_at > now() order by kickoff_at limit 1;
  if found then return g; end if;

  select * into s from settings where id = 1;
  d := (now() at time zone tz())::date;
  for i in 0..7 loop
    if extract(dow from d + i)::int = s.kickoff_dow
       and local_ts(d + i, s.kickoff_time) + make_interval(mins => s.duration_minutes) > now() then
      base := d + i;
      exit;
    end if;
  end loop;
  k := local_ts(base, s.kickoff_time);

  insert into games (kickoff_at, ends_at, location, price_cents, max_players,
                     opens_at, closes_at, drop_deadline_at)
  values (k,
          k + make_interval(mins => s.duration_minutes),
          s.location, s.price_cents, s.max_players,
          local_ts(base - ((7 + s.kickoff_dow - s.opens_dow) % 7), s.opens_time),
          k - make_interval(mins => s.close_minutes_before),
          local_ts(base - ((7 + s.kickoff_dow - s.drop_deadline_dow) % 7), s.drop_deadline_time))
  on conflict (kickoff_at) do nothing
  returning * into g;

  if g.id is null then select * into g from games where kickoff_at = k; end if;
  return g;
end $$;

create or replace function public.offer_deadline(g public.games, start timestamptz) returns timestamptz
language plpgsql stable as $$
declare s public.settings; d timestamptz;
begin
  select * into s from public.settings where id = 1;
  if g.kickoff_at - start <= make_interval(hours => s.late_window_hours) then
    d := start + make_interval(mins => s.late_offer_minutes);
  else
    d := public.add_active_time(start, make_interval(mins => s.offer_minutes));
  end if;
  return least(d, g.closes_at);
end $$;

create or replace function public.notify(p_user uuid, p_kind text, p_title text, p_body text) returns void
language sql security definer set search_path = public as $$
  insert into outbox (user_id, kind, title, body) values (p_user, p_kind, p_title, p_body) $$;

create or replace function public.notify_admins(p_kind text, p_title text, p_body text) returns void
language sql security definer set search_path = public as $$
  insert into outbox (user_id, kind, title, body)
  select id, p_kind, p_title, p_body from profiles where is_admin $$;

create or replace function public.enqueue_task(p_reg bigint, p_kind text, p_reason text, p_session text default null)
returns void language sql security definer set search_path = public as $$
  insert into stripe_tasks (registration_id, kind, reason, session_id)
  values (p_reg, p_kind, p_reason, p_session) $$;

-- Ends a registration's checkout session if one exists.
create or replace function public.close_session(r public.registrations) returns void
language plpgsql security definer set search_path = public as $$
begin
  if r.checkout_session_id is not null and r.pay_state = 'none' then
    perform enqueue_task(r.id, 'expire_session', 'spot released', r.checkout_session_id);
  end if;
end $$;

-- Gives back the money for a registration (releases the card hold, or refunds).
create or replace function public.give_money_back(r public.registrations, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if r.pay_state in ('authorized','captured') then
    update registrations set pay_state = 'refund_pending' where id = r.id;
    perform enqueue_task(r.id, 'release_or_refund', p_reason);
    return true;
  end if;
  return false;
end $$;

-- Offers open spots to the waitlist, in order. Caller must hold the game lock.
create or replace function public.promote(p_game bigint) returns void
language plpgsql security definer set search_path = public as $$
declare g games; nxt registrations;
begin
  select * into g from games where id = p_game;
  if game_phase(g) <> 'open' then return; end if;
  while active_count(p_game) < g.max_players loop
    select * into nxt from registrations
      where game_id = p_game and status = 'waitlisted'
      order by sort_at, id limit 1;
    exit when not found;
    update registrations
       set status = 'offered', offer_started_at = now(),
           offer_expires_at = offer_deadline(g, now()), offer_reminded = false,
           checkout_session_id = null, checkout_url = null
     where id = nxt.id
     returning * into nxt;
    perform notify(nxt.user_id, 'spot_offered',
      'A spot opened up for you! ⚽',
      'A spot opened up for ' || fmt_day(g.kickoff_at) || '. Pay ' || fmt_money(g.price_cents) ||
      ' by ' || fmt_time(nxt.offer_expires_at) || ' (' || fmt_day(nxt.offer_expires_at) ||
      ') to claim it, or it goes to the next person. (The clock pauses 10 PM – 9 AM.)');
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------

-- Is this email one of the organizer emails in settings? (comma-separated list)
create or replace function public.is_organizer_email(p_email text) returns boolean
language sql stable security definer set search_path = public as $$
  select lower(trim(coalesce(p_email, ''))) <> '' and lower(trim(coalesce(p_email, ''))) = any (
    select lower(trim(x)) from settings, unnest(string_to_array(admin_email, ',')) x where id = 1) $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, is_admin)
  values (new.id, coalesce(new.email, ''),
          is_organizer_email(new.email))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.me() returns public.profiles
language plpgsql security definer set search_path = public as $$
declare p profiles; uid uuid := auth.uid(); em text;
begin
  if uid is null then raise exception 'Please sign in again.'; end if;
  select * into p from profiles where id = uid;
  if not found then
    select email into em from auth.users where id = uid;
    insert into profiles (id, email, is_admin)
    values (uid, coalesce(em,''), is_organizer_email(em))
    on conflict (id) do nothing;
    select * into p from profiles where id = uid;
  end if;
  return p;
end $$;

create or replace function public.require_admin() returns public.profiles
language plpgsql security definer set search_path = public as $$
declare p profiles := me();
begin
  if not p.is_admin then raise exception 'Only the organizer can do that.'; end if;
  return p;
end $$;

create or replace function public.save_profile(p_full_name text, p_phone text, p_accept_waiver boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p profiles := me();
begin
  if coalesce(length(trim(p_full_name)), 0) < 2 then raise exception 'Please enter your full name.'; end if;
  if length(trim(p_full_name)) > 60 then raise exception 'That name is too long.'; end if;
  if p.waiver_accepted_at is null and not coalesce(p_accept_waiver, false) then
    raise exception 'Please accept the waiver to play.';
  end if;
  update profiles
     set full_name = trim(p_full_name),
         phone = nullif(left(trim(coalesce(p_phone,'')), 30), ''),
         waiver_accepted_at = coalesce(waiver_accepted_at, case when p_accept_waiver then now() end)
   where id = p.id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- What a player sees
-- ---------------------------------------------------------------------

create or replace function public.game_json(g public.games) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', g.id, 'phase', game_phase(g),
    'kickoff_at', g.kickoff_at, 'ends_at', g.ends_at, 'location', g.location,
    'price_cents', g.price_cents, 'max_players', g.max_players,
    'opens_at', g.opens_at, 'closes_at', g.closes_at, 'drop_deadline_at', g.drop_deadline_at,
    'cancel_reason', g.cancel_reason,
    'spots_taken', active_count(g.id),
    'confirmed_count', (select count(*) from registrations where game_id = g.id and status = 'confirmed'),
    'waitlist_count', (select count(*) from registrations where game_id = g.id and status in ('waitlisted','offered'))
  ) $$;

create or replace function public.get_home() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p profiles := me(); g games; r registrations; pos int;
begin
  g := ensure_next_game();
  select * into r from registrations
    where game_id = g.id and user_id = p.id
    order by (status in ('holding','confirmed','waitlisted','offered')) desc, id desc limit 1;
  if r.status in ('waitlisted','offered') then
    select count(*) + 1 into pos from registrations
      where game_id = g.id and status in ('waitlisted','offered')
        and (sort_at, id) < (r.sort_at, r.id);
  end if;
  return jsonb_build_object(
    'server_now', now(),
    'me', jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name, 'phone', p.phone,
                             'waiver', p.waiver_accepted_at is not null, 'is_admin', p.is_admin, 'blocked', p.blocked),
    'game', game_json(g),
    'my', case when r.id is null then null else jsonb_build_object(
            'id', r.id, 'status', r.status, 'position', pos, 'pay_state', r.pay_state,
            'hold_expires_at', r.hold_expires_at, 'offer_expires_at', r.offer_expires_at,
            'checkout_url', r.checkout_url, 'late_drop_refund', r.late_drop_refund, 'is_manual', r.is_manual) end,
    'confirmed', coalesce((select jsonb_agg(jsonb_build_object('name', coalesce(pr.full_name, 'Player'), 'me', pr.id = p.id)
                                            order by x.sort_at, x.id)
                             from registrations x join profiles pr on pr.id = x.user_id
                            where x.game_id = g.id and x.status = 'confirmed'), '[]'::jsonb),
    'paying_count', (select count(*) from registrations where game_id = g.id and status = 'holding'),
    'waitlist', coalesce((select jsonb_agg(jsonb_build_object('name', coalesce(pr.full_name, 'Player'), 'me', pr.id = p.id,
                                                             'offered', x.status = 'offered')
                                           order by x.sort_at, x.id)
                            from registrations x join profiles pr on pr.id = x.user_id
                           where x.game_id = g.id and x.status in ('waitlisted','offered')), '[]'::jsonb)
  );
end $$;

create or replace function public.my_history() returns jsonb
language plpgsql security definer set search_path = public as $$
declare p profiles := me();
begin
  return jsonb_build_object(
    'games', coalesce((select jsonb_agg(jsonb_build_object(
                'kickoff_at', g.kickoff_at, 'location', g.location, 'status', r.status,
                'cancelled', g.cancelled_at is not null, 'pay_state', r.pay_state, 'amount_cents', r.amount_cents)
              order by g.kickoff_at desc, r.id desc)
              from registrations r join games g on g.id = r.game_id
             where r.user_id = p.id and (r.status in ('confirmed','dropped','removed','cancelled') or r.pay_state <> 'none')),
            '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object(
                'created_at', e.created_at, 'kind', e.kind, 'amount_cents', e.amount_cents, 'kickoff_at', g.kickoff_at)
              order by e.id desc)
              from payment_events e left join games g on g.id = e.game_id
             where e.user_id = p.id), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- Signing up (called by the website server, which then opens Stripe checkout)
-- ---------------------------------------------------------------------

create or replace function public.pay_info(r public.registrations, g public.games, p public.profiles)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'action', 'pay', 'registration_id', r.id, 'status', r.status, 'game_id', g.id,
    'amount_cents', g.price_cents, 'email', p.email,
    'description', 'Friday Soccer — ' || public.fmt_day(g.kickoff_at) || ', ' || public.fmt_time(g.kickoff_at) || ' at ' || g.location,
    -- Before the drop deadline we only place a hold on the card, and charge it at the deadline.
    'capture', case when now() < g.drop_deadline_at - interval '5 minutes'
                     and g.drop_deadline_at < now() + interval '6 days' then 'manual' else 'automatic' end,
    'expires_at', case when r.status = 'holding' then r.hold_expires_at else r.offer_expires_at end,
    'checkout_session_id', r.checkout_session_id, 'checkout_url', r.checkout_url) $$;

create or replace function public.claim_spot(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g games; s settings; p profiles; r registrations; ph text; pos int;
begin
  g := ensure_next_game();
  select * into g from games where id = g.id for update;      -- one sign-up at a time per game
  select * into s from settings where id = 1;
  select * into p from profiles where id = p_user;
  if p.id is null or coalesce(trim(p.full_name), '') = '' or p.waiver_accepted_at is null then
    return jsonb_build_object('error', 'Please finish your profile first.');
  end if;
  if p.blocked then
    return jsonb_build_object('error', 'Your account can''t sign up right now. Please contact the organizer.');
  end if;

  ph := game_phase(g);
  if ph <> 'open' then
    return jsonb_build_object('error', case ph
      when 'upcoming'  then 'Sign-ups open ' || fmt_day(g.opens_at) || ' at ' || fmt_time(g.opens_at) || '.'
      when 'cancelled' then 'This game was cancelled.'
      else 'Sign-ups are closed for this game.' end);
  end if;

  select * into r from registrations
   where game_id = g.id and user_id = p_user and status in ('holding','confirmed','waitlisted','offered');
  if found then
    if r.status in ('holding','offered') then return pay_info(r, g, p); end if;
    return jsonb_build_object('action', 'none', 'status', r.status);
  end if;

  perform promote(g.id);
  if active_count(g.id) < g.max_players then
    insert into registrations (game_id, user_id, status, hold_expires_at)
    values (g.id, p_user, 'holding', now() + make_interval(mins => s.hold_minutes))
    returning * into r;
    return pay_info(r, g, p);
  end if;

  insert into registrations (game_id, user_id, status)
  values (g.id, p_user, 'waitlisted') returning * into r;
  select count(*) into pos from registrations where game_id = g.id and status in ('waitlisted','offered');
  return jsonb_build_object('action', 'waitlisted', 'registration_id', r.id, 'position', pos);
end $$;

create or replace function public.attach_checkout(p_reg bigint, p_session text, p_url text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update registrations set checkout_session_id = p_session, checkout_url = p_url
   where id = p_reg and status in ('holding','offered') and pay_state = 'none';
  return found;
end $$;

-- Stripe says the player finished paying.
create or replace function public.payment_completed(p_session text, p_reg bigint, p_pi text, p_amount int, p_captured boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r registrations; g games; d registrations;
begin
  select * into r from registrations where checkout_session_id = p_session;
  if not found then select * into r from registrations where id = p_reg; end if;
  if not found then return jsonb_build_object('result', 'unknown'); end if;
  select * into g from games where id = r.game_id for update;
  select * into r from registrations where id = r.id for update;

  if r.payment_intent_id = p_pi then return jsonb_build_object('result', 'already'); end if;

  if r.status in ('holding','offered') and r.pay_state = 'none' then
    update registrations
       set status = 'confirmed', payment_intent_id = p_pi, amount_cents = p_amount,
           pay_state = case when p_captured then 'captured' else 'authorized' end,
           paid_at = now(), hold_expires_at = null, offer_expires_at = null,
           checkout_session_id = coalesce(checkout_session_id, p_session)
     where id = r.id;
    insert into payment_events (registration_id, game_id, user_id, kind, amount_cents, stripe_ref)
    values (r.id, g.id, r.user_id, case when p_captured then 'charged' else 'authorized' end, p_amount, p_pi);
    perform notify(r.user_id, 'payment_confirmed', 'You''re in! ✓',
      'Your spot for ' || fmt_day(g.kickoff_at) || ' at ' || fmt_time(g.kickoff_at) || ' (' || g.location ||
      ') is confirmed. ' || case when p_captured then fmt_money(p_amount) || ' was charged.'
        else 'Your card is on hold for ' || fmt_money(p_amount) || ' and will be charged ' ||
             fmt_day(g.drop_deadline_at) || ' at ' || fmt_time(g.drop_deadline_at) || '. Drop before then for free.' end);

    -- Someone who dropped after the deadline gets refunded now that their spot was filled.
    select * into d from registrations
     where game_id = g.id and status = 'dropped' and late_drop_refund = 'pending'
     order by ended_at, id limit 1 for update;
    if found then
      update registrations set late_drop_refund = 'refunded' where id = d.id;
      if not give_money_back(d, 'spot was filled') then null; end if;
    end if;
    return jsonb_build_object('result', 'confirmed');
  end if;

  -- Paid too late (their hold or offer already ran out): give the money back.
  update registrations set payment_intent_id = p_pi, amount_cents = p_amount,
         pay_state = case when p_captured then 'captured' else 'authorized' end
   where id = r.id returning * into r;
  insert into payment_events (registration_id, game_id, user_id, kind, amount_cents, stripe_ref)
  values (r.id, g.id, r.user_id, case when p_captured then 'charged' else 'authorized' end, p_amount, p_pi);
  perform give_money_back(r, 'late payment');
  perform notify(r.user_id, 'late_payment', 'Payment returned',
    'Your payment came in after your time ran out, so the spot went to someone else. ' ||
    'Your ' || fmt_money(p_amount) || ' is being returned to your card automatically.');
  return jsonb_build_object('result', 'refunding');
end $$;

-- Stripe says a checkout page timed out.
create or replace function public.checkout_expired(p_session text) returns void
language plpgsql security definer set search_path = public as $$
declare r registrations; g games;
begin
  select * into r from registrations where checkout_session_id = p_session;
  if not found then return; end if;
  select * into g from games where id = r.game_id for update;
  select * into r from registrations where id = r.id for update;
  if r.pay_state <> 'none' then return; end if;
  if r.status = 'holding' then
    update registrations set status = 'expired', ended_at = now() where id = r.id;
    perform promote(g.id);
  elsif r.status = 'offered' then
    update registrations set checkout_session_id = null, checkout_url = null where id = r.id;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Dropping out
-- ---------------------------------------------------------------------

create or replace function public.drop_out() returns jsonb
language plpgsql security definer set search_path = public as $$
declare p profiles := me(); g games; r registrations; msg text; ph text;
begin
  g := ensure_next_game();
  select * into g from games where id = g.id for update;
  select * into r from registrations
   where game_id = g.id and user_id = p.id and status in ('holding','confirmed','waitlisted','offered') for update;
  if not found then return jsonb_build_object('message', 'You''re not signed up for this game.'); end if;
  ph := game_phase(g);

  if r.status in ('holding','waitlisted','offered') then
    update registrations set status = case when r.status = 'holding' then 'cancelled' else 'dropped' end,
                             ended_at = now() where id = r.id;
    perform close_session(r);
    perform promote(g.id);
    return jsonb_build_object('message', case r.status when 'waitlisted' then 'You left the waitlist.'
                                         else 'Your spot was released.' end);
  end if;

  -- Confirmed player
  if now() < g.drop_deadline_at then
    update registrations set status = 'dropped', ended_at = now() where id = r.id returning * into r;
    if give_money_back(r, 'dropped before deadline') then
      msg := 'You''re out. Your ' || fmt_money(r.amount_cents) || ' is being returned to your card.';
    else
      msg := 'You''re out.';
    end if;
  elsif ph = 'open' then
    update registrations set status = 'dropped', ended_at = now(),
           late_drop_refund = case when r.pay_state in ('authorized','captured') then 'pending' end
     where id = r.id;
    msg := 'You''re out. It''s past the drop deadline, so you''ll only be refunded if someone takes your spot.';
  else
    update registrations set status = 'dropped', ended_at = now(),
           late_drop_refund = case when r.pay_state in ('authorized','captured') then 'forfeited' end
     where id = r.id;
    msg := 'You''re out. Sign-ups are closed, so there''s no refund.';
  end if;
  perform promote(g.id);
  perform notify_admins('admin_drop', 'Player dropped',
    coalesce(p.full_name, p.email) || ' dropped out of ' || fmt_day(g.kickoff_at) || '.');
  return jsonb_build_object('message', msg);
end $$;

-- ---------------------------------------------------------------------
-- Scheduled work (runs every minute)
-- ---------------------------------------------------------------------

create or replace function public.tick_db() returns jsonb
language plpgsql security definer set search_path = public as $$
declare g games; r registrations; ph text; n_hold int := 0; n_offer int := 0;
begin
  g := ensure_next_game();
  select * into g from games where id = g.id for update;
  ph := game_phase(g);

  -- Sign-ups just opened: tell everyone.
  if ph = 'open' and not g.opened_notified then
    insert into outbox (user_id, kind, title, body)
    select id, 'signups_open', 'Sign-ups are open ⚽',
           'Sign-ups for ' || fmt_day(g.kickoff_at) || ' at ' || fmt_time(g.kickoff_at) || ' (' || g.location ||
           ') are open. ' || g.max_players || ' spots, first come first served.'
      from profiles where not blocked and full_name is not null;
    update games set opened_notified = true where id = g.id;
  end if;

  -- Checkout holds that ran out.
  for r in select * from registrations where game_id = g.id and status = 'holding'
             and hold_expires_at < now() and pay_state = 'none' for update loop
    update registrations set status = 'expired', ended_at = now() where id = r.id;
    perform close_session(r);
    n_hold := n_hold + 1;
  end loop;

  -- Waitlist offers that ran out.
  for r in select * from registrations where game_id = g.id and status = 'offered'
             and offer_expires_at < now() and pay_state = 'none' for update loop
    update registrations set status = 'expired', ended_at = now() where id = r.id;
    perform close_session(r);
    perform notify(r.user_id, 'offer_expired', 'Your offer expired',
      'Time ran out on the spot you were offered, so it moved to the next person. You can join the waitlist again in the app.');
    n_offer := n_offer + 1;
  end loop;

  -- Offers about to run out.
  for r in select * from registrations where game_id = g.id and status = 'offered' and not offer_reminded
             and offer_expires_at - now() <=
                 case when offer_expires_at - offer_started_at >= interval '60 minutes'
                      then interval '30 minutes' else interval '10 minutes' end loop
    update registrations set offer_reminded = true where id = r.id;
    perform notify(r.user_id, 'offer_expiring', 'Your spot offer is about to expire ⏳',
      'Pay by ' || fmt_time(r.offer_expires_at) || ' to keep your spot for ' || fmt_day(g.kickoff_at) || '.');
  end loop;

  perform promote(g.id);

  -- Drop deadline reached: charge the cards that were on hold.
  if now() >= g.drop_deadline_at and g.captured_at is null and g.cancelled_at is null then
    insert into stripe_tasks (registration_id, kind, reason)
    select id, 'capture', 'drop deadline' from registrations
     where game_id = g.id and status = 'confirmed' and pay_state = 'authorized';
    update games set captured_at = now() where id = g.id;
  end if;

  -- Game-day reminder.
  if ph in ('open','closed') and not g.reminder_sent
     and (now() at time zone tz())::date = (g.kickoff_at at time zone tz())::date
     and (now() at time zone tz())::time >= (select reminder_time from settings where id = 1) then
    insert into outbox (user_id, kind, title, body)
    select user_id, 'game_reminder', 'Game tonight ⚽',
           'See you at ' || g.location || ' tonight at ' || fmt_time(g.kickoff_at) || '!'
      from registrations where game_id = g.id and status = 'confirmed';
    update games set reminder_sent = true where id = g.id;
  end if;

  -- Sign-ups closed.
  if ph in ('closed','done') and not g.closed_processed then
    for r in select * from registrations where game_id = g.id and status in ('holding','offered') and pay_state = 'none' for update loop
      update registrations set status = 'expired', ended_at = now() where id = r.id;
      perform close_session(r);
    end loop;
    update registrations set late_drop_refund = 'forfeited'
     where game_id = g.id and late_drop_refund = 'pending';
    insert into stripe_tasks (registration_id, kind, reason)
    select id, 'capture', 'sign-ups closed' from registrations
     where game_id = g.id and status = 'confirmed' and pay_state = 'authorized'
       and not exists (select 1 from stripe_tasks t where t.registration_id = registrations.id
                        and t.kind = 'capture' and t.status = 'pending');
    update games set closed_processed = true where id = g.id;
  end if;

  return jsonb_build_object('game', g.id, 'phase', ph, 'expired_holds', n_hold, 'expired_offers', n_offer);
end $$;

-- Work for the server to do with Stripe.
create or replace function public.take_tasks(p_limit int default 8) returns jsonb
language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'kind', t.kind, 'reason', t.reason, 'attempts', t.attempts,
           'session_id', coalesce(t.session_id, r.checkout_session_id),
           'payment_intent_id', r.payment_intent_id, 'registration_id', r.id,
           'amount_cents', r.amount_cents, 'pay_state', r.pay_state) order by t.id), '[]'::jsonb)
    from (select * from stripe_tasks where status = 'pending'
           and (attempts = 0 or created_at < now() - make_interval(mins => attempts * attempts))
           order by id limit p_limit) t
    join registrations r on r.id = t.registration_id $$;

-- p_result: 'released' | 'refunded' | 'captured' | 'expired' | 'nothing'
create or replace function public.task_done(p_task bigint, p_ok boolean, p_result text, p_amount int, p_ref text, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare t stripe_tasks; r registrations; g games;
begin
  select * into t from stripe_tasks where id = p_task for update;
  if not found or t.status <> 'pending' then return; end if;
  select * into r from registrations where id = t.registration_id for update;
  select * into g from games where id = r.game_id;

  if not p_ok then
    update stripe_tasks set attempts = attempts + 1, last_error = left(p_error, 500),
           status = case when attempts + 1 >= 10 then 'failed' else 'pending' end
     where id = t.id;
    if t.attempts + 1 >= 10 then
      perform notify_admins('admin_alert', 'Payment problem needs a look',
        'A ' || t.kind || ' for registration #' || r.id || ' failed 10 times: ' || left(coalesce(p_error,''), 200) ||
        ' Check it in your Stripe dashboard.');
    end if;
    return;
  end if;

  update stripe_tasks set status = 'done', done_at = now() where id = t.id;

  if p_result in ('released','refunded') then
    update registrations set pay_state = p_result where id = r.id;
    insert into payment_events (registration_id, game_id, user_id, kind, amount_cents, stripe_ref)
    values (r.id, r.game_id, r.user_id, p_result, coalesce(p_amount, r.amount_cents, 0), p_ref);
    if t.reason <> 'late payment' then
      perform notify(r.user_id, 'refund_issued', 'Refund on its way',
        case when p_result = 'released'
             then 'The ' || fmt_money(coalesce(p_amount, r.amount_cents)) || ' hold on your card was released. It usually disappears within a few days.'
             else 'We refunded ' || fmt_money(coalesce(p_amount, r.amount_cents)) || ' to your card. It can take 5–10 business days to show up.' end);
    end if;
  elsif p_result = 'captured' then
    update registrations set pay_state = 'captured' where id = r.id;
    insert into payment_events (registration_id, game_id, user_id, kind, amount_cents, stripe_ref)
    values (r.id, r.game_id, r.user_id, 'captured', coalesce(p_amount, r.amount_cents, 0), p_ref);
  elsif p_result = 'nothing' and t.kind = 'release_or_refund' and r.pay_state = 'refund_pending' then
    update registrations set pay_state = 'none' where id = r.id;
  end if;
end $$;

-- Notifications for the server to send (email + push).
create or replace function public.take_outbox(p_limit int default 25) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ids bigint[];
begin
  select array_agg(id) into ids from (
    select id from outbox
     where (status = 'pending' and (attempts = 0 or taken_at < now() - make_interval(mins => 5 * attempts)))
        or (status = 'sending' and taken_at < now() - interval '10 minutes')
     order by id limit p_limit for update skip locked) x;
  if ids is null then return '[]'::jsonb; end if;
  update outbox set status = 'sending', taken_at = now(), attempts = attempts + 1 where id = any(ids);
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', o.id, 'kind', o.kind, 'title', o.title, 'body', o.body,
            'email', p.email, 'name', p.full_name,
            'subs', coalesce((select jsonb_agg(jsonb_build_object('endpoint', s.endpoint))
                                from push_subscriptions s where s.user_id = o.user_id), '[]'::jsonb))
            order by o.id), '[]'::jsonb)
          from outbox o join profiles p on p.id = o.user_id where o.id = any(ids));
end $$;

create or replace function public.outbox_result(p_sent bigint[], p_failed bigint[], p_dead_endpoints text[])
returns void language plpgsql security definer set search_path = public as $$
begin
  update outbox set status = 'sent', sent_at = now() where id = any(coalesce(p_sent, '{}'));
  update outbox set status = case when attempts >= 5 then 'failed' else 'pending' end
   where id = any(coalesce(p_failed, '{}'));
  delete from push_subscriptions where endpoint = any(coalesce(p_dead_endpoints, '{}'));
end $$;

-- Push notifications
create or replace function public.save_push(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
declare p profiles := me();
begin
  insert into push_subscriptions (endpoint, user_id, p256dh, auth) values (p_endpoint, p.id, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function public.remove_push(p_endpoint text) returns void
language plpgsql security definer set search_path = public as $$
declare p profiles := me();
begin
  delete from push_subscriptions where endpoint = p_endpoint and user_id = p.id;
end $$;

create or replace function public.latest_for_endpoint(p_endpoint text) returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object('title', o.title, 'body', o.body)
    from push_subscriptions s join outbox o on o.user_id = s.user_id
   where s.endpoint = p_endpoint and o.created_at > now() - interval '3 hours'
   order by o.id desc limit 1 $$;

create or replace function public.get_secret(p_key text) returns text
language sql security definer set search_path = public as $$ select value from app_secrets where key = p_key $$;

create or replace function public.set_secret(p_key text, p_value text) returns void
language sql security definer set search_path = public as $$
  insert into app_secrets (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value, updated_at = now() $$;

create or replace function public.public_config() returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object('vapid_public_key', (select value from app_secrets where key = 'vapid_public')) $$;

-- ---------------------------------------------------------------------
-- Organizer (admin) tools
-- ---------------------------------------------------------------------

create or replace function public.admin_board(p_game bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a profiles := require_admin(); g games;
begin
  if p_game is null then g := ensure_next_game(); else select * into g from games where id = p_game; end if;
  return jsonb_build_object(
    'game', game_json(g),
    'settings', (select to_jsonb(s) from settings s where id = 1),
    'registrations', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'status', r.status, 'name', pr.full_name, 'email', pr.email, 'phone', pr.phone,
        'user_id', pr.id, 'blocked', pr.blocked, 'pay_state', r.pay_state, 'amount_cents', r.amount_cents,
        'sort_at', r.sort_at, 'created_at', r.created_at, 'paid_at', r.paid_at, 'is_manual', r.is_manual,
        'hold_expires_at', r.hold_expires_at, 'offer_expires_at', r.offer_expires_at,
        'late_drop_refund', r.late_drop_refund) order by r.sort_at, r.id)
      from registrations r join profiles pr on pr.id = r.user_id where r.game_id = g.id), '[]'::jsonb),
    'collected_cents', coalesce((select sum(case when kind in ('charged','captured') then amount_cents
                                                when kind = 'refunded' then -amount_cents else 0 end)
                                   from payment_events where game_id = g.id), 0),
    'on_hold_cents', coalesce((select sum(amount_cents) from registrations
                                where game_id = g.id and pay_state = 'authorized'), 0),
    'failed_tasks', (select count(*) from stripe_tasks where status = 'failed'));
end $$;

create or replace function public.admin_players() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a profiles := require_admin();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.full_name, 'email', p.email, 'phone', p.phone, 'blocked', p.blocked,
      'is_admin', p.is_admin, 'created_at', p.created_at,
      'games_played', (select count(*) from registrations r where r.user_id = p.id and r.status = 'confirmed'))
      order by lower(coalesce(p.full_name, p.email))) from profiles p), '[]'::jsonb);
end $$;

create or replace function public.admin_remove(p_reg bigint, p_refund boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a profiles := require_admin(); r registrations; g games;
begin
  select * into r from registrations where id = p_reg;
  if not found then raise exception 'Player not found.'; end if;
  select * into g from games where id = r.game_id for update;
  select * into r from registrations where id = p_reg for update;
  if r.status not in ('holding','confirmed','waitlisted','offered') then
    raise exception 'That player is not on the list anymore.';
  end if;
  update registrations set status = 'removed', ended_at = now() where id = r.id returning * into r;
  perform close_session(r);
  if p_refund then
    perform give_money_back(r, 'removed by organizer');
  elsif r.pay_state = 'authorized' then
    perform enqueue_task(r.id, 'capture', 'removed without refund');
  end if;
  perform notify(r.user_id, 'removed', 'You were removed from the game',
    'The organizer removed you from ' || fmt_day(g.kickoff_at) || '.' ||
    case when p_refund and r.pay_state in ('authorized','captured') then ' Your payment is being returned.' else '' end);
  perform promote(g.id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_add(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a profiles := require_admin(); g games; p profiles;
begin
  g := ensure_next_game();
  select * into g from games where id = g.id for update;
  if g.cancelled_at is not null then raise exception 'This game was cancelled.'; end if;
  select * into p from profiles where id = p_user;
  if not found then raise exception 'Player not found.'; end if;
  if exists (select 1 from registrations where game_id = g.id and user_id = p_user
              and status in ('holding','confirmed','waitlisted','offered')) then
    raise exception '% is already on the list. Remove them first.', coalesce(p.full_name, p.email);
  end if;
  if active_count(g.id) >= g.max_players then
    raise exception 'The game is full (% players). Remove someone or raise the player limit first.', g.max_players;
  end if;
  insert into registrations (game_id, user_id, status, pay_state, is_manual, amount_cents, paid_at)
  values (g.id, p_user, 'confirmed', 'manual', true, 0, now());
  if p_user <> a.id then
    perform notify(p_user, 'added', 'You''re in! ✓',
      'The organizer added you to ' || fmt_day(g.kickoff_at) || ' at ' || fmt_time(g.kickoff_at) || ' (' || g.location || ').');
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_move(p_reg bigint, p_direction text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a profiles := require_admin(); r registrations; other registrations; grp text[]; tmp timestamptz;
begin
  select * into r from registrations where id = p_reg;
  if not found then raise exception 'Player not found.'; end if;
  perform 1 from games where id = r.game_id for update;
  grp := case when r.status in ('waitlisted','offered') then array['waitlisted','offered']
              else array['confirmed','holding'] end;
  if p_direction = 'up' then
    select * into other from registrations where game_id = r.game_id and status = any(grp)
       and (sort_at, id) < (r.sort_at, r.id) order by sort_at desc, id desc limit 1;
  else
    select * into other from registrations where game_id = r.game_id and status = any(grp)
       and (sort_at, id) > (r.sort_at, r.id) order by sort_at, id limit 1;
  end if;
  if not found then return jsonb_build_object('ok', true); end if;
  tmp := r.sort_at;
  if tmp = other.sort_at then tmp := tmp + case when p_direction = 'up' then interval '1 microsecond' else interval '-1 microsecond' end; end if;
  update registrations set sort_at = other.sort_at where id = r.id;
  update registrations set sort_at = tmp where id = other.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_cancel_game(p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a profiles := require_admin(); g games; r registrations; n int := 0;
begin
  g := ensure_next_game();
  select * into g from games where id = g.id for update;
  if g.cancelled_at is not null then raise exception 'This game is already cancelled.'; end if;
  update games set cancelled_at = now(), cancel_reason = nullif(trim(p_reason), '') where id = g.id;
  for r in select * from registrations where game_id = g.id and status in ('holding','confirmed','waitlisted','offered') for update loop
    update registrations set status = 'cancelled', ended_at = now() where id = r.id;
    perform close_session(r);
    perform give_money_back(r, 'game cancelled');
    perform notify(r.user_id, 'game_cancelled', 'Game cancelled',
      'The ' || fmt_day(g.kickoff_at) || ' game is cancelled' ||
      coalesce(' (' || nullif(trim(p_reason), '') || ')', '') || '.' ||
      case when r.pay_state in ('authorized','captured') then ' Your payment is being returned automatically.' else '' end);
    n := n + 1;
  end loop;
  -- Pending late-drop refunds: refund those too, since the game isn't happening.
  for r in select * from registrations where game_id = g.id and late_drop_refund = 'pending' for update loop
    update registrations set late_drop_refund = 'refunded' where id = r.id;
    perform give_money_back(r, 'game cancelled');
  end loop;
  return jsonb_build_object('ok', true, 'players', n);
end $$;

create or replace function public.admin_update_game(p_location text, p_max_players int, p_kickoff_time time) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a profiles := require_admin(); g games; s settings; k timestamptz;
begin
  g := ensure_next_game();
  select * into g from games where id = g.id for update;
  select * into s from settings where id = 1;
  if p_max_players is not null and p_max_players < active_count(g.id) then
    raise exception 'There are already % players. Remove some before lowering the limit.', active_count(g.id);
  end if;
  k := case when p_kickoff_time is null then g.kickoff_at
            else local_ts((g.kickoff_at at time zone tz())::date, p_kickoff_time) end;
  update games set location = coalesce(nullif(trim(p_location), ''), location),
                   max_players = coalesce(p_max_players, max_players),
                   kickoff_at = k,
                   ends_at = k + make_interval(mins => s.duration_minutes),
                   closes_at = k - make_interval(mins => s.close_minutes_before)
   where id = g.id;
  perform promote(g.id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_update_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a profiles := require_admin();
begin
  update settings set
    location             = coalesce(nullif(trim(p->>'location'), ''), location),
    price_cents          = coalesce((p->>'price_cents')::int, price_cents),
    max_players          = coalesce((p->>'max_players')::int, max_players),
    kickoff_dow          = coalesce((p->>'kickoff_dow')::int, kickoff_dow),
    kickoff_time         = coalesce((p->>'kickoff_time')::time, kickoff_time),
    duration_minutes     = coalesce((p->>'duration_minutes')::int, duration_minutes),
    opens_dow            = coalesce((p->>'opens_dow')::int, opens_dow),
    opens_time           = coalesce((p->>'opens_time')::time, opens_time),
    close_minutes_before = coalesce((p->>'close_minutes_before')::int, close_minutes_before),
    drop_deadline_dow    = coalesce((p->>'drop_deadline_dow')::int, drop_deadline_dow),
    drop_deadline_time   = coalesce((p->>'drop_deadline_time')::time, drop_deadline_time),
    hold_minutes         = coalesce((p->>'hold_minutes')::int, hold_minutes),
    offer_minutes        = coalesce((p->>'offer_minutes')::int, offer_minutes),
    late_offer_minutes   = coalesce((p->>'late_offer_minutes')::int, late_offer_minutes),
    quiet_start          = coalesce((p->>'quiet_start')::time, quiet_start),
    quiet_end            = coalesce((p->>'quiet_end')::time, quiet_end),
    updated_at           = now()
  where id = 1;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_message(p_title text, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a profiles := require_admin(); g games; n int;
begin
  if coalesce(trim(p_body), '') = '' then raise exception 'Please write a message.'; end if;
  g := ensure_next_game();
  insert into outbox (user_id, kind, title, body)
  select distinct user_id, 'admin_message', coalesce(nullif(trim(p_title), ''), 'Message from the organizer'), trim(p_body)
    from registrations where game_id = g.id and status in ('holding','confirmed','waitlisted','offered');
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'sent_to', n);
end $$;

create or replace function public.admin_block(p_user uuid, p_blocked boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a profiles := require_admin();
begin
  if p_user = a.id then raise exception 'You can''t block yourself.'; end if;
  update profiles set blocked = p_blocked where id = p_user;
  return jsonb_build_object('ok', true);
end $$;

-- Make someone an organizer (or remove them). Organizers see the Organizer dashboard.
create or replace function public.admin_set_organizer(p_user uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a profiles := require_admin();
begin
  if p_user = a.id and not p_on then raise exception 'You can''t remove yourself as organizer.'; end if;
  update profiles set is_admin = p_on where id = p_user;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_games() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a profiles := require_admin();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', g.id, 'kickoff_at', g.kickoff_at, 'location', g.location, 'cancelled', g.cancelled_at is not null,
      'players', (select count(*) from registrations r where r.game_id = g.id and r.status = 'confirmed'),
      'collected_cents', coalesce((select sum(case when kind in ('charged','captured') then amount_cents
                                                  when kind = 'refunded' then -amount_cents else 0 end)
                                     from payment_events e where e.game_id = g.id), 0))
      order by g.kickoff_at desc) from games g where g.kickoff_at < now() + interval '8 days'), '[]'::jsonb);
end $$;

create or replace function public.admin_payments() returns jsonb
language plpgsql security definer set search_path = public as $$
declare a profiles := require_admin();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'date', e.created_at, 'game', g.kickoff_at, 'player', p.full_name, 'email', p.email,
      'kind', e.kind, 'amount_cents', e.amount_cents, 'stripe_ref', e.stripe_ref) order by e.id desc)
    from payment_events e left join games g on g.id = e.game_id left join profiles p on p.id = e.user_id), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  -- Everything is private by default…
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- …except what signed-in players and the organizer use from the website.
grant execute on function public.get_home()                         to authenticated;
grant execute on function public.my_history()                       to authenticated;
grant execute on function public.save_profile(text, text, boolean)  to authenticated;
grant execute on function public.drop_out()                         to authenticated;
grant execute on function public.save_push(text, text, text)        to authenticated;
grant execute on function public.remove_push(text)                  to authenticated;
grant execute on function public.public_config()                    to anon, authenticated;
grant execute on function public.admin_board(bigint)                to authenticated;
grant execute on function public.admin_players()                    to authenticated;
grant execute on function public.admin_remove(bigint, boolean)      to authenticated;
grant execute on function public.admin_add(uuid)                    to authenticated;
grant execute on function public.admin_move(bigint, text)           to authenticated;
grant execute on function public.admin_cancel_game(text)            to authenticated;
grant execute on function public.admin_update_game(text, int, time) to authenticated;
grant execute on function public.admin_update_settings(jsonb)       to authenticated;
grant execute on function public.admin_message(text, text)          to authenticated;
grant execute on function public.admin_block(uuid, boolean)         to authenticated;
grant execute on function public.admin_games()                      to authenticated;
grant execute on function public.admin_set_organizer(uuid, boolean) to authenticated;
grant execute on function public.admin_payments()                   to authenticated;
