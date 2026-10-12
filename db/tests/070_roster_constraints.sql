-- ACC-03, ACC-06, ACC-07, ACC-08, ACC-10, ACC-12, PDPA-03, T5: the roster's own rules, which hold
-- for every writer (these run as the owner unless they say otherwise).
\ir fixtures/two_orgs.sql

-- Phone numbers (ACC-03, ACC-06): E.164, one current number per person, and a current number
-- belongs to one person; a removed number can be given out again.
select pg_temp.expect_error($$insert into public.phone_numbers (org_id, person_id, e164, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a9', '91234567', 'f1000000-0000-4000-8000-0000000000a1')$$, '23514');
select pg_temp.expect_error($$insert into public.phone_numbers (org_id, person_id, e164, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a9', '+65 9123 4567', 'f1000000-0000-4000-8000-0000000000a1')$$, '23514');
select pg_temp.expect_error($$insert into public.phone_numbers (org_id, person_id, e164, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', '+6591234567', 'f1000000-0000-4000-8000-0000000000a1')$$, '23505');
select pg_temp.expect_error($$insert into public.phone_numbers (org_id, person_id, e164, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a9', '+6510000001', 'f1000000-0000-4000-8000-0000000000a1')$$, '23505');
update public.phone_numbers set removed_at = now(), removed_by = 'f1000000-0000-4000-8000-0000000000a1'
where org_id = 'f1000000-0000-4000-8000-000000000000' and e164 = '+6510000009';
insert into public.phone_numbers (org_id, person_id, e164, created_by)
values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a9', '+6599990000', 'f1000000-0000-4000-8000-0000000000a1');
-- The same number in another org is that org's business.
insert into public.phone_numbers (org_id, person_id, e164, created_by, removed_at, removed_by)
values ('f2000000-0000-4000-8000-000000000000', 'f2000000-0000-4000-8000-0000000000a9', '+6510000001', 'f2000000-0000-4000-8000-0000000000a1',
        now(), 'f2000000-0000-4000-8000-0000000000a1');
-- Who removed it goes with when.
select pg_temp.expect_error($$update public.phone_numbers set removed_at = now()
  where org_id = 'f1000000-0000-4000-8000-000000000000' and e164 = '+6510000008'$$, '23514');

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
reset role;
-- After leaving a team, joining it again is a new membership.
update public.team_memberships set removed_at = now(), removed_by = 'f1000000-0000-4000-8000-0000000000a1'
where org_id = 'f1000000-0000-4000-8000-000000000000' and person_id = 'f1000000-0000-4000-8000-0000000000a8';
insert into public.team_memberships (org_id, team_id, person_id, created_by)
values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000d1', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a1');

-- Roles (ACC-10): only the seven named ones (Member has no rows); Team Admin, and only Team Admin,
-- names a team; nobody grants, approves or revokes their own; one current grant of each.
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'member', 'f1000000-0000-4000-8000-0000000000a2')$$, '23514');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'superuser', 'f1000000-0000-4000-8000-0000000000a2')$$, '23514');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'team_admin', 'f1000000-0000-4000-8000-0000000000a2')$$, '23514');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, team_id, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'admin', 'f1000000-0000-4000-8000-0000000000d1', 'f1000000-0000-4000-8000-0000000000a1')$$, '23514');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a2', 'owner', 'f1000000-0000-4000-8000-0000000000a2')$$, '23514');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by, approved_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'dpo', 'f1000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a8')$$, '23514');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by, approved_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'dpo', 'f1000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a1')$$, '23514');
select pg_temp.expect_error($$update public.role_assignments set revoked_at = now(), revoked_by = person_id
  where org_id = 'f1000000-0000-4000-8000-000000000000' and role = 'ai_admin'$$, '23514');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a2', 'admin', 'f1000000-0000-4000-8000-0000000000a1')$$, '23505');
select pg_temp.expect_error($$insert into public.role_assignments (org_id, person_id, role, team_id, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'team_admin', 'f1000000-0000-4000-8000-0000000000d1', 'f1000000-0000-4000-8000-0000000000a1')$$, '23505');
-- A Team Admin of another team, and a role revoked earlier granted again, are fine.
insert into public.role_assignments (org_id, person_id, role, team_id, created_by)
values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'team_admin', 'f1000000-0000-4000-8000-0000000000d2', 'f1000000-0000-4000-8000-0000000000a1');
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

