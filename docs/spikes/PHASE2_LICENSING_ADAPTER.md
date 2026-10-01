# Phase 2 — licensing adapter

Branch `spike/razorpay-keygen-phase1`, worktree `../ttd-info-keygen-spike`. Production is unchanged: with no new env vars set, every licence still routes to Dodo.

## Baseline

The committed `main` (12 Sep) is **not** what production runs. Production was deployed from the main clone's uncommitted working tree (13 files, +582/−74: stranded-activation recovery, rejection reasons, instance markers, contract tests). That working tree was copied into this worktree unchanged as the Phase 2 baseline; the main clone itself was not touched. **Commit those main-clone changes before merging this branch**, or this branch will carry them.

## What it does

- `api/_licensing.mjs` decides which provider owns a licence, then runs the Keygen flows for activate, refresh, validate and deactivate. Dodo licences go through the existing code byte-for-byte; the only change to that code is the routing check up front, and the shared `REJECTIONS` moved here.
- `api/_keygen.mjs` is a minimal Keygen API client (API 1.8, product token, 8 s timeout, 20 s for machine creation). It maps Keygen validation codes onto the Dodo-era reasons.
- `api/_ledger.mjs` does read-only Supabase REST lookups for licence authority and instance aliases. Schema: `db/ledger/001_licensing.sql`.

### Contracts kept

- Response shapes, error codes and messages match the Dodo path (`activation_in_use`, `licence_expired`, `licence_disabled`, terminal `{ provider_status: 'invalid' }`, `provider_unavailable`).
- **Product IDs:** the extension only trusts four Dodo product IDs. Keygen licences carry `metadata.publicProductId` (or a policy → product map in `KEYGEN_POLICY_PRODUCTS`), and that ID is what goes into tokens and responses.
- **Migrated licences** keep their Dodo `lic_*` / `lki_*` IDs (`metadata.publicLicenseId`, `metadata.publicInstanceId`, plus ledger aliases), so tokens issued before migration keep refreshing.
- The machine fingerprint is the existing HMAC installation reference (`instref:`), so imported Dodo instances match the same browser.

### Routing rules

1. Activate (key only): the ledger row for `sha256(key)` wins. Otherwise use `LICENSING_PROVIDER` (default `dodo`).
2. Refresh, validate, deactivate (signed claims): a UUID licence ID means native Keygen. A `lic_*` ID goes through the ledger authority row plus the instance alias; a tombstoned alias is terminal. With no ledger row, the request goes to Dodo.
3. **No cross-provider fallback.** A ledger outage returns `provider_unavailable`; it never guesses the provider.

### Keygen behaviours handled

- Same-browser re-activation and `FINGERPRINT_TAKEN` re-attach to the browser's own machine. A machine create that times out after Keygen commits it is recovered.
- `MACHINE_LIMIT_EXCEEDED` returns 409 `activation_in_use`, and no slot is taken.
- **`FROM_FIRST_ACTIVATION` expiry is set by the adapter** (a PATCH guarded by a null check), so Keygen's worker isn't needed.
- A deleted machine, binding mismatch, suspension or expiry is terminal for refresh. Timeouts, 5xx and 429 are `provider_unavailable`, so the client fails open.

## Tests

- `node --test`: **94/94**. That's 77 existing Dodo tests, unchanged, plus 17 in `test/keygen-licensing.test.mjs` against a stateful fake Keygen and ledger.
- `spike/keygen/scripts/adapter-live.mjs` runs the real handlers against the live spike Keygen: **10/10 in three consecutive runs** (activate, re-attach, in-use, refresh, validate, grant clock, deactivate, terminal after deactivate, freed slot, suspend).

## Finding: turn Keygen's worker off on Vercel

With the embedded Sidekiq worker running (concurrency 5), Keygen requests slowed to 0.5–1.5 s. Vercel then added containers, and requests routed to a booting one waited ~14 s, past the adapter's 8 s timeout (3/10 live passes). With `KEYGEN_EMBED_WORKER=0`: median request time ~140 ms, boot ~10 s, 10/10 ×3. Nothing we use needs the worker (no Keygen webhooks; the adapter sets expiry). It is now off by default in the image.

## Env vars (ttd-info)

