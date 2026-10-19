-- The schema an upgrade check compares with a fresh build's (scripts/check-*-upgrade.sh): tables,
-- views and their bodies, columns and their defaults, enum, domain and composite types, rules (apart
-- from whether each was validated, which each check covers itself), indexes, triggers and whether
-- each is on, functions, policies, owners and grants, one line each. Monthly partitions are left
-- out: they are named for the month each build ran in.
select format('%s %s: %s', kind, name, detail) from (
  select 'table' as kind, format('%I', c.relname) as name,
         format('kind=%s owner=%s rls=%s force=%s acl=%s', c.relkind, pg_get_userbyid(c.relowner), c.relrowsecurity,
                c.relforcerowsecurity, c.relacl) as detail
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and not c.relispartition
  union all
  select 'view', format('%I', c.relname), md5(pg_get_viewdef(c.oid))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('v', 'm')
  union all
  -- A composite type's attributes are its columns (below); a domain's rules are listed here, by name
  -- and apart from whether each was validated, as the rules branch lists tables'.
  select 'type', format('%I', t.typname),
         format('kind=%s owner=%s labels=%s base=%s notnull=%s default=%s checks=%s acl=%s', t.typtype,
                pg_get_userbyid(t.typowner),
                (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid),
                format_type(t.typbasetype, t.typtypmod), t.typnotnull, t.typdefault,
                (select string_agg(format('%I %s', k.conname, replace(pg_get_constraintdef(k.oid), ' NOT VALID', '')),
                                   '; ' order by k.conname)
                 from pg_constraint k where k.contypid = t.oid), t.typacl)
  from pg_type t join pg_namespace n on n.oid = t.typnamespace
  left join pg_class c on c.oid = t.typrelid
  where n.nspname = 'public' and (t.typtype in ('e', 'd') or (t.typtype = 'c' and c.relkind = 'c'))
  union all
  select 'column', format('%I.%I', c.relname, a.attname),
         format('%s notnull=%s default=%s acl=%s', format_type(a.atttypid, a.atttypmod), a.attnotnull,
                pg_get_expr(d.adbin, d.adrelid), a.attacl)
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'c') and not c.relispartition
    and a.attnum > 0 and not a.attisdropped
  union all
  select 'constraint', format('%I.%I', c.relname, k.conname), replace(pg_get_constraintdef(k.oid), ' NOT VALID', '')
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not c.relispartition
  union all
  select 'index', format('%I', i.indexrelid::regclass::text), pg_get_indexdef(i.indexrelid)
  from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not c.relispartition
  union all
  select 'trigger', format('%I.%I', c.relname, t.tgname), format('%s enabled=%s', pg_get_triggerdef(t.oid), t.tgenabled)
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal and not c.relispartition
  union all
  select 'function', p.oid::regprocedure::text,
         format('%s owner=%s definer=%s config=%s acl=%s', md5(pg_get_functiondef(p.oid)), pg_get_userbyid(p.proowner),
                p.prosecdef, p.proconfig, p.proacl)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f', 'p')
  union all
  select 'policy', format('%I.%I', c.relname, pol.polname),
         format('%s %s %s using=%s check=%s', pol.polcmd, pol.polpermissive, pol.polroles::regrole[],
                pg_get_expr(pol.polqual, pol.polrelid), pg_get_expr(pol.polwithcheck, pol.polrelid))
  from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not c.relispartition
) as objects
order by 1;
