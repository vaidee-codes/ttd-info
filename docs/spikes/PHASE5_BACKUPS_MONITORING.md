# Phase 5 — backups and monitoring

## Backups (done 30 Sep, see PHASE2 notes)
Nightly 02:30 IST: encrypted `pg_dump` of `keygen_prod` + `ttd-ledger` → S3 `ttd-autofill-db-backups-419741996286` (upload-only credentials; restore verified). **New:** each run inserts a heartbeat into ledger `backup_runs(host, ok, databases, bytes)` (`db/ledger/005_monitoring.sql`).

## Monitoring — `api/health-watch.mjs` (Vercel Cron */5, CRON_SECRET)
Checks: Keygen `/v1/health` on the VPS (10 s), last successful backup < 26 h, paid orders without a licence > 2 min, failed licence emails in 24 h. State in `alert_state`: email `ALERT_EMAIL` via Resend on first failure, remind every 6 h while failing, "RECOVERED" email when it clears. Tests `test/health-watch.test.mjs` (4); suite 126/126.

Live on the test app: first run correctly raised `email_failures` (the sandbox email Resend refused). `ALERT_EMAIL` must be the Resend account's own address until a domain is verified (the owner's other address was refused); set to the address that received the sandbox key email. Alert delivery confirmed.

Limits: the watchdog runs on Vercel, so a full Vercel outage is not reported — add a cronmint job hitting `https://13-205-179-101.sslip.io/v1/health` and `https://ttd-info.vercel.app/api/config` for outside-in checks.
