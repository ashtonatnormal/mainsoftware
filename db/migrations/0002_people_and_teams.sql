-- C0.3: the roster, org structure, roles and profiles (ACC-03, ACC-07, ACC-08, ACC-10).
--
-- people are roster entries: an admin adds a phone number and a name, and only those numbers can
-- sign in (ACC-03). A person's id is their human principal's id. users holds the account a person
-- gets at first sign-in (C0.5 adds its credentials). Rows that carry history are archived,
-- deactivated or removed, never deleted, and record who did it and when (CLAUDE.md, Database).
-- Every *_by column names the principal that acted.

-- Departments (ACC-07). Flat for now: nothing in the PRD nests them.
create table public.departments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  name text not null check (name = btrim(name) and length(name) between 1 and 100),
  created_at timestamptz not null default now(),
  created_by uuid not null,
  archived_at timestamptz,
  archived_by uuid,
  unique (org_id, id),
  check ((archived_at is null) = (archived_by is null)),
  foreign key (org_id, created_by) references public.principals (org_id, id),
  foreign key (org_id, archived_by) references public.principals (org_id, id)
);
create unique index departments_name_unique on public.departments (org_id, lower(name))
  where archived_at is null;

-- Teams (ACC-07). A person can be in several. Team defaults (the channels and rooms a new member
-- joins) arrive with channels and rooms (C1.10); the admin console stores none until then (C0.16).
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  name text not null check (name = btrim(name) and length(name) between 1 and 100),
  created_at timestamptz not null default now(),
  created_by uuid not null,
  archived_at timestamptz,
  archived_by uuid,
  unique (org_id, id),
  check ((archived_at is null) = (archived_by is null)),
  foreign key (org_id, created_by) references public.principals (org_id, id),
  foreign key (org_id, archived_by) references public.principals (org_id, id)
);
create unique index teams_name_unique on public.teams (org_id, lower(name)) where archived_at is null;

-- The roster (ACC-03): the people an admin added, with what the CSV import carries (name,
-- department, manager; phone numbers, teams and roles have their own tables). Deactivating
-- someone (ACC-05) keeps the row and their content.
create table public.people (
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  -- Always 'human', so the foreign key below makes a person's id a human principal's id.
  principal_kind text not null default 'human' check (principal_kind = 'human'),
  full_name text not null check (full_name = btrim(full_name) and length(full_name) between 1 and 200),
  department_id uuid,
  manager_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  deactivated_at timestamptz,
  deactivated_by uuid,
  unique (org_id, id),
  check ((deactivated_at is null) = (deactivated_by is null)),
  foreign key (org_id, id, principal_kind) references public.principals (org_id, id, kind),
  foreign key (org_id, department_id) references public.departments (org_id, id),
  foreign key (org_id, manager_id) references public.people (org_id, id),
  foreign key (org_id, created_by) references public.principals (org_id, id),
  foreign key (org_id, deactivated_by) references public.principals (org_id, id)
);
create index people_manager on public.people (org_id, manager_id);
create index people_department on public.people (org_id, department_id);

-- Reporting lines form a tree: nobody manages themselves, directly or through others, and a new
-- manager must still be at the org. Two changes made at once could each look fine alone and
-- together make a loop, so each takes the org's reporting-line lock first; under READ COMMITTED
-- the loop check then sees whatever the other committed (CLAUDE.md: tree changes run under READ
-- COMMITTED, so this refuses any other isolation level). The messages can be shown as they are.
create function public.people_check_manager() returns trigger
language plpgsql set search_path = '' as $$
declare
  loops boolean;
