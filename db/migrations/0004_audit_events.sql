-- C0.3: the audit log (ADM-06, T12; INF-AUDIT).
--
-- One append-only table, written in the same transaction as the change it records. hearth_app
-- may only add rows: no SELECT (so no INSERT ... RETURNING), UPDATE, DELETE or TRUNCATE. Reads go
-- through read_audit_events(), which checks the reader's roles against the ones the org lets read
-- the log (audit_log_readers) and logs the read.
-- C0.16 adds the hash chain and the Object Lock export; the retention engine keeps rows at least
-- 12 months (ADM-06, PDPA-09).
create table public.audit_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id),
  at timestamptz not null default now(),
  -- Who acted: a person, an agent, an assistant or Hearth itself. Empty only when nobody could
  -- be identified, such as a sign-in attempt for a number that isn't on the roster.
  actor_id uuid,
  -- For an assistant or agent, the person it acted for, and the feature it acted through (e.g.
  -- 'assistant', 'agent'). Unused until A4 and A5.
  on_behalf_of_id uuid,
  via text check (via ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  -- What happened, as a dotted code such as 'auth.sign_in' or 'role.granted'.
  action text not null check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and length(action) <= 100),
  -- What it happened to: a kind such as 'person' or 'session', and its id.
  target_type text check (target_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  target_id text check (length(target_id) between 1 and 200),
  -- The reason the actor gave, which privileged access always has (Rule 9).
  reason text check (length(reason) between 1 and 2000),
  -- The logged case a privileged read belongs to (Rule 9, C1.11). Its table comes with the Rule 9
  -- module and has no hearth_app grants, so this is a plain id.
  case_id uuid,
  -- The request that made the change, to tie the entry to the server's logs, and where it came
  -- from: the device (devices.id, kept as a plain id so the retention engine can delete devices
  -- the log outlives) and the client's IP address.
  request_id text check (length(request_id) between 1 and 200),
  device_id uuid,
  ip inet,
  -- Anything else worth keeping, never message or file content.
  details jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  check ((target_type is null) = (target_id is null)),
  check (on_behalf_of_id is null or actor_id is not null),
  -- Privileged access (Rule 9; actions named privileged.*) always names its case and reason.
  constraint audit_events_privileged_has_case check (action !~ '^privileged\.' or (case_id is not null and reason is not null)),
  foreign key (org_id, actor_id) references public.principals (org_id, id),
  foreign key (org_id, on_behalf_of_id) references public.principals (org_id, id)
);
create index audit_events_org_at on public.audit_events (org_id, at);
create index audit_events_actor on public.audit_events (org_id, actor_id, at);
create index audit_events_target on public.audit_events (org_id, target_type, target_id);

alter table public.audit_events enable row level security;
create policy org_isolation on public.audit_events for insert
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
-- Not id or at: entries take the sequence's next id and the time of the write, so none can be
-- backdated or slotted in among earlier ones.
grant insert (org_id, actor_id, on_behalf_of_id, via, action, target_type, target_id, reason, case_id, request_id, device_id, ip, details)
  on public.audit_events to hearth_app;

-- Which roles may read the org's audit log (ADM-06, ACC-10). It's a setting, not code: none at
-- first, and the admin console (C0.16) adds and removes roles through a checked function that
-- writes the audit event, so hearth_app may read the list but not change it. Team Admin can't be
-- one: the log covers the whole org, and that role covers one team. A role taken off the list is
-- removed with who and when, not deleted, and adding it back is a new row.
create table public.audit_log_readers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  role text not null check (role in ('owner', 'admin', 'ai_admin', 'leadership', 'dpo', 'compliance_officer')),
  created_at timestamptz not null default now(),
  created_by uuid not null,
  removed_at timestamptz,
  removed_by uuid,
  unique (org_id, id),
  check ((removed_at is null) = (removed_by is null)),
  foreign key (org_id, created_by) references public.principals (org_id, id),
  foreign key (org_id, removed_by) references public.principals (org_id, id)
);
create unique index audit_log_readers_current on public.audit_log_readers (org_id, role) where removed_at is null;
create trigger audit_log_readers_keep_history before update of removed_at, removed_by on public.audit_log_readers
  for each row execute function public.keep_history('removed_at', 'removed_by');
alter table public.audit_log_readers enable row level security;
create policy org_isolation on public.audit_log_readers
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant select on public.audit_log_readers to hearth_app;

-- Reads the org's audit log, newest first, for the person the server set as app.user_id, who
-- must be at the org (not deactivated) and hold a role on the org's audit_log_readers list. It
-- reads the org and the person from the settings the server's transaction helper set from the
-- session (CLAUDE.md, Database), never from its arguments, and every read is itself logged. Page
-- with before_id: pass the smallest id of the previous page.
create function public.read_audit_events(
  from_at timestamptz,
  to_at timestamptz,
  before_id bigint default null,
  max_rows integer default 100
) returns setof public.audit_events
language plpgsql security definer set search_path = '' as $$
declare
  org uuid := nullif(current_setting('app.org_id', true), '')::uuid;
  reader uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
  if org is null or reader is null then
    raise exception 'No org or user is set for this transaction' using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1
    from public.role_assignments r
    join public.people p on p.org_id = r.org_id and p.id = r.person_id
    join public.audit_log_readers a on a.org_id = r.org_id and a.role = r.role and a.removed_at is null
    where r.org_id = org and r.person_id = reader and r.revoked_at is null and p.deactivated_at is null
  ) then
    raise exception 'None of your roles can read the audit log. The roles that can are chosen in the admin console.'
      using errcode = 'insufficient_privilege';
  end if;
  if from_at is null or to_at is null or from_at >= to_at then
    raise exception 'The period to read must start before it ends.' using errcode = 'invalid_parameter_value';
  end if;
  if max_rows is null or max_rows not between 1 and 1000 then
    raise exception 'Read between 1 and 1000 entries at a time.' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.audit_events (org_id, actor_id, action, details)
  values (org, reader, 'audit.read', pg_catalog.jsonb_build_object(
    'from', from_at, 'to', to_at, 'before_id', before_id, 'max_rows', max_rows));

  return query
    select a.* from public.audit_events a
    where a.org_id = org and a.at >= from_at and a.at < to_at and (before_id is null or a.id < before_id)
    order by a.id desc
    limit max_rows;
end
$$;
revoke execute on function public.read_audit_events(timestamptz, timestamptz, bigint, integer) from public;
grant execute on function public.read_audit_events(timestamptz, timestamptz, bigint, integer) to hearth_app;
