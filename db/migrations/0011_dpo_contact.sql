-- C0.9 PR 3a (C0.9 OD-05): the DPO's business contact, which the notice prints; acknowledgements
-- the DPO records; deemed consent by conduct in the notice; and Twilio's break-glass re-clear
-- (PDPA-02, PDPA-03, PDPA-04, PDPA-10, PDPA-13, ACC-12; BUILD-PLAN C0.9; C0.9 OD-10, OD-11, OD-18,
-- OD-19, OD-20; TECH-SPEC T22 items 38 to 49).
--
-- What it adds: dpo_settings, the DPO's settings in versions that never change, with its trigger
-- and its one writer, set_dpo_contact() (OD-10, PD-63, PD-64); record_notice_acknowledgement(), the
-- notice tables' third writer, and the day and the note it keeps on notice_acknowledgments (OD-19,
-- PD-75, PD-76); notice_versions.dpo_settings_version, the contact a version printed (OD-11,
-- PD-66); and cleared_via 'break_glass' on transfer_clearances (OD-20, PD-80).
--
-- What it replaces: publish_notice(), dropped and created with one more argument, the settings
-- version the draft printed: the caller must say which contact the words it sends printed, and an
-- overload would leave a contact-blind publisher callable (PD-66). It now refuses a notice with no
-- contact recorded, and states deemed consent by conduct (OD-18, PD-73). And
-- bootstrap_transfer_clearance(), with the same signature, owner and (empty) grants: without the
-- emergency marker it is 0009's, whole; with it, it re-clears Twilio Verify once an earlier
-- clearance has ended, while no DPO has a live session (PD-77 to PD-79).
--
-- What it leaves alone: the outbox's type check (no new event type, so 0011 takes no lock on the
-- outbox); the purposes and processing_register_defaults(); processing_restrictions;
-- transfer_send_state(), transfer_cleared(), notice_provider_states(), acknowledge_notice(),
-- notice_facts(), registers_check_dpo() and notice_check_dpo(); orgs; the job roles' grants; and the
-- seed. No existing row changes.
--
-- The lock order (CLAUDE.md, Database; T22 items 13 and 45): people → users → passkeys →
-- phone_numbers → devices → sessions, then role_assignments → processing_register →
-- processing_restrictions → transfer_register → transfer_clearances → dpo_settings → orgs
-- (publishing only) → notice_versions → notice_acknowledgments → feature_flags → jobs →
-- schedule_runs. A contact change reads the DPO's rows FOR SHARE, then takes the latest dpo_settings
-- row FOR NO KEY UPDATE. Publishing takes that row FOR SHARE after the transfer entries and before
-- the org's row. A recorded acknowledgement reads the DPO's rows, then the person's (an admin action
-- on someone else), FOR SHARE, then the latest version FOR SHARE. The re-clear takes every current
-- DPO's person row FOR NO KEY UPDATE, then the named DPO's role row FOR SHARE, then the Twilio entry
-- FOR NO KEY UPDATE.
--
-- The locks 0011 takes: the new table's foreign keys take SHARE ROW EXCLUSIVE on orgs and
-- principals, which conflicts only with writes to them (today only the bootstrap makes any). The
-- three tables every request or send reads (transfer_clearances, notice_versions,
-- notice_acknowledgments) are locked last, before their ALTER TABLEs. Requests read them in both
-- orders: a sign-in send holds transfer_clearances and then reads notice_versions, while a gated
-- request reads the notice first (the notice gate) and then may read a clearance (a
-- re-authentication code's send, the registers). No one order of the three avoids a deadlock with
-- both, so the migration never waits while it holds one: it asks for all three without waiting,
-- and when one is busy it lets go of what it took, waits a moment and asks again, for up to about
-- 10 s, then fails with 55P03 and the deploy's migrate step is run again. The ACCESS EXCLUSIVE
-- locks are held only until the commit.
--
-- The DPO's free text (the contact, a recorded acknowledgement's note) is held to Hearth's list of
-- AI wording (AI_COPY, packages/shared), and a purpose on deemed consent by conduct to the purposes
-- whose withdrawal by hand is written down (CONDUCT_WITHDRAWABLE), by each writer's route, its only
-- caller, before it calls the function (PD-62, PD-65, PD-86; scripts/guards/api-test-overrides.test.ts
-- keeps it so). Both are code lists that change with the code, which a migration can't follow, so
-- SQL doesn't repeat them.