begin
  if new.manager_id is null or (tg_op = 'UPDATE' and new.manager_id is not distinct from old.manager_id) then
    return new;
  end if;
  if new.manager_id = new.id then
    raise exception 'Nobody can be their own manager.' using errcode = 'check_violation';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Reporting lines change only under READ COMMITTED, so the loop check sees every committed change'
      using errcode = 'invalid_transaction_state';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('hearth.people.manager_id:' || new.org_id::text, 0));
  if exists (select 1 from public.people m
             where m.org_id = new.org_id and m.id = new.manager_id and m.deactivated_at is not null) then
    raise exception 'That manager has left the organisation. Choose someone who is still here.'
      using errcode = 'check_violation';
  end if;
  with recursive chain (id, depth) as (
    select new.manager_id, 1
    union all
    select p.manager_id, c.depth + 1
    from public.people p join chain c on p.org_id = new.org_id and p.id = c.id
    where p.manager_id is not null and c.depth < 10000
  )
  select exists (select 1 from chain where chain.id = new.id) into loops;
  if loops then
    raise exception 'That would make a loop in the reporting lines: this person already manages their new manager, directly or through others.'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function public.people_check_manager() from public;
create trigger people_check_manager before insert or update of manager_id on public.people
  for each row execute function public.people_check_manager();

-- Roster phone numbers (ACC-03, ACC-06). One current number per person, and a number belongs to
-- one current person in the org. A changed number is removed, not overwritten, so the history
-- stays (ACC-06 phone change, PDPA-05 sign-in records).
create table public.phone_numbers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  person_id uuid not null,
  -- E.164: a plus, a country code and up to 15 digits in all.
  e164 text not null check (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  created_at timestamptz not null default now(),
  created_by uuid not null,
  removed_at timestamptz,
  removed_by uuid,
  unique (org_id, id),
  check ((removed_at is null) = (removed_by is null)),
  foreign key (org_id, person_id) references public.people (org_id, id),
  foreign key (org_id, created_by) references public.principals (org_id, id),
  foreign key (org_id, removed_by) references public.principals (org_id, id)
);
create unique index phone_numbers_current_number on public.phone_numbers (org_id, e164) where removed_at is null;
create unique index phone_numbers_current_person on public.phone_numbers (org_id, person_id) where removed_at is null;

-- The account a person gets at first sign-in (ACC-01). Its id is the person's id. C0.5 adds the
-- PIN, passkeys and lockout state.
create table public.users (
  id uuid primary key,
  org_id uuid not null references public.orgs (id),
  created_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, id) references public.people (org_id, id)
);

-- Team membership (ACC-07): a person in several teams, with the history kept.
create table public.team_memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  team_id uuid not null,
  person_id uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  removed_at timestamptz,
  removed_by uuid,
  unique (org_id, id),
  check ((removed_at is null) = (removed_by is null)),
  foreign key (org_id, team_id) references public.teams (org_id, id),
  foreign key (org_id, person_id) references public.people (org_id, id),
  foreign key (org_id, created_by) references public.principals (org_id, id),
  foreign key (org_id, removed_by) references public.principals (org_id, id)
);
create unique index team_memberships_current on public.team_memberships (org_id, team_id, person_id)
  where removed_at is null;
create index team_memberships_person on public.team_memberships (org_id, person_id) where removed_at is null;

-- Nobody joins an archived team, and nobody who has left joins a team. The messages can be shown
-- as they are.
create function public.team_memberships_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.teams t
             where t.org_id = new.org_id and t.id = new.team_id and t.archived_at is not null) then
    raise exception 'That team is archived, so nobody can join it.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.people p
             where p.org_id = new.org_id and p.id = new.person_id and p.deactivated_at is not null) then
    raise exception 'That person has left the organisation, so they can''t join a team.' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function public.team_memberships_check() from public;
create trigger team_memberships_check before insert on public.team_memberships
  for each row execute function public.team_memberships_check();

