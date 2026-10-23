#!/usr/bin/env bash
# The upgrade check for 0008_revocation_role (C0.7; CLAUDE.md, Testing and CI): 0008 applied on top
# of the checkpoints 0007 allows, as a C0.6 deployment would have them, instead of to an empty
# database.
#
# 0008 replaces outbox_checkpoints_own_row() so that each consumer the server runs is bound to the
# role it runs as (TECH-SPEC T16 item 3, T19 item 4), and refuses to apply while a checkpoint already
# there pairs a bound name with another role. A C0.6 deployment holds an `offboarding` checkpoint in
# each org, which the offboarding role started and moves. Under 0007 that role could also start a
# `revocation` checkpoint in its own name, the row the binding exists to refuse, and a superuser
# could start an `offboarding` one naming another role. So this loads the Tembusu seed and a second
# org, then the offboarding role's own checkpoint (moved on, as its worker would have), one it starts
# under a name 0008 doesn't bind, and one the superuser starts for another role under such a name,
# and checks that:
# - with both bad rows planted (a `revocation` checkpoint naming the offboarding role, and in the
#   second org an `offboarding` one naming the purge role), 0008 refuses, naming both, and the
#   database stays at 0007;
# - with them removed, 0008 applies, and every other checkpoint is still there, unchanged;
# - afterwards the offboarding role can still move its own checkpoint and start one under a name
#   0008 doesn't bind, but can't start a `revocation` one or move the purge role's; the revocation
#   role can start its own, and neither role can start one in the other's name;
# - the upgraded schema matches a fresh build (BASE_DB, scripts/schema-digest.sql).
# The migrate applies every migration after 0007, so it applies 0009 (C0.9 PR 1) over the same data,
# which has no step of its own (TECH-SPEC T22 item 18, C0.9 PD-29): 0009 changes no row, replaces
# outbox_events_type with a superset, validated in place, and gives every org its register entries.
# So this also writes one outbox event of a type 0007 lists before the migrate, so the new check is
# validated over a real row, and checks afterwards that:
# - that event is still there, unchanged, and the new check is validated;
# - every org, the seed's and the second (which has no principals), has exactly the defaults' version
#   1 of each purpose and the defaults' entry for each provider, naming nobody, recording nothing,
#   and nothing cleared (the digest compares no rows).
# The data is made up; none of it is anyone's.
#
# Usage, after a full scratch build (BASE_DB, default hearth_check):
#   scripts/check-migrations.sh
#   CHECK_DB=hearth_upgrade_check UP_TO=0008 scripts/check-migrations.sh
#   CHECK_DB=hearth_upgrade_check scripts/check-revocation-upgrade.sh
# Same connection settings as check-migrations.sh; CHECK_DB is the database built up to 0008.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export PGHOST=${PGHOST:-127.0.0.1} PGPORT=${PGPORT:-5432} PGUSER=${PGUSER:-postgres} PGPASSWORD=${PGPASSWORD:-postgres}
db=${CHECK_DB:-hearth_check}
base=${BASE_DB:-hearth_check}
for name in "$db" "$base"; do
  [[ $name =~ ^[a-z_][a-z0-9_]{0,54}_check$ ]] ||
    { echo "CHECK_DB and BASE_DB must be lower-case names ending in _check, at most 61 characters, not '$name'" >&2; exit 2; }
done
[ "$db" != "$base" ] || { echo "CHECK_DB must be the database built up to 0008, not BASE_DB ($base)" >&2; exit 2; }
owner=hearth_owner
migrator=${db}_m
sql() { psql --no-psqlrc -w -v ON_ERROR_STOP=1 -q "$@"; }

