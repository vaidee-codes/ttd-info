-- Razorpay payments ledger. Backend secret key only; RLS on with no policies.

create table if not exists public.orders (
  id                   uuid primary key default gen_random_uuid(),
  request_id           uuid not null unique,               -- client idempotency key
  plan                 text not null,
  amount_paise         integer not null check (amount_paise > 0),
  currency             text not null default 'INR',
  email                text not null,
  activate             boolean not null default false,
  extension_id         text,
  razorpay_order_id    text unique,
  razorpay_payment_id  text,
  purchase_token_hash  text,                                -- sha256 of the browser's retrieval token
  status               text not null default 'created'
                       check (status in ('created', 'paid', 'fulfilled')),
  paid_at              timestamptz,
  fulfilled_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists orders_status_created_idx on public.orders (status, created_at);

-- One row per verified Razorpay webhook delivery (deduplicated on the event id).
create table if not exists public.payment_events (
  event_id             text primary key,
  event                text not null,
  razorpay_order_id    text,
  razorpay_payment_id  text,
  payload              jsonb not null,
  received_at          timestamptz not null default now()
);

-- Exactly one licence per paid order. The key is generated and stored (encrypted)
-- before Keygen is called, so any retry re-uses the same key.
create table if not exists public.fulfilments (
  order_id             uuid primary key references public.orders (id),
  license_key_enc      text not null,
  keygen_license_id    uuid unique,
  status               text not null default 'pending' check (status in ('pending', 'provisioned')),
  created_at           timestamptz not null default now(),
  provisioned_at       timestamptz
);

create table if not exists public.email_outbox (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null,
  order_id             uuid references public.orders (id),
  to_email             text not null,
  status               text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts             integer not null default 0,
  last_error           text,
  created_at           timestamptz not null default now(),
  sent_at              timestamptz,
  unique (kind, order_id)
);

alter table public.orders enable row level security;
alter table public.payment_events enable row level security;
alter table public.fulfilments enable row level security;
alter table public.email_outbox enable row level security;
