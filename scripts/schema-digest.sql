-- The schema an upgrade check compares with a fresh build's (scripts/check-*-upgrade.sh), one line
-- each, sorted. After the upgrade migrates, each check tests its own rows and rules, and this is
-- the only check of the upgraded schema as a whole: the role, row level security and grant checks
-- in scripts/check-migrations.sh run only on fresh and partial builds. It compares:
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
-- - columns: type, collation, NOT NULL, default or generated expression, identity, generated,
--   storage (PLAIN refuses a row too big for a page) and column grants;
-- - rules (constraints); indexes and whether each is valid; triggers and rewrite rules (CREATE
--   RULE), and whether each is on; policies;
-- - functions, procedures and window functions (body, owner, SECURITY DEFINER, settings and
--   grants), and aggregates (declared arguments, owner, grants and their definition).
--
-- A partition is compared like any table (its row level security, grants, column grants, owner,
-- policies, indexes, rules and triggers) under a name with its month folded:
-- data_access_events_2026_10 is listed as data_access_events_yyyy_mm, with its name folded the
-- same way wherever it appears in the names and text of its rules, indexes, triggers, rewrite rules
-- and policies, and its bound reads yyyy-mm-01 for the first of its month and yyyy-mm+1-01 for the
-- next. Its copies of the parent's indexes and of its primary key, unique,
-- exclusion and foreign key rules are listed by the parent's names
-- (data_access_events_yyyy_mm.data_access_events_pkey), however Postgres named them (it shortens
-- long index names), and a copy left unattached reads differently: an index of a month's own is
-- listed as data_access_events_yyyy_mm.(local), whatever Postgres shortened and numbered its name
-- to. Identical lines are listed once,
-- so two builds made in different months, whose sets of months differ, compare equal, and a month
-- that differs from the others adds a line of its own. Each month partition also gets a line with a
-- hash of its own lines (partition data_access_events_yyyy_mm: <md5>), so a month that lacks a line
-- the others have (an index, a rule, a trigger, a policy) adds a hash of its own.
--
-- Deparsed text follows the session's settings, so this fixes them first: time zone, date and
-- interval styles, float digits, bytea output, string escapes, identifier quoting and search_path
-- (which decides when a name is qualified). A database set to another time zone
-- (check-sign-in-upgrade.sh sets New York) still reads in UTC, and a domain's default is deparsed
-- now, not read as the text frozen in the creating session's zone.
--
-- A rule's NOT VALID is compared too, except for the rules the calling check names in the psql
-- variable not_valid, as the digest lists them (<table or domain>.<rule>), separated by spaces
-- (psql -v not_valid=sessions.sessions_revoke_reason): whether those were validated is checked by
-- the caller itself.
--
-- It leaves out:
-- - the rows and sequence values (data, not schema), and which months have partitions
--   (create_data_access_partitions() keeps them a year ahead; a missing month is the partitions
--   job's concern, not the schema's);
-- - the database's own settings, owner and extensions (only plpgsql today; the migration that adds
--   pgvector, A2, adds a line); roles and memberships, which belong to the whole server
--   (scripts/check-migrations.sh checks them on every fresh and partial build);
-- - tuning that changes no result: TOAST options, replica identity, a column's compression and
--   statistics target, and extended statistics;
-- - Postgres's own internal triggers (foreign keys' and deferred unique rules'), which only a
--   superuser can turn off, and hearth_owner isn't one;
-- - comments; column order; collation versions, which follow the server's libraries; names that
--   carry a month other than through the partition's whole name (a policy named read_2026_10 makes
--   months differ, which fails the check rather than hiding anything);
-- - object kinds no migration makes yet: range types, operators, casts, operator classes and
--   families, text search objects, conversions, publications, foreign servers and event triggers;
--   the migration that first makes one adds a line for it; and objects outside public apart from
--   the schema lines above.
-- It runs only in psql (it reads a psql variable), and prints no SET tags under -q.
\if :{?not_valid}
\else
\set not_valid ''
\endif
set timezone = 'UTC';
set datestyle = 'ISO, MDY';
set intervalstyle = 'postgres';
set extra_float_digits = 1;
set bytea_output = 'hex';
set standard_conforming_strings = on;
set quote_all_identifiers = off;
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
         format('%s collation=%s notnull=%s default=%s identity=%s generated=%s storage=%s acl=%s',
                format_type(a.atttypid, a.atttypmod), a.attcollation::regcollation, a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
                a.attidentity, a.attgenerated, a.attstorage, a.attacl), c.oid
  from pg_attribute a join rel c on c.oid = a.attrelid
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where c.relkind in ('r', 'p', 'v', 'm', 'f', 'c') and a.attnum > 0 and not a.attisdropped
  union all
  -- A partition's copy of its parent's primary key, unique, exclusion or foreign key rule is listed
  -- by the parent's rule's name, so it reads alike in every month however Postgres named it, and
  -- one left unattached reads differently. not_valid names a rule as it's listed.
  select 'constraint', l.name,
         replace(case when l.name = any (skip.names) then regexp_replace(pg_get_constraintdef(k.oid), ' NOT VALID$', '')
                      else pg_get_constraintdef(k.oid) end, c.relname, c.folded), c.oid
  from pg_constraint k join rel c on c.oid = k.conrelid
  cross join lateral (
    select format('%I.%I', c.folded,
                  coalesce((select replace(pk.conname, pc.relname, pc.folded)
                            from pg_constraint pk join rel pc on pc.oid = pk.conrelid where pk.oid = k.conparentid),
                           replace(k.conname, c.relname, c.folded))) as name
  ) l
  cross join skip
  union all
  -- A partition's index attached to its parent's is listed by the parent index's name (as
  -- <partition>.<parent index>), so it reads alike in every month however Postgres named it (it
  -- shortens long names). A month partition's own index, attached to none, is listed as
  -- <partition>.(local): Postgres may have shortened its name past the month and numbered it to
  -- keep it unique, so its name says nothing stable; its definition and the month's hash still
  -- count it. A partitioned index is valid only once every partition's index is attached.
  select 'index', x.name,
         format('%s valid=%s', replace(replace(pg_get_indexdef(i.indexrelid), 'INDEX ' || quote_ident(x.relname) || ' ON ',
                                               'INDEX ' || x.name || ' ON '), c.relname, c.folded),
                i.indisvalid), c.oid
  from pg_index i join rel c on c.oid = i.indrelid
  cross join lateral (
    select ix.relname,
           coalesce((select format('%I.%I', c.folded, replace(px.relname, pc.relname, pc.folded))
                     from pg_inherits h join pg_class px on px.oid = h.inhparent
                     join pg_index pi on pi.indexrelid = px.oid join rel pc on pc.oid = pi.indrelid
                     where h.inhrelid = i.indexrelid),
                    case when c.month is not null then format('%I.(local)', c.folded) end,
                    format('%I', replace(ix.relname, c.relname, c.folded))) as name
    from pg_class ix where ix.oid = i.indexrelid
  ) x
  union all
  select 'trigger', format('%I.%I', c.folded, replace(t.tgname, c.relname, c.folded)),
         format('%s enabled=%s', replace(pg_get_triggerdef(t.oid), c.relname, c.folded), t.tgenabled), c.oid
  from pg_trigger t join rel c on c.oid = t.tgrelid
  where not t.tgisinternal
  union all
  -- Rewrite rules (CREATE RULE), apart from the _RETURN rule a view is made of, and whether each is
  -- on. scripts/check-migrations.sh refuses them, but only on fresh and partial builds.
  select 'rewrite_rule', format('%I.%I', c.folded, replace(r.rulename, c.relname, c.folded)),
         format('%s enabled=%s', md5(replace(pg_get_ruledef(r.oid), c.relname, c.folded)), r.ev_enabled), c.oid
  from pg_rewrite r join rel c on c.oid = r.ev_class
  where not (r.rulename = '_RETURN' and c.relkind in ('v', 'm'))
  union all
  select 'function', p.oid::regprocedure::text,
         format('%s owner=%s definer=%s config=%s acl=%s', md5(pg_get_functiondef(p.oid)), pg_get_userbyid(p.proowner),
                p.prosecdef, p.proconfig, p.proacl), null
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f', 'p', 'w')
  union all
  -- An aggregate, which pg_get_functiondef refuses: its declared arguments (VARIADIC, names, an
  -- ordered-set aggregate's ORDER BY), owner, grants and definition, with every function, operator
  -- and type by name.
  select 'aggregate', p.oid::regprocedure::text,
         format('args=%s owner=%s acl=%s returns=%s parallel=%s kind=%s direct=%s transfn=%s finalfn=%s combinefn=%s serialfn=%s '
                'deserialfn=%s mtransfn=%s minvtransfn=%s mfinalfn=%s finalextra=%s mfinalextra=%s finalmodify=%s '
                'mfinalmodify=%s sortop=%s transtype=%s transspace=%s mtranstype=%s mtransspace=%s initval=%s minitval=%s',
                pg_get_function_arguments(p.oid), pg_get_userbyid(p.proowner), p.proacl, format_type(p.prorettype, null),
                p.proparallel, a.aggkind,
                a.aggnumdirectargs, a.aggtransfn::regprocedure, a.aggfinalfn::regprocedure, a.aggcombinefn::regprocedure,
                a.aggserialfn::regprocedure, a.aggdeserialfn::regprocedure, a.aggmtransfn::regprocedure,
                a.aggminvtransfn::regprocedure, a.aggmfinalfn::regprocedure, a.aggfinalextra, a.aggmfinalextra,
                a.aggfinalmodify, a.aggmfinalmodify, a.aggsortop::regoperator, format_type(a.aggtranstype, null),
                a.aggtransspace, format_type(a.aggmtranstype, null), a.aggmtransspace, a.agginitval, a.aggminitval), null
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_aggregate a on a.aggfnoid = p.oid
  where n.nspname = 'public' and p.prokind = 'a'
  union all
  select 'policy', format('%I.%I', c.folded, replace(pol.polname, c.relname, c.folded)),
         format('%s %s %s using=%s check=%s', pol.polcmd, pol.polpermissive, pol.polroles::regrole[],
                replace(pg_get_expr(pol.polqual, pol.polrelid), c.relname, c.folded),
                replace(pg_get_expr(pol.polwithcheck, pol.polrelid), c.relname, c.folded)), c.oid
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
