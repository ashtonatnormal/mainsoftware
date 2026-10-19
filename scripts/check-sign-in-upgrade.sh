#!/usr/bin/env bash
# The upgrade check for 0006_sign_in (C0.5; CLAUDE.md, Testing and CI): 0006 applied on top of
# rows 0005 allows, as production would have them, instead of to an empty database.
#
# 0006 adds two rules a session made earlier could break: a session lasts at most 90 days, and
# why one ended is one of four codes. No session exists before 0006 anywhere, but the upgrade
# mustn't depend on that. So this loads the Tembusu seed, then devices and sessions 0003 allowed
# (written as hearth_owner) and someone who left with a session still open, applies 0006 with
# production's migrator in a time zone with daylight saving, and checks that:
# - every session, device and account is still there;
# - the leaver's sessions and devices ended as of when they left, or when made if later;
# - a session not revoked and meant to last more than 90 days now ends 90 days after it began,
#   and no other session's times or ending moved;
# - the rule named by the argument stays NOT VALID, since a revoked session breaks it and keeps its
#   times and reason; the other rules are validated; new rows still meet every rule;
# - no session made before 0006 counts as re-authenticated, and every account gets its new
#   columns' defaults;
# - the upgraded schema matches a fresh build (BASE_DB), apart from that NOT VALID rule.
# CI runs it once for each of the two rules, so each is seen both validated and left NOT VALID.
# The data is made up; none of it is anyone's.
#
# Usage, after a full scratch build (BASE_DB, default hearth_check), for each rule:
#   scripts/check-migrations.sh
#   CHECK_DB=hearth_upgrade_check UP_TO=0006 scripts/check-migrations.sh
#   CHECK_DB=hearth_upgrade_check scripts/check-sign-in-upgrade.sh sessions_revoke_reason
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
# The rule an older session leaves NOT VALID in this run.
kept=${1:-}
case "$kept" in
  sessions_revoke_reason | sessions_at_most_90_days) ;;
  *) echo "Name the rule older sessions leave NOT VALID: sessions_revoke_reason or sessions_at_most_90_days" >&2; exit 2 ;;
esac
sql() { psql --no-psqlrc -w -v ON_ERROR_STOP=1 -q "$@"; }

