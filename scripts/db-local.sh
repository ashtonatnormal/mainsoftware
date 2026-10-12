#!/usr/bin/env bash
# The local stack's database (docker-compose.yml: postgres, database `hearth`), set up the way AWS
# will be (CLAUDE.md, Database): migrations run as hearth_owner, which owns the database, and the
# server connects as hearth_app, which owns nothing and is held to row level security.
#
#   scripts/db-local.sh reset     drop and rebuild `hearth`: migrations, then the Tembusu seed
#                                 (db/seed/tembusu.sql). npm run db:reset.
#   scripts/db-local.sh migrate   apply any new migrations to `hearth`, keeping its data.
#                                 npm run db:migrate.
#
# Both give hearth_app a login with the local password in .env.example's DATABASE_URL, which
# migrations never do (roles are created without one; in AWS, infra/ sets IAM sign-in). Roles
# belong to the whole server, so this refuses anything but a local server, as the other DB
# scripts do. It needs psql and Node 24 with the repo's packages installed (npm ci), and connects
# as the Compose stack's superuser through the standard PG* variables (defaults: postgres:postgres
# @127.0.0.1:5432). CI runs `reset` before the server's start-up check.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export PGHOST=${PGHOST:-127.0.0.1} PGPORT=${PGPORT:-5432} PGUSER=${PGUSER:-postgres} PGPASSWORD=${PGPASSWORD:-postgres}
db=hearth
owner=hearth_owner
# The local-only password .env.example's DATABASE_URL uses. Not a secret: the server is bound
# to 127.0.0.1 and holds only the seed's made-up data.
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

# The migrator connects with the PG* variables, so nothing has to be put into a URL.
PGDATABASE=$db MIGRATION_ROLE=$owner node apps/server/src/db/migrate.ts

# The migrations created hearth_app without a login; locally it signs in with a password.
sql -d postgres -c "alter role hearth_app login password '$app_password'"

if [ "$command" = reset ]; then
  sql -d "$db" --single-transaction -c "set local role $owner" -f db/seed/tembusu.sql
  echo "db-local: rebuilt $db with the Tembusu seed; the server connects as hearth_app."
else
  echo "db-local: $db is up to date; the server connects as hearth_app."
fi
