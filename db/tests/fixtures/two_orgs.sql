-- Test helpers and two small orgs with a row in every table, for the DB tests in db/tests/. The
-- test runner (scripts/test-db.sh) runs each test in a transaction it rolls back, as a superuser,
-- so this inserts past row level security; each test then switches to hearth_app, or to the job
-- role it tests (0007).
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
--   e3 notice v1     e7 a8's passkey (added on e1)
--   b1 a review schedule      b2 its run, interrupted (a crash)
--   b3 a queued job           b4 a running job, under lease token b5 (both on core.system)
--   e4 a8's withdrawal (processing restriction) of presence_receipts, which a5 (the DPO) recorded
--      as resting on consent in its version 2
--   e5 aws's clearance, by a5 in the app, on the facts a5 recorded (its revision 2)
-- Each org also has every feature flag (the orgs trigger, 0007), one outbox event (flag.changed for
-- core.system, Hearth acting), the offboarding consumer's checkpoint (at the start), a floor
-- (nothing purged yet), and every purpose's and provider's register entry (the orgs trigger, 0009).

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

  insert into public.role_assignments (org_id, person_id, role, team_id, created_by, approved_by, approved_at, revoked_at, revoked_by) values
    (org, owner, 'owner', null, hearth, null, null, null, null),
    (org, admin, 'admin', null, owner, null, null, null, null),
    (org, pg_temp.id(o, 'a3'), 'ai_admin', null, owner, null, null, null, null),
    (org, pg_temp.id(o, 'a4'), 'leadership', null, owner, null, null, null, null),
    (org, pg_temp.id(o, 'a5'), 'dpo', null, owner, admin, now(), null, null),
    (org, pg_temp.id(o, 'a6'), 'compliance_officer', null, owner, admin, now(), null, null),
    (org, pg_temp.id(o, 'a7'), 'team_admin', pg_temp.id(o, 'd1'), admin, null, null, null, null),
    (org, pg_temp.id(o, 'aa'), 'admin', null, owner, null, null, now(), owner);
  -- a9 was a DPO and has left; the role was never revoked.
  insert into public.role_assignments (org_id, person_id, role, created_by, approved_by, approved_at)
    values (org, pg_temp.id(o, 'a9'), 'dpo', owner, admin, now());
  update public.people set deactivated_at = now(), deactivated_by = owner where id = pg_temp.id(o, 'a9');
  -- Nobody may read the audit log until roles are chosen: this org once let Admins read it and
  -- then stopped, so its only reader row is a removed one (050 adds current ones).
  insert into public.audit_log_readers (org_id, role, created_by, removed_at, removed_by)
    values (org, 'admin', owner, now(), owner);

  insert into public.devices (id, org_id, user_id, label) values (pg_temp.id(o, 'e1'), org, pg_temp.id(o, 'a8'), 'Test phone');
  insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at)
    values (pg_temp.id(o, 'e2'), org, pg_temp.id(o, 'a8'), pg_temp.id(o, 'e1'),
            decode(md5('session ' || o) || md5('token ' || o), 'hex'), now() + interval '30 days');
  insert into public.passkeys (id, org_id, user_id, credential_id, public_key, backed_up, created_device_id)
    values (pg_temp.id(o, 'e7'), org, pg_temp.id(o, 'a8'), decode(md5('credential ' || o), 'hex'),
            decode(md5('public key ' || o) || md5('key ' || o), 'hex'), true, pg_temp.id(o, 'e1'));
  insert into public.notice_versions (id, org_id, version, body, published_by)
    values (pg_temp.id(o, 'e3'), org, 0, 'Test notice ' || o, pg_temp.id(o, 'a5'));
  insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, device_id)
    values (org, pg_temp.id(o, 'a8'), pg_temp.id(o, 'e3'), 'in_app', pg_temp.id(o, 'e1'));

  insert into public.audit_events (org_id, actor_id, action, target_type, target_id)
    values (org, admin, 'role.granted', 'person', pg_temp.id(o, 'a3')::text);
  insert into public.data_access_events (org_id, type, subject_id, actor_id, object_type, object_id)
    values (org, 'export', pg_temp.id(o, 'a8'), pg_temp.id(o, 'a8'), 'file', 'test-file-' || o);

  -- The outbox, the queue and the scheduler, written as the worker writes them, with Hearth acting:
  -- an event's actor and a job's created_by are the transaction's acting principal (0007).
  perform set_config('app.user_id', hearth::text, true);
  insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose, ids)
  select org, 'flag.changed', 'feature_flag', f.id, hearth, 'system', 'service_operation',
         jsonb_build_object('key', f.key, 'enabled', f.enabled)
  from public.feature_flags f where f.org_id = org and f.key = 'core.system';
  insert into public.outbox_checkpoints (org_id, consumer, role_name) values (org, 'offboarding', 'hearth_job_offboarding');
  insert into public.outbox_floors (org_id, last_tx, last_id) values (org, '0', 0);
  insert into public.schedules (id, org_id, key, kind, cron, on_interrupt, next_run_at)
    values (pg_temp.id(o, 'b1'), org, 'fixture.hourly', 'fixture.review_run', '0 * * * *', 'review', now() + interval '1 hour');
  insert into public.schedule_runs (id, org_id, schedule_id, scheduled_for, on_interrupt, state, reason, started_at, finished_at)
    values (pg_temp.id(o, 'b2'), org, pg_temp.id(o, 'b1'), date_trunc('hour', now()), 'review', 'interrupted', 'crash', now(), now());
  insert into public.jobs (id, org_id, kind, feature_key, purpose)
    values (pg_temp.id(o, 'b3'), org, 'fixture.queued', 'core.system', 'service_operation');
  insert into public.jobs (id, org_id, kind, feature_key, purpose, state, attempts, lease_token, lease_expires_at, claimed_by, started_at)
    values (pg_temp.id(o, 'b4'), org, 'fixture.running', 'core.system', 'service_operation', 'running', 1,
            pg_temp.id(o, 'b5'), now() + interval '30 seconds', 'fixture', now());
  perform set_config('app.user_id', '', true);

  -- The registers (0009), written as the DPO's functions write them: presence_receipts' version 2
  -- rests on consent, so a8's withdrawal of it can be recorded; aws's facts are recorded and cleared.
  insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status, basis, retention,
                                          recorded_by)
  select org, r.purpose, r.ai, r.pinned, r.needs_switch, 2, 'active', 'consent', 'Until the person withdraws it',
         pg_temp.id(o, 'a5')
  from public.processing_register r where r.org_id = org and r.purpose = 'presence_receipts' and r.version = 1;
  insert into public.processing_restrictions (id, org_id, person_id, purpose, effective_at, created_by)
    values (pg_temp.id(o, 'e4'), org, pg_temp.id(o, 'a8'), 'presence_receipts', now(), pg_temp.id(o, 'a5'));
  update public.transfer_register
  set services = 'Hosting, CloudWatch logs', data_types = 'Everything Hearth stores', processing_countries = '{SG}',
      storage_countries = '{SG}', countries_confirmed = 'Test agreement, schedule 1', safeguard = 'dpa',
      safeguard_reference = 'Test agreement', dpa_terms_confirmed = true, training = 'not_applicable',
      zero_retention = 'not_applicable', provider_retention = 'Until deleted', retention_confirmed = 'Test agreement, clause 9',
      onward_recipients = 'None', review_on = current_date + 365, revision = 2, updated_at = now(), updated_by = pg_temp.id(o, 'a5')
  where org_id = org and provider = 'aws';
  insert into public.transfer_clearances (id, org_id, entry_id, cleared_by, cleared_via)
  select pg_temp.id(o, 'e5'), org, t.id, pg_temp.id(o, 'a5'), 'app'
  from public.transfer_register t where t.org_id = org and t.provider = 'aws';
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

