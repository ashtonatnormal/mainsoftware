#!/usr/bin/env bash
# Claude Code Stop hook: after every Claude response, commit the working tree
# and push the current branch to GitHub. Each response is a checkpoint, so
# unfinished work is pushed too (squash-merge the PR).
#
# Guardrails (see CLAUDE.md):
#   - never commits or pushes on main/master or off a local branch
#   - never commits .env/key/credential files (only .env.example is allowed)
#     or files containing token-shaped secrets
#   - never pushes unpushed commits (e.g. ones Claude made itself, merges
#     included) that touch such files or tokens or carry a token in their
#     message; those, and octopus merges, are left for a manual push
#   - skips while a merge/rebase/cherry-pick is in progress or a conflict is
#     unresolved
#   - never force-pushes and never skips git hooks (pre-push hooks get 60 s)
#   - pushes only the branch commit it scanned: no tags, submodule commits or
#     git-lfs objects
#   - leaves nested repositories (e.g. Claude's .claude/worktrees/) uncommitted
#   - formats the files it commits with the repo's own Biome first (never npx);
#     a file Biome can't parse is committed as it is
#   - commits a new file only in a source folder or as a known root config file,
#     and never one shaped like data (this repo is public; CLAUDE.md, Git).
#     Changes to tracked files are always committed. Other new files stay
#     uncommitted and are named in the message; if one is already staged, the
#     checkpoint is refused and the index left as it was
#
# Opt out for a session: HEARTH_AUTOPUSH=0 claude
set -uo pipefail
user_lc=${LC_ALL-}  # git hooks still run in the caller's locale (commit, push)
export LC_ALL=C  # byte-wise regexes: invalid UTF-8 in a name or file can't dodge them
# Git sees the objects a push sends (not git-replace stand-ins), and pathspecs
# mean what this script writes.
export GIT_NO_REPLACE_OBJECTS=1
unset GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS

# Report to the user and stop. Hook output must be JSON: fold whitespace, then
# drop control characters, quotes and backslashes so the string stays valid.
say() {
  local text
  text=$(printf '%s%s' "$1" "${note-}" | tr '\n\r\t' '   ' | tr -d '\000-\037"\\')
  printf '{"systemMessage": "auto-push: %s"}\n' "$text"
  exit 0
}

# Git can leave long-lived children behind (credential-cache, fsmonitor and gc
# daemons): run it with the lock's fd 9 closed so they never hold the lock.
# Through env, an external command: bash 3.2 hands a builtin's or function's
# children a saved copy of a redirected fd.
git() { env git "$@" 9>&-; }

# Run a command for at most $1 seconds, in a new session so it has no terminal
# to prompt on, then kill its whole process group (perl: macOS has no timeout).
# If this run is killed first, that group goes with it.
bounded() {
  if command -v perl >/dev/null 2>&1; then
    perl -MPOSIX=setsid -e '$t = shift; $p = fork // exit 127;
      if (!$p) { setsid; exec @ARGV or exit 127 }
      $SIG{TERM} = $SIG{HUP} = $SIG{INT} = sub { kill KILL => -$p; exit 143 };
      $SIG{ALRM} = sub { kill KILL => -$p; exit 124 }; alarm $t;
      waitpid $p, 0; exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$@" 9>&-
  elif command -v timeout >/dev/null 2>&1; then
    timeout "$@" 9>&-
  else
    shift; env "$@" 9>&-  # nothing to bound it with
  fi
}
# Run a command in a new session, unbounded: a git hook that reads /dev/tty
# (like commitizen's) fails at once instead of reading what the user types.
notty() {
  if command -v perl >/dev/null 2>&1; then
    perl -MPOSIX=setsid -e 'setsid; exec @ARGV or exit 127' "$@" 9>&-
  else
    env "$@" 9>&-
  fi
}