-- PDPA-13, PDPA-02 (C0.9 OD-10, PD-63, PD-64): what the DPO sets that the notice prints, in versions
-- that never change. In 0011 it holds their business contact: a role title, never a person's name,
-- and at least one way to reach the DPO outside Hearth, so leavers and people with no account can
-- write (OD-13). PR 3b adds the reply targets as columns; each writer copies the columns it doesn't
-- change, so every version is whole. The current settings are the highest version. A notice
-- version links the one it printed (notice_versions.dpo_settings_version), so a version never
-- changes: Settings reads the printed contact through that link (PD-69). No org has a row until its
-- DPO records one. Never on orgs, whose row only publishing locks. Only set_dpo_contact() writes it.
create table public.dpo_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  version integer not null check (version >= 1),
  contact_title text not null,
  contact_email text,
  contact_phone text,
  contact_postal text,
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null,
  unique (org_id, id),
  -- Named, so set_dpo_contact() can say on conflict on constraint: a plain on conflict (org_id,
  -- version) would be ambiguous with the function's OUT column version.
  constraint dpo_settings_org_version unique (org_id, version),
  -- One line, 1 to 120 characters, trimmed.
  constraint dpo_settings_title check (
    contact_title = btrim(contact_title) and length(contact_title) between 1 and 120 and contact_title !~ '[[:cntrl:]]'),
  -- A shape the notice prints exactly and Settings links as mailto: with nothing a URL reads
  -- specially (no space, quote, ?, &, % or #). packages/shared's CONTACT_EMAIL_PATTERN is the same.
  constraint dpo_settings_email check (length(contact_email) <= 254 and contact_email ~
    '^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$'),
  -- International format, so people abroad can dial it: + and 7 to 15 digits, with single spaces or
  -- hyphens between them (CONTACT_PHONE_PATTERN).
  constraint dpo_settings_phone check (contact_phone ~ '^\+[1-9]([ -]?[0-9]){6,14}$'),
  -- Up to 500 characters on as many lines as it needs: trimmed at both ends, no empty line, and no
  -- control character but the line break (the api also trims each line: SetContactBody).
  constraint dpo_settings_postal check (
    contact_postal = btrim(contact_postal) and length(contact_postal) between 1 and 500
    and translate(contact_postal, E'\n', '') !~ '[[:cntrl:]]' and contact_postal !~ '\n[[:space:]]*\n'),
  -- OD-10: at least one channel outside Hearth.
  constraint dpo_settings_channel check (num_nonnulls(contact_email, contact_phone, contact_postal) >= 1),
  foreign key (org_id, recorded_by) references public.principals (org_id, id)
);

-- Row level security: the table only within the org the server set (CLAUDE.md, Database).
do $$
declare
  t text;
