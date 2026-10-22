-- C0.9 PR 1 (C0.9 OD-02): the processing register (PDPA-01), the transfer register (PDPA-10) and the
-- processing-restrictions hook (the PDPA-04a seam) (BUILD-PLAN C0.9; INF-COMPLIANCE,
-- INF-PURPOSEGATE, INF-RESTRICT; TECH-SPEC T22).
--
-- The processing register says why Hearth processes personal data: one entry per org and purpose
-- (PURPOSES in packages/shared), kept in versions. A change inserts the next version under a lock
-- on the one before, and nothing is updated or deleted, so the notice (C0.9 PR 2) can point at the
-- exact entries it was made from, and the current entry is the highest version (C0.9 PD-04). The
-- transfer register lists the providers that receive personal data: one entry per org and provider
-- (PROVIDERS), whose facts change in place under a revision, and whose clearances are kept as
-- episodes in transfer_clearances, each with a snapshot of the facts it rested on (C0.9 PD-05). An
-- outbound client sends a provider personal data only while its entry has an open clearance, which
-- it asks transfer_cleared() in the transaction that decides the send (C0.9 PD-15).
--
-- Both registers are the DPO's alone (PDPA-01 "maintained by the DPO", PDPA-13): they change only
-- through the checked functions below, which the api calls after can() allows the change and which
-- re-check the DPO in tables and write the audit event (ADM-06); the api appends the outbox event in
-- the same transaction. The first-Owner bootstrap clears Twilio's and AWS's entries once, through
-- bootstrap_transfer_clearance(), which only the owner can run (C0.9 OD-01, PD-23).
--
-- Two purposes are pinned, accounts and service_operation, the purposes of core.system (locked on):
-- always active and never resting on consent, because sign-in, revocation, offboarding and Hearth's
-- own upkeep run on them (T19 item 4, C0.9 PD-07). Every AI purpose stays planned with nothing
-- recorded, and no AI provider can be cleared, until A0's migration lifts both: the second lock
-- behind the ai.* flags (D41). Each purpose's ai, pinned and needs_switch are fixed by
-- processing_register_defaults(), copied by every version, and compared with code in CI.
--
-- processing_restrictions is the hook for one person's withdrawal (PDPA-04a): it has no writer and
-- no hearth_app grant until C2.11, and only the worker reads it.
--
-- No existing row changes. This adds tables, functions and grants; gives every new org its register
-- entries through a trigger on orgs (and the orgs already here theirs, below); and, as its last
-- statement, replaces outbox_events_type with a superset that adds the two register events. The
-- notice tables (0003) are untouched; PR 2 links them to the register.

-- PDPA-01: each purpose's entry, in versions that never change. Version 1 is Hearth's and names
-- nobody (recorded_by empty): pinned purposes, security_audit and backups start active and every
-- other one planned, all with no basis recorded, since Hearth never asserts a legal basis for the
-- DPO (C0.9 PD-06). Later versions are the DPO's, through set_register_purpose(). An entry records
-- its status, one of PDPA-01's seven bases with the attachment it needs (where the legitimate
-- interests assessment is kept; where the assessment for deemed consent by notification is kept,
-- and its opt-out window; the provision another exception relies on), how long the data is kept,
-- and the providers involved (non-AI keys of the transfer register).
create table public.processing_register (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  purpose text not null check (purpose ~ '^[a-z][a-z0-9_]{0,62}$'),
  -- Fixed per purpose by processing_register_defaults(); each version copies them from the one
  -- before. ai: only the AI layer serves it (A0 onwards). pinned: a flag that is locked on names it
  -- (core.system). needs_switch: withdrawing it needs a per-person switch (PDPA-04).
  ai boolean not null,
  pinned boolean not null,
  needs_switch boolean not null,
  version integer not null check (version >= 1),
  status text not null check (status in ('planned', 'active', 'retired')),
  basis text check (basis in ('employment', 'legitimate_interests', 'business_improvement', 'consent',
                              'deemed_consent_conduct', 'deemed_consent_notification', 'other_exception')),
  basis_reference text check (basis_reference = btrim(basis_reference) and length(basis_reference) between 1 and 1000),
  opt_out_days integer check (opt_out_days between 1 and 365),
  retention text check (retention = btrim(retention) and length(retention) between 1 and 1000),
  providers text[] not null default '{}' check (
    cardinality(providers) <= 20 and array_position(providers, null) is null
    and pg_catalog.array_to_string(providers, ',') ~ '^([a-z][a-z0-9_]{0,62}(,[a-z][a-z0-9_]{0,62})*)?$'),
  recorded_at timestamptz not null default now(),
  recorded_by uuid,
  unique (org_id, id),
  unique (org_id, purpose, version),
  -- Version 1 is Hearth's, naming nobody; every later one names who recorded it.
  constraint processing_register_recorded_by check ((recorded_by is null) = (version = 1)),
  -- PDPA-01's attachments: a reference for legitimate interests, deemed consent by notification
  -- (s15A) and another exception, and an opt-out window for s15A alone.
  constraint processing_register_attachment check (
    (basis_reference is not null) = coalesce(basis in ('legitimate_interests', 'deemed_consent_notification', 'other_exception'), false)
    and (opt_out_days is not null) = coalesce(basis = 'deemed_consent_notification', false)),
  -- Once the DPO has edited an entry, only a planned purpose may lack a basis or retention.
  constraint processing_register_recorded check (status = 'planned' or version = 1 or (basis is not null and retention is not null)),
  -- The second lock (D41): an AI purpose stays planned with nothing recorded. A0's migration
  -- replaces this.
  constraint processing_register_ai_planned check (
    not ai or (status = 'planned' and basis is null and retention is null and cardinality(providers) = 0)),
  -- Hearth runs on these (T19 item 4, C0.9 PD-07): active, and never on a consent-type basis.
  constraint processing_register_pinned check (
    not pinned or (status = 'active'
                   and coalesce(basis not in ('consent', 'deemed_consent_conduct', 'deemed_consent_notification'), true))),
  -- PDPA-04: a purpose whose withdrawal needs a per-person switch rests on no consent-type basis
  -- until those switches exist (C0.9 PD-11). C2.11's migration replaces this.
  constraint processing_register_switch check (
    not needs_switch
    or coalesce(basis not in ('consent', 'deemed_consent_conduct', 'deemed_consent_notification'), true)),
  foreign key (org_id, recorded_by) references public.principals (org_id, id)
);

