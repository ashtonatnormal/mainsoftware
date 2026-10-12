-- C0.3: the runtime role, orgs and principals (ACC-11, D1; BUILD-PLAN Part 1D seams).
--
-- Every table in Hearth carries org_id and has row level security keyed on the org the server
-- set for the transaction (CLAUDE.md, Database):
--   org_id = nullif(current_setting('app.org_id', true), '')::uuid
-- so a transaction with no org set sees and writes nothing. Policies apply to every role RLS
-- applies to; table grants decide which role may do what. hearth_owner owns everything and
-- bypasses RLS, so SECURITY DEFINER functions filter by org themselves.
--
-- Foreign keys between org-scoped tables include org_id, so a row can only point at a row in its
-- own org: each parent has unique (org_id, id) for them to reference.

-- The database belongs to hearth_owner (scripts/check-migrations.sh and scripts/db-local.sh create
-- it so; infra/ does on RDS), so every object the migrations make is the owner's and nothing else
-- owns its public schema. Nobody but the owner gets temporary tables: a temporary table or type
-- would be found before the real one by an unqualified name, so a runtime role could plant one on
-- a pooled connection for a later request to read.
do $$
begin
  if pg_catalog.pg_get_userbyid((select datdba from pg_catalog.pg_database where datname = pg_catalog.current_database()))
     <> 'hearth_owner' then
    raise exception 'hearth_owner must own the database the migrations run in (create database ... owner hearth_owner)';
  end if;
  execute pg_catalog.format('revoke temporary on database %I from public', pg_catalog.current_database());
end
$$;

-- The runtime role (CLAUDE.md, Database): no superuser, no BYPASSRLS, owns nothing, and a member
-- of no role, so it can't inherit an owner's way round RLS. Roles belong to the whole server, so
-- when it already exists (another database on the server, or infra/'s bootstrap on RDS) this
-- checks it instead of skipping silently. Its login (a password locally, IAM on RDS) is set
-- outside git: scripts/db-local.sh locally, infra/ in AWS. On RDS it may be a member of rds_iam,
-- which IAM sign-in needs, as long as rds_iam itself has no powers and belongs to no role.
do $$
declare
  app pg_roles%rowtype;
  extra text;
begin
  select * into app from pg_roles where rolname = 'hearth_app';
  if not found then
    create role hearth_app nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    return;
  end if;
  if app.rolsuper or app.rolbypassrls or app.rolcreaterole or app.rolcreatedb or app.rolreplication then
    raise exception 'hearth_app already exists with a power it must not have (superuser, bypassrls, createrole, createdb or replication)';
  end if;
  select string_agg(g.rolname, ', ') into extra
  from pg_auth_members m join pg_roles g on g.oid = m.roleid
  where m.member = app.oid
    and not (g.rolname = 'rds_iam' and not g.rolsuper and not g.rolbypassrls
             and not exists (select 1 from pg_auth_members r where r.member = g.oid));
  if extra is not null then
    raise exception 'hearth_app already exists and is a member of %; it must be a member of no role', extra;
  end if;
end
$$;

-- Postgres lets everyone execute a new function unless told otherwise. From here on, functions
-- hearth_owner creates in this database start with no grants; each migration still revokes
-- execute from public on its own functions, which scripts/check-migrations.sh checks.
alter default privileges for role hearth_owner revoke execute on functions from public;

-- Whether a name is a time zone of the form times are stored with (PRD-61): UTC, an Etc/GMT
-- offset zone, or a name with a slash that Postgres's time zone database knows, such as
-- Asia/Singapore (aliases such as US/Eastern included). Not an abbreviation (SGT), a bare offset
-- (+08), a slashless alias (Singapore), or a POSIX rule that looks like a zone
-- (Asia/Singapore+1, which Postgres reads as UTC-1 and browsers reject). It runs in CHECK
-- constraints, so it's cheap (pg_timezone_names reads the zone files on every call, about 50 ms),
-- and every role that writes those tables needs EXECUTE on it.
create function public.is_iana_time_zone(zone text) returns boolean
language sql stable set search_path = '' as $$
  select zone ~ '^(UTC|Etc/GMT[+-]([0-9]|1[0-4])|[A-Z][A-Za-z]+(/[A-Za-z][A-Za-z_]*(-[A-Za-z][A-Za-z_]*)*)+)$'
     and pg_catalog.pg_input_is_valid('2000-01-01 00:00:00 ' || zone, 'pg_catalog.timestamptz')
$$;
revoke execute on function public.is_iana_time_zone(text) from public;
grant execute on function public.is_iana_time_zone(text) to hearth_app;

-- Once a row records that something ended (deactivated, removed, revoked, signed out, archived),
-- when, by whom and why stay as recorded: those columns can be set once and never changed or
-- cleared (CLAUDE.md: record who did what and when). The trigger's arguments name the columns.
-- Undoing an end, if a feature ever needs it, is a new row or a checked SECURITY DEFINER function
-- that logs it, not an edit.
create function public.keep_history() returns trigger
language plpgsql set search_path = '' as $$
declare
  col text;
  was jsonb := pg_catalog.to_jsonb(old);
  now_is jsonb := pg_catalog.to_jsonb(new);
begin
  foreach col in array tg_argv loop
    if was ->> col is not null and (now_is ->> col) is distinct from (was ->> col) then
      raise exception 'That has already ended, and when, by whom and why can''t be changed.'
        using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end
$$;
revoke execute on function public.keep_history() from public;

-- The tenant (ACC-11). v1 runs one org (D1), but every record belongs to one. Its own id is the
-- org_id everything else carries. Its time zone is the default for anything without its own
-- (a new sheet, SHEET-15; dates shown to the whole org).
create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name = btrim(name) and length(name) between 1 and 200),
  time_zone text not null default 'Asia/Singapore' check (public.is_iana_time_zone(time_zone)),
  created_at timestamptz not null default now()
);
alter table public.orgs enable row level security;
create policy org_isolation on public.orgs
  using (id = nullif(current_setting('app.org_id', true), '')::uuid);
