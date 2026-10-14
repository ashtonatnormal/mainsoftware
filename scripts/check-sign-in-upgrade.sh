#!/usr/bin/env bash
# The upgrade check for 0006_sign_in (C0.5; CLAUDE.md, Testing and CI): 0006 applied on top of
# rows 0005 allows, as production would have them, instead of to an empty database.
#
# 0006 adds rules that check every existing row: a session lasts at most 90 days, and why one
# ended is one of four codes. No session exists before 0006 anywhere, but the upgrade mustn't
# depend on that. So this loads the Tembusu seed and sessions 0003 allowed (some meant to last
# longer than 90 days, some that ended for reasons outside 0006's codes), applies 0006 with
# production's migrator, and checks that:
# - every row is still there, and only an overlong session's end moved, to 90 days after it began;
# - an older reason is kept, so the rule on reasons stays NOT VALID, and new rows still meet both
#   rules;
# - no session made before 0006 counts as re-authenticated, and every account gets its new
#   columns' defaults;
# - the upgraded schema matches a fresh build (BASE_DB), apart from that one NOT VALID rule.
# The data is made up; none of it is anyone's.
#
# Usage, after a full scratch build (BASE_DB, default hearth_check):
#   scripts/check-migrations.sh
#   CHECK_DB=hearth_upgrade_check UP_TO=0006 scripts/check-migrations.sh
#   CHECK_DB=hearth_upgrade_check scripts/check-sign-in-upgrade.sh
# Same connection settings as check-migrations.sh; CHECK_DB is the database built up to 0006.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export PGHOST=${PGHOST:-127.0.0.1} PGPORT=${PGPORT:-5432} PGUSER=${PGUSER:-postgres} PGPASSWORD=${PGPASSWORD:-postgres}
db=${CHECK_DB:-hearth_check}
base=${BASE_DB:-hearth_check}
for name in "$db" "$base"; do
  [[ $name =~ ^[a-z_][a-z0-9_]{0,54}_check$ ]] ||
    { echo "CHECK_DB and BASE_DB must be lower-case names ending in _check, at most 61 characters, not '$name'" >&2; exit 2; }
done
[ "$db" != "$base" ] || { echo "CHECK_DB must be the database built up to 0006, not BASE_DB ($base)" >&2; exit 2; }
owner=hearth_owner
migrator=${db}_m
sql() { psql --no-psqlrc -w -v ON_ERROR_STOP=1 -q "$@"; }

