#!/usr/bin/env bash
# Checks a branch's migrations against main (T3; CLAUDE.md, Database). A scratch build starts
# empty, so scripts/check-migrations.sh can't see this; production can, because it has already
# applied main's migrations. Fails if the branch:
#   - adds a migration numbered at or below the highest one on main (two PRs merged out of order,
#     or one branched before another's migration landed). Kysely's migrator would refuse it in
#     production, but only after the merge. Renumber it above main's highest.
#   - changes, renames or deletes a migration main already has. Production has applied it, so
#     an edit would never run there and the databases would drift. Add a new migration instead.
#
# Usage: scripts/check-migration-order.sh [BASE]   (BASE defaults to origin/main)
# CI runs it on pull requests against the PR's base branch. It compares the branch with where it
# meets BASE (git diff BASE...HEAD), and BASE's own highest number, so main having moved on since
# the branch started is accounted for.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
base=${1:-origin/main}
git rev-parse --verify --quiet "$base^{commit}" >/dev/null ||
  { echo "check-migration-order: no commit '$base' (fetch it first, e.g. git fetch origin main)" >&2; exit 2; }

highest=$(git ls-tree -r --name-only "$base" db/migrations/ | sed -n 's#^db/migrations/\([0-9]\{4\}\)_.*\.sql$#\1#p' | LC_ALL=C sort | tail -n 1)
status=0
while IFS=$'\t' read -r change path; do
  [ -n "$path" ] || continue
  name=${path##*/}
  case "$change" in
    A)
      number=${name%%_*}
      if [[ $number =~ ^[0-9]{4}$ && -n $highest && ! $number > $highest ]]; then
        echo "$path is numbered $number, but $base already has migrations up to $highest: renumber it above $highest" >&2
        status=1
      fi
      ;;
    *)
      echo "$path is on $base, so production has applied it; leave it as it is and add a new migration instead" >&2
      status=1
      ;;
  esac
done < <(git diff --no-renames --name-status "$base...HEAD" -- db/migrations/)

if [ "$status" -eq 0 ]; then
  echo "OK: every migration this branch adds numbers above ${highest:-none} (the highest on $base), and none of $base's changed."
fi
exit "$status"
