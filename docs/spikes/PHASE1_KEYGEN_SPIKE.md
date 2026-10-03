# Phase 1 spike — Keygen CE hosting and licensing behaviour

Branch: `spike/razorpay-keygen-phase1` (worktree `../ttd-info-keygen-spike`). Nothing here touches the production `ttd-info` Vercel project, its env or Dodo.
Plan: `autofill-extension/docs/RAZORPAY_KEYGEN_CE_SELF_HOSTED_PLAN.md`.

## What is being decided

| Option | Where Keygen runs | Status |
|---|---|---|
| **A. Vercel Pro container** | Separate Vercel project `ttd-keygen-spike` (bom1), `keygen/api:v1.7.2` + instance-local Redis + embedded Sidekiq | Image builds and boots on Vercel; waiting on DB env |
| **B. Always-on VM** | `spike/keygen/vm/docker-compose.yml` (web, worker, Redis, Cloudflare quick tunnel) | Waiting on an Oracle Cloud account |

Both use the Supabase `keygen` project as Postgres. Portal (pinned `keygen-portal@d34789f`, `VITE_KEYGEN_VERSION=1.7`) is a static site on its own Vercel project.

## Decision criteria

Option A is chosen only if **all** hold; otherwise B.

| # | Criterion | Target | A result | B result |
|---|---|---|---|---|
| 1 | `keygen-smoke.mjs` functional checks | all PASS | **28/29 PASS** ×3 runs; the only failure is #4 | ✅ **29/29 PASS** |
| 2 | Cold start (first request after > 5 min idle) | median ≤ 10 s, max ≤ 20 s (activation timeout) | ❌ **14.1–14.5 s** in 3/3 idle rounds (7 min idle), warm 45–68 ms. Misses the 10 s median target but is inside the 20 s activation timeout | n/a |
| 3 | Warm `validate-key` latency from India | p95 ≤ 800 ms | **p50 70–86 ms, p95 ~144 ms** ✅ | ❌ via quick tunnel p50 411 ms / p95 1,191 ms; on-box p50 262 ms / p95 694 ms (E2.1.Micro is CPU-bound) |
| 4 | Grant clock starts on first activation without an always-on worker | expiry set within 10 s | ❌ Keygen sets it in a Sidekiq job (`EventNotificationWorker` → `set_expiry_on_first_activation!`); paused instances don't run it. **Fix: adapter sets expiry explicitly on first activation** (host-independent) | ✅ 7.000 days (worker runs) |
| 5 | Admin change visible on next validation (suspend, deactivate) | immediate | ✅ 3/3 after retest. The single earlier miss was a request that hit a booting instance. Validation doesn't use the Redis cache | — |
| 6 | Portal against Keygen 1.7: sign in, create licence, list machines, deactivate machine | works | Deployed; login page loads for our account and CORS allows it. **Owner sign-in check pending** | — |
| 7 | Monthly cost at 2,000 users | inside the Pro plan's included usage | Pending Vercel usage readout after the test day | ₹0 |

Row 5 matters for A: each instance has its own Redis cache, so a stale cache on a second instance would show up here.

## Findings so far (26 Sep 2026)

- Container Images (Beta) **is enabled** for the team. Vercel ignores a bare `Dockerfile.vercel`; the explicit `services.<name>.runtime = "container"` config in `vercel.json` is required.
- `keygen/api:v1.7.2` builds on Vercel (buildah, x86) and starts in `bom1`. Redis inside the container starts in < 1 s. Rails loads and stops on the missing `KEYGEN_HOST`, which is expected with no env set.
- `rails keygen:setup` runs non-interactively when `KEYGEN_HOST`, `KEYGEN_ACCOUNT_ID`, `KEYGEN_ADMIN_EMAIL` and `KEYGEN_ADMIN_PASSWORD` are set. `start.sh` runs it once, only when `KEYGEN_BOOTSTRAP=1` **and** the `accounts` table does not exist, and keeps its output (which contains secrets) out of the logs.
- Keygen serves API version = release major.minor (v1.7.x → 1.7). Portal master defaults to 1.8, so it is built with `VITE_KEYGEN_VERSION=1.7`. The build succeeds; runtime compatibility is criterion 6.
- Portal needs pnpm build scripts allowed for `esbuild` and `@tailwindcss/oxide` (pnpm 11 blocks them by default).
- No Docker on the dev Mac. Option B is exercised on the VM itself once the account exists.

### 26 Sep — live results (option A)

