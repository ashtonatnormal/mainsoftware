-- C0.9 PR 2 (C0.9 OD-02): the privacy notice, generated from the registers and published by the
-- DPO, and its acknowledgements (PDPA-02, PDPA-03, ACC-12; BUILD-PLAN C0.9; C0.9 OD-01, OD-04, A-01,
-- A-12; TECH-SPEC T22 items 21 to 37).
--
-- At run time a notice version (0003) is now written only through publish_notice(), which the DPO
-- alone may call, from the generator's text (generateNotice() in packages/shared, run by the api). It
-- stores the exact words people acknowledge as plain text, the generator that wrote them, and links
-- to the exact register versions and clearances it was made from (store the context), which
-- publish_notice() derives itself from the rows it locks, never from what the caller sends (C0.9
-- PD-33, PD-34, PD-37). A version never changes, for any writer. A version Hearth didn't generate
-- (a stand-in: the seed's v0, the DB fixtures', the integration harness's) can only come before the
-- first generated one. Production never gets one.
--
-- Acknowledging goes only through acknowledge_notice(), for the latest version, on the session's own
-- device (C0.9 PD-42), so hearth_app loses its INSERT on both notice tables. Who has acknowledged
-- the latest version then decides who may use Hearth (the api's gate, PD-43 to PD-45), which a
-- digest of the schema can't see, so 0010 has its own upgrade check (scripts/check-notice-upgrade.sh,
-- PD-54).
--
-- A provider receives people's data only while the published notice states it (A-01, PD-41, PD-59):
-- transfer_send_state() answers not_cleared, no_notice (cleared, and no version at all), cleared
-- (and the latest version is a stand-in, or states the open clearance's seven notice facts) or
-- unstated (the latest generated version doesn't), in the transaction that decides each send; the
-- api's sign-in sends a code on no_notice or unstated only to the DPO. transfer_cleared() keeps its
-- signature and grants, and answers true for cleared and no_notice, PR 1's meaning before the first
-- version. The worker reads only whether each open clearance is stated (notice_provider_states()),
-- never the facts (B-06).
--
-- No existing row changes. This adds one nullable column, two tables, two trigger functions and six
-- functions (notice_facts, notice_check_dpo, publish_notice, acknowledge_notice,
-- transfer_send_state, notice_provider_states); replaces transfer_cleared() with the same signature;
-- and revokes hearth_app's two INSERT grants on the notice tables (0003). The outbox's type check
-- already names notice.published and notice.acknowledged (0009), which the api appends, so 0010
-- leaves the outbox alone and takes no lock on it.
--
-- The DPO's free text (a basis reference, a retention, a provider's facts) is held to Hearth's list
-- of AI wording (AI_COPY, packages/shared) when publishing, by the publish route, which regenerates
-- and checks the draft before it calls publish_notice() and is its only caller (B-14, C0.9 PD-62;
-- scripts/guards/api-test-overrides.test.ts keeps it so). That list is code that changes with the
-- copy, which a migration can't follow, so SQL doesn't repeat it.
--
-- The lock order (CLAUDE.md, Database; T22 item 13): ... role_assignments → processing_register →
-- processing_restrictions → transfer_register → transfer_clearances → orgs (publishing only) →
-- notice_versions → notice_acknowledgments → feature_flags ... Publishing reads the DPO's rows FOR
-- SHARE, locks every non-AI purpose's latest version and every non-AI transfer entry FOR SHARE, then
-- the org's own row and the latest version FOR NO KEY UPDATE (B-02). Acknowledging reads the person
-- and the device FOR SHARE, then locks the latest version FOR SHARE. A send reads the clearance FOR
-- SHARE and the notice with no lock.

-- PD-33: the code that wrote a version, as generateNotice() names itself (NOTICE_GENERATOR); empty
-- on a stand-in. Every version already here is one, and passes.
alter table public.notice_versions
  add column generator text constraint notice_versions_generator check (generator ~ '^[a-z0-9][a-z0-9.-]{0,31}$');

-- PD-34, B-05: what each version lists, by the exact source rows: each active or retired non-AI
-- purpose at the register version it was published from (its status there is that row's), and each
-- open non-AI clearance, whose provider and facts are the clearance's own snapshot, which never
-- changes. Only publish_notice() writes them, from the rows it locked.
create table public.notice_version_purposes (
  org_id uuid not null references public.orgs (id),
  notice_version_id uuid not null,
  purpose text not null,
  register_version integer not null,
  primary key (org_id, notice_version_id, purpose),
  foreign key (org_id, notice_version_id) references public.notice_versions (org_id, id),
  foreign key (org_id, purpose, register_version) references public.processing_register (org_id, purpose, version)
);
create table public.notice_version_providers (
  org_id uuid not null references public.orgs (id),
  notice_version_id uuid not null,
  clearance_id uuid not null,
  primary key (org_id, notice_version_id, clearance_id),
  foreign key (org_id, notice_version_id) references public.notice_versions (org_id, id),
  foreign key (org_id, clearance_id) references public.transfer_clearances (org_id, id)
);

-- Row level security: each table only within the org the server set (CLAUDE.md, Database).
do $$
declare
  t text;
begin
  foreach t in array array['notice_version_purposes', 'notice_version_providers'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy org_isolation on public.%I
      using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  end loop;
end
$$;

-- PD-33: a published version is the record of what people were told, so neither it nor what it
-- lists ever changes, whoever writes (the owner and a superuser too). A change of purposes publishes
-- a new version. The message can be shown as it is.
create function public.notice_unchanged() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'A published notice never changes. Publish a new version instead.' using errcode = 'check_violation';
end
$$;
revoke execute on function public.notice_unchanged() from public;
create trigger notice_versions_unchanged before update on public.notice_versions
  for each row execute function public.notice_unchanged();
create trigger notice_version_purposes_unchanged before update on public.notice_version_purposes
  for each row execute function public.notice_unchanged();
create trigger notice_version_providers_unchanged before update on public.notice_version_providers
  for each row execute function public.notice_unchanged();

-- PD-33, PD-41: a stand-in never follows a generated version, so the provider rule's exemption for
-- a stand-in (transfer_send_state) holds only before the first one. Stand-ins are written only by
-- the seed, the DB fixtures and the harness, as the owner or a superuser, never beside a publish.
-- notice_versions_check() (0003) still numbers versions. The message can be shown as it is.
create function public.notice_versions_generated() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.generator is null and exists (
       select 1 from public.notice_versions v where v.org_id = new.org_id and v.generator is not null) then
    raise exception 'A notice Hearth didn''t generate can''t follow one it did.' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function public.notice_versions_generated() from public;
create trigger notice_versions_generated before insert on public.notice_versions
  for each row execute function public.notice_versions_generated();

-- PD-41: the facts of a clearance's snapshot (transfer_register_facts(), 0009) that the notice
-- states: what the provider does and receives, where it processes and stores the data, whether it
-- trains on it, how long it keeps it and whom it passes it to. A change to any of them stops sends
-- until a new version states it; a change to a review date, a safeguard or a written confirmation
-- doesn't. NOTICE_TRANSFER_FACTS in packages/shared lists the same keys, which CI compares (check 6).
-- Granted to nobody (C-03): only the definer functions below, which the owner owns, call it.
create function public.notice_facts(f jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'services', f -> 'services',
    'data_types', f -> 'data_types',
    'processing_countries', f -> 'processing_countries',
    'storage_countries', f -> 'storage_countries',
    'training', f -> 'training',
    'provider_retention', f -> 'provider_retention',
    'onward_recipients', f -> 'onward_recipients')
$$;
revoke execute on function public.notice_facts(jsonb) from public;

-- publish_notice() acts for the person the server set as app.user_id (packages/access decided
-- first: notice.publish), who must still be at the org and hold the DPO role (PDPA-02, PDPA-13).
-- This re-checks both in tables, in the lock order (people, then role_assignments), FOR SHARE, as
-- registers_check_dpo() (0009) does for the registers, so a deactivation or revocation in progress
-- makes the publish wait and then refuse. Its own message, since that one's speaks of the
-- registers. It is no grant's: only publish_notice() calls it.
create function public.notice_check_dpo(org uuid, actor uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if org is null or actor is null then
    raise exception 'No org or user is set for this transaction' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.people p where p.org_id = org and p.id = actor and p.deactivated_at is null for share;
  if not found then
    raise exception 'Only the Data Protection Officer can publish the notice.' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.role_assignments r
  where r.org_id = org and r.person_id = actor and r.revoked_at is null and r.role = 'dpo'
  for share;
  if not found then
    raise exception 'Only the Data Protection Officer can publish the notice.' using errcode = 'insufficient_privilege';
  end if;
end
$$;
revoke execute on function public.notice_check_dpo(uuid, uuid) from public;

-- Publishes the next notice version (PDPA-02, PDPA-03; C0.9 PD-33 to PD-38, B-02, B-05), from the
-- draft the DPO saw: the version they saw as the latest (seen, empty when none), the generator's body
-- and id, and the sources the draft was made from (each listed purpose's key and register version,
-- and each open clearance's id). In order:
--   1. the DPO, re-checked (notice_check_dpo);
--   2. every non-AI purpose's latest version, locked FOR SHARE in key order, again until the row
--      held is still the latest (as processing_restrictions_check() does), so a purpose change
--      (which locks that version FOR NO KEY UPDATE to add the next) waits for the publish, or the
--      publish for it;
--   3. every non-AI transfer entry, FOR SHARE in provider order: every clearance writer locks its
--      entry FOR NO KEY UPDATE first (0009), so no clearance starts or ends while this runs;
--   4. the org's own row, then the latest version, FOR NO KEY UPDATE (B-02): two publishes, the
--      first two included, take turns, and the second then finds the first's version and is
--      refused (HF007), as is a seen that isn't the latest;
--   5. the sources, from the locked rows: S, every active or retired non-AI purpose at its latest
--      version, and P, every open non-AI clearance. Unless the caller's sources equal them, the
--      registers moved since the draft (HF007);
--   6. the rules (HF008), each with a message the page can show, in this order: an active purpose
--      with no basis or retention; an active purpose on a consent-type basis (consent until C1.3's
--      consent items, deemed consent by conduct until PR 3 publishes how to withdraw, s15A until
--      per-person opt-out windows are tracked: PD-38); an active purpose listing a provider with no
--      open clearance; a body that is blank or over 100,000 characters, or a generator id that isn't
--      one; and a draft identical to the latest version (the same generator, body and sources). A
--      retired purpose is listed, but no rule applies to it: 0009 already requires its basis and
--      retention, and it no longer runs (B-05);
--   7. the version, numbered after the latest (0 for the first), and its links from S and P;
--   8. one audit row (ADM-06): ids and numbers only.
-- The api appends notice.published in the same transaction. Returns the version's id and number.
create function public.publish_notice(
  seen integer,
  body text,
  generator text,
  purpose_keys text[],
  purpose_versions integer[],
  clearance_ids uuid[],
  request_id text,
  device_id uuid,
  ip inet
) returns table (notice uuid, version integer)
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  consent_types constant text[] := array['consent', 'deemed_consent_conduct', 'deemed_consent_notification'];
  -- Empty, or only JavaScript's whitespace (String.prototype.trim()'s set), as 0009 reads text.
  blank constant text := '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$';
  k text;
  cur public.processing_register%rowtype;
  locked public.processing_register[] := '{}';
  latest public.notice_versions%rowtype;
  sources text[];
  open_ids uuid[];
  listed_provider text;
  new_id uuid := pg_catalog.gen_random_uuid();
  new_version integer;
begin
  perform public.notice_check_dpo(org, actor);

  for k in
    select distinct r.purpose from public.processing_register r where r.org_id = org and not r.ai order by r.purpose
  loop
    loop
      select * into cur from public.processing_register r
      where r.org_id = org and r.purpose = k
      order by r.version desc
      limit 1
      for share;
      exit when not exists (
        select 1 from public.processing_register r
        where r.org_id = org and r.purpose = k and r.version > cur.version);
    end loop;
    locked := locked || cur;
  end loop;

  perform 1 from public.transfer_register t where t.org_id = org and not t.ai order by t.provider for share;

  perform 1 from public.orgs o where o.id = org for no key update;
  select * into latest from public.notice_versions v
  where v.org_id = org
  order by v.version desc
  limit 1
  for no key update;
  if seen is distinct from latest.version or exists (
       select 1 from public.notice_versions v where v.org_id = org and v.version > latest.version) then
    raise exception 'A newer version was published since you looked. Check the preview again.' using errcode = 'HF007';
  end if;

  -- Both lists sorted by the same text, so they're equal exactly when they hold the same entries.
  sources := array(select pg_catalog.format('%s:%s', p.purpose, p.version) from pg_catalog.unnest(locked) p
                   where p.status in ('active', 'retired') order by 1);
  open_ids := array(select c.id from public.transfer_clearances c
                    join public.transfer_register t on t.org_id = c.org_id and t.id = c.entry_id
                    where c.org_id = org and c.withdrawn_at is null and not t.ai order by 1);
  if sources is distinct from array(
       select pg_catalog.format('%s:%s', x.purpose, x.version)
       from rows from (pg_catalog.unnest(coalesce(purpose_keys, '{}')), pg_catalog.unnest(coalesce(purpose_versions, '{}')))
         as x (purpose, version)
       order by 1)
     or open_ids is distinct from array(select x from pg_catalog.unnest(coalesce(clearance_ids, '{}')) x order by 1) then
    raise exception 'The registers changed since this notice was prepared. Check the preview again, then publish.'
      using errcode = 'HF007';
  end if;

  select p.purpose into k from pg_catalog.unnest(locked) p
  where p.status = 'active' and (p.basis is null or p.retention is null)
  order by p.purpose
  limit 1;
  if found then
    raise exception 'Record %''s legal basis and how long its data is kept before publishing.', k using errcode = 'HF008';
  end if;
  select p.purpose into k from pg_catalog.unnest(locked) p
  where p.status = 'active' and p.basis = any (consent_types)
  order by p.purpose
  limit 1;
  if found then
    raise exception 'A purpose resting on consent or deemed consent can''t be in the notice yet.' using errcode = 'HF008';
  end if;
  select p.purpose, x.provider into k, listed_provider
  from pg_catalog.unnest(locked) p cross join lateral pg_catalog.unnest(p.providers) as x (provider)
  where p.status = 'active'
    and not exists (select 1 from public.transfer_clearances c where c.id = any (open_ids) and c.provider = x.provider)
  order by p.purpose, x.provider
  limit 1;
  if found then
    raise exception '% lists %, which isn''t cleared.', k, listed_provider using errcode = 'HF008';
  end if;
  if publish_notice.body is null or publish_notice.body ~ blank or pg_catalog.length(publish_notice.body) > 100000 then
    raise exception 'A notice needs its text, of at most 100,000 characters.' using errcode = 'HF008';
  end if;
  if publish_notice.generator is null or publish_notice.generator !~ '^[a-z0-9][a-z0-9.-]{0,31}$' then
    raise exception 'A notice names the generator that wrote it.' using errcode = 'HF008';
  end if;
  if latest.generator is not distinct from publish_notice.generator and latest.body = publish_notice.body
     and sources = array(select pg_catalog.format('%s:%s', l.purpose, l.register_version)
                         from public.notice_version_purposes l
                         where l.org_id = org and l.notice_version_id = latest.id order by 1)
     and open_ids = array(select l.clearance_id from public.notice_version_providers l
                          where l.org_id = org and l.notice_version_id = latest.id order by 1) then
    raise exception 'The published notice already says this.' using errcode = 'HF008';
  end if;

  new_version := coalesce(latest.version + 1, 0);
  insert into public.notice_versions (id, org_id, version, body, generator, published_by)
  values (new_id, org, new_version, publish_notice.body, publish_notice.generator, actor);
  insert into public.notice_version_purposes (org_id, notice_version_id, purpose, register_version)
  select org, new_id, p.purpose, p.version from pg_catalog.unnest(locked) p where p.status in ('active', 'retired');
  insert into public.notice_version_providers (org_id, notice_version_id, clearance_id)
  select org, new_id, x from pg_catalog.unnest(open_ids) x;
  insert into public.audit_events (org_id, actor_id, action, target_type, target_id, request_id, device_id, ip, details)
  values (org, actor, 'notice.publish', 'notice_version', new_id::text, request_id, device_id, ip,
          pg_catalog.jsonb_build_object(
            'version', new_version, 'was_version', latest.version, 'generator', publish_notice.generator,
            'purposes', (select coalesce(pg_catalog.jsonb_object_agg(p.purpose, p.version), '{}')
                         from pg_catalog.unnest(locked) p where p.status in ('active', 'retired')),
            'clearances', (select coalesce(pg_catalog.jsonb_object_agg(c.provider, c.id), '{}')
                           from public.transfer_clearances c where c.org_id = org and c.id = any (open_ids))));
  return query select new_id, new_version;
end
$$;
revoke execute on function public.publish_notice(integer, text, text, text[], integer[], uuid[], text, uuid, inet) from public;

-- Records that the person the server set as app.user_id acknowledged a notice version in the app
-- (ACC-12, PDPA-03; C0.9 PD-42): the version shown (notice_id), on the session's own device, which
-- the server passes and the request never names. The person is read FOR SHARE and must still be at
-- the org, and the device FOR SHARE and must be theirs and not signed out (42501, which the api
-- answers as signed_out), so a deactivation or sign-out in progress makes this wait and then refuse.
-- An id that isn't one of the org's versions is 22023. The latest version is locked FOR SHARE, again
-- until the row held is still the latest, so a publish in progress makes this wait and then find
-- the newer version, and one that starts later waits for this: only the latest version is
-- acknowledged (HF007 otherwise, which the api answers as notice_changed). Once per person and
-- version: a second call (or one the DPO recorded) writes nothing and returns changed false;
-- otherwise one audit row (ADM-06), and the api appends notice.acknowledged. Returns the version's
-- number and whether anything changed. The messages can be shown as they are.
create function public.acknowledge_notice(
  notice_id uuid,
  request_id text,
  device_id uuid,
  ip inet
) returns table (version integer, changed boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  signed_out timestamptz;
  latest public.notice_versions%rowtype;
  ack uuid;
begin
  if org is null or actor is null then
    raise exception 'No org or user is set for this transaction' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.people p where p.org_id = org and p.id = actor and p.deactivated_at is null for share;
  if not found then
    raise exception 'Only someone still at the organisation can acknowledge its notice.' using errcode = 'insufficient_privilege';
  end if;
  select d.signed_out_at into signed_out from public.devices d
  where d.org_id = org and d.user_id = actor and d.id = acknowledge_notice.device_id
  for share;
  if not found or signed_out is not null then
    raise exception 'That device has been signed out.' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.notice_versions v where v.org_id = org and v.id = notice_id;
  if not found then
    raise exception 'There is no such version of the notice.' using errcode = 'invalid_parameter_value';
  end if;
  loop
    select * into latest from public.notice_versions v
    where v.org_id = org
    order by v.version desc
    limit 1
    for share;
    exit when not exists (select 1 from public.notice_versions v where v.org_id = org and v.version > latest.version);
  end loop;
  if latest.id is distinct from notice_id then
    raise exception 'A newer version of the notice was published. Read it, then acknowledge it.' using errcode = 'HF007';
  end if;
  insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, device_id)
  values (org, actor, latest.id, 'in_app', acknowledge_notice.device_id)
  on conflict (org_id, person_id, notice_version_id) do nothing
  returning id into ack;
  if ack is null then
    return query select latest.version, false;
    return;
  end if;
  insert into public.audit_events (org_id, actor_id, action, target_type, target_id, request_id, device_id, ip, details)
  values (org, actor, 'notice.acknowledge', 'person', actor::text, request_id, acknowledge_notice.device_id, ip,
          pg_catalog.jsonb_build_object('notice', latest.id, 'version', latest.version));
  return query select latest.version, true;
end
$$;
revoke execute on function public.acknowledge_notice(uuid, text, uuid, inet) from public;

-- Whether the org the server set may send this provider personal data now, and if not why
-- (PDPA-10, D46; C0.9 PD-15, PD-41, PD-59; B-03, C-01), asked in the transaction that decides each
-- send (sign-in's code, a re-authentication's code), which calls the provider only after it commits:
--   not_cleared  no open clearance;
--   no_notice    an open clearance, and the org has no notice version at all (before v0, OD-01);
--   cleared      an open clearance, and the latest version is a stand-in (generator empty), or
--                links a clearance of this provider whose notice facts (notice_facts) equal the open
--                one's;
--   unstated     an open clearance that the latest generated version doesn't state.
-- The api sends sign-in codes on cleared to everyone and on no_notice or unstated to the DPO alone
-- (codeMaySend). The open clearance is read FOR SHARE twice, as transfer_cleared() read it in 0009:
-- a withdrawal in progress makes this wait and then read not_cleared, and one that starts later
-- waits for this transaction; but a withdrawal that commits after it, before the provider is called,
-- can't stop that one send (T22 item 8). When "Save and keep cleared" ends the clearance this waited
-- for and grants the next in the same commit, the first read finds neither, so it reads again. The
-- notice is read with no lock. A version that commits during a send lists every clearance open when
-- it was made, the one this holds among them (a clearance starts or ends only under its entry's lock,
-- which a publish holds FOR SHARE), so either answer agrees with a version the send could see; a
-- facts change waits for the send (PD-15). It takes no acting user and skips can(): it answers about
-- the org's own registers and writes nothing. A read-only transaction can't run it (no row locks
-- there).
create function public.transfer_send_state(provider_key text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  open_facts jsonb;
  latest_id uuid;
  latest_generator text;
begin
  if org is null then
    raise exception 'No org is set for this transaction' using errcode = 'insufficient_privilege';
  end if;
  select c.facts into open_facts from public.transfer_clearances c
  where c.org_id = org and c.provider = provider_key and c.withdrawn_at is null
  for share;
  if not found then
    select c.facts into open_facts from public.transfer_clearances c
    where c.org_id = org and c.provider = provider_key and c.withdrawn_at is null
    for share;
    if not found then
      return 'not_cleared';
    end if;
  end if;
  select v.id, v.generator into latest_id, latest_generator from public.notice_versions v
  where v.org_id = org
  order by v.version desc
  limit 1;
  if not found then
    return 'no_notice';
  end if;
  if latest_generator is null or exists (
       select 1 from public.notice_version_providers l
       join public.transfer_clearances s on s.org_id = l.org_id and s.id = l.clearance_id
       where l.org_id = org and l.notice_version_id = latest_id and s.provider = provider_key
         and public.notice_facts(s.facts) = public.notice_facts(open_facts)) then
    return 'cleared';
  end if;
  return 'unstated';
end
$$;
revoke execute on function public.transfer_send_state(text) from public;

-- PR 1's transfer gate (0009), kept for every sender but sign-in's code (C0.14's push, C2's LiveKit):
-- cleared, or cleared with no notice version yet (PR 1's meaning before v0). The same signature, so
-- its owner and grants stay; it reads what transfer_send_state() reads, with the same locks.
create or replace function public.transfer_cleared(provider_key text) returns boolean
language sql volatile security definer set search_path = '' as $$
  select public.transfer_send_state(provider_key) in ('cleared', 'no_notice')
$$;

-- For the org the server set (none: no rows), each open non-AI clearance and whether the latest
-- version states it (B-06, C-03): stated is true when that version, whatever wrote it, links a
-- clearance of the provider whose notice facts equal the open one's, as transfer_send_state()
-- judges it, but read with no lock, so a read-only transaction can run it. Whether it matters is
-- the reader's: with no version, or a stand-in as the latest, nothing waits for a notice (the
-- worker's providerCleared() and the DPO's pages read the latest version themselves). The worker's
-- copy of the registers (T22 item 9) and the flags route read it, so neither needs a clearance's
-- facts, which hold the DPO's written confirmations. It writes nothing.
create function public.notice_provider_states() returns table (provider text, clearance uuid, stated boolean)
language sql stable security definer set search_path = '' as $$
  with latest as (
    select v.org_id, v.id from public.notice_versions v
    where v.org_id = nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid
    order by v.version desc
    limit 1
  )
  select c.provider, c.id,
         exists (select 1 from latest
                 join public.notice_version_providers l on l.org_id = latest.org_id and l.notice_version_id = latest.id
                 join public.transfer_clearances s on s.org_id = l.org_id and s.id = l.clearance_id
                 where s.provider = c.provider and public.notice_facts(s.facts) = public.notice_facts(c.facts))
  from public.transfer_clearances c
  join public.transfer_register t on t.org_id = c.org_id and t.id = c.entry_id
  where c.org_id = nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid
    and c.withdrawn_at is null and not t.ai
  order by c.provider
$$;
revoke execute on function public.notice_provider_states() from public;

-- What each role may do (CLAUDE.md, Database: only the grants each needs; never ALL, TRUNCATE,
-- TRIGGER or REFERENCES). No role may insert, update or delete a notice row itself: publish_notice()
-- and acknowledge_notice() are the notice tables' only writers (PD-42).
--
-- hearth_app (the api and the gateway): no longer adds versions or acknowledgements directly
-- (0003's grants), and keeps SELECT on both, which the acknowledgement gate's standing read and the
-- gateway's admission use (PD-43, PD-45); reads the links, for the DPO's Notice tab, what changed
-- since someone last acknowledged, and "notified" in the flags route's copy of the registers;
-- publishes and acknowledges through the two functions; asks transfer_send_state() in the
-- transaction that decides each code send (transfer_cleared() keeps 0009's grant); and reads
-- whether each open clearance is stated.
revoke insert on public.notice_versions from hearth_app;
revoke insert (org_id, person_id, notice_version_id, method, device_id, recorded_by) on public.notice_acknowledgments from hearth_app;
grant select on public.notice_version_purposes, public.notice_version_providers to hearth_app;
grant execute on function
    public.publish_notice(integer, text, text, text[], integer[], uuid[], text, uuid, inet),
    public.acknowledge_notice(uuid, text, uuid, inet),
    public.transfer_send_state(text),
    public.notice_provider_states()
  to hearth_app;

-- hearth_queue: the worker's copy of the registers adds the latest version (its id, number and
-- whether it was generated) and the purposes it lists at which register version, for "notified"
-- (PD-40) and a pinned purpose's staleness (B-04, C-09); and, through notice_provider_states(),
-- whether each open clearance is stated, never a clearance's facts or the version's providers
-- (C-03). Never a version's text or who published it, nor anyone's acknowledgement.
grant select (org_id, id, version, generator) on public.notice_versions to hearth_queue;
grant select (org_id, notice_version_id, purpose, register_version) on public.notice_version_purposes to hearth_queue;
grant execute on function public.notice_provider_states() to hearth_queue;
