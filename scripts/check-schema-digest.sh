#!/usr/bin/env bash
# Probes for scripts/schema-digest.sql, the schema the upgrade checks (scripts/check-*-upgrade.sh)
# compare with a fresh build's. After an upgrade migrates, the digest is the only check of the
# upgraded schema as a whole, so a respect it leaves out would let an upgrade drift unnoticed, and
# a session setting leaking into its text would fail CI when nothing is wrong.
#
# Each probe builds two throwaway databases and compares their digests. Most differ in one respect
# and must produce different digests, in a line the probe names:
# - a partition's row level security, grants, column grants, owner, policies, indexes, rules,
#   triggers or bound; a month lacking an index, policy or trigger the other months have; a
#   partitioned index left invalid; a month's primary key not attached to the parent's; a parent's
#   partition key; a DEFAULT partition;
# - a domain's default; a view's or table's options; whether a table is unlogged;
# - a sequence's type, start, increment, bounds, cache, cycling and owning column;
# - identity and generated columns; a column's storage; a column's, a domain's and a custom
#   collation;
# - default privileges; a schema's grants and owner, and another schema;
# - a rule left NOT VALID that the caller doesn't name;
# - a rewrite rule (CREATE RULE), and one turned off; an aggregate's grants, definition and
#   declared arguments.
# The others are equivalent and must compare equal: partitions made in different months, including
# months whose index names Postgres shortened and months with policies named for them; a database set to New York, or to other date,
# interval, float, bytea, string-escape, identifier-quoting or search_path settings, against the
# defaults; a domain made in a New York session against one made in UTC; NOT VALID rules the caller
# names, a month's rule among them. Then, against the real migrations (copies of the full build,
# BASE_DB), a partition for an older month, made by create_data_access_partitions() with its clock
# set back, compares equal with a copy that lacks it and its newest month, and stops comparing
# equal once it has row level security off or a grant. The months come from BASE_DB's partitions,
# so these hold however long ago it was built.
#
# These cover each respect the digest was widened for, not every field it prints.
#
# Usage, after a full scratch build (BASE_DB, default hearth_check):
#   scripts/check-migrations.sh && scripts/check-schema-digest.sh
# Same connection settings as check-migrations.sh. BASE_DB is copied as a template, so nothing else
# may be connected to it. The roles come from the full build; the databases are made up and
# dropped at the end.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export PGHOST=${PGHOST:-127.0.0.1} PGPORT=${PGPORT:-5432} PGUSER=${PGUSER:-postgres} PGPASSWORD=${PGPASSWORD:-postgres}
base=${BASE_DB:-hearth_check}
[[ $base =~ ^[a-z_][a-z0-9_]{0,54}_check$ ]] ||
  { echo "BASE_DB must be a lower-case name ending in _check, at most 61 characters, not '$base'" >&2; exit 2; }
a=schema_digest_a_check b=schema_digest_b_check
owner=hearth_owner
sql() { psql --no-psqlrc -w -v ON_ERROR_STOP=1 -q "$@"; }

[ "$(sql -d "$base" -Atc "select count(*) > 0 from public.kysely_migration" 2>/dev/null)" = t ] ||
  { echo "BASE_DB ($base) must be a full build: scripts/check-migrations.sh" >&2; exit 2; }
trap 'sql -d postgres -c "drop database if exists $a" -c "drop database if exists $b" 2>/dev/null || true' EXIT

# The database each probe's two copies start from: template0 (empty) or BASE_DB.
template=template0
failures=0 count=0

