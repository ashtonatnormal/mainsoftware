-- Tembusu Logistics: the fictional org the demo shows (demo/src/data/people.ts), as local and CI
-- data. Never production: scripts/db-local.sh loads it into the local stack's database, refusing
-- any server but a local one, and CI's migrations job into its scratch database. It also checks
-- for itself, below. Production's first Owner comes from the reviewed bootstrap script instead
-- (CLAUDE.md, Database).
--
-- The phone numbers are made up, and the local fake SMS provider sends nothing: it prints each
-- code to the api's terminal, with the number masked (T20). The ids are fixed, so local links and
-- tests can name them: the org ends 0001, principals start b0, departments c0, teams d0 and the
-- notice e0. The demo's agents and assistant arrive with A4 and A5.
--
-- It runs as hearth_owner, which owns the tables and so is not held to row level security, in
-- one transaction on an empty database: run it twice and the second run fails on the first row.

do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'rds_superuser') then
    raise exception 'The Tembusu seed is for the local stack and CI, never an RDS database';
  end if;
  if exists (select 1 from public.orgs) then
    raise exception 'The Tembusu seed loads only into a database with no org yet';
  end if;
end
$$;

insert into public.orgs (id, name) values ('a0000000-0000-4000-8000-000000000001', 'Tembusu Logistics');

-- Hearth itself, which acts for the org (the roster import, the first role grants).
insert into public.principals (id, org_id, kind, system_key) values
  ('b0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000001', 'system', 'hearth');

