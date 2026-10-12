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

-- The loop check walks at most 10,000 managers up, and refuses a longer line rather than pass it
-- unchecked. A line of 10,001 people (n reports to n - 1) is built without the triggers, which
-- would walk it once per person.
set local session_replication_role = replica;
insert into public.principals (id, org_id, kind)
select ('f1000000-0000-4000-9000-' || lpad(to_hex(n), 12, '0'))::uuid, 'f1000000-0000-4000-8000-000000000000', 'human'
from generate_series(1, 10001) as n;
insert into public.people (id, org_id, full_name, manager_id, created_by)
select ('f1000000-0000-4000-9000-' || lpad(to_hex(n), 12, '0'))::uuid, 'f1000000-0000-4000-8000-000000000000', 'In line ' || n,
       case when n > 1 then ('f1000000-0000-4000-9000-' || lpad(to_hex(n - 1), 12, '0'))::uuid end,
       'f1000000-0000-4000-8000-0000000000a2'
from generate_series(1, 10001) as n;
set local session_replication_role = origin;
select pg_temp.act_as('1', 'a2');
-- Under person 10,000: 10,000 managers above, all checked.
update public.people set manager_id = 'f1000000-0000-4000-9000-000000002710' where id = 'f1000000-0000-4000-8000-0000000000a8';
-- Under person 10,001: one too many.
select pg_temp.expect_error($$update public.people set manager_id = 'f1000000-0000-4000-9000-000000002711' where id = 'f1000000-0000-4000-8000-0000000000a8'$$,
  '23514', 'That would put more than 10,000 managers above this person%');
-- A loop right at the limit is still found: person 1, at the top, under a8 (who is under 10,000).
select pg_temp.expect_error($$update public.people set manager_id = 'f1000000-0000-4000-8000-0000000000a8' where id = 'f1000000-0000-4000-9000-000000000001'$$,
  '23514', 'That would make a loop in the reporting lines%');
reset role;

-- 085_reporting_lines_isolation.sql covers the refusal outside READ COMMITTED, and
-- apps/server/scripts/check-concurrency.ts a manager who leaves while someone is moved under them.
