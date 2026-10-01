-- Defence in depth (Supabase security advisor, 2026-10-01). RLS is already on
-- for every table with no policies, so the Data API roles see nothing; also
-- drop their grants so a future table created without RLS is not exposed.
-- The backend uses the service-role key and is unaffected.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.allocate_invoice_seq(text) to service_role;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
