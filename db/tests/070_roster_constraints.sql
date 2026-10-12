-- ACC-03, ACC-04, ACC-05, ACC-06, ACC-07, ACC-08, ACC-10, ACC-12, PDPA-03, PDPA-09, T5: the
-- roster's own rules, which hold for every writer (these run as the owner unless they act as
-- someone).
\ir fixtures/two_orgs.sql

-- Phone numbers (ACC-03, ACC-06): E.164; one current number per person; a current number belongs
-- to one person; a removed number can be given out again.
select pg_temp.expect_error($$insert into public.phone_numbers (org_id, person_id, e164, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a9', '91234567', 'f1000000-0000-4000-8000-0000000000a1')$$,
  '23514', '%phone_numbers_e164%');
select pg_temp.expect_error($$insert into public.phone_numbers (org_id, person_id, e164, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a9', '+65 9123 4567', 'f1000000-0000-4000-8000-0000000000a1')$$,
  '23514', '%phone_numbers_e164%');
select pg_temp.expect_error($$insert into public.phone_numbers (org_id, person_id, e164, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', '+6591234567', 'f1000000-0000-4000-8000-0000000000a1')$$,
  '23505', '%phone_numbers_current_person%');
-- a9's number is removed, so a9 has none; a1's current number still can't be a9's.
update public.phone_numbers set removed_at = now(), removed_by = 'f1000000-0000-4000-8000-0000000000a1'
where org_id = 'f1000000-0000-4000-8000-000000000000' and e164 = '+6510000009';
select pg_temp.expect_error($$insert into public.phone_numbers (org_id, person_id, e164, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a9', '+6510000001', 'f1000000-0000-4000-8000-0000000000a1')$$,
  '23505', '%phone_numbers_current_number%');
-- The removed number goes to someone else.
update public.phone_numbers set removed_at = now(), removed_by = 'f1000000-0000-4000-8000-0000000000a1'
where org_id = 'f1000000-0000-4000-8000-000000000000' and person_id = 'f1000000-0000-4000-8000-0000000000aa';
insert into public.phone_numbers (org_id, person_id, e164, created_by)
values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000aa', '+6510000009', 'f1000000-0000-4000-8000-0000000000a1');
-- The same number in another org is that org's business.
insert into public.phone_numbers (org_id, person_id, e164, created_by, removed_at, removed_by)
values ('f2000000-0000-4000-8000-000000000000', 'f2000000-0000-4000-8000-0000000000a9', '+6510000001', 'f2000000-0000-4000-8000-0000000000a1',
        now(), 'f2000000-0000-4000-8000-0000000000a1');

-- Names are trimmed and not empty; team and department names are unique in the org (ignoring
-- case) among those not archived.
select pg_temp.expect_error($$update public.people set full_name = ' Mel ' where id = 'f1000000-0000-4000-8000-0000000000a8'$$, '23514');
select pg_temp.expect_error($$update public.people set full_name = '' where id = 'f1000000-0000-4000-8000-0000000000a8'$$, '23514');
select pg_temp.expect_error($$insert into public.teams (org_id, name, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'CREW', 'f1000000-0000-4000-8000-0000000000a1')$$, '23505');
insert into public.teams (org_id, name, created_by)
values ('f1000000-0000-4000-8000-000000000000', 'Old Crew', 'f1000000-0000-4000-8000-0000000000a1');
select pg_temp.expect_error($$insert into public.departments (org_id, name, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'operations', 'f1000000-0000-4000-8000-0000000000a1')$$, '23505');

-- Every end records who and when together (*_at with *_by).
select pg_temp.expect_error($$update public.departments set archived_at = now() where id = 'f1000000-0000-4000-8000-0000000000c1'$$, '23514');
select pg_temp.expect_error($$update public.teams set archived_at = now() where id = 'f1000000-0000-4000-8000-0000000000d1'$$, '23514');
select pg_temp.expect_error($$update public.people set deactivated_at = now() where id = 'f1000000-0000-4000-8000-0000000000a6'$$, '23514');
select pg_temp.expect_error($$update public.phone_numbers set removed_at = now()
  where org_id = 'f1000000-0000-4000-8000-000000000000' and e164 = '+6510000008'$$, '23514');
select pg_temp.expect_error($$update public.team_memberships set removed_at = now()
  where org_id = 'f1000000-0000-4000-8000-000000000000' and person_id = 'f1000000-0000-4000-8000-0000000000a8'$$, '23514');
select pg_temp.expect_error($$update public.devices set signed_out_at = now() where id = 'f1000000-0000-4000-8000-0000000000e1'$$, '23514');
select pg_temp.expect_error($$update public.role_assignments set revoked_at = now()
  where org_id = 'f1000000-0000-4000-8000-000000000000' and role = 'ai_admin'$$, '23514');

-- And once recorded, an end stays as it was: nobody who has left comes back by an edit (so a DPO
-- who left can't read the audit log again), and nothing removed, revoked or signed out is undone
-- or re-attributed. This holds for hearth_app, which writes these columns.
select pg_temp.act_as('1', 'a2');
select pg_temp.expect_error($$update public.people set deactivated_at = null, deactivated_by = null where id = 'f1000000-0000-4000-8000-0000000000a9'$$,
  '23514', 'That has already ended%');
select pg_temp.expect_error($$update public.people set deactivated_by = 'f1000000-0000-4000-8000-0000000000a2' where id = 'f1000000-0000-4000-8000-0000000000a9'$$,
  '23514', 'That has already ended%');
select pg_temp.expect_error($$update public.phone_numbers set removed_at = null, removed_by = null where removed_at is not null$$,
  '23514', 'That has already ended%');
select pg_temp.expect_error($$update public.teams set archived_at = null, archived_by = null where id = 'f1000000-0000-4000-8000-0000000000d2'$$,
  '23514', 'That has already ended%');
-- Sign a device and its session out, then try to undo it.
update public.sessions set revoked_at = now(), revoked_by = 'f1000000-0000-4000-8000-0000000000a2', revoke_reason = 'device_sign_out'
where id = 'f1000000-0000-4000-8000-0000000000e2';
update public.devices set signed_out_at = now(), signed_out_by = 'f1000000-0000-4000-8000-0000000000a2'
where id = 'f1000000-0000-4000-8000-0000000000e1';
select pg_temp.expect_error($$update public.sessions set revoked_at = null, revoked_by = null, revoke_reason = null where id = 'f1000000-0000-4000-8000-0000000000e2'$$,
  '23514', 'That has already ended%');
select pg_temp.expect_error($$update public.sessions set revoke_reason = 'sign_out' where id = 'f1000000-0000-4000-8000-0000000000e2'$$,
  '23514', 'That has already ended%');
select pg_temp.expect_error($$update public.devices set signed_out_at = null, signed_out_by = null where id = 'f1000000-0000-4000-8000-0000000000e1'$$,
  '23514', 'That has already ended%');
-- Things not yet ended can end, and other columns stay editable.
update public.team_memberships set removed_at = now(), removed_by = 'f1000000-0000-4000-8000-0000000000a2'
where org_id = 'f1000000-0000-4000-8000-000000000000' and person_id = 'f1000000-0000-4000-8000-0000000000a7';
select pg_temp.expect_error($$update public.team_memberships set removed_at = null, removed_by = null
  where org_id = 'f1000000-0000-4000-8000-000000000000' and person_id = 'f1000000-0000-4000-8000-0000000000a7'$$, '23514', 'That has already ended%');
update public.teams set name = 'Old crew, renamed' where id = 'f1000000-0000-4000-8000-0000000000d2';
reset role;
-- The owner too (a role revoked is revoked; re-granting is a new row).
select pg_temp.expect_error($$update public.role_assignments set revoked_at = null, revoked_by = null
  where org_id = 'f1000000-0000-4000-8000-000000000000' and person_id = 'f1000000-0000-4000-8000-0000000000aa'$$, '23514', 'That has already ended%');

-- An archived department takes nobody new; once archived, its name is free again.
update public.departments set archived_at = now(), archived_by = 'f1000000-0000-4000-8000-0000000000a1'
where id = 'f1000000-0000-4000-8000-0000000000c1';
insert into public.departments (id, org_id, name, created_by)
values ('f1000000-0000-4000-8000-0000000000c2', 'f1000000-0000-4000-8000-000000000000', 'Operations', 'f1000000-0000-4000-8000-0000000000a1');
select pg_temp.act_as('1', 'a2');
select pg_temp.expect_error($$update public.people set department_id = 'f1000000-0000-4000-8000-0000000000c1' where id = 'f1000000-0000-4000-8000-0000000000a8'$$,
  '23514', 'That department is archived, so nobody can be added to it.');
update public.people set department_id = 'f1000000-0000-4000-8000-0000000000c2' where id = 'f1000000-0000-4000-8000-0000000000a8';
-- Someone already in it (the Owner) stays until moved.
update public.people set full_name = 'Olive Owner renamed' where id = 'f1000000-0000-4000-8000-0000000000a1';
reset role;

-- Team membership (ACC-07): several teams each, once at a time, never an archived team, never
-- someone who has left. The refusals read as they would on screen.
select pg_temp.expect_error($$insert into public.team_memberships (org_id, team_id, person_id, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000d1', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a1')$$, '23505');
select pg_temp.expect_error($$insert into public.team_memberships (org_id, team_id, person_id, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000d2', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a1')$$,
  '23514', 'That team is archived, so nobody can join it.');
select pg_temp.expect_error($$insert into public.team_memberships (org_id, team_id, person_id, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000d1', 'f1000000-0000-4000-8000-0000000000a9', 'f1000000-0000-4000-8000-0000000000a1')$$,
  '23514', 'That person has left the organisation, so they can''t join a team.');
-- The same refusals reach hearth_app, which adds members through the admin console (C0.16).
select pg_temp.act_as('1', 'a2');
select pg_temp.expect_error($$insert into public.team_memberships (org_id, team_id, person_id, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000d2', 'f1000000-0000-4000-8000-0000000000a6', 'f1000000-0000-4000-8000-0000000000a2')$$,
  '23514', 'That team is archived, so nobody can join it.');
insert into public.team_memberships (org_id, team_id, person_id, created_by)
values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000d1', 'f1000000-0000-4000-8000-0000000000a6', 'f1000000-0000-4000-8000-0000000000a2');
-- a7 left team d1 above; joining again is a new membership.
insert into public.team_memberships (org_id, team_id, person_id, created_by)
values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000d1', 'f1000000-0000-4000-8000-0000000000a7', 'f1000000-0000-4000-8000-0000000000a2');
reset role;

-- Roles (ACC-10): only the seven named ones (Member has no rows); Team Admin, and only Team Admin,
-- names a team; nobody grants, approves or revokes their own; an approval records who and when;
-- one current grant of each; nobody who has left gets one, and no archived team gets a Team
-- Admin. The constraints are named for the server to put into words.
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'member', 'f1000000-0000-4000-8000-0000000000a2')$$, '23514');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'superuser', 'f1000000-0000-4000-8000-0000000000a2')$$, '23514');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'team_admin', 'f1000000-0000-4000-8000-0000000000a2')$$,
  '23514', '%role_assignments_team_admin_has_team%');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, team_id, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'admin', 'f1000000-0000-4000-8000-0000000000d1', 'f1000000-0000-4000-8000-0000000000a1')$$,
  '23514', '%role_assignments_team_admin_has_team%');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a2', 'owner', 'f1000000-0000-4000-8000-0000000000a2')$$,
  '23514', '%role_assignments_not_self_granted%');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by, approved_by, approved_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'dpo', 'f1000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a8', now())$$,
  '23514', '%role_assignments_not_self_approved%');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by, approved_by, approved_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'dpo', 'f1000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a1', now())$$,
  '23514', '%role_assignments_not_self_approved%');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by, approved_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'dpo', 'f1000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a2')$$, '23514');
