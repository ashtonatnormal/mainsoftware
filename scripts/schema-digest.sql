-- The schema an upgrade check compares with a fresh build's (scripts/check-*-upgrade.sh), one line
-- each, sorted. After the upgrade migrates, this is the only check the upgraded database gets, so
-- it lists everything the checks rely on. It compares:
-- - schemas other than the system ones: owner and grants (so public's grants, and any schema a
--   migration adds, show);
-- - default privileges (ALTER DEFAULT PRIVILEGES), for every role and schema;
-- - in public, every relation: tables, partitioned tables and their partitions, views, materialized
--   views, foreign tables and sequences, with their kind, owner, row level security (on and
--   forced), grants, options sorted (a view's security_invoker, check_option and security_barrier;
--   a table's storage options), persistence (unlogged or not), parent, partition bound and
--   partition key;
-- - each view's body; each sequence's type, start, increment, bounds, cache, cycle and the column
--   that owns it (OWNED BY, serial or identity);
-- - enum, domain and composite types: owner, labels, base type, collation, NOT NULL, default,
--   rules and grants;
-- - custom collations: owner, provider, locale, collate and ctype, ICU rules, whether
--   deterministic;
-- - columns: type, collation, NOT NULL, default or generated expression, identity, generated, and
--   column grants;
-- - rules (constraints), indexes, triggers and whether each is on, policies, and functions and
--   procedures (body, owner, SECURITY DEFINER, settings and grants).
--
-- A partition is compared like any table (its row level security, grants, column grants, owner,
-- policies, indexes, rules and triggers) under a name with its month folded:
-- data_access_events_2026_10 is listed as data_access_events_yyyy_mm, and so are its indexes and
-- cloned rules (data_access_events_yyyy_mm_pkey), with the month folded in their text too, and its
-- bound reads yyyy-mm-01 for the first of its month and yyyy-mm+1-01 for the next. Identical lines
-- are listed once, so two builds made in different months, whose sets of months differ, compare
-- equal, and a month that differs from the others adds a line of its own. Each month partition also
-- gets a line with a hash of its own lines (partition data_access_events_yyyy_mm: <md5>), so a
-- month that lacks a line the others have (an index, a rule, a trigger, a policy) adds a hash of
-- its own.
--
-- Deparsed text follows the session's settings, so this fixes them first: time zone, date and
-- interval styles, float digits, bytea output and search_path (which decides when a name is
-- qualified). A database set to another time zone (check-sign-in-upgrade.sh sets New York) still
-- reads in UTC, and a domain's default is deparsed now, not read as the text frozen in the
-- creating session's zone.
--
-- A rule's NOT VALID is compared too, except for the rules the calling check names in the psql
-- variable not_valid, as <table or domain>.<rule> separated by spaces (psql -v
-- not_valid=sessions.sessions_revoke_reason): whether those were validated is checked by the
-- caller itself.
--
-- It leaves out: the rows and sequence values (data, not schema); the database's own settings,
-- owner and extensions (only plpgsql today; the migration that adds pgvector, A2, adds a line);
-- roles and memberships, which belong to the whole server (scripts/check-migrations.sh checks them
-- on every fresh and partial build); comments; column order; range types (none yet); collation
-- versions, which follow the server's libraries; and objects outside public apart from the schema
-- lines above. It runs only in psql (it reads a psql variable), and prints no SET tags under -q.
\if :{?not_valid}
\else
\set not_valid ''
\endif
set timezone = 'UTC';
set datestyle = 'ISO, MDY';
set intervalstyle = 'postgres';
set extra_float_digits = 1;
set bytea_output = 'hex';
set search_path = public;
with rel as (
  -- Every relation in public, under the name it's listed by: a partition's month, if its name ends
  -- in one, folded to yyyy_mm, and the month kept (as a date) to fold its bound. A name ending in
  -- something that isn't a month (_2026_13) gives no month, so it stays as it is.
  select c.*, m.month,
         case when m.month is null then c.relname else regexp_replace(c.relname, '_[0-9]{4}_[0-9]{2}$', '_yyyy_mm') end as folded
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral (
    select case when c.relispartition
                then to_date(substring(c.relname from '_([0-9]{4}_(?:0[1-9]|1[0-2]))$'), 'YYYY_MM') end as month
  ) m
  where n.nspname = 'public'
),
-- The rules whose NOT VALID the calling check leaves out.
skip as (select string_to_array(:'not_valid', ' ') as names),
-- Every line, with the relation it describes (relid) where it describes one.
lines as (
  select 'schema' as kind, format('%I', n.nspname) as name,
         format('owner=%s acl=%s', pg_get_userbyid(n.nspowner), n.nspacl) as detail, null::oid as relid
  from pg_namespace n
  where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
  union all
  select 'default_acl',
         format('%I on %s%s', pg_get_userbyid(d.defaclrole),
                case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions'
                                     when 'T' then 'types' when 'n' then 'schemas' else d.defaclobjtype::text end,
                ' in ' || quote_ident(n.nspname)),
         d.defaclacl::text, null
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  union all
  select 'table', format('%I', c.folded),
         format('kind=%s owner=%s rls=%s force=%s acl=%s options=%s persistence=%s parent=%s bound=%s partkey=%s',
                c.relkind, pg_get_userbyid(c.relowner), c.relrowsecurity, c.relforcerowsecurity, c.relacl,
                (select array_agg(o order by o) from unnest(c.reloptions) o), c.relpersistence,
                (select string_agg(coalesce(format('%I', p.folded), i.inhparent::regclass::text), ',' order by i.inhseqno)
                 from pg_inherits i left join rel p on p.oid = i.inhparent where i.inhrelid = c.oid),
                case when c.month is null then pg_get_expr(c.relpartbound, c.oid)
                     else replace(replace(pg_get_expr(c.relpartbound, c.oid), to_char(c.month, 'YYYY-MM-DD'), 'yyyy-mm-01'),
                                  to_char(c.month + interval '1 month', 'YYYY-MM-DD'), 'yyyy-mm+1-01') end,
                pg_get_partkeydef(c.oid)), c.oid
  from rel c
  where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  union all
  select 'view', format('%I', c.folded), md5(pg_get_viewdef(c.oid)), c.oid
  from rel c
  where c.relkind in ('v', 'm')
  union all
  select 'sequence', format('%I', c.folded),
         format('type=%s start=%s increment=%s min=%s max=%s cache=%s cycle=%s owned_by=%s', format_type(s.seqtypid, null),
                s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle,
                (select string_agg(format('%I.%I', o.folded, a.attname), ',' order by o.folded, a.attname)
                 from pg_depend d join rel o on o.oid = d.refobjid
                 join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
                 where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.refclassid = 'pg_class'::regclass
                   and d.deptype in ('a', 'i'))), c.oid
  from pg_sequence s join rel c on c.oid = s.seqrelid
  union all
  -- A composite type's attributes are its columns (below); a domain's rules are listed here, by
  -- name, as the rules branch lists tables'.
  select 'type', format('%I', t.typname),
         format('kind=%s owner=%s labels=%s base=%s collation=%s notnull=%s default=%s checks=%s acl=%s', t.typtype,
                pg_get_userbyid(t.typowner),
                (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid),
                format_type(t.typbasetype, t.typtypmod), t.typcollation::regcollation, t.typnotnull,
                pg_get_expr(t.typdefaultbin, 0),
                (select string_agg(format('%I %s', k.conname,
                                          case when format('%I.%I', t.typname, k.conname) = any (skip.names)
                                               then regexp_replace(pg_get_constraintdef(k.oid), ' NOT VALID$', '')
                                               else pg_get_constraintdef(k.oid) end),
                                   '; ' order by k.conname)
                 from pg_constraint k where k.contypid = t.oid), t.typacl), null
  from pg_type t join pg_namespace n on n.oid = t.typnamespace
  left join pg_class c on c.oid = t.typrelid
  cross join skip
  where n.nspname = 'public' and (t.typtype in ('e', 'd') or (t.typtype = 'c' and c.relkind = 'c'))
  union all
  select 'collation', format('%I', l.collname),
         format('owner=%s provider=%s locale=%s collate=%s ctype=%s rules=%s deterministic=%s', pg_get_userbyid(l.collowner),
                l.collprovider, l.colllocale, l.collcollate, l.collctype, l.collicurules, l.collisdeterministic), null
  from pg_collation l join pg_namespace n on n.oid = l.collnamespace
  where n.nspname = 'public'
  union all
  select 'column', format('%I.%I', c.folded, a.attname),
         format('%s collation=%s notnull=%s default=%s identity=%s generated=%s acl=%s', format_type(a.atttypid, a.atttypmod),
                a.attcollation::regcollation, a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity, a.attgenerated,
                a.attacl), c.oid
  from pg_attribute a join rel c on c.oid = a.attrelid
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where c.relkind in ('r', 'p', 'v', 'm', 'f', 'c') and a.attnum > 0 and not a.attisdropped
  union all
  select 'constraint', format('%I.%I', c.folded, replace(k.conname, c.relname, c.folded)),
         replace(case when format('%I.%I', c.folded, k.conname) = any (skip.names)
                      then regexp_replace(pg_get_constraintdef(k.oid), ' NOT VALID$', '')
                      else pg_get_constraintdef(k.oid) end, c.relname, c.folded), c.oid
  from pg_constraint k join rel c on c.oid = k.conrelid
  cross join skip
  union all
  select 'index', format('%I', replace(x.relname, c.relname, c.folded)), replace(pg_get_indexdef(i.indexrelid), c.relname, c.folded),
         c.oid
  from pg_index i join rel c on c.oid = i.indrelid join pg_class x on x.oid = i.indexrelid
  union all
  select 'trigger', format('%I.%I', c.folded, replace(t.tgname, c.relname, c.folded)),
         format('%s enabled=%s', replace(pg_get_triggerdef(t.oid), c.relname, c.folded), t.tgenabled), c.oid
  from pg_trigger t join rel c on c.oid = t.tgrelid
  where not t.tgisinternal
  union all
  select 'function', p.oid::regprocedure::text,
         format('%s owner=%s definer=%s config=%s acl=%s', md5(pg_get_functiondef(p.oid)), pg_get_userbyid(p.proowner),
                p.prosecdef, p.proconfig, p.proacl), null
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f', 'p')
  union all
  select 'policy', format('%I.%I', c.folded, pol.polname),
         format('%s %s %s using=%s check=%s', pol.polcmd, pol.polpermissive, pol.polroles::regrole[],
                pg_get_expr(pol.polqual, pol.polrelid), pg_get_expr(pol.polwithcheck, pol.polrelid)), c.oid
  from pg_policy pol join rel c on c.oid = pol.polrelid
)
select distinct line collate "C" as line from (
  select format('%s %s: %s', kind, name, detail) as line from lines
  union all
  -- One line per month partition, with a hash of its own lines, so a month that lacks a line the
  -- other months have (an index, a rule, a trigger, a policy) shows, though identical lines are
  -- listed once.
  select format('partition %I: %s', c.folded,
                md5(string_agg(format('%s %s: %s', l.kind, l.name, l.detail), E'\n'
                               order by format('%s %s: %s', l.kind, l.name, l.detail) collate "C")))
  from lines l join rel c on c.oid = l.relid
  where c.month is not null
  group by c.oid, c.folded
) as every_line
order by line;