-- Roles (ACC-10), several per person. Every active person on the roster is a Member, so Member
-- has no rows; these are the others. Team Admin is held for one team. AI Admin carries no AI
-- permissions until A0 (packages/access decides what each role may do, C0.4).
--
-- Roles are set only through ADM-02's role assignment and the roster import (ACC-03), plus the
-- Owner bootstrap (CLAUDE.md, Database), so hearth_app may read them but not write them: C0.16
-- adds the SECURITY DEFINER functions that re-check who may grant what (Owner-only roles, the
-- second approver for DPO and Compliance Officer, PRD-85) and write the audit event. Nobody
-- grants, approves or revokes their own role.
create table public.role_assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  person_id uuid not null,
  role text not null check (role in ('owner', 'admin', 'ai_admin', 'leadership', 'dpo', 'compliance_officer', 'team_admin')),
  team_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  -- The second approver DPO and Compliance Officer grants need (PRD-85); the bootstrap's first
  -- Owner and DPO (D35) has none.
  approved_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  unique (org_id, id),
  check ((role = 'team_admin') = (team_id is not null)),
  check ((revoked_at is null) = (revoked_by is null)),
  check (created_by <> person_id),
  check (approved_by <> person_id and approved_by <> created_by),
  check (revoked_by <> person_id),
  foreign key (org_id, person_id) references public.people (org_id, id),
  foreign key (org_id, team_id) references public.teams (org_id, id),
  foreign key (org_id, created_by) references public.principals (org_id, id),
  foreign key (org_id, approved_by) references public.principals (org_id, id),
  foreign key (org_id, revoked_by) references public.principals (org_id, id)
);
create unique index role_assignments_current on public.role_assignments (org_id, person_id, role, team_id)
  nulls not distinct where revoked_at is null;

-- What a person sets about themselves (ACC-08): the name they go by, their title, time zone and
-- status. Their full name, department, manager and teams come from the roster; the photo arrives
-- with C0.15. The time zone and working hours drive quiet hours (C0.14), replies owed (C1.9) and
-- due soon (C2.1), and the per-person part of CAL-06.
create table public.profiles (
  person_id uuid primary key,
  org_id uuid not null references public.orgs (id),
  display_name text check (display_name = btrim(display_name) and length(display_name) between 1 and 100),
  title text check (title = btrim(title) and length(title) between 1 and 200),
  time_zone text not null default 'Asia/Singapore' check (public.is_iana_time_zone(time_zone)),
  custom_status text check (custom_status = btrim(custom_status) and length(custom_status) between 1 and 100),
  custom_status_until timestamptz,
  updated_at timestamptz not null default now(),
  unique (org_id, person_id),
  check (custom_status_until is null or custom_status is not null),
  foreign key (org_id, person_id) references public.people (org_id, id)
);

-- Working hours (ACC-08): one or more spans a day, Monday (1) to Sunday (7), in the person's own
-- time zone. A span that ends at or before its start runs past midnight (a night shift).
create table public.working_hours (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  person_id uuid not null,
  weekday smallint not null check (weekday between 1 and 7),
  starts_at time not null,
  ends_at time not null,
  unique (org_id, id),
  unique (org_id, person_id, weekday, starts_at),
  check (starts_at <> ends_at),
  foreign key (org_id, person_id) references public.people (org_id, id)
);

-- Row level security: each table only within the org the server set (CLAUDE.md, Database).
do $$
declare
  t text;
begin
  foreach t in array array['departments', 'teams', 'people', 'phone_numbers', 'users', 'team_memberships',
                           'role_assignments', 'profiles', 'working_hours'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy org_isolation on public.%I
      using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  end loop;
end
$$;

-- What the server may do. No DELETE except on working hours, which are a setting replaced
-- wholesale; everything else is archived, deactivated or removed.
grant select, insert on public.departments, public.teams to hearth_app;
grant update (name, archived_at, archived_by) on public.departments, public.teams to hearth_app;
grant select, insert on public.people to hearth_app;
grant update (full_name, department_id, manager_id, deactivated_at, deactivated_by) on public.people to hearth_app;
grant select, insert on public.phone_numbers to hearth_app;
grant update (removed_at, removed_by) on public.phone_numbers to hearth_app;
grant select, insert on public.users to hearth_app;
grant select, insert on public.team_memberships to hearth_app;
grant update (removed_at, removed_by) on public.team_memberships to hearth_app;
grant select on public.role_assignments to hearth_app;
grant select, insert on public.profiles to hearth_app;
grant update (display_name, title, time_zone, custom_status, custom_status_until, updated_at) on public.profiles to hearth_app;
grant select, insert, delete on public.working_hours to hearth_app;
