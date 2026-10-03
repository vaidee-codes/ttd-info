-- TTD ledger (Supabase project `ttd-ledger`): licence authority and public-ID aliases.
-- Only the backend's secret key reaches these tables; RLS is on with no policies,
-- so the anon/publishable key can read nothing.

create table if not exists public.licence_authority (
  key_hash            text primary key,            -- sha256 hex of the exact licence key
  authority           text not null check (authority in ('dodo', 'keygen')),
  public_license_id   text unique,                 -- ID the extension holds (Dodo lic_* for migrated keys)
  keygen_license_id   uuid unique,                 -- set once the licence lives in Keygen
  source              text not null default 'dodo-migrated',
  migrated_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.instance_alias (
  public_instance_id  text primary key,            -- Dodo lki_* the extension holds
  public_license_id   text not null references public.licence_authority (public_license_id),
  keygen_machine_id   uuid unique,
  tombstoned_at       timestamptz,                 -- set when the machine is deactivated; blocks replay
  created_at          timestamptz not null default now()
);

create index if not exists instance_alias_license_idx on public.instance_alias (public_license_id);

alter table public.licence_authority enable row level security;
alter table public.instance_alias enable row level security;