# probe <what> <same|differs> <pattern> <sql in both> <sql in a only> <sql in b only> [psql args for the digest]
# With differs, a line that only one digest has must match the pattern (grep -E).
probe() {
  local what=$1 expect=$2 pattern=$3 both=$4 only_a=$5 only_b=$6 db
  shift 6
  for db in "$a" "$b"; do
    sql -d postgres -c "set client_min_messages = warning" -c "drop database if exists $db" \
      -c "create database $db owner $owner template $template"
  done
  sql -d "$a" -c "$both" -c "$only_a"
  sql -d "$b" -c "$both" -c "$only_b"
  local left right changed
  left=$(sql -d "$a" -At "$@" -f scripts/schema-digest.sql)
  right=$(sql -d "$b" -At "$@" -f scripts/schema-digest.sql)
  changed=$(diff <(printf '%s\n' "$left") <(printf '%s\n' "$right") | sed -n 's/^[<>] //p' || true)
  count=$((count + 1))
  if [ "$expect" = same ] && [ -z "$changed" ]; then
    echo "ok    $what (equal)"
  elif [ "$expect" = differs ] && grep -qE -- "$pattern" <<<"$changed"; then
    echo "ok    $what (differs)"
  else
    failures=$((failures + 1))
    if [ "$expect" = same ]; then
      echo "FAIL  $what: the digests should be equal, but these lines differ:" >&2
    elif [ -z "$changed" ]; then
      echo "FAIL  $what: the digests should differ in a line matching '$pattern', but they're equal" >&2
    else
      echo "FAIL  $what: the digests should differ in a line matching '$pattern', but only these differ:" >&2
    fi
    [ -z "$changed" ] || sed 's/^/        /' <<<"$changed" >&2
  fi
}

# SQL that sets a database setting for the database it runs in, as a migration or an operator might.
setdb() { printf "do \$\$ begin execute format('alter database %%I set %s = %%L', current_database(), %s); end \$\$;" "$1" "$2"; }

# A partitioned table like data_access_events: row level security and a policy, a grant, a rule,
# an index and a trigger on the parent. months makes its partitions the way
# create_data_access_partitions() does: one calendar month each in UTC, with row level security on
# and no grants.
partitioned="create table p (id int not null, at timestamptz not null, primary key (id, at), check (id > 0))
  partition by range (at);
create index p_at on p (at);
alter table p enable row level security;
create policy org on p for insert with check (id > 0);
grant insert (id, at) on p to hearth_app;
create function p_touch() returns trigger language plpgsql as \$\$ begin return new; end \$\$;
create trigger p_touch before insert on p for each row execute function p_touch();"
months_of() {
  local table=$1
  shift
  printf "do \$\$ declare m date; begin
  foreach m in array '{%s}'::date[] loop
    execute format('create table %%I partition of %s for values from (%%L) to (%%L)', '%s_' || to_char(m, 'YYYY_MM'),
                   m::timestamp at time zone 'UTC', (m + interval '1 month')::timestamp at time zone 'UTC');
    execute format('alter table %%I enable row level security', '%s_' || to_char(m, 'YYYY_MM'));
  end loop;
end \$\$;" "$(IFS=,; echo "$*")" "$table" "$table" "$table"
}
months() { months_of p "$@"; }
two=$(months 2026-01-01 2026-02-01)

# 1. Partitions, compared like any table under a name with the month folded.
probe 'partitions: builds made in different months' same '' \
  "$partitioned" "$two" "$(months 2026-05-01 2026-06-01 2026-07-01)"
probe 'partitions: a month with row level security off' differs '^table p_yyyy_mm: .* rls=f' \
  "$partitioned; $two" "" "alter table p_2026_02 disable row level security"
probe 'partitions: a month granted to a role' differs '^table p_yyyy_mm: .*hearth_app=r/' \
  "$partitioned; $two" "" "grant select on p_2026_02 to hearth_app"
probe 'partitions: a column of a month granted to a role' differs '^column p_yyyy_mm\.id: .*hearth_app=r/' \
  "$partitioned; $two" "" "grant select (id) on p_2026_02 to hearth_app"
probe 'partitions: a month with another owner' differs '^table p_yyyy_mm: .*owner=hearth_owner' \
  "$partitioned; $two" "" "alter table p_2026_02 owner to hearth_owner"
probe 'partitions: a policy on a month' differs '^policy p_yyyy_mm\.own:' \
  "$partitioned; $two" "" "create policy own on p_2026_02 for select using (true)"
