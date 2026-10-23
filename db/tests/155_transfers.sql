-- PDPA-10, D46, PDPA-13, D41, ADM-06, TECH-SPEC T22 (C0.9 PR 1): the transfer register (0009).
-- Only the DPO who is still at the org records, clears and withdraws (RGS-08); a clearance needs
-- every fact PDPA-10 and D46 ask for, refused one by one, with a review date after today in the
-- org's time zone, and never for an AI provider (RGS-09); a cleared entry's facts can't change,
-- recording them ends the clearance, "Save and keep cleared" grants the next one on the new facts or
-- changes nothing, and each clearance is stamped with the facts it rests on (RGS-10); the transfer
-- gate answers for the org set, and only in a transaction that can lock (XFR-01); the first-Owner
-- bootstrap's clearance runs only as the owner, acting as Hearth, once per provider (BSC-01 to
-- BSC-03); and its break-glass re-clear (0011, C0.9 OD-20) runs only with the emergency marker, for
-- Twilio Verify once an earlier clearance has ended, while no DPO has a live session, within its own
-- bounds (BSC-04), on the facts given, stated or not (BSC-05), recorded as break_glass, Twilio's
-- alone (BSC-06), and again after the DPO's own clear and withdrawal (BSC-07). Every case runs as
-- hearth_app (act_as), the owner or the role it tests unless it says it arranges data as the
-- superuser. The facts are made up.
\ir fixtures/two_orgs.sql

-- Today in the transaction's org's time zone.
create function pg_temp.today() returns date language sql as $$
  select (now() at time zone o.time_zone)::date from public.orgs o where o.id = current_setting('app.org_id')::uuid
$$;
-- A complete set of facts, as the DPO's page sends them; a case overrides some. The review date is a
-- year after today in the transaction's org's time zone.
create function pg_temp.full_facts() returns jsonb language sql as $$
  select jsonb_build_object(
    'services', 'Sign-in codes by text message',
    'data_types', 'The phone number, the channel and the service id',
    'processing_countries', jsonb_build_array('us', 'IE', 'US'),
    'storage_countries', jsonb_build_array('US'),
    'countries_confirmed', 'The agreement, schedule 2',
    'safeguard', 'dpa_addendum',
    'safeguard_reference', 'The agreement and its addendum',
    'certificate_verified_on', null,
    'dpa_terms_confirmed', true,
    'training', 'off',
    'zero_retention', 'not_offered',
    'provider_retention', 'Verification records for 30 days',
    'retention_confirmed', 'A letter from the provider',
    'onward_recipients', 'Mobile carriers',
    'review_on', (pg_temp.today() + 365))
$$;
-- record_transfer_entry with full_facts() and the overrides, from the revision the caller can read
-- now, with the request's details, as the api's route calls it.
create function pg_temp.record(p text, changes jsonb default '{}', keep boolean default false)
returns table (entry uuid, revision bigint, cleared boolean, changed boolean) language plpgsql as $$
declare
  f jsonb := pg_temp.full_facts() || changes;
  seen bigint := (select t.revision from public.transfer_register t
                  where t.org_id = current_setting('app.org_id')::uuid and t.provider = p);
begin
  return query select * from public.record_transfer_entry(p, seen, f ->> 'services', f ->> 'data_types',
    array(select jsonb_array_elements_text(f -> 'processing_countries')),
    array(select jsonb_array_elements_text(f -> 'storage_countries')),
    f ->> 'countries_confirmed', f ->> 'safeguard', f ->> 'safeguard_reference', (f ->> 'certificate_verified_on')::date,
    (f ->> 'dpa_terms_confirmed')::boolean, f ->> 'training', f ->> 'zero_retention', f ->> 'provider_retention',
    f ->> 'retention_confirmed', f ->> 'onward_recipients', (f ->> 'review_on')::date, keep,
    'req-transfers', pg_temp.id('1', 'e1'), '192.0.2.30');
end
$$;
create function pg_temp.clear(p text) returns table (entry uuid, revision bigint, cleared boolean, changed boolean)
language sql as $$
  select * from public.clear_transfer_entry(p, (select t.revision from public.transfer_register t
                                                where t.org_id = current_setting('app.org_id')::uuid and t.provider = p),
                                            'req-transfers', pg_temp.id('1', 'e1'), '192.0.2.30')
$$;
create function pg_temp.withdraw(p text) returns table (entry uuid, revision bigint, cleared boolean, changed boolean)
language sql as $$
  select * from public.withdraw_transfer_clearance(p, 'req-transfers', pg_temp.id('1', 'e1'), '192.0.2.30')
$$;
-- bootstrap_transfer_clearance with full_facts() and the overrides.
create function pg_temp.bootstrap(p text, dpo uuid, changes jsonb, why text) returns uuid language plpgsql as $$
declare
  f jsonb := pg_temp.full_facts() || changes;
begin
  return public.bootstrap_transfer_clearance(p, dpo, f ->> 'services', f ->> 'data_types',
    array(select jsonb_array_elements_text(f -> 'processing_countries')),
    array(select jsonb_array_elements_text(f -> 'storage_countries')),
    f ->> 'countries_confirmed', f ->> 'safeguard', f ->> 'safeguard_reference', (f ->> 'certificate_verified_on')::date,
    (f ->> 'dpa_terms_confirmed')::boolean, f ->> 'training', f ->> 'zero_retention', f ->> 'provider_retention',
    f ->> 'retention_confirmed', f ->> 'onward_recipients', (f ->> 'review_on')::date, why);
end
$$;
-- The break-glass re-clear (0011, C0.9 OD-20), as the bootstrap script's recovery mode calls it:
-- the emergency marker set in the transaction, and by default a review date 30 days ahead, inside
-- the 90-day cap. A call that succeeds outside a savepoint leaves its own 2 s lock_timeout and 30 s
-- transaction_timeout set, so this puts back the test transaction's (BSC-04 checks the bounds), and
-- unsets the marker, so a later call is the set-up's.
create function pg_temp.reclear(dpo uuid, changes jsonb default '{}', p text default 'twilio',
                                why text default ' Twilio withdrawn and no DPO signed in ') returns uuid language plpgsql as $$
declare
  lock_was text := current_setting('lock_timeout');
  transaction_was text := current_setting('transaction_timeout');
  clearance uuid;
begin
  perform set_config('hearth.break_glass', 'twilio_reclear', true);
  clearance := pg_temp.bootstrap(p, dpo, jsonb_build_object('review_on', pg_temp.today() + 30) || changes, why);
  perform set_config('hearth.break_glass', '', true), set_config('lock_timeout', lock_was, true),
          set_config('transaction_timeout', transaction_was, true);
  return clearance;
end
$$;
-- The sources publish_notice() derives (as 160 has them): each active or retired non-AI purpose's
-- key and current version, in key order, and each open non-AI clearance's id.
create function pg_temp.sources(out keys text[], out versions integer[], out clearances uuid[]) language sql as $$
  with cur as (
    select distinct on (r.purpose) r.purpose, r.version, r.status
    from public.processing_register r
    where r.org_id = current_setting('app.org_id')::uuid and not r.ai
    order by r.purpose, r.version desc)
  select array(select c.purpose from cur c where c.status <> 'planned' order by c.purpose),
         array(select c.version from cur c where c.status <> 'planned' order by c.purpose),
         array(select x.id from public.transfer_clearances x join public.transfer_register t on t.id = x.entry_id
               where x.org_id = current_setting('app.org_id')::uuid and x.withdrawn_at is null and not t.ai order by x.id)
$$;
-- Every clearance a test makes is made in its one transaction, so all share now(). The re-clear's
-- audit row names the clearance that ended last (the latest cleared_at), so before one, every
-- earlier clearance of the provider but the given one is moved back an hour (as the superuser;
-- only the end of a clearance is kept from change), as the episodes would be spread across days.
create function pg_temp.backdate_but(o text, p text, latest uuid) returns void language sql as $$
  update public.transfer_clearances set cleared_at = cleared_at - interval '1 hour'
  where org_id = pg_temp.id(o, '00') and provider = p and id <> latest