-- Every purpose an org's register has, with its fixed facts and the status version 1 starts with
-- (C0.9 PD-03, PD-06). A migration that adds a purpose key, or changes what is pinned, replaces this
-- function and inserts or updates the rows of the orgs already there (as T17 item 1 does for flags);
-- apps/server/scripts/check-catalogues.ts fails CI unless it lists exactly PURPOSES, with ai as
-- PURPOSES has it, pinned exactly for PINNED_PURPOSES, and needs_switch and the status as
-- packages/shared has them. Only the owner reads it (the trigger below, CI's check).
create function public.processing_register_defaults()
  returns table (purpose text, ai boolean, pinned boolean, needs_switch boolean, status text)
language sql immutable set search_path = '' as $$
  values
    -- Pinned: core.system's purposes.
    ('accounts', false, true, false, 'active'),
    ('service_operation', false, true, false, 'active'),
    -- Active from the start, with no basis recorded yet: Hearth writes the audit log from C0.3, and
    -- every database is backed up. The DPO records their basis before the first notice (PR 2).
    ('security_audit', false, false, false, 'active'),
    ('backups', false, false, false, 'active'),
    -- Planned until the DPO records them and a published notice lists them.
    ('content_delivery', false, false, false, 'planned'),
    ('access_logs', false, false, false, 'planned'),
    ('presence_receipts', false, false, false, 'planned'),
    ('session_slides', false, false, false, 'planned'),
    ('session_sharing', false, false, false, 'planned'),
    ('people_insights', false, false, false, 'planned'),
    ('sensitive_data_detection', false, false, false, 'planned'),
    -- PDPA-04's list: recording, transcription, notes, voice-message transcription, Org Brain or AI
    -- use, whose withdrawal needs a per-person switch.
    ('recording_meetings', false, false, true, 'planned'),
    ('recording_drop_in', false, false, true, 'planned'),
    ('transcription', true, false, true, 'planned'),
    ('voice_message_transcription', true, false, true, 'planned'),
    ('meeting_notes', true, false, true, 'planned'),
    ('org_brain', true, false, true, 'planned'),
    ('ai_writing', true, false, true, 'planned'),
    ('people_inference', true, false, true, 'planned'),
    ('assistant', true, false, true, 'planned'),
    ('agents', true, false, true, 'planned'),
    ('ai_cost_figures', true, false, true, 'planned'),
    -- Withdrawn by deleting the person's clips, so it needs no switch.
    ('transcription_test_set', true, false, false, 'planned')
$$;
revoke execute on function public.processing_register_defaults() from public;

-- PDPA-10, D46: one entry per org and provider, whose facts change in place under a revision. Its
-- facts: the services and the personal data it receives; the countries where it processes and
-- stores that data (ISO codes), with where and when it confirmed them in writing; the safeguard and
-- its reference (a certification counts only once the certificate is verified); that the agreement
-- binds protection comparable to the PDPA, names the countries and requires prompt notice of an
-- incident; whether it trains on the data; the result of applying for zero retention; how long it
-- keeps the data, with its written confirmation; who it passes the data on to; and when the entry
-- is next reviewed. Revision 1 is Hearth's, with nothing recorded; nobody can change a fact while a
-- clearance is open (transfer_register_check).
create table public.transfer_register (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{0,62}$'),
  -- Fixed per provider by transfer_register_defaults(): an AI provider (openai, bedrock) is never
  -- cleared before A0.
  ai boolean not null,
  services text check (length(services) between 1 and 500),
  data_types text check (length(data_types) between 1 and 1000),
  processing_countries text[] not null default '{}',
  storage_countries text[] not null default '{}',
  countries_confirmed text check (length(countries_confirmed) between 1 and 500),
  safeguard text check (safeguard in ('dpa', 'dpa_addendum', 'certification')),
  safeguard_reference text check (length(safeguard_reference) between 1 and 500),
  certificate_verified_on date,
  dpa_terms_confirmed boolean not null default false,
  training text check (training in ('off', 'not_applicable')),
  zero_retention text check (zero_retention in ('granted', 'refused', 'not_offered', 'not_applicable', 'pending')),
  provider_retention text check (length(provider_retention) between 1 and 1000),
  retention_confirmed text check (length(retention_confirmed) between 1 and 500),
  onward_recipients text check (length(onward_recipients) between 1 and 1000),
  review_on date,
  revision bigint not null default 1 check (revision >= 1),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (org_id, id),
  unique (org_id, provider),
  unique (org_id, id, provider),
  -- Revision 1 is Hearth's, naming nobody; every later one names who recorded it.
  constraint transfer_register_updated check ((updated_by is null) = (revision = 1)),
  -- Country codes: two capital letters each, at most 60, none empty.
  constraint transfer_register_countries check (
    array_position(processing_countries, null) is null and array_position(storage_countries, null) is null
    and pg_catalog.array_to_string(processing_countries, ',') ~ '^([A-Z]{2}(,[A-Z]{2}){0,59})?$'
    and pg_catalog.array_to_string(storage_countries, ',') ~ '^([A-Z]{2}(,[A-Z]{2}){0,59})?$'),
  -- PDPA-10: certification is a safeguard only once the certificate is verified.
  constraint transfer_register_certificate check (safeguard is distinct from 'certification' or certificate_verified_on is not null),
  foreign key (org_id, updated_by) references public.principals (org_id, id)
);

-- Every provider an org's register has (C0.9 PD-03, PD-14): PROVIDERS in packages/shared, with ai
-- for the AI layer's (CI compares the two). A migration that adds a provider replaces this function
-- and inserts rows for the orgs already there. Only the owner reads it.
create function public.transfer_register_defaults() returns table (provider text, ai boolean)
language sql immutable set search_path = '' as $$
  values
    ('aws', false),
    ('aws_sms', false),
    ('twilio', false),
    ('livekit', false),
    ('openai', true),
    ('bedrock', true),
    ('apple_push', false),
    ('google_fcm', false),
    ('mozilla_push', false),
    ('microsoft_wns', false)
$$;
revoke execute on function public.transfer_register_defaults() from public;

-- An entry's facts as one object: what a clearance rests on (its snapshot), what a fact change is
-- compared by, and what the audit row of a change records (from and to). Facts only, never who or
-- when; they hold nobody's personal data.
create function public.transfer_register_facts(e public.transfer_register) returns jsonb
language sql stable set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'services', (e).services,
    'data_types', (e).data_types,
    'processing_countries', (e).processing_countries,
    'storage_countries', (e).storage_countries,
    'countries_confirmed', (e).countries_confirmed,
    'safeguard', (e).safeguard,
    'safeguard_reference', (e).safeguard_reference,
    'certificate_verified_on', (e).certificate_verified_on,
    'dpa_terms_confirmed', (e).dpa_terms_confirmed,
    'training', (e).training,
    'zero_retention', (e).zero_retention,
    'provider_retention', (e).provider_retention,
    'retention_confirmed', (e).retention_confirmed,
    'onward_recipients', (e).onward_recipients,
    'review_on', (e).review_on)
$$;
revoke execute on function public.transfer_register_facts(public.transfer_register) from public;

