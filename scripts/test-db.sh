#!/usr/bin/env bash
# Run the DB tests in db/tests/ against the scratch database scripts/check-migrations.sh just
# built. A test is a plain .sql file that fails by raising an error, e.g. a DO block that raises
# if the role it switched to (set local role ...) can see a row it shouldn't. A test that doesn't
# switch role runs as a superuser and proves nothing. Every .sql file directly in db/tests/ runs
# as a test, in name order; keep shared fixtures in a subfolder and include them with \ir.
#
# Each test runs inside a transaction that is rolled back afterwards, with deferred constraints
# checked at the end. A test that ends that transaction itself (COMMIT, ROLLBACK, \connect) or
# turns ON_ERROR_STOP off fails, and its changes may stay in the scratch database until
# check-migrations.sh rebuilds it.
#
# Usage: scripts/check-migrations.sh && scripts/test-db.sh
# Same connection settings and CHECK_DB as check-migrations.sh.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export PGHOST=${PGHOST:-127.0.0.1} PGPORT=${PGPORT:-5432} PGUSER=${PGUSER:-postgres} PGPASSWORD=${PGPASSWORD:-postgres}
db=${CHECK_DB:-hearth_check}
[[ $db =~ ^[a-z_][a-z0-9_]{0,56}_check$ ]] ||
  { echo "CHECK_DB must be a lower-case name ending in _check, at most 63 characters, not '$db'" >&2; exit 2; }

shopt -s nullglob
tests=(db/tests/*.sql)
if [ "${#tests[@]}" -eq 0 ]; then
  echo "No DB tests yet (db/tests/*.sql)."
  exit 0
fi

# The transaction's start time is recorded before the test and checked after it; SQL can't move
# it, so a test that ends the transaction can't make this match again. An error the test let
# through has aborted the transaction, so the check fails then too.
mark="select set_config('hearth.test_txn', extract(epoch from transaction_timestamp())::text, true)"
guard="do \$\$ begin if current_setting('hearth.test_txn', true) is distinct from extract(epoch from transaction_timestamp())::text then
  raise exception 'the test ended its own transaction (COMMIT, ROLLBACK or \\connect); its changes may have stayed in $db';
end if; end \$\$"
failed=0
for path in "${tests[@]}"; do
  # -f keeps psql's file:line prefix on errors and lets \ir find files next to the test.
  if psql --no-psqlrc -w -v ON_ERROR_STOP=1 -q -d "$db" \
       -c 'begin' -c "$mark" -f "$path" \
       -c '\set ON_ERROR_STOP 1' -c 'set constraints all immediate' -c "$guard" -c 'rollback' >/dev/null; then
    echo "ok    $path"
  else
    echo "FAIL  $path" >&2
    failed=1
  fi
done
exit "$failed"
