#!/usr/bin/env bash
# Run the DB tests in db/tests/ against the scratch database scripts/check-migrations.sh just
# built. A test is a plain .sql file that fails by raising an error, e.g. a DO block that
# switches to a role (set local role ...) and raises if it can see a row it shouldn't. Files run
# in name order, each inside a transaction that is rolled back afterwards, so they can't affect
# each other; don't commit inside one.
#
# Usage: scripts/check-migrations.sh && scripts/test-db.sh
# Same connection settings as check-migrations.sh.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export PGHOST=${PGHOST:-127.0.0.1} PGPORT=${PGPORT:-5432} PGUSER=${PGUSER:-postgres} PGPASSWORD=${PGPASSWORD:-postgres}
db=${CHECK_DB:-hearth_check}

shopt -s nullglob
tests=(db/tests/*.sql)
if [ "${#tests[@]}" -eq 0 ]; then
  echo "No DB tests yet (db/tests/*.sql)."
  exit 0
fi

failed=0
for path in "${tests[@]}"; do
  if { echo 'begin;'; cat "$path"; echo; echo 'rollback;'; } |
     psql --no-psqlrc -w -v ON_ERROR_STOP=1 -q -d "$db" >/dev/null; then
    echo "ok    $path"
  else
    echo "FAIL  $path" >&2
    failed=1
  fi
done
exit "$failed"