$$;
-- Acting as the owner in an org, as Hearth (the bootstrap's transaction), or as someone else.
create function pg_temp.act_as_owner(o text, suffix text) returns void language plpgsql as $$
begin
  perform set_config('app.org_id', pg_temp.id(o, '00')::text, true);
  perform set_config('app.user_id', pg_temp.id(o, suffix)::text, true);
  perform set_config('role', 'hearth_owner', true);
end
$$;

-- RGS-08 (PDPA-10 "maintained by the DPO", PDPA-13, ACC-10, C0.9 PD-20, PD-21): only the DPO who is
-- still at the org records, clears and withdraws. Refused (42501): the Owner, an Admin, AI Admin,
-- Leadership, the Compliance Officer, a Team Admin, a Member, a DPO who has left, a former Admin,
-- an agent, an assistant, Hearth itself, another org's DPO, no acting person, a DPO whose role was
-- revoked, and the worker's roles, which can't run them at all. Nothing is written for any of them.
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
do $$
declare
  who text;
begin
  foreach who in array array['a1', 'a2', 'a3', 'a4', 'a6', 'a7', 'a8', 'a9', 'aa', 'ab', 'ac', 'a0'] loop
    perform pg_temp.act_as('1', who);
    perform pg_temp.expect_error($f$select * from pg_temp.record('twilio')$f$, '42501',
                                 'Only the Data Protection Officer can change the registers.');
    perform pg_temp.expect_error($f$select * from pg_temp.clear('aws')$f$, '42501',
                                 'Only the Data Protection Officer can change the registers.');
    perform pg_temp.expect_error($f$select * from pg_temp.withdraw('aws')$f$, '42501',
                                 'Only the Data Protection Officer can change the registers.');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', pg_temp.id('2', 'a5')::text, true);
set local role hearth_app;
select pg_temp.expect_error($$select * from pg_temp.record('twilio')$$, '42501');
select pg_temp.expect_error($$select * from pg_temp.clear('aws')$$, '42501');
select pg_temp.expect_error($$select * from pg_temp.withdraw('aws')$$, '42501');
select set_config('app.user_id', '', true);
select pg_temp.expect_error($$select * from pg_temp.withdraw('aws')$$, '42501');
reset role;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge',
                           'hearth_job_revocation', 'hearth_worker'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error($f$select * from public.record_transfer_entry('twilio', 1, 'Codes', null, '{}', '{}', null,
                                   null, null, null, false, null, null, null, null, null, null, false, null, null, null)$f$, '42501');
    perform pg_temp.expect_error($f$select * from public.clear_transfer_entry('aws', 2, null, null, null)$f$, '42501');
    perform pg_temp.expect_error($f$select * from public.withdraw_transfer_clearance('aws', null, null, null)$f$, '42501');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
update public.role_assignments set revoked_at = now(), revoked_by = pg_temp.id('1', 'a1')
where person_id = pg_temp.id('1', 'a5') and role = 'dpo';
select pg_temp.act_as('1', 'a5');
select pg_temp.expect_error($$select * from pg_temp.withdraw('aws')$$, '42501', 'Only the Data Protection Officer can change the registers.');
reset role;
-- A new DPO (a6, granted as the superuser) takes over in org 1 for the rest of this test.
insert into public.role_assignments (org_id, person_id, role, created_by, approved_by, approved_at)
  values (pg_temp.id('1', '00'), pg_temp.id('1', 'a6'), 'dpo', pg_temp.id('1', 'a1'), pg_temp.id('1', 'a2'), now());
select pg_temp.check(count(*) = 0, 'a refused change wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
select pg_temp.check((select revision from public.transfer_register where org_id = pg_temp.id('1', '00') and provider = 'twilio') = 1
                     and (select withdrawn_at is null from public.transfer_clearances where id = pg_temp.id('1', 'e5')),
                     'a refused change changed an entry or a clearance');
select pg_temp.act_as('1', 'a6');
select pg_temp.check(changed and revision = 2 and not cleared, 'the DPO could not record twilio''s facts')
from pg_temp.record('twilio');
reset role;
select pg_temp.check(t.processing_countries = '{IE,US}' and t.storage_countries = '{US}' and t.updated_by = pg_temp.id('1', 'a6')
                     and t.updated_at = now() and t.review_on = (now() at time zone 'Asia/Singapore')::date + 365,
                     'twilio''s facts were not recorded as sent, with countries upper case, sorted and once each')
from public.transfer_register t where t.org_id = pg_temp.id('1', '00') and t.provider = 'twilio';

-- RGS-09 (PDPA-10, D46, D41, C0.9 PD-12): clearing needs every fact, refused one at a time by the
-- clearance's trigger (HF006), with a message naming what is missing, and in the order the shared
-- rules list them; a review date that isn't after today in the org's time zone; a certificate
-- verified on a date still to come; and never an AI provider, through the functions or directly.
select pg_temp.act_as('1', 'a6');
do $$
declare
  c record;
begin
  for c in
    select * from (values
      ('{"services": null}'::jsonb, 'Record the services it provides before clearing it.'),
      -- Text of only whitespace (JavaScript's, as transferProblems() reads it) is no fact.
      ('{"services": "\t"}', 'Record the services it provides before clearing it.'),
      ('{"data_types": null}', 'Record the personal data it receives before clearing it.'),
      ('{"processing_countries": []}', 'Record the countries where it processes the data before clearing it.'),
      ('{"storage_countries": []}', 'Record the countries where it stores the data before clearing it.'),
      ('{"countries_confirmed": null}', 'Record where and when it confirmed those countries in writing before clearing it.'),
      ('{"safeguard": null}', 'Record the safeguard for the transfer before clearing it.'),
      ('{"safeguard_reference": null}', 'Record where the safeguard is kept before clearing it.'),
      (jsonb_build_object('safeguard', 'certification', 'certificate_verified_on', pg_temp.today() + 1),
       'A certificate can''t be verified on a date still to come.'),
      ('{"dpa_terms_confirmed": false}', 'Confirm the agreement binds protection comparable to the PDPA%'),
      ('{"training": null}', 'Record whether it trains on the data before clearing it.'),
      ('{"zero_retention": null}', 'Record the zero-retention result before clearing it. Pending isn''t a result.'),
      ('{"zero_retention": "pending"}', 'Record the zero-retention result before clearing it. Pending isn''t a result.'),
      ('{"provider_retention": null}', 'Record how long it keeps the data before clearing it.'),
      ('{"retention_confirmed": null}', 'Record where and when it confirmed how long it keeps the data in writing before clearing it.'),
      ('{"onward_recipients": null}', 'Record who it passes the data on to (or None) before clearing it.'),
      ('{"onward_recipients": "\u00a0\u3000\n"}', 'Record who it passes the data on to (or None) before clearing it.'),
      ('{"review_on": null}', 'Set a review date after today before clearing it.'),
      (jsonb_build_object('review_on', pg_temp.today()), 'Set a review date after today before clearing it.'),
      (jsonb_build_object('review_on', pg_temp.today() - 1), 'Set a review date after today before clearing it.'),
      -- With several missing, the first in order is named.
      ('{"review_on": null, "onward_recipients": null, "services": null}', 'Record the services it provides%'),
      ('{"training": null, "storage_countries": []}', 'Record the countries where it stores%')
    ) as v (changes, message)
  loop
    perform pg_temp.check((select changed from pg_temp.record('twilio', c.changes)), format('recording %s changed nothing', c.changes));
    perform pg_temp.expect_error($f$select * from pg_temp.clear('twilio')$f$, 'HF006', c.message);
  end loop;
end
$$;
-- A certification counts only once verified (23514, the table's own rule).
select pg_temp.expect_error($$select * from pg_temp.record('twilio', '{"safeguard": "certification"}')$$, '23514',
                            '%transfer_register_certificate%');
-- A country code is two capital letters (23514).
select pg_temp.expect_error($$select * from pg_temp.record('twilio', '{"processing_countries": ["USA"]}')$$, '23514',
                            '%transfer_register_countries%');
-- A text fact is kept trimmed, so one of only spaces is never recorded, nor one with spaces around
-- it (23514, the column's own rule, as processing_register's); other whitespace alone is recorded,
-- and the clearance refuses it, above.
do $$
declare
  f text;
  v text;
begin
  foreach f in array array['services', 'data_types', 'countries_confirmed', 'safeguard_reference', 'provider_retention',
                           'retention_confirmed', 'onward_recipients'] loop
    foreach v in array array[' ', E' \t ', ' Padded'] loop
      perform pg_temp.expect_error(format($f$select * from pg_temp.record('twilio', %L)$f$, jsonb_build_object(f, v)), '23514',
                                   format('%%transfer_register_%s_check%%', f));
    end loop;
  end loop;
end
$$;
-- With every fact, it clears, and a certificate verified today counts.
select pg_temp.check((select changed from pg_temp.record('twilio', jsonb_build_object('safeguard', 'certification',
                                                                                       'certificate_verified_on', pg_temp.today()))),
                     'recording a verified certificate changed nothing');
select pg_temp.check(cleared and changed, 'twilio did not clear with every fact recorded') from pg_temp.clear('twilio');
-- D41: an AI provider is refused by every function, before anything else (HF006).
select pg_temp.expect_error($$select * from pg_temp.record('openai')$$, 'HF006',
                            'Providers for later stages can''t be recorded or cleared until their stage begins.');
select pg_temp.expect_error($$select * from public.clear_transfer_entry('bedrock', 1, null, null, null)$$, 'HF006',
                            'Providers for later stages%');
select pg_temp.expect_error($$select * from pg_temp.withdraw('openai')$$, 'HF006', 'Providers for later stages%');
reset role;
-- And by the trigger, even with every fact recorded (as the superuser).
update public.transfer_register
set services = 'Models', data_types = 'Text', processing_countries = '{US}', storage_countries = '{US}',
    countries_confirmed = 'The agreement', safeguard = 'dpa', safeguard_reference = 'The agreement',
    dpa_terms_confirmed = true, training = 'off', zero_retention = 'granted', provider_retention = 'None',
    retention_confirmed = 'The agreement', onward_recipients = 'None', review_on = current_date + 365, revision = 2,
    updated_by = pg_temp.id('1', 'a6')
where org_id = pg_temp.id('1', '00') and provider = 'openai';
select pg_temp.expect_error($$insert into public.transfer_clearances (org_id, entry_id, cleared_by, cleared_via)
  select t.org_id, t.id, 'f1000000-0000-4000-8000-0000000000a6', 'app' from public.transfer_register t
  where t.org_id = 'f1000000-0000-4000-8000-000000000000' and t.provider = 'openai'$$, 'HF006',
  'Providers for later stages can''t be cleared until their stage begins.');
-- The review date is judged in the org's time zone, not the server's: in a zone ahead of UTC
-- (Pacific/Kiritimati, UTC+14) and one behind it (Etc/GMT+12, UTC-12), today there is refused and
-- the day after cleared, whatever the hour in UTC. As org 2's DPO, on apple_push.
update public.orgs set time_zone = 'Pacific/Kiritimati' where id = pg_temp.id('2', '00');
select pg_temp.act_as('2', 'a5');
select pg_temp.check((select changed from pg_temp.record('apple_push', jsonb_build_object('review_on', pg_temp.today()))),
                     'recording apple_push changed nothing');
select pg_temp.expect_error($$select * from pg_temp.clear('apple_push')$$, 'HF006', 'Set a review date after today%');
select pg_temp.check((select changed from pg_temp.record('apple_push', jsonb_build_object('review_on', pg_temp.today() + 1))),
                     'recording apple_push changed nothing');
select pg_temp.check(cleared, 'a review date after today in Kiritimati was refused') from pg_temp.clear('apple_push');
reset role;
update public.orgs set time_zone = 'Etc/GMT+12' where id = pg_temp.id('2', '00');
select pg_temp.act_as('2', 'a5');
select pg_temp.check((select changed and not cleared from pg_temp.record('apple_push', jsonb_build_object('review_on', pg_temp.today()))),
                     'recording apple_push did not end its clearance');
select pg_temp.expect_error($$select * from pg_temp.clear('apple_push')$$, 'HF006', 'Set a review date after today%');
select pg_temp.check((select changed from pg_temp.record('apple_push', jsonb_build_object('review_on', pg_temp.today() + 1))),
                     'recording apple_push changed nothing');
select pg_temp.check(cleared, 'a review date after today at UTC-12 was refused') from pg_temp.clear('apple_push');
reset role;
update public.orgs set time_zone = 'Asia/Singapore' where id = pg_temp.id('2', '00');

-- RGS-10 (PDPA-10, ADM-06, C0.9 PD-05, PD-21): a clearance and the facts it rests on. Org 1's aws
-- was cleared on the fixture's facts (e5, at revision 2).
-- A cleared entry's facts can't change, even for the superuser (23514); a field that isn't a fact can.
select pg_temp.expect_error($$update public.transfer_register set services = 'Changed'
  where org_id = 'f1000000-0000-4000-8000-000000000000' and provider = 'aws'$$, '23514',
  'A cleared entry''s facts can''t change. End its clearance first.');
select pg_temp.expect_error($$update public.transfer_register set review_on = review_on + 1
  where org_id = 'f1000000-0000-4000-8000-000000000000' and provider = 'aws'$$, '23514', 'A cleared entry''s facts%');
select pg_temp.expect_rows($$update public.transfer_register set updated_at = now()
  where org_id = 'f1000000-0000-4000-8000-000000000000' and provider = 'aws'$$, 1);
-- Recording new facts ends the clearance (facts_changed), moves the revision on, and writes one
-- audit row naming each fact that changed, from and to (and none that didn't).
select set_config('test.audit_max', (select max(id)::text from public.audit_events), true);
select pg_temp.act_as('1', 'a6');
select pg_temp.check(changed and revision = 3 and not cleared, 'recording aws''s facts did not end its clearance')
from pg_temp.record('aws');
select pg_temp.check(not public.transfer_cleared('aws'), 'aws still reads as cleared after its facts changed');
reset role;
select pg_temp.check(withdrawn_at = now() and withdrawn_by = pg_temp.id('1', 'a6') and withdraw_reason = 'facts_changed',
                     'aws''s clearance did not end as facts_changed')
from public.transfer_clearances where id = pg_temp.id('1', 'e5');
select pg_temp.check(a.action = 'register.transfer_recorded' and a.actor_id = pg_temp.id('1', 'a6')
                     and a.target_type = 'transfer_entry' and a.target_id = 'aws' and a.request_id = 'req-transfers'
                     and a.device_id = pg_temp.id('1', 'e1') and a.ip = '192.0.2.30'
                     and (a.details ->> 'revision')::int = 3 and (a.details ->> 'was_revision')::int = 2
                     and (a.details ->> 'ended_clearance')::boolean and not (a.details ->> 'kept_cleared')::boolean
                     and a.details -> 'changed' -> 'services'
                         = '{"from": "Hosting, CloudWatch logs", "to": "Sign-in codes by text message"}'
                     and a.details -> 'changed' -> 'processing_countries' = '{"from": ["SG"], "to": ["IE", "US"]}'
                     and (a.details -> 'changed' ? 'safeguard_reference')
                     and not (a.details -> 'changed' ? 'dpa_terms_confirmed'),
                     format('the audit row does not record the change: %s', a.details))
from public.audit_events a where a.id > current_setting('test.audit_max')::bigint;
select pg_temp.check(count(*) = 1, format('expected one audit row for the change, got %s', count(*)))
from public.audit_events where id > current_setting('test.audit_max')::bigint;
-- Clearing it again stamps the new clearance with the revision and the facts it rests on.
select pg_temp.act_as('1', 'a6');
select pg_temp.check(cleared and changed and revision = 3, 'aws did not clear again') from pg_temp.clear('aws');
select pg_temp.check(public.transfer_cleared('aws'), 'aws does not read as cleared');
reset role;
select pg_temp.check(c.register_revision = 3 and c.facts = public.transfer_register_facts(t) and c.cleared_via = 'app'
                     and c.cleared_by = pg_temp.id('1', 'a6') and c.provider = 'aws' and c.withdrawn_at is null,
                     'the new clearance does not rest on revision 3''s facts')
from public.transfer_clearances c join public.transfer_register t on t.id = c.entry_id
where c.org_id = pg_temp.id('1', '00') and c.provider = 'aws' and c.withdrawn_at is null;
select pg_temp.check(a.action = 'register.transfer_cleared' and (a.details ->> 'revision')::int = 3
                     and (a.details ->> 'clearance')::uuid = (select id from public.transfer_clearances
                                                             where org_id = pg_temp.id('1', '00') and provider = 'aws'
                                                               and withdrawn_at is null),
                     format('the clearance''s audit row is wrong: %s', a.details))
from public.audit_events a where a.id = (select max(id) from public.audit_events where action = 'register.transfer_cleared');
-- A clear when already cleared, and a record of the same facts (countries in another order), write
-- nothing.
select set_config('test.audit_max', (select max(id)::text from public.audit_events), true);
select pg_temp.act_as('1', 'a6');
select pg_temp.check(cleared and not changed and revision = 3, 'clearing a cleared entry changed it') from pg_temp.clear('aws');
select pg_temp.check(cleared and not changed and revision = 3, 'recording the same facts changed the entry')
from pg_temp.record('aws', '{"processing_countries": ["US", "ie"]}', true);
-- Stale: a revision the DPO never saw, or none (HF005); an unknown provider (22023).
select pg_temp.expect_error($$select * from public.record_transfer_entry('aws', 2, 'Hosting', null, '{}', '{}', null, null, null,
  null, false, null, null, null, null, null, null, false, null, null, null)$$, 'HF005',
  'This entry changed since you opened it. Reload it and try again.');
select pg_temp.expect_error($$select * from public.clear_transfer_entry('twilio', 1, null, null, null)$$, 'HF005');
select pg_temp.expect_error($$select * from public.clear_transfer_entry('twilio', null, null, null, null)$$, 'HF005');
select pg_temp.expect_error($$select * from public.record_transfer_entry('no_such_provider', 1, 'Hosting', null, '{}', '{}', null,
  null, null, null, false, null, null, null, null, null, null, false, null, null, null)$$, '22023');
select pg_temp.expect_error($$select * from public.clear_transfer_entry('no_such_provider', 1, null, null, null)$$, '22023');
select pg_temp.expect_error($$select * from public.withdraw_transfer_clearance('no_such_provider', null, null, null)$$, '22023');
reset role;
select pg_temp.check(count(*) = 0, 'a no-op or a refused change wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
-- "Save and keep cleared": the clearance ends (facts_changed) and the next one is granted on the new
-- facts in the same call; a send never reads "not cleared" afterwards.
select pg_temp.act_as('1', 'a6');
select pg_temp.check(cleared and changed and revision = 4, 'save and keep cleared did not keep aws cleared')
from pg_temp.record('aws', '{"services": "Hosting and logs"}', true);
select pg_temp.check(public.transfer_cleared('aws'), 'aws reads as not cleared after save and keep cleared');
reset role;
select pg_temp.check(count(*) filter (where withdrawn_at is null) = 1
                     and count(*) filter (where withdraw_reason = 'facts_changed') = 2
                     and bool_and(withdrawn_at is not null or (register_revision = 4 and facts ->> 'services' = 'Hosting and logs')),
                     'save and keep cleared did not end one clearance and grant one on the new facts')
from public.transfer_clearances where org_id = pg_temp.id('1', '00') and provider = 'aws';
select pg_temp.check((details ->> 'ended_clearance')::boolean and (details ->> 'kept_cleared')::boolean
                     and details -> 'changed' = '{"services": {"from": "Sign-in codes by text message", "to": "Hosting and logs"}}',
                     format('the audit row does not record keeping it cleared: %s', details))
from public.audit_events where id = (select max(id) from public.audit_events where action = 'register.transfer_recorded');
-- With new facts that are incomplete, the whole call is refused (HF006) and nothing changes.
select set_config('test.audit_max', (select max(id)::text from public.audit_events), true);
select pg_temp.act_as('1', 'a6');
select pg_temp.expect_error($$select * from pg_temp.record('aws', '{"services": "Hosting and logs", "onward_recipients": null}', true)$$,
                            'HF006', 'Record who it passes the data on to%');
select pg_temp.check(public.transfer_cleared('aws'), 'a refused save and keep cleared ended the clearance');
reset role;
select pg_temp.check(revision = 4 and onward_recipients = 'Mobile carriers', 'a refused save and keep cleared changed the facts')
from public.transfer_register where org_id = pg_temp.id('1', '00') and provider = 'aws';
select pg_temp.check(count(*) = 0, 'a refused save and keep cleared wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
-- Keeping cleared only keeps a clearance that was open: org 1's livekit, never cleared, stays so.
select pg_temp.act_as('1', 'a6');
select pg_temp.check(changed and not cleared, 'save and keep cleared cleared an entry that was not cleared')
from pg_temp.record('livekit', '{}', true);
reset role;
-- One open clearance per provider (23505), and an ended one stays as it ended (keep_history).
select pg_temp.expect_error($$insert into public.transfer_clearances (org_id, entry_id, cleared_by, cleared_via)
  select t.org_id, t.id, 'f1000000-0000-4000-8000-0000000000a6', 'app' from public.transfer_register t
  where t.org_id = 'f1000000-0000-4000-8000-000000000000' and t.provider = 'aws'$$, '23505', '%transfer_clearances_open%');
select pg_temp.expect_error($$update public.transfer_clearances set withdrawn_at = now() - interval '1 day'
  where id = 'f1000000-0000-4000-8000-0000000000e5'$$, '23514', '%already ended%');
select pg_temp.expect_error($$update public.transfer_clearances set withdraw_reason = 'dpo_decision'
  where id = 'f1000000-0000-4000-8000-0000000000e5'$$, '23514', '%already ended%');
select pg_temp.expect_error($$update public.transfer_clearances set withdrawn_at = now()
  where org_id = 'f1000000-0000-4000-8000-000000000000' and provider = 'aws' and withdrawn_at is null$$, '23514',
  '%transfer_clearances_withdrawn%');
-- Withdrawing: the open clearance ends by the DPO's decision, with one audit row; with none open,
-- nothing is written.
select set_config('test.audit_max', (select max(id)::text from public.audit_events), true);
select pg_temp.act_as('1', 'a6');
select pg_temp.check(changed and not cleared and revision = 4, 'withdrawing aws did not end its clearance') from pg_temp.withdraw('aws');
select pg_temp.check(not changed and not cleared and revision = 4, 'withdrawing again changed something') from pg_temp.withdraw('aws');
select pg_temp.check(not public.transfer_cleared('aws'), 'aws still reads as cleared after its withdrawal');
reset role;
select pg_temp.check(count(*) = 1 and bool_and(c.withdrawn_by = pg_temp.id('1', 'a6') and c.withdraw_reason = 'dpo_decision'),
                     'the withdrawal did not end exactly one clearance by the DPO''s decision')
from public.transfer_clearances c where c.org_id = pg_temp.id('1', '00') and c.provider = 'aws' and c.withdrawn_at = now()
  and c.withdraw_reason = 'dpo_decision';
select pg_temp.check(count(*) = 1 and bool_and(action = 'register.transfer_withdrawn' and target_id = 'aws'
                                               and (details ->> 'revision')::int = 4 and details ? 'clearance'),
                     format('expected one register.transfer_withdrawn row, got %s', count(*)))
from public.audit_events where id > current_setting('test.audit_max')::bigint;
-- The trigger stamps a clearance with the entry's provider, revision and facts, whatever the
-- writer sent (as the superuser).
insert into public.transfer_clearances (org_id, entry_id, provider, register_revision, facts, cleared_by, cleared_via)
select t.org_id, t.id, 'twilio', 999, '{"services": "Something else"}', pg_temp.id('1', 'a6'), 'app'
from public.transfer_register t where t.org_id = pg_temp.id('1', '00') and t.provider = 'aws';
select pg_temp.check(c.provider = 'aws' and c.register_revision = 4 and c.facts = public.transfer_register_facts(t),
                     'the trigger did not stamp the clearance with the entry''s provider, revision and facts')
from public.transfer_clearances c join public.transfer_register t on t.id = c.entry_id
where c.org_id = pg_temp.id('1', '00') and c.provider = 'aws' and c.withdrawn_at is null;

-- XFR-01 (PDPA-10, D46, C0.9 PD-15): the transfer gate, as the api asks it in the transaction that
-- decides a send (as Hearth before a session exists, or as the person re-authenticating): false,
-- then true once cleared, then false once withdrawn; another org's clearance is never this org's; an
-- unknown or AI provider is never cleared; no org set is refused (42501); and a read-only transaction
-- can't run it, since it locks the clearance it reads (25006). The worker's roles can't run it.
select pg_temp.act_as('1', 'a0');
select pg_temp.check(not public.transfer_cleared('livekit'), 'livekit reads as cleared before any clearance');
reset role;
select pg_temp.act_as('2', 'a5');
select pg_temp.check((select changed from pg_temp.record('livekit')) and (select cleared from pg_temp.clear('livekit')),
                     'org 2''s DPO could not clear livekit');
select pg_temp.check(public.transfer_cleared('livekit'), 'org 2''s livekit does not read as cleared');
reset role;
select pg_temp.act_as('1', 'a0');
select pg_temp.check(not public.transfer_cleared('livekit'), 'org 2''s clearance of livekit reached org 1');
reset role;
select pg_temp.act_as('1', 'a6');
select pg_temp.check((select cleared from pg_temp.clear('livekit')), 'org 1''s DPO could not clear livekit');
reset role;
select pg_temp.act_as('1', 'a8');
select pg_temp.check(public.transfer_cleared('livekit') and public.transfer_cleared('twilio'),
                     'org 1''s cleared providers do not read as cleared');
select pg_temp.check(not public.transfer_cleared('openai') and not public.transfer_cleared('aws_sms')
                     and not public.transfer_cleared('no_such_provider') and not public.transfer_cleared(null),
                     'a provider never cleared reads as cleared');
reset role;
select pg_temp.act_as('1', 'a6');
select pg_temp.check((select changed from pg_temp.withdraw('livekit')), 'org 1''s DPO could not withdraw livekit');
reset role;
select pg_temp.act_as('1', 'a0');
select pg_temp.check(not public.transfer_cleared('livekit'), 'livekit still reads as cleared after its withdrawal');
do $$
begin
  begin
    perform set_config('transaction_read_only', 'on', true);
    perform public.transfer_cleared('twilio');
    raise exception 'transfer_cleared ran in a read-only transaction';
  exception when read_only_sql_transaction then
    null;
  end;
end
$$;
reset role;
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
set local role hearth_app;
select pg_temp.expect_error($$select public.transfer_cleared('twilio')$$, '42501', 'No org is set for this transaction');
reset role;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge',
                           'hearth_job_revocation', 'hearth_worker'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error($f$select public.transfer_cleared('twilio')$f$, '42501');
    perform set_config('role', 'none', true);
  end loop;
end
$$;

-- BSC-01 (C0.9 OD-01, OD-20, PD-23): no runtime role can run the bootstrap's clearance (42501); only
-- its owner and a superuser can. 0011 replaced it in place: still the owner's, a security invoker,
-- granted to nobody.
do $$
declare
  r text;
begin
  foreach r in array pg_temp.runtime_roles() || array['hearth_worker'] loop
    perform pg_temp.check(not has_function_privilege(r,
      'public.bootstrap_transfer_clearance(text,uuid,text,text,text[],text[],text,text,text,date,boolean,text,text,text,text,text,date,text)',
      'EXECUTE'), format('%s can run the bootstrap''s clearance', r));
  end loop;
end
$$;
select pg_temp.check(not prosecdef and proowner = 'hearth_owner'::regrole and proacl is not null
                     and not exists (select 1 from aclexplode(proacl) a where a.grantee <> proowner),
                     'the bootstrap''s clearance changed its owner, its rights or its grants')
from pg_proc
where oid = 'public.bootstrap_transfer_clearance(text,uuid,text,text,text[],text[],text,text,text,date,boolean,text,text,text,text,text,date,text)'::regprocedure;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_app', 'hearth_queue'] loop
    perform set_config('app.org_id', pg_temp.id('2', '00')::text, true);
    perform set_config('app.user_id', pg_temp.id('2', 'a0')::text, true);
    perform set_config('role', r, true);
    perform pg_temp.expect_error($f$select public.bootstrap_transfer_clearance('twilio', 'f2000000-0000-4000-8000-0000000000a5',
      'Codes', 'Numbers', '{US}', '{US}', 'Agreement', 'dpa', 'Agreement', null, true, 'off', 'not_offered', '30 days',
      'Letter', 'Carriers', current_date + 365, 'Set-up')$f$, '42501', 'permission denied%');
    perform set_config('role', 'none', true);
  end loop;
end
$$;

-- BSC-03 (C0.9 OD-01, PD-23): what the bootstrap's clearance refuses, writing nothing: a transaction
-- that doesn't act as the org's Hearth principal (42501); a provider other than Twilio or AWS
-- (HF006); a DPO who isn't one, has left, or is another org's (42501); a reason missing, of only
-- spaces or too long (22023); missing facts, a text fact of only spaces among them, since the
-- set-up trims each (HF006, the clearance's own trigger); and a provider cleared in the org before
-- (HF006), even after a withdrawal. As the owner, in org 2.
select set_config('test.audit_max', (select max(id)::text from public.audit_events), true);
select set_config('test.outbox_max', (select max(id)::text from public.outbox_events), true);
select pg_temp.act_as_owner('2', 'a1');
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a5', '{}', 'Set-up')$$, '42501',
                            'Run this in the bootstrap''s transaction, acting as the organisation''s Hearth principal.');
select set_config('app.user_id', '', true);
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a5', '{}', 'Set-up')$$, '42501');
select set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a5', '{}', 'Set-up')$$, '42501');
reset role;
select pg_temp.act_as_owner('2', 'a0');
select pg_temp.expect_error($$select pg_temp.bootstrap('livekit', 'f2000000-0000-4000-8000-0000000000a5', '{}', 'Set-up')$$, 'HF006',
                            'The set-up clears only Twilio Verify and AWS. The DPO clears the rest in Hearth.');
select pg_temp.expect_error($$select pg_temp.bootstrap('openai', 'f2000000-0000-4000-8000-0000000000a5', '{}', 'Set-up')$$, 'HF006');
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a1', '{}', 'Set-up')$$, '42501',
                            'The person named as the DPO must be at the organisation and hold the DPO role.');
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a9', '{}', 'Set-up')$$, '42501',
                            'The person named as the DPO%');
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f1000000-0000-4000-8000-0000000000a5', '{}', 'Set-up')$$, '42501',
                            'The person named as the DPO%');
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a5', '{}', '')$$, '22023',
                            'Give the set-up''s reason, from 1 to 2,000 characters.');
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a5', '{}', null)$$, '22023');
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a5', '{}', E' \t' || U&'\00A0')$$, '22023',
                            'Give the set-up''s reason, from 1 to 2,000 characters.');
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a5', '{}', repeat('x', 2001))$$,
                            '22023');
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a5', '{"retention_confirmed": null}',
  'Set-up')$$, 'HF006', 'Record where and when it confirmed how long it keeps the data in writing%');
