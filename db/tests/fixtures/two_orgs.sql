-- Test helpers and two small orgs with a row in every table, for the DB tests in db/tests/. The
-- test runner (scripts/test-db.sh) runs each test in a transaction it rolls back, as a superuser,
-- so this inserts past row level security; each test then switches to hearth_app.
--
-- Ids: pg_temp.id(org, suffix) is f<org>000000-0000-4000-8000-0000000000<suffix>. Org 1 and org 2
-- have the same people under the same suffixes:
--   00 the org                      a0 Hearth (system principal)
--   a1 Owner                        a2 Admin             a3 AI Admin        a4 Leadership
--   a5 DPO                          a6 Compliance Officer                   a7 Team Admin (team d1)
--   a8 Member (reports to a7, who reports to a1)
--   a9 a DPO who has left (deactivated, role never revoked)
--   aa a former Admin (role revoked)
--   ab an agent                     ac a8's assistant
--   c1 department    d1 team    d2 archived team    e1 a8's device    e2 a8's session
--   e3 notice v1

-- pg_temp.id('1', 'a1') is org 1's Owner.
create function pg_temp.id(org text, suffix text) returns uuid language sql immutable as $$
  select ('f' || org || '000000-0000-4000-8000-0000000000' || suffix)::uuid
$$;

-- Runs a statement that must fail with the given SQLSTATE (42501 insufficient privilege or a
-- row level security refusal, 23514 a check, 23503 a foreign key, 23505 a unique index), and
-- fails the test if it succeeds or fails another way. message_like, if given, must match the
-- error message (ILIKE), to tell one trigger's refusal from another's.
create function pg_temp.expect_error(stmt text, state text, message_like text default null) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlstate = state and (message_like is null or sqlerrm ilike message_like) then
      return;
    end if;
    raise exception 'expected % % but got % (%) from: %', state, coalesce(message_like, ''), sqlstate, sqlerrm, stmt;
  end;
  raise exception 'expected % from: %', state, stmt;
end
$$;

-- Runs a statement that must succeed and affect exactly the given number of rows.
create function pg_temp.expect_rows(stmt text, expected bigint) returns void language plpgsql as $$
declare
  n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  if n <> expected then
    raise exception 'expected % row(s) but got % from: %', expected, n, stmt;
  end if;
end
$$;

-- Fails the test with a message unless the condition holds.
create function pg_temp.check(ok boolean, message text) returns void language plpgsql as $$
begin
  if ok is not true then
    raise exception 'check failed: %', message;
  end if;
end
$$;

-- One org with a row in every table.
create function pg_temp.make_org(o text) returns void language plpgsql as $$
declare
  org uuid := pg_temp.id(o, '00');
  hearth uuid := pg_temp.id(o, 'a0');
  owner uuid := pg_temp.id(o, 'a1');
  admin uuid := pg_temp.id(o, 'a2');
  s text;