# Paths that hold secrets (npm/MCP configs, <name>.env files and Supabase
# signing keys too), and token shapes for private keys (PEM, PGP), JWTs
# (Supabase keys), Anthropic, OpenAI and Google keys, Supabase secret and access
# tokens, GitHub, npm, AWS and SendGrid keys (sk- also right after a \n, \r or
# \t escape), AWS secret access keys and LiveKit API secrets assigned to their
# usual variable names, and Postgres and Valkey/Redis URLs (postgresql+driver://
# and rediss:// too) with a password (it may hold @) that isn't an upper-case
# $VAR, [..], <..> or {..} placeholder, for a dotted host name or an IP (127.x,
# ::1, localhost and other bare names are local dev).
SECRET_FILES='(^|/)(\.env[^/]*(/.*)?|[^/]*\.env|\.netrc|\.npmrc|\.pgpass|\.mcp\.json|signing_keys[^/]*\.json|credentials[^/]*\.json|[^/]*service[-_]?account[^/]*\.json|[^/]*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519))$'
SECRET_TOKENS='-----BEGIN ([A-Z]+ )*PRIVATE KEY( BLOCK)?-----|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(^|[^A-Za-z0-9_-]|\\[nrt])sk-((ant|proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})|AIza[0-9A-Za-z_-]{35}|sb_secret_[A-Za-z0-9_-]{10,}|sbp_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{30,}|npm_[A-Za-z0-9]{36}|(AKIA|ASIA)[0-9A-Z]{16}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}|(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)[^A-Za-z0-9/+:=]{0,3}[:=][^A-Za-z0-9/+]{0,3}[A-Za-z0-9/+]{40}([^A-Za-z0-9/+]|$)|(LIVEKIT_API_SECRET|livekit_api_secret|livekitApiSecret)[^A-Za-z0-9:=]{0,3}[:=][^A-Za-z0-9]{0,3}[A-Za-z0-9]{32,}([^A-Za-z0-9(._-]|$)|(postgres(ql)?(\+[A-Za-z0-9]+)?|rediss?|valkeys?)://[^@/:[:space:]]*:([^/[:space:]$<[{]|\$[^{A-Z_/[:space:]]|\$[A-Z_][A-Z0-9_]*[^A-Z0-9_@/[:space:]])[^/[:space:]]*@([^@/:[:space:]]*\.[A-Za-z]|\[[^:]|[2-9]|1[^2]|12[^7])'
ENV_EXAMPLE='(^|/)\.env\.example$'
# New files a checkpoint may commit: source folders and root config files, but
# nothing shaped like data, in any folder. Matched without regard to case.
CHECKPOINT_NEW='^((apps|packages|db|docs|scripts|infra|demo|spike|\.github|\.claude)/.+|(CLAUDE|AGENTS|README)\.md|LICENSE|package(-lock)?\.json|tsconfig([.-][^/]*)?\.json|biome\.jsonc?|docker-compose\.ya?ml|\.gitignore|\.env\.example|\.nvmrc|\.editorconfig|\.coderabbit\.yaml|\.pr_agent\.toml|renovate\.json)$'
DATA_SHAPED='\.(csv|tsv|jsonl|ndjson|xlsx?|xlsm|docx?|pptx?|pdf|wav|mp3|m4a|aac|ogg|oga|opus|webm|mp4|mov|flac|dump|sqlite3?|db|parquet|zip|gz|tgz)$'
checkpoint_allowed() {
  local ok=1
  shopt -s nocasematch
  if [[ $1 =~ $CHECKPOINT_NEW ]] && ! [[ $1 =~ $DATA_SHAPED ]]; then ok=0; fi
  shopt -u nocasematch
  return $ok
}
# A git-lfs pointer (any spec URL git-lfs accepts; an edit changes only its oid
# line): the lfs pre-push hook uploads the real content, unscanned.
LFS_POINTER='^(version (https://(git-lfs|hawser)\.github\.com/spec/|http://git-media\.io/v/)|oid sha256:)'

