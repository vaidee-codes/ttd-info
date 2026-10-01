-- Applied 2026-10-01 to the keygen Supabase project, database "postgres" (the old
-- Oracle spike Keygen; the Data API serves this database). Not for keygen_prod.
-- Lock the Supabase Data API out of the public schema: RLS on every table (no
-- policies, so the anon/authenticated API roles see nothing) and no grants.
-- Non-destructive: no data is changed; the postgres/service roles are unaffected.
begin;
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    execute format('alter table public.%I enable row level security', r.relname);
  end loop;
end $$;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
commit;
