#!/usr/bin/env bash
# Build a scratch database from db/migrations/ the way production will, and check it. Fails if:
#   - a migration file isn't named <NNNN>_<name>.sql (lower case), two share a number, a folder or
#     a hidden file sits in db/migrations/ (nothing in it would be applied), a file is over 120 KB,
#     or a line starts with a psql meta-command
#   - the migrations fail. They're applied by the same Kysely migrator production uses
#     (apps/server/src/db/migrate.ts; T3): in name order, in one transaction on an empty
#     database, each file sent to the server unparsed, so a psql meta-command anywhere is a
#     syntax error. The session logs in as a throwaway non-superuser role whose only power is to
#     act as hearth_owner (NOSUPERUSER; CLAUDE.md, Database), so a migration can't fall back on
#     superuser rights. A migration that ends the transaction itself (COMMIT, ROLLBACK) or leaves
#     a different role in place fails, naming the file.
#   - the result breaks a Database rule in CLAUDE.md: a table without org_id (orgs aside: its id
#     is the org id), a table with row level security off, a view without security_invoker, a
#     materialized view or foreign table granted to anyone, anything granted to PUBLIC, a
#     function PUBLIC can execute, a SECURITY DEFINER function without search_path = '',
#     TRUNCATE, TRIGGER or REFERENCES (on a table or a column) held by anyone but the owner, an
#     object not owned by hearth_owner, a database hearth_owner doesn't own, or a hearth_app role
#     that could bypass RLS. Objects that belong to an extension and the constructor functions
#     Postgres makes for a range type are skipped. The migrator's own ledger (kysely_migration,
#     kysely_migration_lock) has no org_id or row level security, so those two checks skip it by
#     name; it must still be the owner's and granted to nobody.
#
# The scratch database ($CHECK_DB, default hearth_check) is dropped and rebuilt on every run, so
# the database you develop against is never touched; scripts/test-db.sh then runs against it.
# Roles belong to the whole server, so this runs only on the local stack or in CI: it refuses an
# RDS server. It creates hearth_owner when missing and the untrusted extensions listed below in
# the scratch database (in AWS, infra/ does that bootstrap); migrations keep their
# 'create extension if not exists', which is then a no-op.
#
# UP_TO=NNNN builds the database only up to the migration before NNNN, for an upgrade test:
# scripts/check-<name>-upgrade.sh then loads production-shaped data and applies NNNN.
#
# A scratch build starts empty, so it can't see a migration numbered below one production has
# already applied; scripts/check-migration-order.sh, run against main in CI, does.
#
# Usage: scripts/check-migrations.sh && scripts/test-db.sh
# Needs psql and Node 24 with the repo's packages installed (npm ci). Connects as a superuser with
# the standard PG* variables; any that are unset default to the local stack
# (postgres:postgres@127.0.0.1:5432).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export PGHOST=${PGHOST:-127.0.0.1} PGPORT=${PGPORT:-5432} PGUSER=${PGUSER:-postgres} PGPASSWORD=${PGPASSWORD:-postgres}
db=${CHECK_DB:-hearth_check}
owner=hearth_owner
# Logs in for the migration run and may only act as $owner. One per scratch database, so two runs
# against different databases on one server don't change each other's password.
migrator=${db}_m
# Untrusted extensions hearth_owner can't create (add vector with the migration that first uses
# it). infra/ creates the same ones as the RDS master user.
superuser_extensions=()
# The database gets dropped, so only accept a plain name that says it's a scratch one, short
# enough that Postgres won't truncate it (names stop at 63 bytes) into some other database's name,
# with room for the migrator role's _m.
[[ $db =~ ^[a-z_][a-z0-9_]{0,54}_check$ ]] ||
  { echo "CHECK_DB must be a lower-case name ending in _check, at most 61 characters, not '$db'" >&2; exit 2; }
up_to=${UP_TO:-}
[[ -z $up_to || $up_to =~ ^[0-9]{4}$ ]] || { echo "UP_TO must be a 4-digit migration number, not '$up_to'" >&2; exit 2; }
sql() { psql --no-psqlrc -w -v ON_ERROR_STOP=1 -q "$@"; }  # -w: fail rather than prompt

