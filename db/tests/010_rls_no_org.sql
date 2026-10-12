-- ACC-11, CLAUDE.md Database: a transaction with no org set (or an empty one) sees no row of any
-- table hearth_app can read, and can't write one. Every table is covered without listing them, so
-- a new table is checked the day it lands.
\ir fixtures/two_orgs.sql

do $$
declare
  t record;
  setting text;
  seen bigint;
begin
  -- First with app.org_id never set in this session, then set to ''.
  foreach setting in array array['unset', ''] loop
    if setting <> 'unset' then
      perform set_config('app.org_id', setting, true);
    end if;
    for t in
      select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
      where s.nspname = 'public' and c.relkind in ('r', 'p') and has_table_privilege('hearth_app', c.oid, 'SELECT')
    loop
      perform set_config('role', 'hearth_app', true);
      execute format('select count(*) from public.%I', t.relname) into seen;
      perform set_config('role', 'none', true);
      perform pg_temp.check(seen = 0, format('%s: hearth_app saw %s row(s) with app.org_id %s', t.relname, seen, setting));
    end loop;
  end loop;
end
$$;

-- Writes with no org set are refused, and updates and deletes find nothing.
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a1')::text, true);
set local role hearth_app;
select pg_temp.expect_error($$insert into public.teams (org_id, name, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'No org', 'f1000000-0000-4000-8000-0000000000a1')$$, '42501');
select pg_temp.expect_error($$insert into public.audit_events (org_id, action)
  values ('f1000000-0000-4000-8000-000000000000', 'test.no_org')$$, '42501');
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id)
  values ('f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a8')$$, '42501');
select pg_temp.expect_rows($$update public.teams set name = 'Renamed' where id = 'f1000000-0000-4000-8000-0000000000d1'$$, 0);
select pg_temp.expect_rows($$delete from public.working_hours$$, 0);
