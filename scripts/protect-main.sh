#!/usr/bin/env bash
# Apply .github/rulesets/protect-main.json to GitHub: creates the ruleset, or
# updates it in place if one with the same name exists. Safe to re-run.
#
# Needs the gh CLI logged in as a repo admin. Rulesets on a private repo need
# GitHub Team (or higher); on Free the API answers 403 "Upgrade to GitHub Pro".
#
# Usage: scripts/protect-main.sh [owner/repo]   (defaults to this clone's repo)
set -euo pipefail

name=protect-main  # must match "name" in the JSON
ruleset="$(git rev-parse --show-toplevel)/.github/rulesets/$name.json"
repo=${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}

id=$(gh api --paginate "repos/$repo/rulesets?includes_parents=false" --jq ".[] | select(.name == \"$name\") | .id")
if [ -n "$id" ]; then
  gh api -X PUT "repos/$repo/rulesets/$id" --input "$ruleset" --silent
  echo "Updated ruleset $name (#$id) on $repo"
else
  id=$(gh api -X POST "repos/$repo/rulesets" --input "$ruleset" --jq .id)
  echo "Created ruleset $name (#$id) on $repo"
fi

echo "Rules now enforced on main:"
gh api "repos/$repo/rules/branches/main" --jq '.[].type' | sed 's/^/  - /'
