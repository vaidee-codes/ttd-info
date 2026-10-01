-- Reliability fixes (review 2026-10-01).
-- Orders: which Razorpay mode took the order (cleanup must never touch live
-- money), round-robin reconcile, and the previous checkout token (a reopened
-- checkout no longer locks the first tab out).
alter table public.orders add column if not exists razorpay_mode text check (razorpay_mode in ('test', 'live'));
alter table public.orders add column if not exists reconcile_checked_at timestamptz;
alter table public.orders add column if not exists purchase_token_hash_prev text;
create index if not exists orders_reconcile_idx on public.orders (status, reconcile_checked_at nulls first);

-- Email outbox: retries keep going for days (provider daily limits reset), so a
-- missed email still goes out the next day. `failed` is only for addresses every
-- provider rejects permanently, or after the retry window.
alter table public.email_outbox add column if not exists next_attempt_at timestamptz not null default now();
alter table public.email_outbox add column if not exists provider text;
create index if not exists email_outbox_due_idx on public.email_outbox (status, next_attempt_at);