select pg_temp.expect_error($$update public.role_assignments set revoked_at = now(), revoked_by = person_id
  where org_id = 'f1000000-0000-4000-8000-000000000000' and role = 'ai_admin'$$, '23514', '%role_assignments_not_self_revoked%');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a2', 'admin', 'f1000000-0000-4000-8000-0000000000a1')$$, '23505');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, team_id, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'team_admin', 'f1000000-0000-4000-8000-0000000000d1', 'f1000000-0000-4000-8000-0000000000a1')$$, '23505');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a9', 'admin', 'f1000000-0000-4000-8000-0000000000a1')$$,
  '23514', 'That person has left the organisation, so they can''t be given a role.');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, team_id, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'team_admin', 'f1000000-0000-4000-8000-0000000000d2', 'f1000000-0000-4000-8000-0000000000a1')$$,
  '23514', 'That team is archived, so nobody can be its Team Admin.');
-- A Team Admin of another team, and a role revoked earlier granted again, are fine.
insert into public.teams (id, org_id, name, created_by)
values ('f1000000-0000-4000-8000-0000000000d3', 'f1000000-0000-4000-8000-000000000000', 'Night crew', 'f1000000-0000-4000-8000-0000000000a1');
insert into public.role_assignments (org_id, person_id, role, team_id, created_by)
values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'team_admin', 'f1000000-0000-4000-8000-0000000000d3', 'f1000000-0000-4000-8000-0000000000a1');
insert into public.role_assignments (org_id, person_id, role, created_by)
values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000aa', 'admin', 'f1000000-0000-4000-8000-0000000000a1');
-- hearth_app can read roles but never write them (C0.16's checked functions will).
select pg_temp.act_as('1', 'a1');
select pg_temp.check(count(*) > 0, 'hearth_app could not read roles') from public.role_assignments;
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'admin', 'f1000000-0000-4000-8000-0000000000a1')$$, '42501');
select pg_temp.expect_error($$update public.role_assignments set revoked_at = now(), revoked_by = 'f1000000-0000-4000-8000-0000000000a1'$$, '42501');
select pg_temp.expect_error($$update public.role_assignments set role = 'owner'$$, '42501');
select pg_temp.expect_error($$delete from public.role_assignments$$, '42501');
reset role;