- The first deploy ran `keygen:setup` once (9 s) against Supabase `keygen` (ap-south-1 session pooler). A concurrent second instance correctly skipped it. Bootstrap vars have since been removed.
- Boot breakdown: container + Redis < 1 s; a second Rails boot for `db:migrate` ~5 s (now opt-in via `KEYGEN_MIGRATE_ON_BOOT=1`); Puma boot about the rest.
- Vercel starts extra instances under a sequential test (new `spike_boot` every ~40 s). Any request routed to a booting instance waits for the full cold start. In one run that exceeded the smoke test's 30 s client timeout.
- Verified on CE 1.7.2: custom keys kept verbatim (UUID, grouped, fixture-style, 128-char); `FROM_CREATION` expiry = exactly 7 days; `maxMachines=1` → `MACHINE_LIMIT_EXCEEDED`; same fingerprint → `FINGERPRINT_TAKEN` (adapter must treat as "already activated here"); admin `DELETE /machines/:id` frees the slot immediately; suspend/reinstate; per-licence `maxMachines` override; past expiry → `EXPIRED`; customers as passwordless users; offline-sale metadata search (`metadata[reference]=…`).
- **Version correction:** the `keygen/api:v1.7.2` Docker tag actually runs **Keygen 1.8.0** (revision 055c872, per the worker banner). Pin by digest, not tag. With `Keygen-Version: 1.8` the email-only login probe returns `PASSWORD_REQUIRED`, so Portal is now built with `VITE_KEYGEN_VERSION=1.8` and works **unpatched** (email → password step verified). The earlier `CREDENTIALS_INVALID` failure came from forcing API 1.7. The image is multi-arch (amd64 + arm64); the docs saying x86-only are stale.
- **Worker pool:** Keygen 1.8's bulk-fetch capsule needs `SIDEKIQ_CONCURRENCY >= 5`; lower values crash-loop the worker (`Pool size too small for perform_bulk:processing`). The Vercel image had 2, so its embedded worker was likely never running. Both configs now use 5.
- Keygen sends `Access-Control-Allow-Origin: *`, so Portal on its own vercel.app host can call the API.
- Adapter requirement from #4: on a successful first activation for a `grant-*` licence with `expiry == null`, PATCH `expiry = now + policy.duration`. Idempotent; guard with the same null check.

## Runbook

1. **Env (owner runs; reads `~/.dbpassword` locally):**
   ```bash
   cd spike/keygen/scripts
   ./set-vercel-env.sh --pooler-uri 'postgresql://postgres.<ref>:[YOUR-PASSWORD]@<pooler-host>:5432/postgres' --admin-email <you>
   ```
   Use the Supabase `keygen` project → Connect → **Session pooler** URI. Generated Keygen secrets land in `~/.keygen-spike.env` (600). Back them up.
2. **Deploy:** `cd spike/keygen/vercel && vercel deploy --prod --yes`, then `curl https://ttd-keygen-spike.vercel.app/v1/ping`.
3. **Finish bootstrap:** `./set-vercel-env.sh --finish-bootstrap`, then redeploy with `--prod`.
4. **Functional:** `node spike/keygen/scripts/keygen-smoke.mjs` (add `--keep` to leave records for Portal checks).
5. **Cold start:** `node spike/keygen/scripts/coldstart.mjs https://ttd-keygen-spike.vercel.app 4 7`.
6. **Portal:** `spike/keygen/portal/build-and-deploy.sh` → sign in at the printed URL with the admin email and the password from `~/.keygen-spike.env`.
7. **Redis volume (A):** on scale-in the container logs a `spike_redis_stats` line; read it with `vercel logs`.

## Cleanup when the spike ends

Delete Vercel projects `ttd-keygen-spike` and `ttd-keygen-portal-spike`, drop the Keygen tables in the Supabase `keygen` project (production gets a fresh `keygen:setup`), and remove `~/.keygen-spike.env`.

### 26 Sep — live results (option B: Oracle E2.1.Micro, Mumbai)

- A1.Flex (ARM) was **out of capacity** in ap-mumbai-1 (single AD). Fell back to **VM.Standard.E2.1.Micro** (x86, 1 GB, 1/8 OCPU baseline). Added 2 GB swap. Steady state ≈ 670 MB RAM + ~130 MB swap with web, worker (concurrency 5), Redis and cloudflared.
- The same Supabase `keygen` DB and the same Keygen secrets as option A, so both hosts serve the same account side by side.
- **Host routing:** Keygen only serves account routes on `KEYGEN_HOST`'s domain, so the VM must use its public hostname as `KEYGEN_HOST` (quick-tunnel host for the spike). The container healthcheck needs a `Host:` header or Rails blocks it. **Production needs a stable hostname:** a domain with a named tunnel, or a free `<ip>.sslip.io` name with Caddy/Let's Encrypt on 443 (opens a port). A quick tunnel's name changes on every restart and is not for production.