-- Country codes as an entry keeps them: upper case, sorted, each once.
create function public.transfer_countries(codes text[]) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(pg_catalog.array_agg(distinct pg_catalog.upper(c) order by pg_catalog.upper(c)), '{}')
  from pg_catalog.unnest(codes) c
$$;
revoke execute on function public.transfer_countries(text[]) from public;

-- Each clearance of an entry (PDPA-10, C0.9 PD-05): who decided (the DPO), how (in the app, or by
-- the first-Owner bootstrap), and, stamped by its trigger whatever the writer sent, the revision
-- and a snapshot of the facts it rests on. It ends once (keep_history): by the DPO's decision, or
-- because new facts were recorded (facts_changed). At most one is open per provider.
create table public.transfer_clearances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  entry_id uuid not null,
  provider text not null,
  register_revision bigint not null check (register_revision >= 1),
  facts jsonb not null check (jsonb_typeof(facts) = 'object'),
  cleared_at timestamptz not null default now(),
  cleared_by uuid not null,
  cleared_via text not null check (cleared_via in ('app', 'bootstrap')),
  withdrawn_at timestamptz,
  withdrawn_by uuid,
  withdraw_reason text check (withdraw_reason in ('dpo_decision', 'facts_changed')),
  unique (org_id, id),
  constraint transfer_clearances_withdrawn check (
    (withdrawn_at is null) = (withdrawn_by is null) and (withdrawn_at is null) = (withdraw_reason is null)),
  foreign key (org_id, entry_id, provider) references public.transfer_register (org_id, id, provider),
  foreign key (org_id, cleared_by) references public.principals (org_id, id),
  foreign key (org_id, withdrawn_by) references public.principals (org_id, id)
);
create unique index transfer_clearances_open on public.transfer_clearances (org_id, provider) where withdrawn_at is null;
create trigger transfer_clearances_keep_history before update of withdrawn_at, withdrawn_by, withdraw_reason
  on public.transfer_clearances for each row execute function public.keep_history('withdrawn_at', 'withdrawn_by', 'withdraw_reason');

-- A cleared entry's facts can't change: what the clearance rests on stays what was recorded.
-- Recording new facts ends the clearance first (record_transfer_entry). A change that waits for a
-- clearance in progress (which holds the entry FOR SHARE) runs this once that has committed, and
-- then sees it. The message can be shown as it is.
create function public.transfer_register_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if public.transfer_register_facts(new) is distinct from public.transfer_register_facts(old)
     and exists (select 1 from public.transfer_clearances c
                 where c.org_id = old.org_id and c.entry_id = old.id and c.withdrawn_at is null) then
    raise exception 'A cleared entry''s facts can''t change. End its clearance first.' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function public.transfer_register_check() from public;
create trigger transfer_register_check before update on public.transfer_register
  for each row execute function public.transfer_register_check();

-- A clearance needs every fact PDPA-10 and D46 ask for (C0.9 PD-12), checked in this order, which
-- packages/shared's transferProblems() mirrors: services; the data it receives; the processing and
-- storage countries and their written confirmation; the safeguard and its reference (a certificate
-- not verified on a date still to come); the agreement's terms; training; a zero-retention result
-- (pending isn't one); the provider's retention and its written confirmation; who it passes the data
-- on to; and a review date after today in the org's time zone. An AI provider is never cleared
-- before A0 (D41). The entry is read FOR SHARE, so a change to its facts in progress makes this
-- wait and then see it, and one that starts later waits for this transaction; the row is stamped
-- with the provider, the revision and the facts read then. The messages can be shown as they are;
-- the code is Hearth's own (HF006), which the api answers as register_invalid.
create function public.transfer_clearances_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  e public.transfer_register%rowtype;
  today date;
begin
  select * into e from public.transfer_register t where t.org_id = new.org_id and t.id = new.entry_id for share;
  if not found then
    raise exception 'There is no such entry in the transfer register.' using errcode = 'foreign_key_violation';
  end if;
  new.provider := e.provider;
  new.register_revision := e.revision;
  new.facts := public.transfer_register_facts(e);
  select (pg_catalog.now() at time zone o.time_zone)::date into today from public.orgs o where o.id = new.org_id;
  if e.ai then
    raise exception 'Providers for later stages can''t be cleared until their stage begins.' using errcode = 'HF006';
  elsif e.services is null then
    raise exception 'Record the services it provides before clearing it.' using errcode = 'HF006';
  elsif e.data_types is null then
    raise exception 'Record the personal data it receives before clearing it.' using errcode = 'HF006';
  elsif pg_catalog.cardinality(e.processing_countries) = 0 then
    raise exception 'Record the countries where it processes the data before clearing it.' using errcode = 'HF006';
  elsif pg_catalog.cardinality(e.storage_countries) = 0 then
    raise exception 'Record the countries where it stores the data before clearing it.' using errcode = 'HF006';
  elsif e.countries_confirmed is null then
    raise exception 'Record where and when it confirmed those countries in writing before clearing it.' using errcode = 'HF006';
  elsif e.safeguard is null then
    raise exception 'Record the safeguard for the transfer before clearing it.' using errcode = 'HF006';
  elsif e.safeguard_reference is null then
    raise exception 'Record where the safeguard is kept before clearing it.' using errcode = 'HF006';
  elsif e.certificate_verified_on > today then
    raise exception 'A certificate can''t be verified on a date still to come.' using errcode = 'HF006';
  elsif not e.dpa_terms_confirmed then
    raise exception 'Confirm the agreement binds protection comparable to the PDPA, names the countries and requires prompt notice of an incident before clearing it.'
      using errcode = 'HF006';
  elsif e.training is null then
    raise exception 'Record whether it trains on the data before clearing it.' using errcode = 'HF006';
  elsif e.zero_retention is null or e.zero_retention = 'pending' then
    raise exception 'Record the zero-retention result before clearing it. Pending isn''t a result.' using errcode = 'HF006';
  elsif e.provider_retention is null then
    raise exception 'Record how long it keeps the data before clearing it.' using errcode = 'HF006';
  elsif e.retention_confirmed is null then
    raise exception 'Record where and when it confirmed how long it keeps the data in writing before clearing it.' using errcode = 'HF006';
  elsif e.onward_recipients is null then
    raise exception 'Record who it passes the data on to (or None) before clearing it.' using errcode = 'HF006';
  elsif e.review_on is null or e.review_on <= today then
    raise exception 'Set a review date after today before clearing it.' using errcode = 'HF006';
  end if;
  return new;
end
$$;
revoke execute on function public.transfer_clearances_check() from public;
create trigger transfer_clearances_check before insert on public.transfer_clearances
  for each row execute function public.transfer_clearances_check();

-- PDPA-04a's hook (C0.9 PD-10): a person's withdrawal of a purpose that rests on a consent-type
-- basis, from when it takes effect, with who recorded it, the case it came from (PR 3's or C2.11's;
-- a plain id until then) and its lift (keep_history). At most one is live per person and purpose. No
-- writer and no hearth_app grant until C2.11 (who withdrew is sensitive); the worker reads it.
create table public.processing_restrictions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  person_id uuid not null,
  purpose text not null check (purpose ~ '^[a-z][a-z0-9_]{0,62}$'),
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  case_id uuid,
  lifted_at timestamptz,
  lifted_by uuid,
  unique (org_id, id),
  constraint processing_restrictions_lifted check ((lifted_at is null) = (lifted_by is null)),
  foreign key (org_id, person_id) references public.people (org_id, id),
  foreign key (org_id, created_by) references public.principals (org_id, id),
  foreign key (org_id, lifted_by) references public.principals (org_id, id)
);
create unique index processing_restrictions_live on public.processing_restrictions (org_id, person_id, purpose)
  where lifted_at is null;
