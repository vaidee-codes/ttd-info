# Cutover runbook — Dodo → Razorpay + Keygen (Phases 7–9)

Owner approval is required before **every** step marked 🔴 (it touches production `ttd-info.vercel.app` or real money). All other steps are safe to repeat.

Branch `spike/razorpay-keygen-phase1` (worktree `../ttd-info-keygen-spike`). Scripts in `scripts/migrate/` and `ops/keygen/`. Snapshots, plans and state live in `~/ttd-migration/` (age-encrypted to `~/.ttd-backup-age.key`).

## 0. Preconditions

- [ ] Commit the uncommitted production code in the **main clone** (`../ttd-info`, 17 files); production runs it today. Rebase this branch on it.
- [ ] Razorpay **live** webhook created (Dashboard, Live mode → Webhooks): URL `https://ttd-info.vercel.app/api/razorpay-webhook`, events `payment.captured, order.paid, payment.authorized, payment.failed, refund.processed, payment.dispute.created`, new secret → `~/.razorpay-live-webhook-secret`.
- [ ] Razorpay live keys in `~/.razorpayenv` (already there).
- [x] Email: `ttd-autofill.com` verified on Amazon SES (DKIM + MAIL FROM `ses.ttd-autofill.com`), Resend and Brevo.
- [ ] Amazon SES production access approved (case 179081960100709). Until then SES only reaches verified addresses and mail falls through to Resend (100/day free) and Brevo (300/day free); anything over that waits in the outbox and goes out the next day.
- [ ] Rehearsal passed: reconcile 0 differences, `verify-adapter.mjs` all PASS (see PHASE6 notes).
- [ ] `TTDAF_LOG_CORRELATION_SECRET` in production is **never rotated**: migrated browsers are matched by an HMAC of it.

## Phase 7 — production setup (dark)

1. **Clean the test data** out of the production ledger and Keygen:
   `node scripts/migrate/cleanup-test-data.mjs` (report) → `--confirm`. Deletes only Razorpay-test-mode orders and offline sales tagged by the e2e scripts (E2E…/SES…); live orders, other offline sales (e.g. "whatsapp") and migrated licences are always kept. Invoice numbering continues from the highest invoice left.
2. **Production env for `ttd-info`** 🔴 (Vercel → ttd-info → Production). Values come from the local files; set with `vercel env add … production`:

   | Var | Value |
   |---|---|
   | `KEYGEN_API_URL` | `https://licensing.ttd-autofill.com` (sslip.io still accepted as an alias via KEYGEN_HOSTS) |
   | `KEYGEN_ACCOUNT_ID`, `KEYGEN_PRODUCT_ID`, `KEYGEN_PRODUCT_TOKEN` (sensitive), `KEYGEN_POLICY_PRODUCTS` | `~/.ttd-keygen-prod.env` |
   | `KEYGEN_PLAN_POLICIES`, `KEYGEN_GRANT_POLICIES` | pass-* / grant-* policy ids (prod) |
   | `TTD_LEDGER_URL` | `https://nfjpzkkqcfgvopijnxtj.supabase.co` |
   | `TTD_LEDGER_SECRET_KEY` (sensitive) | `~/.ttd-ledger` secret_key |
   | `LEDGER_ENCRYPTION_KEY` (sensitive) | **new** `openssl rand -base64 32`; store in the password manager |
   | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (sensitive), `RAZORPAY_MODE=live`, `RAZORPAY_WEBHOOK_SECRET` (sensitive) | live values |
   | `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` (sensitive), `SES_REGION=ap-south-1`, `SES_CONFIGURATION_SET=ttd-autofill-transactional`, `SES_FROM` | SES sender (`ops/ses/setup.sh` creates a key; one per project) |
   | `RESEND_API_KEY` (sensitive), `RESEND_FROM`, `ALERT_EMAIL` | as on the test app |
   | `BREVO_API_KEY` (sensitive), `BREVO_FROM` | `~/.brevoenv`; `TTD Autofill <keys@ttd-autofill.com>` |
   | `EMAIL_PROVIDERS` | optional; default `ses,resend,brevo` |
   | `INVOICE_SELLER_NAME`, `INVOICE_SELLER_ADDRESS` | optional; defaults are "FireflyAI Softwares", "Proprietor: Roopa Nayanika B, Bangalore 560035, Karnataka, India" |
   | `LICENSING_OUTAGE_ACCESS` | leave unset (on). `false` disables the 72 h outage access |
   | `SUPABASE_ACCESS_TOKEN` (sensitive), `SUPABASE_PROJECT_REFS=nfjpzkkqcfgvopijnxtj,tyiwglnvusbdjvfgbxjm` | optional: lets health-watch restore a paused Supabase project by itself |
   | `CRON_SECRET` (sensitive) | new random |
   | `LICENSING_PROVIDER` | `dodo` (unchanged behaviour) |
   | `PAYMENT_PROVIDER` | `dodo` (unchanged behaviour) |