# It stops just before 0008, and the full build is complete.
before=$(sql -d "$db" -Atc "select count(*) filter (where name < '0008'), count(*) filter (where name >= '0008')
  from public.kysely_migration") ||
  { echo "No migrated database $db: build it with CHECK_DB=$db UP_TO=0008 scripts/check-migrations.sh" >&2; exit 2; }
[ "${before#*|}" = 0 ] && [ "${before%|*}" -gt 0 ] ||
  { echo "$db must be built up to (not including) 0008: CHECK_DB=$db UP_TO=0008 scripts/check-migrations.sh" >&2; exit 2; }
[ "$(sql -d "$base" -Atc "select count(*) from public.kysely_migration where name = '0008_revocation_role'")" = 1 ] ||
  { echo "BASE_DB ($base) must be a full build: scripts/check-migrations.sh" >&2; exit 2; }

org=a0000000-0000-4000-8000-000000000001
org2=a0000000-0000-4000-8000-000000000002
# One transaction as a job role in an org, as withOrg() opens one for a job.
as_job() { sql -d "$db" --single-transaction -o /dev/null -c "set local role $1" -c "select set_config('app.org_id', '$2', true)" -c "$3"; }
# Every checkpoint, one line each, to compare before and after.
checkpoints="select string_agg(format('%s %s %s %s %s %s %s %s', org_id, consumer, role_name, last_tx, last_id, processed,
  created_at, updated_at), E'\n' order by org_id, consumer) from public.outbox_checkpoints"

# The seed's org and a second, written as hearth_owner (who owns the tables).
sql -d "$db" --single-transaction -c 'set local role hearth_owner' -f db/seed/tembusu.sql
sql -d "$db" --single-transaction -c 'set local role hearth_owner' \
  -c "insert into public.orgs (id, name) values ('$org2', 'Upgrade Check Two')"
# The offboarding role's own checkpoint, started and then moved on, as C0.6's worker does; one it
# starts under a name 0008 doesn't bind; and one the superuser (who may use every role) starts for
# the purge role under such a name.
as_job hearth_job_offboarding "$org" "
insert into public.outbox_checkpoints (org_id, consumer, role_name) values
  ('$org', 'offboarding', 'hearth_job_offboarding'),
  ('$org', 'side_offboarding', 'hearth_job_offboarding');
update public.outbox_checkpoints set last_tx = '42', last_id = 7, processed = 3, updated_at = now() - interval '1 hour'
where consumer = 'offboarding';"
sql -d "$db" -c "insert into public.outbox_checkpoints (org_id, consumer, role_name, last_tx, last_id, processed)
  values ('$org', 'purge_side', 'hearth_job_purge', '9', 2, 1)"
kept=$(sql -d "$db" -Atc "$checkpoints")

# One outbox event of a type 0007 lists, as C0.6's worker writes one (Hearth's system principal
# acting), so 0009 validates its new outbox_events_type over a row rather than an empty table.
events="select string_agg(format('%s %s %s %s %s %s %s', id, org_id, type, entity_type, entity_id, actor_id, ids), E'\n'
  order by id) from public.outbox_events"
sql -d "$db" --single-transaction -o /dev/null \
  -c "select set_config('app.user_id', 'b0000000-0000-4000-8000-000000000000', true)" \
  -c "insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose, ids)
      select f.org_id, 'flag.changed', 'feature_flag', f.id, 'b0000000-0000-4000-8000-000000000000', 'system',
             'service_operation', jsonb_build_object('key', f.key, 'enabled', f.enabled)
      from public.feature_flags f where f.org_id = '$org' and f.key = 'core.system'"
kept_events=$(sql -d "$db" -Atc "$events")
[ -n "$kept_events" ] || { echo "The outbox event to upgrade over wasn't written" >&2; exit 1; }

# The rows the binding refuses, which 0007 allowed: the offboarding role starts the revocation
# consumer's checkpoint in its own name, and the superuser starts the second org's offboarding one
# for the purge role.
as_job hearth_job_offboarding "$org" "insert into public.outbox_checkpoints (org_id, consumer, role_name, last_tx, last_id)
  values ('$org', 'revocation', 'hearth_job_offboarding', '40', 5)"
sql -d "$db" -c "insert into public.outbox_checkpoints (org_id, consumer, role_name) values ('$org2', 'offboarding', 'hearth_job_purge')"

# 0008 with production's migrator, as check-migrations.sh runs it: a login that can only act as
# hearth_owner.
migrator_pw=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
trap 'sql -d postgres -c "drop role if exists $migrator" >/dev/null 2>&1 || true' EXIT
sql -d postgres -c "set client_min_messages = warning" \
  -c "do \$\$ begin create role $migrator; exception when duplicate_object then null; end \$\$" \
  -c "alter role $migrator login nosuperuser nobypassrls nocreaterole nocreatedb noinherit password '$migrator_pw'" \
  -c "grant $owner to $migrator"
