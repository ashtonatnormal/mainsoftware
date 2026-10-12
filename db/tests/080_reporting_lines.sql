-- ACC-07, ACC-08, CLAUDE.md Database (hierarchy enforced by triggers whose messages the UI can
-- show): reporting lines form a tree. Nobody manages themselves, directly or through others; a
-- new manager must still be at the org. In the fixture, a8 reports to a7, who reports to a1.
\ir fixtures/two_orgs.sql

select pg_temp.act_as('1', 'a2');
select pg_temp.expect_error($$update public.people set manager_id = id where id = 'f1000000-0000-4000-8000-0000000000a8'$$,
  '23514', 'Nobody can be their own manager.');
select pg_temp.expect_error($$update public.people set manager_id = 'f1000000-0000-4000-8000-0000000000a8' where id = 'f1000000-0000-4000-8000-0000000000a7'$$,
  '23514', 'That would make a loop in the reporting lines%');
select pg_temp.expect_error($$update public.people set manager_id = 'f1000000-0000-4000-8000-0000000000a8' where id = 'f1000000-0000-4000-8000-0000000000a1'$$,
  '23514', 'That would make a loop in the reporting lines%');
select pg_temp.expect_error($$update public.people set manager_id = 'f1000000-0000-4000-8000-0000000000a9' where id = 'f1000000-0000-4000-8000-0000000000a8'$$,
  '23514', 'That manager has left the organisation.%');
-- A new person can't start under someone who has left either.
insert into public.principals (id, org_id, kind) values ('f1000000-0000-4000-8000-0000000000ad', 'f1000000-0000-4000-8000-000000000000', 'human');
select pg_temp.expect_error($$insert into public.people (id, org_id, full_name, manager_id, created_by)
  values ('f1000000-0000-4000-8000-0000000000ad', 'f1000000-0000-4000-8000-000000000000', 'New Starter', 'f1000000-0000-4000-8000-0000000000a9', 'f1000000-0000-4000-8000-0000000000a2')$$,
  '23514', 'That manager has left the organisation.%');

-- Moving someone within the tree is fine, and so is clearing a manager.
update public.people set manager_id = 'f1000000-0000-4000-8000-0000000000a1' where id = 'f1000000-0000-4000-8000-0000000000a8';
update public.people set manager_id = 'f1000000-0000-4000-8000-0000000000a8' where id = 'f1000000-0000-4000-8000-0000000000a7';
select pg_temp.expect_error($$update public.people set manager_id = 'f1000000-0000-4000-8000-0000000000a7' where id = 'f1000000-0000-4000-8000-0000000000a8'$$,
  '23514', 'That would make a loop in the reporting lines%');
update public.people set manager_id = null where id = 'f1000000-0000-4000-8000-0000000000a7';
-- Someone whose manager later leaves keeps that line until it's changed.
reset role;
update public.people set deactivated_at = now(), deactivated_by = 'f1000000-0000-4000-8000-0000000000a1'
where id = 'f1000000-0000-4000-8000-0000000000a1';
update public.people set full_name = 'Mel Member renamed' where id = 'f1000000-0000-4000-8000-0000000000a8';

-- The trigger also refuses to change a manager outside READ COMMITTED, where the loop check
-- couldn't see a concurrent commit. That needs its own transaction, which a test here can't
-- start (scripts/test-db.sh runs each in one), so it isn't covered here.
