-- CLAUDE.md Database: hearth_app gets only the grants each table needs. This pins every privilege
-- it can use on every table, column, sequence and function outside Postgres's own schemas,
-- however it got it (a grant to it, to PUBLIC, or through a role), so any new grant must be added
-- here on purpose. Anything not listed (UPDATE or DELETE on audit_events, SELECT on
-- data_access_events, choosing a log entry's time, any grant on a partition) fails. Nothing may be
-- granted to PUBLIC at all, and hearth_app can create no schema object or temporary table.
\ir fixtures/two_orgs.sql

do $$
declare
  expected text[] := array[
    'orgs: SELECT',
    'principals: INSERT', 'principals: SELECT',
    'departments: INSERT', 'departments: SELECT',
    'departments.archived_at: UPDATE', 'departments.archived_by: UPDATE', 'departments.name: UPDATE',
    'teams: INSERT', 'teams: SELECT',
    'teams.archived_at: UPDATE', 'teams.archived_by: UPDATE', 'teams.name: UPDATE',
    'people: INSERT', 'people: SELECT',
    'people.deactivated_at: UPDATE', 'people.deactivated_by: UPDATE', 'people.department_id: UPDATE',
    'people.full_name: UPDATE', 'people.manager_id: UPDATE',
    'phone_numbers: INSERT', 'phone_numbers: SELECT',
    'phone_numbers.removed_at: UPDATE', 'phone_numbers.removed_by: UPDATE',
    'users: INSERT', 'users: SELECT',
    'team_memberships: INSERT', 'team_memberships: SELECT',
    'team_memberships.removed_at: UPDATE', 'team_memberships.removed_by: UPDATE',
    'role_assignments: SELECT',
    'profiles: INSERT', 'profiles: SELECT',
    'profiles.custom_status: UPDATE', 'profiles.custom_status_until: UPDATE', 'profiles.display_name: UPDATE',
    'profiles.time_zone: UPDATE', 'profiles.title: UPDATE', 'profiles.updated_at: UPDATE',
    'working_hours: DELETE', 'working_hours: INSERT', 'working_hours: SELECT',
    'devices: INSERT', 'devices: SELECT',
    'devices.label: UPDATE', 'devices.last_seen_at: UPDATE', 'devices.signed_out_at: UPDATE', 'devices.signed_out_by: UPDATE',
    'sessions: INSERT', 'sessions: SELECT',
    'sessions.last_seen_at: UPDATE', 'sessions.revoke_reason: UPDATE', 'sessions.revoked_at: UPDATE', 'sessions.revoked_by: UPDATE',
    'notice_versions: INSERT', 'notice_versions: SELECT',
    'notice_acknowledgments: SELECT',
    'notice_acknowledgments.device_id: INSERT', 'notice_acknowledgments.method: INSERT',
    'notice_acknowledgments.notice_version_id: INSERT', 'notice_acknowledgments.org_id: INSERT',
    'notice_acknowledgments.person_id: INSERT', 'notice_acknowledgments.recorded_by: INSERT',
    -- The logs: add rows, nothing else, and never choose an entry's id or time.
    'audit_events.action: INSERT', 'audit_events.actor_id: INSERT',
    'audit_events.case_id: INSERT', 'audit_events.details: INSERT', 'audit_events.device_id: INSERT',
    'audit_events.ip: INSERT', 'audit_events.on_behalf_of_id: INSERT',
    'audit_events.org_id: INSERT', 'audit_events.reason: INSERT', 'audit_events.request_id: INSERT',
    'audit_events.target_id: INSERT', 'audit_events.target_type: INSERT', 'audit_events.via: INSERT',
    'data_access_events.actor_id: INSERT', 'data_access_events.case_id: INSERT', 'data_access_events.data_type: INSERT',
    'data_access_events.details: INSERT', 'data_access_events.object_id: INSERT',
    'data_access_events.object_type: INSERT', 'data_access_events.on_behalf_of_id: INSERT',
    'data_access_events.org_id: INSERT', 'data_access_events.provider: INSERT', 'data_access_events.request_id: INSERT',
    'data_access_events.subject_id: INSERT', 'data_access_events.type: INSERT', 'data_access_events.via: INSERT',
    -- Functions.
    'function is_iana_time_zone(text): EXECUTE',
    'function read_audit_events(timestamp with time zone,timestamp with time zone,bigint,integer): EXECUTE'
  ];
  actual text[];
  missing text[];
  extra text[];
begin
  with rel as (
    select c.oid, c.relkind,
           case n.nspname when 'public' then c.relname::text else format('%I.%I', n.nspname, c.relname) end as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  ), table_level as (
    select r.oid, r.name, p.priv
    from rel r cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (priv)
    where r.relkind <> 'S' and has_table_privilege('hearth_app', r.oid, p.priv)
  )
  select coalesce(array_agg(g order by g), '{}') into actual from (
    select format('%s: %s', name, priv) as g from table_level
    union all
    -- Column privileges it holds only for some columns.
    select format('%s.%s: %s', r.name, a.attname, p.priv)
    from rel r
    join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p (priv)
    where r.relkind <> 'S' and has_column_privilege('hearth_app', r.oid, a.attnum, p.priv)
      and not exists (select 1 from table_level t where t.oid = r.oid and t.priv = p.priv)
    union all
    select format('sequence %s: %s', r.name, p.priv)
    from rel r cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) as p (priv)
    where r.relkind = 'S' and has_sequence_privilege('hearth_app', r.oid, p.priv)
    union all
    -- Functions it can run, by any route.
    select format('function %s: EXECUTE', p.oid::regprocedure)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
      and has_function_privilege('hearth_app', p.oid, 'EXECUTE')
  ) grants;

  select coalesce(array_agg(e order by e), '{}') into missing from unnest(expected) e where e <> all (actual);
  select coalesce(array_agg(a order by a), '{}') into extra from unnest(actual) a where a <> all (expected);
  perform pg_temp.check(cardinality(missing) = 0, format('hearth_app lacks grants this test expects: %s', missing));
  perform pg_temp.check(cardinality(extra) = 0,
    format('hearth_app holds grants this test does not list (add them here only if they are meant): %s', extra));