# It stops just before 0006, and the full build is complete.
before=$(sql -d "$db" -Atc "select count(*) filter (where name < '0006'), count(*) filter (where name >= '0006')
  from public.kysely_migration") ||
  { echo "No migrated database $db: build it with CHECK_DB=$db UP_TO=0006 scripts/check-migrations.sh" >&2; exit 2; }
[ "${before#*|}" = 0 ] && [ "${before%|*}" -gt 0 ] ||
  { echo "$db must be built up to (not including) 0006: CHECK_DB=$db UP_TO=0006 scripts/check-migrations.sh" >&2; exit 2; }
[ "$(sql -d "$base" -Atc "select count(*) from public.kysely_migration where name = '0006_sign_in'")" = 1 ] ||
  { echo "BASE_DB ($base) must be a full build: scripts/check-migrations.sh" >&2; exit 2; }

# A time zone with daylight saving, so a cap that moved with the clocks (days, not hours) shows:
# session 09's 90 days cross New York's change of 2 November 2025.
sql -d postgres -c "alter database $db set timezone = 'America/New_York'"
# One clock reading, so the rows below and the checks after the upgrade agree on every time.
t0=$(sql -d "$db" -Atc "select date_trunc('second', now())")
org=a0000000-0000-4000-8000-000000000001
p01=b0000000-0000-4000-8000-000000000001 p02=b0000000-0000-4000-8000-000000000002
p03=b0000000-0000-4000-8000-000000000003 p04=b0000000-0000-4000-8000-000000000004
d1=f1000000-0000-4000-8000-000000000001 d2=f1000000-0000-4000-8000-000000000002
d3=f1000000-0000-4000-8000-000000000003 d4=f1000000-0000-4000-8000-000000000004
d5=f1000000-0000-4000-8000-000000000005

# The seed's org, people, accounts and numbers, then devices and sessions 0003 allowed, written as
# hearth_owner (who owns the tables) in one transaction each. Person 04 leaves 2 days before t0
# with a session and a device still open, which nothing ended before 0006, and gets another of
# each a day later, which nothing refused before 0006.
sql -d "$db" --single-transaction -c 'set local role hearth_owner' -f db/seed/tembusu.sql
sql -d "$db" --single-transaction -c 'set local role hearth_owner' -c "
insert into public.devices (id, org_id, user_id, label, created_at, last_seen_at) values
  ('$d1', '$org', '$p01', 'iPhone · Safari', '2025-09-01 00:00:00+00', '$t0'),
  ('$d2', '$org', '$p02', 'Pixel · Chrome', '2025-09-01 00:00:00+00', '$t0'),
  ('$d3', '$org', '$p03', 'Mac · Firefox', '2025-09-01 00:00:00+00', '$t0'),
  ('$d4', '$org', '$p04', 'iPad · Safari', '2025-09-01 00:00:00+00', '$t0'),
  ('$d5', '$org', '$p04', 'Laptop · Edge', '$t0'::timestamptz - interval '1 day', '$t0');
insert into public.sessions
  (id, org_id, user_id, device_id, token_hash, created_at, last_seen_at, expires_at, revoked_at, revoked_by, revoke_reason)
select ('f2000000-0000-4000-8000-0000000000' || s.n)::uuid, '$org', s.person::uuid, s.device::uuid,
       sha256(convert_to('upgrade-session-' || s.n, 'UTF8')), s.started, '$t0'::timestamptz - interval '1 hour',
       s.started + s.lasts, s.revoked, s.revoked_by::uuid, s.reason
from (values
  -- Live, exactly 90 days: allowed before and after.
  ('01', null, '$p01', '$d1', '$t0'::timestamptz - interval '10 days', interval '2160 hours', null::timestamptz, null, null),
  -- Live, 120 days: ends 90 days after it began, still in the future.
  ('02', null, '$p01', '$d1', '$t0'::timestamptz - interval '10 days', interval '120 days', null, null, null),
  -- Live, a year, begun 100 days ago: ends 90 days after it began, so it has ended.
  ('03', null, '$p02', '$d2', '$t0'::timestamptz - interval '100 days', interval '365 days', null, null, null),
  -- Signed out, for a reason 0006 keeps.
  ('04', null, '$p02', '$d2', '$t0'::timestamptz - interval '5 days', interval '2160 hours', '$t0'::timestamptz - interval '1 day', '$p01', 'sign_out'),
  -- Ended for a reason outside 0006's codes, which 0003 allowed: keeps it.
  ('05', 'sessions_revoke_reason', '$p03', '$d3', '$t0'::timestamptz - interval '5 days', interval '2160 hours', '$t0'::timestamptz - interval '1 day', '$p01', 'admin_ended'),
  -- Signed out, 200 days long: keeps its times.
  ('06', 'sessions_at_most_90_days', '$p03', '$d3', '$t0'::timestamptz - interval '30 days', interval '200 days', '$t0'::timestamptz - interval '1 day', '$p01', 'sign_out'),
  -- Live and signed out, both shorter than 90 days: unchanged.
  ('07', null, '$p01', '$d1', '$t0'::timestamptz - interval '2 days', interval '720 hours', null, null, null),
  ('08', null, '$p02', '$d2', '$t0'::timestamptz - interval '3 days', interval '240 hours', '$t0'::timestamptz - interval '1 day', '$p02', 'sign_out'),
  -- Never revoked, 180 days, ended on its own long ago: still capped, as it must take an update.
  ('09', null, '$p03', '$d3', '2025-10-01 12:00:00+00'::timestamptz, interval '180 days', null, null, null),
  -- The leaver's, still open: one from before they left, one from after.
  ('10', null, '$p04', '$d4', '$t0'::timestamptz - interval '20 days', interval '2160 hours', null, null, null),
  ('11', null, '$p04', '$d5', '$t0'::timestamptz - interval '1 day', interval '240 hours', null, null, null)
) as s (n, only_for, person, device, started, lasts, revoked, revoked_by, reason)
where s.only_for is null or s.only_for = '$kept';
update public.people set deactivated_at = '$t0'::timestamptz - interval '2 days', deactivated_by = '$p01'
where org_id = '$org' and id = '$p04';"

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
  kept text := '$kept';
  s record;
  expected int;
  constraint_name text;
begin
  if not exists (select 1 from public.kysely_migration where name = '0006_sign_in') then
    raise exception '0006_sign_in was not applied';
  end if;
  create temporary table expected_sessions on commit drop as
  select * from (values
    ('01', null, t0 - interval '10 days', t0 - interval '10 days' + interval '2160 hours', null::timestamptz, null::uuid, null),
    ('02', null, t0 - interval '10 days', t0 - interval '10 days' + interval '2160 hours', null, null, null),
    ('03', null, t0 - interval '100 days', t0 - interval '100 days' + interval '2160 hours', null, null, null),
    ('04', null, t0 - interval '5 days', t0 - interval '5 days' + interval '2160 hours', t0 - interval '1 day', '$p01', 'sign_out'),
    ('05', 'sessions_revoke_reason', t0 - interval '5 days', t0 - interval '5 days' + interval '2160 hours', t0 - interval '1 day', '$p01', 'admin_ended'),
    ('06', 'sessions_at_most_90_days', t0 - interval '30 days', t0 - interval '30 days' + interval '200 days', t0 - interval '1 day', '$p01', 'sign_out'),
    ('07', null, t0 - interval '2 days', t0 - interval '2 days' + interval '720 hours', null, null, null),
    ('08', null, t0 - interval '3 days', t0 - interval '3 days' + interval '240 hours', t0 - interval '1 day', '$p02', 'sign_out'),
    ('09', null, timestamptz '2025-10-01 12:00:00+00', timestamptz '2025-10-01 12:00:00+00' + interval '2160 hours', null, null, null),
    ('10', null, t0 - interval '20 days', t0 - interval '20 days' + interval '2160 hours', t0 - interval '2 days', '$p01', 'deactivated'),
    -- Made after they left, so it ends when it began, not before.
    ('11', null, t0 - interval '1 day', t0 - interval '1 day' + interval '240 hours', t0 - interval '1 day', '$p01', 'deactivated')
  ) as x (n, only_for, started, ends, revoked, revoked_by, reason)
  where x.only_for is null or x.only_for = kept;
  expected := (select count(*) from expected_sessions);
  if (select count(*) from public.sessions) <> expected or (select count(*) from public.devices) <> 5 then
    raise exception 'sessions or devices were lost or added: % sessions (not %), % devices (not 5)',
      (select count(*) from public.sessions), expected, (select count(*) from public.devices);
  end if;
  for s in
    select x.n, x.started, x.ends, x.revoked, x.revoked_by as by_whom, x.reason, ss.*
    from expected_sessions x
    left join public.sessions ss on ss.id = ('f2000000-0000-4000-8000-0000000000' || x.n)::uuid
  loop
    if s.id is null then raise exception 'session % is gone', s.n; end if;
    if s.created_at <> s.started or s.last_seen_at <> t0 - interval '1 hour' then
      raise exception 'session %: when it began or was last used changed', s.n;
    end if;
    if s.expires_at <> s.ends then
      raise exception 'session % ends at %, not %', s.n, s.expires_at, s.ends;
    end if;
    if s.revoked_at is distinct from s.revoked or s.revoked_by is distinct from s.by_whom
       or s.revoke_reason is distinct from s.reason then
      raise exception 'session %: ended at % by % for %, not at % by % for %', s.n,
        s.revoked_at, s.revoked_by, s.revoke_reason, s.revoked, s.by_whom, s.reason;
    end if;
    if s.reauthenticated_at is not null then
      raise exception 'session % counts as re-authenticated at %, though it was made before 0006', s.n, s.reauthenticated_at;
    end if;
  end loop;
  -- Session 03 was meant to run a year; capped at 90 days, it has ended.
  if (select expires_at from public.sessions where id = 'f2000000-0000-4000-8000-000000000003') > now() then
    raise exception 'session 03 is still live after its 90 days';
  end if;
  -- The leaver's devices were signed out when they left, or when made if later; the others are
  -- still signed in.
  if exists (select 1 from public.devices
             where id = '$d4' and (signed_out_at, signed_out_by) is distinct from (t0 - interval '2 days', '$p01'::uuid))
     or exists (select 1 from public.devices
                where id = '$d5' and (signed_out_at, signed_out_by) is distinct from (t0 - interval '1 day', '$p01'::uuid))
     or exists (select 1 from public.devices where id not in ('$d4', '$d5') and signed_out_at is not null) then
    raise exception 'devices were not signed out as the leaver''s should be, and only theirs';
  end if;

  if (select count(*) from pg_constraint where conrelid = 'public.sessions'::regclass
      and conname in ('sessions_at_most_90_days', 'sessions_reauthenticated_after_start', 'sessions_revoke_reason')) <> 3 then
    raise exception 'a rule on sessions is missing';
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.sessions'::regclass
             and conname in ('sessions_at_most_90_days', 'sessions_reauthenticated_after_start', 'sessions_revoke_reason')
             and convalidated = (conname = kept)) then
    raise exception '% should stay NOT VALID and the other rules be validated: %', kept,
      (select string_agg(format('%s=%s', conname, convalidated), ', ' order by conname) from pg_constraint
       where conrelid = 'public.sessions'::regclass
         and conname in ('sessions_at_most_90_days', 'sessions_reauthenticated_after_start', 'sessions_revoke_reason'));
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
    values ('$org', '$p01', '$d1', sha256(convert_to('upgrade-new-1', 'UTF8')),
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
    values ('$org', '$p01', '$d1', sha256(convert_to('upgrade-new-2', 'UTF8')),
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

# The upgraded schema matches a fresh build (scripts/schema-digest.sql), apart from whether each rule
# was validated, which the checks above cover.
upgraded=$(sql -d "$db" -At -f scripts/schema-digest.sql)
fresh=$(sql -d "$base" -At -f scripts/schema-digest.sql)
if [ "$upgraded" != "$fresh" ]; then
  echo "The upgraded schema ($db) differs from a fresh build ($base):" >&2
  diff <(printf '%s\n' "$fresh") <(printf '%s\n' "$upgraded") | sed 's/^/  /' >&2 || true
  exit 1
fi

echo "OK: 0006 upgraded $db with sessions and accounts 0005 allows, leaving $kept NOT VALID; the rows and the schema check out."
