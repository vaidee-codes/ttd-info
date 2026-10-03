# Phase 6 — Dodo licence migration rehearsal (30 Sep 2026)

Read-only on Dodo throughout. All snapshots, plans, state and ledger-row files are in `~/ttd-migration/`, age-encrypted to `~/.ttd-backup-age.key`, mode 600, never in the repo. Reports contain counts and HMAC references only.

## Tooling (`scripts/migrate/`)

| Script | Purpose |
|---|---|
| `export-dodo.mjs` | Licence keys, activation instances and customers → encrypted snapshot (concurrency 3, retries on 429/5xx) |
| `export-payments.mjs` | Every payment's id and status, so keys from unpaid payments are never migrated as valid |
| `plan.mjs` | Dry run: snapshot → per-licence plan (policy, expiry, status, limit, machines), plus quarantine and anomalies |
| `import.mjs` | Plan → Keygen. Resumable and checkpointed; looks up by key before creating. `--sync` updates already-imported licences (expiry, limit, suspend/reinstate, removed activations). Writes `ledger-rows-<target>.json.age` (not applied) |
| `reconcile.mjs` | Field-by-field comparison of every imported licence with the plan |
| `verify-adapter.mjs` | Runs the real `/api/license-*` handlers against the imported data with Dodo-era-shaped tokens |
| `apply-ledger-rows.mjs` | Cutover step: upserts `licence_authority` and `instance_alias` (`--dry-run` supported) |
| `cleanup-test-data.mjs` | Pre-launch removal of sandbox data; refuses once migrated data exists |

## Source data (Dodo live, 30 Sep)

3,202 licence keys (750 active, 2,363 expired, 89 disabled); products: 3,107 weekly, 58 30-day, 25 90-day, 12 supporter. 3,001 activation instances on 2,966 keys. 2,754 customers. 3,426 payments (2,998 succeeded).

## Plan

- **Migrate 3,190**; **skip 12** supporter keys (they stay on Dodo, owner decision); **quarantine 0**.
- Policies: pass-7d 3,094 · pass-30d 23 · pass-90d 16 · grant-7d 13 · grant-30d 35 · grant-90d 9 (grants are unused complimentary keys; the clock starts at first activation).
- Activated complimentary keys get an explicit expiry of activation + tier days, as today's `computeEffectiveExpiry` does.
- Live today (active and unexpired): **744**. Of those, 632 have pre-marker activations, 14 have marked activations, 98 are not activated.
- Dodo `expired` → active licence with its past expiry; `disabled` (89) → suspended.
- Every key has a succeeded payment or is a manual/complimentary key; all migrated licences have an email.

## Finding: 2,985 of 3,000 activations have no installation marker

Dodo instance names carry `instref:<HMAC>` only for recent builds. Unmarked activations are imported with a placeholder fingerprint `legacy:<lki id>`. **Installation bridge** (`api/_licensing.mjs`): on the first refresh with a validly signed entitlement bound to that exact Dodo instance, and only if the key is still usable, the adapter raises the licence limit by one, creates the real machine (fingerprint = HMAC of the installation), repoints the alias, deletes the placeholder and restores the limit. It is retry-safe. Without it ~632 live customers would be locked out at cutover. The marked 15 match directly, provided production `TTDAF_LOG_CORRELATION_SECRET` is never rotated.

## Rehearsal results (separate Keygen: `rehearsal.13-205-179-101.sslip.io`, DB `keygen_rehearsal`)

- Import: 3,190 licences, 3,000 machines, 89 suspended, **0 errors**, ~5 min (concurrency 4 on the 1 GB VPS; production Keygen stayed healthy at 0.23 s).
- Reconcile: **3,190 compared, 0 unexplained differences** (key, expiry, suspended, limit, policy, product, Dodo licence id, email, machines).
- `verify-adapter.mjs` on real migrated licences: 7/7:
  - a pre-marker browser refreshes via the bridge and keeps refreshing;
  - a second browser gets `activation_in_use`;
  - an unused complimentary key activates with the clock starting now;
  - a disabled key and an expired key are terminal;
  - an expired key with a used slot says `licence_expired`.
- `--sync` with an unchanged plan: 0 changes, ~2 min. A later reconcile showed 27 differences, all caused by the verification itself (13 bridged machines, 7 grants activated); 0 unexplained.
- Fixes that came out of the rehearsal:
  - the `expired` status mapping;
  - "expired" reported before "in use" on a full slot;
  - the bridge is skipped for expired or disabled licences;
  - the cutover fence `LICENSING_FENCE` (activate/deactivate return 503; refresh unaffected).
- Tests: `test/migration-plan.test.mjs` (8) plus bridge, fence and expired-slot cases in `test/keygen-licensing.test.mjs`. Suite **142/142**.

The rehearsal Keygen container is stopped (data kept). Restart with `docker compose --profile rehearsal up -d rehearsal`.

## Cutover

See `CUTOVER_RUNBOOK.md`. Expected fence (activations paused, autofill unaffected): export ~5 min + sync ~2 min + reconcile ~2 min + switch ≈ 15–20 min.