end
$$;

-- Nothing in the schema is granted to PUBLIC, table or column.
select pg_temp.check(count(*) = 0, format('granted to PUBLIC: %s', string_agg(what, ', ')))
from (
  select format('%I.%I %s', n.nspname, c.relname, a.privilege_type) as what
  from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
  where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema' and a.grantee = 0
  union all
  select format('%I.%I.%I %s', n.nspname, c.relname, att.attname, a.privilege_type)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute att on att.attrelid = c.oid and att.attnum > 0
  cross join lateral aclexplode(att.attacl) a
  where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema' and a.grantee = 0
) public_grants;

-- It can create nothing: no schema, no object in one, no temporary table.
select pg_temp.check(not has_database_privilege('hearth_app', current_database(), 'CREATE'), 'hearth_app can create schemas');
select pg_temp.check(not has_database_privilege('hearth_app', current_database(), 'TEMPORARY'), 'hearth_app can create temporary tables');
select pg_temp.check(not exists (
  select 1 from pg_namespace n
  where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema' and has_schema_privilege('hearth_app', n.oid, 'CREATE')),
  'hearth_app can create objects in a schema');

-- And the role itself: no superuser, no BYPASSRLS, no CREATEROLE or CREATEDB, not the database's
-- owner, and a member of no role (rds_iam aside, on RDS, if it has no powers of its own).
select pg_temp.check(not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication),
                     'hearth_app has a power it must not have')
from pg_roles where rolname = 'hearth_app';
select pg_temp.check(pg_get_userbyid(datdba) = 'hearth_owner', 'hearth_owner does not own the database')
from pg_database where datname = current_database();
select pg_temp.check(not exists (
  select 1 from pg_auth_members m join pg_roles g on g.oid = m.roleid
  where m.member = 'hearth_app'::regrole
    and not (g.rolname = 'rds_iam' and not g.rolsuper and not g.rolbypassrls
             and not exists (select 1 from pg_auth_members r where r.member = g.oid))),
  'hearth_app is a member of another role');

-- A temporary type can't stand in for the one the time zone check names (pg_catalog.timestamptz),
-- even for a role that could make one.
create domain pg_temp.timestamptz as text;
select pg_temp.check(not public.is_iana_time_zone('Mars/Olympus_Mons'), 'a temporary type changed is_iana_time_zone');