# Read NUL-separated paths on stdin; print the ones that look like secret files.
# Whole paths are matched, so a newline inside a filename can't split one.
secret_paths() {
  local f found=
  while IFS= read -r -d '' f; do
    if [[ $f =~ $SECRET_FILES && ! $f =~ $ENV_EXAMPLE ]]; then found+="$f "; fi
  done
  printf '%s' "$found"
}

# Print each staged secret-file path, then each staged file whose content
# matches a token shape (binary files too). Names reach git grep as literal
# pathspecs, and a failing scan (git grep exits 2+) fails the whole check.
scan_staged() {
  # shellcheck disable=SC2016  # $0 and $@ are sh -c's own arguments
  git diff --cached --name-only -z --diff-filter=d | secret_paths &&
  git diff --cached --name-only -z --diff-filter=d | xargs -0 sh -c \
    '[ $# -eq 0 ] || git --literal-pathspecs grep --no-color --cached -l -z -E -e "$0" -- "$@"; [ $? -le 1 ]' \
    "$SECRET_TOKENS" 9>&- | tr '\0' ' '
}

[ "${HEARTH_AUTOPUSH:-1}" = "0" ] && exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$top" || exit 0

# The full ref, not --short: a tag named main would make that "heads/main".
ref=$(git symbolic-ref -q HEAD) || say "detached HEAD, skipped"
case "$ref" in refs/heads/?*) ;; *) say "HEAD is not on a local branch, skipped" ;; esac
branch=${ref#refs/heads/}
case "$branch" in
  main|master) say "on $branch, skipped (never commit to $branch; create a feature branch)" ;;
  +*) say "branch $branch starts with +, skipped (git reads that as a force-push; rename it)" ;;
esac

gitdir=$(git rev-parse --git-dir)
for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do  # not files with reftable
  git rev-parse -q --verify "$marker" >/dev/null && say "merge/rebase in progress on $branch, skipped"
done
for marker in rebase-merge rebase-apply; do
  [ -e "$gitdir/$marker" ] && say "merge/rebase in progress on $branch, skipped"
done
# Conflicts left by e.g. stash pop or merge --squash write no marker above.
[ -n "$(git ls-files -u)" ] && say "unresolved conflicts on $branch, skipped"

# One run at a time per repository, so overlapping sessions can't commit or
# restore the index under each other. This is an OS lock on fd 9 (flock, or
# perl on macOS): it is released as soon as this run exits or is killed, so
# there is no stale lock to reclaim. Children that may outlive the run (git's,
# sleep) get fd 9 closed (9>&-) so they don't keep holding it.
{ exec 9>>"$gitdir/autopush.flock"; } 2>/dev/null || say "cannot open lock file on $branch, skipped"
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || say "another auto-push is running on $branch, skipped"
elif command -v perl >/dev/null 2>&1; then
  perl -MFcntl=:flock -e 'open(my $fh, ">&=", 9) or exit 2; flock($fh, LOCK_EX | LOCK_NB) or exit 1' ||
    say "another auto-push is running on $branch, skipped"
else
  say "no flock or perl to take the lock with, skipped on $branch"
fi
index=$(git rev-parse --git-path index)
head=$(git rev-parse -q --verify HEAD) || head=none
backup='' committed='' staging=''
trap '[ -n "$backup" ] && rm -f "$backup"' EXIT
# Killed: leave the backup for the next run, or, while it has no restorable
# name yet, put it back (bash runs this only once git add has returned).
trap '[ -n "$staging" ] && mv -f "$staging" "$index" 2>/dev/null; trap - EXIT; exit 143' TERM INT HUP
# Holding the lock, no other run is using a backup. One a killed run left holds
# the user's staging from before that run, and is named after HEAD and the tree
# that run staged: put it back only if neither has changed since (that run
# never committed, and nobody has touched the index), else drop it.
for old in "$index".autopush.*; do
  case "$old" in
    "$index.autopush.$head".*) [ "$old" = "$index.autopush.$head.$(git write-tree)" ] && mv -f "$old" "$index" ;;
  esac
  rm -f "$old"