-- Profiles (ACC-08): IANA-style time zones only, trimmed text, a status end needs a status.
do $$
declare
  zone text;
begin
  foreach zone in array array['SGT', '+08', 'Singapore', 'Asia/Atlantis', 'asia/singapore', 'Asia/Singapore+1', 'Asia/Singapore-8', '', ' Asia/Singapore'] loop
    perform pg_temp.expect_error(format('update public.profiles set time_zone = %L where person_id = %L', zone, pg_temp.id('1', 'a8')),
                                 '23514', '%profiles_time_zone%');
  end loop;
  foreach zone in array array['Asia/Singapore', 'Asia/Kuala_Lumpur', 'UTC', 'Etc/GMT+8', 'America/Port-au-Prince', 'America/Argentina/Buenos_Aires', 'US/Eastern'] loop
    update public.profiles set time_zone = zone where person_id = pg_temp.id('1', 'a8');
  end loop;
end
$$;
select pg_temp.expect_error($$update public.profiles set custom_status = '' where person_id = 'f1000000-0000-4000-8000-0000000000a8'$$, '23514');
select pg_temp.expect_error($$update public.profiles set custom_status = null, custom_status_until = now()
  where person_id = 'f1000000-0000-4000-8000-0000000000a8'$$, '23514');
select pg_temp.expect_error($$update public.orgs set time_zone = 'SGT' where id = 'f1000000-0000-4000-8000-000000000000'$$, '23514');
-- A person edits their own profile through hearth_app (ACC-08).
select pg_temp.act_as('1', 'a8');
update public.profiles set time_zone = 'Asia/Jakarta', custom_status = 'On leave', custom_status_until = now() + interval '1 day'
where person_id = 'f1000000-0000-4000-8000-0000000000a8';
select pg_temp.expect_error($$update public.profiles set time_zone = 'Mars/Olympus' where person_id = 'f1000000-0000-4000-8000-0000000000a8'$$, '23514');
reset role;

