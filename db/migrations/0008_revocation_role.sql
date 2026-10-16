-- C0.7: the revocation registry's job role (BUILD-PLAN C0.7; INF-REVOKE; TECH-SPEC T18, T19).
--
-- hearth_job_revocation runs the revocation outbox consumer, which reads signin.ended and
-- acl.changed and queues one revocation.handler job per handler, and runs those jobs. The sockets
-- job re-reads which sessions an event names have ended, and when, before it tells the realtime
-- role on Valkey; the topics job only tells it whose access changed, which realtime re-checks
-- itself. Like 0007's job roles (CLAUDE.md, Database: every system job gets its own role with only
-- the grants it needs) it is NOLOGIN, owns nothing, is a member of nothing, is held to row level
-- security and may be used by hearth_worker alone, by SET and never INHERIT. A role that already
-- exists is checked, grant by grant, rather than skipped silently.
--
-- Closing a leaver's sockets moves from the offboarding registry to this one (T19 item 2). This
-- migration only adds (T3, expand and contract): hearth_job_offboarding keeps its read of sessions,
-- because a C0.6 worker may still run its offboarding sockets job while C0.7 deploys; a later
-- migration revokes it once no such worker can run.
--
-- With a second role that may start checkpoints, outbox_checkpoints_own_row() now also binds each
-- consumer the server runs to the role it runs as (below). No table, row or constraint changes;
-- the database's types are unchanged.
do $$
declare
  r pg_roles%rowtype;
  bad text;
begin
  select * into r from pg_roles where rolname = 'hearth_job_revocation';
  if not found then
    create role hearth_job_revocation nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  else
    if r.rolcanlogin or r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication then
      raise exception 'hearth_job_revocation already exists with a power it must not have (login, superuser, bypassrls, createrole, createdb or replication)';
    end if;
    select string_agg(g.rolname, ', ') into bad
    from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid;
    if bad is not null then
      raise exception 'hearth_job_revocation already exists and is a member of %; a job role must be a member of no role', bad;
    end if;
    -- Only hearth_worker may act as it (SET, never INHERIT or ADMIN), beside the ADMIN-only grant
    -- Postgres gives the role that created it.
    select string_agg(g.rolname, ', ') into bad
    from pg_auth_members m join pg_roles g on g.oid = m.member
    where m.roleid = r.oid
      and not (g.rolname = 'hearth_worker' and not m.inherit_option and not m.admin_option)
      and not (g.rolname = 'hearth_owner' and not m.inherit_option and not m.set_option);
    if bad is not null then
      raise exception 'hearth_job_revocation already exists and % may act as it; only hearth_worker may (SET, never INHERIT)', bad;
    end if;
    -- It owns nothing, here or server-wide (hearth_worker's own check in 0007 ran before it existed).
    if exists (select 1 from pg_shdepend d
               where d.refclassid = 'pg_authid'::regclass and d.refobjid = r.oid and d.deptype = 'o'
                 and d.dbid in (0, (select o.oid from pg_database o where o.datname = current_database()))) then
      raise exception 'hearth_job_revocation already exists and owns something; a job role owns nothing';
    end if;
  end if;
end
$$;
grant hearth_job_revocation to hearth_worker with inherit false, set true;

-- withOrg()'s system principal.
grant select (id, org_id, kind, system_key) on public.principals to hearth_job_revocation;

-- The consumer: read the outbox, start and move its own checkpoint (outbox_checkpoints_own_row,
-- below, keeps it to its own), read the floors, and end every round with the fence.
grant select on public.outbox_events to hearth_job_revocation;
grant select, insert (org_id, consumer, role_name, last_tx, last_id) on public.outbox_checkpoints to hearth_job_revocation;
grant update (last_tx, last_id, processed, updated_at) on public.outbox_checkpoints to hearth_job_revocation;
grant select on public.outbox_floors to hearth_job_revocation;
grant execute on function public.feature_fence(text, bigint[]) to hearth_job_revocation;

-- One job per handler, never choosing who made it, its state or its lease (is_ids_only() runs in
-- the payload's CHECK); the jobs run as this role too, so it fences and finishes them.
grant execute on function public.is_ids_only(jsonb) to hearth_job_revocation;
grant insert (id, org_id, kind, feature_key, purpose, subject_id, payload, idempotency_key, max_attempts, run_after)
  on public.jobs to hearth_job_revocation;
grant execute on function public.job_fence(uuid, uuid, bigint[]), public.job_finish(uuid, uuid, bigint[])
  to hearth_job_revocation;

-- The sockets job's re-read: which of the sessions an event names have ended, and when.
grant select (id, org_id, user_id, revoked_at) on public.sessions to hearth_job_revocation;

-- A checkpoint is still the business of the role it names (0007), and from here each consumer the
-- server runs is bound to the role it runs as (its OutboxConsumer's role). 0007 checked only that
-- the writer may use the role a row names, which held while one role could start checkpoints. With
-- two, either could start the other's checkpoint under its own name, in an org where that consumer
-- hasn't made it yet, and the consumer could then never move it (42501 at every round), or would
-- read on from wherever it was planted. Now a row whose consumer is bound must name that role, so
-- only a writer who may use it can start or move the row: anyone else, the superuser included, is
-- refused the same way. A name that isn't bound (the tests' own consumers) may still name any role
-- its writer may use. A migration that adds a consumer replaces this function with its name bound.
create or replace function public.outbox_checkpoints_own_row() returns trigger
language plpgsql set search_path = '' as $$
declare
  owner_role oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = new.role_name);
  bound text := case new.consumer
                  when 'offboarding' then 'hearth_job_offboarding'
                  when 'revocation' then 'hearth_job_revocation'
                end;
begin
  if owner_role is null or not pg_catalog.pg_has_role(current_user, owner_role, 'USAGE')
     or (bound is not null and new.role_name <> bound)
     or (tg_op = 'UPDATE' and new.role_name is distinct from old.role_name) then
    raise exception 'Only the role that runs a consumer may move its checkpoint.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
revoke execute on function public.outbox_checkpoints_own_row() from public;

-- No checkpoint already breaks the binding (none can: before this migration only the offboarding
-- role could start one, and C0.6 starts only its own), so every row is held to it from here.
do $$
declare
  bad text;
begin
  select string_agg(format('%s (%s, naming %s)', c.consumer, c.org_id, c.role_name), '; ') into bad
  from public.outbox_checkpoints c
  where (c.consumer = 'offboarding' and c.role_name <> 'hearth_job_offboarding')
     or (c.consumer = 'revocation' and c.role_name <> 'hearth_job_revocation');
  if bad is not null then
    raise exception 'A checkpoint names a role other than the one its consumer runs as: %', bad;
  end if;
end
$$;
