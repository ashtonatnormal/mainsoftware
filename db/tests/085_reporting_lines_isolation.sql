-- test-db: repeatable read
-- CLAUDE.md Database: tree changes run under READ COMMITTED, where the reporting-line trigger's
-- loop check sees what other transactions committed while it waited for the lock. Under any
-- other level it would read an older snapshot and could let a loop through, so it refuses. The
-- first line asks scripts/test-db.sh to run this test REPEATABLE READ. The fixture sets managers,
-- which this level refuses, so this builds its own two people.
insert into public.orgs (id, name) values ('f3000000-0000-4000-8000-000000000000', 'Test org 3');
insert into public.principals (id, org_id, kind, system_key) values
  ('f3000000-0000-4000-8000-0000000000a0', 'f3000000-0000-4000-8000-000000000000', 'system', 'hearth');
insert into public.principals (id, org_id, kind) values
  ('f3000000-0000-4000-8000-0000000000a1', 'f3000000-0000-4000-8000-000000000000', 'human'),
  ('f3000000-0000-4000-8000-0000000000a2', 'f3000000-0000-4000-8000-000000000000', 'human');
insert into public.people (id, org_id, full_name, created_by) values
  ('f3000000-0000-4000-8000-0000000000a1', 'f3000000-0000-4000-8000-000000000000', 'Ana Lead', 'f3000000-0000-4000-8000-0000000000a0'),
  ('f3000000-0000-4000-8000-0000000000a2', 'f3000000-0000-4000-8000-000000000000', 'Ben Report', 'f3000000-0000-4000-8000-0000000000a0');

select set_config('app.org_id', 'f3000000-0000-4000-8000-000000000000', true),
       set_config('app.user_id', 'f3000000-0000-4000-8000-0000000000a1', true);
set local role hearth_app;
do $$
begin
  if current_setting('transaction_isolation') <> 'repeatable read' then
    raise exception 'scripts/test-db.sh did not run this test REPEATABLE READ';
  end if;
  begin
    update public.people set manager_id = 'f3000000-0000-4000-8000-0000000000a1' where id = 'f3000000-0000-4000-8000-0000000000a2';
    raise exception 'a manager was set under REPEATABLE READ';
  exception when invalid_transaction_state then
    if sqlerrm not like 'Reporting lines change only under READ COMMITTED%' then
      raise;
    end if;
  end;
end
$$;
