#!/usr/bin/env bash
# The upgrade check for 0010_notice (C0.9 PR 2, PD-54; CLAUDE.md, Testing and CI), which
# 0011_dpo_contact rides (C0.9 PR 3a, PD-83): 0010 and 0011 applied on top of the notice rows 0003
# to 0009 allow, as a C0.9 PR 1 deployment could hold them, instead of to an empty database.
#
# 0010 changes no existing row: it adds a nullable column to notice_versions, the version links and
# the notice's functions, revokes hearth_app's INSERT on both notice tables, and replaces
# transfer_cleared() with the same signature. But from 0010 the versions and acknowledgements
# already there decide who may use Hearth and whether a provider may receive personal data, which
# the schema digest can't see. So this loads the Tembusu seed (a stand-in v0 that all but one person
# acknowledged) and three more orgs, into a database built up to 0009:
# - org B: stand-ins v0 and v1; a person who acknowledged only v0, in the app; another, whose
#   acknowledgement of v0 outlived its device (deleted, as the retention engine does, PDPA-09), and
#   whose acknowledgement of v1 the DPO recorded;
# - org C: Twilio cleared by the first-Owner bootstrap's clearance (as the plain superuser runs it,
#   A-22), and no notice version (OD-01);
# - org D: Twilio cleared the same way, and a stand-in as its latest version;
# records every notice row, applies 0010 and anything after it with production's migrator, and
# checks that:
# - NTU-01: every notice version and acknowledgement is still there, unchanged; no version has a
#   generator (all are stand-ins); and 0010 linked nothing;
# - NTU-02: the upgraded schema matches a fresh build (BASE_DB, scripts/schema-digest.sql);
# - NTU-03: hearth_app can no longer add a notice version or an acknowledgement itself (42501);
# - NTU-04: acting as org B's first person, acknowledging v0 is refused as no longer the latest
#   (HF007), and acknowledging v1 is recorded;
# - NTU-05: transfer_cleared('twilio') is true in orgs C and D, as before 0010: no_notice in C and
#   cleared under D's stand-in (transfer_send_state()); the seed's org, which cleared nothing, is
#   not_cleared.
#
# 0011 (C0.9 PR 3a, PD-83) rides this step: it changes no existing row either, and its new checks
# pass every row 0003 to 0010 allow, so it is applied with 0010 and checked here too:
# - NTU-06 (OD-19): org B's acknowledgement the DPO recorded before 0011 keeps no day and no note,
#   and still counts in the standing read's query; both new acknowledgement checks are validated;
# - NTU-07 (OD-11, PD-66): no contact is recorded and no version links one; 0010's publish_notice()
#   is gone and hearth_app runs 0011's; and acting as org B's DPO, set_dpo_contact() records
#   version 1 over the upgraded data, and a second first record is refused (HF005);
# - NTU-08 (OD-20, PD-77, PD-80): every clearance keeps how it was cleared, and both new checks on
#   transfer_clearances are validated; in org C, the bootstrap's clearance of Twilio again is
#   refused as cleared before without the emergency marker (0009's refusal), and as cleared
#   already with it (the re-clear's).
# The data is made up; none of it is anyone's.
#
# Usage, after a full scratch build (BASE_DB, default hearth_check):
#   scripts/check-migrations.sh
#   CHECK_DB=hearth_upgrade_check UP_TO=0010 scripts/check-migrations.sh
#   CHECK_DB=hearth_upgrade_check scripts/check-notice-upgrade.sh
# Same connection settings as check-migrations.sh; CHECK_DB is the database built up to 0010.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export PGHOST=${PGHOST:-127.0.0.1} PGPORT=${PGPORT:-5432} PGUSER=${PGUSER:-postgres} PGPASSWORD=${PGPASSWORD:-postgres}
db=${CHECK_DB:-hearth_check}
base=${BASE_DB:-hearth_check}
for name in "$db" "$base"; do
  [[ $name =~ ^[a-z_][a-z0-9_]{0,54}_check$ ]] ||
    { echo "CHECK_DB and BASE_DB must be lower-case names ending in _check, at most 61 characters, not '$name'" >&2; exit 2; }
