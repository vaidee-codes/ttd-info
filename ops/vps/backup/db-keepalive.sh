#!/usr/bin/env bash
# Every 6 h: a small read on each Supabase database, so neither free-plan project
# is ever idle long enough to be paused (Supabase pauses after 7 idle days).
# Independent of Vercel: the 5-minute health check there does the same, this is
# the second line. Uses the same /home/ubuntu/backup/.env (DB_URL_<name>=…).
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
failed=0
for var in $(compgen -v | grep '^DB_URL_'); do
  if docker run --rm -e PGURL="${!var}" postgres:17-alpine sh -c 'psql "$PGURL" -tAqc "select count(*) from pg_stat_user_tables"' >/dev/null 2>&1; then
    echo "{\"event\":\"db_keepalive\",\"db\":\"${var#DB_URL_}\",\"ok\":true}"
  else
    echo "{\"event\":\"db_keepalive\",\"db\":\"${var#DB_URL_}\",\"ok\":false}" >&2; failed=1
  fi
done
exit "$failed"