-- A worker transaction in an org (0007): Hearth's system principal acting, as one of the worker's
-- job roles (withOrg's `as`).
create function pg_temp.act_as_job(o text, job_role text) returns void language plpgsql as $$
begin
  perform set_config('app.org_id', pg_temp.id(o, '00')::text, true);
  perform set_config('app.user_id', pg_temp.id(o, 'a0')::text, true);
  perform set_config('role', job_role, true);
end
$$;

-- The roles the server's transactions run as: every role granted something on a table, a column or
-- a function in this database (the owner aside), as scripts/check-migrations.sh finds them. A new
-- runtime role is then checked by 010 and 020 the day it lands.
create function pg_temp.runtime_roles() returns text[] language sql stable as $$
  select coalesce(array_agg(distinct a.grantee::regrole::text order by a.grantee::regrole::text), '{}')
  from (
    select (aclexplode(c.relacl)).grantee, c.relowner as owner
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
    union all
    select (aclexplode(att.attacl)).grantee, c.relowner
    from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute att on att.attrelid = c.oid and att.attnum > 0
    where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
    union all
    select (aclexplode(p.proacl)).grantee, p.proowner
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
  ) a
  where a.grantee not in (0, a.owner)
$$;

-- Every privilege a role can use on every table, column, sequence and function outside Postgres's
-- own schemas, however it got it (a grant to it, to PUBLIC, or through a role it inherits), one
-- line each: '<table>: <PRIVILEGE>' for the whole table, '<table>.<column>: <PRIVILEGE>' for some
-- columns only, 'sequence <name>: ...' and 'function <signature>: EXECUTE'.
create function pg_temp.privileges_of(who text) returns text[] language sql stable as $$
  with rel as (
    select c.oid, c.relkind,
           case n.nspname when 'public' then c.relname::text else format('%I.%I', n.nspname, c.relname) end as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  ), table_level as (
    select r.oid, r.name, p.priv
    from rel r cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (priv)
    where r.relkind <> 'S' and has_table_privilege(who, r.oid, p.priv)
  )
  select coalesce(array_agg(g order by g), '{}') from (
    select format('%s: %s', name, priv) as g from table_level
    union all
    -- Column privileges it holds only for some columns.
    select format('%s.%s: %s', r.name, a.attname, p.priv)
    from rel r
    join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p (priv)
    where r.relkind <> 'S' and has_column_privilege(who, r.oid, a.attnum, p.priv)
      and not exists (select 1 from table_level t where t.oid = r.oid and t.priv = p.priv)
    union all
    select format('sequence %s: %s', r.name, p.priv)
    from rel r cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) as p (priv)
    where r.relkind = 'S' and has_sequence_privilege(who, r.oid, p.priv)
    union all
    -- Functions it can run, by any route.
    select format('function %s: EXECUTE', p.oid::regprocedure)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
      and has_function_privilege(who, p.oid, 'EXECUTE')
  ) grants
$$;

-- Fails the test unless the role's privileges (privileges_of) are exactly the expected ones,
-- naming what is missing and what is extra.
create function pg_temp.expect_privileges(who text, expected text[]) returns void language plpgsql as $$
declare
  actual text[] := pg_temp.privileges_of(who);
  missing text[];
  extra text[];
begin
  select coalesce(array_agg(e order by e), '{}') into missing from unnest(expected) e where e <> all (actual);
  select coalesce(array_agg(a order by a), '{}') into extra from unnest(actual) a where a <> all (expected);
  perform pg_temp.check(cardinality(missing) = 0, format('%s lacks grants this test expects: %s', who, missing));
  perform pg_temp.check(cardinality(extra) = 0,
    format('%s holds grants this test does not list (add them here only if they are meant): %s', who, extra));
end
$$;