| Var | Purpose |
|---|---|
| `LICENSING_PROVIDER` | `dodo` (default) or `keygen`: provider for keys the ledger doesn't know |
| `KEYGEN_API_URL`, `KEYGEN_ACCOUNT_ID` | Keygen instance |
| `KEYGEN_PRODUCT_TOKEN`, `KEYGEN_PRODUCT_ID` | Server-side product credential and product scope |
| `KEYGEN_POLICY_PRODUCTS` | Optional JSON `{ "<policyId>": "pdt_…" }` fallback when a licence has no `publicProductId` |
| `TTD_LEDGER_URL`, `TTD_LEDGER_SECRET_KEY` | Supabase `ttd-ledger` REST URL and secret key |

## Still to do in Phase 2

1. Apply `db/ledger/001_licensing.sql` to the Supabase `ttd-ledger` project (needs its project ref).
2. Production Keygen: a fresh `ttd-keygen` Vercel project and clean DB (recommended), with real policies `pass-7d/30d/90d` and `grant-7d/30d/90d`.
3. Preview-deploy this branch of ttd-info (not production) with `LICENSING_PROVIDER=keygen`, and test with the current Web Store extension build against it.
4. Ledger writes (fulfilment and migration) belong to Phases 3 and 6.

## 30 Sep — production Keygen + preview results

Done: ledger tables applied (`ttd-ledger`, RLS on). Production Keygen `ttd-keygen.vercel.app` runs on a separate `keygen_prod` database (Supabase `keygen` project; free plan allows only 2 projects), with fresh secrets (`~/.ttd-keygen-prod.env`), product `TTD Autofill`, policies pass/grant × 7/30/90 (`ops/keygen/provision.mjs`) and a product token. ttd-info preview `ttd-info-r9q8o07g6-…` has Keygen routing via per-deployment `-e` vars; only the two secrets are Preview-scoped env vars (inert without the routing vars). Production env and deployment untouched.

**Blocking finding: Vercel container cold starts are unpredictable under real call patterns.**
- Preview e2e (`ops/keygen/preview-e2e.mjs`): 7/8, then 5/8 and 5/8. Failures are timeouts on Keygen calls that landed on a booting container.
- Production Keygen booted **11 containers in ~3 minutes** of sequential e2e traffic, with no graceful stops in between.
- Controlled test: 3 simultaneous requests 3 minutes after a successful keep-warm ping → **all three took ~9.4 s** (new boots); the next sequential requests took 0.12–0.15 s. Overlapping requests get new containers (no in-instance concurrency for container images), and the kept-warm container is not reliably reused.
- The extension waits 8 s for refresh (fails open) and 30 s for activation. On booking days (hundreds of activations, overlapping), many paying customers would wait 10 s+ and some would time out.