-- Working hours: a weekday 1-7 and a span that isn't empty; one that ends before it starts runs
-- past midnight.
select pg_temp.expect_error($$insert into public.working_hours (org_id, person_id, weekday, starts_at, ends_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 8, '09:00', '17:00')$$, '23514');
select pg_temp.expect_error($$insert into public.working_hours (org_id, person_id, weekday, starts_at, ends_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 2, '09:00', '09:00')$$, '23514');
insert into public.working_hours (org_id, person_id, weekday, starts_at, ends_at)
values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 2, '22:00', '06:00');

-- Sessions (T5, ACC-04): a 32-byte token hash, unique; an end has who, when and why together; and
-- a session is on the signed-in person's own device, not another person's (in this org or
-- another).
select pg_temp.expect_error($$insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000e1', '\x00', now() + interval '1 day')$$, '23514');
select pg_temp.expect_error($$insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at)
  values ('f2000000-0000-4000-8000-000000000000', 'f2000000-0000-4000-8000-0000000000a8', 'f2000000-0000-4000-8000-0000000000e1',
          decode(md5('session 1') || md5('token 1'), 'hex'), now() + interval '1 day')$$, '23505');
select pg_temp.expect_error($$update public.sessions set revoked_at = now() where id = 'f2000000-0000-4000-8000-0000000000e2'$$, '23514');
select pg_temp.expect_error($$update public.sessions set revoked_at = now(), revoked_by = 'f2000000-0000-4000-8000-0000000000a8'
  where id = 'f2000000-0000-4000-8000-0000000000e2'$$, '23514');
