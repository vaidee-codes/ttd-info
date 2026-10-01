-- Offline sales can cover several browsers with one key.
alter table public.offline_sales add column if not exists activations integer not null default 1
  check (activations between 1 and 1000);