shopt -s nullglob dotglob  # hidden entries are listed too, so they're refused
named=() files=() status=0
for path in db/migrations/*; do
  name=${path##*/}
  if [ -d "$path" ]; then
    echo "Unexpected folder in db/migrations/ (nothing in it would be applied): $path" >&2
    status=1; continue
  fi
  if [[ ! $name =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]]; then
    echo "Bad migration name (must be <NNNN>_<name>.sql, lower case): $path" >&2
    status=1; continue
  fi
  if meta=$(grep -n '^[[:space:]]*\\' "$path"); then
    echo "psql meta-command in $path (migrations are plain SQL for production's migrator):" >&2
    sed 's/^/  line /' <<<"$meta" >&2
    status=1
  fi
  if [ "$(wc -c <"$path")" -gt 120000 ]; then
    echo "$path is over 120 KB; split it" >&2
    status=1
  fi
  named+=("$path")
  # Every name starts with its own 4-digit number, so the glob's order is the migration order.
  if [ -z "$up_to" ] || [[ ${name%%_*} < $up_to ]]; then files+=("$path"); fi
done
dupes=$(for path in ${named[@]+"${named[@]}"}; do name=${path##*/}; echo "${name%%_*}"; done | LC_ALL=C sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "Two migrations share a number:" >&2
  sed 's/^/  /' <<<"$dupes" >&2
  status=1
fi
[ "$status" -eq 0 ] || exit "$status"
if [ -n "$up_to" ]; then
  found=
  for path in ${named[@]+"${named[@]}"}; do
    case "${path##*/}" in "${up_to}"_*) found=1 ;; esac
  done
  [ -n "$found" ] || { echo "UP_TO=$up_to: no migration with that number in db/migrations/" >&2; exit 2; }
fi

rds=$(sql -d postgres -Atc "select count(*) from pg_roles where rolname = 'rds_superuser'") ||
  { echo "Can't connect to Postgres: check the PG* settings and that the local stack is running." >&2; exit 2; }
if [ "$rds" != 0 ]; then
  echo "Refusing to run on an RDS server: migrations change roles, which the whole server shares. Point PG* at the local stack." >&2
  exit 2
fi
[ "$(sql -d postgres -Atc "select rolsuper from pg_roles where rolname = current_user")" = t ] ||
  { echo "Connect as a superuser (PGUSER): this script creates roles and runs migrations as $owner." >&2; exit 2; }

migrator_pw=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
trap 'sql -d postgres -c "drop role if exists $migrator" >/dev/null 2>&1 || true' EXIT
sql -d postgres -c "set client_min_messages = warning" \
  -c "do \$\$ begin create role $owner nologin createrole; exception when duplicate_object then null; end \$\$" \
  -c "alter role $owner nosuperuser nobypassrls createrole" \
  -c "do \$\$ begin create role $migrator; exception when duplicate_object then null; end \$\$" \
  -c "alter role $migrator login nosuperuser nobypassrls nocreaterole nocreatedb noinherit password '$migrator_pw'" \
  -c "grant $owner to $migrator" \
  -c "drop database if exists $db with (force)" \
  -c "create database $db owner $owner template template0"
for ext in ${superuser_extensions[@]+"${superuser_extensions[@]}"}; do
  sql -d "$db" -c "create extension if not exists \"$ext\""
done

# The migrator checks around every file that the session is still hearth_owner and still in the
# batch's one transaction, and names the file that broke either rule. It connects with the PG*
# variables, so nothing has to be put into a URL.
before=()
[ -z "$up_to" ] || before=(--before "$up_to")
PGUSER=$migrator PGPASSWORD=$migrator_pw PGDATABASE=$db MIGRATION_ROLE=$owner \
  node apps/server/src/db/migrate.ts ${before[@]+"${before[@]}"} >&2 ||
  { echo "Migrations failed: see the migrate: lines above." >&2; exit 1; }

checks="
with rel as (
  select c.oid, c.relkind, c.relrowsecurity, c.relacl, c.relowner, c.reloptions,
         format('%I.%I', n.nspname, c.relname) as name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
    and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
), ledger as (
  -- The migrator's ledger, which it creates itself (as hearth_owner): it has no org_id or row
  -- level security, so it is checked for those two only by name, and must be granted to nobody.
  select oid from rel where name in ('public.kysely_migration', 'public.kysely_migration_lock')
), fn as (
  select p.oid, p.prosecdef, p.proconfig, p.proowner, p.proacl,
         format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as name
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
    and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                      and (d.deptype = 'e' or (d.deptype = 'i' and d.refclassid = 'pg_type'::regclass)))
), problems(problem, object) as (
  select 'Table without an org_id column (every record belongs to an org, ACC-11)', name
  from rel where relkind in ('r', 'p') and name <> 'public.orgs' and oid not in (select oid from ledger)
    and not exists (select 1 from pg_attribute a where a.attrelid = rel.oid and a.attname = 'org_id' and not a.attisdropped)
  union all
  select 'Row level security is off (alter table <name> enable row level security)', name
  from rel where relkind in ('r', 'p') and not relrowsecurity and oid not in (select oid from ledger)
  union all
  select 'The migrator''s ledger is granted to someone (only its owner may touch it)', format('%s: %s', name, a.privilege_type)
  from rel cross join lateral aclexplode(relacl) a
  where oid in (select oid from ledger) and a.grantee <> relowner
  union all
  select 'Granted to PUBLIC (grant to a named role instead)', format('%s: %s', name, a.privilege_type)
  from rel cross join lateral aclexplode(relacl) a
  where a.grantee = 0
  union all
  select 'Granted to PUBLIC (grant to a named role instead)', format('%s.%s: %s', name, att.attname, a.privilege_type)
  from rel join pg_attribute att on att.attrelid = rel.oid and att.attnum > 0
  cross join lateral aclexplode(att.attacl) a
  where a.grantee = 0
  union all
  select 'TRUNCATE, TRIGGER or REFERENCES held by someone other than the owner (they ignore RLS)',
         format('%s.%s: %s to %s', name, att.attname, a.privilege_type, a.grantee::regrole::text)
  from rel join pg_attribute att on att.attrelid = rel.oid and att.attnum > 0
  cross join lateral aclexplode(att.attacl) a
  where a.grantee <> relowner and a.grantee <> 0 and a.privilege_type = 'REFERENCES'
  union all
  select 'View without security_invoker (create view <name> with (security_invoker = true))', name
  from rel where relkind = 'v' and not coalesce((select o.option_value::boolean
    from pg_options_to_table(reloptions) o where o.option_name = 'security_invoker'), false)
  union all
  select 'Materialized view or foreign table granted to someone (RLS can''t protect it)', name
  from rel where relkind in ('m', 'f')
    and exists (select 1 from aclexplode(relacl) a where a.grantee <> relowner)
  union all
  select 'TRUNCATE, TRIGGER or REFERENCES held by someone other than the owner (they ignore RLS)',
         format('%s: %s to %s', name, a.privilege_type,
                case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end)
  from rel cross join lateral aclexplode(relacl) a
  where relkind in ('r', 'p') and a.grantee <> relowner
    and a.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')
  union all
  select 'Function PUBLIC can execute (revoke execute on function <name> from public)', name
  from fn where exists (select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) a
                        where a.grantee = 0 and a.privilege_type = 'EXECUTE')
  union all
  select 'SECURITY DEFINER function without search_path = '''' (alter function <name> set search_path = '''')', name
  from fn where prosecdef and not coalesce('search_path=\"\"' = any(proconfig), false)
  union all
  select 'Not owned by $owner', format('%s (owned by %s)', name, pg_get_userbyid(relowner))
  from rel where relowner <> '$owner'::regrole
  union all
  select 'Not owned by $owner', format('%s (owned by %s)', name, pg_get_userbyid(proowner))
  from fn where proowner <> '$owner'::regrole
  union all
  select 'Not owned by $owner', format('schema %I (owned by %s)', n.nspname, pg_get_userbyid(n.nspowner))
  from pg_namespace n
  where n.nspname not like 'pg\_%' and n.nspname not in ('information_schema', 'public')
    and n.nspowner <> '$owner'::regrole
    and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_namespace'::regclass and d.objid = n.oid and d.deptype = 'e')
  union all
  select 'hearth_app could bypass RLS', 'hearth_app is a superuser or has BYPASSRLS'
  from pg_roles where rolname = 'hearth_app' and (rolsuper or rolbypassrls)
  union all
  select 'hearth_app could bypass RLS', 'hearth_app is a member of ' || r.rolname
  from pg_roles a cross join pg_roles r
  where a.rolname = 'hearth_app' and r.oid <> a.oid and pg_has_role(a.oid, r.oid, 'MEMBER')
    and (r.rolsuper or r.rolbypassrls or exists (select 1 from rel where rel.relowner = r.oid)
         or r.oid = (select datdba from pg_database where datname = current_database()))
  union all
  select 'The database is not owned by $owner', pg_get_userbyid(datdba)
  from pg_database where datname = current_database() and datdba <> '$owner'::regrole
)
select problem, object from problems order by 1, 2"
problems=$(sql -d "$db" -At -F $'\t' -c "$checks")
if [ -n "$problems" ]; then
  awk -F '\t' '$1 != last { print $1 ":"; last = $1 } { print "  " $2 }' <<<"$problems" >&2
  exit 1
fi

if [ -n "$up_to" ]; then
  echo "OK: built $db up to (not including) $up_to: ${#files[@]} migration(s); every check passes."
else
  echo "OK: ${#files[@]} migration(s) applied to $db; every check passes."
fi