begin
  foreach t in array array['dpo_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy org_isolation on public.%I
      using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  end loop;
end
$$;

-- PD-63: a recorded version is what a notice version printed, so it never changes, whoever writes
-- (the owner and a superuser too); a change records the next version. No role holds DELETE, and a
-- notice version's foreign key keeps a version it links. The message can be shown as it is.
create function public.dpo_settings_unchanged() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Recorded contact details never change. Record a new version instead.' using errcode = 'check_violation';
end
$$;
revoke execute on function public.dpo_settings_unchanged() from public;
create trigger dpo_settings_unchanged before update on public.dpo_settings
  for each row execute function public.dpo_settings_unchanged();

-- Records the DPO's business contact (PDPA-13, PDPA-02; C0.9 OD-10, PD-63) for the org the server
-- set, as the person set as app.user_id (packages/access decided first: notice.contact.set), from
-- the version the page showed (seen; null when none is recorded). In order:
--   1. the DPO, re-checked (registers_check_dpo(): the person, then their dpo role, FOR SHARE; its
--      42501 is the api's 403, so its wording about the registers never reaches a screen);
--   2. the latest version FOR NO KEY UPDATE, so of two changes from one version the second waits,
--      then finds the newer one and is refused (HF005, register_changed). With none recorded there
--      is nothing to lock: of two first records the second waits on the unique (org_id, version)
--      index and is refused the same way, never with 23505, and records version 1 if the first
--      rolled back;
--   3. text trimmed of JavaScript's whitespace at both ends (as the api trims it), empty read as
--      none; the rules (HF006, register_invalid), in contactProblems()'s order. Wording Hearth keeps
--      off its screens (AI_COPY) is the route's to refuse, since that list is code (PD-65);
--   4. the same contact again writes nothing and returns changed false;
--   5. the next version, and one audit row (ADM-06) naming the fields that changed, never their
--      values: the versions are the history.
-- PR 3b's settings columns, once they exist, are copied from the latest version into the next here.
-- No outbox event (PD-72): nothing acts on a contact change, which reaches people only through the
-- next published version. The messages can be shown as they are.
create function public.set_dpo_contact(
  seen integer,
  title text,
  email text,
  phone text,
  postal text,
  request_id text,
  device_id uuid,
  ip inet
) returns table (version integer, changed boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  -- Whitespace at either end, as JavaScript's trim() reads it: 0009's literal, byte for byte, with
  -- \u escapes so a reader sees every code point.
  edges constant text := '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'
                         '|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$';
  email_shape constant text :=
    '^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$';
  phone_shape constant text := '^\+[1-9]([ -]?[0-9]){6,14}$';
  to_title text := nullif(pg_catalog.regexp_replace(set_dpo_contact.title, edges, '', 'g'), '');
  to_email text := nullif(pg_catalog.regexp_replace(set_dpo_contact.email, edges, '', 'g'), '');
  to_phone text := nullif(pg_catalog.regexp_replace(set_dpo_contact.phone, edges, '', 'g'), '');
  to_postal text := nullif(pg_catalog.regexp_replace(set_dpo_contact.postal, edges, '', 'g'), '');
  cur public.dpo_settings%rowtype;
  new_id uuid := pg_catalog.gen_random_uuid();
  inserted uuid;
  fields text[];
begin
  perform public.registers_check_dpo(org, actor);
  select * into cur from public.dpo_settings s
  where s.org_id = org
  order by s.version desc
  limit 1
  for no key update;
  -- The locking read returns the version it waited for, so one added meanwhile shows only here.
  if seen is distinct from cur.version or exists (
       select 1 from public.dpo_settings s
       where s.org_id = org and (cur.version is null or s.version > cur.version)) then
    raise exception 'Your contact details changed since you opened them. Reload them and try again.' using errcode = 'HF005';
  end if;
  if to_title is null then
    raise exception 'Give the role title people write to, such as Data Protection Officer.' using errcode = 'HF006';
  elsif pg_catalog.length(to_title) > 120 or to_title ~ '[[:cntrl:]]' then
    raise exception 'Keep the role title to one line of at most 120 characters.' using errcode = 'HF006';
  elsif to_email is null and to_phone is null and to_postal is null then
    raise exception 'Give at least one way to reach you outside Hearth: an email address, a phone number or a postal address.'
      using errcode = 'HF006';
  elsif to_email is not null and (pg_catalog.length(to_email) > 254 or to_email !~ email_shape) then
    raise exception 'Enter an email address such as name@example.org.' using errcode = 'HF006';
  elsif to_phone is not null and to_phone !~ phone_shape then
    raise exception 'Enter the phone number with + and the country code, such as +65.' using errcode = 'HF006';
  elsif to_postal is not null and (pg_catalog.length(to_postal) > 500
        or pg_catalog.translate(to_postal, E'\n', '') ~ '[[:cntrl:]]' or to_postal ~ '\n[[:space:]]*\n') then
    raise exception 'Keep the postal address to 500 characters of plain text.' using errcode = 'HF006';
  end if;
  fields := pg_catalog.array_remove(array[
    case when cur.contact_title is distinct from to_title then 'title' end,
    case when cur.contact_email is distinct from to_email then 'email' end,
    case when cur.contact_phone is distinct from to_phone then 'phone' end,
    case when cur.contact_postal is distinct from to_postal then 'postal' end], null);
  if cur.id is not null and pg_catalog.cardinality(fields) = 0 then
    return query select cur.version, false;
    return;
  end if;
  insert into public.dpo_settings (id, org_id, version, contact_title, contact_email, contact_phone, contact_postal, recorded_by)
  values (new_id, org, coalesce(cur.version, 0) + 1, to_title, to_email, to_phone, to_postal, actor)
  on conflict on constraint dpo_settings_org_version do nothing
  returning id into inserted;
  if inserted is null then
    raise exception 'Your contact details changed since you opened them. Reload them and try again.' using errcode = 'HF005';
  end if;
  insert into public.audit_events (org_id, actor_id, action, target_type, target_id, request_id, device_id, ip, details)
  values (org, actor, 'notice.contact_set', 'dpo_settings', new_id::text, request_id, set_dpo_contact.device_id, ip,
          pg_catalog.jsonb_build_object('version', coalesce(cur.version, 0) + 1, 'was_version', cur.version,
                                        'changed', fields));
  return query select coalesce(cur.version, 0) + 1, true;
end
$$;
revoke execute on function public.set_dpo_contact(integer, text, text, text, text, text, uuid, inet) from public;

-- Records that someone else acknowledged the latest notice version outside Hearth (PDPA-03, ACC-12;
-- C0.9 OD-19, PD-75, PD-76), for the org the server set, as the DPO set as app.user_id
-- (packages/access decided first: notice.acknowledgement.record, which refuses yourself and anyone
-- who has left). An admin action on someone else, so the DPO's own rows come first and the
-- person's after (CLAUDE.md, the lock order's exception). In order:
--   1. the DPO, re-checked (notice_check_dpo(): the person, then their dpo role, FOR SHARE);
--   2. never yourself (you acknowledge in Hearth; 0003's not_self_recorded check backs it);
--   3. the person, FOR SHARE: not the org's is 22023, and one who has left is refused, so a
--      deactivation in progress makes this wait and then refuse;
--   4. an id that isn't one of the org's versions is 22023; the latest version FOR SHARE, again
--      until the row held is still the latest, so a publish in progress makes this wait and then
--      find the newer version (HF007), and one that starts later waits for this;
--   5. the day, from the day the version was published to today, both in the org's zone (orgs read
--      with no lock), and the note, trimmed of JavaScript's whitespace, one line of 1 to 500
--      characters (HF008);
--   6. once per person and version: if they already acknowledged it, in the app or as recorded,
--      this writes nothing and returns changed false; otherwise the row (recorded_by_dpo, the DPO,
--      the day, the note, no device) and one audit row naming the person, the version and the day,
--      never the note. The api appends notice.acknowledged in the same transaction.
-- Returns the version's number and whether anything changed. The messages can be shown as they are.
create function public.record_notice_acknowledgement(
  person uuid,
  notice_id uuid,
  on_day date,         -- the day they acknowledged it (the column acknowledged_on)
  note text,
  request_id text,
  device_id uuid,
  ip inet
) returns table (version integer, changed boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  -- Whitespace at either end, as JavaScript's trim() reads it: 0009's literal, byte for byte, with
  -- \u escapes so a reader sees every code point.
  edges constant text := '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'
                         '|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$';
  how text := nullif(pg_catalog.regexp_replace(record_notice_acknowledgement.note, edges, '', 'g'), '');
  gone timestamptz;
  latest public.notice_versions%rowtype;
  today date;
  published_on date;
  ack uuid;
begin
  perform public.notice_check_dpo(org, actor);
  if record_notice_acknowledgement.person is null or record_notice_acknowledgement.person = actor then
    raise exception 'You acknowledge the notice yourself, in Hearth.' using errcode = 'insufficient_privilege';
  end if;
  select p.deactivated_at into gone from public.people p
  where p.org_id = org and p.id = record_notice_acknowledgement.person
  for share;
  if not found then
    raise exception 'There is no such person at the organisation.' using errcode = 'invalid_parameter_value';
  end if;
  if gone is not null then
    raise exception 'Only someone still at the organisation can have an acknowledgement recorded.'
      using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.notice_versions v where v.org_id = org and v.id = notice_id;
  if not found then
    raise exception 'There is no such version of the notice.' using errcode = 'invalid_parameter_value';
  end if;
  loop
    select * into latest from public.notice_versions v
    where v.org_id = org order by v.version desc limit 1
    for share;
    exit when not exists (select 1 from public.notice_versions v where v.org_id = org and v.version > latest.version);
  end loop;
  if latest.id is distinct from notice_id then
    raise exception 'A newer version of the notice was published. Record the acknowledgement of that one.'
      using errcode = 'HF007';
  end if;
  select (pg_catalog.now() at time zone o.time_zone)::date, (latest.published_at at time zone o.time_zone)::date
  into today, published_on
  from public.orgs o where o.id = org;
  if on_day is null or on_day > today or on_day < published_on then
    raise exception 'Give the day they acknowledged it, from the day version % was published to today.', latest.version
      using errcode = 'HF008';
  end if;
  if how is null or pg_catalog.length(how) > 500 or how ~ '[[:cntrl:]]' then
    raise exception 'Say how they acknowledged it, on one line of at most 500 characters.' using errcode = 'HF008';
  end if;
  insert into public.notice_acknowledgments
    (org_id, person_id, notice_version_id, method, recorded_by, acknowledged_on, recorded_note)
  values (org, record_notice_acknowledgement.person, latest.id, 'recorded_by_dpo', actor, on_day, how)
  on conflict (org_id, person_id, notice_version_id) do nothing
  returning id into ack;
  if ack is null then
    return query select latest.version, false;
    return;
  end if;
  insert into public.audit_events (org_id, actor_id, action, target_type, target_id, request_id, device_id, ip, details)
  values (org, actor, 'notice.acknowledgement_recorded', 'person', record_notice_acknowledgement.person::text,
          request_id, record_notice_acknowledgement.device_id, ip,
          pg_catalog.jsonb_build_object('notice', latest.id, 'version', latest.version, 'acknowledged_on', on_day));
  return query select latest.version, true;
end
$$;
revoke execute on function public.record_notice_acknowledgement(uuid, uuid, date, text, text, uuid, inet) from public;

-- Publishes the next notice version (PDPA-02, PDPA-03; C0.9 PD-33 to PD-38, PD-66, PD-67, B-02,
-- B-05), from the draft the DPO saw: the version they saw as the latest (seen, empty when none), the
-- generator's body and id, the sources the draft was made from (each listed purpose's key and
-- register version, and each open clearance's id) and the DPO's settings version it printed
-- (contact_version, empty when none is recorded). In order:
--   1. the DPO, re-checked (notice_check_dpo);
--   2. every non-AI purpose's latest version, locked FOR SHARE in key order, again until the row
--      held is still the latest (as processing_restrictions_check() does), so a purpose change
--      (which locks that version FOR NO KEY UPDATE to add the next) waits for the publish, or the
--      publish for it;
--   3. every non-AI transfer entry, FOR SHARE in provider order: every clearance writer locks its
--      entry FOR NO KEY UPDATE first (0009), so no clearance starts or ends while this runs;
--   3a. the latest dpo_settings version FOR SHARE, again until the row held is still the latest: a
--      contact change in progress (which locks it FOR NO KEY UPDATE to add the next) makes this
--      wait, and one that starts later waits for this (OD-11, PD-66);
--   4. the org's own row, then the latest version, FOR NO KEY UPDATE (B-02): two publishes, the
--      first two included, take turns, and the second then finds the first's version and is
--      refused (HF007), as is a seen that isn't the latest;
--   5. the sources, from the locked rows: S, every active or retired non-AI purpose at its latest
--      version, and P, every open non-AI clearance. Unless the caller's sources equal them, the
--      registers moved since the draft (HF007); unless its contact_version is the locked settings
--      version, the contact did (HF007, a message of its own);
--   6. the rules (HF008), each with a message the page can show, in this order: an active purpose
--      with no basis or retention; an active purpose on consent (until C1.3's consent items) or
--      deemed consent by notification (s15A, until per-person opt-out windows are tracked: PD-38).
--      Deemed consent by conduct is stated, its withdrawals carried out by hand under the DPO's
--      written procedure (OD-18, PD-73; docs/runbooks/withdrawal-by-hand.md), and the publish route
--      holds back a purpose on it whose procedure doesn't say how (PD-86); an active purpose listing
--      a provider with no open clearance; no DPO contact recorded (OD-11, PD-68); a body that is
--      blank or over 100,000 characters, or a generator id that isn't one; and a draft identical
--      to the latest version (the same generator, body, sources and settings version). A retired
--      purpose is listed, but no rule applies to it: 0009 already requires its basis and
--      retention, and it no longer runs (B-05);
--   7. the version, numbered after the latest (0 for the first), its links from S and P, and the
--      settings version it printed, the locked row's (PD-66);
--   8. one audit row (ADM-06): ids and numbers only.
-- The api appends notice.published in the same transaction. Returns the version's id and number.
drop function public.publish_notice(integer, text, text, text[], integer[], uuid[], text, uuid, inet);
create function public.publish_notice(
  seen integer,
  body text,
  generator text,
  purpose_keys text[],
  purpose_versions integer[],
  clearance_ids uuid[],
  contact_version integer,   -- the DPO's settings version the draft printed; null when none
  request_id text,
  device_id uuid,
  ip inet
) returns table (notice uuid, version integer)
language plpgsql volatile security definer set search_path = '' as $$
declare
  org uuid := nullif(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  actor uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  -- What no version can state yet (PD-38, OD-18): consent until C1.3's consent items, and deemed
  -- consent by notification (s15A) until C2.11 tracks per-person opt-out windows. Deemed consent by
  -- conduct is stated, its withdrawals carried out by hand under the DPO's written procedure
  -- (docs/runbooks/withdrawal-by-hand.md) until C2.11's switches.
  unstated_bases constant text[] := array['consent', 'deemed_consent_notification'];
  -- Empty, or only JavaScript's whitespace (String.prototype.trim()'s set), as 0009 reads text.
  blank constant text := '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$';
  k text;
  cur public.processing_register%rowtype;
  locked public.processing_register[] := '{}';
  settings public.dpo_settings%rowtype;
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

  loop
    select * into settings from public.dpo_settings s
    where s.org_id = org order by s.version desc limit 1
    for share;
    exit when not found or not exists (
      select 1 from public.dpo_settings s where s.org_id = org and s.version > settings.version);
  end loop;

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
  if contact_version is distinct from settings.version then
    raise exception 'The Data Protection Officer''s contact changed since this notice was prepared. Check the preview again, then publish.'
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
  where p.status = 'active' and p.basis = any (unstated_bases)
  order by p.purpose
  limit 1;
  if found then
    raise exception 'A purpose resting on consent or deemed consent by notification can''t be in the notice yet.' using errcode = 'HF008';
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
  if settings.id is null then
    raise exception 'Record the Data Protection Officer''s contact before publishing.' using errcode = 'HF008';
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
                          where l.org_id = org and l.notice_version_id = latest.id order by 1)
     and latest.dpo_settings_version is not distinct from settings.version then
    raise exception 'The published notice already says this.' using errcode = 'HF008';
  end if;

  new_version := coalesce(latest.version + 1, 0);
  insert into public.notice_versions (id, org_id, version, body, generator, published_by, dpo_settings_version)
  values (new_id, org, new_version, publish_notice.body, publish_notice.generator, actor, settings.version);
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
                           from public.transfer_clearances c where c.org_id = org and c.id = any (open_ids)),
            'contact_version', settings.version));
  return query select new_id, new_version;