done 2>/dev/null

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  # Back up the index so a refusal leaves whatever the user had staged intact.
  # It gets a restorable name only once staging is done (below).
  # Without a backup a refusal could only reset the index, losing staged hunks, so skip instead.
  backup=$(mktemp "$index.autopush.tmp.XXXXXX" 2>/dev/null) ||
    say "nothing committed - could not back up the git index on $branch"
  if ! cp "$index" "$backup" 2>/dev/null; then
    rm -f "$backup"; backup=
    say "nothing committed - could not back up the git index on $branch"
  fi
  # Put the user's index back as it was before this run staged anything.
  restore() { mv -f "$backup" "$index"; }

  # Leave out untracked nested repositories (clones) and Claude Code's
  # .claude/worktrees/ at any depth (even a stale one git no longer sees as a
  # repository): git would commit each as a gitlink that points nowhere, or as
  # a copy. The list goes through a file: bash 3.2 in POSIX mode rejects <(..).
  # New files outside the checkpoint allow-list are left out the same way, and
  # named in the message so a person can commit them by hand if they're safe.
  nested=() leftout=0 names=''
  git ls-files -z -o --exclude-standard > "$gitdir/autopush.nested"
  while IFS= read -r -d '' f; do
    case "$f" in
      */) nested+=(":(exclude,literal)${f%/}") ;;
      *) if ! checkpoint_allowed "$f"; then
           nested+=(":(exclude,literal)$f")
           leftout=$((leftout + 1))
           [ "$leftout" -le 10 ] && names+="$f "
         fi ;;
    esac
  done < "$gitdir/autopush.nested"
  if [ "$leftout" -gt 0 ]; then
    [ "$leftout" -gt 10 ] && names+="and $((leftout - 10)) more "
    note=" - left uncommitted (new files outside the checkpoint allow-list; commit them by hand if safe): ${names% }"
  fi
  staging=$backup
  if ! out=$(git add -A -- . ':(exclude,glob)**/.claude/worktrees/**' ${nested[@]+"${nested[@]}"} 2>&1); then
    staging=; restore
    say "nothing committed - staging failed on $branch: $out"
  fi
  # Format what this checkpoint commits with the repo's own Biome, so it isn't red
  # for formatting alone (lint errors and failing tests can still make it red).
  # biome.json decides which files and how: it skips demo/, spike/ and file types
  # it doesn't know. Only the local install runs, never npx (which could fetch
  # code), for 15 s at most; a file Biome can't parse (work in progress) is
  # committed as it is, so its exit status is ignored. Symlinks are left alone.
  # The files are staged again, so the commit holds what is on disk.
  biome=$top/node_modules/.bin/biome
  if [ -x "$biome" ] && command -v node >/dev/null 2>&1; then
    git diff --cached --name-only -z --diff-filter=d |
      while IFS= read -r -d '' f; do
        if [ -f "$f" ] && [ ! -L "$f" ]; then printf '%s\0' "$f"; fi
      done > "$gitdir/autopush.fmt"
    if [ -s "$gitdir/autopush.fmt" ]; then
      bounded 15 xargs -0 "$biome" format --write --no-errors-on-unmatched -- < "$gitdir/autopush.fmt" >/dev/null 2>&1
      if ! out=$(xargs -0 git --literal-pathspecs add -A -- < "$gitdir/autopush.fmt" 2>&1 9>&-); then
        staging=; restore
        say "nothing committed - staging the formatted files failed on $branch: $out"
      fi
    fi
  fi
  if [ -n "$backup" ] && tree=$(git write-tree 2>/dev/null) &&
     mv -f "$backup" "$index.autopush.$head.$tree" 2>/dev/null; then
    backup=$index.autopush.$head.$tree
  fi
  staging=
  if git diff --cached --quiet; then
    restore  # nothing to commit (e.g. only a dirty submodule or nested repo)
  else
    # A new file someone staged by hand gets the same allow-list check: refuse the
    # checkpoint rather than commit it (renames count as new files here).
    staged_out=$(git diff --cached --no-renames --name-only -z --diff-filter=A |
      while IFS= read -r -d '' f; do checkpoint_allowed "$f" || printf '%s ' "$f"; done)
    if [ -n "$staged_out" ]; then
      restore
      say "nothing committed - staged new files outside the checkpoint allow-list: ${staged_out% } (commit them by hand if they hold no people's data)"
    fi
    blocked=$(scan_staged) || { restore; say "nothing committed - could not scan the staged files on $branch"; }
    if [ -n "$blocked" ]; then
      restore
      say "nothing committed - possible secrets in: ${blocked% } (remove them, add them to .gitignore, or commit and push them by hand)"
    fi
    # A 'git switch' since HEAD was read carries the staging to another branch
    # (its index is no longer the backup's to restore).
    [ "$(git symbolic-ref -q HEAD)" = "$ref" ] || say "HEAD left $branch during this run, nothing committed"
    if ! out=$(LC_ALL=$user_lc notty git commit -q -m "chore(auto): checkpoint after Claude Code run" 2>&1); then
      restore
      say "commit failed on $branch: $out"
    fi
    committed=1
  fi
