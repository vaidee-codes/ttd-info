-- Multi-pass purchases: one key valid on `quantity` browsers, with a volume discount.
alter table public.orders add column if not exists quantity integer not null default 1 check (quantity between 1 and 50);
alter table public.orders add column if not exists discount_pct integer not null default 0 check (discount_pct between 0 and 90);
alter table public.invoices add column if not exists quantity integer not null default 1;
alter table public.invoices add column if not exists discount_pct integer not null default 0;
