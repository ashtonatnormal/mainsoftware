-- ACC-11, CLAUDE.md Database: every table's row level security is the one org-scoped policy, for
-- reads and writes alike. 010 and 020 show reads are scoped; this pins the policy text itself, so
-- a write check loosened to (true), an extra permissive policy that widens access, or a policy
-- for another role can't slip in without editing this test. Partitions carry no policies of their
-- own (their parent's apply), and the migrator's ledger has no row level security (hearth_app
-- has no grant on it).
\ir fixtures/two_orgs.sql

do $$
declare
  scoped constant text := '(org_id = (NULLIF(current_setting(''app.org_id''::text, true), ''''::text))::uuid)';
  own_org constant text := '(id = (NULLIF(current_setting(''app.org_id''::text, true), ''''::text))::uuid)';
  expected text[];
  actual text[];
  missing text[];
  extra text[];
begin
  -- One line per policy: table, name, permissive or restrictive, command, roles, using, check.
  select array_agg(e order by e) into expected from (
    select format('%s|org_isolation|PERMISSIVE|ALL|{public}|%s|%s', c.relname, scoped, scoped) as e
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
      and c.relname not in ('orgs', 'audit_events', 'data_access_events', 'kysely_migration', 'kysely_migration_lock')
    union all
    -- The org row itself: its id is the org id, and nothing writes it through hearth_app.
    select format('orgs|org_isolation|PERMISSIVE|ALL|{public}|%s|', own_org)
    union all
    -- The append-only logs: adding a row for the org, nothing else.
    select format('%s|org_isolation|PERMISSIVE|INSERT|{public}||%s', t, scoped)
    from unnest(array['audit_events', 'data_access_events']) as t
    union all
    -- hearth_app creates only human principals (A4 and A5 widen this).
    select 'principals|server_creates_humans|RESTRICTIVE|INSERT|{public}||(kind = ''human''::text)'
  ) x;

  select coalesce(array_agg(a order by a), '{}') into actual from (
    select format('%s|%s|%s|%s|%s|%s|%s', p.tablename, p.policyname, p.permissive, p.cmd, p.roles::text,
                  coalesce(p.qual, ''), coalesce(p.with_check, '')) as a
    from pg_policies p
    where p.schemaname not like 'pg\_%' and p.schemaname <> 'information_schema'
  ) y;

  -- The registers (0009) are among them, by name, so they can't drop out of the list unseen.
  perform pg_temp.check(expected @> (select array_agg(format('%s|org_isolation|PERMISSIVE|ALL|{public}|%s|%s', t, scoped, scoped))
                                     from unnest(array['processing_register', 'transfer_register', 'transfer_clearances',
                                                       'processing_restrictions']) t),
                        'a register table is missing from the expected policies');
  -- So are the notice's tables (0003) and its links (0010, C0.9 PD-34), and the DPO's contact
  -- (0011, C0.9 PD-63).
  perform pg_temp.check(expected @> (select array_agg(format('%s|org_isolation|PERMISSIVE|ALL|{public}|%s|%s', t, scoped, scoped))
                                     from unnest(array['notice_versions', 'notice_acknowledgments', 'notice_version_purposes',
                                                       'notice_version_providers', 'dpo_settings']) t),
                        'a notice table is missing from the expected policies');

  select coalesce(array_agg(e order by e), '{}') into missing from unnest(expected) e where e <> all (actual);
  select coalesce(array_agg(a order by a), '{}') into extra from unnest(actual) a where a <> all (expected);
  perform pg_temp.check(cardinality(missing) = 0, format('these policies are missing or changed: %s', missing));
  perform pg_temp.check(cardinality(extra) = 0,
    format('policies this test does not list (add them only if they are meant): %s', extra));

  -- Row level security is on everywhere that holds rows, partitions included (the ledger aside).
  perform pg_temp.check(not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema' and c.relkind in ('r', 'p')
      and not c.relrowsecurity and not (n.nspname = 'public' and c.relname in ('kysely_migration', 'kysely_migration_lock'))),
    'a table has row level security off');
end
$$;
