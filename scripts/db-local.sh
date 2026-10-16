#!/usr/bin/env bash
# The local stack's database (docker-compose.yml: postgres, database `hearth`), set up the way AWS
# will be (CLAUDE.md, Database): migrations run as hearth_owner, which owns the database; the api
# and realtime roles connect as hearth_app, which owns nothing and is held to row level security;
# and the worker connects as hearth_worker, which holds nothing itself and takes one job role per
# transaction (0007, TECH-SPEC T18).
#
#   scripts/db-local.sh reset     drop and rebuild `hearth`: migrations, then the Tembusu seed
#                                 (db/seed/tembusu.sql). npm run db:reset.
#   scripts/db-local.sh migrate   apply any new migrations to `hearth`, keeping its data.
#                                 npm run db:migrate.
#
# Both give hearth_app and hearth_worker a login with the local password .env.example's database
# URLs use, which migrations never do (roles are created without one; in AWS, infra/ sets IAM
# sign-in). Roles belong to the whole server, so this refuses anything but a local server, as the
# other DB scripts do. It needs psql and Node 24 with the repo's packages installed (npm ci), and
# connects as the Compose stack's superuser through the standard PG* variables (defaults:
# postgres:postgres@127.0.0.1:5432). CI runs `reset` before the server's start-up check.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export PGHOST=${PGHOST:-127.0.0.1} PGPORT=${PGPORT:-5432} PGUSER=${PGUSER:-postgres} PGPASSWORD=${PGPASSWORD:-postgres}
db=hearth
owner=hearth_owner
# The local-only password .env.example's database URLs use. Not a secret: the server is bound to
# 127.0.0.1 and holds only the seed's made-up data.
app_password=hearth-local
sql() { psql --no-psqlrc -w -v ON_ERROR_STOP=1 -q "$@"; }

command=${1:-}
case "$command" in
  reset | migrate) ;;
  *) echo "Usage: scripts/db-local.sh reset|migrate" >&2; exit 2 ;;
esac

case "$PGHOST" in
  127.0.0.1 | localhost | ::1) ;;
  *) echo "Refusing to touch $PGHOST: this sets up the local stack's database only." >&2; exit 2 ;;
esac
# These would send psql somewhere other than PGHOST says.
for var in PGHOSTADDR PGSERVICE PGSERVICEFILE; do
  [ -z "${!var:-}" ] || { echo "Unset $var: this sets up the local stack's database only, at PGHOST." >&2; exit 2; }
done
rds=$(sql -d postgres -Atc "select count(*) from pg_roles where rolname = 'rds_superuser'") ||
  { echo "Can't connect to Postgres: is the local stack up (docker compose up -d --wait)?" >&2; exit 2; }
[ "$rds" = 0 ] || { echo "Refusing to run on an RDS server." >&2; exit 2; }
[ "$(sql -d postgres -Atc "select rolsuper from pg_roles where rolname = current_user")" = t ] ||
  { echo "Connect as a superuser (PGUSER): this creates roles and the database." >&2; exit 2; }

# hearth_owner, as scripts/check-migrations.sh and infra/'s bootstrap create it.
sql -d postgres -c "set client_min_messages = warning" \
  -c "do \$\$ begin create role $owner nologin createrole; exception when duplicate_object then null; end \$\$" \
  -c "alter role $owner nosuperuser nobypassrls createrole"
if [ "$command" = reset ]; then
  sql -d postgres -c "set client_min_messages = warning" -c "drop database if exists $db with (force)" \
    -c "create database $db owner $owner template template0"
else
  [ "$(sql -d postgres -Atc "select count(*) from pg_database where datname = '$db'")" = 1 ] ||
    sql -d postgres -c "create database $db owner $owner template template0"
  # A database made before this script (docker-compose.yml creates `hearth` owned by postgres)
  # passes to hearth_owner, so the migrations can create tables in its public schema.
  sql -d postgres -c "alter database $db owner to $owner"
fi

# The migrate login, like CI's (scripts/check-migrations.sh): a NOINHERIT login whose only right
# is to take hearth_owner, so a migration that switches role gains nothing here either. It's
# dropped afterwards. The migrator connects with the PG* variables checked above, so nothing goes
# into a URL; an inherited MIGRATION_DATABASE_URL would win over them, so it's dropped.
migrator=hearth_local_m
migrator_pw=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
trap 'sql -d postgres -c "drop role if exists $migrator" >/dev/null 2>&1 || true' EXIT
sql -d postgres -c "set client_min_messages = warning" \
  -c "do \$\$ begin create role $migrator; exception when duplicate_object then null; end \$\$" \
  -c "alter role $migrator login nosuperuser nobypassrls nocreaterole nocreatedb noinherit password '$migrator_pw'" \
  -c "grant $owner to $migrator"
PGUSER=$migrator PGPASSWORD=$migrator_pw PGDATABASE=$db MIGRATION_ROLE=$owner \
  env -u MIGRATION_DATABASE_URL node apps/server/src/db/migrate.ts

# The migrations created hearth_app and hearth_worker without a login; locally they sign in with a
# password.
sql -d postgres -c "alter role hearth_app login password '$app_password'" \
  -c "alter role hearth_worker login password '$app_password'"

logins="the api and realtime roles connect as hearth_app, the worker as hearth_worker"
if [ "$command" = reset ]; then
  sql -d "$db" --single-transaction -c "set local role $owner" -f db/seed/tembusu.sql
  echo "db-local: rebuilt $db with the Tembusu seed; $logins."
else
  echo "db-local: $db is up to date; $logins."
fi
