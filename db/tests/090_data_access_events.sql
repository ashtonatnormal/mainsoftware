-- ADM-06, PDPA-06, INF-ACCESSEVENTS, BUILD-PLAN Part 1D seams: the data access stream takes the
-- core event types and the reserved AI ones, one row per subject who is a person of the org,
-- partitioned by month from this month for at least a year.
\ir fixtures/two_orgs.sql

select pg_temp.act_as('1', 'a2');

-- Every type, including those reserved for A1 and A2.
insert into public.data_access_events (org_id, type, subject_id, actor_id, object_type, object_id, provider, data_type, case_id)
select 'f1000000-0000-4000-8000-000000000000', t, 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a2',
       'session', 's-1', case t when 'provider.send' then 'livekit' end, case t when 'provider.send' then 'audio' end,
       case t when 'privileged.read' then gen_random_uuid() end
from unnest(array['export', 'share', 'recording.view', 'privileged.read', 'provider.send', 'ai.retrieval', 'transcript.view']) as t;
-- An assistant reading for its person (A4).
insert into public.data_access_events (org_id, type, subject_id, actor_id, on_behalf_of_id, via, object_type, object_id)
values ('f1000000-0000-4000-8000-000000000000', 'ai.retrieval', 'f1000000-0000-4000-8000-0000000000a7',
        'f1000000-0000-4000-8000-0000000000ac', 'f1000000-0000-4000-8000-0000000000a8', 'assistant', 'message', 'm-1');

select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id)
  values ('f1000000-0000-4000-8000-000000000000', 'peek', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a2')$$, '23514');
-- A provider send names the provider and the kind of data; nothing else does.
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id)
  values ('f1000000-0000-4000-8000-000000000000', 'provider.send', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a2')$$, '23514');
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id, provider, data_type)
  values ('f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a2', 'livekit', 'audio')$$, '23514');
-- A privileged read names its Rule 9 case (C1.11), and only a privileged read has one.
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id)
  values ('f1000000-0000-4000-8000-000000000000', 'privileged.read', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a5')$$,
  '23514', '%data_access_events_privileged_has_case%');
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id, case_id)
  values ('f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a5', gen_random_uuid())$$,
  '23514', '%data_access_events_privileged_has_case%');
-- The subject is a person of the org: not an agent, not another org's person.
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id)
  values ('f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000ab', 'f1000000-0000-4000-8000-0000000000a2')$$, '23503');
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id)
  values ('f1000000-0000-4000-8000-000000000000', 'export', 'f2000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a2')$$, '23503');
reset role;
-- A row dated before the first partition, or past the last, fails rather than vanishing. (Only
-- the owner can date a row; hearth_app's rows take the time of the write.)
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id, at)
  values ('f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a2', now() - interval '20 years')$$,
  '23514', 'no partition of relation%');
select pg_temp.expect_error($$insert into public.data_access_events (org_id, type, subject_id, actor_id, at)
  values ('f1000000-0000-4000-8000-000000000000', 'export', 'f1000000-0000-4000-8000-0000000000a8', 'f1000000-0000-4000-8000-0000000000a2', now() + interval '20 years')$$,
  '23514', 'no partition of relation%');

-- Partitions: whole UTC months back to back, from this month to at least 12 months on, each with
-- row level security on and no grants.
do $$
declare
  first_from timestamptz;
  last_to timestamptz;
  bad integer;
begin
  with bounds as (
    select c.relrowsecurity, c.relacl,
           (regexp_match(pg_get_expr(c.relpartbound, c.oid), $r$FROM \('([^']+)'\) TO \('([^']+)'\)$r$)) as b
    from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.data_access_events'::regclass
  ), months as (
    select relrowsecurity, relacl, b[1]::timestamptz as lo, b[2]::timestamptz as hi from bounds
  ), ordered as (
    select *, lead(lo) over (order by lo) as next_lo from months
  )
  select min(lo), max(hi),
         count(*) filter (where (hi <> next_lo) or date_add(lo, interval '1 month', 'UTC') <> hi
                          or date_trunc('month', lo, 'UTC') <> lo or not relrowsecurity or relacl is not null)
    into first_from, last_to, bad
  from ordered;
  perform pg_temp.check(bad = 0, 'a partition is not one whole UTC month, back to back, with row level security and no grants');
  perform pg_temp.check(first_from <= now() and last_to >= now() + interval '12 months',
                        format('the partitions run from %s to %s, not this month to a year on', first_from, last_to));
end
$$;

-- create_data_access_partitions() adds what's missing and leaves the rest, in any session time
-- zone.
set local timezone = 'America/New_York';
select public.create_data_access_partitions(14);
select pg_temp.check(count(*) >= 15, 'create_data_access_partitions(14) did not add the missing months')
from pg_inherits where inhparent = 'public.data_access_events'::regclass;
select pg_temp.check(bool_and(date_trunc('month', lo, 'UTC') = lo and date_add(lo, interval '1 month', 'UTC') = hi),
                     'a partition made in another session time zone is not one whole UTC month')
from (
  select b[1]::timestamptz as lo, b[2]::timestamptz as hi
  from pg_inherits i join pg_class c on c.oid = i.inhrelid,
       regexp_match(pg_get_expr(c.relpartbound, c.oid), $r$FROM \('([^']+)'\) TO \('([^']+)'\)$r$) as b
  where i.inhparent = 'public.data_access_events'::regclass
) bounds;
select pg_temp.expect_error($$select public.create_data_access_partitions(25)$$, '22023');