done
[ "$db" != "$base" ] || { echo "CHECK_DB must be the database built up to 0010, not BASE_DB ($base)" >&2; exit 2; }
owner=hearth_owner
migrator=${db}_m
sql() { psql --no-psqlrc -w -v ON_ERROR_STOP=1 -q "$@"; }

# It stops just before 0010, and the full build is complete.
before=$(sql -d "$db" -Atc "select count(*) filter (where name < '0010'), count(*) filter (where name >= '0010')
  from public.kysely_migration") ||
  { echo "No migrated database $db: build it with CHECK_DB=$db UP_TO=0010 scripts/check-migrations.sh" >&2; exit 2; }
[ "${before#*|}" = 0 ] && [ "${before%|*}" -gt 0 ] ||
  { echo "$db must be built up to (not including) 0010: CHECK_DB=$db UP_TO=0010 scripts/check-migrations.sh" >&2; exit 2; }
[ "$(sql -d "$base" -Atc "select count(*) from public.kysely_migration where name = '0010_notice'")" = 1 ] ||
  { echo "BASE_DB ($base) must be a full build: scripts/check-migrations.sh" >&2; exit 2; }

seed=a0000000-0000-4000-8000-000000000001
org_b=a0000000-0000-4000-8000-000000000002 org_c=a0000000-0000-4000-8000-000000000003
org_d=a0000000-0000-4000-8000-000000000004
# Each org's Hearth principal ends 000; its people 001 (B's first person), 002 (the DPO) and 003.
hearth_b=b2000000-0000-4000-8000-000000000000 b1=b2000000-0000-4000-8000-000000000001
b2=b2000000-0000-4000-8000-000000000002 b3=b2000000-0000-4000-8000-000000000003
hearth_c=b3000000-0000-4000-8000-000000000000 c2=b3000000-0000-4000-8000-000000000002
hearth_d=b4000000-0000-4000-8000-000000000000 d2=b4000000-0000-4000-8000-000000000002
# Org B's versions and devices.
b_v0=e2000000-0000-4000-8000-000000000000 b_v1=e2000000-0000-4000-8000-000000000001
b_dev1=e2000000-0000-4000-8000-0000000000d1 b_dev3=e2000000-0000-4000-8000-0000000000d3

# The seed's org, written as hearth_owner (who owns the tables).
sql -d "$db" --single-transaction -c 'set local role hearth_owner' -f db/seed/tembusu.sql
# Org B, as hearth_owner: its stand-ins, and the acknowledgements 0003 allowed.
sql -d "$db" --single-transaction -c 'set local role hearth_owner' -c "
insert into public.orgs (id, name) values ('$org_b', 'Upgrade Check B');
insert into public.principals (id, org_id, kind, system_key) values ('$hearth_b', '$org_b', 'system', 'hearth');
insert into public.principals (id, org_id, kind) values ('$b1', '$org_b', 'human'), ('$b2', '$org_b', 'human'), ('$b3', '$org_b', 'human');
insert into public.people (id, org_id, full_name, created_by) values
  ('$b1', '$org_b', 'Bea One', '$hearth_b'), ('$b2', '$org_b', 'Bo Two', '$hearth_b'), ('$b3', '$org_b', 'Bel Three', '$hearth_b');
insert into public.role_assignments (org_id, person_id, role, created_by) values ('$org_b', '$b2', 'dpo', '$hearth_b');
insert into public.users (id, org_id) values ('$b1', '$org_b'), ('$b3', '$org_b');
insert into public.devices (id, org_id, user_id, label) values
  ('$b_dev1', '$org_b', '$b1', 'Phone B1'), ('$b_dev3', '$org_b', '$b3', 'Phone B3');
insert into public.notice_versions (id, org_id, version, body, published_by, published_at) values
  ('$b_v0', '$org_b', 0, 'Stand-in v0 for org B', '$b2', now() - interval '30 days'),
  ('$b_v1', '$org_b', 1, 'Stand-in v1 for org B', '$b2', now() - interval '1 day');
insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, device_id, acknowledged_at) values
  ('$org_b', '$b1', '$b_v0', 'in_app', '$b_dev1', now() - interval '29 days'),
  ('$org_b', '$b3', '$b_v0', 'in_app', '$b_dev3', now() - interval '28 days');
insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, recorded_by)
  values ('$org_b', '$b3', '$b_v1', 'recorded_by_dpo', '$b2');
delete from public.devices where id = '$b_dev3';"
# Orgs C and D: a Hearth principal and a DPO each, with Twilio cleared by the bootstrap's clearance,
# run as the plain superuser acting as the org's Hearth principal, as the harness runs it (A-22);
# then D's stand-in.
for org in "$org_c:$hearth_c:$c2" "$org_d:$hearth_d:$d2"; do
  IFS=: read -r o h dpo <<<"$org"
  sql -d "$db" --single-transaction -o /dev/null -c "
insert into public.orgs (id, name) values ('$o', 'Upgrade Check ' || '$o');
insert into public.principals (id, org_id, kind, system_key) values ('$h', '$o', 'system', 'hearth');
insert into public.principals (id, org_id, kind) values ('$dpo', '$o', 'human');
insert into public.people (id, org_id, full_name, created_by) values ('$dpo', '$o', 'Dee Pio', '$h');
insert into public.role_assignments (org_id, person_id, role, created_by) values ('$o', '$dpo', 'dpo', '$h');
select set_config('app.org_id', '$o', true), set_config('app.user_id', '$h', true);
select public.bootstrap_transfer_clearance('twilio', '$dpo', 'Sign-in codes by text message',
  'The phone number, the channel and the service id', '{US}', '{US}', 'The agreement, schedule 2', 'dpa_addendum',
  'The agreement and its addendum', null, true, 'off', 'not_offered', 'Verification records for 30 days',
  'A letter from the provider', 'Mobile carriers', current_date + 365, 'Upgrade check: a cleared Twilio before 0010');"
done
sql -d "$db" --single-transaction -c 'set local role hearth_owner' -c "
insert into public.notice_versions (org_id, version, body, published_by) values ('$org_d', 0, 'Stand-in v0 for org D', '$d2');"

# Every notice row, one line each, by the columns 0009 has, to compare before and after.
versions="select string_agg(format('%s %s %s %s %s %s', id, org_id, version, md5(body), published_at, published_by), E'\n'
  order by org_id, version) from public.notice_versions"
acks="select string_agg(format('%s %s %s %s %s %s %s %s', id, org_id, person_id, notice_version_id, acknowledged_at, method,
  device_id, recorded_by), E'\n' order by id) from public.notice_acknowledgments"
clearances="select string_agg(format('%s %s %s %s %s', id, org_id, provider, cleared_via, withdrawn_at), E'\n' order by id)
  from public.transfer_clearances"
kept_versions=$(sql -d "$db" -Atc "$versions")
kept_acks=$(sql -d "$db" -Atc "$acks")
kept_clearances=$(sql -d "$db" -Atc "$clearances")
[ "$(sql -d "$db" -Atc "select count(*) from public.notice_versions")" = 4 ] &&
  [ "$(sql -d "$db" -Atc "select count(*) from public.notice_acknowledgments")" = 14 ] &&
  [ "$(sql -d "$db" -Atc "select count(*) from public.notice_acknowledgments
         where org_id = '$org_b' and device_id is null and method = 'in_app'")" = 1 ] ||
  { echo "The notice rows to upgrade over weren't all written" >&2; exit 1; }

# 0010 with production's migrator, as check-migrations.sh runs it: a login that can only act as
# hearth_owner.
migrator_pw=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
trap 'sql -d postgres -c "drop role if exists $migrator" >/dev/null 2>&1 || true' EXIT
sql -d postgres -c "set client_min_messages = warning" \
  -c "do \$\$ begin create role $migrator; exception when duplicate_object then null; end \$\$" \
  -c "alter role $migrator login nosuperuser nobypassrls nocreaterole nocreatedb noinherit password '$migrator_pw'" \
  -c "grant $owner to $migrator"