migrate() {
  PGUSER=$migrator PGPASSWORD=$migrator_pw PGDATABASE=$db MIGRATION_ROLE=$owner \
    env -u MIGRATION_DATABASE_URL node apps/server/src/db/migrate.ts 2>&1
}

# With the bad rows there, 0008 is refused, naming each, and nothing of it stays.
if out=$(migrate); then
  printf '%s\n' "$out" >&2
  echo "0008 applied over a revocation checkpoint naming the offboarding role, and an offboarding one naming the purge role" >&2
  exit 1
fi
for row in "revocation ($org, naming hearth_job_offboarding)" "offboarding ($org2, naming hearth_job_purge)"; do
  grep -qF "$row" <<<"$out" || {
    printf '%s\n' "$out" >&2
    echo "0008 was refused, but not for the checkpoint $row: see the migrate: lines above" >&2
    exit 1
  }
done
grep -qF 'A checkpoint names a role other than the one its consumer runs as' <<<"$out" || {
  printf '%s\n' "$out" >&2
  echo "0008 was refused, but not by its check of the checkpoints already there: see the migrate: lines above" >&2
  exit 1
}
[ "$(sql -d "$db" -Atc "select count(*) from public.kysely_migration where name >= '0008'")" = 0 ] &&
  [ "$(sql -d "$db" -Atc "select count(*) from pg_proc p where p.oid = 'public.outbox_checkpoints_own_row()'::regprocedure
         and p.prosrc like '%hearth_job_revocation%'")" = 0 ] ||
  { echo "0008 was refused but left something behind: the database should still be at 0007" >&2; exit 1; }

# With them removed, 0008 applies, and every other checkpoint is as it was.
sql -d "$db" -c "delete from public.outbox_checkpoints
  where (org_id, consumer) in (('$org', 'revocation'), ('$org2', 'offboarding'))"
migrate >&2 || { echo "0008 (or a later migration) failed over checkpoints 0007 allows that keep its binding: see the migrate: lines above." >&2; exit 1; }
[ "$(sql -d "$db" -Atc "select count(*) from public.kysely_migration where name = '0008_revocation_role'")" = 1 ] ||
  { echo "0008_revocation_role was not applied" >&2; exit 1; }
now=$(sql -d "$db" -Atc "$checkpoints")
if [ "$now" != "$kept" ]; then
  echo "0008 changed the checkpoints already there:" >&2
  diff <(printf '%s\n' "$kept") <(printf '%s\n' "$now") | sed 's/^/  /' >&2 || true
  exit 1
fi

# 0009 (C0.9 PR 1): the outbox event is as it was, under a validated check, and every org got
# exactly its register entries from the backfill.
[ "$(sql -d "$db" -Atc "select count(*) from public.kysely_migration where name = '0009_registers'")" = 1 ] ||
  { echo "0009_registers was not applied" >&2; exit 1; }
now_events=$(sql -d "$db" -Atc "$events")
if [ "$now_events" != "$kept_events" ]; then
  echo "The migrations changed the outbox events already there:" >&2
  diff <(printf '%s\n' "$kept_events") <(printf '%s\n' "$now_events") | sed 's/^/  /' >&2 || true
  exit 1
fi
[ "$(sql -d "$db" -Atc "select convalidated from pg_constraint
       where conrelid = 'public.outbox_events'::regclass and conname = 'outbox_events_type'")" = t ] ||
  { echo "0009 left outbox_events_type NOT VALID" >&2; exit 1; }
[ "$(sql -d "$db" -Atc "select string_agg(id::text, ' ' order by id) from public.orgs")" = "$org $org2" ] ||
  { echo "The upgrade check expects exactly the seed's org and the second org" >&2; exit 1; }
