#!/usr/bin/env bash
# 40 members tap "Sign up" at the same moment for 18 spots, from 40 separate connections.
set -euo pipefail
DB=$1
PSQL="psql -h ${PGHOST:-/tmp/pg} -U postgres -X -q -d $DB"
$PSQL <<'SQL' >/dev/null
delete from stripe_tasks; delete from outbox; delete from payment_events; delete from registrations; delete from games;
select make_game('friday', '2026-10-16');
insert into auth.users (id, email) select gen_random_uuid(), 'race' || i || '@example.com' from generate_series(1, 40) i;
update profiles set full_name = 'Racer', waiver_accepted_at = now(), blocked = false where email like 'race%';
insert into memberships (user_id, category_id, status) select id, 'friday', 'approved' from profiles where email like 'race%';
SQL
GAME=$($PSQL -t -A -c "select id from games limit 1")
pids=()
for u in $($PSQL -t -A -c "select id from auth.users where email like 'race%'"); do
  $PSQL -c "set test.now = '2026-10-12 14:00:01 America/Chicago'" -c "select claim_spot('$u', $GAME)" >/dev/null &
  pids+=($!)
done
for p in "${pids[@]}"; do wait $p; done
$PSQL -t -A -c "select case when count(*) filter (where status='holding') = 18 and count(*) filter (where status='waitlisted') = 22
  then 'ok - 40 simultaneous taps: exactly 18 got spots, 22 waitlisted' else 'FAILED race: ' || count(*) filter (where status='holding') || ' holding' end
  from registrations"