probe 'partitions: an index on a month' differs '^index p_yyyy_mm_id_idx: CREATE INDEX p_yyyy_mm_id_idx ON public\.p_yyyy_mm ' \
  "$partitioned; $two" "" "create index on p_2026_02 (id)"
probe 'partitions: a rule on a month' differs '^constraint p_yyyy_mm\.p_yyyy_mm_small: CHECK' \
  "$partitioned; $two" "" "alter table p_2026_02 add constraint p_2026_02_small check (id < 10)"
probe 'partitions: a trigger on a month' differs '^trigger p_yyyy_mm\.own: CREATE TRIGGER own .* ON public\.p_yyyy_mm ' \
  "$partitioned; $two" "" "create trigger own before update on p_2026_02 for each row execute function p_touch()"
probe 'partitions: a month without the index the others have' differs '^partition p_yyyy_mm: ' \
  "$partitioned; $two" "create index on p_2026_01 (id); create index on p_2026_02 (id)" "create index on p_2026_01 (id)"
probe 'partitions: a month without the policy the others have' differs '^partition p_yyyy_mm: ' \
  "$partitioned; $two" "create policy own on p_2026_01 for select using (true); create policy own on p_2026_02 for select using (true)" \
  "create policy own on p_2026_01 for select using (true)"
probe 'partitions: a month without the trigger the others have' differs '^partition p_yyyy_mm: ' \
  "$partitioned; $two" \
  "create trigger own before update on p_2026_01 for each row execute function p_touch();
   create trigger own before update on p_2026_02 for each row execute function p_touch()" \
  "create trigger own before update on p_2026_01 for each row execute function p_touch()"
probe 'partitions: a month whose bound starts at New York midnight' differs "^table p_yyyy_mm: .*bound=FOR VALUES FROM \('yyyy-mm-01 05:00:00\+00'\)" \
  "$partitioned; $(months 2026-01-01)" "$(months 2026-02-01)" \
  "create table p_2026_02 partition of p for values from ('2026-02-01 00:00-05') to ('2026-03-01 00:00-05');
   alter table p_2026_02 enable row level security"
probe 'partitions: the partition key' differs '^table k: .*partkey=LIST \(a\)' \
  "" "create table k (a int, b int) partition by range (a)" "create table k (a int, b int) partition by list (a)"
probe 'partitions: a DEFAULT partition' differs '^table p_rest: .*parent=p bound=DEFAULT' \
  "$partitioned; $two" "create table p_rest (id int not null, at timestamptz not null)" \
  "create table p_rest partition of p default"
probe 'partitions: a partitioned index left invalid' differs '^index p_id: CREATE INDEX p_id ON ONLY public\.p .* valid=f$' \
  "$partitioned; $two" "create index p_id on p (id)" \
  "create index p_id on only p (id); create index on p_2026_01 (id); create index on p_2026_02 (id)"
probe "partitions: a month's primary key not attached to the parent's" differs '^constraint q_yyyy_mm\.q_yyyy_mm_pkey: PRIMARY KEY' \
  "create table q (id int not null, at date not null) partition by range (at);
   create table q_2026_01 partition of q for values from ('2026-01-01') to ('2026-02-01')" \
  "alter table q add primary key (id, at)" "alter table only q add primary key (id, at); alter table q_2026_01 add primary key (id, at)"
# A longer table name, so Postgres shortens its months' index names and they no longer hold the
# whole partition name.
long=retrieval_events_with_a_rather_long_name
probe 'partitions: months with policies named for them' same '' \
  "$partitioned" \
  "$two; create policy p_2026_01_own on p_2026_01 for select using (true);
   create policy p_2026_02_own on p_2026_02 for select using (true)" \
  "$(months 2026-05-01 2026-06-01); create policy p_2026_05_own on p_2026_05 for select using (true);
   create policy p_2026_06_own on p_2026_06 for select using (true)"
