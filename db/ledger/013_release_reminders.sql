-- Opt-in reminder emails the day before a TTD quota release.
-- The buyer ticks a box at checkout (orders.reminder_opt_in); once the order is
-- fulfilled the address joins reminder_subscribers. The operator enters each
-- release on /ops; a cron job queues one email per subscriber whose pass will
-- have run out by then, through the existing email outbox.

alter table public.orders add column if not exists reminder_opt_in boolean not null default false;

create table if not exists public.reminder_subscribers (
  email            text primary key,                  -- lower-cased
  opted_in_at      timestamptz not null default now(),
  unsubscribed_at  timestamptz,
  covered_until    timestamptz,                       -- latest fulfilled pass, estimated from the order (fulfilled_at + plan days)
  last_order_id    uuid references public.orders (id)
);

create table if not exists public.quota_releases (
  id                    uuid primary key default gen_random_uuid(),
  release_at            timestamptz not null,
  title                 text not null check (char_length(title) between 3 and 120),
  created_by            text not null,               -- Keygen admin user id
  created_at            timestamptz not null default now(),
  cancelled_at          timestamptz,
  reminders_queued_at   timestamptz,
  reminders_queued      integer
);
create index if not exists quota_releases_due_idx on public.quota_releases (release_at) where cancelled_at is null and reminders_queued_at is null;

alter table public.email_outbox add column if not exists release_id uuid references public.quota_releases (id);
create unique index if not exists email_outbox_release_to_idx on public.email_outbox (release_id, to_email) where release_id is not null;

alter table public.reminder_subscribers enable row level security;
alter table public.quota_releases enable row level security;

-- Called once a paid order is fulfilled. A ticked box (re)subscribes the
-- address; any purchase by a subscriber pushes covered_until forward.
create or replace function public.note_reminder_purchase(p_email text, p_opt_in boolean, p_covered_until timestamptz, p_order_id uuid) returns void
language sql as $$
  insert into public.reminder_subscribers as s (email, covered_until, last_order_id)
  select lower(p_email), p_covered_until, p_order_id where p_opt_in
  on conflict (email) do update
     set unsubscribed_at = null,
         opted_in_at = case when s.unsubscribed_at is null then s.opted_in_at else now() end,
         covered_until = greatest(s.covered_until, excluded.covered_until),
         last_order_id = excluded.last_order_id;
  update public.reminder_subscribers
     set covered_until = greatest(covered_until, p_covered_until), last_order_id = p_order_id
   where not p_opt_in and email = lower(p_email);
$$;

-- Queues one reminder per subscriber not covered through the release, once.
-- Returns how many were queued (null if the release was already handled).
create or replace function public.queue_release_reminders(p_release_id uuid) returns integer
language plpgsql as $$
declare
  r public.quota_releases;
  n integer;
begin
  update public.quota_releases set reminders_queued_at = now()
   where id = p_release_id and cancelled_at is null and reminders_queued_at is null
   returning * into r;
  if not found then return null; end if;
  insert into public.email_outbox (kind, release_id, to_email)
  select 'release_reminder', r.id, s.email
    from public.reminder_subscribers s
   where s.unsubscribed_at is null and (s.covered_until is null or s.covered_until < r.release_at)
  on conflict (release_id, to_email) where release_id is not null do nothing;
  get diagnostics n = row_count;
  update public.quota_releases set reminders_queued = n where id = r.id;
  return n;
end $$;

revoke all on function public.note_reminder_purchase(text, boolean, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.queue_release_reminders(uuid) from public, anon, authenticated;
grant execute on function public.note_reminder_purchase(text, boolean, timestamptz, uuid) to service_role;
grant execute on function public.queue_release_reminders(uuid) to service_role;
