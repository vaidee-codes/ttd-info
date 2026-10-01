# Phase 3 — Razorpay payments

Branch `spike/razorpay-keygen-phase1`. Switched on only by `PAYMENT_PROVIDER=razorpay`; otherwise the Dodo checkout is untouched.

## Flow

1. `/pass`: `/api/config` → `payment_provider: 'razorpay'`, so the page shows an email field.
2. `POST /api/checkout {plan, request_id, email, activate, extension_id}` → ledger `orders` row (idempotent on `request_id`) → Razorpay Order (server price, INR, `receipt` = our order id, `partial_payment: false`) → `{key_id, razorpay_order_id, amount, purchase_token}`. Only `sha256(purchase_token)` is stored.
3. Razorpay Checkout modal (email prefilled and read-only). Phone collection stays on until Razorpay enables optional contact.
4. `POST /api/payment-confirm {razorpay_order_id, razorpay_payment_id, razorpay_signature, purchase_token}`:
   - verifies the HMAC signature and the purchase token;
   - **re-fetches the payment from Razorpay** and requires `captured` (captures an `authorized` one), the same order, the exact amount and INR;
   - calls `fulfilOrder`, then returns the key.
   - Returns 202 while pending; the page retries for up to ~60 s, then shows the key on `/pass/success` (handed over via sessionStorage, never the URL).
5. `POST /api/razorpay-webhook`:
   - checks the signature over the raw body;
   - stores the event (deduplicated on `x-razorpay-event-id`);
   - `payment.captured`, `order.paid` and `payment.authorized` trigger the same `settleOrder`;
   - refunds and disputes are recorded only;
   - returns 5xx on storage or fulfilment failure so Razorpay retries.
6. Cron `*/5 /api/payments-reconcile` (CRON_SECRET): orders in `created` or `paid` that are 2 min to 48 h old are checked against Razorpay and fulfilled; a stuck paid order logs `alert_paid_unfulfilled`.

## Exactly one licence per order

`fulfilments` has primary key `order_id`. The licence key (`TTD-XXXXX-XXXXX-XXXXX-XXXXX`, 100 bits) is generated and stored **AES-256-GCM-encrypted** (`LEDGER_ENCRYPTION_KEY`) before Keygen is called. Every retry re-uses that key, and a Keygen 422 on a duplicate key resolves to the existing licence. The licence carries metadata `{source: 'razorpay', orderId, plan, email, publicProductId}`; a `licence_authority` row routes it to Keygen, and an `email_outbox` row is queued (sender not built yet).

## Guards

- A live key (`rzp_live_`) works only with `RAZORPAY_MODE=live`, and a test key only without it.
- Refunds and disputes never change licences (owner decision).
- Duplicate captures on one order are logged (`payment_duplicate_capture`) for a manual refund.

## Tests

`test/razorpay-payments.test.mjs` (15 cases, stateful fake of the ledger, Razorpay and Keygen): server price; idempotent checkout; conflict; bad email; one licence even on repeat; forged signature and wrong token; wrong amount and currency; authorized → capture; closed-tab webhook plus redelivery; bad webhook signature; refund recorded only; Keygen outage → reconcile completes with the same key; lost Keygen response → no duplicate; cron auth; live-key guard; config flag. Full suite **109/109**. Verified live: the Keygen product token can create and delete licences.

## Env (test app `ttd-info-keygen`)

Set: `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_MODE=test`, `PASS_SALES_ENABLED=true`, `LEDGER_ENCRYPTION_KEY`, `KEYGEN_PLAN_POLICIES` (7d/30d/90d → `pass-*` policy ids), `CRON_SECRET`. **Missing:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (test mode), `RAZORPAY_WEBHOOK_SECRET`.

Test purchases write to the production ledger and production Keygen (tagged `source: razorpay`). Clear them before go-live.

## Email (Resend only, owner decision)

`api/_email.mjs`: after fulfilment, `settleOrder` sends the licence email immediately (best effort); the reconcile cron drains any still-queued rows. Idempotency key `licence_key/<order_id>`. Retries on 429/5xx up to 8 attempts; other 4xx → `failed`. Signed "Crimson / TTD Autofill", reply-to ttdautofill@gmail.com. Env: `RESEND_API_KEY` (send-only key), `RESEND_FROM`. Tests: sent once, outage retried by cron, rejected address not retried, unconfigured → waits. Suite **112/112**.

## 30 Sep — sandbox run (Razorpay test mode, owner paid in the browser)

- Fixes needed first: allow the project's own production origin (`VERCEL_PROJECT_PRODUCTION_URL`) in `allowedOrigins`, and add `https://cdn.razorpay.com` to `script-src`.
- 7-day purchase: webhooks `payment.authorized`, `payment.captured` and `order.paid` all verified and stored. Order `created → paid → fulfilled` in 4 s; one Keygen licence (`source: razorpay`); `licence_authority` row → keygen; the success page showed `TTD-…`.
- The key through the test app API: activate (product `pdt_0Nk4…`, expiry exactly purchase + 7 days) → refresh 200 → validate valid → deactivate ok.
- Email: sent for the order whose address is the Resend account's own; **403 validation_error** for the other address. As expected, **Resend needs a verified sending domain before it can email customers**; `onboarding@resend.dev` only reaches the account owner.

## Still open

- A domain for Resend (and later for Keygen instead of sslip.io).
- Razorpay optional-contact (support ticket) → set `hidden.contact` once enabled.
- Remove test orders and licences (`source: razorpay`, test mode) from the ledger and Keygen before go-live.
- Live keys: production env `RAZORPAY_MODE=live` plus a live webhook on the production URL at cutover.

## 30 Sep — email collected by Razorpay (owner decision)

- The pass page no longer asks for an email. Razorpay Checkout collects it (mandatory by default), and `settleOrder` copies `payment.email` (domain lowercased) into `orders.email` when it marks the order paid. That email goes into the licence metadata and the outbox. A payment without an email still issues the licence, with no email queued.
- `003_email_from_razorpay.sql`: `orders.email` is nullable. The circular import was removed (`normaliseEmail` now lives in `_payments.mjs`).
- Suite 112/112; the test app is redeployed (checkout without email OK; the page has no email field).
- Resend licence emails reach customers only once a domain is verified (owner will buy one later).