select pg_temp.expect_error($$insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'f1000000-0000-4000-8000-0000000000e1',
          sha256('another person''s device'), now() + interval '1 day')$$, '23503', '%sessions_org_id_user_id_device_id_fkey%');
select pg_temp.expect_error($$insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'f2000000-0000-4000-8000-0000000000e1',
          sha256('another org''s device'), now() + interval '1 day')$$, '23503');

-- Signing a device out ends its open sessions with the device's when and who; a session already
-- ended keeps its own. No session starts on a signed-out device (ACC-04).
insert into public.devices (id, org_id, user_id, label)
values ('f2000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-000000000000', 'f2000000-0000-4000-8000-0000000000a8', 'Laptop');
insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at, revoked_at, revoked_by, revoke_reason) values
  ('f2000000-0000-4000-8000-0000000000e5', 'f2000000-0000-4000-8000-000000000000', 'f2000000-0000-4000-8000-0000000000a8',
   'f2000000-0000-4000-8000-0000000000e4', sha256('open on the laptop'), now() + interval '1 day', null, null, null),
  ('f2000000-0000-4000-8000-0000000000e6', 'f2000000-0000-4000-8000-000000000000', 'f2000000-0000-4000-8000-0000000000a8',
   'f2000000-0000-4000-8000-0000000000e4', sha256('ended on the laptop'), now() + interval '1 day',
   now() - interval '1 hour', 'f2000000-0000-4000-8000-0000000000a8', 'sign_out');
select pg_temp.act_as('2', 'a2');
update public.devices set signed_out_at = now(), signed_out_by = 'f2000000-0000-4000-8000-0000000000a2'
where id = 'f2000000-0000-4000-8000-0000000000e4';
select pg_temp.check((select s.revoked_at = d.signed_out_at and s.revoked_by = d.signed_out_by and s.revoke_reason = 'device_sign_out'
                      from public.sessions s join public.devices d on d.id = s.device_id
                      where s.id = 'f2000000-0000-4000-8000-0000000000e5'),
                     'signing the device out did not end its open session');
select pg_temp.check((select revoked_at < now() and revoked_by = 'f2000000-0000-4000-8000-0000000000a8' and revoke_reason = 'sign_out'
                      from public.sessions where id = 'f2000000-0000-4000-8000-0000000000e6'),
                     'signing the device out changed a session that had already ended');
select pg_temp.expect_error($$insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at)
  values ('f2000000-0000-4000-8000-000000000000', 'f2000000-0000-4000-8000-0000000000a8', 'f2000000-0000-4000-8000-0000000000e4',
          sha256('after the sign-out'), now() + interval '1 day')$$, '23514', 'That device has been signed out.%');