fi

# Pin the branch's commit (not HEAD, which a 'git switch' may have moved): only
# what is scanned below is pushed, whatever the branch does next.
sha=$(git rev-parse -q --verify "$ref") || exit 0  # no commits yet, nothing to push
git remote get-url origin >/dev/null 2>&1 ||
  { [ -n "$committed" ] && say "committed on $branch; no origin remote, nothing pushed"; exit 0; }
# Where git would push it: pushRemote, pushDefault, then the upstream's remote
# ('.', a local upstream, is left to origin).
pushremote=$(git config "branch.$branch.pushRemote" || git config remote.pushDefault ||
             git config "branch.$branch.remote")
if [ "${pushremote:-origin}" != origin ] && [ "$pushremote" != . ]; then
  [ -n "$committed" ] && say "committed on $branch, which pushes to $pushremote, not origin; not pushed"
  exit 0
fi
if git rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null &&
   [ -z "$(git rev-list "refs/remotes/origin/$branch..$sha")" ]; then
  [ -n "${note-}" ] && say "nothing new to push on $branch"
  exit 0  # already up to date
fi
# The scan trusts refs/remotes/origin/, so only origin may fetch into it: every
# other remote's fetch refspecs (legacy .git/remotes/ files too) must write
# under refs/remotes/<one name other than origin>/. A remote named origin/fork,
# a glob like --mirror=fetch's +refs/*:refs/*, or the remotes/origin/x
# shorthand would write there, and its commits would skip the scan (refs/tags/
# and refs/notes/ can't). And origin must push where it fetches from (no
# pushurl, pushInsteadOf or second url): its refs say nothing about another repo.
dsts=$({ git config --get-regexp '^remote\..*\.fetch$' | grep -v '^remote\.origin\.fetch '
         find "$(git rev-parse --git-common-dir)/remotes" -type f ! -name origin -exec cat {} + 2>/dev/null
       } | grep -E '^(remote\.|Pull:).*:' | sed 's/.*://')
other=$(printf '%s\n' "$dsts" | grep -Ev '^refs/(remotes/[^*/]+|tags|notes)/'; printf '%s\n' "$dsts" | grep -i '^refs/remotes/origin/')
[ -n "$other" ] && say "not pushed - another remote may fetch into refs/remotes/origin/ (keep its fetch refspecs under refs/remotes/<its name>/, then push manually)"
[ "$(git remote get-url --push --all origin)" = "$(git remote get-url origin)" ] ||
  say "not pushed - origin pushes to a different URL than it fetches from (push manually after review)"