PGUSER=$migrator PGPASSWORD=$migrator_pw PGDATABASE=$db MIGRATION_ROLE=$owner \
  env -u MIGRATION_DATABASE_URL node apps/server/src/db/migrate.ts >&2 ||
  { echo "0010 (or a later migration) failed over the notice rows 0003 to 0009 allow: see the migrate: lines above." >&2; exit 1; }
[ "$(sql -d "$db" -Atc "select count(*) from public.kysely_migration where name in ('0010_notice', '0011_dpo_contact')")" = 2 ] ||
  { echo "0010_notice and 0011_dpo_contact were not both applied" >&2; exit 1; }

# NTU-01: every row as it was, every version a stand-in, nothing linked.
now_versions=$(sql -d "$db" -Atc "$versions")
now_acks=$(sql -d "$db" -Atc "$acks")
if [ "$now_versions" != "$kept_versions" ] || [ "$now_acks" != "$kept_acks" ]; then
  echo "NTU-01: the migrations changed the notice rows already there:" >&2
  diff <(printf '%s\n%s\n' "$kept_versions" "$kept_acks") <(printf '%s\n%s\n' "$now_versions" "$now_acks") | sed 's/^/  /' >&2 || true
  exit 1
fi
[ "$(sql -d "$db" -Atc "select count(*) filter (where generator is not null) from public.notice_versions")" = 0 ] ||
  { echo "NTU-01: a version already there was given a generator" >&2; exit 1; }
[ "$(sql -d "$db" -Atc "select (select count(*) from public.notice_version_purposes) + (select count(*) from public.notice_version_providers)")" = 0 ] ||
  { echo "NTU-01: 0010 linked a version already there to the registers" >&2; exit 1; }

# NTU-02: the upgraded schema matches a fresh build.
upgraded=$(sql -d "$db" -At -f scripts/schema-digest.sql)
fresh=$(sql -d "$base" -At -f scripts/schema-digest.sql)
if [ "$upgraded" != "$fresh" ]; then
  echo "NTU-02: the upgraded schema ($db) differs from a fresh build ($base):" >&2
  diff <(printf '%s\n' "$fresh") <(printf '%s\n' "$upgraded") | sed 's/^/  /' >&2 || true
  exit 1
fi

# One transaction as hearth_app acting as someone in an org, as withOrg() opens one.
as_app() { sql -d "$db" --single-transaction -At -c 'set local role hearth_app' \
  -c "select set_config('app.org_id', '$1', true), set_config('app.user_id', '$2', true)" -o /dev/null -c "$3"; }
as_app_out() { sql -d "$db" --single-transaction -At -c 'set local role hearth_app' \
  -c "select set_config('app.org_id', '$1', true), set_config('app.user_id', '$2', true)" -c "$3" | tail -n 1; }
