-- One sender per outbox row. The success page and three Razorpay webhooks all
-- try to deliver the same email within a second; SES (unlike Resend) has no
-- idempotency key, so each attempt was a real email. A sender must first
-- claim the row; a claim expires after 2 minutes so a crashed sender's row is
-- retried.
alter table public.email_outbox add column if not exists claimed_until timestamptz;

create or replace function public.claim_outbox_row(p_id uuid) returns boolean
language sql as $$
  with claimed as (
    update public.email_outbox
       set claimed_until = now() + interval '2 minutes'
     where id = p_id and status = 'queued' and (claimed_until is null or claimed_until < now())
     returning id
  )
  select exists (select 1 from claimed);
$$;
revoke all on function public.claim_outbox_row(uuid) from public, anon, authenticated;
grant execute on function public.claim_outbox_row(uuid) to service_role;