3. **Deploy the branch to production** 🔴 with both providers still `dodo`. Expected: no customer-visible change; the new crons run (reconcile is a no-op; health-watch starts alerting). Check `/api/config`, a Dodo activation and a refresh.
4. **Full pre-import** (the day before): `export-dodo.mjs` → `export-payments.mjs` → `plan.mjs <snapshot> --payments <payments>` → `import.mjs <plan> ~/.ttd-keygen-prod.env` → `reconcile.mjs` = 0 differences. Customers are still on Dodo (no ledger rows yet).
5. **Live canary** 🔴: temporarily set `PAYMENT_PROVIDER=razorpay` on a **Preview** of the production project, or do it in production during a quiet hour. The owner buys one ₹99 pass for real, then refunds it from the Razorpay dashboard (the licence stays, by design). Verify key, activation and email; then revert to `dodo`.

## Phase 8 — cutover (≈ 20–30 min, off-peak, not a TTD booking day) 🔴

| # | Step | Command / action |
|---|---|---|
| 1 | Stop new Dodo sales | env `PASS_SALES_ENABLED=false` → redeploy |
| 2 | Fence licence changes | env `LICENSING_FENCE=true` → redeploy (activate/deactivate return retryable 503; refresh keeps working) |
| 3 | Wait 10 min for open Dodo checkouts to finish | — |
| 4 | Final export | `export-dodo.mjs` + `export-payments.mjs` (~5 min with concurrency 3) |
| 5 | Final plan | `plan.mjs <new snapshot> --payments <new payments>` |
| 6 | Sync into production Keygen | `import.mjs <new plan> ~/.ttd-keygen-prod.env --sync` |
| 7 | Reconcile | `reconcile.mjs <new plan> ~/.ttd-keygen-prod.env` → **must be 0** (includes `stale_not_suspended`: licences the new plan dropped must be suspended by `--sync`); otherwise stop and roll back (step R1) |
| 8 | Route migrated licences to Keygen (and pin the 12 supporter keys to Dodo) | `apply-ledger-rows.mjs ~/ttd-migration/ledger-rows-licensing.json.age` (`--dry-run` first; output shows `stay_on_dodo: 12`) |
| 9 | Switch providers | env `LICENSING_PROVIDER=keygen`, `PAYMENT_PROVIDER=razorpay`, `PASS_SALES_ENABLED=true`, `LICENSING_FENCE` removed → redeploy |
| 10 | Smoke test | refresh an existing pass (bridge), buy a ₹99 pass, `/ops` lookup, health-watch green |

**Rollback before step 8:** remove `LICENSING_FENCE`, set `PASS_SALES_ENABLED=true` → still Dodo; nothing changed for customers.
**Rollback after step 9:** set `PAYMENT_PROVIDER=dodo` (sales back on Dodo). Keep licences on Keygen: moving them back requires a reverse reconcile, because Keygen may already have accepted activations. If Keygen or the ledger is down, already-activated browsers keep working for up to 72 h (outage access, 2 h tokens); new activations wait.

## Phase 9 — observe and retire (30 days+)

- Watch health-watch alerts, `alert_paid_unfulfilled`, `legacy_bridge_incomplete` (fix via `/ops` reset) and Razorpay settlements against ledger orders.
- Supporter subscriptions (12) stay on Dodo until they end; keep the Dodo key and Dodo code paths for them and for late refund or dispute events.
- After 30 days with no Dodo-served licence activity except supporters: stop the rehearsal Keygen (`docker compose --profile rehearsal down` plus drop DB `keygen_rehearsal`), and delete the test app `ttd-info-keygen`.
- Only when the last supporter subscription ends: remove the Dodo checkout code and `DODO_*` env.

## Supabase free-plan pause

Both projects are on the free plan, which pauses a project after 7 idle days:
`ttd-ledger` (`nfjpzkkqcfgvopijnxtj`: orders, invoices, routing) and `keygen` (`tyiwglnvusbdjvfgbxjm`: database `keygen_prod`, the production Keygen data; its `postgres` database is the old Oracle spike — never delete the project).

- **Prevention, three independent layers:** health-watch on Vercel queries both every 5 min; the VPS timer `db-keepalive.timer` queries both every 6 h; the nightly backup dumps both.
- **Detection:** health-watch alerts within 5 min (`ledger database unreachable` / `keygen db`).
- **While paused:** activated browsers keep working (outage access, up to 72 h); new sales and activations fail with a retryable message; Razorpay retries webhooks for 24 h, so payments made just before are fulfilled after the restore.
- **Recovery:** Supabase Dashboard → project → Restore (a few minutes). With `SUPABASE_ACCESS_TOKEN` set, health-watch requests the restore itself and says so in the alert.
- **Permanent fix if it ever happens:** Supabase Pro ($25/month per organisation) never pauses.
