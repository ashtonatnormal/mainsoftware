#!/usr/bin/env bash
# Build a scratch database from db/migrations/ and check it. Fails if:
#   - a migration file isn't named <NNNN>_<name>.sql (lower-case name), or two share a number
#   - a migration fails. Each runs in its own transaction, in name order, on an empty database,
#     so CREATE INDEX CONCURRENTLY and the like don't belong in a migration file.
#   - a table has row level security off (CLAUDE.md: RLS on every table). Tables that belong to
#     an extension are skipped.
#
# The scratch database ($CHECK_DB, default hearth_check) is dropped and rebuilt on every run, so
# the database you develop against is never touched. scripts/test-db.sh then runs against it.
# Roles belong to the whole server and outlive the scratch database, so a migration that creates
# a role must skip it when it already exists (production has it too).
#
# Usage: scripts/check-migrations.sh && scripts/test-db.sh
# Needs psql. Connects with the standard PG* variables; any that are unset default to the local
# stack (postgres:postgres@127.0.0.1:5432).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export PGHOST=${PGHOST:-127.0.0.1} PGPORT=${PGPORT:-5432} PGUSER=${PGUSER:-postgres} PGPASSWORD=${PGPASSWORD:-postgres}
db=${CHECK_DB:-hearth_check}
# The database gets dropped, so only accept a plain name that says it's a scratch one.
[[ $db =~ ^[a-z_][a-z0-9_]*_check$ ]] || { echo "CHECK_DB must be a lower-case name ending in _check, not '$db'" >&2; exit 2; }
sql() { psql --no-psqlrc -w -v ON_ERROR_STOP=1 -q "$@"; }  # -w: fail rather than prompt

shopt -s nullglob
files=() status=0
for path in db/migrations/*; do
  [ -f "$path" ] || continue  # e.g. a migration tool's meta/ folder
  name=${path##*/}
  if [[ ! $name =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]]; then
    echo "Bad migration name (must be <NNNN>_<name>.sql, lower case): $path" >&2
    status=1
  fi
  files+=("$path")
done
dupes=$(for path in ${files[@]+"${files[@]}"}; do name=${path##*/}; echo "${name%%_*}"; done | LC_ALL=C sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "Two migrations share a number:" >&2
  sed 's/^/  /' <<<"$dupes" >&2
  status=1
fi
[ "$status" -eq 0 ] || exit "$status"

sql -d postgres -c "set client_min_messages = warning" \
  -c "drop database if exists $db with (force)" -c "create database $db"
# Every name starts with its own 4-digit number, so the glob's order is the migration order.
for path in ${files[@]+"${files[@]}"}; do
  sql -d "$db" --single-transaction -f "$path" || { echo "Failed: $path" >&2; exit 1; }
done

no_rls=$(sql -d "$db" -Atc "
  select format('%I.%I', n.nspname, c.relname)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and not c.relrowsecurity
    and n.nspname not like 'pg\_%'
    and n.nspname <> 'information_schema'
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
  order by 1")
if [ -n "$no_rls" ]; then
  echo "Row level security is off (add: alter table <name> enable row level security;):" >&2
  sed 's/^/  /' <<<"$no_rls" >&2
  exit 1
fi

echo "OK: ${#files[@]} migration(s) applied to $db; RLS is on for every table."
