-- Two optional questions on the pass success page, answered after payment:
-- "Which other temple do you struggle to book?" and "How did you hear about us?".
-- One row per paid order; answering again replaces the earlier answer.

create table if not exists public.purchase_feedback (
  order_id           uuid primary key references public.orders (id),
  other_temple       text check (char_length(other_temple) <= 300),
  heard_from         text check (heard_from in ('chrome_web_store', 'youtube', 'whatsapp', 'telegram', 'instagram', 'facebook', 'google', 'friend', 'other')),
  heard_from_detail  text check (char_length(heard_from_detail) <= 200),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (other_temple is not null or heard_from is not null)
);

alter table public.purchase_feedback enable row level security;
revoke all on public.purchase_feedback from anon, authenticated;
