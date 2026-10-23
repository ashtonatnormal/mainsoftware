-- CLAUDE.md Database: hearth_app gets only the grants each table needs. This pins every privilege
-- it can use on every table, column, sequence and function outside Postgres's own schemas,
-- however it got it (a grant to it, to PUBLIC, or through a role), so any new grant must be added
-- here on purpose. Anything not listed (UPDATE or DELETE on audit_events, SELECT on
-- data_access_events, choosing a log entry's time, any grant on a partition; no DELETE on
-- passkeys; no UPDATE of a passkey's key or credential id; no write of a session's start,
-- last-seen or re-authentication time, or of when a PIN last failed, that the database doesn't
-- stamp; from 0007, reading the outbox or choosing an event's id, position or time, and any grant
-- on jobs, schedules, a fence or the clean-up; from 0009, writing a register row itself, any grant
-- on processing_restrictions, or running the bootstrap's clearance; from 0010, adding a notice
-- version, a link or an acknowledgement itself, or running notice_facts(); from 0011, writing a
-- contact version itself, or running dpo_settings_unchanged()) fails. Nothing may be granted to
-- PUBLIC at all, and hearth_app can create no schema object or temporary table. 032 pins the
-- worker's roles the same way.
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
    -- A new account names only the person and org; the PIN columns are each updated for a reason
    -- (0006). Nothing writes when a PIN last failed: the database stamps it.
    'users: SELECT', 'users.id: INSERT', 'users.org_id: INSERT',
    'users.pin_failures: UPDATE', 'users.pin_hash: UPDATE', 'users.pin_key_id: UPDATE',
    'users.pin_reset_at: UPDATE', 'users.pin_reset_by: UPDATE', 'users.pin_set_at: UPDATE',
    'team_memberships: INSERT', 'team_memberships: SELECT',
    'team_memberships.removed_at: UPDATE', 'team_memberships.removed_by: UPDATE',
    'role_assignments: SELECT',
    'profiles: INSERT', 'profiles: SELECT',
    'profiles.custom_status: UPDATE', 'profiles.custom_status_until: UPDATE', 'profiles.display_name: UPDATE',
    'profiles.time_zone: UPDATE', 'profiles.title: UPDATE', 'profiles.updated_at: UPDATE',
    'working_hours: DELETE', 'working_hours: INSERT', 'working_hours: SELECT',
    'devices: INSERT', 'devices: SELECT',
    'devices.label: UPDATE', 'devices.last_seen_at: UPDATE', 'devices.signed_out_at: UPDATE', 'devices.signed_out_by: UPDATE',
    -- A new session never names its start, last-seen or re-authentication time (0006).
    'sessions: SELECT',
    'sessions.device_id: INSERT', 'sessions.expires_at: INSERT', 'sessions.id: INSERT',
    'sessions.org_id: INSERT', 'sessions.token_hash: INSERT', 'sessions.user_id: INSERT',
    'sessions.last_seen_at: UPDATE', 'sessions.reauthenticated_at: UPDATE', 'sessions.revoke_reason: UPDATE',
    'sessions.revoked_at: UPDATE', 'sessions.revoked_by: UPDATE',
    -- Passkeys: read, add (never choosing the id or when it was added), record a use, remove softly.
    'passkeys: SELECT',
    'passkeys.backed_up: INSERT', 'passkeys.counter: INSERT', 'passkeys.created_device_id: INSERT',
    'passkeys.credential_id: INSERT', 'passkeys.org_id: INSERT', 'passkeys.public_key: INSERT',
    'passkeys.transports: INSERT', 'passkeys.user_id: INSERT',
    'passkeys.counter: UPDATE', 'passkeys.last_used_at: UPDATE', 'passkeys.removed_at: UPDATE', 'passkeys.removed_by: UPDATE',
    -- The notice (0003, 0010, C0.9 PD-42): read the versions, what each lists, and who acknowledged
    -- which, for the acknowledgement gate and the DPO's Notice tab; never add a version or an
    -- acknowledgement directly (publish_notice() and acknowledge_notice() below are the only writers).
    'notice_versions: SELECT',
    'notice_version_purposes: SELECT', 'notice_version_providers: SELECT',
    -- The DPO's contact (0011, C0.9 PD-63): read for the contact page, the draft and everyone's
    -- GET /api/notice; recorded only through set_dpo_contact() below.
    'dpo_settings: SELECT',
    'audit_log_readers: SELECT',
    'notice_acknowledgments: SELECT',
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
    -- Feature flags (0007): read, and change only through set_feature_flag().
    'feature_flags: SELECT',
    -- The outbox (0007): add events in the transaction that makes the change, never reading them
    -- or choosing an event's id, position (tx_id) or time.
    'outbox_events.acl_epoch: INSERT', 'outbox_events.acl_more: INSERT', 'outbox_events.acl_tokens: INSERT',
    'outbox_events.actor_id: INSERT', 'outbox_events.actor_kind: INSERT', 'outbox_events.container_id: INSERT',
    'outbox_events.container_type: INSERT', 'outbox_events.entity_id: INSERT', 'outbox_events.entity_type: INSERT',
    'outbox_events.ids: INSERT', 'outbox_events.index_class: INSERT', 'outbox_events.org_id: INSERT',
    'outbox_events.purpose: INSERT', 'outbox_events.subject_ids: INSERT', 'outbox_events.tombstone: INSERT',
    'outbox_events.type: INSERT', 'outbox_events.version: INSERT',
    -- The registers (0009, C0.9 PR 1): read for the DPO's pages, changed only through the DPO's
    -- functions below; nothing on processing_restrictions until C2.11.
    'processing_register: SELECT', 'transfer_register: SELECT', 'transfer_clearances: SELECT',
    -- Functions.
    'function is_iana_time_zone(text): EXECUTE',
    -- The outbox's ids check runs as whoever writes the row (0007).
    'function is_ids_only(jsonb): EXECUTE',
    'function set_feature_flag(text,boolean,text,uuid[],text[],text,uuid,inet): EXECUTE',
    -- The two sign-in lookups that run before the org is known (0006).
    'function person_by_phone(text): EXECUTE',
    'function session_by_token(bytea,interval): EXECUTE',
    'function read_audit_events(timestamp with time zone,timestamp with time zone,bigint,integer): EXECUTE',
    -- The DPO's register changes (0009, PDPA-01, PDPA-10, PDPA-13), and the transfer gate a send
    -- asks in its own transaction (C0.9 PD-15).
    'function set_register_purpose(text,integer,text,text,text,integer,text,text[],text,uuid,inet): EXECUTE',
    'function record_transfer_entry(text,bigint,text,text,text[],text[],text,text,text,date,boolean,text,text,text,text,text,date,boolean,text,uuid,inet): EXECUTE',
    'function clear_transfer_entry(text,bigint,text,uuid,inet): EXECUTE',
    'function withdraw_transfer_clearance(text,text,uuid,inet): EXECUTE',
    'function transfer_cleared(text): EXECUTE',
    -- The notice (0010, C0.9 PR 2): the DPO publishes and everyone acknowledges through the two
    -- functions; the transfer gate's four answers, which a code send asks (B-03, C-02); and whether
    -- each open clearance is stated, never its facts (B-06). From 0011 (C0.9 PR 3a) publishing names
    -- the contact it printed (PD-66), the DPO records the contact (PD-63) and someone else's
    -- acknowledgement (PD-75), each through its function.
    'function publish_notice(integer,text,text,text[],integer[],uuid[],integer,text,uuid,inet): EXECUTE',
    'function acknowledge_notice(uuid,text,uuid,inet): EXECUTE',
    'function set_dpo_contact(integer,text,text,text,text,text,uuid,inet): EXECUTE',
    'function record_notice_acknowledgement(uuid,uuid,date,text,text,uuid,inet): EXECUTE',
    'function transfer_send_state(text): EXECUTE',
    'function notice_provider_states(): EXECUTE'
  ];
begin
  perform pg_temp.expect_privileges('hearth_app', expected);
end
$$;

-- C-03: nobody runs notice_facts() or notice_check_dpo() (0010); only the owner's definer functions
-- call them. Nor the contact's trigger function (0011).
select pg_temp.check(not has_function_privilege('hearth_app', 'public.notice_facts(jsonb)', 'EXECUTE')
                     and not has_function_privilege('hearth_app', 'public.notice_check_dpo(uuid,uuid)', 'EXECUTE')
                     and not has_function_privilege('hearth_app', 'public.dpo_settings_unchanged()', 'EXECUTE'),
                     'hearth_app can run notice_facts(), notice_check_dpo() or dpo_settings_unchanged()');

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