create trigger processing_restrictions_keep_history before update of lifted_at, lifted_by
  on public.processing_restrictions for each row execute function public.keep_history('lifted_at', 'lifted_by');

-- A restriction is only for a purpose whose current entry rests on a consent-type basis (consent,
-- or deemed consent by conduct or by notification). The purpose's latest version is read FOR SHARE,
-- so a change of basis in progress (which locks that version to add the next) makes this wait; a
-- version is a new row, so once it has waited this reads again until the row it holds is still the
-- latest. A change of basis that starts later waits for this transaction, and then sees the
-- restriction (set_register_purpose). The message can be shown as it is.
create function public.processing_restrictions_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  latest public.processing_register%rowtype;
begin
  loop
    select * into latest from public.processing_register r
    where r.org_id = new.org_id and r.purpose = new.purpose
    order by r.version desc
    limit 1
    for share;
    exit when not found or not exists (
      select 1 from public.processing_register r
      where r.org_id = new.org_id and r.purpose = new.purpose and r.version > latest.version);
  end loop;
  if latest.basis is null or latest.basis not in ('consent', 'deemed_consent_conduct', 'deemed_consent_notification') then
    raise exception 'A processing switch applies only to a purpose the register records as resting on consent.'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function public.processing_restrictions_check() from public;
create trigger processing_restrictions_check before insert on public.processing_restrictions
  for each row execute function public.processing_restrictions_check();

-- A new org gets every purpose's version 1 and every provider's entry, naming nobody, so an org
-- with no principals yet has them too (C0.9 PD-03). Orgs are made by the owner (the bootstrap
-- script, the seed) or a test's superuser, never by hearth_app. The orgs already here get theirs
-- now. A missing row reads as refused or not cleared.
create function public.orgs_add_registers() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status)
  select new.id, d.purpose, d.ai, d.pinned, d.needs_switch, 1, d.status from public.processing_register_defaults() d;
  insert into public.transfer_register (org_id, provider, ai)
  select new.id, d.provider, d.ai from public.transfer_register_defaults() d;
  return null;
end
$$;
revoke execute on function public.orgs_add_registers() from public;
create trigger orgs_add_registers after insert on public.orgs
  for each row execute function public.orgs_add_registers();
insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status)
select o.id, d.purpose, d.ai, d.pinned, d.needs_switch, 1, d.status
from public.orgs o cross join public.processing_register_defaults() d;
insert into public.transfer_register (org_id, provider, ai)
select o.id, d.provider, d.ai from public.orgs o cross join public.transfer_register_defaults() d;

-- Row level security: each table only within the org the server set (CLAUDE.md, Database).
do $$
declare
  t text;
