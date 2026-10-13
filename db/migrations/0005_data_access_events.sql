-- C0.3: the data access stream (ADM-06, PDPA-06; INF-ACCESSEVENTS).
--
-- One row per person whose data was used or disclosed: an export, a share, a recording viewed, a
-- send to an outside provider, a privileged read, and later an AI retrieval. It answers "how was
-- my data used" for an access request (PDPA-05, PDPA-06) and "viewed by" on a recording (REC-21),
-- so it is indexed by that person (the subject). Like the audit log it is append-only for
-- hearth_app; the readers that need it (C1.11, C2.8, C6.2) come with SECURITY DEFINER functions.
--
-- It is the busiest log (AI retrievals are recorded once per item, A2), so it is partitioned by
-- month. Retention (ADM-06, PDPA-09; the retention engine, C0.10) deletes rows past their period
-- except those under a legal or access-request hold, logging what it deletes, and can drop a
-- month's partition once nothing in it is held. This migration creates this month and the next
-- 12; create_data_access_partitions() adds more and the C0.6 scheduler runs it monthly. A row
-- dated outside every partition fails to insert, loudly.
create table public.data_access_events (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  at timestamptz not null default now(),
  -- What happened. Reserved, not yet written (BUILD-PLAN Part 1D seams):
  --   ai.retrieval     an AI feature read the item (once per item retrieved; A2)
  --   transcript.view  someone opened a transcript (A1)
  -- provider.send starts in C2.2 with LiveKit, and AI providers join it in A1.
  type text not null check (type in (
    'export', 'share', 'recording.view', 'privileged.read', 'provider.send',
    'ai.retrieval', 'transcript.view'
  )),
  -- Whose data it was.
  subject_id uuid not null,
  -- Who or what used it: a person, an agent, an assistant or Hearth itself.
  actor_id uuid not null,
  -- For an assistant or agent, the person it acted for, and the feature it acted through (e.g.
  -- 'assistant', 'agent', 'ask'). Unused until A3-A5.
  on_behalf_of_id uuid,
  via text check (via ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  -- The item involved, by kind and id, e.g. ('session', <id>) or ('file', <id>).
  object_type text check (object_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  object_id text check (length(object_id) between 1 and 200),
  -- For provider.send: which outside provider (PDPA-10) and what kind of data, never the data.
  provider text check (provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  data_type text check (data_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  request_id text check (length(request_id) between 1 and 200),
  -- For privileged.read: the Rule 9 case it was read under (C1.11), a plain id like audit_events'.
  case_id uuid,
  details jsonb not null default '{}' check (jsonb_typeof(details) = 'object'),
  primary key (id, at),
  check ((object_type is null) = (object_id is null)),
  check ((type = 'provider.send') = (provider is not null and data_type is not null)),
  constraint data_access_events_privileged_has_case check ((type = 'privileged.read') = (case_id is not null)),
  foreign key (org_id, subject_id) references public.people (org_id, id),
  foreign key (org_id, actor_id) references public.principals (org_id, id),
  foreign key (org_id, on_behalf_of_id) references public.principals (org_id, id)
) partition by range (at);
create index data_access_events_subject on public.data_access_events (org_id, subject_id, at);
create index data_access_events_object on public.data_access_events (org_id, object_type, object_id, at);

-- Policies on the partitioned table apply to every row read or written through it. Partitions get
-- row level security with no policy and no grants, so nobody but the owner reaches one directly.
alter table public.data_access_events enable row level security;
create policy org_isolation on public.data_access_events for insert
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
-- Not id or at: each row takes a new id and the time of the write. A time that differs from the
-- write (a provider send's window, say) goes in details.
grant insert (org_id, type, subject_id, actor_id, on_behalf_of_id, via, object_type, object_id, provider, data_type, request_id, case_id, details)
  on public.data_access_events to hearth_app;

-- Creates the month partitions from this month to months_ahead months on, skipping any that
-- exist. Each covers one calendar month in UTC: the function runs in UTC, so the month arithmetic
-- and the bounds it writes don't depend on the caller's time zone.
create function public.create_data_access_partitions(months_ahead integer) returns void
language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  month timestamptz;
  name text;
begin
  if months_ahead is null or months_ahead not between 0 and 24 then
    raise exception 'months_ahead must be between 0 and 24' using errcode = 'invalid_parameter_value';
  end if;
  for month in
    select pg_catalog.generate_series(
      pg_catalog.date_trunc('month', pg_catalog.now()),
      pg_catalog.date_trunc('month', pg_catalog.now()) + pg_catalog.make_interval(months => months_ahead),
      interval '1 month')
  loop
    name := 'data_access_events_' || pg_catalog.to_char(month, 'YYYY_MM');
    if pg_catalog.to_regclass('public.' || name) is null then
      execute pg_catalog.format(
        'create table public.%I partition of public.data_access_events for values from (%L) to (%L)',
        name, month, month + interval '1 month');
      execute pg_catalog.format('alter table public.%I enable row level security', name);
    end if;
  end loop;
end
$$;
revoke execute on function public.create_data_access_partitions(integer) from public;

select public.create_data_access_partitions(12);