do $$
declare
  c record;
begin
  for c in
    select * from (values
      ('services', 'Record the services it provides%'),
      ('data_types', 'Record the personal data it receives%'),
      ('countries_confirmed', 'Record where and when it confirmed those countries%'),
      ('safeguard_reference', 'Record where the safeguard is kept%'),
      ('provider_retention', 'Record how long it keeps the data before%'),
      ('retention_confirmed', 'Record where and when it confirmed how long it keeps the data in writing%'),
      ('onward_recipients', 'Record who it passes the data on to%')
    ) as v (fact, message)
  loop
    perform pg_temp.expect_error(format($f$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a5', %L, 'Set-up')$f$,
                                        jsonb_build_object(c.fact, E' \t\n' || U&'\00A0\FEFF')), 'HF006', c.message);
  end loop;
end
$$;
-- aws was cleared in org 2 by its DPO (the fixture's e5), so the set-up can't clear it.
select pg_temp.expect_error($$select pg_temp.bootstrap('aws', 'f2000000-0000-4000-8000-0000000000a5', '{}', 'Set-up')$$, 'HF006',
                            'That provider has been cleared in this organisation before. The DPO clears it again in Hearth.');
reset role;
select pg_temp.check(count(*) = 0, 'a refused set-up wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
select pg_temp.check(count(*) = 0, 'a refused set-up appended an event')
from public.outbox_events where id > current_setting('test.outbox_max')::bigint;
select pg_temp.check(revision = 1 and updated_by is null, 'a refused set-up recorded twilio''s facts')
from public.transfer_register where org_id = pg_temp.id('2', '00') and provider = 'twilio';

-- BSC-02 (C0.9 OD-01, PD-23, TECH-SPEC T22 item 3): as the owner, acting as org 2's Hearth
-- principal, the set-up records twilio's facts as Hearth's and clears it in the DPO's name
-- (cleared_via 'bootstrap'), writes one audit row with Hearth as the actor, the reason, and details
-- naming the bootstrap, the DPO and each fact that changed, from and to (never via or
-- on_behalf_of_id, which 0004 keeps for A4 and A5), and appends one register.transfer_changed event,
-- Hearth acting. The api's gate then reads it as cleared.
select pg_temp.act_as_owner('2', 'a0');
select set_config('test.clearance', pg_temp.bootstrap('twilio', pg_temp.id('2', 'a5'), '{}',
                                                      'First set-up: the signed agreement and the provider''s letter')::text, true);
reset role;
select pg_temp.check(c.cleared_via = 'bootstrap' and c.cleared_by = pg_temp.id('2', 'a5') and c.provider = 'twilio'
                     and c.register_revision = 2 and c.facts = public.transfer_register_facts(t) and c.withdrawn_at is null
                     and t.revision = 2 and t.updated_by = pg_temp.id('2', 'a0') and t.processing_countries = '{IE,US}',
                     'the set-up did not record twilio''s facts as Hearth''s and clear them in the DPO''s name')
from public.transfer_clearances c join public.transfer_register t on t.id = c.entry_id
where c.id = current_setting('test.clearance')::uuid;
select pg_temp.check(count(*) = 1 and bool_and(
                       a.org_id = pg_temp.id('2', '00') and a.actor_id = pg_temp.id('2', 'a0') and a.action = 'register.transfer_cleared'
                       and a.target_type = 'transfer_entry' and a.target_id = 'twilio'
                       and a.reason = 'First set-up: the signed agreement and the provider''s letter'
                       and a.via is null and a.on_behalf_of_id is null and a.request_id is null
                       and a.details = jsonb_build_object('by', 'bootstrap', 'decided_by', pg_temp.id('2', 'a5'), 'revision', 2,
                                                          'was_revision', 1, 'changed', a.details -> 'changed',
                                                          'clearance', current_setting('test.clearance')::uuid)
                       -- Every fact the set-up gave, from Hearth's empty revision 1; not the
                       -- certificate's date, which stayed empty.
                       and (select array_agg(k order by k) from jsonb_object_keys(a.details -> 'changed') k)
                           = array['countries_confirmed', 'data_types', 'dpa_terms_confirmed', 'onward_recipients',
                                   'processing_countries', 'provider_retention', 'retention_confirmed', 'review_on',
                                   'safeguard', 'safeguard_reference', 'services', 'storage_countries', 'training',
                                   'zero_retention']
                       and a.details #> '{changed,services}' = '{"from": null, "to": "Sign-in codes by text message"}'
                       and a.details #> '{changed,processing_countries}' = '{"from": [], "to": ["IE", "US"]}'
                       and a.details #> '{changed,dpa_terms_confirmed}' = '{"from": false, "to": true}'),
                     format('the set-up''s audit row is wrong: %s', array_agg(a.details)))
from public.audit_events a where a.id > current_setting('test.audit_max')::bigint;
select pg_temp.check(count(*) = 1 and bool_and(
                       e.org_id = pg_temp.id('2', '00') and e.type = 'register.transfer_changed' and e.entity_type = 'transfer_entry'
                       and e.entity_id = (select id from public.transfer_register where org_id = pg_temp.id('2', '00') and provider = 'twilio')
                       and e.actor_id = pg_temp.id('2', 'a0') and e.actor_kind = 'system' and e.purpose = 'service_operation'
                       and e.subject_ids = '{}' and e.acl_tokens is null and e.ids = '{"provider": "twilio", "cleared": true}'),
                     'the set-up did not append one register.transfer_changed event, Hearth acting')
from public.outbox_events e where e.id > current_setting('test.outbox_max')::bigint;
select pg_temp.act_as('2', 'a0');
select pg_temp.check(public.transfer_cleared('twilio'), 'twilio does not read as cleared after the set-up');
reset role;
-- Once the DPO withdraws it, the set-up can't clear it again (BSC-03); the DPO can, in the app, and
-- so can the break-glass re-clear (BSC-04).
select pg_temp.act_as('2', 'a5');
select pg_temp.check((select changed from pg_temp.withdraw('twilio')), 'the DPO could not withdraw the set-up''s clearance');
reset role;
select pg_temp.act_as_owner('2', 'a0');
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a5', '{}', 'Again')$$, 'HF006',
                            'That provider has been cleared in this organisation before.%');
reset role;
select pg_temp.act_as('2', 'a5');
select pg_temp.check(cleared and changed, 'the DPO could not clear twilio again in the app') from pg_temp.clear('twilio');
reset role;
-- The plain superuser (as the integration harness runs it) may run it too, in an org made now: its
-- Hearth principal, an Owner, and a DPO the Owner granted.
insert into public.orgs (id, name) values (pg_temp.id('3', '00'), 'A third org');
insert into public.principals (id, org_id, kind, system_key) values (pg_temp.id('3', 'a0'), pg_temp.id('3', '00'), 'system', 'hearth');
insert into public.principals (id, org_id, kind) values (pg_temp.id('3', 'a1'), pg_temp.id('3', '00'), 'human'),
                                                       (pg_temp.id('3', 'a5'), pg_temp.id('3', '00'), 'human');
insert into public.people (id, org_id, full_name, created_by) values
  (pg_temp.id('3', 'a1'), pg_temp.id('3', '00'), 'Olive Owner 3', pg_temp.id('3', 'a0')),
  (pg_temp.id('3', 'a5'), pg_temp.id('3', '00'), 'Dee Pio 3', pg_temp.id('3', 'a0'));
insert into public.role_assignments (org_id, person_id, role, created_by) values
  (pg_temp.id('3', '00'), pg_temp.id('3', 'a1'), 'owner', pg_temp.id('3', 'a0')),
  (pg_temp.id('3', '00'), pg_temp.id('3', 'a5'), 'dpo', pg_temp.id('3', 'a1'));
select set_config('app.org_id', pg_temp.id('3', '00')::text, true), set_config('app.user_id', pg_temp.id('3', 'a0')::text, true);
-- Text given with spaces around it is kept trimmed, as the api keeps the DPO's.
select pg_temp.check(pg_temp.bootstrap('aws', pg_temp.id('3', 'a5'),
                                       E'{"services": " Hosting, CloudWatch logs\\n", "processing_countries": ["SG"], "storage_countries": ["SG"]}',
                                       '  First set-up ') is not null, 'the superuser could not run the set-up');
select pg_temp.check(count(*) = 1 and bool_and(cleared_via = 'bootstrap' and cleared_by = pg_temp.id('3', 'a5')
                                               and facts ->> 'services' = 'Hosting, CloudWatch logs'),
                     'the superuser''s set-up did not clear aws''s trimmed facts in the DPO''s name')
from public.transfer_clearances where org_id = pg_temp.id('3', '00') and provider = 'aws' and withdrawn_at is null;
select pg_temp.check(count(*) = 1 and bool_and(reason = 'First set-up'), 'the set-up''s reason was not kept trimmed')
from public.audit_events where org_id = pg_temp.id('3', '00') and action = 'register.transfer_cleared';
select set_config('app.org_id', '', true), set_config('app.user_id', '', true);

-- BSC-04 (C0.9 OD-20, PD-77 to PD-79): what the break-glass re-clear refuses, writing nothing. In
-- org 2, Twilio was cleared by the set-up (BSC-02) and then in the app; its DPO (a5) now withdraws
-- it, and aws (the fixture's e5). As the owner acting as org 2's Hearth principal, with the
-- emergency marker set and a review date 30 days ahead unless a case says otherwise:
--   - no marker, or a marker of another value: the set-up's refusal (0009's message and order);
--   - the marker for a provider never cleared in the org (org 3's Twilio): refused, so no first
--     clearance is ever an emergency;
--   - aws, cleared before: 0009's message; a review date 91 days ahead;
--   - a person named as the DPO who isn't one, has left, is another org's, or is nobody (42501);
--   - facts left incomplete, or a review date not after today (the clearance's trigger, HF006);
--   - a5 with a live session; Twilio already cleared, with a review date inside the cap.
select pg_temp.act_as('2', 'a5');
select pg_temp.check((select changed from pg_temp.withdraw('twilio')) and (select changed from pg_temp.withdraw('aws')),
                     'org 2''s DPO could not withdraw twilio and aws');
reset role;
select set_config('test.audit_max', (select max(id)::text from public.audit_events), true);
select set_config('test.outbox_max', (select max(id)::text from public.outbox_events), true);
select pg_temp.act_as_owner('2', 'a0');
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a5',
  jsonb_build_object('review_on', pg_temp.today() + 30), 'Again')$$, 'HF006',
  'That provider has been cleared in this organisation before. The DPO clears it again in Hearth.');
select set_config('hearth.break_glass', 'reclear', true);
select pg_temp.expect_error($$select pg_temp.bootstrap('twilio', 'f2000000-0000-4000-8000-0000000000a5',
  jsonb_build_object('review_on', pg_temp.today() + 30), 'Again')$$, 'HF006', 'That provider has been cleared%');
select set_config('hearth.break_glass', '', true);
select pg_temp.expect_error($$select pg_temp.reclear('f2000000-0000-4000-8000-0000000000a5', '{}', 'aws')$$, 'HF006',
                            'That provider has been cleared in this organisation before. The DPO clears it again in Hearth.');
select pg_temp.expect_error($$select pg_temp.reclear('f2000000-0000-4000-8000-0000000000a5',
  jsonb_build_object('review_on', pg_temp.today() + 91))$$, 'HF006',
  'An emergency re-clear sets a review date at most 90 days ahead. The DPO sets a later one in Hearth.');
do $$
declare
  who uuid;
begin
  foreach who in array array[pg_temp.id('2', 'a1'), pg_temp.id('2', 'a9'), pg_temp.id('1', 'a5'), null] loop
    perform pg_temp.expect_error(format($f$select pg_temp.reclear(%L)$f$, who), '42501',
                                 'The person named as the DPO must be at the organisation and hold the DPO role.');
  end loop;
end
$$;
select pg_temp.expect_error($$select pg_temp.reclear('f2000000-0000-4000-8000-0000000000a5', '{"services": null}')$$, 'HF006',
                            'Record the services it provides before clearing it.');
select pg_temp.expect_error($$select pg_temp.reclear('f2000000-0000-4000-8000-0000000000a5', '{"onward_recipients": " \t"}')$$,
                            'HF006', 'Record who it passes the data on to (or None) before clearing it.');
select pg_temp.expect_error($$select pg_temp.reclear('f2000000-0000-4000-8000-0000000000a5',
  jsonb_build_object('review_on', pg_temp.today()))$$, 'HF006', 'Set a review date after today before clearing it.');
select pg_temp.expect_error($$select pg_temp.reclear('f2000000-0000-4000-8000-0000000000a5', '{}', 'twilio', ' ')$$, '22023',
                            'Give the set-up''s reason, from 1 to 2,000 characters.');
reset role;
select pg_temp.act_as_owner('3', 'a0');
select pg_temp.expect_error($$select pg_temp.reclear('f3000000-0000-4000-8000-0000000000a5')$$, 'HF006',
                            'The emergency re-clear restores only a clearance that has ended. Run the set-up without it.');
reset role;
-- a5 with a live session (its account's device and session, added as the superuser), and Twilio
-- already cleared by a5 in the app: each in a savepoint.
do $$
begin
  insert into public.devices (id, org_id, user_id, label) values (pg_temp.id('2', 'e9'), pg_temp.id('2', '00'), pg_temp.id('2', 'a5'), 'DPO phone');
  insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at)
  values (pg_temp.id('2', 'f9'), pg_temp.id('2', '00'), pg_temp.id('2', 'a5'), pg_temp.id('2', 'e9'),
          decode(md5('dpo session') || md5('dpo token'), 'hex'), now() + interval '7 days');
  perform pg_temp.act_as_owner('2', 'a0');
  perform pg_temp.expect_error($f$select pg_temp.reclear('f2000000-0000-4000-8000-0000000000a5')$f$, 'HF006',
                               'A Data Protection Officer is signed in, so they clear Twilio Verify again in Hearth.');
  raise exception 'roll the session back' using errcode = 'HT001';
exception when sqlstate 'HT001' then
  null;
end
$$;
do $$
begin
  perform pg_temp.act_as('2', 'a5');
  perform pg_temp.check((select cleared from pg_temp.clear('twilio')), 'org 2''s DPO could not clear twilio in the app');
  perform pg_temp.act_as_owner('2', 'a0');
  perform pg_temp.expect_error($f$select pg_temp.reclear('f2000000-0000-4000-8000-0000000000a5')$f$, 'HF006',
                               'Twilio Verify is cleared already. The DPO changes its entry in Hearth.');
  raise exception 'roll the clearance back' using errcode = 'HT001';
exception when sqlstate 'HT001' then
  null;
end
$$;
select pg_temp.check(count(*) = 0, 'a refused re-clear wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
select pg_temp.check(count(*) = 0, 'a refused re-clear appended an event')
from public.outbox_events where id > current_setting('test.outbox_max')::bigint;
select pg_temp.check(not exists (select 1 from public.transfer_clearances
                                 where org_id = pg_temp.id('2', '00') and provider in ('twilio', 'aws') and withdrawn_at is null),
                     'a refused re-clear cleared twilio or aws');
-- Its bounds (PD-79): a re-clear that goes ahead leaves its 2 s lock_timeout and 30 s
-- transaction_timeout set for the rest of its transaction (a refused one rolls back with them),
-- replacing a longer transaction_timeout the transaction already runs and keeping a shorter one;
-- the set-up (org 3's twilio, cleared for the first time) never sets them. Each in a savepoint.
-- (That the timer then ends the transaction 30 s after the re-clear, whatever ran before, is
-- Postgres's: switched off and on again, it starts afresh.)
do $$
declare
  lock_was constant text := current_setting('lock_timeout');
  transaction_was constant text := current_setting('transaction_timeout');
begin
  perform pg_temp.check(lock_was <> '2s' and transaction_was <> '30s', 'the test transaction already has the re-clear''s bounds');
  begin
    perform pg_temp.act_as_owner('2', 'a0');
    perform set_config('hearth.break_glass', 'twilio_reclear', true);
    perform pg_temp.bootstrap('twilio', pg_temp.id('2', 'a5'), jsonb_build_object('review_on', pg_temp.today() + 30), 'Bounds');
    perform pg_temp.check(current_setting('lock_timeout') = '2s' and current_setting('transaction_timeout') = '30s',
                          format('the re-clear left lock_timeout %s and transaction_timeout %s',
                                 current_setting('lock_timeout'), current_setting('transaction_timeout')));
    raise exception 'roll the re-clear back' using errcode = 'HT001';
  exception when sqlstate 'HT001' then
    null;
  end;
  perform pg_temp.check(current_setting('lock_timeout') = lock_was and current_setting('transaction_timeout') = transaction_was
                        and current_setting('hearth.break_glass', true) is distinct from 'twilio_reclear',
                        'a rolled-back re-clear left its bounds or its marker set');
  declare
    running text;
  begin
    foreach running in array array['5min', '10s'] loop
      begin
        perform set_config('transaction_timeout', running, true);
        perform pg_temp.act_as_owner('2', 'a0');
        perform set_config('hearth.break_glass', 'twilio_reclear', true);
        perform pg_temp.bootstrap('twilio', pg_temp.id('2', 'a5'), jsonb_build_object('review_on', pg_temp.today() + 30), 'Bounds');
        perform pg_temp.check(current_setting('transaction_timeout') = case running when '5min' then '30s' else '10s' end,
                              format('with %s running, the re-clear left transaction_timeout %s', running,
                                     current_setting('transaction_timeout')));
        raise exception 'roll the re-clear back' using errcode = 'HT001';
      exception when sqlstate 'HT001' then
        null;
      end;
    end loop;
  end;
  begin
    perform pg_temp.act_as_owner('3', 'a0');
    perform pg_temp.bootstrap('twilio', pg_temp.id('3', 'a5'), '{}', 'First set-up of Twilio');
    perform pg_temp.check(current_setting('lock_timeout') = lock_was and current_setting('transaction_timeout') = transaction_was,
                          'the set-up set the re-clear''s bounds');
    raise exception 'roll the set-up back' using errcode = 'HT001';
  exception when sqlstate 'HT001' then
    null;
  end;
end
$$;
-- What isn't a live DPO session, each in a savepoint, after which the re-clear goes ahead: a5's
-- session revoked; expired; on a signed-out device; of a5 once they have left, or once their dpo
-- row is revoked (a second DPO, a6, granted as the superuser, is then the one named); and a live
-- session of someone who isn't a DPO (the fixture's a8, e2, present in every case). Idle time
-- isn't counted. The session on a signed-out device and the DPO who left keep their sessions open
-- only because the superuser arranges them with triggers off (session_replication_role), so the
-- re-clear's own reading, not a trigger's end of the session, is what lets them through.
do $$
declare
  c text;
  named uuid;
begin
  foreach c in array array['revoked', 'expired', 'signed_out_device', 'left', 'role_revoked', 'not_a_dpo'] loop
    begin
      perform pg_temp.check(exists (select 1 from public.sessions where id = pg_temp.id('2', 'e2') and revoked_at is null
                                    and expires_at > now()), 'the fixture''s a8 has no live session');
      named := pg_temp.id('2', 'a5');
      if c <> 'not_a_dpo' then
        insert into public.devices (id, org_id, user_id, label)
        values (pg_temp.id('2', 'e9'), pg_temp.id('2', '00'), pg_temp.id('2', 'a5'), 'DPO phone');
        insert into public.sessions (id, org_id, user_id, device_id, token_hash, created_at, expires_at)
        values (pg_temp.id('2', 'f9'), pg_temp.id('2', '00'), pg_temp.id('2', 'a5'), pg_temp.id('2', 'e9'),
                decode(md5('dpo session ' || c) || md5('dpo token ' || c), 'hex'),
                case c when 'expired' then now() - interval '8 days' else now() end,
                case c when 'expired' then now() - interval '1 day' else now() + interval '7 days' end);
      end if;
      if c = 'revoked' then
        update public.sessions set revoked_at = now(), revoked_by = pg_temp.id('2', 'a5'), revoke_reason = 'sign_out'
        where id = pg_temp.id('2', 'f9');
      elsif c = 'signed_out_device' then
        perform set_config('session_replication_role', 'replica', true);
        update public.devices set signed_out_at = now(), signed_out_by = pg_temp.id('2', 'a5') where id = pg_temp.id('2', 'e9');
        perform set_config('session_replication_role', 'origin', true);
      elsif c in ('left', 'role_revoked') then
        insert into public.role_assignments (org_id, person_id, role, created_by, approved_by, approved_at)
        values (pg_temp.id('2', '00'), pg_temp.id('2', 'a6'), 'dpo', pg_temp.id('2', 'a1'), pg_temp.id('2', 'a2'), now());
        named := pg_temp.id('2', 'a6');
        if c = 'left' then
          perform set_config('session_replication_role', 'replica', true);
          update public.people set deactivated_at = now(), deactivated_by = pg_temp.id('2', 'a1') where id = pg_temp.id('2', 'a5');
          perform set_config('session_replication_role', 'origin', true);
        else
          update public.role_assignments set revoked_at = now(), revoked_by = pg_temp.id('2', 'a1')
          where org_id = pg_temp.id('2', '00') and person_id = pg_temp.id('2', 'a5') and role = 'dpo' and revoked_at is null;
        end if;
      end if;
      if c not in ('expired', 'not_a_dpo') then
        perform pg_temp.check((c = 'revoked') = exists (select 1 from public.sessions where id = pg_temp.id('2', 'f9')
                                                        and revoked_at is not null),
                              format('%s: the arranged session is not as the case needs', c));
      end if;
      perform pg_temp.act_as_owner('2', 'a0');
      perform pg_temp.check(pg_temp.reclear(named) is not null, format('%s: the re-clear was refused', c));
      perform set_config('role', 'none', true);
      perform pg_temp.check((select cleared_via = 'break_glass' and cleared_by = named from public.transfer_clearances
                             where org_id = pg_temp.id('2', '00') and provider = 'twilio' and withdrawn_at is null),
                            format('%s: twilio is not cleared by the re-clear in the named DPO''s name', c));
      raise exception 'roll the case back' using errcode = 'HT001';
    exception when sqlstate 'HT001' then
      null;
    end;
  end loop;
end
$$;

-- BSC-05 (C0.9 OD-20, PD-78, PD-80): a re-clear with no live DPO session clears Twilio in the named
-- DPO's name (cleared_via 'break_glass'), on the facts given. Org 2's registers are made ready (as
-- the superuser), and its DPO records Twilio's facts with a review date 30 days ahead, clears it in
-- the app, publishes version 1 (stating that clearance, on the fixture's contact e6) and withdraws
-- it. With the facts read as the recovery mode reads them, from the snapshot of the Twilio
-- clearance the latest version links, the revision stays and Twilio is cleared for every send.
-- With one stated fact changed (in a savepoint, first) the revision moves on, with Hearth as
-- updated_by, and sends wait for a version that states it (unstated). With no version at all (org
-- 3, in a savepoint) it is no_notice. One audit row (Hearth acting, the reason, the bootstrap's
-- details with the clearance that ended and why) and one register.transfer_changed, Hearth acting.
insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status, basis, retention, providers,
                                        recorded_by)
select c.org_id, c.purpose, c.ai, c.pinned, c.needs_switch, c.version + 1, 'active', 'employment', 'Kept for 12 months',
       c.providers, pg_temp.id('2', 'a5')
from (select distinct on (r.purpose) r.* from public.processing_register r
      where r.org_id = pg_temp.id('2', '00') order by r.purpose, r.version desc) c
where not c.ai and c.status = 'active'
  and (c.basis is null or c.retention is null or c.basis in ('consent', 'deemed_consent_conduct', 'deemed_consent_notification'));
select pg_temp.act_as('2', 'a5');
select pg_temp.check((select changed and not cleared from pg_temp.record('twilio', jsonb_build_object('review_on', pg_temp.today() + 30)))
                     and (select cleared from pg_temp.clear('twilio')),
                     'org 2''s DPO could not record and clear twilio');
select set_config('test.app_clearance', (select id::text from public.transfer_clearances
                                         where org_id = pg_temp.id('2', '00') and provider = 'twilio' and withdrawn_at is null), true);
select set_config('test.v1', p.notice::text, true)
from pg_temp.sources() s,
     public.publish_notice(0, 'Privacy notice', 'c09.2', s.keys, s.versions, s.clearances, 1, 'req-transfers', null, null) p;
select pg_temp.check((select changed from pg_temp.withdraw('twilio')), 'org 2''s DPO could not withdraw twilio');
reset role;
-- The facts the latest version states for Twilio: the snapshot of the clearance it links.
select set_config('test.stated', c.facts::text, true), set_config('test.revision', t.revision::text, true)
from public.notice_version_providers l
join public.transfer_clearances c on c.org_id = l.org_id and c.id = l.clearance_id
join public.transfer_register t on t.org_id = c.org_id and t.id = c.entry_id
where l.notice_version_id = current_setting('test.v1')::uuid and c.provider = 'twilio';
select pg_temp.check(current_setting('test.stated', true) <> '' and current_setting('test.app_clearance', true) <> '',
                     'version 1 does not state twilio''s clearance');
do $$
begin
  perform pg_temp.act_as_owner('2', 'a0');
  perform pg_temp.reclear(pg_temp.id('2', 'a5'),
                          current_setting('test.stated')::jsonb || '{"provider_retention": "Verification records for 60 days"}');
  perform set_config('role', 'none', true);
  perform pg_temp.check(t.revision = current_setting('test.revision')::bigint + 1 and t.updated_by = pg_temp.id('2', 'a0')
                        and t.provider_retention = 'Verification records for 60 days',
                        'a re-clear with a changed fact did not move the revision on, as Hearth''s')
  from public.transfer_register t where t.org_id = pg_temp.id('2', '00') and t.provider = 'twilio';
  perform pg_temp.check(a.details -> 'changed' = '{"provider_retention": {"from": "Verification records for 30 days",
                                                                      "to": "Verification records for 60 days"}}',
                        format('the re-clear''s audit row does not record the changed fact: %s', a.details))
  from public.audit_events a where a.id = (select max(id) from public.audit_events);
  perform pg_temp.act_as('2', 'a0');
  perform pg_temp.check(public.transfer_send_state('twilio') = 'unstated',
                        format('twilio re-cleared on facts version 1 doesn''t state is %s', public.transfer_send_state('twilio')));
  raise exception 'roll the re-clear back' using errcode = 'HT001';
exception when sqlstate 'HT001' then
  null;
end
$$;
select pg_temp.backdate_but('2', 'twilio', current_setting('test.app_clearance')::uuid);
select set_config('test.audit_max', (select max(id)::text from public.audit_events), true);
select set_config('test.outbox_max', (select max(id)::text from public.outbox_events), true);
select pg_temp.act_as_owner('2', 'a0');
select set_config('test.reclear', pg_temp.reclear(pg_temp.id('2', 'a5'), current_setting('test.stated')::jsonb)::text, true);
reset role;
select pg_temp.check(c.cleared_via = 'break_glass' and c.cleared_by = pg_temp.id('2', 'a5') and c.provider = 'twilio'
                     and c.withdrawn_at is null and c.facts = current_setting('test.stated')::jsonb
                     and c.register_revision = current_setting('test.revision')::bigint
                     and t.revision = current_setting('test.revision')::bigint and t.updated_by = pg_temp.id('2', 'a5'),
                     'the re-clear did not clear twilio in a5''s name on the stated facts, keeping the revision')
from public.transfer_clearances c join public.transfer_register t on t.id = c.entry_id
where c.id = current_setting('test.reclear')::uuid;
select pg_temp.check(count(*) = 1 and bool_and(
                       a.org_id = pg_temp.id('2', '00') and a.actor_id = pg_temp.id('2', 'a0') and a.action = 'register.transfer_cleared'
                       and a.target_type = 'transfer_entry' and a.target_id = 'twilio'
                       and a.reason = 'Twilio withdrawn and no DPO signed in'
                       and a.via is null and a.on_behalf_of_id is null and a.request_id is null
                       and a.details = jsonb_build_object('by', 'break_glass', 'decided_by', pg_temp.id('2', 'a5'),
                                                          'revision', current_setting('test.revision')::bigint,
                                                          'was_revision', current_setting('test.revision')::bigint,
                                                          'changed', '{}'::jsonb,
                                                          'clearance', current_setting('test.reclear')::uuid,
                                                          'ended_clearance', current_setting('test.app_clearance')::uuid,
                                                          'ended_reason', 'dpo_decision')),
                     format('the re-clear''s audit row is wrong: %s', array_agg(a.details)))
from public.audit_events a where a.id > current_setting('test.audit_max')::bigint;
select pg_temp.check(count(*) = 1 and bool_and(
                       e.type = 'register.transfer_changed' and e.entity_type = 'transfer_entry'
                       and e.entity_id = (select id from public.transfer_register where org_id = pg_temp.id('2', '00') and provider = 'twilio')
                       and e.actor_id = pg_temp.id('2', 'a0') and e.actor_kind = 'system' and e.purpose = 'service_operation'
                       and e.ids = '{"provider": "twilio", "cleared": true}'),
                     'the re-clear did not append one register.transfer_changed event, Hearth acting')
from public.outbox_events e where e.id > current_setting('test.outbox_max')::bigint;
select pg_temp.act_as('2', 'a0');
select pg_temp.check(public.transfer_send_state('twilio') = 'cleared' and public.transfer_cleared('twilio'),
                     'twilio re-cleared on the facts version 1 states is not cleared');
reset role;
do $$
begin
  perform pg_temp.act_as_owner('3', 'a0');
  perform pg_temp.bootstrap('twilio', pg_temp.id('3', 'a5'), '{}', 'First set-up of Twilio');
  perform pg_temp.act_as('3', 'a5');
  perform pg_temp.check((select changed from pg_temp.withdraw('twilio')), 'org 3''s DPO could not withdraw twilio');
  perform pg_temp.act_as_owner('3', 'a0');
  perform pg_temp.reclear(pg_temp.id('3', 'a5'));
  perform pg_temp.act_as('3', 'a0');
  perform pg_temp.check(public.transfer_send_state('twilio') = 'no_notice',
                        format('twilio re-cleared with no version is %s', public.transfer_send_state('twilio')));
  raise exception 'roll org 3 back' using errcode = 'HT001';
exception when sqlstate 'HT001' then
  null;
end
$$;

-- BSC-06 (C0.9 PD-80): a clearance is the break-glass re-clear's only for Twilio Verify (23514,
-- transfer_clearances_break_glass), and cleared_via is one of the three ways (23514), whoever
-- writes (a superuser's insert, on org 2's aws, whose facts are complete and which no clearance
-- holds open).
select pg_temp.expect_error($$insert into public.transfer_clearances (org_id, entry_id, cleared_by, cleared_via)
  select t.org_id, t.id, 'f2000000-0000-4000-8000-0000000000a5', 'break_glass' from public.transfer_register t
  where t.org_id = 'f2000000-0000-4000-8000-000000000000' and t.provider = 'aws'$$, '23514', '%transfer_clearances_break_glass%');
select pg_temp.expect_error($$insert into public.transfer_clearances (org_id, entry_id, cleared_by, cleared_via)
  select t.org_id, t.id, 'f2000000-0000-4000-8000-0000000000a5', 'elsewhere' from public.transfer_register t
  where t.org_id = 'f2000000-0000-4000-8000-000000000000' and t.provider = 'aws'$$, '23514', '%transfer_clearances_cleared_via%');

-- BSC-07 (C0.9 OD-20): after a re-clear the DPO withdraws it and clears it again in the app as
-- before; after a second withdrawal, a second re-clear still goes ahead with no DPO session, naming
-- the app's clearance as the one that ended. One clearance is open at the end.
select pg_temp.act_as('2', 'a5');
select pg_temp.check((select changed from pg_temp.withdraw('twilio')) and (select cleared and changed from pg_temp.clear('twilio')),
                     'org 2''s DPO could not withdraw the re-clear and clear twilio again in the app');
select set_config('test.app_clearance', (select id::text from public.transfer_clearances
                                         where org_id = pg_temp.id('2', '00') and provider = 'twilio' and withdrawn_at is null
                                           and cleared_via = 'app'), true);
select pg_temp.check((select changed from pg_temp.withdraw('twilio')), 'org 2''s DPO could not withdraw twilio again');
reset role;
select pg_temp.backdate_but('2', 'twilio', current_setting('test.app_clearance')::uuid);
select pg_temp.act_as_owner('2', 'a0');
select set_config('test.reclear', pg_temp.reclear(pg_temp.id('2', 'a5'), current_setting('test.stated')::jsonb,
                                                  'twilio', 'Twilio withdrawn again')::text, true);
reset role;
select pg_temp.check(count(*) filter (where withdrawn_at is null) = 1
                     and bool_and(withdrawn_at is not null or (id = current_setting('test.reclear')::uuid and cleared_via = 'break_glass')),
                     'the second re-clear did not leave exactly one open clearance, its own')
from public.transfer_clearances where org_id = pg_temp.id('2', '00') and provider = 'twilio';
select pg_temp.check(details ->> 'ended_clearance' = current_setting('test.app_clearance')
                     and details ->> 'ended_reason' = 'dpo_decision' and reason = 'Twilio withdrawn again',
                     format('the second re-clear''s audit row is wrong: %s', details))
from public.audit_events where id = (select max(id) from public.audit_events where action = 'register.transfer_cleared');
select pg_temp.check(current_setting('lock_timeout') <> '2s' and current_setting('transaction_timeout') <> '30s'
                     and current_setting('hearth.break_glass', true) is distinct from 'twilio_reclear',
                     'a re-clear''s bounds or marker outlived the helper');
select set_config('app.org_id', '', true), set_config('app.user_id', '', true);
