#!/usr/bin/env bash
# Runs the database rule tests against a throwaway local Postgres (needs Postgres 16 installed).
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL="psql -h ${PGHOST:-/tmp/pg} -U postgres -X -q"
DB=fs_test_$$
$PSQL -c "create database $DB"
trap '$PSQL -c "drop database $DB" >/dev/null' EXIT
sed -E 's/\bnow\(\)/public.clock()/g' supabase/schema.sql > /tmp/schema_test_$$.sql
$PSQL -d $DB -v ON_ERROR_STOP=1 -f tests/supabase_stub.sql -f /tmp/schema_test_$$.sql >/dev/null 2>&1
$PSQL -d $DB -f tests/rules_test.sql 2>&1 | grep -E 'ok -|FAILED|ERROR|PASSED|LINE' | sed 's/^psql:[^ ]* //'
bash tests/race_test.sh $DB