# It stops just before 0006, and the full build is complete.
before=$(sql -d "$db" -Atc "select count(*) filter (where name < '0006'), count(*) filter (where name >= '0006')
  from public.kysely_migration") ||
  { echo "No migrated database $db: build it with CHECK_DB=$db UP_TO=0006 scripts/check-migrations.sh" >&2; exit 2; }
[ "${before#*|}" = 0 ] && [ "${before%|*}" -gt 0 ] ||
  { echo "$db must be built up to (not including) 0006: CHECK_DB=$db UP_TO=0006 scripts/check-migrations.sh" >&2; exit 2; }
[ "$(sql -d "$base" -Atc "select count(*) from public.kysely_migration where name = '0006_sign_in'")" = 1 ] ||
  { echo "BASE_DB ($base) must be a full build: scripts/check-migrations.sh" >&2; exit 2; }

# One clock reading, so the rows below and the checks after the upgrade agree on every time.
t0=$(sql -d "$db" -Atc "select date_trunc('second', now())")
org=a0000000-0000-4000-8000-000000000001
p01=b0000000-0000-4000-8000-000000000001 p02=b0000000-0000-4000-8000-000000000002 p03=b0000000-0000-4000-8000-000000000003

# The seed's org, people, accounts and numbers, then devices and sessions as sign-in would have
# made them, written as hearth_owner (who owns the tables) in one transaction each.
sql -d "$db" --single-transaction -c 'set local role hearth_owner' -f db/seed/tembusu.sql
sql -d "$db" --single-transaction -c 'set local role hearth_owner' -c "
insert into public.devices (id, org_id, user_id, label, created_at, last_seen_at) values
  ('f1000000-0000-4000-8000-000000000001', '$org', '$p01', 'iPhone · Safari', '$t0'::timestamptz - interval '120 days', '$t0'),
  ('f1000000-0000-4000-8000-000000000002', '$org', '$p02', 'Pixel · Chrome', '$t0'::timestamptz - interval '120 days', '$t0'),
  ('f1000000-0000-4000-8000-000000000003', '$org', '$p03', 'Mac · Firefox', '$t0'::timestamptz - interval '120 days', '$t0');
insert into public.sessions
  (id, org_id, user_id, device_id, token_hash, created_at, last_seen_at, expires_at, revoked_at, revoked_by, revoke_reason)
select ('f2000000-0000-4000-8000-0000000000' || s.n)::uuid, '$org', s.person::uuid, s.device::uuid,
       sha256(convert_to('upgrade-session-' || s.n, 'UTF8')), s.started, '$t0'::timestamptz - interval '1 hour',
       s.started + s.lasts, s.revoked, s.revoked_by::uuid, s.reason
from (values
  -- Live, exactly 90 days: allowed before and after.
  ('01', '$p01', 'f1000000-0000-4000-8000-000000000001', '$t0'::timestamptz - interval '10 days', interval '2160 hours', null::timestamptz, null, null),
  -- Live, 120 days: ends 90 days after it began, still in the future.
  ('02', '$p01', 'f1000000-0000-4000-8000-000000000001', '$t0'::timestamptz - interval '10 days', interval '120 days', null, null, null),
  -- Live, a year, begun 100 days ago: ends 90 days after it began, so it has ended.
  ('03', '$p02', 'f1000000-0000-4000-8000-000000000002', '$t0'::timestamptz - interval '100 days', interval '365 days', null, null, null),
  -- Signed out, for a reason 0006 keeps.
  ('04', '$p02', 'f1000000-0000-4000-8000-000000000002', '$t0'::timestamptz - interval '5 days', interval '2160 hours', '$t0'::timestamptz - interval '1 day', '$p01', 'sign_out'),
  -- Ended for a reason outside 0006's codes, which 0003 allowed.
  ('05', '$p03', 'f1000000-0000-4000-8000-000000000003', '$t0'::timestamptz - interval '5 days', interval '2160 hours', '$t0'::timestamptz - interval '1 day', '$p01', 'admin_ended'),
  -- Both: an older reason and 200 days long.
  ('06', '$p03', 'f1000000-0000-4000-8000-000000000003', '$t0'::timestamptz - interval '3 days', interval '200 days', '$t0'::timestamptz - interval '1 day', '$p01', 'stale_cleanup')
) as s (n, person, device, started, lasts, revoked, revoked_by, reason);"

users_before=$(sql -d "$db" -Atc "select count(*) from public.users")

# 0006 and anything after it, with production's migrator, as check-migrations.sh runs it: a login
# that can only act as hearth_owner.
migrator_pw=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
trap 'sql -d postgres -c "drop role if exists $migrator" >/dev/null 2>&1 || true' EXIT
sql -d postgres -c "set client_min_messages = warning" \
  -c "do \$\$ begin create role $migrator; exception when duplicate_object then null; end \$\$" \
  -c "alter role $migrator login nosuperuser nobypassrls nocreaterole nocreatedb noinherit password '$migrator_pw'" \
  -c "grant $owner to $migrator"
PGUSER=$migrator PGPASSWORD=$migrator_pw PGDATABASE=$db MIGRATION_ROLE=$owner \
  env -u MIGRATION_DATABASE_URL node apps/server/src/db/migrate.ts >&2 ||
  { echo "0006 failed on rows 0005 allows: see the migrate: lines above." >&2; exit 1; }

# What the upgrade did to those rows, and what the new rules still refuse. Each failure is named.
sql -d "$db" -c "
do \$\$
declare
  t0 timestamptz := '$t0';
  s record;
  constraint_name text;
begin
  if not exists (select 1 from public.kysely_migration where name = '0006_sign_in') then
    raise exception '0006_sign_in was not applied';
  end if;
  if (select count(*) from public.sessions) <> 6 or (select count(*) from public.devices) <> 3 then
    raise exception 'sessions or devices were lost or added: % sessions, % devices',
      (select count(*) from public.sessions), (select count(*) from public.devices);
  end if;
  for s in
    select x.n, x.started, x.ends, x.revoked, x.reason, ss.*
    from (values
      ('01', t0 - interval '10 days', t0 - interval '10 days' + interval '2160 hours', null::timestamptz, null),
      ('02', t0 - interval '10 days', t0 - interval '10 days' + interval '2160 hours', null, null),
      ('03', t0 - interval '100 days', t0 - interval '100 days' + interval '2160 hours', null, null),
      ('04', t0 - interval '5 days', t0 - interval '5 days' + interval '2160 hours', t0 - interval '1 day', 'sign_out'),
      ('05', t0 - interval '5 days', t0 - interval '5 days' + interval '2160 hours', t0 - interval '1 day', 'admin_ended'),
      ('06', t0 - interval '3 days', t0 - interval '3 days' + interval '2160 hours', t0 - interval '1 day', 'stale_cleanup')
    ) as x (n, started, ends, revoked, reason)
    left join public.sessions ss on ss.id = ('f2000000-0000-4000-8000-0000000000' || x.n)::uuid
  loop
    if s.id is null then raise exception 'session % is gone', s.n; end if;
    if s.created_at <> s.started or s.last_seen_at <> t0 - interval '1 hour' then
      raise exception 'session %: when it began or was last used changed', s.n;
    end if;
    if s.expires_at <> s.ends then
      raise exception 'session % ends at %, not %', s.n, s.expires_at, s.ends;
    end if;
    if s.revoked_at is distinct from s.revoked or s.revoke_reason is distinct from s.reason
       or (s.revoked_by is null) <> (s.revoked is null) then
      raise exception 'session %: when, by whom or why it ended changed (now %, %)', s.n, s.revoked_at, s.revoke_reason;
    end if;
    if s.reauthenticated_at is not null then
      raise exception 'session % counts as re-authenticated at %, though it was made before 0006', s.n, s.reauthenticated_at;
    end if;
  end loop;
  -- Session 03 was meant to run a year; capped at 90 days, it has ended.
  if (select expires_at from public.sessions where id = 'f2000000-0000-4000-8000-000000000003') > now() then
    raise exception 'session 03 is still live after its 90 days';
  end if;

  if (select convalidated from pg_constraint
      where conrelid = 'public.sessions'::regclass and conname = 'sessions_revoke_reason') then
    raise exception 'sessions_revoke_reason was validated, though sessions keep reasons outside its codes';
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.sessions'::regclass
             and conname in ('sessions_at_most_90_days', 'sessions_reauthenticated_after_start') and not convalidated)
     or (select count(*) from pg_constraint where conrelid = 'public.sessions'::regclass
         and conname in ('sessions_at_most_90_days', 'sessions_reauthenticated_after_start', 'sessions_revoke_reason')) <> 3 then
    raise exception 'the 90-day and re-authentication rules are missing or not validated';
  end if;

  if (select count(*) from public.users) <> $users_before
     or exists (select 1 from public.users where pin_failures <> 0 or pin_last_failed_at is not null
                or pin_hash is not null or passkey_user_handle is null)
     or (select count(distinct passkey_user_handle) from public.users) <> (select count(*) from public.users) then
    raise exception 'accounts made before 0006 did not get its defaults (no PIN, no failures, a passkey handle each)';
  end if;

  -- A new row must still meet both rules (the person and device are live, so only the rule can refuse).
  begin
    insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at, revoked_at, revoked_by, revoke_reason)
    values ('$org', '$p01', 'f1000000-0000-4000-8000-000000000001', sha256(convert_to('upgrade-new-1', 'UTF8')),
            now() + interval '1 day', now(), '$p01', 'admin_ended');
    raise exception 'a new session that ended for a reason outside 0006''s codes was accepted';
  exception when check_violation then
    get stacked diagnostics constraint_name = constraint_name;
    if constraint_name is distinct from 'sessions_revoke_reason' then
      raise exception 'a new session with an older reason was refused by %, not sessions_revoke_reason', constraint_name;
    end if;
  end;
  begin
    insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at)
    values ('$org', '$p01', 'f1000000-0000-4000-8000-000000000001', sha256(convert_to('upgrade-new-2', 'UTF8')),
            now() + interval '2161 hours');
    raise exception 'a new session lasting more than 90 days was accepted';
  exception when check_violation then
    get stacked diagnostics constraint_name = constraint_name;
    if constraint_name is distinct from 'sessions_at_most_90_days' then
      raise exception 'a new 91-day session was refused by %, not sessions_at_most_90_days', constraint_name;
    end if;
  end;