grant select on public.orgs to hearth_app;

-- Everyone and everything that can act or author: a person (human), an agent (A5), a person's
-- private assistant (A4), or Hearth itself (system). Content, audit and access records point at
-- a principal, so agents and Hearth can author later without a migration (BUILD-PLAN Part 1D).
-- A human principal's id is also the person's id (people.id) and their account's id (users.id).
--
-- Kind rules:
--   system:    has a system_key naming it (e.g. 'hearth'), unique in the org.
--   assistant: has an owner, the human principal it serves (PA-01: one per person, private).
--   human, agent: neither. Agents get their own table in A5.
create table public.principals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  kind text not null check (kind in ('human', 'agent', 'assistant', 'system')),
  system_key text check (system_key ~ '^[a-z][a-z0-9_]{0,62}$'),
  owner_id uuid,
  -- Always 'human', so the foreign key below can only point at a human principal.
  owner_kind text not null default 'human' check (owner_kind = 'human'),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid,
  unique (org_id, id),
  unique (org_id, id, kind),
  check ((archived_at is null) = (archived_by is null)),
  constraint principals_system_key check ((kind = 'system') = (system_key is not null)),
  constraint principals_assistant_owner check ((kind = 'assistant') = (owner_id is not null)),
  foreign key (org_id, owner_id, owner_kind) references public.principals (org_id, id, kind),
  foreign key (org_id, archived_by) references public.principals (org_id, id)
);
create trigger principals_keep_history before update of archived_at, archived_by on public.principals
  for each row execute function public.keep_history('archived_at', 'archived_by');
create unique index principals_system_key_unique on public.principals (org_id, system_key)
  where system_key is not null;
create unique index principals_one_assistant_per_person on public.principals (org_id, owner_id)
  where kind = 'assistant' and archived_at is null;
alter table public.principals enable row level security;
create policy org_isolation on public.principals
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
-- The server adds people to the roster (ACC-03), so it creates human principals. Hearth's own
-- system principal comes with the org (the bootstrap script, or the seed locally), and assistants
-- and agents arrive with A4 and A5, which widen this and grant archiving. A person leaving is
-- recorded on people (deactivated_at), not here.
create policy server_creates_humans on public.principals as restrictive for insert
  with check (kind = 'human');
grant select, insert on public.principals to hearth_app;