reset role;

-- Notices (PDPA-02, PDPA-03, ACC-12): numbered from v0, each above the last; an acknowledgment is
-- once per version, in the app on the person's own device or recorded by the DPO (never for
-- themselves), and outlives the device.
select pg_temp.expect_error($$insert into public.notice_versions (org_id, version, body, published_by)
  values ('f1000000-0000-4000-8000-000000000000', -1, 'Minus one', 'f1000000-0000-4000-8000-0000000000a5')$$, '23514');
insert into public.notice_versions (id, org_id, version, body, published_by)
values ('f1000000-0000-4000-8000-0000000000e4', 'f1000000-0000-4000-8000-000000000000', 2, 'Version 2', 'f1000000-0000-4000-8000-0000000000a5');
select pg_temp.expect_error($$insert into public.notice_versions (org_id, version, body, published_by)
  values ('f1000000-0000-4000-8000-000000000000', 1, 'Late version 1', 'f1000000-0000-4000-8000-0000000000a5')$$,
  '23514', 'A new notice version must be numbered above the latest, which is 2.');
select pg_temp.expect_error($$insert into public.notice_versions (org_id, version, body, published_by)
  values ('f1000000-0000-4000-8000-000000000000', 2, 'Version 2 again', 'f1000000-0000-4000-8000-0000000000a5')$$, '23514');
-- Org 2 numbers its own.
insert into public.notice_versions (org_id, version, body, published_by)
values ('f2000000-0000-4000-8000-000000000000', 1, 'Org 2 version 1', 'f2000000-0000-4000-8000-0000000000a5');
select pg_temp.expect_error($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000e3', 'in_app')$$, '23505');
select pg_temp.expect_error($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'f1000000-0000-4000-8000-0000000000e3', 'recorded_by_dpo')$$,
  '23514', '%notice_acknowledgments_recorder%');
select pg_temp.expect_error($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, recorded_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a5', 'f1000000-0000-4000-8000-0000000000e3', 'recorded_by_dpo', 'f1000000-0000-4000-8000-0000000000a5')$$,
  '23514', '%notice_acknowledgments_not_self_recorded%');
select pg_temp.expect_error($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, recorded_by, device_id)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000e4', 'recorded_by_dpo',
          'f1000000-0000-4000-8000-0000000000a5', 'f1000000-0000-4000-8000-0000000000e1')$$,
  '23514', '%notice_acknowledgments_device_in_app%');
select pg_temp.expect_error($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'f1000000-0000-4000-8000-0000000000e3', 'by_post')$$, '23514');
-- In the app, on someone else's device: refused.
select pg_temp.expect_error($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, device_id)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'f1000000-0000-4000-8000-0000000000e3', 'in_app',
          'f1000000-0000-4000-8000-0000000000e1')$$, '23503', '%notice_acknowledgments_org_id_person_id_device_id_fkey%');
insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, recorded_by)
values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'f1000000-0000-4000-8000-0000000000e3', 'recorded_by_dpo', 'f1000000-0000-4000-8000-0000000000a5');
select pg_temp.act_as('1', 'a8');
select pg_temp.expect_error($$update public.notice_acknowledgments set acknowledged_at = now()$$, '42501');
select pg_temp.expect_error($$delete from public.notice_acknowledgments$$, '42501');
select pg_temp.expect_error($$update public.notice_versions set body = 'Rewritten'$$, '42501');
reset role;
-- When the retention engine deletes a leaver's device (PDPA-09), the acknowledgment made on it
-- stays, without the device.
delete from public.sessions where device_id = 'f1000000-0000-4000-8000-0000000000e1';
delete from public.devices where id = 'f1000000-0000-4000-8000-0000000000e1';
select pg_temp.check(count(*) = 1 and bool_and(device_id is null and method = 'in_app'),
                     'the acknowledgment did not outlive its device')
from public.notice_acknowledgments
where person_id = 'f1000000-0000-4000-8000-0000000000a8' and notice_version_id = 'f1000000-0000-4000-8000-0000000000e3';