end
$$;
revoke execute on function public.publish_notice(integer, text, text, text[], integer[], uuid[], integer, text, uuid, inet)
  from public;

-- The first-Owner bootstrap's clearance of Twilio and AWS (C0.9 OD-01, PD-23), and its break-glass
-- re-clear of Twilio Verify (C0.9 OD-20, PD-77 to PD-80): the facts and a reason given when it
-- runs, the DPO who decided (D35: the first Owner is also the first DPO), and Hearth writing.
-- SECURITY INVOKER and granted to nobody, so only the owner (and a superuser) can run it, in its own
-- transaction, acting as the org's Hearth principal (app.org_id and app.user_id set as withOrg sets
-- them): the reviewed bootstrap script, which a person runs, never a coding agent. It records the
-- facts (Hearth as updated_by; text trimmed, as the api trims the DPO's, so a fact of only
-- whitespace is missing and the clearance refuses it) and a clearance in the DPO's name, which
-- transfer_clearances_check() checks like any other; writes one audit row with Hearth as the
-- actor, the reason (trimmed, and more than whitespace), and in details how it was done, which DPO
-- decided, and each fact that changed, from and to, as record_transfer_entry() does (never via or
-- on_behalf_of_id, which 0004 keeps for A4 and A5); and appends register.transfer_changed. Returns
-- the clearance's id. The messages can be shown as they are. It has two modes, chosen explicitly:
--
-- The set-up (no emergency marker): 0009's function, whole and in 0009's order. It clears only a
-- provider never cleared in the org (cleared_via 'bootstrap', details.by 'bootstrap'): a clearance
-- after a withdrawal is the DPO's, in the app, or the re-clear's.
--
-- The re-clear: only with the emergency marker set in the same transaction,
-- set_config('hearth.break_glass', 'twilio_reclear', true), which only the bootstrap script's
-- recovery mode sets (any other value counts as unset; the marker records intent and is no
-- privilege, since only the owner can run this), and only for a provider cleared in the org before
-- (the marker on one never cleared is refused, so no first clearance is ever an emergency). For
-- Twilio Verify alone, with no clearance open, while no current DPO has a live session: a session
-- not revoked or expired, on a device not signed out, of someone still at the org holding dpo (idle
-- time isn't counted, which fails closed). Before its first lock it bounds its own transaction (a
-- 2 s lock_timeout and a 30 s transaction_timeout, transaction-local, as withOrg() sets them, the
-- timer started afresh), since it then holds every current DPO's person row FOR NO KEY UPDATE,
-- until their set is stable: a code sent before a withdrawal can still finish a sign-in after it
-- (verifyCode() asks the provider by its reference with no transfer gate), and each sign-in step
-- reads the person FOR SHARE first, so a DPO sign-in in progress finishes first and its session is
-- then seen, and one that starts later waits for this. The review date is at most 90 days ahead
-- (the DPO sets a later one in Hearth). The facts are given as at set-up; the recovery mode passes
-- those of the Twilio clearance the latest published version links (else the last ended one's), so
-- by default they are what the notice states. It records cleared_via 'break_glass' and, in the
-- audit row, details.by 'break_glass' with the clearance that last ended and why.
create or replace function public.bootstrap_transfer_clearance(
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
  -- The emergency marker (PD-77): set by the recovery mode alone, in this transaction.
  marked boolean := pg_catalog.current_setting('hearth.break_glass', true) is not distinct from 'twilio_reclear';
  cur public.transfer_register%rowtype;
  proposed public.transfer_register%rowtype;
  ended public.transfer_clearances%rowtype;
  holders uuid[];
  today date;
  at_revision bigint;
  diff jsonb;
  audit jsonb;
  clearance uuid := pg_catalog.gen_random_uuid();
  -- Whitespace at either end, as JavaScript's trim() reads it (transfer_clearances_check()).
  edges constant text := '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'
                         '|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$';
  why text := nullif(pg_catalog.regexp_replace(reason, edges, '', 'g'), '');
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
  if why is null or pg_catalog.length(why) > 2000 then
    raise exception 'Give the set-up''s reason, from 1 to 2,000 characters.' using errcode = 'invalid_parameter_value';
  end if;

  if not marked then
    -- The set-up. The DPO named, read FOR SHARE in the lock order, so a deactivation or revocation
    -- in progress makes this wait and then refuse.
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
  else
    -- The re-clear. Clearances only accrue, so a plain read that finds one stays true; a first
    -- clearance committing just after a read that found none leaves this refused, to be run again.
    if not exists (select 1 from public.transfer_clearances c where c.org_id = org and c.provider = provider_key) then
      raise exception 'The emergency re-clear restores only a clearance that has ended. Run the set-up without it.'
        using errcode = 'HF006';
    end if;
    if provider_key <> 'twilio' then
      raise exception 'That provider has been cleared in this organisation before. The DPO clears it again in Hearth.'
        using errcode = 'HF006';
    end if;
    -- Its own bounds, before its first lock (PD-79): a lock it can't get within 2 s answers 55P03
    -- and the caller runs it again; a transaction left open after it ends 30 s from here, rolling
    -- the re-clear back, so it never holds the DPOs' rows or the outbox's horizon. Postgres starts
    -- the transaction's timer only when none is running, and lowering the setting never shortens
    -- one that is, and SQL can read only the setting, never the timer. So the timer is always
    -- switched off and started again here, at 30 s. Both stay set when this returns (the
    -- function's own set clause restores only search_path).
    perform pg_catalog.set_config('lock_timeout', '2s', true);
    perform pg_catalog.set_config('transaction_timeout', '0', true);
    perform pg_catalog.set_config('transaction_timeout', '30s', true);
    select (pg_catalog.now() at time zone o.time_zone)::date into today from public.orgs o where o.id = org;
    if bootstrap_transfer_clearance.review_on > today + 90 then
      raise exception 'An emergency re-clear sets a review date at most 90 days ahead. The DPO sets a later one in Hearth.'
        using errcode = 'HF006';
    end if;
    -- Every current DPO's person row, in id order, until the set is stable: a dpo grant or a
    -- departure that commits between the read and the lock shows in the read after it.
    loop
      holders := array(select distinct r.person_id from public.role_assignments r
                       join public.people p on p.org_id = r.org_id and p.id = r.person_id
                       where r.org_id = org and r.role = 'dpo' and r.revoked_at is null and p.deactivated_at is null
                       order by 1);
      perform 1 from public.people p where p.org_id = org and p.id = any (holders) order by p.id for no key update;
      exit when holders = array(select distinct r.person_id from public.role_assignments r
                                join public.people p on p.org_id = r.org_id and p.id = r.person_id
                                where r.org_id = org and r.role = 'dpo' and r.revoked_at is null
                                  and p.deactivated_at is null
                                order by 1);
    end loop;
    if dpo is null or not (dpo = any (holders)) then
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
    -- Read plainly once the people rows are held: no DPO session can start or end meanwhile.
    if exists (select 1 from public.sessions s
               join public.devices d on d.org_id = s.org_id and d.user_id = s.user_id and d.id = s.device_id
               where s.org_id = org and s.user_id = any (holders)
                 and s.revoked_at is null and s.expires_at > pg_catalog.now() and d.signed_out_at is null) then
      raise exception 'A Data Protection Officer is signed in, so they clear Twilio Verify again in Hearth.' using errcode = 'HF006';
    end if;
    select * into cur from public.transfer_register t where t.org_id = org and t.provider = provider_key for no key update;
    if not found then
      raise exception 'There is no transfer-register entry for %.', provider_key using errcode = 'invalid_parameter_value';
    end if;
    if exists (select 1 from public.transfer_clearances c
               where c.org_id = org and c.provider = provider_key and c.withdrawn_at is null) then
      raise exception 'Twilio Verify is cleared already. The DPO changes its entry in Hearth.' using errcode = 'HF006';
    end if;
    select * into ended from public.transfer_clearances c
    where c.org_id = org and c.provider = provider_key
    order by c.cleared_at desc
    limit 1;
  end if;

  proposed := cur;
  proposed.services := nullif(pg_catalog.regexp_replace(bootstrap_transfer_clearance.services, edges, '', 'g'), '');
  proposed.data_types := nullif(pg_catalog.regexp_replace(bootstrap_transfer_clearance.data_types, edges, '', 'g'), '');
  proposed.processing_countries := public.transfer_countries(bootstrap_transfer_clearance.processing_countries);
  proposed.storage_countries := public.transfer_countries(bootstrap_transfer_clearance.storage_countries);
  proposed.countries_confirmed := nullif(pg_catalog.regexp_replace(bootstrap_transfer_clearance.countries_confirmed, edges, '', 'g'), '');
  proposed.safeguard := bootstrap_transfer_clearance.safeguard;
  proposed.safeguard_reference := nullif(pg_catalog.regexp_replace(bootstrap_transfer_clearance.safeguard_reference, edges, '', 'g'), '');
  proposed.certificate_verified_on := bootstrap_transfer_clearance.certificate_verified_on;
  proposed.dpa_terms_confirmed := coalesce(bootstrap_transfer_clearance.dpa_terms_confirmed, false);
  proposed.training := bootstrap_transfer_clearance.training;
  proposed.zero_retention := bootstrap_transfer_clearance.zero_retention;
  proposed.provider_retention := nullif(pg_catalog.regexp_replace(bootstrap_transfer_clearance.provider_retention, edges, '', 'g'), '');
  proposed.retention_confirmed := nullif(pg_catalog.regexp_replace(bootstrap_transfer_clearance.retention_confirmed, edges, '', 'g'), '');
  proposed.onward_recipients := nullif(pg_catalog.regexp_replace(bootstrap_transfer_clearance.onward_recipients, edges, '', 'g'), '');
  proposed.review_on := bootstrap_transfer_clearance.review_on;
  at_revision := cur.revision;
  select coalesce(pg_catalog.jsonb_object_agg(w.key, pg_catalog.jsonb_build_object('from', w.value, 'to', n.value)), '{}')
  into diff
  from pg_catalog.jsonb_each(public.transfer_register_facts(cur)) w
  join pg_catalog.jsonb_each(public.transfer_register_facts(proposed)) n on n.key = w.key
  where w.value is distinct from n.value;
  -- No clearance is open on either path, so transfer_register_check() lets the facts change.
  if diff <> '{}' then
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
  values (clearance, org, cur.id, dpo, case when marked then 'break_glass' else 'bootstrap' end);
  audit := pg_catalog.jsonb_build_object('by', case when marked then 'break_glass' else 'bootstrap' end, 'decided_by', dpo,
                                         'revision', at_revision, 'was_revision', cur.revision, 'changed', diff,
                                         'clearance', clearance);
  if marked then
    audit := audit || pg_catalog.jsonb_build_object('ended_clearance', ended.id, 'ended_reason', ended.withdraw_reason);
  end if;
  insert into public.audit_events (org_id, actor_id, action, target_type, target_id, reason, details)
  values (org, hearth, 'register.transfer_cleared', 'transfer_entry', provider_key, why, audit);
  insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose, ids)
  values (org, 'register.transfer_changed', 'transfer_entry', cur.id, hearth, 'system', 'service_operation',
          pg_catalog.jsonb_build_object('provider', provider_key, 'cleared', true));
  return clearance;
end
$$;

-- What each role may do (CLAUDE.md, Database: only the grants each needs; never ALL, TRUNCATE,
-- TRIGGER or REFERENCES). No role may insert, update or delete a contact version or a notice row
-- itself: set_dpo_contact(), publish_notice(), acknowledge_notice() and
-- record_notice_acknowledgement() are their only writers. bootstrap_transfer_clearance(): create or
-- replace keeps 0009's revoke, and nothing is granted. Nothing goes to a job role or hearth_worker.
-- hearth_app (the api): reads the contact for the contact page, the draft and everyone's
-- GET /api/notice; records it, publishes and records acknowledgements through the functions.
grant select on public.dpo_settings to hearth_app;
grant execute on function
    public.set_dpo_contact(integer, text, text, text, text, text, uuid, inet),
    public.record_notice_acknowledgement(uuid, uuid, date, text, text, uuid, inet),
    public.publish_notice(integer, text, text, text[], integer[], uuid[], integer, text, uuid, inet)
  to hearth_app;

-- The tables every request or send reads, locked without ever waiting while one is held. A
-- sign-in send holds transfer_clearances FOR SHARE and then reads notice_versions; a gated request
-- reads notice_versions and notice_acknowledgments (the notice gate) and then, for a
-- re-authentication code or a register read, transfer_clearances. Waiting for one while holding
-- another could close a cycle with either, so each attempt asks for all three with NOWAIT in a
-- block of its own: a busy table fails the attempt, whose rollback lets go of what it took, and
-- the next attempt follows 0.1 s later. Postgres takes a list's locks in the order given, and
-- holds them until the commit. After 100 attempts (about 10 s, the migrator's lock_timeout) it
-- fails with 55P03, and the migrate step is run again.
do $$
begin
  for attempt in 1..100 loop
    begin
      lock table public.transfer_clearances, public.notice_versions, public.notice_acknowledgments
        in access exclusive mode nowait;
      return;
    exception when lock_not_available then
      perform pg_catalog.pg_sleep(0.1);
    end;
  end loop;
  raise exception 'transfer_clearances, notice_versions and notice_acknowledgments stayed in use for 10 s. Run the migrate step again.'
    using errcode = 'lock_not_available';
end
$$;

-- C0.9 OD-20, PD-80: a clearance can now be the break-glass re-clear's, for Twilio Verify alone.
-- transfer_clearances_cleared_via_check is Postgres's name for 0009's inline column check. Every row
-- already there (app or bootstrap) passes both, validated in place; the provider is stamped by
-- transfer_clearances_check() before the checks run.
alter table public.transfer_clearances
  drop constraint transfer_clearances_cleared_via_check,
  add constraint transfer_clearances_cleared_via check (cleared_via in ('app', 'bootstrap', 'break_glass')),
  add constraint transfer_clearances_break_glass check (cleared_via <> 'break_glass' or provider = 'twilio');

-- PD-66: the DPO's settings version a version printed (its contact), which publish_notice() takes
-- from the row it locked, never from the caller's argument alone. Empty on every version made
-- before 0011, stand-ins and 0010's generated versions alike, which printed no contact. A version
-- never changes (notice_unchanged() fires on UPDATE); adding a column with no default updates no row.
alter table public.notice_versions
  add column dpo_settings_version integer,
  add constraint notice_versions_dpo_settings
    foreign key (org_id, dpo_settings_version) references public.dpo_settings (org_id, version);

-- PDPA-03's "when, and how" for an acknowledgement the DPO records (C0.9 OD-19, PD-75): the day the
-- person acknowledged the version outside Hearth, in the org's zone, and a short note of how.
-- acknowledged_at stays the moment it was recorded (the database's). record_notice_acknowledgement()
-- always writes both. A row the DPO recorded before 0011 (fixtures and upgrade data only: nothing
-- wrote one in production) has neither, which the checks allow. hearth_app's SELECT covers both
-- columns, for the person's own rows in Settings; it still holds no INSERT (0010).
alter table public.notice_acknowledgments
  add column acknowledged_on date,
  add column recorded_note text,
  add constraint notice_acknowledgments_recorded_details check (
    (acknowledged_on is null) = (recorded_note is null) and (recorded_note is null or method = 'recorded_by_dpo')),
  add constraint notice_acknowledgments_recorded_note check (
    recorded_note = btrim(recorded_note) and length(recorded_note) between 1 and 500 and recorded_note !~ '[[:cntrl:]]');