probe 'partitions: months whose index names Postgres shortened' same '' \
  "create table $long (org_id int not null, subject_id int not null, at timestamptz not null, primary key (org_id, at))
     partition by range (at);
   create index on $long (org_id, subject_id, at)" \
  "$(months_of "$long" 2026-01-01 2026-02-01)" "$(months_of "$long" 2026-05-01 2026-06-01 2026-07-01)"

# 2. Session settings: deparsed text reads the same whatever the database or session is set to.
constants="create domain moment as timestamptz default '2026-01-01 00:00+00' check (value > '2020-01-01 00:00+00');
create table c (at timestamptz default '2026-01-01 12:00+00', day date default '2026-01-31',
  span interval default '2160 hours' check (span <= interval '90 days 3 hours'), ratio float8 default '0.30000000000000004',
  tag bytea default '\\x00ff', m moment);
create view cv with (security_invoker = true) as select at, day from c;
$partitioned
$two"
probe 'settings: a database in New York against one in UTC' same '' \
  "$constants" "$(setdb timezone "'America/New_York'")" ""
probe 'settings: a database with another date style' same '' \
  "$constants" "$(setdb datestyle "'SQL, DMY'")" ""
probe 'settings: a database with another interval style' same '' \
  "$constants" "$(setdb intervalstyle "'iso_8601'")" ""
probe 'settings: a database with fewer float digits' same '' \
  "$constants" "$(setdb extra_float_digits 0)" ""
probe 'settings: a database with escaped bytea output' same '' \
  "$constants" "$(setdb bytea_output "'escape'")" ""
probe 'settings: a database with an empty search_path' same '' \
  "$constants" "$(setdb search_path "''")" ""
probe 'settings: a database with standard_conforming_strings off' same '' \
  "$constants" "$(setdb standard_conforming_strings "'off'")" ""
probe 'settings: a database that quotes every identifier' same '' \
  "$constants" "$(setdb quote_all_identifiers "'on'")" ""
probe "settings: a domain made in a New York session against one made in UTC" same '' \
  "" "set timezone = 'America/New_York'; create domain moment as timestamptz default '2026-01-01 00:00+00'" \
  "set timezone = 'UTC'; create domain moment as timestamptz default '2026-01-01 00:00+00'"
probe "settings: a domain whose default differs by an hour" differs "^type moment: .*default='2026-01-01 01:00:00\+00'" \
  "set timezone = 'America/New_York'" "create domain moment as timestamptz default '2026-01-01 00:00+00'" \
  "create domain moment as timestamptz default '2026-01-01 01:00+00'"

# 3. Options, sorted: a view's and a table's; and whether a table is unlogged.
probe 'options: a view without security_invoker' differs '^table v: .*options=\{security_invoker=true\}' \
  "create table t (x int)" "create view v with (security_invoker = true) as select x from t" \
  "create view v as select x from t"
probe 'options: a view with check_option' differs '^table v: .*options=\{check_option=local\}' \
  "create table t (x int)" "create view v as select x from t with local check option" "create view v as select x from t"
probe 'options: a view with security_barrier' differs '^table v: .*options=\{security_barrier=true,security_invoker=true\}' \
  "create table t (x int)" "create view v with (security_invoker, security_barrier) as select x from t" \
  "create view v with (security_invoker) as select x from t"
probe "options: a table's storage options" differs '^table t: .*options=\{autovacuum_enabled=false,fillfactor=70\}' \
  "" "create table t (x int) with (fillfactor = 70, autovacuum_enabled = false)" "create table t (x int)"
probe 'options: an unlogged table' differs '^table t: .*persistence=u' \
  "" "create unlogged table t (x int)" "create table t (x int)"

# 4. Sequences.
probe 'sequences: the type' differs '^sequence s: type=integer ' "" "create sequence s as integer" "create sequence s"
probe 'sequences: the start' differs '^sequence s: .* start=5 ' "" "create sequence s start 5" "create sequence s"
probe 'sequences: the increment' differs '^sequence s: .* increment=2 ' "" "create sequence s increment 2" "create sequence s"
probe 'sequences: the bounds' differs '^sequence s: .* min=10 max=1000 ' \
  "" "create sequence s minvalue 10 maxvalue 1000" "create sequence s"