-- Profiles (ACC-08): IANA time zones only, trimmed text, a status end needs a status.
select pg_temp.expect_error($$update public.profiles set time_zone = 'SGT' where person_id = 'f1000000-0000-4000-8000-0000000000a8'$$, '23514');
select pg_temp.expect_error($$update public.profiles set time_zone = '+08' where person_id = 'f1000000-0000-4000-8000-0000000000a8'$$, '23514');
select pg_temp.expect_error($$update public.profiles set time_zone = 'Asia/Atlantis' where person_id = 'f1000000-0000-4000-8000-0000000000a8'$$, '23514');
update public.profiles set time_zone = 'Asia/Kuala_Lumpur' where person_id = 'f1000000-0000-4000-8000-0000000000a8';
update public.profiles set time_zone = 'UTC' where person_id = 'f1000000-0000-4000-8000-0000000000a8';
select pg_temp.expect_error($$update public.profiles set custom_status = '' where person_id = 'f1000000-0000-4000-8000-0000000000a8'$$, '23514');
select pg_temp.expect_error($$update public.profiles set custom_status = null, custom_status_until = now()
  where person_id = 'f1000000-0000-4000-8000-0000000000a8'$$, '23514');
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

-- Sessions (T5): a 32-byte token hash, unique; an end has who, when and why together.
select pg_temp.expect_error($$insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000e1', '\x00', now() + interval '1 day')$$, '23514');
select pg_temp.expect_error($$insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at)
  values ('f2000000-0000-4000-8000-000000000000', 'f2000000-0000-4000-8000-0000000000a8', 'f2000000-0000-4000-8000-0000000000e1',
          decode(md5('session 1') || md5('token 1'), 'hex'), now() + interval '1 day')$$, '23505');
select pg_temp.expect_error($$update public.sessions set revoked_at = now() where id = 'f1000000-0000-4000-8000-0000000000e2'$$, '23514');
select pg_temp.expect_error($$update public.sessions set revoked_at = now(), revoked_by = 'f1000000-0000-4000-8000-0000000000a8'
  where id = 'f1000000-0000-4000-8000-0000000000e2'$$, '23514');
update public.sessions set revoked_at = now(), revoked_by = 'f1000000-0000-4000-8000-0000000000a8', revoke_reason = 'sign_out'
where id = 'f1000000-0000-4000-8000-0000000000e2';
-- A device's session must belong to the same person's device in the same org.
select pg_temp.expect_error($$insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'f2000000-0000-4000-8000-0000000000e1',
          decode(md5('x') || md5('y'), 'hex'), now() + interval '1 day')$$, '23503');

-- Notices (PDPA-02, PDPA-03, ACC-12): versions are numbered once each; an acknowledgment is once
-- per version, in the app or recorded by the DPO (never for themselves), and stays as made.
select pg_temp.expect_error($$insert into public.notice_versions (org_id, version, body, published_by)
  values ('f1000000-0000-4000-8000-000000000000', 1, 'Again', 'f1000000-0000-4000-8000-0000000000a5')$$, '23505');
select pg_temp.expect_error($$insert into public.notice_versions (org_id, version, body, published_by)
  values ('f1000000-0000-4000-8000-000000000000', 0, 'Zero', 'f1000000-0000-4000-8000-0000000000a5')$$, '23514');
select pg_temp.expect_error($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000e3', 'in_app')$$, '23505');
select pg_temp.expect_error($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'f1000000-0000-4000-8000-0000000000e3', 'recorded_by_dpo')$$, '23514');
select pg_temp.expect_error($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, recorded_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a5', 'f1000000-0000-4000-8000-0000000000e3', 'recorded_by_dpo', 'f1000000-0000-4000-8000-0000000000a5')$$, '23514');
select pg_temp.expect_error($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'f1000000-0000-4000-8000-0000000000e3', 'by_post')$$, '23514');
insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, recorded_by)
values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'f1000000-0000-4000-8000-0000000000e3', 'recorded_by_dpo', 'f1000000-0000-4000-8000-0000000000a5');
select pg_temp.act_as('1', 'a8');
select pg_temp.expect_error($$update public.notice_acknowledgments set acknowledged_at = now()$$, '42501');
select pg_temp.expect_error($$delete from public.notice_acknowledgments$$, '42501');
select pg_temp.expect_error($$update public.notice_versions set body = 'Rewritten'$$, '42501');
