-- CLAUDE.md Database: hearth_app gets only the grants each table needs. This pins every privilege
-- it holds on the public schema's tables, columns, sequences and functions, so any new grant (or
-- a table that gets one) must be added here on purpose, and anything not listed (UPDATE or
-- DELETE on audit_events, SELECT on data_access_events, any grant on a partition) fails.
\ir fixtures/two_orgs.sql

do $$
declare
  expected text[] := array[
    'orgs: SELECT',
    'principals: INSERT', 'principals: SELECT', 'principals.archived_at: UPDATE',
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
    'notice_acknowledgments: INSERT', 'notice_acknowledgments: SELECT',
    -- The logs: add rows, nothing else.
    'audit_events.action: INSERT', 'audit_events.actor_id: INSERT', 'audit_events.at: INSERT',
    'audit_events.case_id: INSERT', 'audit_events.details: INSERT', 'audit_events.device_id: INSERT',
    'audit_events.ip: INSERT', 'audit_events.on_behalf_of_id: INSERT',
    'audit_events.org_id: INSERT', 'audit_events.reason: INSERT', 'audit_events.request_id: INSERT',
    'audit_events.target_id: INSERT', 'audit_events.target_type: INSERT', 'audit_events.via: INSERT',
    'data_access_events.actor_id: INSERT', 'data_access_events.at: INSERT', 'data_access_events.data_type: INSERT',
    'data_access_events.details: INSERT', 'data_access_events.id: INSERT', 'data_access_events.object_id: INSERT',
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
  select coalesce(array_agg(g order by g), '{}') into actual from (
    -- Table-wide grants.
    select format('%s: %s', c.relname, a.privilege_type) as g
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    where s.nspname = 'public' and a.grantee = 'hearth_app'::regrole
    union all
    -- Column grants.
    select format('%s.%s: %s', c.relname, att.attname, a.privilege_type)
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
    join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
    cross join lateral aclexplode(att.attacl) a
    where s.nspname = 'public' and a.grantee = 'hearth_app'::regrole
    union all
    -- Functions it can run, by any route (a grant to it or to PUBLIC).
    select format('function %s: EXECUTE', p.oid::regprocedure)
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and has_function_privilege('hearth_app', p.oid, 'EXECUTE')
  ) grants;

  select coalesce(array_agg(e order by e), '{}') into missing from unnest(expected) e where e <> all (actual);
  select coalesce(array_agg(a order by a), '{}') into extra from unnest(actual) a where a <> all (expected);
  perform pg_temp.check(cardinality(missing) = 0, format('hearth_app lacks grants this test expects: %s', missing));
  perform pg_temp.check(cardinality(extra) = 0,
    format('hearth_app holds grants this test does not list (add them here only if they are meant): %s', extra));
end
$$;

-- And the role itself: no superuser, no BYPASSRLS, no CREATEROLE or CREATEDB, a member of nothing
-- that matters (scripts/check-migrations.sh checks the RLS part on every build).
select pg_temp.check(not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication),
                     'hearth_app has a power it must not have')
from pg_roles where rolname = 'hearth_app';
select pg_temp.check(not exists (
  select 1 from pg_auth_members m join pg_roles g on g.oid = m.roleid
  where m.member = 'hearth_app'::regrole and g.rolname <> 'rds_iam'), 'hearth_app is a member of another role');