# Check every commit the push would send, not just the checkpoint above: the
# paths and content each one changes, and its message (raw, so an encoding
# header can't garble it). Merge commits are diffed with --remerge-diff (git
# 2.36+), which shows only what the merge resolution itself introduced, not
# content brought in from the other parent; it skips octopus merges, so those
# are not pushed. Log/diff config that would hide a change (textconv,
# log.showSignature, log.showRoot=false) is overridden.
outgoing=("$sha" --not --remotes=origin)
[ -n "$(git rev-list --min-parents=3 "${outgoing[@]}")" ] &&
  say "not pushed - octopus merges can't be scanned (review, then push manually)"
if git log -1 --format= --diff-merges=remerge HEAD >/dev/null 2>&1; then
  merges=--diff-merges=remerge
elif [ -n "$(git rev-list --merges "${outgoing[@]}")" ]; then
  say "not pushed - scanning unpushed merge commits needs git 2.36+ (review, then push manually)"
else
  merges=--no-merges  # older git, and no merges to scan anyway
fi
# Print each outgoing secret-file path, then each commit whose changes or
# message match a token shape or that adds a git-lfs pointer. A failing scan
# fails the whole check.
scan_outgoing() {
  local log=(log --root --no-show-signature --no-textconv --text "$merges")
  git "${log[@]}" --format= --name-only -z --diff-filter=d "${outgoing[@]}" | secret_paths &&
  git "${log[@]}" --no-patch -G"$SECRET_TOKENS" --format='%h ' "${outgoing[@]}" &&
  git "${log[@]}" --no-patch -G"$LFS_POINTER" --format='%h(lfs) ' "${outgoing[@]}" &&
  git log --no-show-signature --encoding=none -E --grep="$SECRET_TOKENS" --format='%h(message) ' "${outgoing[@]}"
}
blocked=$(scan_outgoing | tr '\n' ' ') ||
  say "not pushed - could not scan unpushed commits on $branch (push manually after review)"
[ -n "${blocked// /}" ] && say "not pushed - unpushed commits touch possible secrets: ${blocked% } (review, then push manually)"

# Push the scanned commit with a full refspec: it can't be read as a force-push
# (+) or remapped by remote.origin.push, and no tags or submodule commits go
# with it (push.followTags, submodule.recurse). Set the upstream only if the
# branch has none. No terminal or credential-manager prompts (askpass helpers
# still run, bounded). 60 s for the first attempt, pre-push hooks included,
# then 15 s retries only for transient network errors: at most 96 s, within
# the hook's 120 s timeout. Output goes to a file, so a background child of git
# can't hold a pipe open past that. Hooks get the caller's locale, git's own
# messages stay English for the retry check (unless the caller set LC_ALL).
track=1
git config "branch.$branch.merge" >/dev/null && track=
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
limit=60
for delay in 2 4 0; do
  LC_ALL=$user_lc LC_MESSAGES=C bounded "$limit" git push -q --no-follow-tags --no-recurse-submodules origin "$sha:refs/heads/$branch" >"$gitdir/autopush.out" 2>&1
  rc=$?; out=$(cat "$gitdir/autopush.out" 2>/dev/null)
  if [ $rc -eq 0 ]; then
    [ -n "$track" ] && git config "branch.$branch.remote" origin && git config "branch.$branch.merge" "refs/heads/$branch"
    say "pushed $branch @ $(git rev-parse --short "$sha")"
  fi
  [ $rc -eq 124 ] && { out="timed out after $limit s"; break; }
  case "$out" in
    *"Could not resolve host"*|*"Failed to connect"*|*"timed out"*|*"Connection refused"*|\
    *"Connection reset"*|*"hung up unexpectedly"*|*"early EOF"*|*"returned error: 5"[0-9][0-9]*) ;;
    *) break ;;
  esac
  [ "$delay" -gt 0 ] && sleep "$delay" 9>&-
  limit=15
done
say "push of $branch failed: $(printf '%s\n' "$out" | grep -v '^hint:')"
