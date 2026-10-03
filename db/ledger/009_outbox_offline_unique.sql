-- PostgREST's on_conflict cannot target a partial unique index, so the offline-sale
-- outbox insert (on_conflict=kind,offline_sale_id) failed. Use a plain unique
-- constraint instead; NULLs stay distinct, so order rows (offline_sale_id null) are unaffected.
drop index if exists public.email_outbox_kind_offline_idx;
alter table public.email_outbox drop constraint if exists email_outbox_kind_offline_sale_id_key;
alter table public.email_outbox add constraint email_outbox_kind_offline_sale_id_key unique (kind, offline_sale_id);