Recommendation: host production Keygen **always-on** (Oracle VM, preferably A1 after upgrading the tenancy to Pay-As-You-Go, since Always Free resources stay free) behind a stable HTTPS name (`<ip>.sslip.io` + Caddy/Let's Encrypt, port 443 open), and keep Vercel only for ttd-info. The adapter code is host-independent; only `KEYGEN_API_URL` changes.

## 30 Sep (later) — staying on Vercel: warm-pool fix

Owner decision: stay on Vercel; a VM only if nothing works. Test app `ttd-info-keygen.vercel.app` (a separate Vercel project, its own production, public) replaces the protected preview. It has its own signing key and log secret (`~/.ttd-info-keygen-test.env`), so its tokens are never trusted by the real extension. ttd-info's Preview secrets were removed again; ttd-info has no Keygen settings anywhere.

- **Root cause confirmed:** Keygen container instances take one request at a time; any overlapping request boots a new one (~9–11 s). A single keep-warm ping keeps only one instance warm.
- **Bootsnap:** tried; the cold boot barely changed (8.5–10.3 s), so it was reverted.
- **Fix: warm pool.** After 4 simultaneous pings, the next 4 simultaneous requests took 0.14–0.22 s after **210 s idle**, twice in a row. `api/keygen-keepwarm.mjs` (cron `*/4 * * * *`, `CRON_SECRET`-protected, no-op when `KEYGEN_API_URL` is unset) pings `KEYGEN_WARM_POOL` (default 4) at once. It is live on the test app, keeping production Keygen's pool warm.
- **Blocker for e2e on the test app:** its licence endpoints fail closed until the Firewall rule `pass-license-key` (`@vercel/firewall` rate-limit ID) exists. The Vercel API returns "config not found" for this team, so the owner has to add it in the dashboard.

## 30 Sep — test app e2e after the firewall rule

- Firewall rule added by the owner; the fake key now returns `licence_invalid`, as expected.
- Warm pool (4) alone: e2e 5/8, 5/8, 6/8. 10 Keygen boots in ~2 min of sequential test traffic.
- Controlled tests: 80 sequential `curl` requests from a laptop → **0 boots**, p50 0.12 s. 30 sequential Node `fetch` requests (keep-alive) → **3 boots**, max 10.3 s. The same with keep-alive disabled (undici `Agent({ pipelining: 0 })`) → **0 boots**, max 0.32 s.
- Keep-alive disabled in `_keygen.mjs`, the keep-warm function and the e2e harness. e2e: 8/8 ×3, then 5/8 ×2 (7 boots); after also fixing the harness: 6, 6, 4, 5, 5 of 8 (10 boots).
- **Conclusion:** boots triggered by Vercel-function → Vercel-container traffic can't be controlled from our side. Keep-alive made it worse, but disabling it doesn't stop it. We tried: single keep-warm ping, warm pool, Bootsnap, no keep-alive. Per the owner's rule ("if nothing works, a VM"), Keygen should move to an always-on VM. The adapter needs no changes beyond `KEYGEN_API_URL`, and keeping keep-alive off is harmless on a VM.

## 30 Sep — Keygen moved to an AWS Lightsail VPS (owner decision)

- Vercel Keygen projects deleted (`ttd-keygen`, `ttd-keygen-spike`, `ttd-keygen-portal-spike`). Data kept in Supabase `keygen_prod`.
- VPS: Lightsail `ttd-keygen`, Mumbai `ap-south-1a`, `micro_3_1` (1 GB, 2 vCPU, $7/mo), Ubuntu 24.04, static IP `13.205.179.101`, SSH only from the owner's IP, 80/443 open. Created by `ops/vps/create-lightsail.sh` (AWS profile `ttd`); stack in `ops/vps/docker-compose.yml`: Keygen web (pinned digest, no worker), Redis, Caddy with Let's Encrypt for `13-205-179-101.sslip.io`. 2 GB swap. DB: `keygen_prod` via the Supabase session pooler (5432).
- Results through the test app `ttd-info-keygen` (`KEYGEN_API_URL=https://13-205-179-101.sslip.io`):
  - e2e **8/8 ×5 sequential** and **8/8 ×5 run simultaneously**.
  - 30 simultaneous validate-key calls: all 200, p50 0.31 s, p90 0.34 s, max 2.2 s.
  - VPS under that load: Keygen web 254 MB, load average 0.10, ~290 MB RAM available, 78 MB swap in use. The 1 GB plan is sufficient for now; `BUNDLE=small_3_1` upgrades to 2 GB.
- Still to do: rebuild Portal (static) for the new host; backups (only Caddy certs and Redis live on the VPS; licence data is in Supabase); monitoring via cronmint or UptimeRobot on `/v1/health`; a real domain later instead of sslip.io.

## 30 Sep — nightly database backups

- CloudFormation stack `ttd-autofill-backups` (`ops/vps/backup-stack.yaml`, ap-south-1): private, SSE-S3, versioned bucket `ttd-autofill-db-backups-419741996286`, TLS-only policy, lifecycle `daily/` 35 days and `monthly/` 400 days. IAM user `ttd-backup-uploader` has `s3:PutObject` only (list and delete verified AccessDenied).
- VPS: `ops/vps/backup/` → `/home/ubuntu/backup/`. A systemd timer runs at 21:00 UTC (02:30 IST): `pg_dump -Fc` (postgres:17 image) for `keygen_prod` and `ttd-ledger` → age-encrypted to the owner's public key → S3 (aws-cli image). On the 1st of each month it also writes to `monthly/`. Optional `HEALTHCHECK_URL` gets a ping on success (point a cronmint or Healthchecks job at it).
- Restore verified on the Mac (`age -d -i ~/.ttd-backup-age.key` → `pg_restore --list`): keygen_prod 50 tables, ttd_ledger 40 tables. **`~/.ttd-backup-age.key` is the only decryption key; keep it in the password manager.**
- Restore procedure: download from S3 → `age -d -i ~/.ttd-backup-age.key -o x.dump x.dump.age` → `pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" x.dump` (libpq 17+ client).
