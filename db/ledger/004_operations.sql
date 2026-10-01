-- Operations: offline sales, append-only audit, find-my-key challenges.

create table if not exists public.offline_sales (
  id                  uuid primary key default gen_random_uuid(),
  method              text not null check (method in ('upi', 'bank', 'cash', 'other')),
  reference           text not null,                 -- UTR / receipt number, unique per method
  amount_inr          integer not null check (amount_inr >= 0),
  plan                text not null,
  kind                text not null check (kind in ('paid', 'grant')),
  email               text,
  note                text,
  license_key_enc     text not null,                 -- sealed before Keygen is called (retry-safe)
  keygen_license_id   uuid unique,
  status              text not null default 'pending' check (status in ('pending', 'provisioned')),
  created_by          text not null,                 -- Keygen admin user id
  created_at          timestamptz not null default now(),
  provisioned_at      timestamptz,
  unique (method, reference)
);

create table if not exists public.audit_events (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  actor         text not null,                       -- Keygen admin user id or 'system'
  action        text not null,
  target        text,
  detail        jsonb not null default '{}'::jsonb
);
create index if not exists audit_events_target_idx on public.audit_events (target, at desc);

create or replace function public.audit_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end $$;
drop trigger if exists audit_events_no_change on public.audit_events;
create trigger audit_events_no_change before update or delete on public.audit_events
  for each row execute function public.audit_events_append_only();

create table if not exists public.find_key_challenges (
  id            uuid primary key default gen_random_uuid(),
  email_hash    text not null,
  code_hash     text not null,
  attempts      integer not null default 0,
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists find_key_challenges_email_idx on public.find_key_challenges (email_hash, created_at desc);

alter table public.offline_sales enable row level security;
alter table public.audit_events enable row level security;
alter table public.find_key_challenges enable row level security;
