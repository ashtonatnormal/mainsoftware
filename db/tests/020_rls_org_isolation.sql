-- ACC-11, CLAUDE.md Database: acting in one org, hearth_app sees exactly that org's rows of every
-- table it can read (none of the other org's), and can't write, change or delete the other org's.
-- The fixture has a row of every table in both orgs, so a table missing from it fails here.
\ir fixtures/two_orgs.sql

do $$
declare
  t record;
  o text;
  key text;
  own bigint;
  seen bigint;
  other bigint;
begin
  foreach o in array array['1', '2'] loop
    for t in
      select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
      where s.nspname = 'public' and c.relkind in ('r', 'p') and has_table_privilege('hearth_app', c.oid, 'SELECT')
    loop
      key := case t.relname when 'orgs' then 'id' else 'org_id' end;
      execute format('select count(*) from public.%I where %I = $1', t.relname, key) into own using pg_temp.id(o, '00');
      perform pg_temp.check(own > 0, format('%s: the fixture has no row in org %s; add one to db/tests/fixtures/two_orgs.sql', t.relname, o));
      perform pg_temp.act_as(o, 'a1');
      execute format('select count(*), count(*) filter (where %I <> $1) from public.%I', key, t.relname)
        into seen, other using pg_temp.id(o, '00');
      perform set_config('role', 'none', true);
      perform pg_temp.check(other = 0, format('%s: acting in org %s, hearth_app saw %s row(s) of another org', t.relname, o, other));
      perform pg_temp.check(seen = own, format('%s: acting in org %s, hearth_app saw %s of its %s row(s)', t.relname, o, seen, own));
    end loop;
  end loop;
end
$$;

-- Acting in org 2, nothing of org 1's can be added, changed or removed.
select pg_temp.act_as('2', 'a1');
select pg_temp.expect_error($$insert into public.teams (org_id, name, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'Planted', 'f1000000-0000-4000-8000-0000000000a1')$$, '42501');
select pg_temp.expect_error($$insert into public.principals (org_id, kind)
  values ('f1000000-0000-4000-8000-000000000000', 'human')$$, '42501');
select pg_temp.expect_error($$insert into public.audit_events (org_id, action)
  values ('f1000000-0000-4000-8000-000000000000', 'test.planted')$$, '42501');
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id)
  values ('f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a8')$$, '42501');
select pg_temp.expect_rows($$update public.teams set name = 'Renamed' where id = 'f1000000-0000-4000-8000-0000000000d1'$$, 0);
select pg_temp.expect_rows($$update public.people set full_name = 'Renamed' where org_id = 'f1000000-0000-4000-8000-000000000000'$$, 0);
select pg_temp.expect_rows($$update public.sessions set revoked_at = now(), revoked_by = 'f2000000-0000-4000-8000-0000000000a1', revoke_reason = 'sign_out'
  where org_id = 'f1000000-0000-4000-8000-000000000000'$$, 0);
select pg_temp.expect_rows($$delete from public.working_hours where org_id = 'f1000000-0000-4000-8000-000000000000'$$, 0);

-- A row can't point at another org's row, even one hearth_app could name: foreign keys between
-- org-scoped tables include org_id. (As the superuser, so only the foreign key stands in the way.)
reset role;
select pg_temp.expect_error($$insert into public.team_memberships (org_id, team_id, person_id, created_by)
  values ('f2000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000d1', 'f2000000-0000-4000-8000-0000000000a8', 'f2000000-0000-4000-8000-0000000000a1')$$, '23503');
select pg_temp.expect_error($$update public.people set manager_id = 'f1000000-0000-4000-8000-0000000000a1'
  where id = 'f2000000-0000-4000-8000-0000000000a8'$$, '23503');
select pg_temp.expect_error($$insert into public.audit_events (org_id, actor_id, action)
  values ('f2000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a1', 'test.cross_org')$$, '23503');
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id)
  values ('f2000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f2000000-0000-4000-8000-0000000000a8')$$, '23503');
select pg_temp.expect_error($$insert into public.people (id, org_id, full_name, created_by)
  values ('f1000000-0000-4000-8000-0000000000ab', 'f2000000-0000-4000-8000-000000000000', 'Borrowed id', 'f2000000-0000-4000-8000-0000000000a1')$$, '23503');