backfill=$(sql -d "$db" -At <<'SQL'
-- Each org whose register entries aren't exactly the defaults', untouched.
with want as (
  select (select string_agg(format('%s %s %s %s %s', d.purpose, d.ai, d.pinned, d.needs_switch, d.status), ',' order by d.purpose)
          from public.processing_register_defaults() d) as purposes,
         (select string_agg(format('%s %s', d.provider, d.ai), ',' order by d.provider)
          from public.transfer_register_defaults() d) as providers
)
select coalesce(string_agg(o.id::text, ', ' order by o.id), '')
from public.orgs o cross join want w
where (select string_agg(format('%s %s %s %s %s', r.purpose, r.ai, r.pinned, r.needs_switch, r.status), ',' order by r.purpose)
       from public.processing_register r where r.org_id = o.id) is distinct from w.purposes
   or exists (select 1 from public.processing_register r
              where r.org_id = o.id and (r.version <> 1 or r.recorded_by is not null or r.basis is not null
                                         or r.basis_reference is not null or r.opt_out_days is not null
                                         or r.retention is not null or r.providers <> '{}'))
   or (select string_agg(format('%s %s', t.provider, t.ai), ',' order by t.provider)
       from public.transfer_register t where t.org_id = o.id) is distinct from w.providers
   or exists (select 1 from public.transfer_register t
              where t.org_id = o.id and (t.revision <> 1 or t.updated_by is not null
                                         or pg_catalog.jsonb_strip_nulls(public.transfer_register_facts(t))
                                            <> '{"processing_countries": [], "storage_countries": [], "dpa_terms_confirmed": false}'))
   or exists (select 1 from public.transfer_clearances c where c.org_id = o.id)
SQL
)
[ -z "$backfill" ] ||
  { echo "0009's backfill didn't give these orgs exactly the defaults' register entries: $backfill" >&2; exit 1; }

# The binding holds from here, for checkpoints old and new. Each refusal is named.
refused() { # what is refused, then the statement
  local what=${1//\'/\'\'}
  printf "do \$\$ begin %s; raise exception 'allowed after 0008: %s'; exception when insufficient_privilege then null; end \$\$" "$2" "$what"
}
as_job hearth_job_offboarding "$org" "
update public.outbox_checkpoints set last_tx = '43', last_id = 8, processed = processed + 1, updated_at = now()
where consumer = 'offboarding';
insert into public.outbox_checkpoints (org_id, consumer, role_name) values ('$org', 'side_two', 'hearth_job_offboarding');
$(refused 'the offboarding role started the revocation checkpoint' \
  "insert into public.outbox_checkpoints (org_id, consumer, role_name) values ('$org', 'revocation', 'hearth_job_offboarding')");
$(refused 'the offboarding role started the revocation checkpoint in the revocation role'\''s name' \
  "insert into public.outbox_checkpoints (org_id, consumer, role_name) values ('$org', 'revocation', 'hearth_job_revocation')");
$(refused 'the offboarding role moved the purge role'\''s checkpoint' \
  "update public.outbox_checkpoints set last_id = 9 where consumer = 'purge_side'")"
as_job hearth_job_revocation "$org2" "
insert into public.outbox_checkpoints (org_id, consumer, role_name) values ('$org2', 'revocation', 'hearth_job_revocation');
update public.outbox_checkpoints set last_tx = '1', last_id = 1, processed = 1, updated_at = now() where consumer = 'revocation';
$(refused 'the revocation role started the offboarding checkpoint' \
  "insert into public.outbox_checkpoints (org_id, consumer, role_name) values ('$org2', 'offboarding', 'hearth_job_revocation')");
$(refused 'the revocation role started the offboarding checkpoint in the offboarding role'\''s name' \
  "insert into public.outbox_checkpoints (org_id, consumer, role_name) values ('$org2', 'offboarding', 'hearth_job_offboarding')")"
[ "$(sql -d "$db" -Atc "select string_agg(format('%s %s %s', consumer, last_tx, last_id), ', ' order by consumer)
       from public.outbox_checkpoints where org_id = '$org' and consumer in ('offboarding', 'side_two')")" = 'offboarding 43 8, side_two 0 0' ] ||
  { echo "the offboarding role's moves after 0008 didn't land" >&2; exit 1; }

# The upgraded schema matches a fresh build.
upgraded=$(sql -d "$db" -At -f scripts/schema-digest.sql)
fresh=$(sql -d "$base" -At -f scripts/schema-digest.sql)
if [ "$upgraded" != "$fresh" ]; then
  echo "The upgraded schema ($db) differs from a fresh build ($base):" >&2
  diff <(printf '%s\n' "$fresh") <(printf '%s\n' "$upgraded") | sed 's/^/  /' >&2 || true
  exit 1
fi

echo "OK: 0008 refused checkpoints that break its binding, then upgraded $db over the ones 0007 allows; the rows, the binding and the schema check out, and 0009 kept the outbox event and gave each org its register entries."