begin
  foreach t in array array['processing_register', 'transfer_register', 'transfer_clearances', 'processing_restrictions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy org_isolation on public.%I
      using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  end loop;
end
$$;

-- The functions that change the registers (set_register_purpose, record_transfer_entry,
-- clear_transfer_entry, withdraw_transfer_clearance) act for the person the server set as
-- app.user_id (CLAUDE.md, Database; packages/access decided first: register.purpose.set,
-- register.transfer.set), who must still be at the org and hold the DPO role. This re-checks both
-- in tables, in the lock order (people, then role_assignments), FOR SHARE, so a deactivation or
-- revocation in progress makes the change wait and then refuse, and one that starts later waits
-- for it. Each function then locks its entry, refuses a stale edit (HF005, which the api answers as
-- register_changed) or a rule (HF006, register_invalid), writes nothing for a change that changes
-- nothing, and writes the audit event (ADM-06). It is no grant's: only those functions call it.
create function public.registers_check_dpo(org uuid, actor uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if org is null or actor is null then
    raise exception 'No org or user is set for this transaction' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.people p where p.org_id = org and p.id = actor and p.deactivated_at is null for share;
  if not found then
    raise exception 'Only the Data Protection Officer can change the registers.' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.role_assignments r
  where r.org_id = org and r.person_id = actor and r.revoked_at is null and r.role = 'dpo'
  for share;
  if not found then
    raise exception 'Only the Data Protection Officer can change the registers.' using errcode = 'insufficient_privilege';
  end if;
end
$$;
revoke execute on function public.registers_check_dpo(uuid, uuid) from public;

-- Records a purpose's next version (PDPA-01, C0.9 PD-04, PD-11, PD-21), from the version the DPO
-- saw (seen). The latest version is locked FOR NO KEY UPDATE, so of two changes from one version
-- the second waits, then finds the newer one and is refused (HF005), as is a change from an older
-- version. Refused (HF006): an AI purpose (planned until A0); a pinned purpose that isn't active or
-- rests on a consent-type basis; a consent-type basis for a purpose whose withdrawal needs a
-- per-person switch (until C2.11); a missing or extra attachment; an active or retired purpose with
-- no basis or retention; a provider that isn't one of the transfer register's or is an AI one; and
-- a basis leaving consent-type while withdrawals (processing_restrictions) are live, which a new
-- restriction can't pass, since it locks this version FOR SHARE. Providers are kept sorted and once
-- each. Returns the current entry, its version and whether anything changed (nothing is written
-- when nothing did). The messages can be shown as they are.
create function public.set_register_purpose(
  purpose_key text,
  seen integer,
  to_status text,
  to_basis text,
  to_basis_reference text,
  to_opt_out_days integer,
  to_retention text,
  to_providers text[],
  request_id text,
  device_id uuid,
  ip inet
) returns table (entry uuid, version integer, changed boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  consent_types constant text[] := array['consent', 'deemed_consent_conduct', 'deemed_consent_notification'];
  cur public.processing_register%rowtype;
  listed text[] := array(select distinct x from pg_catalog.unnest(coalesce(to_providers, '{}')) x order by x);
  new_id uuid := pg_catalog.gen_random_uuid();
  fields text[];
begin
  perform public.registers_check_dpo(org, actor);
  select * into cur from public.processing_register r
  where r.org_id = org and r.purpose = purpose_key
  order by r.version desc
  limit 1
  for no key update;
  if not found then
    raise exception 'There is no purpose %.', purpose_key using errcode = 'invalid_parameter_value';
  end if;
  -- The locking read returns the version it waited for, so a version added meanwhile shows only here.
  if seen is distinct from cur.version or exists (
       select 1 from public.processing_register r
       where r.org_id = org and r.purpose = purpose_key and r.version > cur.version) then
    raise exception 'This entry changed since you opened it. Reload it and try again.' using errcode = 'HF005';
  end if;
  if cur.ai then
    raise exception 'Purposes for later stages stay planned until their stage begins.' using errcode = 'HF006';
  end if;
  if to_status is null or to_status not in ('planned', 'active', 'retired') then
    raise exception 'A purpose is planned, active or retired.' using errcode = 'HF006';
  end if;
  if to_basis not in ('employment', 'legitimate_interests', 'business_improvement', 'consent', 'deemed_consent_conduct',
                      'deemed_consent_notification', 'other_exception') then
    raise exception 'That basis isn''t one the register records.' using errcode = 'HF006';
  end if;
  if cur.pinned and (to_status <> 'active' or coalesce(to_basis = any (consent_types), false)) then
    raise exception 'Hearth needs this purpose for sign-in and its own upkeep, so it stays active and never rests on consent.'
      using errcode = 'HF006';
  end if;
  if cur.needs_switch and coalesce(to_basis = any (consent_types), false) then
    raise exception 'Until per-person switches exist, this purpose can''t rest on consent or deemed consent.'
      using errcode = 'HF006';
  end if;
  if to_basis = 'legitimate_interests' and to_basis_reference is null then
    raise exception 'Record where the legitimate interests assessment is kept.' using errcode = 'HF006';
  end if;
  if to_basis = 'deemed_consent_notification' and (to_basis_reference is null or to_opt_out_days is null) then
    raise exception 'Record where the assessment for deemed consent by notification is kept, and its opt-out window.'
      using errcode = 'HF006';
  end if;
  if to_basis = 'other_exception' and to_basis_reference is null then
    raise exception 'Record the provision relied on.' using errcode = 'HF006';
  end if;
  if to_basis_reference is not null
     and coalesce(to_basis not in ('legitimate_interests', 'deemed_consent_notification', 'other_exception'), true) then
    raise exception 'Only legitimate interests, deemed consent by notification and another exception take a reference.'
      using errcode = 'HF006';
  end if;
  if to_opt_out_days is not null and to_basis is distinct from 'deemed_consent_notification' then
    raise exception 'Only deemed consent by notification takes an opt-out window.' using errcode = 'HF006';
  end if;
  if to_status <> 'planned' and (to_basis is null or to_retention is null) then
    raise exception 'An active or retired purpose needs its basis and how long its data is kept.' using errcode = 'HF006';
  end if;
  if exists (select 1 from pg_catalog.unnest(listed) x
             where x is null or not exists (select 1 from public.transfer_register t
                                            where t.org_id = org and t.provider = x and not t.ai)) then
    raise exception 'Only providers in the transfer register can be listed, and not those for later stages.'
      using errcode = 'HF006';
  end if;
  if cur.basis = any (consent_types) and not coalesce(to_basis = any (consent_types), false)
     and exists (select 1 from public.processing_restrictions x
                 where x.org_id = org and x.purpose = purpose_key and x.lifted_at is null) then
    raise exception 'Withdrawals are recorded against this purpose, so its basis stays consent-based until they''re lifted.'
      using errcode = 'HF006';
  end if;

  fields := pg_catalog.array_remove(array[
    case when cur.status is distinct from to_status then 'status' end,
    case when cur.basis is distinct from to_basis then 'basis' end,
    case when cur.basis_reference is distinct from to_basis_reference then 'basis_reference' end,
    case when cur.opt_out_days is distinct from to_opt_out_days then 'opt_out_days' end,
    case when cur.retention is distinct from to_retention then 'retention' end,
    case when cur.providers is distinct from listed then 'providers' end], null);
  if pg_catalog.cardinality(fields) = 0 then
    return query select cur.id, cur.version, false;
    return;
  end if;
  insert into public.processing_register (id, org_id, purpose, ai, pinned, needs_switch, version, status, basis,
                                          basis_reference, opt_out_days, retention, providers, recorded_by)
  values (new_id, org, cur.purpose, cur.ai, cur.pinned, cur.needs_switch, cur.version + 1, to_status, to_basis,
          to_basis_reference, to_opt_out_days, to_retention, listed, actor);
  insert into public.audit_events (org_id, actor_id, action, target_type, target_id, request_id, device_id, ip, details)
  values (org, actor, 'register.purpose_set', 'processing_purpose', purpose_key, request_id, device_id, ip,
          pg_catalog.jsonb_build_object('version', cur.version + 1, 'was_version', cur.version, 'status', to_status,
                                        'was_status', cur.status, 'basis', to_basis, 'was_basis', cur.basis,
                                        'changed', fields));
  return query select new_id, cur.version + 1, true;
end
$$;
revoke execute on function public.set_register_purpose(text, integer, text, text, text, integer, text, text[], text, uuid, inet)
  from public;

-- Records a provider's facts (PDPA-10, D46; C0.9 PD-05, PD-21), from the revision the DPO saw
-- (seen; HF005 when stale). The entry is locked FOR NO KEY UPDATE, which orders this against
-- clearing and withdrawing it. Countries are kept upper case, sorted and once each. When a fact
-- changes, an open clearance ends first (facts_changed: what it rested on is no longer what is
-- recorded), the facts change and the revision moves on; with keep_cleared ("Save and keep
-- cleared"), a clearance that was open is granted again on the new facts in the same transaction,
-- which transfer_clearances_check() checks, so the whole call is refused (HF006) and nothing changes
-- when the new facts are incomplete. A send's transfer_cleared() then never reads "not cleared" in
-- between. The audit row names each fact that changed, from and to: an entry's facts change in
-- place, so the log keeps their history. AI providers are refused (HF006) until A0. Returns the
-- entry, its revision, whether a clearance is open and whether anything changed.
create function public.record_transfer_entry(
  provider_key text,
  seen bigint,
  services text,
  data_types text,
  processing_countries text[],
  storage_countries text[],
  countries_confirmed text,
  safeguard text,
  safeguard_reference text,
  certificate_verified_on date,
  dpa_terms_confirmed boolean,
  training text,
  zero_retention text,
  provider_retention text,
  retention_confirmed text,
  onward_recipients text,
  review_on date,
  keep_cleared boolean,
  request_id text,
  device_id uuid,
  ip inet
) returns table (entry uuid, revision bigint, cleared boolean, changed boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  cur public.transfer_register%rowtype;
  proposed public.transfer_register%rowtype;
  open_clearance uuid;
  was_facts jsonb;
  new_facts jsonb;
  diff jsonb;
  kept boolean := false;
begin
  perform public.registers_check_dpo(org, actor);
  select * into cur from public.transfer_register t where t.org_id = org and t.provider = provider_key for no key update;
  if not found then
    raise exception 'There is no transfer-register entry for %.', provider_key using errcode = 'invalid_parameter_value';
  end if;
  if cur.ai then
    raise exception 'Providers for later stages can''t be recorded or cleared until their stage begins.' using errcode = 'HF006';
  end if;
  if seen is distinct from cur.revision then
    raise exception 'This entry changed since you opened it. Reload it and try again.' using errcode = 'HF005';
  end if;
  proposed := cur;
  proposed.services := record_transfer_entry.services;
  proposed.data_types := record_transfer_entry.data_types;
  proposed.processing_countries := public.transfer_countries(record_transfer_entry.processing_countries);
  proposed.storage_countries := public.transfer_countries(record_transfer_entry.storage_countries);
  proposed.countries_confirmed := record_transfer_entry.countries_confirmed;
  proposed.safeguard := record_transfer_entry.safeguard;
  proposed.safeguard_reference := record_transfer_entry.safeguard_reference;
  proposed.certificate_verified_on := record_transfer_entry.certificate_verified_on;
  proposed.dpa_terms_confirmed := coalesce(record_transfer_entry.dpa_terms_confirmed, false);
  proposed.training := record_transfer_entry.training;
  proposed.zero_retention := record_transfer_entry.zero_retention;
  proposed.provider_retention := record_transfer_entry.provider_retention;
  proposed.retention_confirmed := record_transfer_entry.retention_confirmed;
  proposed.onward_recipients := record_transfer_entry.onward_recipients;
  proposed.review_on := record_transfer_entry.review_on;
  was_facts := public.transfer_register_facts(cur);
  new_facts := public.transfer_register_facts(proposed);
  select c.id into open_clearance from public.transfer_clearances c
  where c.org_id = org and c.entry_id = cur.id and c.withdrawn_at is null;
  if was_facts = new_facts then
    return query select cur.id, cur.revision, open_clearance is not null, false;
    return;
  end if;

  if open_clearance is not null then
    update public.transfer_clearances c
    set withdrawn_at = pg_catalog.now(), withdrawn_by = actor, withdraw_reason = 'facts_changed'
    where c.org_id = org and c.id = open_clearance;
  end if;
  update public.transfer_register t
  set services = proposed.services, data_types = proposed.data_types, processing_countries = proposed.processing_countries,
      storage_countries = proposed.storage_countries, countries_confirmed = proposed.countries_confirmed,
      safeguard = proposed.safeguard, safeguard_reference = proposed.safeguard_reference,
      certificate_verified_on = proposed.certificate_verified_on, dpa_terms_confirmed = proposed.dpa_terms_confirmed,
      training = proposed.training, zero_retention = proposed.zero_retention,
      provider_retention = proposed.provider_retention, retention_confirmed = proposed.retention_confirmed,
      onward_recipients = proposed.onward_recipients, review_on = proposed.review_on, revision = t.revision + 1,
      updated_at = pg_catalog.now(), updated_by = actor
  where t.org_id = org and t.id = cur.id;
  if keep_cleared and open_clearance is not null then
    insert into public.transfer_clearances (org_id, entry_id, cleared_by, cleared_via) values (org, cur.id, actor, 'app');
    kept := true;
  end if;
  select coalesce(pg_catalog.jsonb_object_agg(w.key, pg_catalog.jsonb_build_object('from', w.value, 'to', n.value)), '{}')
  into diff
  from pg_catalog.jsonb_each(was_facts) w join pg_catalog.jsonb_each(new_facts) n on n.key = w.key
  where w.value is distinct from n.value;
  insert into public.audit_events (org_id, actor_id, action, target_type, target_id, request_id, device_id, ip, details)
  values (org, actor, 'register.transfer_recorded', 'transfer_entry', provider_key, request_id, device_id, ip,
          pg_catalog.jsonb_build_object('revision', cur.revision + 1, 'was_revision', cur.revision, 'changed', diff,
                                        'ended_clearance', open_clearance is not null, 'kept_cleared', kept));
  return query select cur.id, cur.revision + 1, kept, true;
end
$$;
revoke execute on function public.record_transfer_entry(text, bigint, text, text, text[], text[], text, text, text, date, boolean,
  text, text, text, text, text, date, boolean, text, uuid, inet) from public;

-- Clears a provider for use (PDPA-10, D46; C0.9 PD-12, PD-21), on the revision the DPO saw (seen;
-- HF005 when stale): a clearance in the DPO's name, which transfer_clearances_check() refuses
-- (HF006) until every fact is recorded. The entry is locked FOR NO KEY UPDATE first, so a change of
-- its facts can't pass it. An entry already cleared is returned as it is, with nothing written.
create function public.clear_transfer_entry(
  provider_key text,
  seen bigint,
  request_id text,
  device_id uuid,
  ip inet
) returns table (entry uuid, revision bigint, cleared boolean, changed boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  cur public.transfer_register%rowtype;
  clearance uuid := pg_catalog.gen_random_uuid();
begin
  perform public.registers_check_dpo(org, actor);
  select * into cur from public.transfer_register t where t.org_id = org and t.provider = provider_key for no key update;
  if not found then
    raise exception 'There is no transfer-register entry for %.', provider_key using errcode = 'invalid_parameter_value';
  end if;
  if cur.ai then
    raise exception 'Providers for later stages can''t be recorded or cleared until their stage begins.' using errcode = 'HF006';
  end if;
  if seen is distinct from cur.revision then
    raise exception 'This entry changed since you opened it. Reload it and try again.' using errcode = 'HF005';
  end if;
  if exists (select 1 from public.transfer_clearances c where c.org_id = org and c.entry_id = cur.id and c.withdrawn_at is null) then
    return query select cur.id, cur.revision, true, false;
    return;
  end if;
  insert into public.transfer_clearances (id, org_id, entry_id, cleared_by, cleared_via)
  values (clearance, org, cur.id, actor, 'app');
  insert into public.audit_events (org_id, actor_id, action, target_type, target_id, request_id, device_id, ip, details)
  values (org, actor, 'register.transfer_cleared', 'transfer_entry', provider_key, request_id, device_id, ip,
          pg_catalog.jsonb_build_object('revision', cur.revision, 'clearance', clearance));
  return query select cur.id, cur.revision, true, true;
end
$$;
revoke execute on function public.clear_transfer_entry(text, bigint, text, uuid, inet) from public;

-- Withdraws a provider's clearance (PDPA-10; C0.9 PD-20, PD-21): the open one ends now, by the DPO's
-- decision. It takes no seen: a withdrawal is never refused as stale. The entry is locked first, as
-- the other writers lock it; ending the clearance then waits for a send's transfer_cleared() that
-- holds it FOR SHARE, and a send that starts later waits for this and reads "not cleared". With
-- none open it returns the entry as it is and writes nothing.
create function public.withdraw_transfer_clearance(
  provider_key text,
  request_id text,
  device_id uuid,
  ip inet
) returns table (entry uuid, revision bigint, cleared boolean, changed boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  cur public.transfer_register%rowtype;
  ended uuid;
begin
  perform public.registers_check_dpo(org, actor);
  select * into cur from public.transfer_register t where t.org_id = org and t.provider = provider_key for no key update;
  if not found then
    raise exception 'There is no transfer-register entry for %.', provider_key using errcode = 'invalid_parameter_value';
  end if;
  if cur.ai then
    raise exception 'Providers for later stages can''t be recorded or cleared until their stage begins.' using errcode = 'HF006';
  end if;
  update public.transfer_clearances c
  set withdrawn_at = pg_catalog.now(), withdrawn_by = actor, withdraw_reason = 'dpo_decision'
  where c.org_id = org and c.entry_id = cur.id and c.withdrawn_at is null
  returning c.id into ended;
  if ended is null then
    return query select cur.id, cur.revision, false, false;
    return;
  end if;
  insert into public.audit_events (org_id, actor_id, action, target_type, target_id, request_id, device_id, ip, details)
  values (org, actor, 'register.transfer_withdrawn', 'transfer_entry', provider_key, request_id, device_id, ip,
          pg_catalog.jsonb_build_object('revision', cur.revision, 'clearance', ended));
  return query select cur.id, cur.revision, false, true;
end
$$;
revoke execute on function public.withdraw_transfer_clearance(text, text, uuid, inet) from public;

-- Whether the org the server set may send this provider personal data now (PDPA-10, D46; C0.9
-- PD-15): whether its entry has an open clearance. An outbound client asks it in the transaction
-- that decides each send (sign-in's code, a re-authentication's code), and calls the provider only
-- after that transaction commits. The open clearance is read FOR SHARE, so a withdrawal in progress
-- makes this wait and then read "not cleared", and one that starts later waits for this
-- transaction; but a withdrawal that commits after it, before the provider is called, can't stop
-- that one send (T22 item 8). When "Save and keep cleared" ends the clearance this waited for and
-- grants the next in the same commit, the first read finds neither, so it reads again, also FOR
-- SHARE. It takes no acting user and skips can(): it answers yes or no about the org's own register
-- and writes nothing. A read-only transaction can't run it (no row locks there).
create function public.transfer_cleared(provider_key text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
begin
  if org is null then
    raise exception 'No org is set for this transaction' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.transfer_clearances c
  where c.org_id = org and c.provider = provider_key and c.withdrawn_at is null
  for share;
  if found then
    return true;
  end if;
  perform 1 from public.transfer_clearances c
  where c.org_id = org and c.provider = provider_key and c.withdrawn_at is null
  for share;
  return found;
end
$$;
revoke execute on function public.transfer_cleared(text) from public;

-- The first-Owner bootstrap's clearance of Twilio and AWS (C0.9 OD-01, PD-23): the facts and a
-- reason given when it runs, the DPO who decided (D35: the first Owner is also the first DPO), and
-- Hearth writing. SECURITY INVOKER and granted to nobody, so only the owner (and a superuser) can
-- run it: the reviewed bootstrap script, in its own transaction, acting as the org's Hearth
-- principal (app.org_id and app.user_id set as withOrg sets them). It records the facts (Hearth as
-- updated_by) and a clearance in the DPO's name, cleared_via 'bootstrap', which
-- transfer_clearances_check() checks like any other; writes one audit row with Hearth as the
-- actor, the reason, and in details that the bootstrap did it and which DPO decided (never via or
-- on_behalf_of_id, which 0004 keeps for A4 and A5); and appends register.transfer_changed. It clears
-- only a provider never cleared in the org: a clearance after a withdrawal is the DPO's, in the app.
-- Returns the clearance's id. The messages can be shown as they are.
create function public.bootstrap_transfer_clearance(
  provider_key text,
  dpo uuid,
  services text,
  data_types text,
  processing_countries text[],
  storage_countries text[],
  countries_confirmed text,
  safeguard text,
  safeguard_reference text,
  certificate_verified_on date,
  dpa_terms_confirmed boolean,
  training text,
  zero_retention text,
  provider_retention text,
  retention_confirmed text,
  onward_recipients text,
  review_on date,
  reason text
) returns uuid
language plpgsql volatile set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  hearth uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  cur public.transfer_register%rowtype;
  proposed public.transfer_register%rowtype;
  at_revision bigint;
  clearance uuid := pg_catalog.gen_random_uuid();
begin
  if org is null or hearth is null or not exists (
       select 1 from public.principals p
       where p.org_id = org and p.id = hearth and p.kind = 'system' and p.system_key = 'hearth') then
    raise exception 'Run this in the bootstrap''s transaction, acting as the organisation''s Hearth principal.'
      using errcode = 'insufficient_privilege';
  end if;
  if provider_key is null or provider_key not in ('twilio', 'aws') then
    raise exception 'The set-up clears only Twilio Verify and AWS. The DPO clears the rest in Hearth.' using errcode = 'HF006';
  end if;
  if reason is null or pg_catalog.length(reason) not between 1 and 2000 then
    raise exception 'Give the set-up''s reason, from 1 to 2,000 characters.' using errcode = 'invalid_parameter_value';
  end if;
  -- The DPO named, read FOR SHARE in the lock order, so a deactivation or revocation in progress
  -- makes this wait and then refuse.
  perform 1 from public.people p where p.org_id = org and p.id = dpo and p.deactivated_at is null for share;
  if not found then
    raise exception 'The person named as the DPO must be at the organisation and hold the DPO role.'
      using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.role_assignments r
  where r.org_id = org and r.person_id = dpo and r.revoked_at is null and r.role = 'dpo'
  for share;
  if not found then
    raise exception 'The person named as the DPO must be at the organisation and hold the DPO role.'
      using errcode = 'insufficient_privilege';
  end if;
  select * into cur from public.transfer_register t where t.org_id = org and t.provider = provider_key for no key update;
  if not found then
    raise exception 'There is no transfer-register entry for %.', provider_key using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from public.transfer_clearances c where c.org_id = org and c.provider = provider_key) then
    raise exception 'That provider has been cleared in this organisation before. The DPO clears it again in Hearth.'
      using errcode = 'HF006';
  end if;
  proposed := cur;
  proposed.services := bootstrap_transfer_clearance.services;
  proposed.data_types := bootstrap_transfer_clearance.data_types;
  proposed.processing_countries := public.transfer_countries(bootstrap_transfer_clearance.processing_countries);
  proposed.storage_countries := public.transfer_countries(bootstrap_transfer_clearance.storage_countries);
  proposed.countries_confirmed := bootstrap_transfer_clearance.countries_confirmed;
  proposed.safeguard := bootstrap_transfer_clearance.safeguard;
  proposed.safeguard_reference := bootstrap_transfer_clearance.safeguard_reference;
  proposed.certificate_verified_on := bootstrap_transfer_clearance.certificate_verified_on;
  proposed.dpa_terms_confirmed := coalesce(bootstrap_transfer_clearance.dpa_terms_confirmed, false);
  proposed.training := bootstrap_transfer_clearance.training;
  proposed.zero_retention := bootstrap_transfer_clearance.zero_retention;
  proposed.provider_retention := bootstrap_transfer_clearance.provider_retention;
  proposed.retention_confirmed := bootstrap_transfer_clearance.retention_confirmed;
  proposed.onward_recipients := bootstrap_transfer_clearance.onward_recipients;
  proposed.review_on := bootstrap_transfer_clearance.review_on;
  at_revision := cur.revision;
  if public.transfer_register_facts(proposed) is distinct from public.transfer_register_facts(cur) then
    update public.transfer_register t
    set services = proposed.services, data_types = proposed.data_types, processing_countries = proposed.processing_countries,
        storage_countries = proposed.storage_countries, countries_confirmed = proposed.countries_confirmed,
        safeguard = proposed.safeguard, safeguard_reference = proposed.safeguard_reference,
        certificate_verified_on = proposed.certificate_verified_on, dpa_terms_confirmed = proposed.dpa_terms_confirmed,
        training = proposed.training, zero_retention = proposed.zero_retention,
        provider_retention = proposed.provider_retention, retention_confirmed = proposed.retention_confirmed,
        onward_recipients = proposed.onward_recipients, review_on = proposed.review_on, revision = t.revision + 1,
        updated_at = pg_catalog.now(), updated_by = hearth
    where t.org_id = org and t.id = cur.id;
    at_revision := cur.revision + 1;
  end if;
  insert into public.transfer_clearances (id, org_id, entry_id, cleared_by, cleared_via)
  values (clearance, org, cur.id, dpo, 'bootstrap');
  insert into public.audit_events (org_id, actor_id, action, target_type, target_id, reason, details)
  values (org, hearth, 'register.transfer_cleared', 'transfer_entry', provider_key, reason,
          pg_catalog.jsonb_build_object('by', 'bootstrap', 'decided_by', dpo, 'revision', at_revision,
                                        'clearance', clearance));
  insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose, ids)
  values (org, 'register.transfer_changed', 'transfer_entry', cur.id, hearth, 'system', 'service_operation',
          pg_catalog.jsonb_build_object('provider', provider_key, 'cleared', true));
  return clearance;
end
$$;
revoke execute on function public.bootstrap_transfer_clearance(text, uuid, text, text, text[], text[], text, text, text, date,
  boolean, text, text, text, text, text, date, text) from public;

-- What each role may do (CLAUDE.md, Database: only the grants each needs; never ALL, TRUNCATE,
-- TRIGGER or REFERENCES). No role may insert, update or delete a register row itself: the functions
-- above are the only writers.
--
-- hearth_app (the api): reads both registers and the clearances, for the DPO's pages (can()
-- decides who may: register.read), changes them through the four functions, and asks
-- transfer_cleared() in the transaction that decides each send. Nothing on processing_restrictions:
-- who withdrew is sensitive, and nothing in the api needs it before C2.11.
grant select on public.processing_register, public.transfer_register, public.transfer_clearances to hearth_app;
grant execute on function
    public.set_register_purpose(text, integer, text, text, text, integer, text, text[], text, uuid, inet),
    public.record_transfer_entry(text, bigint, text, text, text[], text[], text, text, text, date, boolean, text, text, text,
                                 text, text, date, boolean, text, uuid, inet),
    public.clear_transfer_entry(text, bigint, text, uuid, inet),
    public.withdraw_transfer_clearance(text, text, uuid, inet),
    public.transfer_cleared(text)
  to hearth_app;

-- hearth_queue: the worker's copy of the registers, read in the same transaction as its flags (T22
-- item 9): each purpose's versions, status, basis and providers; each provider's review date and
-- revision (so a change of facts shows); which clearances are open; and live restrictions, by id,
-- person, purpose and time only. A later step that sends a provider personal data from the worker
-- (C0.14) grants its own role transfer_cleared().
grant select (org_id, purpose, version, status, basis, providers) on public.processing_register to hearth_queue;
grant select (org_id, provider, review_on, revision) on public.transfer_register to hearth_queue;
grant select (org_id, id, provider, withdrawn_at) on public.transfer_clearances to hearth_queue;
grant select (org_id, id, person_id, purpose, effective_at, lifted_at) on public.processing_restrictions to hearth_queue;

-- The two register events join the outbox's types (packages/shared EVENTS lists the same, and CI
-- compares the two lists). The new list holds every type the old one did, so every row already
-- there passes, and the check is validated in place, in this statement. Replacing a check takes an
-- ACCESS EXCLUSIVE lock on the outbox, which every api write and every consumer round touches, so
-- it is this migration's last statement and holds that lock only until the commit.
alter table public.outbox_events
  drop constraint outbox_events_type,
  add constraint outbox_events_type check (type in (
    -- Emitted from C0.6.
    'signin.started', 'signin.ended', 'account.pin_set', 'account.pin_reset', 'account.passkey_added',
    'account.passkey_removed', 'person.deactivated', 'acl.changed', 'flag.changed',
    -- Emitted from C0.9: a change to the processing or the transfer register.
    'register.purpose_changed', 'register.transfer_changed',
    -- Reserved: named now, emitted by the step after each.
    'person.added', 'person.updated', 'person.phone_changed', 'department.changed', 'team.changed',
    'team.membership_changed', 'role.changed',                                     -- C0.16
    'profile.updated',                                                             -- C0.15
    'notice.published', 'notice.acknowledged',                                     -- C0.9
    'message.created', 'message.updated', 'message.deleted',                       -- C1.1
    'voice_message.created',                                                       -- C1.6
    'task.created', 'task.updated', 'task.deleted', 'task.overdue',                -- C2.1
    'session.started', 'session.ended',                                            -- C2.4 (room sessions)
    'track_segment.written',                                                       -- C2.6
    'redaction.applied',                                                           -- C2.11
    'suggested_task.created'                                                       -- C3.5
  ));
