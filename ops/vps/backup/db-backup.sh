#!/usr/bin/env bash
# Nightly: pg_dump each database -> age-encrypt -> upload to S3 (upload-only credentials).
# Config in /home/ubuntu/backup/.env (600): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
# BUCKET, AGE_RECIPIENT, and one DB_URL_<name>=postgresql://... per database.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
set -a; . ./.env; set +a

STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
DAY="$(date -u +%d)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
failed=0
count=0
total=0

for var in $(compgen -v | grep '^DB_URL_'); do
  name="${var#DB_URL_}"
  file="$WORK/$name-$STAMP.dump.age"
  if docker run --rm -e PGURL="${!var}" postgres:17-alpine sh -c 'pg_dump --format=custom --no-owner --no-privileges "$PGURL"' \
      | age -r "$AGE_RECIPIENT" -o "$file" && [ -s "$file" ]; then
    for prefix in daily $( [ "$DAY" = "01" ] && echo monthly ); do
      docker run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION=ap-south-1 \
        -v "$WORK:/w:ro" amazon/aws-cli:2.27.50 s3 cp --only-show-errors "/w/$(basename "$file")" "s3://$BUCKET/$prefix/$name/$(basename "$file")"
    done
    size=$(stat -c %s "$file"); count=$((count + 1)); total=$((total + size))
    echo "{\"event\":\"db_backup\",\"db\":\"$name\",\"ok\":true,\"bytes\":$size}"
  else
    echo "{\"event\":\"db_backup\",\"db\":\"$name\",\"ok\":false}" >&2
    failed=1
  fi
done

# Heartbeat for the monitoring cron (ledger table backup_runs).
ok=$([ "$failed" = 0 ] && echo true || echo false)
docker run --rm -e PGURL="$DB_URL_ttd_ledger" postgres:17-alpine sh -c \
  "psql \"\$PGURL\" -qc \"insert into public.backup_runs(host, ok, databases, bytes) values ('$(hostname)', $ok, $count, $total)\"" \
  || echo '{"event":"db_backup_heartbeat","ok":false}' >&2

[ -n "${HEALTHCHECK_URL:-}" ] && [ "$failed" = 0 ] && curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null || true
exit "$failed"
