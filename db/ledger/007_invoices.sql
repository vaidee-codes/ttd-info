-- Invoices: one per paid order (or offline paid sale), numbered sequentially per Indian
-- financial year (April–March), e.g. TTDA/2026-27/0001.

create table if not exists public.invoice_counters (
  fy    text primary key,
  last  integer not null default 0
);

create table if not exists public.invoices (
  id               uuid primary key default gen_random_uuid(),
  number           text not null unique,
  fy               text not null,
  seq              integer not null,
  order_id         uuid unique references public.orders (id),
  offline_sale_id  uuid unique references public.offline_sales (id),
  issued_at        timestamptz not null default now(),
  buyer_email      text,
  item             text not null,
  amount_paise     integer not null,
  currency         text not null default 'INR',
  payment_ref      text,
  payment_method   text,
  seller           jsonb not null,
  unique (fy, seq)
);

-- Atomic next number for a financial year (called via PostgREST RPC).
create or replace function public.allocate_invoice_seq(p_fy text) returns integer
language sql as $$
  insert into public.invoice_counters (fy, last) values (p_fy, 1)
  on conflict (fy) do update set last = public.invoice_counters.last + 1
  returning last;
$$;
revoke all on function public.allocate_invoice_seq(text) from public, anon, authenticated;
grant execute on function public.allocate_invoice_seq(text) to service_role;

alter table public.invoice_counters enable row level security;
alter table public.invoices enable row level security;

-- Offline sales can opt in to a licence email (with invoice when paid).
alter table public.email_outbox alter column order_id drop not null;
alter table public.email_outbox add column if not exists offline_sale_id uuid references public.offline_sales (id);
create unique index if not exists email_outbox_kind_offline_idx on public.email_outbox (kind, offline_sale_id) where offline_sale_id is not null;
