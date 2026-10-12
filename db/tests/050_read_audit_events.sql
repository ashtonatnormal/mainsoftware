-- ADM-06, ACC-10, PDPA-13, CLAUDE.md Database: read_audit_events() is the only way hearth_app
-- reads the audit log. It takes the reader from app.user_id and the org from app.org_id, both set
-- from the session, and lets in only an Owner, Admin, DPO or Compliance Officer who is still at
-- the org; one case per ACC-10 role. It returns only the org's rows and logs every read.
\ir fixtures/two_orgs.sql

-- Allowed: Owner (a1), Admin (a2), DPO (a5), Compliance Officer (a6).
do $$
declare
  reader text;
  rows_read bigint;
  other_org bigint;
begin
  foreach reader in array array['a1', 'a2', 'a5', 'a6'] loop
    perform pg_temp.act_as('1', reader);
    select count(*), count(*) filter (where org_id <> pg_temp.id('1', '00'))
      into rows_read, other_org
      from public.read_audit_events(now() - interval '1 day', now() + interval '1 day');
    perform set_config('role', 'none', true);
    -- The fixture's role.granted entry, this read's own audit.read entry, and each earlier
    -- reader's audit.read entry.
    perform pg_temp.check(rows_read >= 2, format('%s read %s audit row(s)', reader, rows_read));
    perform pg_temp.check(other_org = 0, format('%s read %s row(s) of another org', reader, other_org));
    perform pg_temp.check(exists (
      select 1 from public.audit_events
      where org_id = pg_temp.id('1', '00') and actor_id = pg_temp.id('1', reader) and action = 'audit.read'),
      format('the read by %s was not logged', reader));
  end loop;
end
$$;

-- Refused: AI Admin (a3), Leadership (a4), Team Admin (a7), Member (a8), a DPO who has left (a9),
-- a former Admin (aa), and an agent (ab).
do $$
declare
  reader text;
begin
  foreach reader in array array['a3', 'a4', 'a7', 'a8', 'a9', 'aa', 'ab'] loop
    perform pg_temp.act_as('1', reader);
    perform pg_temp.expect_error(
      $q$select count(*) from public.read_audit_events(now() - interval '1 day', now() + interval '1 day')$q$,
      '42501', 'Only an Owner, Admin, DPO or Compliance Officer can read the audit log.');
    perform set_config('role', 'none', true);
  end loop;
end
$$;

-- Refused: the other org's Owner, acting in this org (their roles are in their own org).
select set_config('app.org_id', pg_temp.id('1', '00')::text, true),
       set_config('app.user_id', pg_temp.id('2', 'a1')::text, true);
set local role hearth_app;
select pg_temp.expect_error($$select count(*) from public.read_audit_events(now() - interval '1 day', now())$$, '42501');

-- Refused: no user set, or no org set.
reset role;
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', '', true);
set local role hearth_app;
select pg_temp.expect_error($$select count(*) from public.read_audit_events(now() - interval '1 day', now())$$, '42501');
reset role;
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a1')::text, true);
set local role hearth_app;
select pg_temp.expect_error($$select count(*) from public.read_audit_events(now() - interval '1 day', now())$$, '42501');

-- Bad arguments.
reset role;
select pg_temp.act_as('1', 'a1');
select pg_temp.expect_error($$select count(*) from public.read_audit_events(now(), now() - interval '1 day')$$, '22023');
select pg_temp.expect_error($$select count(*) from public.read_audit_events(now() - interval '1 day', now(), null, 0)$$, '22023');
select pg_temp.expect_error($$select count(*) from public.read_audit_events(now() - interval '1 day', now(), null, 1001)$$, '22023');

-- The period and the paging: rows outside [from, to) stay out, results come newest first, and
-- before_id returns only older rows. (As the superuser, add an old row and two more recent ones.)
reset role;
insert into public.audit_events (org_id, action, at) values
  ('f1000000-0000-4000-8000-000000000000', 'test.old', now() - interval '3 days'),
  ('f1000000-0000-4000-8000-000000000000', 'test.page_a', now()),
  ('f1000000-0000-4000-8000-000000000000', 'test.page_b', now());
select pg_temp.act_as('1', 'a1');
do $$
declare
  page bigint[];
  next_page bigint[];
  everything bigint[];
begin
  select array_agg(r.id order by r.ordinality) into everything
  from public.read_audit_events(now() - interval '1 day', now() + interval '1 day') with ordinality as r;
  perform pg_temp.check(everything = (select array_agg(x order by x desc) from unnest(everything) x), 'rows are not newest first');
  perform pg_temp.check(not exists (
    select 1 from public.read_audit_events(now() - interval '1 day', now() + interval '1 day') r where r.action = 'test.old'),
    'a row from before the period was returned');

  select array_agg(r.id order by r.ordinality) into page
  from public.read_audit_events(now() - interval '1 day', now() + interval '1 day', null, 2) with ordinality as r;
  perform pg_temp.check(cardinality(page) = 2 and page[1] > page[2], format('max_rows or the order is wrong: %s', page));
  select array_agg(r.id order by r.ordinality) into next_page
  from public.read_audit_events(now() - interval '1 day', now() + interval '1 day', page[1], 1) with ordinality as r;
  perform pg_temp.check(next_page = array[page[2]], format('before_id %s returned %s, not %s', page[1], next_page, page[2]));
end
$$;