# A statement that must be refused with the given SQLSTATE; anything else fails the check.
refused() { # SQLSTATE, what is refused, then the statement
  local what=${2//\'/\'\'}
  printf "do \$\$ begin %s; raise exception 'allowed after 0010: %s'; exception when sqlstate '%s' then null; end \$\$" "$3" "$what" "$1"
}

# NTU-03: hearth_app writes neither notice table itself any more.
as_app "$org_b" "$b2" "
$(refused 42501 'hearth_app added a notice version' \
  "insert into public.notice_versions (org_id, version, body, published_by) values ('$org_b', 2, 'Planted', '$b2')");
$(refused 42501 'hearth_app added an acknowledgement' \
  "insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, device_id)
   values ('$org_b', '$b1', '$b_v1', 'in_app', '$b_dev1')")" ||
  { echo "NTU-03: hearth_app could still write a notice table itself" >&2; exit 1; }

# NTU-04: org B's first person acknowledged only v0, which is no longer the latest; v1 is recorded.
as_app "$org_b" "$b1" "$(refused HF007 'acknowledging v0 under v1' \
  "perform public.acknowledge_notice('$b_v0', 'req-upgrade', '$b_dev1', null)")" ||
  { echo "NTU-04: acknowledging v0 wasn't refused as no longer the latest" >&2; exit 1; }
[ "$(as_app_out "$org_b" "$b1" "select format('%s %s', version, changed) from public.acknowledge_notice('$b_v1', 'req-upgrade', '$b_dev1', null)")" = '1 t' ] ||
  { echo "NTU-04: org B's first person couldn't acknowledge v1" >&2; exit 1; }
[ "$(sql -d "$db" -Atc "select count(*) from public.notice_acknowledgments
       where org_id = '$org_b' and person_id = '$b1' and notice_version_id = '$b_v1' and method = 'in_app' and device_id = '$b_dev1'")" = 1 ] ||
  { echo "NTU-04: the acknowledgement of v1 wasn't recorded" >&2; exit 1; }

# NTU-05: the transfer gate keeps PR 1's answers before the first generated version.
for row in "$org_c:$hearth_c:t no_notice" "$org_d:$hearth_d:t cleared" "$seed:b0000000-0000-4000-8000-000000000000:f not_cleared"; do
  IFS=: read -r o h want <<<"$row"
  got=$(as_app_out "$o" "$h" "select format('%s %s', public.transfer_cleared('twilio'), public.transfer_send_state('twilio'))")
  [ "$got" = "$want" ] || { echo "NTU-05: in org $o, twilio reads '$got', not '$want'" >&2; exit 1; }
done

# A statement that must be refused with the given SQLSTATE and a message like the pattern.
refused_like() { # SQLSTATE, the message's pattern (LIKE), what is refused, then the statement
  local what=${3//\'/\'\'}
  printf "do \$\$ begin %s; raise exception 'allowed after 0011: %s'; exception when sqlstate '%s' then
    if sqlerrm not like '%s' then raise; end if; end \$\$" "$4" "$what" "$1" "$2"
}

# NTU-06: the DPO's record of b3's acknowledgement of v1, made before 0011, has neither the day nor
# the note, which the new checks allow, and still lets b3 through: the standing read's query
# (compliance/notice-standing.ts), as hearth_app.
[ "$(sql -d "$db" -Atc "select format('%s %s %s', method, acknowledged_on is null, recorded_note is null)
       from public.notice_acknowledgments where org_id = '$org_b' and person_id = '$b3' and notice_version_id = '$b_v1'")" = \
  'recorded_by_dpo t t' ] || { echo "NTU-06: org B's recorded acknowledgement gained a day or a note" >&2; exit 1; }
[ "$(as_app_out "$org_b" "$b3" "select case when v.id is null then 'unpublished'
       when exists (select 1 from public.notice_acknowledgments a
                    where a.org_id = '$org_b' and a.person_id = '$b3' and a.notice_version_id = v.id) then 'acknowledged'
       else 'required' end
     from (select 1) one left join lateral (select id from public.notice_versions where org_id = '$org_b'
                                            order by version desc limit 1) v on true")" = acknowledged ] ||
  { echo "NTU-06: org B's recorded acknowledgement of v1 no longer lets b3 through" >&2; exit 1; }
[ "$(sql -d "$db" -Atc "select string_agg(conname || ' ' || convalidated, ',' order by conname) from pg_constraint
       where conrelid = 'public.notice_acknowledgments'::regclass
         and conname in ('notice_acknowledgments_recorded_details', 'notice_acknowledgments_recorded_note')")" = \
  'notice_acknowledgments_recorded_details true,notice_acknowledgments_recorded_note true' ] ||
  { echo "NTU-06: a new acknowledgement check is missing or left NOT VALID" >&2; exit 1; }

# NTU-07: nothing printed a contact before 0011, so none is recorded and no version links one;
# publishing has only 0011's signature, which hearth_app runs; and the contact's writer works over the
# upgraded data, as org B's DPO: version 1, then a second first record refused (HF005).
[ "$(sql -d "$db" -Atc "select (select count(*) from public.dpo_settings) || ' ' ||
       (select count(*) from public.notice_versions where dpo_settings_version is not null)")" = '0 0' ] ||
  { echo "NTU-07: 0011 recorded a contact, or linked a version to one" >&2; exit 1; }
[ "$(sql -d "$db" -Atc "select format('%s %s',
       to_regprocedure('public.publish_notice(integer,text,text,text[],integer[],uuid[],text,uuid,inet)') is null,
       has_function_privilege('hearth_app',
         'public.publish_notice(integer,text,text,text[],integer[],uuid[],integer,text,uuid,inet)', 'EXECUTE'))")" = 't t' ] ||
  { echo "NTU-07: 0010's publish_notice() is still there, or hearth_app can't run 0011's" >&2; exit 1; }
[ "$(as_app_out "$org_b" "$b2" "select format('%s %s', version, changed) from public.set_dpo_contact(null,
       'Data Protection Officer', 'dpo@upgrade.example', null, null, 'req-upgrade', null, null)")" = '1 t' ] ||
  { echo "NTU-07: org B's DPO couldn't record a contact over the upgraded data" >&2; exit 1; }
as_app "$org_b" "$b2" "$(refused_like HF005 'Your contact details changed since you opened them.%' 'a second first record' \
  "perform public.set_dpo_contact(null, 'Data Protection Officer', 'privacy@upgrade.example', null, null, 'req-upgrade', null, null)")" ||
  { echo "NTU-07: a second first record of org B's contact wasn't refused as stale" >&2; exit 1; }

# NTU-08: every clearance is as it was (how, and whether it ended); both new checks on
# transfer_clearances are validated; and org C's Twilio, which the set-up cleared, can't be cleared
# by it again (0009's refusal, without the emergency marker) nor re-cleared while its clearance is
# open (with the marker), acting as org C's Hearth principal as the superuser, as the harness runs
# it, on the facts it was cleared on and a review date 30 days ahead, inside the re-clear's cap.
now_clearances=$(sql -d "$db" -Atc "$clearances")
[ "$now_clearances" = "$kept_clearances" ] || { echo "NTU-08: the migrations changed a clearance already there" >&2; exit 1; }
[ "$(sql -d "$db" -Atc "select string_agg(conname || ' ' || convalidated, ',' order by conname) from pg_constraint
       where conrelid = 'public.transfer_clearances'::regclass
         and conname in ('transfer_clearances_break_glass', 'transfer_clearances_cleared_via')")" = \
  'transfer_clearances_break_glass true,transfer_clearances_cleared_via true' ] ||
  { echo "NTU-08: a new clearance check is missing or left NOT VALID" >&2; exit 1; }
again="perform public.bootstrap_transfer_clearance('twilio', '$c2', 'Sign-in codes by text message',
  'The phone number, the channel and the service id', '{US}', '{US}', 'The agreement, schedule 2', 'dpa_addendum',
  'The agreement and its addendum', null, true, 'off', 'not_offered', 'Verification records for 30 days',
  'A letter from the provider', 'Mobile carriers', current_date + 30, 'Upgrade check: Twilio again')"
sql -d "$db" --single-transaction -o /dev/null -c "select set_config('app.org_id', '$org_c', true), set_config('app.user_id', '$hearth_c', true)" \
  -c "$(refused_like HF006 'That provider has been cleared%' 'the set-up clearing Twilio again' "$again")" ||
  { echo "NTU-08: the set-up's clearance of Twilio again wasn't refused as cleared before" >&2; exit 1; }
sql -d "$db" --single-transaction -o /dev/null -c "select set_config('app.org_id', '$org_c', true), set_config('app.user_id', '$hearth_c', true),
  set_config('hearth.break_glass', 'twilio_reclear', true)" \
  -c "$(refused_like HF006 'Twilio Verify is cleared already.%' 'the re-clear of a cleared Twilio' "$again")" ||
  { echo "NTU-08: the re-clear of org C's cleared Twilio wasn't refused as cleared already" >&2; exit 1; }

echo "OK: 0010 and 0011 upgraded $db over the notice rows 0003 to 0009 allow; the rows, the writes, acknowledging, the contact's writer, the transfer gate and the re-clear's refusals check out, and the schema matches a fresh build."