end
\$\$"

# The upgraded schema matches a fresh build: tables, columns and their defaults, rules (apart from
# whether each was validated, which the checks above cover), indexes, triggers, functions, policies
# and grants. Monthly partitions are left out: they are named for the month each build ran in.
digest="
select format('%s %s: %s', kind, name, detail) from (
  select 'table' as kind, format('%I', c.relname) as name,
         format('kind=%s rls=%s force=%s acl=%s', c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl) as detail
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and not c.relispartition
  union all
  select 'column', format('%I.%I', c.relname, a.attname),
         format('%s notnull=%s default=%s acl=%s', format_type(a.atttypid, a.atttypmod), a.attnotnull,
                pg_get_expr(d.adbin, d.adrelid), a.attacl)
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
    and a.attnum > 0 and not a.attisdropped
  union all
  select 'constraint', format('%I.%I', c.relname, k.conname), replace(pg_get_constraintdef(k.oid), ' NOT VALID', '')
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not c.relispartition
  union all
  select 'index', format('%I', i.indexrelid::regclass::text), pg_get_indexdef(i.indexrelid)
  from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not c.relispartition
  union all
  select 'trigger', format('%I.%I', c.relname, t.tgname), pg_get_triggerdef(t.oid)
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal and not c.relispartition
  union all
  select 'function', p.oid::regprocedure::text,
         format('%s definer=%s config=%s acl=%s', md5(pg_get_functiondef(p.oid)), p.prosecdef, p.proconfig, p.proacl)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f', 'p')
  union all
  select 'policy', format('%I.%I', c.relname, pol.polname),
         format('%s %s %s using=%s check=%s', pol.polcmd, pol.polpermissive, pol.polroles::regrole[],
                pg_get_expr(pol.polqual, pol.polrelid), pg_get_expr(pol.polwithcheck, pol.polrelid))
  from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not c.relispartition
) as objects
order by 1"
upgraded=$(sql -d "$db" -At -c "$digest")
fresh=$(sql -d "$base" -At -c "$digest")
if [ "$upgraded" != "$fresh" ]; then
  echo "The upgraded schema ($db) differs from a fresh build ($base):" >&2
  diff <(printf '%s\n' "$fresh") <(printf '%s\n' "$upgraded") | sed 's/^/  /' >&2 || true
  exit 1
fi

echo "OK: 0006 upgraded $db with sessions and accounts 0005 allows; the rows and the schema check out."
