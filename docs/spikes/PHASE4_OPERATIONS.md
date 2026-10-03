# Phase 4 — operations

Branch `spike/razorpay-keygen-phase1`. The ledger schema is in `db/ledger/004_operations.sql` (applied): `offline_sales` (unique `method + reference`), `audit_events` (append-only, enforced by a trigger; verified), `find_key_challenges`.

## Admin: `/ops` (noindex, no-store)

- **Sign-in:** `POST /api/ops/login` passes the email and password to Keygen `POST /tokens` (8 h token) and accepts only `role: admin` (checked via Keygen `/me`). The password is never stored or logged. The login is rate-limited per email via the `pass-license-key` firewall rule. The token lives in sessionStorage.
- **Every ops call** sends `Authorization: Bearer <Keygen admin token>`; `requireOperator` re-checks it with Keygen `/me`. The actor recorded in `audit_events` is the Keygen admin user id.
- **Lookup:** `POST /api/ops/lookup {query}` accepts an email (licence `metadata.email`), a licence key (validate-key), or a licence/order id. Each result lists its activations (machines).
- **Reset:** `POST /api/ops/reset-activations {license_id, machine_id?, reason}` removes one activation or all of them, tombstones any migrated `instance_alias`, and writes an audit row with the reason. The old browser locks within 8 h (the current entitlement lifetime).
- **Offline sale / grant:** `POST /api/ops/offline-sale {plan, kind, method, reference, amount_inr, email?, note?}`:
  - `paid` uses the `pass-*` policy (clock starts at creation); `grant` uses the `grant-*` policy (clock starts at first activation; env `KEYGEN_GRANT_POLICIES`).
  - The key is sealed in the ledger before Keygen is called, so a retry returns the same key.
  - A reused reference for a different sale → 409 `duplicate_reference`.
  - Licence metadata: `source` (offline or grant), method, reference, amountInr, plan, email, note, offlineSaleId, publicProductId.
  - Writes an audit row.

## Customer: `/pass/find-key`

`POST /api/find-key {email}` returns the same message whether or not the email has purchases. When it does (fulfilled orders or provisioned offline sales), it emails a 6-digit code (valid 10 min, max 3 codes/hour). `{email, code}` accepts at most 5 wrong guesses, consumes the code on success, and returns every key for that email, decrypted from the ledger. Rate-limited per email. **Customer emails need a verified Resend domain** (see Phase 3).

## Tests

- `test/operations.test.mjs` (10): admin-only access (no token, bad token, non-admin, wrong password); offline sale fields and audit actor; idempotent retry plus duplicate UTR; grant policy, free grant vs paid ≥ ₹1, bad method; reset all with tombstone and audit; deactivate one; lookup by email, key or id; find-key code flow, replay refused, unknown email → same answer and no email, guess limit, expiry.
- Full suite **122/122**.
- Live (`ops/keygen/ops-e2e.mjs` against the test app, production Keygen and ledger): **11/11**. Audit rows `offline_sale_created`, `grant_created` and `reset_activations` were recorded with the admin id and reason.

## Also fixed

- `.vercelignore` now excludes `ops/vps/` and `ops/*.json`. **Production `ttd-info.vercel.app/ops/dodo-inventory-2026-08-10.json` is publicly served today** (a sanitized summary with no emails or keys); this branch stops that on merge.

## Not done

- Keygen Portal is not redeployed. `/ops` covers the daily tasks (find, deactivate, offline sale, grant). Portal is still available for rarer edits (limits, expiry, suspend), and can be redeployed as a static site for `13-205-179-101.sslip.io`.

## 30 Sep — several browsers per offline key (owner request)

- Offline sale / grant form: **Browsers allowed (activations)**, 1–1000, default 1 → Keygen per-licence `maxMachines` override; stored in `offline_sales.activations` (`006_offline_activations.sql`); part of the duplicate-reference check.
- `POST /api/ops/set-activation-limit {license_id, activations, reason}` and a "Change browser limit" button on each lookup result: raises or lowers the limit of any licence; refuses to go below the number of browsers already activated (409 `limit_below_use`); audited with from/to/reason.
- Online (Razorpay) purchases stay at 1 browser; a quantity option on the pass page is a later change.
- Tests: 2 new (suite 145/145). Live `ops-e2e.mjs` 17/17: a 3-browser key activates on 3 browsers, the 4th is refused, the limit cannot drop below use, raising to 4 lets the 4th in.
