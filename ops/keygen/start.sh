#!/usr/bin/env bash
# Boots Keygen web + an embedded Sidekiq worker + an instance-local Redis.
# Redis here is ephemeral per instance; the spike measures whether that is acceptable.
set -euo pipefail
cd /app

log() { echo "{\"event\":\"spike_boot\",\"step\":\"$1\",\"t\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"; }
log start

rm -f tmp/pids/server.pid
redis-server --port 6379 --bind 127.0.0.1 --save '' --appendonly no \
  --maxmemory 64mb --maxmemory-policy noeviction --dir /tmp --daemonize yes >/dev/null
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379/0}"
log redis_up

report_redis() {
  echo "{\"event\":\"spike_redis_stats\",$(redis-cli info stats | tr -d '\r' \
    | awk -F: '/^(total_commands_processed|total_connections_received|instantaneous_ops_per_sec)/{printf "\"%s\":%s,", $1, $2}') \"uptime_s\":$(redis-cli info server | tr -d '\r' | awk -F: '/^uptime_in_seconds/{print $2}')}"
}
trap 'report_redis; kill -TERM "${WEB_PID:-0}" "${WORKER_PID:-0}" 2>/dev/null; wait' TERM INT

if [ "${KEYGEN_BOOTSTRAP:-0}" = "1" ]; then
  ready=$(psql "$DATABASE_URL" -tAc "select to_regclass('public.accounts') is not null" 2>/dev/null || echo error)
  if [ "$ready" = "f" ]; then
    log setup_begin
    # Setup prints generated config (incl. secrets); keep it out of logs.
    if ! bundle exec rails keygen:setup </dev/null >/tmp/setup.log 2>&1; then
      grep -viE 'secret|encryption|password|key_base|salt' /tmp/setup.log | tail -n 30
      exit 1
    fi
    log setup_done
  else
    log "setup_skipped_$ready"
  fi
fi

# Migrating on every cold start costs a second Rails boot (~5 s); only do it when upgrading.
if [ "${KEYGEN_MIGRATE_ON_BOOT:-0}" = "1" ]; then
  bundle exec rails db:migrate >/tmp/migrate.log 2>&1 || { tail -n 30 /tmp/migrate.log; exit 1; }
  log migrated
fi

# Off by default: the worker competes with Puma for the container CPU, which
# slows requests and makes Vercel add cold instances. Nothing we use needs it.
if [ "${KEYGEN_EMBED_WORKER:-0}" = "1" ]; then
  bundle exec sidekiq >/tmp/sidekiq.log 2>&1 &
  WORKER_PID=$!
  log worker_started
fi

bundle exec rails server -b 0.0.0.0 -p "${PORT}" &
WEB_PID=$!
log web_started
wait "$WEB_PID"
