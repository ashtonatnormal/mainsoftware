-- C0.6: the job queue, the scheduler, the outbox and feature flags (BUILD-PLAN C0.6; INF-QUEUE,
-- INF-SCHED, INF-OUTBOX, INF-FLAGS; TECH-SPEC T4, T15-T18).
--
-- Hearth runs its own small queue rather than pg-boss (T4, the owner's decision of 14 Oct 2026), so
-- every table here follows the same rules as the rest: org_id, row level security, owned by
-- hearth_owner, granted column by column. A job is a row the worker claims with FOR UPDATE SKIP
-- LOCKED and finishes in the same transaction as its last effect (job_finish), so an effect made
-- in that transaction commits once. Schedules fire jobs; a run cut short either goes back to the
-- queue (maintenance, which is safe to repeat) or waits as interrupted for a person (AGT-10).
--
-- The outbox is ids-only: one row per business event, appended in the transaction that made the
-- change, so a rolled-back write leaves no event. Consumers read it in the order of the writer's
-- transaction id, never past the oldest transaction still running, so no row can appear behind a
-- consumer's checkpoint (T16). Rows go after 14 days, only through purge_outbox(), which deletes
-- from the lowest position up and records how far it went (the floor).
--
-- Feature flags are rows per org whose keys and defaults the migrations set (feature_flag_defaults()
-- below; packages/shared lists the same keys with their class and purposes, and CI compares the
-- two). Every ai.* flag is off and locked here: no function, grant or role can turn one on until
-- A0's migration lifts this lock, and C0.9's purpose gate then refuses it until its purpose is
-- notified and its providers cleared. A flag changes only through set_feature_flag(), and every
-- change bumps its revision. A transaction that makes a feature's effect visible ends with a fence
-- that locks the feature's flags FOR SHARE and refuses unless they are on and still at the
-- revisions the server checked, so nothing commits after a flag is turned off or narrowed.
--
-- The worker connects as hearth_worker, which holds nothing itself, and takes one job role for each
-- transaction (CLAUDE.md, Database: every system job gets its own role with only the grants it
-- needs). It lists orgs through worker_org_ids(), which returns only their ids: the one cross-org
-- read besides the sign-in lookups (0006).
--
-- No existing row is changed: this adds roles, tables, functions and grants, a flag row for each
-- (org, flag), and a trigger that gives every new org its flag rows.

-- The worker's roles (T18). hearth_worker is the worker's login: its password locally and IAM on
-- RDS are set outside git, as hearth_app's are. It is NOINHERIT and holds each job role with SET
-- but never INHERIT, so it can use nothing until the server takes one job role for a transaction
-- (withOrg's `as`). The job roles never log in, own nothing and are members of nothing. Roles
-- belong to the whole server, so one that already exists is checked rather than skipped silently
-- (CLAUDE.md, Database): its attributes, the roles it belongs to, and who may act as it. On
-- Postgres 16 and later each grant has its own INHERIT and SET options, whatever the role's
-- NOINHERIT says, so the options are checked grant by grant. hearth_worker may already hold job
-- roles a later migration added; it may never hold anything that could own a table or skip row
-- level security.
do $$
declare
  job text;
  r pg_roles%rowtype;
  bad text;
  db_owner oid := (select d.datdba from pg_database d where d.datname = current_database());
begin
  foreach job in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge'] loop
    select * into r from pg_roles where rolname = job;
    if not found then
      execute format('create role %I nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls', job);
      continue;
    end if;
    if r.rolcanlogin or r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication then
      raise exception '% already exists with a power it must not have (login, superuser, bypassrls, createrole, createdb or replication)', job;
    end if;
    select string_agg(g.rolname, ', ') into bad from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid;
    if bad is not null then
      raise exception '% already exists and is a member of %; a job role must be a member of no role', job, bad;
    end if;
    -- Only hearth_worker may act as a job role (SET, never INHERIT or ADMIN), beside the ADMIN-only
    -- grant Postgres gives the role that created it.
    select string_agg(g.rolname, ', ') into bad
    from pg_auth_members m join pg_roles g on g.oid = m.member
    where m.roleid = r.oid
      and not (g.rolname = 'hearth_worker' and not m.inherit_option and not m.admin_option)
      and not (g.rolname = 'hearth_owner' and not m.inherit_option and not m.set_option);
    if bad is not null then
      raise exception '% already exists and % may act as it; only hearth_worker may (SET, never INHERIT)', job, bad;
    end if;
  end loop;

  select * into r from pg_roles where rolname = 'hearth_worker';
  if not found then
    create role hearth_worker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  else
    if r.rolinherit or r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication then
      raise exception 'hearth_worker already exists with a power it must not have (inherit, superuser, bypassrls, createrole, createdb or replication)';
    end if;
    -- What it belongs to: job roles, by SET and never INHERIT, and on RDS the powerless rds_iam,
    -- which IAM sign-in needs.
    select string_agg(g.rolname, ', ') into bad
    from pg_auth_members m join pg_roles g on g.oid = m.roleid
    where m.member = r.oid
      and not (g.rolname = 'rds_iam' and not g.rolsuper and not g.rolbypassrls
               and not exists (select 1 from pg_auth_members x where x.member = g.oid))
      and (m.inherit_option or m.admin_option
           or g.rolsuper or g.rolbypassrls or g.rolcreaterole or g.rolcreatedb or g.rolreplication or g.rolcanlogin
           or g.rolname in ('hearth_owner', 'hearth_app') or g.oid = db_owner
           or exists (select 1 from pg_auth_members x where x.member = g.oid));
    if bad is not null then
      raise exception 'hearth_worker already exists and is a member of %; it may only hold job roles, by SET', bad;
    end if;
    -- Nobody may act as hearth_worker, beside its creator's ADMIN-only grant.
    select string_agg(g.rolname, ', ') into bad
    from pg_auth_members m join pg_roles g on g.oid = m.member
    where m.roleid = r.oid and not (g.rolname = 'hearth_owner' and not m.inherit_option and not m.set_option);
    if bad is not null then
      raise exception 'hearth_worker already exists and % may act as it; nobody may', bad;
    end if;
  end if;
end
$$;
grant hearth_queue, hearth_job_offboarding, hearth_job_partitions, hearth_job_purge to hearth_worker
  with inherit false, set true;

-- Feature flags (INF-FLAGS, T17). One row per org and flag. A flag is on for a job or a request when
-- it and every flag above it (ai above ai.agents above ai.agents.<id>) is enabled, and, where it
-- names a cohort, the person is in it. A locked flag keeps its value; only a migration changes a
-- lock. Each change bumps the revision, which every process polls (and hears on Valkey) to apply
-- the change within 10 seconds (PRD-65), and which the fences compare. updated_by is empty only
-- while a flag still has the value a migration gave it.
create table public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  key text not null constraint feature_flags_key check (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' and length(key) <= 100),
  enabled boolean not null,
  locked boolean not null,
  -- Who the flag is on for while it's enabled: the whole org, or the people and the holders of the
  -- org-wide roles named here (any of them). Teams and departments come with the step that first
  -- needs them (C6.8's department waves), and so does Team Admin: its powers end when its team is
  -- archived (T13), so telling who holds it means reading teams.
  audience text not null default 'org' check (audience in ('org', 'cohort')),
  cohort_people uuid[] not null default '{}',
  cohort_roles text[] not null default '{}'
    check (cohort_roles <@ array['owner', 'admin', 'ai_admin', 'leadership', 'dpo', 'compliance_officer']::text[]),
  revision bigint not null default 1 check (revision >= 1),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (org_id, id),
  unique (org_id, key),
  constraint feature_flags_cohort check (
    (audience = 'cohort') = (cardinality(cohort_people) + cardinality(cohort_roles) > 0)
    and cardinality(cohort_people) + cardinality(cohort_roles) <= 1000
    and array_position(cohort_people, null) is null),
  check ((updated_by is null) = (revision = 1)),
  -- Every ai.* flag is off and locked until A0 (BUILD-PLAN C0.6; D41). A0's migration replaces this
  -- constraint (and bumps the revision of every row it changes); C0.9's purpose gate is the second
  -- lock.
  constraint feature_flags_ai_locked_off check (key !~ '^ai(\.|$)' or (locked and not enabled)),
  foreign key (org_id, updated_by) references public.principals (org_id, id)
);

-- The flags every org has, with the value and lock each starts with. A migration that adds a flag
-- replaces this function and inserts the new rows for existing orgs; apps/server/scripts/
-- check-catalogues.ts fails CI unless it lists exactly the keys, defaults and locks of FLAGS in
-- packages/shared. Only the owner reads it (the trigger below, CI's check).
create function public.feature_flag_defaults() returns table (key text, enabled boolean, locked boolean)
language sql immutable set search_path = '' as $$
  values
    -- Hearth's own maintenance: partitions, the outbox and queue clean-up, offboarding. Locked on.
    ('core.system', true, true),
    -- Every AI feature (ADM-10's "all AI features"), and each one under it (A0-A5).
    ('ai', false, true),
    ('ai.transcription', false, true),
    ('ai.transcription.sessions', false, true),
    ('ai.transcription.voice_messages', false, true),
    ('ai.notes', false, true),
    ('ai.brain', false, true),
    ('ai.ask', false, true),
    ('ai.catch_up', false, true),
    ('ai.summaries', false, true),
    ('ai.docs', false, true),
    ('ai.sheets', false, true),
    ('ai.slides', false, true),
    ('ai.quick_replies', false, true),
    ('ai.people_inference', false, true),
    ('ai.assistant', false, true),
    ('ai.agents', false, true),
    ('ai.onboarding_buddy', false, true)
$$;
revoke execute on function public.feature_flag_defaults() from public;

-- A new org gets every flag at its default. Orgs are made by the owner (the bootstrap script, the
-- seed) or a test's superuser, never by hearth_app.
create function public.orgs_add_feature_flags() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.feature_flags (org_id, key, enabled, locked)
  select new.id, d.key, d.enabled, d.locked from public.feature_flag_defaults() d;
  return null;
end
$$;
revoke execute on function public.orgs_add_feature_flags() from public;
create trigger orgs_add_feature_flags after insert on public.orgs
  for each row execute function public.orgs_add_feature_flags();
insert into public.feature_flags (org_id, key, enabled, locked)
select o.id, d.key, d.enabled, d.locked from public.orgs o cross join public.feature_flag_defaults() d;

-- Whether a jsonb object holds only ids (T16): each value a uuid, a code (lower-case letters,
-- digits and underscores, dotted, at most 63 characters), a whole number from 0 to 1,000,000, a
-- boolean, or a list of at most 100 uuids. It refuses what most often carries someone's details:
-- free text, a phone number written as a number, text spelled out as a list of numbers, nested
-- objects. It is the database's backstop for outbox events, job payloads and schedule payloads;
-- the guarantee is the schemas of the event catalogue and the job kinds, whose every field is a
-- uuid, an enum, a boolean or a bounded number (packages/shared, catalogues.test.ts). It runs in
-- CHECK constraints, so every role that writes those tables needs EXECUTE on it.
create function public.is_ids_only(j jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_typeof(j) = 'object' and pg_catalog.pg_column_size(j) <= 8192
    and not pg_catalog.jsonb_path_exists(j, 'strict $.* ? (!(
          (@.type() == "string"
            && @ like_regex "^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z][a-z0-9_]*(\\.[a-z0-9_]+)*)$"
            && !(@ like_regex "^.{64}"))
          || (@.type() == "number" && @ >= 0 && @ <= 1000000 && @ == @.floor())
          || @.type() == "boolean"
          || (@.type() == "array" && @.size() <= 100)))')
    and not pg_catalog.jsonb_path_exists(j, 'strict $.* ? (@.type() == "array")[*] ? (!(
          @.type() == "string" && @ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))')
$$;
revoke execute on function public.is_ids_only(jsonb) from public;

-- The outbox (INF-OUTBOX, T16): ids only, never content. type is one of the catalogue's event
-- types (packages/shared EVENTS; CI compares the two lists), which a later step extends with a
-- migration. Every row is written in the transaction that made the change, and records:
--   tx_id         that transaction's id, which consumers read in order, never past the oldest
--                 transaction still running (pg_snapshot_xmin), so no row commits behind them.
--                 Only the default can set it: a producer that chose it could hide a row below
--                 every checkpoint.
--   at            when the row was written (the clock, not the transaction's start), for the lag
--                 metric and the 14 days.
--   entity        what the event is about; container: the place whose ACL the snapshot came from.
--   acl_*         for content, the snapshot @hearth/access's aclOf makes (tokens, more,
--                 index_class) and the container's acl_epoch, which every change that rewrites its
--                 stored ACL rows bumps (grant, visibility, move, trash, restore; never a
--                 membership, team or role change, which changes people's keys instead; T13).
--                 Events that aren't about content carry none.
--   actor         who caused it, with their principal kind: the principal acting in the
--                 transaction, or, when Hearth acts (a sign-in before a session exists, a job),
--                 whoever it names (outbox_events_check_actor). subject_ids: whose personal data
--                 it concerns; purpose: why (a purpose key, C0.9's register); tombstone: the entity
--                 is gone, so everything made from it goes too.
--   ids           the other ids the consumers need (is_ids_only).
create table public.outbox_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id),
  tx_id xid8 not null default pg_catalog.pg_current_xact_id(),
  at timestamptz not null default pg_catalog.clock_timestamp(),
  type text not null constraint outbox_events_type check (type in (
    -- Emitted from C0.6.
    'signin.started', 'signin.ended', 'account.pin_set', 'account.pin_reset', 'account.passkey_added',
    'account.passkey_removed', 'person.deactivated', 'acl.changed', 'flag.changed',
    -- Reserved: named now, emitted by the step after each.
    'person.added', 'person.updated', 'person.phone_changed', 'department.changed', 'team.changed',
    'team.membership_changed', 'role.changed',                                     -- C0.16
    'profile.updated',                                                             -- C0.15
    'notice.published', 'notice.acknowledged',                                     -- C0.9
    'message.created', 'message.updated', 'message.deleted',                       -- C1.1
    'voice_message.created',                                                       -- C1.6
    'task.created', 'task.updated', 'task.deleted', 'task.overdue',                -- C2.1
    'session.started', 'session.ended',                                            -- C2.4 (room sessions)
    'track_segment.written',                                                       -- C2.6
    'redaction.applied',                                                           -- C2.11
    'suggested_task.created'                                                       -- C3.5
  )),
  version smallint not null default 1 check (version between 1 and 100),
  entity_type text not null check (entity_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  entity_id uuid not null,
  container_type text check (container_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  container_id uuid,
  acl_tokens text[],
  acl_more jsonb,
  index_class text check (index_class in ('normal', 'dm', 'agent_dm', 'personal', 'playback_only', 'restricted')),
  acl_epoch bigint check (acl_epoch >= 0),
  actor_id uuid not null,
  actor_kind text not null check (actor_kind in ('human', 'agent', 'assistant', 'system')),
  subject_ids uuid[] not null default '{}' check (cardinality(subject_ids) <= 100 and array_position(subject_ids, null) is null),
  purpose text not null check (purpose ~ '^[a-z][a-z0-9_]{0,62}$'),
  tombstone boolean not null default false,
  ids jsonb not null default '{}' constraint outbox_events_ids_only check (public.is_ids_only(ids)),
  check ((container_type is null) = (container_id is null)),
  -- A snapshot comes whole or not at all (aclOf's row shape; @hearth/access/sql reads it).
  constraint outbox_events_acl_whole check (
    (acl_tokens is null) = (acl_more is null) and (acl_tokens is null) = (index_class is null)
    and (acl_tokens is null) = (acl_epoch is null)),
  check (acl_more is null or jsonb_typeof(acl_more) = 'array'),
  check (array_position(acl_tokens, null) is null),
  -- The actor's kind is its principal's.
  foreign key (org_id, actor_id, actor_kind) references public.principals (org_id, id, kind)
);
-- Consumers read by (org, tx_id, id), from their checkpoint, and the purge deletes in that order.
create index outbox_events_cursor on public.outbox_events (org_id, tx_id, id);
-- The purge finds how far 14 days reach by time.
create index outbox_events_at on public.outbox_events (org_id, at);

-- An event's actor is the principal the transaction acts as (app.user_id), which the server took
-- from the session (CLAUDE.md, Database), unless that principal is Hearth itself: before a session
-- exists the person signing in is the actor, as the audit row has it, and a job names whoever its
-- work is for.
create function public.outbox_events_check_actor() returns trigger
language plpgsql set search_path = '' as $$
declare
  acting uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
begin
  if new.actor_id is distinct from acting and not exists (
       select 1 from public.principals p where p.org_id = new.org_id and p.id = acting and p.kind = 'system') then
    raise exception 'An event''s actor must be the principal acting in its transaction.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
revoke execute on function public.outbox_events_check_actor() from public;
create trigger outbox_events_check_actor before insert on public.outbox_events
  for each row execute function public.outbox_events_check_actor();

-- Where each consumer has read to, per org (T16): the (tx_id, id) of the last event it handled. A
-- consumer advances it in the transaction that applies the events' effects, so effects and position
-- commit together. role_name is the job role the consumer runs as, and only that role moves the row
-- (outbox_checkpoints_own_row), so one consumer can't skip another's events.
create table public.outbox_checkpoints (
  org_id uuid not null references public.orgs (id),
  consumer text not null check (consumer ~ '^[a-z][a-z0-9_]{0,62}$'),
  role_name text not null check (role_name ~ '^hearth_[a-z0-9_]{1,56}$'),
  last_tx xid8 not null default '0',
  last_id bigint not null default 0 check (last_id >= 0),
  processed bigint not null default 0 check (processed >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, consumer)
);

-- A checkpoint is the business of the role it names. USAGE, not membership: the worker's login is a
-- member of every job role but can use none of them without taking it, and the owner (an admin
-- member) can't either. A test's superuser can. A role name that names no role is refused the same
-- way, rather than with Postgres's own error for an unknown role, and a checkpoint never changes
-- hands.
create function public.outbox_checkpoints_own_row() returns trigger
language plpgsql set search_path = '' as $$
declare
  owner_role oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = new.role_name);
begin
  if owner_role is null or not pg_catalog.pg_has_role(current_user, owner_role, 'USAGE')
     or (tg_op = 'UPDATE' and new.role_name is distinct from old.role_name) then
    raise exception 'Only the role that runs a consumer may move its checkpoint.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
revoke execute on function public.outbox_checkpoints_own_row() from public;
create trigger outbox_checkpoints_own_row before insert or update on public.outbox_checkpoints
  for each row execute function public.outbox_checkpoints_own_row();

-- How far the purge has deleted in each org: every event at or below this (tx_id, id) is gone,
-- and none can appear there again. A consumer whose checkpoint is below it has missed events and
-- must be rebuilt from the base tables (T16); a new consumer, or a replay from the oldest kept
-- event, starts here. Only purge_outbox() writes it.
create table public.outbox_floors (
  org_id uuid primary key references public.orgs (id),
  last_tx xid8 not null,
  last_id bigint not null check (last_id >= 0),
  purged_at timestamptz not null default now()
);

-- Schedules (INF-SCHED, T15): a 5-field cron expression, in UTC, that fires a job kind. Hearth's own
-- schedules come from the server's registry (apps/server/src/jobs/schedules.ts, origin
-- 'registry'), which the worker writes here for each org; A5 adds rows people make. A key's kind,
-- cron, payload and interrupt policy never change, so two versions of the worker running at once
-- during a deploy can't undo each other: a change is a new key, with the old key retired. A retired
-- schedule stays retired, and is never deleted. on_interrupt says what happens to a run cut short:
-- rerun (it goes back to the queue: safe to repeat) or review (it waits for a person, AGT-10).
create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  key text not null check (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' and length(key) <= 100),
  origin text not null default 'registry' check (origin in ('registry')),
  kind text not null check (kind ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and length(kind) <= 100),
  cron text not null check (cron ~ '^[0-9*,/-]+( [0-9*,/-]+){4}$'),
  on_interrupt text not null check (on_interrupt in ('rerun', 'review')),
  payload jsonb not null default '{}' constraint schedules_payload_ids_only check (public.is_ids_only(payload)),
  next_run_at timestamptz not null,
  last_fired_at timestamptz,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (org_id, id),
  unique (org_id, key)
);
create index schedules_due on public.schedules (org_id, next_run_at) where retired_at is null;
create trigger schedules_keep_history before update of retired_at on public.schedules
  for each row execute function public.keep_history('retired_at');

-- One firing of a schedule (an occurrence), and each attempt at it. A run is queued, running, then
-- succeeded or failed, or skipped (it wasn't run: its feature was off, say). A review run cut short
-- (a crash, a deploy, its flag turned off, a timeout) is interrupted and waits for a person: resume
-- makes the next attempt, dismiss closes it. Nothing retries it silently (AGT-10). The step that
-- adds the first review schedule (A4 or A5.4) adds the checked function that records the decision
-- (review_schedule_run()), its grant and the scheduler's next attempt; until then no run can wait,
-- because C0.6's schedules are all rerun ones and only A4's and A5's will be review schedules.
-- reason is a code: why it was skipped, failed or interrupted.
create table public.schedule_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  schedule_id uuid not null,
  scheduled_for timestamptz not null,
  attempt integer not null default 1 check (attempt between 1 and 1000),
  on_interrupt text not null check (on_interrupt in ('rerun', 'review')),
  state text not null default 'queued'
    check (state in ('queued', 'running', 'succeeded', 'failed', 'skipped', 'interrupted', 'resumed', 'dismissed')),
  reason text check (reason ~ '^[a-z][a-z0-9_]{0,62}$'),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid,
  review_note text check (length(review_note) between 1 and 2000),
  resumed_from uuid,
  unique (org_id, id),
  -- One run per occurrence and attempt, so two schedulers firing at once make one.
  unique (org_id, schedule_id, scheduled_for, attempt),
  check ((reviewed_at is null) = (reviewed_by is null)),
  constraint schedule_runs_reviewed check ((state in ('resumed', 'dismissed')) = (reviewed_at is not null)),
  constraint schedule_runs_reason check (state not in ('failed', 'skipped', 'interrupted') or reason is not null),
  constraint schedule_runs_finished check ((state in ('queued', 'running')) = (finished_at is null)),
  -- Only a review run waits for a person; a rerun one goes back to the queue.
  constraint schedule_runs_review_only check (state not in ('interrupted', 'resumed', 'dismissed') or on_interrupt = 'review'),
  -- A first attempt resumes nothing. A later one names the run it resumes until the purge deletes
  -- that older run (90 days after its review).
  check (resumed_from is null or attempt > 1),
  foreign key (org_id, schedule_id) references public.schedules (org_id, id),
  foreign key (org_id, reviewed_by) references public.principals (org_id, id),
  foreign key (org_id, resumed_from) references public.schedule_runs (org_id, id) on delete set null (resumed_from)
);
create index schedule_runs_open on public.schedule_runs (org_id, state) where state in ('interrupted', 'resumed');
create index schedule_runs_finished_at on public.schedule_runs (org_id, finished_at) where finished_at is not null;
-- The next attempt names the one it resumes, once.
create unique index schedule_runs_resumed_once on public.schedule_runs (org_id, resumed_from) where resumed_from is not null;
create trigger schedule_runs_keep_history before update of reviewed_at, reviewed_by on public.schedule_runs
  for each row execute function public.keep_history('reviewed_at', 'reviewed_by');

-- The job queue (INF-QUEUE, T15). A producer adds a row in its own transaction, so a rolled-back
-- change queues nothing; created_by is the principal that transaction acts as, which no producer
-- chooses. Every job names its feature (a flag: it runs only while that flag is on) and the purpose
-- it processes personal data for, and, if it works for one person, that person, so cohorts and
-- processing switches can be checked (BUILD-PLAN 842); the worker refuses a job whose feature or
-- purpose isn't its kind's. payload is ids only, like the outbox's ids. A worker claims a queued
-- job (state running, with a fresh lease token), keeps the lease alive while it runs, and finishes
-- it in the transaction of its last effect (job_finish), or gives it back: queued again with a
-- delay (a retry), queued at once and uncounted (give_backs counts those, so a job that can never
-- finish ends), dead (no attempts left, or a failure that won't go away), or cancelled (its
-- optional feature was switched off). reason is a code: why it was retried, cancelled or died. A
-- key makes adding the same job twice add it once.
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  kind text not null check (kind ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and length(kind) <= 100),
  feature_key text not null,
  purpose text not null check (purpose ~ '^[a-z][a-z0-9_]{0,62}$'),
  subject_id uuid,
  payload jsonb not null default '{}' constraint jobs_payload_ids_only check (public.is_ids_only(payload)),
  idempotency_key text check (length(idempotency_key) between 1 and 200),
  state text not null default 'queued' check (state in ('queued', 'running', 'succeeded', 'dead', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 100),
  give_backs integer not null default 0 check (give_backs between 0 and 1000),
  run_after timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  claimed_by text check (claimed_by ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  reason text check (reason ~ '^[a-z][a-z0-9_.]{0,99}$'),
  schedule_run_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid not null default nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid,
  started_at timestamptz,
  finished_at timestamptz,
  unique (org_id, id),
  constraint jobs_lease check ((state = 'running') = (lease_token is not null) and (lease_token is null) = (lease_expires_at is null)),
  constraint jobs_finished check ((state in ('succeeded', 'dead', 'cancelled')) = (finished_at is not null)),
  constraint jobs_reason check (state not in ('dead', 'cancelled') or reason is not null),
  check (attempts <= max_attempts),
  foreign key (org_id, feature_key) references public.feature_flags (org_id, key),
  foreign key (org_id, created_by) references public.principals (org_id, id),
  foreign key (org_id, subject_id) references public.people (org_id, id),
  foreign key (org_id, schedule_run_id) references public.schedule_runs (org_id, id) on delete set null (schedule_run_id)
);
create unique index jobs_idempotency on public.jobs (org_id, kind, idempotency_key) where idempotency_key is not null;
create index jobs_claim on public.jobs (org_id, run_after) where state = 'queued';
create index jobs_leases on public.jobs (org_id, lease_expires_at) where state = 'running';
create index jobs_finished_at on public.jobs (org_id, finished_at) where finished_at is not null;
create index jobs_schedule_run on public.jobs (org_id, schedule_run_id) where schedule_run_id is not null;
create index jobs_feature on public.jobs (org_id, feature_key) where state in ('queued', 'running');

-- Row level security: each table only within the org the server set (CLAUDE.md, Database).
do $$
declare
  t text;
begin
  foreach t in array array['feature_flags', 'outbox_events', 'outbox_checkpoints', 'outbox_floors', 'schedules',
                           'schedule_runs', 'jobs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy org_isolation on public.%I
      using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  end loop;
end
$$;

-- The orgs the worker serves, ids only (T18): the one cross-org read besides the sign-in lookups
-- (0006). The worker can't list orgs through RLS, which shows a transaction only its own org, and
-- needs each org's id to open that org's transactions. Only hearth_queue may call it.
create function public.worker_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select o.id from public.orgs o order by o.id
$$;
revoke execute on function public.worker_org_ids() from public;

-- The fences (feature_fence, job_fence, job_finish) are SECURITY DEFINER because their FOR SHARE and
-- FOR NO KEY UPDATE locks need UPDATE on the table, which no runtime role is given on flags or
-- jobs. Unlike set_feature_flag(), they neither re-check an ACC-10 role nor write an audit event:
-- they act for no person, only for the worker's own roles (the only ones that may run them), and
-- decide only whether work already admitted may still commit. They change no flag and nobody's
-- data (job_finish ends the job and its run, the queue's own bookkeeping), and every flag change
-- they compare against is checked and audited in set_feature_flag().

-- Refuses unless a feature is on for the org the server set, exactly as the server checked it: the
-- flag and every flag above it enabled, and each still at the revision the server saw (seen, in
-- order from the top: ai, ai.agents, ai.agents.<id>). Cohorts are the server's to evaluate (T17),
-- and every change to a flag (on, off, a cohort, a lock) bumps its revision, so a feature narrowed
-- to exclude someone refuses here too. The flags are read FOR SHARE, so a change in progress makes
-- this wait and then refuse, and one that starts later waits for this transaction. In the
-- transaction that makes a feature's effect visible, nothing it writes can commit after the flag
-- was changed (PRD-65: "zero posts afterwards"). The messages can be shown as they are; the code is
-- Hearth's own (HF001), so the server can tell a changed flag from a failure, and it reloads the
-- flags to see whether the feature is off or only changed.
create function public.feature_fence(feature text, seen bigint[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  off text;
  revisions bigint[];
begin
  if org is null then
    raise exception 'No org is set for this transaction' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.feature_flags f
  where f.org_id = org and (f.key = feature or pg_catalog.starts_with(feature, f.key || '.'))
  order by f.key
  for share;
  if not exists (select 1 from public.feature_flags f where f.org_id = org and f.key = feature) then
    raise exception 'There is no feature flag %.', feature using errcode = 'HF001';
  end if;
  select f.key into off from public.feature_flags f
  where f.org_id = org and (f.key = feature or pg_catalog.starts_with(feature, f.key || '.')) and not f.enabled
  order by pg_catalog.length(f.key) limit 1;
  if off is not null then
    raise exception 'That feature is switched off (%).', off using errcode = 'HF001';
  end if;
  select pg_catalog.array_agg(f.revision order by pg_catalog.length(f.key)) into revisions
  from public.feature_flags f
  where f.org_id = org and (f.key = feature or pg_catalog.starts_with(feature, f.key || '.'));
  if seen is null or revisions is distinct from seen then
    raise exception 'That feature''s flags have changed since this work checked them.' using errcode = 'HF001';
  end if;
end
$$;
revoke execute on function public.feature_fence(text, bigint[]) from public;

-- The fence for one job's effect (T15): its feature still on as the worker saw it (feature_fence,
-- the flags first, as a flag change takes them) and the job still this worker's: running, under the
-- lease token the worker holds. The job row is then locked until the transaction ends, so the lease
-- sweeper passes it by and a late give-back waits. In every transaction a job commits an effect in;
-- HF002 says the lease has gone to another worker or the sweeper.
create function public.job_fence(job uuid, lease uuid, seen bigint[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  feature text;
begin
  if org is null then
    raise exception 'No org is set for this transaction' using errcode = 'insufficient_privilege';
  end if;
  select j.feature_key into feature from public.jobs j where j.org_id = org and j.id = job;
  if feature is null then
    raise exception 'That job is no longer this worker''s to finish.' using errcode = 'HF002';
  end if;
  perform public.feature_fence(feature, seen);
  perform 1 from public.jobs j
  where j.org_id = org and j.id = job and j.lease_token = lease and j.state = 'running'
  for no key update;
  if not found then
    raise exception 'That job is no longer this worker''s to finish.' using errcode = 'HF002';
  end if;
end
$$;
revoke execute on function public.job_fence(uuid, uuid, bigint[]) from public;

-- Fences the job and marks it succeeded, with its schedule run if it has one, in the transaction of
-- its last effect, so the effect and the job's end commit together: a retry after a crash finds it
-- finished, and a job whose lease or flag has gone commits nothing (T15).
create function public.job_finish(job uuid, lease uuid, seen bigint[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  run uuid;
begin
  perform public.job_fence(job, lease, seen);
  update public.jobs set state = 'succeeded', finished_at = pg_catalog.now(), lease_token = null,
    lease_expires_at = null, reason = null
  where org_id = org and id = job
  returning schedule_run_id into run;
  if run is not null then
    update public.schedule_runs set state = 'succeeded', finished_at = pg_catalog.now()
    where org_id = org and id = run and state = 'running';
  end if;
end
$$;
revoke execute on function public.job_finish(uuid, uuid, bigint[]) from public;

-- Changes a flag (T17) for the person the server set as app.user_id, who must still be at the org
-- and hold Owner or Admin (packages/access decided first, flag.set; this re-checks in tables). The
-- person and their roles are read FOR SHARE, so a deactivation or role revocation in progress
-- makes this wait and then refuse. A locked flag is refused before its row is locked: only a
-- migration changes a lock. The flag's row is then taken FOR NO KEY UPDATE, which waits for the
-- fences that hold it FOR SHARE but not for the jobs being queued for it (their foreign keys hold
-- it FOR KEY SHARE), so a busy feature can still be switched off. A cohort names people of this
-- org and org-wide roles. It is kept sorted and without repeats, so the same cohort sent in
-- another order changes nothing. Returns the new revision (the same one when nothing changed, and
-- then nothing is written). Writes the audit event (ADM-06), naming who joined and left the
-- cohort; the server appends the outbox event (flag.changed) in the same transaction and, after
-- the commit, tells every process on Valkey. The messages can be shown as they are. Hearth's own
-- codes let the server tell a locked flag (HF003) and a cohort naming someone outside this org
-- (HF004) from a refused person (42501) and an unknown flag (22023).
create function public.set_feature_flag(
  flag_key text,
  to_enabled boolean,
  to_audience text,
  people uuid[],
  roles text[],
  request_id text,
  device_id uuid,
  ip inet
) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  flag public.feature_flags%rowtype;
  new_revision bigint;
begin
  if org is null or actor is null then
    raise exception 'No org or user is set for this transaction' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.people p where p.org_id = org and p.id = actor and p.deactivated_at is null for share;
  if not found then
    raise exception 'Only an Owner or Admin can change a feature flag.' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.role_assignments r
  where r.org_id = org and r.person_id = actor and r.revoked_at is null and r.role in ('owner', 'admin')
  for share;
  if not found then
    raise exception 'Only an Owner or Admin can change a feature flag.' using errcode = 'insufficient_privilege';
  end if;
  select * into flag from public.feature_flags f where f.org_id = org and f.key = flag_key;
  if not found then
    raise exception 'There is no feature flag %.', flag_key using errcode = 'invalid_parameter_value';
  end if;
  if flag.locked then
    raise exception 'The flag % is locked: only a release changes it.', flag_key using errcode = 'HF003';
  end if;
  select * into flag from public.feature_flags f where f.org_id = org and f.id = flag.id for no key update;
  people := array(select distinct x from pg_catalog.unnest(coalesce(people, '{}')) x order by x);
  roles := array(select distinct x from pg_catalog.unnest(coalesce(roles, '{}')) x order by x);
  if exists (select 1 from pg_catalog.unnest(people) x where not exists (
               select 1 from public.people p where p.org_id = org and p.id = x)) then
    raise exception 'A cohort can only name people of this organisation.' using errcode = 'HF004';
  end if;
  if flag.enabled = to_enabled and flag.audience = to_audience and flag.cohort_people = people
     and flag.cohort_roles = roles then
    return flag.revision;
  end if;
  update public.feature_flags f
  set enabled = to_enabled, audience = to_audience, cohort_people = people, cohort_roles = roles,
      revision = f.revision + 1, updated_at = pg_catalog.now(), updated_by = actor
  where f.org_id = org and f.id = flag.id
  returning f.revision into new_revision;
  insert into public.audit_events (org_id, actor_id, action, target_type, target_id, request_id, device_id, ip, details)
  values (org, actor, 'flag.set', 'feature_flag', flag_key, request_id, device_id, ip, pg_catalog.jsonb_build_object(
    'enabled', to_enabled, 'was_enabled', flag.enabled, 'audience', to_audience, 'revision', new_revision,
    'people_added', array(select pg_catalog.unnest(people) except select pg_catalog.unnest(flag.cohort_people)),
    'people_removed', array(select pg_catalog.unnest(flag.cohort_people) except select pg_catalog.unnest(people)),
    'roles_added', array(select pg_catalog.unnest(roles) except select pg_catalog.unnest(flag.cohort_roles)),
    'roles_removed', array(select pg_catalog.unnest(flag.cohort_roles) except select pg_catalog.unnest(roles))));
  return new_revision;
end
$$;
revoke execute on function public.set_feature_flag(text, boolean, text, uuid[], text[], text, uuid, inet) from public;

-- The clean-up (T15, T16): the only way rows leave the outbox and the queue. Each call deletes at
-- most one batch, oldest first, in the org the server set, and writes one audit event for it
-- (ADM-06; never one per row), with Hearth's system principal as the actor. The ages are fixed
-- here, so no bug in the worker can delete a row early; changing one is a migration (C0.10 makes
-- them retention classes).

-- Outbox events go after 14 days. The batch takes every event at or below the edge: the furthest
-- position (tx_id, id) of an event older than 14 days whose transaction has ended. Deleting by
-- position, lowest first, keeps the floor exact: everything at or below it is gone and nothing can
-- appear there again, so a consumer at or above the floor has missed nothing. An event whose
-- transaction took its id early can go up to that transaction's length (at most 30 seconds, the
-- transaction timeout) before its 14 days are up. The floor is written in the same transaction as
-- the deletion it records.
create function public.purge_outbox(batch integer) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  edge_tx xid8;
  edge_id bigint;
  deleted integer;
  top_tx xid8;
  top_id bigint;
begin
  if org is null or actor is null then
    raise exception 'No org or user is set for this transaction' using errcode = 'insufficient_privilege';
  end if;
  if batch is null or batch not between 1 and 10000 then
    raise exception 'A clean-up batch is 1 to 10,000 rows.' using errcode = 'invalid_parameter_value';
  end if;
  select e.tx_id, e.id into edge_tx, edge_id
  from public.outbox_events e
  where e.org_id = org and e.at < pg_catalog.now() - interval '14 days'
    and e.tx_id < pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot())
  order by e.tx_id desc, e.id desc
  limit 1;
  if edge_tx is null then
    return 0;
  end if;
  with doomed as (
    select e.id from public.outbox_events e
    where e.org_id = org and (e.tx_id, e.id) <= (edge_tx, edge_id)
    order by e.tx_id, e.id
    limit batch
  ), gone as (
    delete from public.outbox_events e using doomed d
    where e.org_id = org and e.id = d.id
    returning e.tx_id, e.id
  )
  select pg_catalog.count(*), (pg_catalog.array_agg(g.tx_id order by g.tx_id desc, g.id desc))[1],
         (pg_catalog.array_agg(g.id order by g.tx_id desc, g.id desc))[1]
  into deleted, top_tx, top_id
  from gone g;
  if deleted = 0 then
    return 0;
  end if;
  insert into public.outbox_floors as f (org_id, last_tx, last_id) values (org, top_tx, top_id)
  on conflict (org_id) do update set last_tx = excluded.last_tx, last_id = excluded.last_id, purged_at = pg_catalog.now()
  where (f.last_tx, f.last_id) < (excluded.last_tx, excluded.last_id);
  insert into public.audit_events (org_id, actor_id, action, target_type, target_id, details)
  values (org, actor, 'maintenance.purge', 'outbox_events', org::text, pg_catalog.jsonb_build_object(
    'rows', deleted, 'floor_tx', top_tx::text, 'floor_id', top_id));
  return deleted;
end
$$;
revoke execute on function public.purge_outbox(integer) from public;

-- Finished jobs: succeeded and cancelled ones 14 days after they finished, dead ones after 30.
create function public.purge_jobs(batch integer) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  deleted integer;
begin
  if org is null or actor is null then
    raise exception 'No org or user is set for this transaction' using errcode = 'insufficient_privilege';
  end if;
  if batch is null or batch not between 1 and 10000 then
    raise exception 'A clean-up batch is 1 to 10,000 rows.' using errcode = 'invalid_parameter_value';
  end if;
  with doomed as (
    select j.id from public.jobs j
    where j.org_id = org and j.finished_at is not null
      and ((j.state in ('succeeded', 'cancelled') and j.finished_at < pg_catalog.now() - interval '14 days')
           or (j.state = 'dead' and j.finished_at < pg_catalog.now() - interval '30 days'))
    order by j.finished_at
    limit batch
  ), gone as (
    delete from public.jobs j using doomed d where j.org_id = org and j.id = d.id returning 1
  )
  select pg_catalog.count(*) into deleted from gone;
  if deleted > 0 then
    insert into public.audit_events (org_id, actor_id, action, target_type, target_id, details)
    values (org, actor, 'maintenance.purge', 'jobs', org::text, pg_catalog.jsonb_build_object('rows', deleted));
  end if;
  return deleted;
end
$$;
revoke execute on function public.purge_jobs(integer) from public;

-- Schedule runs 90 days after they finished, or after a person decided on them; never one still
-- waiting for review, nor a resumed run whose next attempt hasn't been made yet.
create function public.purge_schedule_runs(batch integer) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  deleted integer;
begin
  if org is null or actor is null then
    raise exception 'No org or user is set for this transaction' using errcode = 'insufficient_privilege';
  end if;
  if batch is null or batch not between 1 and 10000 then
    raise exception 'A clean-up batch is 1 to 10,000 rows.' using errcode = 'invalid_parameter_value';
  end if;
  with doomed as (
    select r.id from public.schedule_runs r
    where r.org_id = org and r.finished_at < pg_catalog.now() - interval '90 days'
      and (r.state in ('succeeded', 'failed', 'skipped')
           or (r.state = 'dismissed' and r.reviewed_at < pg_catalog.now() - interval '90 days')
           or (r.state = 'resumed' and r.reviewed_at < pg_catalog.now() - interval '90 days'
               and exists (select 1 from public.schedule_runs n where n.org_id = org and n.resumed_from = r.id)))
    order by r.finished_at
    limit batch
  ), gone as (
    delete from public.schedule_runs r using doomed d where r.org_id = org and r.id = d.id returning 1
  )
  select pg_catalog.count(*) into deleted from gone;
  if deleted > 0 then
    insert into public.audit_events (org_id, actor_id, action, target_type, target_id, details)
    values (org, actor, 'maintenance.purge', 'schedule_runs', org::text, pg_catalog.jsonb_build_object('rows', deleted));
  end if;
  return deleted;
end
$$;
revoke execute on function public.purge_schedule_runs(integer) from public;

-- What each role may do (CLAUDE.md, Database: only the grants each needs; never ALL, TRUNCATE,
-- TRIGGER or REFERENCES).
--
-- hearth_app (the api and realtime roles): read flags (every process keeps them, T17), append
-- outbox events in the transaction that makes the change, choosing none of the columns the
-- database owns (id, tx_id, at), and change a flag through set_feature_flag(). It queues no jobs
-- and runs no fence yet: the step that first gives the api a producer or a feature effect adds
-- those grants with their caller (T15).
grant select on public.feature_flags to hearth_app;
grant insert (org_id, type, version, entity_type, entity_id, container_type, container_id, acl_tokens, acl_more,
              index_class, acl_epoch, actor_id, actor_kind, subject_ids, purpose, tombstone, ids)
  on public.outbox_events to hearth_app;
grant execute on function public.is_ids_only(jsonb) to hearth_app;
grant execute on function public.set_feature_flag(text, boolean, text, uuid[], text[], text, uuid, inet) to hearth_app;

-- Every job role reads its org's system principal (withOrg acts as it). The roles jobs run as fence
-- and finish them (JobContext's commit); the one a consumer runs as also fences its rounds.
do $$
declare
  job text;
begin
  foreach job in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge'] loop
    execute format('grant select (id, org_id, kind, system_key) on public.principals to %I', job);
  end loop;
  foreach job in array array['hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge'] loop
    execute format('grant execute on function public.job_fence(uuid, uuid, bigint[]), public.job_finish(uuid, uuid, bigint[]) to %I', job);
  end loop;
end
$$;
grant execute on function public.feature_fence(text, bigint[]) to hearth_job_offboarding;

-- hearth_queue, the runner and the scheduler: lists orgs; claims, renews, retries, cancels and ends
-- jobs; fires schedules and records their runs; reads flags (a job whose feature is off is never
-- claimed) and the facts a cohort is checked against (whether the job's person is still at the org,
-- and their current roles); reads the outbox's positions and times (never its envelope), the
-- checkpoints and the floors, for the lag metric and the restore check. A run's next attempt after
-- a person resumes it (attempt, resumed_from) comes with review_schedule_run() (A4 or A5.4).
grant execute on function public.worker_org_ids() to hearth_queue;
grant execute on function public.is_ids_only(jsonb) to hearth_queue;
grant select on public.feature_flags to hearth_queue;
grant select (id, org_id, deactivated_at) on public.people to hearth_queue;
grant select (org_id, person_id, role, revoked_at) on public.role_assignments to hearth_queue;
grant select on public.jobs to hearth_queue;
grant insert (id, org_id, kind, feature_key, purpose, subject_id, payload, idempotency_key, max_attempts, run_after,
              schedule_run_id)
  on public.jobs to hearth_queue;
grant update (state, attempts, give_backs, run_after, lease_token, lease_expires_at, claimed_by, reason, started_at,
              finished_at)
  on public.jobs to hearth_queue;
grant select on public.schedules to hearth_queue;
grant insert (org_id, key, kind, cron, on_interrupt, payload, next_run_at) on public.schedules to hearth_queue;
grant update (next_run_at, last_fired_at, retired_at) on public.schedules to hearth_queue;
grant select on public.schedule_runs to hearth_queue;
grant insert (id, org_id, schedule_id, scheduled_for, on_interrupt, state, reason, finished_at)
  on public.schedule_runs to hearth_queue;
grant update (state, reason, started_at, finished_at) on public.schedule_runs to hearth_queue;
grant select (org_id, id, tx_id, at) on public.outbox_events to hearth_queue;
grant select on public.outbox_checkpoints, public.outbox_floors to hearth_queue;

-- hearth_job_offboarding: the offboarding consumer reads the outbox, starts and moves its own
-- checkpoint and queues one job per handler; it and the jobs re-read that the person has left, and
-- who deactivated them, rather than trust the event (T16); the sockets handler reads which sessions
-- a deactivation ended.
grant select on public.outbox_events to hearth_job_offboarding;
grant select, insert (org_id, consumer, role_name, last_tx, last_id) on public.outbox_checkpoints to hearth_job_offboarding;
grant update (last_tx, last_id, processed, updated_at) on public.outbox_checkpoints to hearth_job_offboarding;
grant select on public.outbox_floors to hearth_job_offboarding;
grant execute on function public.is_ids_only(jsonb) to hearth_job_offboarding;
grant insert (id, org_id, kind, feature_key, purpose, subject_id, payload, idempotency_key, max_attempts, run_after)
  on public.jobs to hearth_job_offboarding;
grant select (id, org_id, deactivated_at, deactivated_by) on public.people to hearth_job_offboarding;
grant select (id, org_id, user_id, revoke_reason) on public.sessions to hearth_job_offboarding;

-- hearth_job_partitions: keeps data_access_events' month partitions a year ahead (0005).
grant execute on function public.create_data_access_partitions(integer) to hearth_job_partitions;

-- hearth_job_purge: the clean-up, through the three functions above and nothing else.
grant execute on function public.purge_outbox(integer), public.purge_jobs(integer), public.purge_schedule_runs(integer)
  to hearth_job_purge;
