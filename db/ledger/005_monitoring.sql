-- Monitoring: backup heartbeats from the VPS and de-duplicated alert state.

create table if not exists public.backup_runs (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  host         text not null,
  ok           boolean not null,
  databases    integer not null default 0,
  bytes        bigint not null default 0
);
create index if not exists backup_runs_at_idx on public.backup_runs (at desc);

create table if not exists public.alert_state (
  check_name   text primary key,
  failing      boolean not null default false,
  since        timestamptz,
  last_sent_at timestamptz,
  detail       text,
  updated_at   timestamptz not null default now()
);

alter table public.backup_runs enable row level security;
alter table public.alert_state enable row level security;