begin
  insert into public.orgs (id, name) values (org, 'Test org ' || o);
  insert into public.principals (id, org_id, kind, system_key) values (hearth, org, 'system', 'hearth');
  foreach s in array array['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'aa'] loop
    insert into public.principals (id, org_id, kind) values (pg_temp.id(o, s), org, 'human');
  end loop;
  insert into public.principals (id, org_id, kind) values (pg_temp.id(o, 'ab'), org, 'agent');
  insert into public.principals (id, org_id, kind, owner_id) values (pg_temp.id(o, 'ac'), org, 'assistant', pg_temp.id(o, 'a8'));

  insert into public.departments (id, org_id, name, created_by) values (pg_temp.id(o, 'c1'), org, 'Operations', hearth);
  insert into public.teams (id, org_id, name, created_by) values (pg_temp.id(o, 'd1'), org, 'Crew', owner);
  insert into public.teams (id, org_id, name, created_by, archived_at, archived_by)
    values (pg_temp.id(o, 'd2'), org, 'Old crew', owner, now(), owner);

  insert into public.people (id, org_id, full_name, department_id, created_by) values (owner, org, 'Olive Owner ' || o, pg_temp.id(o, 'c1'), hearth);
  foreach s in array array['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a9', 'aa'] loop
    insert into public.people (id, org_id, full_name, manager_id, created_by)
      values (pg_temp.id(o, s), org, 'Person ' || s || ' ' || o, case when s = 'a7' then owner end, owner);
  end loop;
  insert into public.people (id, org_id, full_name, manager_id, created_by)
    values (pg_temp.id(o, 'a8'), org, 'Mel Member ' || o, pg_temp.id(o, 'a7'), owner);
  update public.people set deactivated_at = now(), deactivated_by = owner where id = pg_temp.id(o, 'a9');

  -- +65 <org> 00000 <two digits>, e.g. +6510000001 for org 1's Owner and +6510000010 for aa.
  insert into public.phone_numbers (org_id, person_id, e164, created_by)
  select org, pg_temp.id(o, p.suffix), '+65' || o || '00000' || lpad(p.n::text, 2, '0'), owner
  from unnest(array['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'aa']) with ordinality as p (suffix, n);
  insert into public.phone_numbers (org_id, person_id, e164, created_by, removed_at, removed_by)
    values (org, pg_temp.id(o, 'a8'), '+65' || o || '9999999', owner, now(), owner);

  foreach s in array array['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'] loop
    insert into public.users (id, org_id) values (pg_temp.id(o, s), org);
    insert into public.profiles (person_id, org_id, display_name) values (pg_temp.id(o, s), org, 'P' || s);
  end loop;
  insert into public.working_hours (org_id, person_id, weekday, starts_at, ends_at)
    values (org, pg_temp.id(o, 'a8'), 1, '09:00', '17:00');

  insert into public.team_memberships (org_id, team_id, person_id, created_by)
    values (org, pg_temp.id(o, 'd1'), pg_temp.id(o, 'a7'), owner), (org, pg_temp.id(o, 'd1'), pg_temp.id(o, 'a8'), owner);

  insert into public.role_assignments (org_id, person_id, role, team_id, created_by, approved_by, revoked_at, revoked_by) values
    (org, owner, 'owner', null, hearth, null, null, null),
    (org, admin, 'admin', null, owner, null, null, null),
    (org, pg_temp.id(o, 'a3'), 'ai_admin', null, owner, null, null, null),
    (org, pg_temp.id(o, 'a4'), 'leadership', null, owner, null, null, null),
    (org, pg_temp.id(o, 'a5'), 'dpo', null, owner, admin, null, null),
    (org, pg_temp.id(o, 'a6'), 'compliance_officer', null, owner, admin, null, null),
    (org, pg_temp.id(o, 'a7'), 'team_admin', pg_temp.id(o, 'd1'), admin, null, null, null),
    (org, pg_temp.id(o, 'a9'), 'dpo', null, owner, admin, null, null),
    (org, pg_temp.id(o, 'aa'), 'admin', null, owner, null, now(), owner);

  insert into public.devices (id, org_id, user_id, label) values (pg_temp.id(o, 'e1'), org, pg_temp.id(o, 'a8'), 'Test phone');
  insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at)
    values (pg_temp.id(o, 'e2'), org, pg_temp.id(o, 'a8'), pg_temp.id(o, 'e1'),
            decode(md5('session ' || o) || md5('token ' || o), 'hex'), now() + interval '30 days');
  insert into public.notice_versions (id, org_id, version, body, published_by)
    values (pg_temp.id(o, 'e3'), org, 1, 'Test notice ' || o, pg_temp.id(o, 'a5'));
  insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, device_id)
    values (org, pg_temp.id(o, 'a8'), pg_temp.id(o, 'e3'), 'in_app', pg_temp.id(o, 'e1'));

  insert into public.audit_events (org_id, actor_id, action, target_type, target_id)
    values (org, admin, 'role.granted', 'person', pg_temp.id(o, 'a3')::text);
  insert into public.data_access_events (org_id, type, subject_id, actor_id, object_type, object_id)
    values (org, 'export', pg_temp.id(o, 'a8'), pg_temp.id(o, 'a8'), 'file', 'test-file-' || o);
end
$$;

select pg_temp.make_org('1');
select pg_temp.make_org('2');

-- Acting as someone in an org: the settings the server's transaction helper sets from the
-- session (CLAUDE.md, Database), then hearth_app. Callers 'reset role' to act as the superuser
-- again (to arrange data or read what hearth_app can't).
create function pg_temp.act_as(o text, suffix text) returns void language plpgsql as $$
begin
  perform set_config('app.org_id', pg_temp.id(o, '00')::text, true);
  perform set_config('app.user_id', pg_temp.id(o, suffix)::text, true);
  perform set_config('role', 'hearth_app', true);
end
$$;
