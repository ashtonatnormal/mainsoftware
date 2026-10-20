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
#   - never force-pushes and never skips git hooks (pre-push hooks get 60 s,
#     less the time formatting took)
#   - pushes only the branch commit it scanned: no tags, submodule commits or
#     git-lfs objects
#   - leaves nested repositories (e.g. Claude's .claude/worktrees/) uncommitted
#   - formats the staged copies of what it commits with the repo's own Biome
#     (never npx; at most 300 files and about 10 s), so a checkpoint isn't red
#     for formatting alone, but only where a file on disk can take Biome's
#     version in an atomic exchange (Linux renameat2 RENAME_EXCHANGE, on x86_64
#     or arm64, the work tree on the same mount as the git directory;
#     not macOS). It formats only a file of a type Biome formats, of at most
#     1 MiB, that is a regular file with one link and no symlinked folder on
#     its path, on the git directory's mount, holds on disk exactly the staged
#     bytes and has no checkout conversion (CRLF line endings, ident, filter,
#     working-tree-encoding); any other file, and one Biome ignores or can't
#     parse, is committed as it is. A checkpoint that commits says when
#     formatting was skipped or stopped early. A file on disk gets Biome's
#     version only after the commit (or when formatting leaves nothing to
#     commit), only if the commit (or HEAD) holds that version, and only if
#     the file still holds exactly what was staged (FMT_PL, SWAP_PL,
#     format_staged). If an exchange fails anyway, formatting stays off until
#     autopush.noswap in the git directory is deleted, so the files it left
#     as they were are committed as they are, not formatted again every run.
#     An old file whose bytes changed while it was swapped and can't go back
#     (or that a stopped run never checked) is kept in autopush.kept.* in the
#     git directory, and every checkpoint's message names it until it is
#     deleted (SPARE_PL, spares). Formatting
#     needs perl's Digest::SHA (a separate perl-Digest-SHA package on Fedora
#     and RHEL); without it, files are committed as they are, and the message
#     says why.
#     Secrets are looked for both before and after formatting
#     (Biome can move a value onto a line of its own, out of reach of a
#     one-line pattern)
#   - only git add and git commit take the index's lock (other git commands
#     that write an index work on a copy, and the script puts a new index in
#     place itself), so a file truncated while git reads it can't leave a stale
#     index.lock (index_tree, INSTALL_PL); backups and copies of the index keep
#     its mtime (cp -p), which git's check for an edit made in the same second
#     as the index was written relies on
#   - if another git command changes the index or HEAD while it runs (git add,
#     reset, stash or commit, say), commits nothing and leaves the index as
#     that command left it: the user's earlier staging is put back only while
#     HEAD hasn't moved and the index stages exactly what this run left there
#     (restore, INSTALL_PL). A new file outside the allow-list that reaches the
#     commit anyway (staged in the moment before git commit read the index)
#     takes the commit back off the branch, and no checkpoint commit that adds
#     one is ever pushed (late_checkpoints)
#   - commits a new file only in a source folder or as a known root config file,
#     and never one shaped like data (this repo is public; CLAUDE.md, Git).
#     Changes to tracked files don't need that allow-list, but are committed
#     only when the checkpoint passes its secret checks and isn't skipped or
#     refused. Other new files stay uncommitted and are named in the message;
#     if one is already staged, the checkpoint is refused and the index left
#     as it was
#
# Opt out for a session: HEARTH_AUTOPUSH=0 claude
set -uo pipefail
note='' committed='' fmt_note=''  # say() reads these: none comes from the environment
user_lc=${LC_ALL-}  # git hooks still run in the caller's locale (commit, push)
export LC_ALL=C  # byte-wise regexes: invalid UTF-8 in a name or file can't dodge them
# Git sees the objects a push sends (not git-replace stand-ins), and pathspecs
# mean what this script writes.
export GIT_NO_REPLACE_OBJECTS=1
unset GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS

# Report to the user and stop. Hook output must be JSON: fold whitespace, then
# drop control characters, quotes and backslashes so the string stays valid.
# The formatting note (fmt_note) goes only on a run that made a commit.
say() {
  local text
  text=$(printf '%s%s%s' "$1" "${note-}" "${committed:+${fmt_note-}}" | tr '\n\r\t' '   ' | tr -d '\000-\037"\\')
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
# \t escape), Twilio API key SIDs (SK and 32 hex digits), AWS secret access keys,
# LiveKit API secrets, Twilio auth tokens and API key secrets assigned to their
# usual names (a key secret's name ends in API_KEY_SECRET, api_key_secret or
# [Aa]piKeySecret, as the Twilio adapter's option does), and Postgres and
# Valkey/Redis URLs (postgresql+driver:// and rediss:// too) with a password (it
# may hold @) that isn't an upper-case $VAR, [..], <..> or {..} placeholder, for
# a dotted host name or an IP (127.x, ::1, localhost and other bare names are
# local dev).
SECRET_FILES='(^|/)(\.env[^/]*(/.*)?|[^/]*\.env|\.netrc|\.npmrc|\.pgpass|\.mcp\.json|signing_keys[^/]*\.json|credentials[^/]*\.json|[^/]*service[-_]?account[^/]*\.json|[^/]*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519))$'
SECRET_TOKENS='-----BEGIN ([A-Z]+ )*PRIVATE KEY( BLOCK)?-----|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(^|[^A-Za-z0-9_-]|\\[nrt])sk-((ant|proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})|AIza[0-9A-Za-z_-]{35}|sb_secret_[A-Za-z0-9_-]{10,}|sbp_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{30,}|npm_[A-Za-z0-9]{36}|(AKIA|ASIA)[0-9A-Z]{16}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}|(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)[^A-Za-z0-9/+:=]{0,3}[:=][^A-Za-z0-9/+]{0,3}[A-Za-z0-9/+]{40}([^A-Za-z0-9/+]|$)|(LIVEKIT_API_SECRET|livekit_api_secret|livekitApiSecret)[^A-Za-z0-9:=]{0,3}[:=][^A-Za-z0-9]{0,3}[A-Za-z0-9]{32,}([^A-Za-z0-9(._-]|$)|SK[0-9a-f]{32}|(API_KEY_SECRET|api_key_secret|[Aa]piKeySecret|TWILIO_AUTH_TOKEN|twilio_auth_token|twilioAuthToken)[^A-Za-z0-9:=]{0,3}[:=][^A-Za-z0-9]{0,3}[A-Za-z0-9]{32,}([^A-Za-z0-9(._-]|$)|(postgres(ql)?(\+[A-Za-z0-9]+)?|rediss?|valkeys?)://[^@/:[:space:]]*:([^/[:space:]$<[{]|\$[^{A-Z_/[:space:]]|\$[A-Z_][A-Z0-9_]*[^A-Z0-9_@/[:space:]])[^/[:space:]]*@([^@/:[:space:]]*\.[A-Za-z]|\[[^:]|[2-9]|1[^2]|12[^7])'
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
ckpt_msg='chore(auto): checkpoint after Claude Code run'
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
# Refuse the checkpoint, putting the user's index back, if the staged files hold
# a possible secret or can't be scanned.
refuse_secrets() {
  local blocked
  blocked=$(scan_staged) || { restore; say "nothing committed - could not scan the staged files on $branch"; }
  if [ -n "$blocked" ]; then
    restore
    say "nothing committed - possible secrets in: ${blocked% } (remove them, add them to .gitignore, or commit and push them by hand)"
  fi
}

# Formatting. Biome formats each staged copy on stdin (--stdin-file-path) and
# never opens the file on disk, so an edit made meanwhile can't be overwritten,
# and nothing in the work tree is written before the commit. Biome 2.5 applies
# biome.json's includes and .gitignore in that mode only to a path that exists
# on disk, and no size limit at all; it prints an ignored or unknown file back
# unchanged, and nothing for a file it can't parse (exit 1). So FMT_PL takes
# only a staged file
#   - of a type Biome 2.5 formats, by extension: JavaScript and TypeScript,
#     JSON, CSS, GraphQL and Grit, and HTML, Vue, Svelte and Astro, which
#     biome.json may turn on;
#   - of 1 byte to 1 MiB (Biome's own default limit), as the object database
#     says (cat-file --batch-check), so no larger or binary file is copied
#     into .git or counts toward the cap;
#   - that is a regular file with one link and no symlink on its path, matches
#     the index, and (where git ignores case) has the index's name on disk;
#   - whose folder is on the git directory's mount, so the exchange that puts
#     Biome's version on disk (SWAP_PL) can reach it. Nothing at all is
#     formatted without that exchange (noswap: no syscall number for this
#     system, or two files in $dir can't trade places, as on NFS, many FUSE
#     file systems and kernels before 3.15), or with the work tree on another
#     mount than the git directory (xdev): a file whose disk copy can never
#     take Biome's version would leave the tree dirty, and be formatted again,
#     on every run;
#   - that git writes to disk exactly as it stores it: no CRLF line endings on
#     checkout (eol=crlf, or text with core.autocrlf=true or core.eol=crlf),
#     no ident, filter or working-tree-encoding attribute, and the bytes on
#     disk equal the staged blob. Otherwise the disk could never take Biome's
#     version, and every checkpoint would format the file again.
# It drops a result if the file changed at all while Biome ran (lstat), and
# keeps only a successful, non-empty, different result. It runs four Biomes at
# a time, starts none after $budget seconds and stops the ones still running
# then, and formats at most $cap files. If every Biome failed and a one-line
# probe fails too, Biome or its config is broken (broken), not the files. It
# writes update-index records (updates) and old/new blob ids per path
# (manifest), and prints: files changed, files done, candidates, and why it
# stopped early.
IFS= read -r -d '' FMT_PL <<'PERL' || :
use strict; use warnings; use POSIX (); use Fcntl qw(:DEFAULT :mode); use IO::Handle; use Config;
use IPC::Open2 qw(open2); use Time::HiRes qw(time sleep lstat);
my ($biome, $top, $dir, $budget, $cap) = @ARGV;
my $end = time + $budget;
delete @ENV{grep { /^BIOME_/ } keys %ENV};
$SIG{PIPE} = 'IGNORE';
# The exchange SWAP_PL uses (renameat2 RENAME_EXCHANGE, by syscall number).
my $xchg = $^O eq 'linux' && $Config{ptrsize} == 8
  ? ($Config{archname} =~ /^x86_64-linux/ ? 316 : $Config{archname} =~ /^aarch64-linux/ ? 276 : 0) : 0;
sub exchange { my ($x, $y) = ("$_[0]", "$_[1]"); syscall($xchg, -100, $x, -100, $y, 2) == 0 }
# A folder is on $dir's mount if an exchange from a name that doesn't exist in
# $dir into it fails with ENOENT: the kernel checks the mount (EXDEV) and that
# it is writable (EROFS) before it looks the names up, so nothing is moved.
my %mnt;
sub mount_ok { my $d = $_[0] =~ m{^(.*)/} ? $1 : '.';
  $mnt{$d} //= !exchange("$dir/none", "$d/.autopush.none") && $!{ENOENT} ? 1 : 0 }
# SWAP_PL reads a file's bytes back as a blob ID (Digest::SHA, in Perl's core
# but split out by some distributions).
eval { require Digest::SHA; 1 } or do { print "0 0 0 nosha\n"; exit 0 };
{ my $ok = 0;
  if ($xchg && open(my $x, '>', "$dir/xa") && open(my $y, '>', "$dir/xb")) {
    my @a = lstat "$dir/xa"; $ok = @a && exchange("$dir/xa", "$dir/xb") && ((lstat "$dir/xb")[1] // -1) == $a[1] }
  unlink "$dir/xa", "$dir/xb";
  if (!$ok) { print "0 0 0 noswap\n"; exit 0 }
  if (!mount_ok('./x')) { print "0 0 0 xdev\n"; exit 0 } }
# Biome's Node wrapper runs the real binary as its child, so each Biome gets a
# process group of its own, which a stop kills whole. Those groups would
# outlive this script, and a kill of the hook's whole group, so a watchdog in a
# group of its own reads a pipe that only this script and its Biomes write to:
# each Biome registers itself before it leaves the hook's group, and when the
# pipe closes (this script ended, even by SIGKILL) the watchdog kills every
# group still registered.
pipe(my $wr, my $ww) or exit 1;
my $wd = fork // exit 1;
if (!$wd) { close $ww; setpgrp(0, 0); $SIG{$_} = 'IGNORE' for qw(TERM INT HUP);
  open(STDOUT, '>', '/dev/null'); open(STDERR, '>', '/dev/null');
  my %g; while (defined(my $l = <$wr>)) { $l =~ /^([+-])([0-9]+)$/ or next; if ($1 eq '+') { $g{$2} = 1 } else { delete $g{$2} } }
  kill 'KILL', map { -$_ } keys %g if %g; POSIX::_exit(0) }
close $wr; $ww->autoflush(1);
my (%kids, %aux, @cand, @out); my ($next, $done, $ran, $failed, $stopped) = (0, 0, 0, 0, '-');
sub stop { kill 'KILL', map { -$_ } keys %kids; kill 'KILL', keys %aux; POSIX::_exit($_[0]) }
$SIG{$_} = sub { stop(143) } for qw(TERM INT HUP);
$SIG{ALRM} = sub { stop(124) }; alarm($budget + 5);
# run(INPUT, CMD...): what CMD prints (undef if it fails), its stdin the file
# INPUT if defined; a stop kills it too.
sub run { my ($in, @cmd) = @_; my $pid = open(my $h, '-|') // return;
  if (!$pid) { open(STDERR, '>', '/dev/null'); !defined $in || open(STDIN, '<', $in) or POSIX::_exit(127);
    exec @cmd or POSIX::_exit(127) }
  $aux{$pid} = 1; binmode $h; my $o = do { local $/; <$h> }; my $ok = close $h; delete $aux{$pid};
  $ok ? $o // '' : undef }
sub nul { my @f = split /\0/, $_[0], -1; pop @f; @f }
sub conf { my $v = run(undef, qw(git config), @_) // ''; chomp $v; lc $v }
sub snap { my @s = lstat $_[0]; @s ? join(' ', @s[0, 1, 2, 3, 7], map { sprintf '%.9f', $_ } @s[9, 10]) : '' }
sub parents_ok { my @c = split m{/}, $_[0]; pop @c; my $q;
  for (@c) { $q = defined $q ? "$q/$_" : $_; my @s = lstat $q; return 0 unless @s && S_ISDIR($s[2]) } 1 }
sub slurp { open(my $h, '<', $_[0]) or return; binmode $h; local $/; my $c = <$h>; defined $c ? $c : '' }
# Where git ignores case, the name on disk must be the index's (SWAP_PL).
my $icase;
sub name_ok { $icase //= conf(qw(--bool --get core.ignorecase)) eq 'true'; return 1 unless $icase;
  my ($d, $b) = $_[0] =~ m{^(?:(.*)/)?([^/]+)\z} or return 0;
  opendir(my $h, defined $d ? $d : '.') or return 0; my $ok = grep { $_ eq $b } readdir $h; closedir $h; $ok }
# Whether git converts the blob when it writes the file to disk, as convert.c
# decides: CRLF line endings from the text (else crlf) and eol attributes,
# core.autocrlf and core.eol; ident, filter and working-tree-encoding always.
my ($acrlf, $ceol) = ('', '');
sub converts { my ($a) = @_; my %act = (set => 'text', unset => 'binary', input => 'input', auto => 'auto');
  return 1 if grep { ($a->{$_} // 'unspecified') !~ /^(?:unspecified|unset)\z/ } qw(ident filter working-tree-encoding);
  my $act = $act{$a->{text} // ''} // $act{$a->{crlf} // ''} // 'undef';
  return 0 if $act eq 'binary';
  my $eol = $a->{eol} // '';
  return 1 if $eol eq 'crlf';
  return 0 if $eol eq 'lf' || $act eq 'input';
  return $acrlf eq 'true' if $act eq 'undef';
  $acrlf eq 'true' || ($acrlf ne 'input' && $ceol eq 'crlf') }
{ my @r = nul(run(undef, qw(git diff --cached --raw -z --no-abbrev --no-renames --no-color --diff-filter=d)) // exit 1);
  exit 1 if @r % 2;
  my %dirty = map { $_ => 1 } nul(run(undef, qw(git diff-files --name-only -z)) // exit 1);  # plumbing: never writes the index
  my @s;
  while (@r) { my ($meta, $p) = splice(@r, 0, 2); my (undef, $mode, undef, $sha) = split / /, $meta;
    next unless defined $sha && $sha =~ /^[0-9a-f]+\z/ && ($mode eq '100644' || $mode eq '100755');
    next unless $p =~ /\.(?:[cm]?[jt]s|[jt]sx|jsonc?|css|graphql|gql|grit|html?|vue|svelte|astro)\z/i;
    next if $dirty{$p} || !parents_ok($p);
    my @l = lstat $p; push @s, [$p, $mode, $sha] if @l && S_ISREG($l[2]) && $l[3] == 1 && mount_ok($p) && name_ok($p) }
  if (@s) {
    open(my $q, '>', "$dir/shas") or exit 1; print {$q} map { "$_->[2]\n" } @s; close $q or exit 1;
    my @z = split /\n/, run("$dir/shas", qw(git cat-file --batch-check)) // exit 1;
    exit 1 if @z != @s;
    for my $k (0 .. $#s) { my (undef, $type, $size) = split / /, $z[$k]; $s[$k][3] = $type eq 'blob' ? $size // 0 : 0 }
    @s = grep { $_->[3] && $_->[3] <= 1 << 20 } @s }
  if (@s) {
    open(my $q, '>', "$dir/paths") or exit 1; print {$q} map { "$_->[0]\0" } @s; close $q or exit 1;
    my @t = nul(run("$dir/paths", qw(git check-attr -z --stdin text crlf eol ident filter working-tree-encoding)) // exit 1);
    exit 1 if @t % 3;
    my %at; while (@t) { my ($p, $n, $v) = splice(@t, 0, 3); $at{$p}{$n} = $v }
    $acrlf = conf(qw(--get core.autocrlf));
    $acrlf = conf(qw(--bool --get core.autocrlf)) || 'true' if $acrlf ne '' && $acrlf ne 'input';
    $ceol = conf(qw(--get core.eol));
    @cand = map { [@$_, snap($_->[0])] } grep { !converts($at{$_->[0]} || {}) } @s }
}
# Each blob comes from one cat-file, already known to be at most 1 MiB.
my ($bo, $bi, $bp);
if (@cand) { $bp = eval { open2($bo, $bi, qw(git cat-file --batch)) } or exit 1; $aux{$bp} = 1; binmode $bo; binmode $bi }
sub blob { my ($sha, $n) = @_; print {$bi} "$sha\n" or stop(1); $bi->flush or stop(1);
  my $hdr = do { local $/ = "\n"; <$bo> }; my (undef, $type, $size) = split ' ', $hdr // '';
  stop(1) unless defined $size && $type eq 'blob' && $size == $n;
  my $b = ''; while (length $b < $n + 1) { read($bo, $b, $n + 1 - length $b, length $b) or stop(1) }
  substr($b, 0, $n) }
sub disk { my ($p, $n) = @_; sysopen(my $h, $p, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or return;
  my $c = ''; while (length $c <= $n) { my $r = sysread($h, $c, 65536, length $c); return unless defined $r; last unless $r }
  $c }
sub launch { my $i = $next++; my ($p, undef, $sha, $n) = @{$cand[$i]};
  my $b = blob($sha, $n); my $d = disk($p, $n);
  return $done++ unless defined $d && $d eq $b;  # not what git would write: a conversion it wasn't told of, or an edit
  open(my $o, '>', "$dir/$i.in") or return $done++; binmode $o;
  (print {$o} $b) && close($o) or return $done++;
  my $pid = fork // return $done++;
  if (!$pid) { print {$ww} "+$$\n"; setpgrp(0, 0);
    open(STDIN, '<', "$dir/$i.in") && open(STDOUT, '>', "$dir/$i.out") && open(STDERR, '>', '/dev/null') or POSIX::_exit(127);
    exec { $biome } $biome, 'format', '--config-path', $top, "--stdin-file-path=$p" or POSIX::_exit(127) }
  $ran++; $kids{$pid} = $i }
sub reaped { print {$ww} "-$_[0]\n"; delete $kids{$_[0]} }
sub finish { my ($i, $status) = @_; $done++; if ($status) { $failed++; return }
  my $new = slurp("$dir/$i.out"); my $old = slurp("$dir/$i.in");
  return unless defined $new && defined $old && length $new && $new ne $old;
  push @out, $i if snap($cand[$i][0]) eq $cand[$i][4] }
while (1) {
  while (keys(%kids) < 4 && $next < @cand) {
    if ($ran >= $cap) { $stopped = 'cap'; last }
    if (time >= $end) { $stopped = 'time'; last }
    launch() }
  last unless %kids;
  my $pid = waitpid(-1, POSIX::WNOHANG());
  if ($pid > 0) { my $st = $?; finish(reaped($pid), $st) if exists $kids{$pid}; next }
  if (time >= $end) { $stopped = 'time'; kill 'KILL', map { -$_ } keys %kids; for (keys %kids) { waitpid($_, 0); reaped($_) } last }
  sleep 0.005 }
if ($bp) { close $bi; close $bo; waitpid($bp, 0); delete $aux{$bp} }
# Every Biome failed: Biome or biome.json is broken if a one-line probe fails too.
if ($ran && $failed == $ran && time < $end) {
  open(my $o, '>', "$dir/probe.in") or exit 1; print {$o} "export {}\n"; close $o or exit 1;
  my $pid = fork // exit 1;
  if (!$pid) { print {$ww} "+$$\n"; setpgrp(0, 0);
    open(STDIN, '<', "$dir/probe.in") && open(STDOUT, '>', '/dev/null') && open(STDERR, '>', '/dev/null') or POSIX::_exit(127);
    exec { $biome } $biome, 'format', '--config-path', $top, '--stdin-file-path=autopush-probe.ts' or POSIX::_exit(127) }
  $kids{$pid} = -1;
  until (waitpid($pid, POSIX::WNOHANG()) == $pid) {
    if (time >= $end) { kill 'KILL', -$pid; waitpid($pid, 0); $? = 0; last }
    sleep 0.005 }
  $stopped = 'broken' if $?; reaped($pid) }
my @sha;
if (@out) { @sha = split /\n/, run(undef, qw(git hash-object -w --no-filters --), map { "$dir/$_.out" } @out) // exit 1;
  exit 1 if @sha != @out || grep { !/^[0-9a-f]{40}(?:[0-9a-f]{24})?\z/ } @sha }
open(my $u, '>', "$dir/updates") or exit 1; open(my $m, '>', "$dir/manifest") or exit 1;
for my $k (0 .. $#out) { my ($p, $mode, $sha) = @{$cand[$out[$k]]};
  print {$u} "$mode $sha[$k]\t$p\0"; print {$m} "$sha $sha[$k] $p\0" }
close $u or exit 1; close $m or exit 1;
print scalar(@out), " $done ", scalar(@cand), " $stopped\n";
PERL
# Compare-and-swap, after the commit: replace each formatted file on disk with
# Biome's version, but only if the commit (or HEAD, when formatting left
# nothing to commit) holds that version at that path, and the file still holds
# exactly the bytes that were staged, with the mode, owner and times it had
# when they were read. The new copy is written and synced in the git
# directory, and takes the old file's mode. A symlink is never followed, a
# file with another hard link never replaced, and on a case-insensitive file
# system a file whose name differs in case from the index's is left alone. The
# path changes hands in one exchange (renameat2 RENAME_EXCHANGE), so the file
# is never seen half written or missing, and the old file comes out under the
# temporary name: a save that renamed a new file over the path just before is
# seen and put back at once. There is no rename instead: POSIX has no
# rename-if-unchanged, so a save landing between the last check and a rename
# would be lost, and FMT_PL formats nothing where there is no exchange. If an
# exchange fails anyway, and not because the path has gone, nothing more is
# swapped and $off says why: formatting then stays off until that file is
# deleted (format_staged), so the next checkpoint commits the files left as
# they were as they are, instead of formatting them, and failing to swap them,
# on every run. The old file is kept until every file is swapped, and 20 ms
# more, then read again through the handle opened before the swap: if its
# bytes differ from what was staged, its mode, owner, size or mtime from the
# last check before the exchange, or its ctime from just after it (a write or
# chmod meanwhile, by whoever opened it before the swap: an editor or Node
# writing in place), it goes back over Biome's version, so the user's change
# wins; only such a change landing after that is lost. The bytes are compared
# (as a blob id, so no git command is needed then), not just the size and
# mtime, because a same-size write within one tick of a coarse clock (whole
# seconds on ext3, two on FAT) leaves both as they were. A file that has
# changed is left as it is; the next checkpoint commits it. An old file that
# changed but can't go back (the path no longer holds Biome's version) stays
# in $dir for the hook to keep (spares). This run's time limit (ALRM), TERM,
# INT and HUP all stop it the same way: no more swaps, then every file already
# swapped is checked as above before it exits (quit), and they wait while a
# file is between names. Once checking has begun, none of them stops it, so a
# read that hangs (a hung network or FUSE file system) holds it, and the run's
# lock, until it returns, as it would hold git. SIGKILL, or a signal it doesn't
# handle, can leave an old file unchecked in $dir, which the hook then doesn't
# delete (fmt_swap): it keeps any old file whose bytes are neither what was
# staged nor Biome's version (spares), as soon as this ends or, if the hook was
# stopped too, in the next run. A change of mode alone is then lost.
# Paths are checked by name (Perl has no openat), so a folder swapped for a
# symlink in the microseconds between a check and the open or exchange would
# be followed; whoever can do that can write the file anyway.
IFS= read -r -d '' SWAP_PL <<'PERL' || :
use strict; use warnings; use POSIX (); use Fcntl qw(:DEFAULT :mode); use IO::Handle; use Config;
use IPC::Open2 qw(open2); use Time::HiRes qw(time stat lstat sleep); use Digest::SHA ();
my ($dir, $budget, $commit, $off) = @ARGV;
my $end = time + $budget;
my (@pending, $swapped, $stop, $fresh, $quitting); my $me = $$;
# The run's lock (fd 9) stays held until this ends, even if the hook is killed
# first, so no next run clears $dir under it; git's children don't get it.
our $LOCK; if (open($LOCK, '>>&=', 9)) { fcntl($LOCK, F_SETFD, FD_CLOEXEC) }
my %code = (ALRM => 124, TERM => 143, INT => 130, HUP => 129);
my $held = POSIX::SigSet->new(POSIX::SIGALRM(), POSIX::SIGTERM(), POSIX::SIGINT(), POSIX::SIGHUP());
sub hold { $quitting or POSIX::sigprocmask($_[0] ? POSIX::SIG_BLOCK() : POSIX::SIG_UNBLOCK(), $held) }
# (A child between fork and exec just exits.)
sub quit { POSIX::_exit($code{$_[0]} // 1) unless $$ == $me;
  POSIX::sigprocmask(POSIX::SIG_BLOCK(), $held); $quitting = 1; alarm 0;
  unlink $fresh if defined $fresh; settle(); POSIX::_exit($code{$_[0]} // 1) }
$SIG{$_} = \&quit for keys %code;
alarm($budget + 5); $SIG{PIPE} = 'IGNORE';
exit 0 unless ($commit // '') =~ /^[0-9a-f]{40}(?:[0-9a-f]{24})?\z/ && defined $off;
my $xchg = $^O eq 'linux' && $Config{ptrsize} == 8
  ? ($Config{archname} =~ /^x86_64-linux/ ? 316 : $Config{archname} =~ /^aarch64-linux/ ? 276 : 0) : 0;
exit 0 unless $xchg;
sub exchange { my ($x, $y) = ("$_[0]", "$_[1]"); syscall($xchg, -100, $x, -100, $y, 2) == 0 }
sub run { my $pid = open(my $h, '-|') // return; if (!$pid) { open(STDERR, '>', '/dev/null'); exec @_ or POSIX::_exit(127) }
  binmode $h; my $o = do { local $/; <$h> }; close $h ? $o // '' : undef }
sub parents_ok { my @c = split m{/}, $_[0]; pop @c; my $q;
  for (@c) { $q = defined $q ? "$q/$_" : $_; my @s = lstat $q; return 0 unless @s && S_ISDIR($s[2]) } 1 }
my $icase = (run(qw(git config --bool --get core.ignorecase)) // '') =~ /^true/;
sub name_ok { return 1 unless $icase; my ($d, $b) = $_[0] =~ m{^(?:(.*)/)?([^/]+)\z} or return 0;
  opendir(my $h, defined $d ? $d : '.') or return 0; my $ok = grep { $_ eq $b } readdir $h; closedir $h; $ok }
my @recs; { open(my $m, '<', "$dir/manifest") or exit 0; local $/ = "\0";
  while (defined(my $r = <$m>)) { chomp $r; my @f = split / /, $r, 3; push @recs, \@f if @f == 3 } }
exit 0 unless @recs;
my %want;
for (split /\0/, run(qw(git --literal-pathspecs ls-tree -r -z), $commit, '--', map { $_->[2] } @recs) // exit 1) {
  my ($meta, $p) = split /\t/, $_, 2; my (undef, $type, $sha) = split / /, $meta;
  $want{$p} = $sha if defined $p && defined $sha && $type eq 'blob' }
my ($from, $to); eval { open2($from, $to, qw(git cat-file --batch)) } or exit 1;
binmode $from; binmode $to;
sub blob { print {$to} "$_[0]\n" or return; $to->flush or return;
  my $hdr = do { local $/ = "\n"; <$from> }; return unless defined $hdr;
  my (undef, $type, $size) = split ' ', $hdr; return unless defined $size && $type eq 'blob';
  my $buf = ''; while (length $buf < $size + 1) { read($from, $buf, $size + 1 - length $buf, length $buf) or return }
  substr($buf, 0, $size) }
# The bytes of the open file FH from the start, up to N + 1 of them (undef if
# it can't be read).
sub bytes { my ($fh, $n) = @_; defined sysseek($fh, 0, 0) or return; my $c = '';
  while (length $c <= $n) { my $r = sysread($fh, $c, 65536, length $c); return unless defined $r; last unless $r }
  $c }
sub same { my ($x, $y, @i) = @_; for (@i) { return 0 unless $x->[$_] == $y->[$_] } 1 }
# Whether the bytes C are the blob ID (SHA-1, or SHA-256 in such a repository).
sub is_blob { my ($c, $id) = @_; my $b = 'blob ' . length($c) . "\0" . $c;
  (length $id == 64 ? Digest::SHA::sha256_hex($b) : Digest::SHA::sha1_hex($b)) eq $id }
# Exchange: whatever held the path comes out under $tmp; if that isn't the old
# file, a save replaced it just before, and it goes straight back.
sub xswap { my ($p, $fh, $sha, $s1, $tmp, $t) = @_;
  my @l = lstat $p;
  unless (@l && same(\@l, $s1, 0, 1, 2, 3, 4, 5, 7, 9, 10)) { unlink $tmp; return 0 }
  unless (exchange($tmp, $p)) {
    my ($e, $gone) = ("$!", $!{ENOENT} || $!{ENOTDIR}); unlink $tmp; return 0 if $gone;
    $stop = 1; if (open(my $o, '>', $off)) { print {$o} "swapping $p failed: $e"; close $o }
    return 0 }
  my @o = lstat $tmp;
  unless (@o && same(\@o, $s1, 0, 1)) {
    my @now = lstat $p; exchange($tmp, $p) if @now && same(\@now, $t, 0, 1);
    unlink $tmp; return 0 }
  push @pending, [$p, $fh, $sha, $s1, \@o, $tmp, $t]; 1 }
sub swap { my ($p, $sha, $old, $new, $n) = @_;
  return 0 unless !$stop && defined $old && defined $new && length $new && parents_ok($p) && name_ok($p);
  sysopen(my $fh, $p, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or return 0;
  my @s0 = stat $fh;
  return 0 unless @s0 && S_ISREG($s0[2]) && $s0[3] == 1 && $s0[7] == length $old;
  my $disk = bytes($fh, length $old);
  my @s1 = stat $fh;
  return 0 unless defined $disk && $disk eq $old && @s1 && same(\@s0, \@s1, 0, 1, 2, 3, 4, 5, 7, 9, 10);
  # Until it is exchanged, $tmp holds only Biome's version: a quit removes it.
  my $tmp = "$dir/new.$n"; $fresh = $tmp;
  sysopen(my $t, $tmp, O_WRONLY | O_CREAT | O_EXCL, 0600) or return 0;
  my $ok = (syswrite($t, $new) // -1) == length $new && $t->sync;
  $ok = close($t) && $ok && chmod($s1[2] & 07777, $tmp);
  my @t = lstat $tmp;
  unless ($ok && @t) { unlink $tmp; return 0 }
  hold(1); $fresh = undef; my $r = xswap($p, $fh, $sha, \@s1, $tmp, \@t); hold(0); $r }
# Once every file is swapped, and 20 ms more: an old file changed meanwhile
# goes back over Biome's version (if the path still holds it). Each leaves
# @pending only once it is checked; an old file that changed and didn't go
# back stays in $dir.
sub settle { return unless @pending; sleep 0.02;
  while (@pending) { hold(1); my ($p, $fh, $sha, $s1, $o, $spare, $t) = @{ shift @pending };
    my @s3 = stat $fh; my $now = bytes($fh, $s1->[7]); my @s4 = stat $fh;
    my $done = defined $now && is_blob($now, $sha) && @s3 && @s4 && same(\@s3, $s1, 2, 4, 5, 7, 9) &&
      same(\@s3, $o, 10) && same(\@s4, \@s3, 2, 4, 5, 7, 9, 10);
    unless ($done) {
      my @now = lstat $p;
      if (@now && same(\@now, $t, 0, 1, 7, 9) && exchange($spare, $p)) {
        my @x = lstat $spare;
        if (@x && same(\@x, $t, 0, 1)) { $done = 1; $swapped-- } else { exchange($spare, $p) } } }
    unlink $spare if $done; hold(0); close $fh } }
my $n = 0; $swapped = 0;
for (@recs) { last if time >= $end; my ($o, $w, $p) = @$_; $n++;
  next unless ($want{$p} // '') eq $w;
  $swapped += swap($p, $o, blob($o), blob($w), $n) }
settle();
print "$swapped\n";
PERL

# Git reads a large file through mmap, so a file truncated while git reads it
# kills git with SIGBUS. Any git command that may write the index (write-tree,
# update-index) re-reads files staged in the same second as the index was
# written, and does so holding index.lock, which such a death leaves behind to
# block every later git command, the user's too. So apart from git add and git
# commit (see sigbus), this script runs git only on copies of the index, in its
# scratch folder, and puts a new index in place itself (INSTALL_PL). A copy
# keeps the index's mtime (cp -p, as every backup does): git trusts an entry
# whose file is older than the index, so a newer mtime would hide an edit made
# in the second the file was staged.
# index_tree FROM COPY: print the tree the index FROM holds, read from COPY.
index_tree() {
  local t=
  cp -p "$1" "$2" 2>/dev/null && t=$(env GIT_INDEX_FILE="$2" git write-tree 2>/dev/null 9>&-)
  rm -f "$2" "$2.lock"
  [ -n "$t" ] && printf '%s\n' "$t"
}
# The run's scratch folder in the git directory (removed on exit; a killed
# run's is removed by the next run).
scratch() {
  [ -n "$fmtdir" ] || fmtdir=$(mktemp -d "$gitdir/autopush.fmt.XXXXXX" 2>/dev/null) || fmtdir=
  [ -n "$fmtdir" ]
}
# INSTALL_PL INDEX BASE NEW [HEAD]: put the index NEW in place as git does,
# holding index.lock: create the lock (O_EXCL; while a git command holds it,
# try again for 0.5 s, then exit 3), check that HEAD, if given, is still that
# commit (else exit 4) and that the index still stages exactly what BASE (the
# copy NEW was made from, or of the index as this run last left it) staged
# (else exit 2), then rename NEW over the lock and the lock over the index.
# With NEW empty it only makes both checks, without the lock (exit 0 if
# nothing has changed). What is staged is each entry's path, mode,
# blob id and stage, and its assume-unchanged, skip-worktree and intent-to-add
# flags (git ls-files --debug), so a rewrite that changed only stat data or
# extensions (an IDE's git status refreshing the index, an fsmonitor token, the
# untracked cache) still installs NEW, and anything staged meanwhile stops it.
# NEW keeps its own mtime: git wrote it after re-checking every entry staged in
# the same second as BASE, and nothing from the newer index is taken into it,
# so no refresh can make a same-second edit look clean. Every signal but
# SIGKILL (and SIGSTOP) waits until it is done, so only SIGKILL can leave the
# lock, while it compares.
IFS= read -r -d '' INSTALL_PL <<'PERL' || :
use strict; use warnings; use POSIX (); use Fcntl; use Time::HiRes qw(time sleep);
my ($index, $base, $new, $head) = @ARGV;
my $held = POSIX::SigSet->new; $held->fillset;
POSIX::sigprocmask(POSIX::SIG_BLOCK(), $held) or exit 1;
my $mask = 0x8000 | 0x3000 | 1 << 29 | 1 << 30;  # assume-unchanged, stage, intent-to-add, skip-worktree
sub out { my $pid = open(my $h, '-|') // return;
  if (!$pid) { POSIX::sigprocmask(POSIX::SIG_UNBLOCK(), $held); open(STDERR, '>', '/dev/null');
    exec @_ or POSIX::_exit(127) }
  binmode $h; my $o = do { local $/; <$h> } // ''; close $h ? $o : undef }
sub staged { local $ENV{GIT_INDEX_FILE} = $_[0];
  my $all = out(qw(git -c core.fsmonitor=false ls-files -s -z --debug)) // return;
  my $s = '';
  while ($all =~ /\G([0-7]+) ([0-9a-f]+) ([0-3])\t([^\0]*)\0  ctime: [^\n]*\n  mtime: [^\n]*\n  dev: [^\n]*\n  uid: [^\n]*\n  size: [0-9]+\tflags: ([0-9a-f]+)\n/gc) {
    $s .= sprintf "%s %s %s %x\t%s\0", $1, $2, $3, hex($5) & $mask, $4 }
  (pos($all) // 0) == length $all ? $s : undef }
# HEAD as the script names it: a commit id, or none before the first commit.
sub moved { return 0 unless defined $head && length $head;
  my $h = out(qw(git rev-parse -q --verify HEAD)) // ''; chomp $h; ($h eq '' ? 'none' : $h) ne $head }
my $was = staged($base); exit 1 unless defined $was;
if (($new // '') eq '') { exit 4 if moved(); my $cur = staged($index); exit(!defined $cur ? 1 : $cur eq $was ? 0 : 2) }
my ($l, $t0) = (undef, time);
until (sysopen($l, "$index.lock", O_WRONLY | O_CREAT | O_EXCL, 0666)) { exit 3 if !$!{EEXIST} || time - $t0 >= 0.5; sleep 0.01 }
close $l;
if (moved()) { unlink "$index.lock"; exit 4 }
my $cur = staged($index); my $same = defined $cur && $cur eq $was;
my $ok = $same && rename($new, "$index.lock") && rename("$index.lock", $index);
unlink "$index.lock" unless $ok;
exit($ok ? 0 : defined $cur && !$same ? 2 : 1);
PERL

# Format what this checkpoint commits (header; FMT_PL), starting from the copy
# of the index the backup's name was read from (base), then put Biome's
# versions in place in one index write (INSTALL_PL), only if nothing has been
# staged since. Before that write, the backup gets a second name for the tree
# it makes, so a run killed at any point leaves a backup named for the index as
# it is, which the next run restores. A reason not to format, or an early stop,
# goes in the message of a checkpoint that commits (fmt_note); formatting never
# fails a checkpoint.
format_staged() {
  local biome=$top/node_modules/.bin/biome cfg=$top/biome.json t0=$SECONDS why= res tree2= rc
  local re='^[0-9]+ [0-9]+ [0-9]+ (cap|time|broken|noswap|xdev|nosha|-)$' off=$gitdir/autopush.noswap
  { [ -e "$cfg" ] || [ -L "$cfg" ]; } || cfg=$top/biome.jsonc  # Biome's own order
  # (Checked here and read by Biome a moment later: whoever could swap the file
  # in between could edit it anyway.)
  if ! [ -e "$cfg" ] && ! [ -L "$cfg" ]; then why='no biome.json'
  elif [ -L "$cfg" ] || ! [ -f "$cfg" ]; then why="${cfg##*/} is not a regular file"
  elif ! [ -x "$biome" ]; then why='no node_modules/.bin/biome (run npm ci)'
  elif ! command -v node >/dev/null 2>&1; then why='node is not on PATH'
  elif ! command -v perl >/dev/null 2>&1; then why='perl is not on PATH'
  elif [ "$backup" != "$index.autopush.$head.${tree-}" ] || ! [ -f "$fmtdir/base" ]; then
    why='the index backup has no restorable name'
  elif [ -e "$off" ]; then  # SWAP_PL could not put a formatted file on disk
    why="a formatted file could not be put on disk before ($(head -c 200 "$off" 2>/dev/null)); delete $off to format again"
  else
    # Only the repo's config and Biome: no BIOME_* variable (BIOME_CONFIG_PATH,
    # BIOME_BINARY) reaches it, and --config-path stops it looking elsewhere.
    # exec: no subshell waits on it holding the run's lock (fd 9), so if this
    # run is killed, the next one needn't wait for formatting to end.
    res=$(exec env GIT_INDEX_FILE="$fmtdir/base" perl -e "$FMT_PL" "$biome" "$top" "$fmtdir" 10 300 2>/dev/null 9>&-); rc=$?
    if [ $rc -eq 124 ]; then why='formatting took longer than 15 s'
    elif [ $rc -ne 0 ] || ! [[ $res =~ $re ]]; then why='Biome could not be run'
    else
      set -- $res
      case $4 in
        time) fmt_note=" - formatting stopped after 10 s: $(($3 - $2)) of $3 files not checked" ;;
        cap) fmt_note=" - formatting stops at 300 files: $(($3 - $2)) of $3 files not checked" ;;
        broken) why='Biome failed on every file (check biome.json)' ;;
        noswap) why="files here can't be swapped into place atomically (renameat2 RENAME_EXCHANGE: Linux on x86_64 or arm64, on a file system that has it), so the files on disk couldn't take Biome's version" ;;
        xdev) why="the work tree is on another mount than $gitdir, so the files on disk couldn't take Biome's version" ;;
        nosha) why="perl has no Digest::SHA module, which checks the old copy of a file after Biome's version replaces it" ;;
      esac
      if [ "$1" -gt 0 ]; then
        rc=1
        if cp -p "$fmtdir/base" "$fmtdir/new" 2>/dev/null &&
           env GIT_INDEX_FILE="$fmtdir/new" git update-index -z --index-info < "$fmtdir/updates" >/dev/null 2>&1 9>&- &&
           tree2=$(env GIT_INDEX_FILE="$fmtdir/new" git write-tree 2>/dev/null 9>&-) &&
           [ -n "$tree2" ] && [ "$tree2" != "$tree" ] &&
           cp -p "$fmtdir/new" "$fmtdir/mine" 2>/dev/null &&
           { ln "$backup" "$index.autopush.$head.$tree2" 2>/dev/null ||
             { cp -p "$backup" "$fmtdir/backup" && mv -f "$fmtdir/backup" "$index.autopush.$head.$tree2"; } 2>/dev/null; }; then
          perl -e "$INSTALL_PL" "$index" "$fmtdir/base" "$fmtdir/new" "$head" 2>/dev/null 9>&-; rc=$?
        fi
        if [ $rc -eq 0 ]; then
          rm -f "$backup"; backup=$index.autopush.$head.$tree2; mine=$fmtdir/mine
        else
          [ -n "$tree2" ] && [ "$tree2" != "$tree" ] && rm -f "$index.autopush.$head.$tree2"
          rm -f "$fmtdir/manifest"
          case $rc in
            2) why='the index changed while formatting' ;;
            4) why='a commit was made while formatting' ;;
            3) why='another git command was using the index' ;;
            *) why='staging the formatted files failed' ;;
          esac
        fi
      fi
    fi
  fi
  [ -n "$why" ] && fmt_note="${fmt_note-} - not formatted: $why"
  fmt_secs=$((SECONDS - t0 + 1))  # whole seconds, rounded up
}
# SPARE_PL DIR GITDIR: the old files a swap left in the scratch folder DIR
# (new.N, for the Nth file in its manifest). One that holds what was staged or
# Biome's version is removed; any other (it changed while it was swapped, and
# couldn't go back, or SWAP_PL was killed before it checked it) is moved to a
# new autopush.kept.* folder in GITDIR as N.<its name>, with a list of the
# paths they came from (paths.txt), and the folder and paths are printed.
# Exits 1 if any was left in DIR.
IFS= read -r -d '' SPARE_PL <<'PERL' || :
use strict; use warnings; use Fcntl qw(:mode); use Digest::SHA (); use File::Temp ();
my ($dir, $gitdir) = @ARGV;
my @recs; if (open(my $m, '<', "$dir/manifest")) { local $/ = "\0";
  while (defined(my $r = <$m>)) { chomp $r; push @recs, [split / /, $r, 3] } }
opendir(my $d, $dir) or exit 1;
my ($keep, @kept, $left);
for my $f (sort { substr($a, 4) <=> substr($b, 4) } grep { /^new\.[1-9][0-9]{0,8}\z/ } readdir $d) {
  my $r = $recs[substr($f, 4) - 1] // []; my @s = lstat "$dir/$f";
  if (@s && S_ISREG($s[2]) && @$r == 3 && open(my $h, '<:raw', "$dir/$f")) {
    my $c = do { local $/; <$h> } // ''; close $h; my $b = 'blob ' . length($c) . "\0" . $c;
    my $id = length $r->[0] == 64 ? Digest::SHA::sha256_hex($b) : Digest::SHA::sha1_hex($b);
    if ($id eq $r->[0] || $id eq $r->[1]) { unlink "$dir/$f" or $left = 1; next } }
  $keep //= eval { File::Temp::tempdir('autopush.kept.XXXXXX', DIR => $gitdir) };
  (my $name = $r->[2] // $f) =~ s{.*/}{};
  if (defined $keep && rename("$dir/$f", "$keep/" . substr($f, 4) . ".$name")) { push @kept, $r->[2] // $f }
  else { $left = 1 } }
if (@kept) {
  if (open(my $o, '>', "$keep/paths.txt")) { print {$o} map { "$_\n" } @kept; close $o }
  print "$keep (", join(', ', @kept), ")" }
elsif (defined $keep) { rmdir $keep }
exit($left ? 1 : 0);
PERL
# A swap's leftovers in the scratch folder $1 (SPARE_PL), before it is
# removed: an old file that may hold an edit is kept, and the message says
# where. If that can't be done, the whole folder is kept: moved to
# autopush.kept.*, or, if even that fails, left where it is (return 1), for
# the next run to try again.
spares() {
  local dir=$1 kept rc
  set -- "$dir"/new.*
  { [ -e "$1" ] || [ -L "$1" ]; } || return 0
  kept=$(perl -e "$SPARE_PL" "$dir" "$gitdir" 2>/dev/null 9>&-); rc=$?
  [ -n "$kept" ] && note="${note-} - kept old copies of files a checkpoint was formatting, which changed while it swapped Biome's version in: compare them with your files ($kept)"
  [ $rc -eq 0 ] && return 0
  [ "$dir" = "$fmtdir" ] && fmtdir=
  mv -f "$dir" "$gitdir/autopush.kept.${dir##*.}" 2>/dev/null || return 1
  note="${note-} - kept a checkpoint's scratch folder, which may hold old copies of files it was formatting with an edit made meanwhile: compare them with your files ($gitdir/autopush.kept.${dir##*.})"
}
# After the commit, or when formatting left nothing to commit (SWAP_PL): the
# files on disk may take only what HEAD, that commit, holds. If an exchange
# failed, formatting is off from now on, and the message says so. SWAP_PL keeps
# the run's lock (fd 9) until it ends, so if this run is killed meanwhile, the
# next can't start and clear the scratch folder under it. Until spares is done
# with the folder, this run's EXIT trap leaves it too (swapping): a signal bash
# doesn't trap (USR1, ALRM, PIPE...) runs that trap at once, even while
# SWAP_PL is still running.
fmt_swap() {
  local t0=$SECONDS off=$gitdir/autopush.noswap
  { [ -n "$fmtdir" ] && [ -s "$fmtdir/manifest" ]; } || return 0
  swapping=1
  perl -e "$SWAP_PL" "$fmtdir" 5 "$(git rev-parse -q --verify HEAD)" "$off" >/dev/null 2>&1
  spares "$fmtdir"
  swapping=
  [ -s "$off" ] && note="${note-} - formatting is off from now on: $(head -c 200 "$off" 2>/dev/null); the next checkpoint commits the files on disk as they are (delete $off to format again)"
  fmt_secs=$((fmt_secs + SECONDS - t0 + 1))
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
backup='' committed='' staging='' fmtdir='' fmt_secs=0 fmt_note='' mine='' swapping=''
trap '[ -n "$backup" ] && rm -f "$backup"; [ -n "$fmtdir" ] && [ -z "$swapping" ] && rm -rf "$fmtdir"' EXIT
# Killed: leave the backup for the next run, or, while it has no restorable
# name yet, put it back (bash runs this only once git add has returned).
trap '[ -n "$staging" ] && mv -f "$staging" "$index" 2>/dev/null; trap - EXIT; exit 143' TERM INT HUP
# A killed run's scratch folder (its copies, and any old file it was still
# holding after a swap, which spares keeps if it may hold an edit). If that
# run had committed but not yet replaced the files on disk, they now differ
# from HEAD only by formatting, and this run formats them back to HEAD's
# content, commits nothing, and replaces them.
for d in "$gitdir"/autopush.fmt.*; do
  { [ -d "$d" ] && ! [ -L "$d" ]; } || continue
  spares "$d" && rm -rf "$d" 2>/dev/null
done
# Every run names every kept folder until it is deleted, so one whose run was
# stopped before its message still reaches the user.
for k in "$gitdir"/autopush.kept.*; do
  { [ -d "$k" ] && ! [ -L "$k" ]; } || continue
  case ${note-} in *"${k##*/}"*) ;; *) note="${note-} - $k holds old copies of files a checkpoint was formatting, which may hold an edit: compare them with your files, then delete it" ;; esac
done
# Holding the lock, no other run is using a backup. One a killed run left holds
# the user's staging from before that run, and is named after HEAD and the tree
# that run staged: put it back only if neither has changed since (that run
# never committed, and nobody has touched the index), else drop it. The tree is
# read from a copy of the index (index_tree), and the backup put in place the
# way git writes an index (INSTALL_PL). If that can't be done now (a git
# command is using the index, or has just staged something), this checkpoint
# is skipped and the backup left for the next run: a checkpoint now would
# stage everything over it.
for old in "$index".autopush.*; do
  case "$old" in
    "$index.autopush.$head".*)
      if scratch && cp -p "$index" "$fmtdir/current" &&
         [ "$old" = "$index.autopush.$head.$(index_tree "$fmtdir/current" "$fmtdir/tree")" ]; then
        if command -v perl >/dev/null; then
          perl -e "$INSTALL_PL" "$index" "$fmtdir/current" "$old" "$head" 9>&-
          case $? in
            0) ;;
            3) say "nothing committed - another git command is using the index, so the staging an interrupted checkpoint saved isn't back yet; the next checkpoint puts it back (if no git command is running, one that was killed left $index.lock: delete it)" ;;
            2|4) say "nothing committed - the index changed while the staging an interrupted checkpoint saved was being put back; the next checkpoint looks again" ;;
            *) say "nothing committed - could not put back the staging an interrupted checkpoint saved (${old##*/}); the next checkpoint tries again" ;;
          esac
        else
          mv -f "$old" "$index"
        fi
      fi ;;
  esac
  rm -f "$old"
done 2>/dev/null

# git add and git commit are the only git commands here that take the real
# index's lock (index_tree). They take it before they read the work tree and
# rename it last, so if one dies of SIGBUS, the lock it leaves is its own:
# remove it, or it blocks every later git command. git status here takes no
# lock at all. A signal's exit status is 128 + its number, and SIGBUS is 7 on
# Linux but 10 on macOS: bash's own kill -l (else perl's POSIX) says which.
# (One killed by SIGKILL, as the hook's own timeout may do, leaves its lock
# too; nothing here can tell a dead git's lock from a live one's, so the next
# run's "staging failed" message passes on git's advice to remove it.)
bus=$(kill -l BUS 2>/dev/null)
case $bus in ''|*[!0-9]*) bus=$(perl -MPOSIX -e 'print POSIX::SIGBUS()' 2>/dev/null) ;; esac
case $bus in ''|*[!0-9]*) bus=7 ;; esac
sigbus() { [ "$1" -eq $((128 + bus)) ] && rm -f "$index.lock" && out="a file changed while git read it (git died of SIGBUS); try again"; }
# git status can die of SIGBUS the same way: say so, rather than skip the
# checkpoint without a word.
st=$(git --no-optional-locks status --porcelain --untracked-files=normal 2>/dev/null); rc=$?
if [ $rc -ne 0 ]; then
  err="it exited with $rc"; [ $rc -eq $((128 + bus)) ] && err='a file changed while git read it (git died of SIGBUS)'
  say "nothing committed - git status failed on $branch: $err; the next checkpoint tries again"
fi
if [ -n "$st" ]; then
  # Back up the index so a refusal leaves whatever the user had staged intact.
  # It gets a restorable name only once staging is done (below).
  # Without a backup a refusal could only reset the index, losing staged hunks, so skip instead.
  backup=$(mktemp "$index.autopush.tmp.XXXXXX" 2>/dev/null) ||
    say "nothing committed - could not back up the git index on $branch"
  if ! cp -p "$index" "$backup" 2>/dev/null; then
    rm -f "$backup"; backup=
    say "nothing committed - could not back up the git index on $branch"
  fi
  # Put the user's index back as it was before this run staged anything, but
  # only if nobody else has touched it since: HEAD hasn't moved and the index
  # still stages exactly what this run last left there ($mine, a copy).
  # Otherwise another git command (a commit, reset, stash or git add) changed
  # it meanwhile, and the backup would undo that (a commit's changes would
  # stage as a revert): leave the index as it is, and say so. If a git command
  # holds the index, a backup with a restorable name is left for the next run.
  restore() {
    local rc=1 why= saved=$backup
    [ -n "$backup" ] || return 0
    if [ -n "$mine" ] && command -v perl >/dev/null 2>&1; then
      perl -e "$INSTALL_PL" "$index" "$mine" "$backup" "$head" 2>/dev/null 9>&-; rc=$?
    elif [ "$(git rev-parse -q --verify HEAD || echo none)" != "$head" ]; then rc=4
    else mv -f "$backup" "$index" 2>/dev/null && rc=0
    fi
    case $rc in
      0) backup=; return 0 ;;
      2) why='another git command changed the index meanwhile' ;;
      4) why='a commit was made or HEAD moved meanwhile' ;;
      3) case $backup in
           "$index.autopush.$head".*) backup=; why="a git command was using the index; the next checkpoint puts it back (if no git command is running, one that was killed left $index.lock: delete it)" ;;
           *) why="a git command was using the index (if none is running, one that was killed left $index.lock: delete it)" ;;
         esac ;;
      *) why='it could not be put in place' ;;
    esac
    # Worth a word only if the backup staged something HEAD didn't hold.
    [ "$head" != none ] && [ -f "$saved" ] && env GIT_INDEX_FILE="$saved" git diff-index --cached --quiet "$head" -- >/dev/null 2>&1 9>&- && return 0
    note="${note-} - the staging you had before this checkpoint was not put back ($why)"
  }
  scratch  # now, so the time until the backup is named (below) stays short

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
    note="${note-} - left uncommitted (new files outside the checkpoint allow-list; commit them by hand if safe): ${names% }"
  fi
  # A SIGKILL between this git add and the backup's restorable name (below) is
  # the one point where a killed run's staging isn't put back: the next run
  # can't tell this index from one a person staged, so it drops the backup and
  # commits the index as it is. No content is lost, only which changes were
  # staged; the window is the few milliseconds of one cp and one write-tree.
  staging=$backup
  out=$(git add -A -- . ':(exclude,glob)**/.claude/worktrees/**' ${nested[@]+"${nested[@]}"} 2>&1); rc=$?
  if [ $rc -ne 0 ]; then
    # git add writes the index only once it has staged everything, so a failed
    # one left it as it was, or as another git command (whose lock may have
    # failed this one) is leaving it: nothing to put back.
    staging=; sigbus $rc
    say "nothing committed - staging failed on $branch: $out"
  fi
  # The backup's restorable name: HEAD and the tree this staging makes, read
  # from a copy of the index (base) that formatting then starts from, and that
  # restore compares the index with ($mine, until formatting replaces it).
  if [ -n "$backup" ] && scratch && cp -p "$index" "$fmtdir/base" 2>/dev/null &&
     tree=$(index_tree "$fmtdir/base" "$fmtdir/tree") &&
     mv -f "$backup" "$index.autopush.$head.$tree" 2>/dev/null; then
    backup=$index.autopush.$head.$tree
  fi
  [ -n "$fmtdir" ] && [ -f "$fmtdir/base" ] && mine=$fmtdir/base
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
    # Look for secrets before formatting as well as after it: Biome breaks a
    # long assignment after = or :, which puts the value on a line of its own,
    # where a pattern that needs the name and the value together can't see it.
    refuse_secrets
    # The second scan and the commit then see the formatted index.
    format_staged
    if git diff --cached --quiet; then
      restore  # formatting undid every change (e.g. whitespace): nothing to commit
      fmt_swap
    else
      refuse_secrets
      # A 'git switch' since HEAD was read carries the staging to another branch
      # (restore puts the backup back only if that branch is at the same commit).
      [ "$(git symbolic-ref -q HEAD)" = "$ref" ] || { restore; say "HEAD left $branch during this run, nothing committed"; }
      # Commit only what was checked: if another git command has staged, reset,
      # stashed or committed anything since this run staged (a person's git add
      # of a new file outside the allow-list, say), the checks above never saw
      # it. Leave the index as that command left it; the next run tries again.
      if [ -n "$mine" ] && command -v perl >/dev/null 2>&1; then
        perl -e "$INSTALL_PL" "$index" "$mine" '' "$head" 2>/dev/null 9>&-; rc=$?
      elif [ "$(git rev-parse -q --verify HEAD || echo none)" != "$head" ]; then rc=4
      else rc=0
      fi
      case $rc in
        2|4) say "nothing committed - another git command changed the index or made a commit during this checkpoint, so the index was left as it is; the next checkpoint tries again" ;;
      esac  # (1: it couldn't be read; the check on the commit below still holds)
      out=$(LC_ALL=$user_lc notty git commit -q -m "$ckpt_msg" 2>&1); rc=$?
      if [ $rc -ne 0 ]; then
        sigbus $rc; restore
        say "commit failed on $branch: $out"
      fi
      # The commit holds what the index held when git commit read it, so a new
      # file staged in the moment since that check (or by a pre-commit hook)
      # never met the allow-list. Such a commit is taken back off the branch
      # (the index keeps it all staged) and never pushed.
      new=$(git rev-parse -q --verify "$ref") &&
        late=$(git diff-tree -r --root --no-commit-id --no-renames --name-only -z --diff-filter=A "$new" |
          while IFS= read -r -d '' f; do checkpoint_allowed "$f" || printf '%s ' "$f"; done) ||
        say "committed on $branch, not pushed - could not read back the checkpoint commit (review it, then push manually)"
      if [ -n "$late" ]; then
        # Only this run's commit, by its parent; update-ref moves the branch
        # back only if it still points at that commit.
        taken=; parent=$(git rev-parse -q --verify "$new^") || parent=none
        if [ "$parent" != "$head" ]; then :
        elif [ "$head" = none ]; then git update-ref -m 'auto-push: take back checkpoint' -d "$ref" "$new" && taken=1
        else git update-ref -m 'auto-push: take back checkpoint' "$ref" "$head" "$new" && taken=1
        fi
        if [ -n "$taken" ]; then
          restore
          say "nothing committed - new files outside the checkpoint allow-list were staged during this checkpoint: ${late% } (commit them by hand if they hold no people's data)"
        fi
        say "not pushed - checkpoint $(git rev-parse --short "$new") on $branch holds new files outside the checkpoint allow-list, staged while it ran: ${late% } (review it, then push manually)"
      fi
      committed=1
      fmt_swap
    fi
  fi
fi

# Pin the branch's commit (not HEAD, which a 'git switch' may have moved): only
# what is scanned below is pushed, whatever the branch does next.
sha=$(git rev-parse -q --verify "$ref") ||  # no commits yet, nothing to push
  { [ -n "${note-}" ] && say "nothing to push on $branch"; exit 0; }
git remote get-url origin >/dev/null 2>&1 || {
  [ -n "$committed" ] && say "committed on $branch; no origin remote, nothing pushed"
  [ -n "${note-}" ] && say "no origin remote on $branch, nothing pushed"
  exit 0
}
# Where git would push it: pushRemote, pushDefault, then the upstream's remote
# ('.', a local upstream, is left to origin).
pushremote=$(git config "branch.$branch.pushRemote" || git config remote.pushDefault ||
             git config "branch.$branch.remote")
if [ "${pushremote:-origin}" != origin ] && [ "$pushremote" != . ]; then
  [ -n "$committed" ] && say "committed on $branch, which pushes to $pushremote, not origin; not pushed"
  [ -n "${note-}" ] && say "$branch pushes to $pushremote, not origin; not pushed"
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
# A checkpoint commit (by its subject) that adds a new file outside the
# allow-list is never pushed: one that a file staged while it ran slipped into,
# which that run couldn't take back (another commit had landed on top of it).
late_checkpoints() {
  local c f s
  git log --no-show-signature --encoding=none --format='%H %s' "${outgoing[@]}" |
  while read -r c s; do
    [ "$s" = "$ckpt_msg" ] || continue
    git diff-tree -r --root --no-commit-id --no-renames --name-only -z --diff-filter=A "$c" |
      while IFS= read -r -d '' f; do checkpoint_allowed "$f" || printf '%s:%s ' "${c:0:7}" "$f"; done ||
      printf '%s(unreadable) ' "${c:0:7}"
  done
}
late=$(late_checkpoints) || say "not pushed - could not scan unpushed commits on $branch (push manually after review)"
[ -n "$late" ] && say "not pushed - unpushed checkpoint commits add new files outside the checkpoint allow-list: ${late% } (review, then push manually)"

# Push the scanned commit with a full refspec: it can't be read as a force-push
# (+) or remapped by remote.origin.push, and no tags or submodule commits go
# with it (push.followTags, submodule.recurse). Set the upstream only if the
# branch has none. No terminal or credential-manager prompts (askpass helpers
# still run, bounded). 60 s for the first attempt, pre-push hooks included,
# less the whole seconds formatting took (10 s or so; its perl steps stop by
# 15 s and 10 s, the swap only once it has checked each file it swapped, which
# takes milliseconds unless a read hangs), then 15 s retries only for transient
# network errors:
# formatting and pushing take about 96 s at most together (more only if a
# read hangs, or formatting's git steps outside perl take over 3 s; git
# commit's re-read of the formatted files isn't counted), within the hook's
# 120 s timeout. Output
# goes to a file, so a background child of git can't hold a pipe open past that. Hooks get the caller's locale, git's own
# messages stay English for the retry check (unless the caller set LC_ALL).
track=1
git config "branch.$branch.merge" >/dev/null && track=
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
limit=$((60 - fmt_secs))
[ "$limit" -ge 30 ] || limit=30
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