probe 'sequences: the cache' differs '^sequence s: .* cache=20 ' "" "create sequence s cache 20" "create sequence s"
probe 'sequences: cycling' differs '^sequence s: .* cycle=t ' "" "create sequence s cycle" "create sequence s"
probe 'sequences: the column that owns one' differs '^sequence s: .* owned_by=t\.id$' \
  "create table t (id int)" "create sequence s owned by t.id" "create sequence s"

# 5. Identity and generated columns.
probe 'columns: identity always against by default' differs '^column t\.id: .* identity=a ' \
  "" "create table t (id int generated always as identity)" "create table t (id int generated by default as identity)"
probe 'columns: a generated column against a default' differs '^column t\.g: .* generated=s ' \
  "" "create table t (g int generated always as (2) stored)" "create table t (g int default 2)"
probe "columns: a column's storage" differs '^column t\.body: .* storage=p ' \
  "create table t (body text)" "alter table t alter column body set storage plain" ""

# 6. Collations.
probe "collations: a column's" differs '^column t\.s: text collation="C" ' \
  "" "create table t (s text collate \"C\")" "create table t (s text)"
probe "collations: a domain's" differs '^type name_c: .* collation="C" ' \
  "" "create domain name_c as text collate \"C\"" "create domain name_c as text"
probe 'collations: a custom collation in public' differs '^collation ci: .* deterministic=f$' \
  "" "create collation ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)" \
  "create collation ci (provider = icu, locale = 'und-u-ks-level2')"
probe "collations: a custom collation's locale" differs '^collation lc: .*collate=C ctype=C ' \
  "" "create collation lc (provider = libc, locale = 'C')" "create collation lc (provider = libc, locale = 'POSIX')"

# 7. Default privileges.
probe 'default privileges: for every schema' differs '^default_acl hearth_owner on tables: .*hearth_app=r/' \
  "" "alter default privileges for role hearth_owner grant select on tables to hearth_app" ""
probe 'default privileges: in one schema' differs '^default_acl hearth_owner on sequences in public: .*hearth_app=U/' \
  "" "alter default privileges for role hearth_owner in schema public grant usage on sequences to hearth_app" ""

# 8. Schemas.
probe "schemas: public's grants" differs '^schema public: .*hearth_app=C/' "" "grant create on schema public to hearth_app" ""
probe "schemas: public's owner" differs '^schema public: owner=hearth_app ' "" "alter schema public owner to hearth_app" ""
probe 'schemas: another schema' differs '^schema extra: owner=' "" "create schema extra" ""

# 9. NOT VALID, which a rule keeps unless the caller names it.
rules="create table t (id int); create domain d as int;
alter table t add constraint t_pos check (id > 0) not valid; alter domain d add constraint d_pos check (value > 0) not valid"
validated="alter table t validate constraint t_pos; alter domain d validate constraint d_pos"
probe 'NOT VALID: a rule on a table' differs '^constraint t\.t_pos: CHECK \(\(id > 0\)\) NOT VALID$' "$rules" "" "$validated"
probe 'NOT VALID: a rule on a domain' differs '^type d: .*d_pos CHECK \(\(VALUE > 0\)\) NOT VALID ' "$rules" "" "$validated"
probe 'NOT VALID: when the caller names another rule' differs 'NOT VALID' "$rules" "" "$validated" -v not_valid='t.t_other d.d_other'
probe 'NOT VALID: when the caller names both rules' same '' "$rules" "" "$validated" -v not_valid='t.t_pos d.d_pos'
probe "NOT VALID: a month's rule, named as the digest lists it" same '' \
  "$partitioned; $two; alter table p_2026_02 add constraint p_2026_02_small check (id < 10) not valid" "" \
  "alter table p_2026_02 validate constraint p_2026_02_small" -v not_valid=p_yyyy_mm.p_yyyy_mm_small