## Comparison and recommendation (26 Sep)

| | A. Vercel Pro container | B. Oracle E2.1.Micro |
|---|---|---|
| Functional | **29/29 ×3** after the worker-pool and transaction-pooler fixes | 29/29 |
| Warm latency (p50 / p95) | **67–73 / 92–113 ms** | 262 / 694 ms on-box; 411 / 1,191 ms via tunnel |
| Cold start | ~14 s after 5 min idle; mitigate with a keep-warm cron | none (always on) |
| Background jobs / Keygen webhooks | unreliable (instances pause) | reliable |
| Stable hostname without a domain | ✅ `*.vercel.app` | ❌ needs a domain or sslip.io + open port |
| Ops burden | none (deploys like the rest of ttd-info) | VM patching, Docker, backups of Redis config, reclaim risk |
| Cost | inside Pro included usage (to confirm from usage page) | ₹0 |

**Recommendation: A (Vercel Pro container)**, with four conditions: (0) `DATABASE_URL` uses the Supabase **transaction pooler :6543**; (1) the licensing adapter also sets `grant-*` expiry on first activation (guard against lost jobs); (2) nothing depends on Keygen webhooks (offline sales and audit go through our own endpoints); (3) a Vercel cron pings `/v1/ping` every 4 minutes to keep one instance warm. Next test: whether keep-warm removes the cold starts and stops extra instances booting cold. Keep B as the documented fallback; it needs a stable hostname before it could be production.

### 26 Sep — database connection limit (affects both options)

- Supabase Free **session pooler allows only 15 clients** (`EMAXCONNSESSION … pool_size: 15`). VM web (3) + worker (5) plus several Vercel instances (3 web + 5 worker each) exhausted it, and validations started returning 500.
- **Fix: use the transaction pooler (port 6543).** Keygen already sets `prepared_statements: false` and uses no Postgres advisory locks (its locks are in Redis), so it is compatible. After switching, option A passed 29/29 three times in a row. Caveat: `statement_timeout` set per connection may not stick under transaction pooling, so rely on rack-timeout (15 s).
- With the worker fixed (concurrency 5), **first-activation expiry works on Vercel** too; the job runs while an instance is active. Keep the adapter's explicit expiry as a guard anyway, because a job enqueued just before an instance scales in is lost with that instance's Redis.
- The VM stack is stopped (`docker compose stop web worker`) so it doesn't compete for connections. Redis and the tunnel are still up.

### 27 Sep — keep-warm and cost

- **Keep-warm cron bug:** Vercel crons call the *deployment* hostname (`ttd-keygen-spike-<hash>.vercel.app`), which Keygen's host allowlist rejects (403 `Blocked hosts`). Fix: the cron targets `/v1/health`, which Keygen exempts from host authorization (`config.host_authorization exclude: ^/v\d+/health`). Verified 204 on the deployment host (cold 16 s, then 0.37 s). **Re-measured with the fixed cron: after 7 min idle the first request took 485 / 604 / 687 ms (3/3 rounds) instead of ~14 s.** Cold starts are eliminated for normal traffic.
- **Cost (billing period 1–27 Sep, whole team):** usage excluding the Pro subscription line = **$5.79** of the $20 included credit; **billed $0.00**. Keygen so far: `ttd-keygen-spike` $0.05 (Build CPU $0.028, VCR image storage $0.025); runtime CPU/memory not yet visible in the data. A daily scheduled task (`vercel-cost-check`, 9:00 local) logs team usage, projection and Keygen's share to `docs/spikes/vercel-cost-log.md`.

## Phase 1 decision

**Host Keygen CE on Vercel Pro (option A)**, in its own Vercel project, region bom1, with the Supabase `keygen` project on the **transaction pooler (:6543)**, `SIDEKIQ_CONCURRENCY=5`, and a `/v1/health` keep-warm cron every 4 minutes. Option B (Oracle VM) remains the documented fallback and is kept stopped.

Still open before Phase 1 is formally closed: (a) ~~keep-warm re-test~~ ✅ done; (b) the owner's Portal walkthrough (deactivate a machine, create a licence, search metadata); (c) one week of `vercel-cost-log.md` showing Keygen's projected monthly cost stays well under the credit.