-- People: one human principal each, with the same id.
insert into public.principals (id, org_id, kind)
select ('b0000000-0000-4000-8000-0000000000' || n)::uuid, 'a0000000-0000-4000-8000-000000000001', 'human'
from unnest(array['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) as n;

insert into public.departments (id, org_id, name, created_by) values
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Management', 'b0000000-0000-4000-8000-000000000000'),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'Operations', 'b0000000-0000-4000-8000-000000000000'),
  ('c0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'Finance', 'b0000000-0000-4000-8000-000000000000'),
  ('c0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'Commercial', 'b0000000-0000-4000-8000-000000000000'),
  ('c0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'Product', 'b0000000-0000-4000-8000-000000000000'),
  ('c0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', 'People & Culture', 'b0000000-0000-4000-8000-000000000000'),
  ('c0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001', 'IT', 'b0000000-0000-4000-8000-000000000000');

-- Managers first, so each manager exists before the people who report to them.
insert into public.people (id, org_id, full_name, department_id, manager_id, created_by)
select p.id::uuid, 'a0000000-0000-4000-8000-000000000001', p.full_name, p.department_id::uuid, p.manager_id::uuid,
       'b0000000-0000-4000-8000-000000000000'
from (values
  (1, 'b0000000-0000-4000-8000-000000000001', 'Ashton Teo', 'c0000000-0000-4000-8000-000000000001', null),
  (2, 'b0000000-0000-4000-8000-000000000002', 'Priya Nair', 'c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001'),
  (3, 'b0000000-0000-4000-8000-000000000003', 'Marcus Ong', 'c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002'),
  (4, 'b0000000-0000-4000-8000-000000000004', 'Farah Iskandar', 'c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000003'),
  (5, 'b0000000-0000-4000-8000-000000000005', 'Tan Wei Ling', 'c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001'),
  (6, 'b0000000-0000-4000-8000-000000000006', 'Ahmad Rahman', 'c0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000001'),
  (7, 'b0000000-0000-4000-8000-000000000007', 'Rachel Goh', 'c0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000006'),
  (8, 'b0000000-0000-4000-8000-000000000008', 'Daniel Lim', 'c0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001'),
  (9, 'b0000000-0000-4000-8000-000000000009', 'Chua Hui Min', 'c0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000001'),
  (10, 'b0000000-0000-4000-8000-000000000010', 'Arjun Menon', 'c0000000-0000-4000-8000-000000000007', 'b0000000-0000-4000-8000-000000000001'),
  (11, 'b0000000-0000-4000-8000-000000000011', 'Kelvin Ng', 'c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002'),
  (12, 'b0000000-0000-4000-8000-000000000012', 'Nadia Yusof', 'c0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000006')
) as p (n, id, full_name, department_id, manager_id)
order by p.n;

insert into public.phone_numbers (org_id, person_id, e164, created_by)
select 'a0000000-0000-4000-8000-000000000001', ('b0000000-0000-4000-8000-0000000000' || n)::uuid, '+65800000' || n,
       'b0000000-0000-4000-8000-000000000000'
from unnest(array['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) as n;

insert into public.profiles (person_id, org_id, display_name, title, time_zone, custom_status) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Ashton', 'Founder · Data Protection Officer', 'Asia/Singapore', null),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'Priya', 'Head of Operations', 'Asia/Singapore', null),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'Marcus', 'Site Supervisor, Woodlands DC', 'Asia/Singapore', 'On the warehouse floor'),
  ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'Farah', 'Warehouse Coordinator', 'Asia/Singapore', null),
  ('b0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'Wei Ling', 'Finance Manager', 'Asia/Singapore', 'Month-end close'),
  ('b0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', 'Ahmad', 'Sales Lead', 'Asia/Kuala_Lumpur', null),
  ('b0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001', 'Rachel', 'Account Manager', 'Asia/Singapore', null),
  ('b0000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000001', 'Daniel', 'Product Designer', 'Asia/Singapore', null),
  ('b0000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001', 'Hui Min', 'People & Culture Lead', 'Asia/Singapore', null),
  ('b0000000-0000-4000-8000-000000000010', 'a0000000-0000-4000-8000-000000000001', 'Arjun', 'IT Lead', 'Asia/Singapore', 'Server migration until 10'),
  ('b0000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000001', 'Kelvin', 'Driver, Fleet', 'Asia/Singapore', null),
  ('b0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000001', 'Nadia', 'Customer Success Associate', 'Asia/Singapore', null);

-- Office hours Monday to Friday for most; Kelvin drives Monday to Saturday, and Marcus runs the
-- night shift, Sunday to Thursday, 22:00 to 07:00.
insert into public.working_hours (org_id, person_id, weekday, starts_at, ends_at)
select 'a0000000-0000-4000-8000-000000000001', ('b0000000-0000-4000-8000-0000000000' || n)::uuid, d, '09:00', '18:00'
from unnest(array['01', '02', '04', '05', '06', '07', '08', '09', '10', '12']) as n, generate_series(1, 5) as d;
insert into public.working_hours (org_id, person_id, weekday, starts_at, ends_at)
select 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000011', d, '07:00', '16:00'
from generate_series(1, 6) as d;
insert into public.working_hours (org_id, person_id, weekday, starts_at, ends_at)
select 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000003', d, '22:00', '07:00'
from unnest(array[7, 1, 2, 3, 4]) as d;

insert into public.teams (id, org_id, name, created_by) values
  ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Leadership', 'b0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'Operations', 'b0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'Finance', 'b0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'Sales', 'b0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'Design', 'b0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', 'People', 'b0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001', 'IT', 'b0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000001', 'Fleet', 'b0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001', 'Customer Success', 'b0000000-0000-4000-8000-000000000001');

-- Each person's team from the demo; the heads of operations, finance and sales are also in
-- Leadership, and Kelvin in Operations as well as Fleet.
insert into public.team_memberships (org_id, team_id, person_id, created_by)
select 'a0000000-0000-4000-8000-000000000001', ('d0000000-0000-4000-8000-0000000000' || t)::uuid,
       ('b0000000-0000-4000-8000-0000000000' || p)::uuid, 'b0000000-0000-4000-8000-000000000001'
from (values
  ('01', '01'), ('01', '02'), ('01', '05'), ('01', '06'),
  ('02', '02'), ('02', '03'), ('02', '04'), ('02', '11'),
  ('03', '05'), ('04', '06'), ('04', '07'), ('05', '08'), ('06', '09'), ('07', '10'),
  ('08', '11'), ('09', '12')
) as m (t, p);

-- Roles (ACC-10). Ashton is the first Owner and the DPO (D35), granted by Hearth as the bootstrap
-- would. Wei Ling's Compliance Officer grant has its second approver (PRD-85).
insert into public.role_assignments (org_id, person_id, role, team_id, created_by, approved_by, approved_at) values
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'owner', null, 'b0000000-0000-4000-8000-000000000000', null, null),
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'dpo', null, 'b0000000-0000-4000-8000-000000000000', null, null),
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000010', 'admin', null, 'b0000000-0000-4000-8000-000000000001', null, null),
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000010', 'ai_admin', null, 'b0000000-0000-4000-8000-000000000001', null, null),
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', 'leadership', null, 'b0000000-0000-4000-8000-000000000001', null, null),
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000005', 'leadership', null, 'b0000000-0000-4000-8000-000000000001', null, null),
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000006', 'leadership', null, 'b0000000-0000-4000-8000-000000000001', null, null),
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000005', 'compliance_officer', null, 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000010', now()),
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000009', 'team_admin', 'd0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000010', null, null),
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000003', 'team_admin', 'd0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000010', null, null);

-- Nobody reads the audit log yet: the roles that may are chosen in the admin console (C0.16), so
-- audit_log_readers starts empty here as it does in production.

-- Accounts for everyone who has signed in: all but Nadia, who joined today.
insert into public.users (id, org_id)
select ('b0000000-0000-4000-8000-0000000000' || n)::uuid, 'a0000000-0000-4000-8000-000000000001'
from unnest(array['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11']) as n;

-- A stand-in for notice v0 (C0.9 generates the real text from the processing register), and the
-- acknowledgments everyone who has signed in gave in the app.
insert into public.notice_versions (id, org_id, version, body, published_by) values
  ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 0,
   'Local stand-in for the privacy and recording notice. C0.9 generates the real one from the processing register.',
   'b0000000-0000-4000-8000-000000000001');
insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method)
select 'a0000000-0000-4000-8000-000000000001', ('b0000000-0000-4000-8000-0000000000' || n)::uuid,
       'e0000000-0000-4000-8000-000000000001', 'in_app'
from unnest(array['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11']) as n;