# Rewrite rules and aggregates, which scripts/check-migrations.sh checks only on fresh builds.
probe 'rewrite rules: a rule on a table' differs '^rewrite_rule t\.t_drop: ' \
  "create table t (id int)" "create rule t_drop as on insert to t do instead nothing" ""
probe 'rewrite rules: a rule turned off' differs '^rewrite_rule t\.t_drop: .* enabled=D$' \
  "create table t (id int); create rule t_drop as on insert to t do instead nothing" "alter table t disable rule t_drop" ""
accumulate="create function f_acc(int, int) returns int language sql immutable as 'select \$1 + \$2'"
probe 'aggregates: one PUBLIC can run' differs '^aggregate agg\(integer\): args=integer owner=postgres acl= ' \
  "$accumulate; create aggregate agg(int) (sfunc = f_acc, stype = int, initcond = '0')" "" \
  "revoke execute on function agg(int) from public"
probe 'aggregates: VARIADIC' differs '^aggregate many\(integer\[\]\): args=VARIADIC integer\[\] ' \
  "" "create aggregate many(variadic int[]) (sfunc = array_cat, stype = int[])" \
  "create aggregate many(int[]) (sfunc = array_cat, stype = int[])"
probe "aggregates: the initial value" differs '^aggregate agg\(integer\): .* initval=100 ' \
  "$accumulate" "create aggregate agg(int) (sfunc = f_acc, stype = int, initcond = '100')" \
  "create aggregate agg(int) (sfunc = f_acc, stype = int, initcond = '0')"

# 1, against the real migrations. One copy gets a partition for the month two before BASE_DB's
# oldest (a month no fresh build has), made by the function 0005 created with its clock set to that
# month, as a database migrated months ago holds one; the other copy lacks BASE_DB's newest month.
# Both months come from BASE_DB's partitions, not from the clock.
template=$base
months_held=$(sql -d "$base" -At -F ' ' -c "select to_char(to_date(right(min(c.relname), 7), 'YYYY_MM') - interval '2 months', 'YYYY-MM'),
  max(c.relname) from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'public.data_access_events'::regclass")
read -r older newest_name <<<"$months_held"
[[ ${older:-} =~ ^[0-9]{4}-[0-9]{2}$ && ${newest_name:-} =~ ^data_access_events_[0-9]{4}_[0-9]{2}$ ]] ||
  { echo "BASE_DB ($base) has no month partitions of data_access_events to probe with" >&2; exit 2; }
older_name=data_access_events_${older/-/_}
older="set role $owner;
do \$\$ begin
  execute replace(replace(pg_get_functiondef('public.create_data_access_partitions(integer)'::regprocedure),
                          'public.create_data_access_partitions(', 'public.digest_probe_partitions('),
                  'pg_catalog.now()', '''$older-15 00:00:00+00''::timestamptz');
end \$\$;
do \$\$ begin perform public.digest_probe_partitions(0); end \$\$;
drop function public.digest_probe_partitions(integer);
do \$\$ begin
  if pg_catalog.to_regclass('public.$older_name') is null then
    raise exception 'the older month''s partition was not made';
  end if;
end \$\$;"
newest="drop table public.$newest_name"
probe 'real migrations: an older month made by the function, and no newest month' same '' \
  "" "$older" "$newest"
probe 'real migrations: the older month with row level security off' differs '^table data_access_events_yyyy_mm: .* rls=f' \
  "" "$older; alter table $older_name disable row level security" "$newest"
probe 'real migrations: the older month granted to hearth_app' differs '^table data_access_events_yyyy_mm: .*hearth_app=r/' \
  "" "$older; grant select on $older_name to hearth_app" "$newest"

if [ "$failures" -gt 0 ]; then
  echo "$failures of $count digest probes failed (scripts/schema-digest.sql)." >&2
  exit 1
fi
echo "OK: all $count digest probes pass: each probed respect shows, and equivalent builds compare equal."
