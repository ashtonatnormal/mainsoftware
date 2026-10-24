-- PDPA-02, PDPA-03, ACC-12, PDPA-10, PDPA-13, ADM-06, TECH-SPEC T22 items 21 to 37 (C0.9 PR 2): the
-- notice (0010). Row level security keeps each org's links, for every role that reads them (NTD-01);
-- no runtime role writes a notice row itself, and the worker reads only its columns (NTD-02); only
-- the DPO who is still at the org publishes (NTD-03); a stale draft is refused, two first publishes
-- included (NTD-04, B-02); each rule is refused in SQL's order, and only for active purposes
-- (NTD-05, PD-38, B-05); versions number from 0 or after a stand-in, and link exactly the sources
-- locked, with one audit row (NTD-06); a version never changes and a stand-in never follows a
-- generated one (NTD-07); acknowledging is the latest version only, once, on the person's own device
-- (NTD-08, PD-42); the transfer gate answers its four states, and transfer_cleared() PR 1's meaning
-- before the first version (NTD-09, PD-41, B-03, B-06); and notice_facts() names the seven stated
-- facts (NTD-10). From 0011 (C0.9 PR 3a) a publish names the DPO's settings version its draft
-- printed: a stale one is refused (NTD-04), and deemed consent by conduct is stated (NTD-05,
-- OD-18); 165 has the contact's own cases. Every case runs as hearth_app (act_as), the owner or the
-- role it tests unless it says it arranges data as the superuser. The facts and the text are made up.
\ir fixtures/two_orgs.sql

-- Today in the transaction's org's time zone.
create function pg_temp.today() returns date language sql as $$
  select (now() at time zone o.time_zone)::date from public.orgs o where o.id = current_setting('app.org_id')::uuid
$$;
-- The sources publish_notice() derives, as the api's draft reads them for the org the transaction
-- set: each active or retired non-AI purpose's key and current version, in key order, and each open
-- non-AI clearance's id.
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
-- The org's latest DPO settings version (0011), as the api's draft reads it; null with none.
create function pg_temp.contact_version() returns integer language sql as $$
  select max(s.version) from public.dpo_settings s where s.org_id = nullif(current_setting('app.org_id', true), '')::uuid
$$;
-- publish_notice with the sources given, from the version the DPO saw, with the request's details
-- (the device a plain id), as the api's route calls it; pg_temp.publish with the current sources.
-- The settings version is the org's latest unless a case names another (PD-66).
create function pg_temp.publish_with(seen integer, keys text[], versions integer[], clearances uuid[],
                                     body text default 'Privacy notice', generator text default 'c09.1',
                                     contact integer default pg_temp.contact_version())
returns table (notice uuid, version integer) language sql as $$
  select * from public.publish_notice(seen, body, generator, keys, versions, clearances, contact, 'req-notice',
                                      'd0000000-0000-4000-8000-0000000000d1', '192.0.2.40')
$$;
create function pg_temp.publish(seen integer, body text default 'Privacy notice', generator text default 'c09.1')
returns table (notice uuid, version integer) language sql as $$
  select p.* from pg_temp.sources() s, pg_temp.publish_with(seen, s.keys, s.versions, s.clearances, body, generator) p
$$;
-- The org's latest version, as hearth_app reads it.
create function pg_temp.latest(out id uuid, out version integer) language sql as $$
  select v.id, v.version from public.notice_versions v
  where v.org_id = current_setting('app.org_id')::uuid order by v.version desc limit 1
$$;
-- The next version of org o's purpose, as the superuser (arranging data, as the DPO would record
-- it): the current one with the given fields changed, recorded by the org's DPO. Returns its number.
create function pg_temp.next_version(o text, p text, changes jsonb) returns integer language plpgsql as $$
declare
  cur public.processing_register%rowtype;
  f jsonb;
begin
  select * into cur from public.processing_register r
  where r.org_id = pg_temp.id(o, '00') and r.purpose = p order by r.version desc limit 1;
  f := to_jsonb(cur) || changes;
  insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status, basis, basis_reference,
                                          opt_out_days, retention, providers, recorded_by)
  values (cur.org_id, p, cur.ai, cur.pinned, cur.needs_switch, cur.version + 1, f ->> 'status', f ->> 'basis',
          f ->> 'basis_reference', (f ->> 'opt_out_days')::integer, f ->> 'retention',
          array(select jsonb_array_elements_text(f -> 'providers')), pg_temp.id(o, 'a5'));
  return cur.version + 1;
end
$$;
-- Org o's registers made ready to publish (as the superuser): every active non-AI purpose with no
-- basis or retention, or on a consent-type basis, gets a version on the employment exception.
create function pg_temp.ready(o text) returns void language plpgsql as $$
declare
  p text;
begin
  for p in
    select c.purpose
    from (select distinct on (r.purpose) r.* from public.processing_register r
          where r.org_id = pg_temp.id(o, '00') order by r.purpose, r.version desc) c
    where not c.ai and c.status = 'active'
      and (c.basis is null or c.retention is null or c.basis in ('consent', 'deemed_consent_conduct', 'deemed_consent_notification'))
  loop
    perform pg_temp.next_version(o, p, '{"basis": "employment", "basis_reference": null, "opt_out_days": null,
                                          "retention": "Kept for 12 months"}');
  end loop;
end
$$;
-- A complete set of a provider's facts, as the DPO's page sends them (as 155 has them).
create function pg_temp.full_facts() returns jsonb language sql as $$
  select jsonb_build_object(
    'services', 'Sign-in codes by text message',
    'data_types', 'The phone number, the channel and the service id',
    'processing_countries', jsonb_build_array('IE', 'US'),
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
-- A provider's facts now (its entry, as the DPO's page shows it), with some changed.
create function pg_temp.facts(p text, changes jsonb default '{}') returns jsonb language sql as $$
  select to_jsonb(t) || changes from public.transfer_register t
  where t.org_id = current_setting('app.org_id')::uuid and t.provider = p
$$;
-- record_transfer_entry with those facts, from the revision the caller can read now ("Save and
-- keep cleared" unless keep is false), and clear_transfer_entry and withdraw_transfer_clearance, as
-- the api's routes call them.
create function pg_temp.record(p text, f jsonb, keep boolean default true)
returns table (entry uuid, revision bigint, cleared boolean, changed boolean) language plpgsql as $$
declare
  seen bigint := (select t.revision from public.transfer_register t
                  where t.org_id = current_setting('app.org_id')::uuid and t.provider = p);
begin
  return query select * from public.record_transfer_entry(p, seen, f ->> 'services', f ->> 'data_types',
    array(select jsonb_array_elements_text(f -> 'processing_countries')),
    array(select jsonb_array_elements_text(f -> 'storage_countries')),
    f ->> 'countries_confirmed', f ->> 'safeguard', f ->> 'safeguard_reference', (f ->> 'certificate_verified_on')::date,
    (f ->> 'dpa_terms_confirmed')::boolean, f ->> 'training', f ->> 'zero_retention', f ->> 'provider_retention',
    f ->> 'retention_confirmed', f ->> 'onward_recipients', (f ->> 'review_on')::date, keep,
    'req-notice', null, '192.0.2.40');
end
$$;
create function pg_temp.clear(p text) returns table (entry uuid, revision bigint, cleared boolean, changed boolean)
language sql as $$
  select * from public.clear_transfer_entry(p, (select t.revision from public.transfer_register t
                                                where t.org_id = current_setting('app.org_id')::uuid and t.provider = p),
                                            'req-notice', null, '192.0.2.40')
$$;
create function pg_temp.withdraw(p text) returns table (entry uuid, revision bigint, cleared boolean, changed boolean)
language sql as $$
  select * from public.withdraw_transfer_clearance(p, 'req-notice', null, '192.0.2.40')
$$;
-- acknowledge_notice with the request's details, as the api's route calls it.
create function pg_temp.ack(notice uuid, device uuid) returns table (version integer, changed boolean) language sql as $$
  select * from public.acknowledge_notice(notice, 'req-ack', device, '192.0.2.41')
$$;

-- A third org with no notice version yet (as the superuser): Hearth, an Owner, the DPO (a5), and a
-- member (a8) with an account and a device (e1). The orgs trigger gives it its register entries.
insert into public.orgs (id, name) values (pg_temp.id('3', '00'), 'A third org');
insert into public.principals (id, org_id, kind, system_key) values (pg_temp.id('3', 'a0'), pg_temp.id('3', '00'), 'system', 'hearth');
insert into public.principals (id, org_id, kind)
select pg_temp.id('3', s), pg_temp.id('3', '00'), 'human' from unnest(array['a1', 'a5', 'a8']) s;
insert into public.people (id, org_id, full_name, created_by)
select pg_temp.id('3', s), pg_temp.id('3', '00'), 'Person ' || s || ' 3', pg_temp.id('3', 'a0') from unnest(array['a1', 'a5', 'a8']) s;
insert into public.role_assignments (org_id, person_id, role, created_by) values
  (pg_temp.id('3', '00'), pg_temp.id('3', 'a1'), 'owner', pg_temp.id('3', 'a0')),
  (pg_temp.id('3', '00'), pg_temp.id('3', 'a5'), 'dpo', pg_temp.id('3', 'a1'));
insert into public.users (id, org_id) values (pg_temp.id('3', 'a8'), pg_temp.id('3', '00'));
insert into public.devices (id, org_id, user_id, label) values (pg_temp.id('3', 'e1'), pg_temp.id('3', '00'), pg_temp.id('3', 'a8'), 'Phone 3');
-- Its DPO's contact (0011), as set_dpo_contact() writes it, so its publishes pass the contact rule.
insert into public.dpo_settings (org_id, version, contact_title, contact_email, recorded_by)
values (pg_temp.id('3', '00'), 1, 'Data Protection Officer', 'dpo-3@fixture.example', pg_temp.id('3', 'a5'));

-- NTD-10 (PD-41, A-01): notice_facts() keeps exactly the seven facts the notice states, from a
-- clearance's snapshot (every fact the DPO records, written confirmations included), a missing one
-- reading as empty; it is immutable, and nobody but the owner runs it (C-03).
select pg_temp.check(
  (select array_agg(k order by k) from jsonb_object_keys(public.notice_facts(c.facts)) k)
    = '{data_types,onward_recipients,processing_countries,provider_retention,services,storage_countries,training}'
  and public.notice_facts(c.facts) = jsonb_build_object(
    'services', c.facts -> 'services', 'data_types', c.facts -> 'data_types',
    'processing_countries', c.facts -> 'processing_countries', 'storage_countries', c.facts -> 'storage_countries',
    'training', c.facts -> 'training', 'provider_retention', c.facts -> 'provider_retention',
    'onward_recipients', c.facts -> 'onward_recipients')
  and cardinality(array(select jsonb_object_keys(c.facts))) = 15,
  format('notice_facts() does not keep exactly the seven stated facts of %s', c.facts))
from public.transfer_clearances c where c.id = pg_temp.id('1', 'e5');
select pg_temp.check(public.notice_facts('{}') = '{"services": null, "data_types": null, "processing_countries": null,
  "storage_countries": null, "training": null, "provider_retention": null, "onward_recipients": null}',
                     'notice_facts() of no facts is not seven empty ones');
select pg_temp.check(provolatile = 'i' and not prosecdef, 'notice_facts() is not an immutable invoker function')
from pg_proc where oid = 'public.notice_facts(jsonb)'::regprocedure;

-- NTD-02 (CLAUDE.md, Database; C0.9 PD-42, PD-66, B-06, C-03): no runtime role (nor hearth_worker)
-- may insert, update, delete, empty, reference or trigger on any of the four notice tables; nobody
-- runs notice_facts(), notice_check_dpo() or the triggers' functions; only hearth_app publishes (by
-- 0011's signature, which names the contact: 0010's is gone, so no contact-blind publisher is
-- left), acknowledges and asks transfer_send_state(); hearth_app and hearth_queue read the stated
-- clearances. (030 and 032 pin each role's whole list.)
do $$
declare
  r text;
  t text;
  p text;
begin
  foreach r in array pg_temp.runtime_roles() || array['hearth_worker'] loop
    foreach t in array array['notice_versions', 'notice_acknowledgments', 'notice_version_purposes', 'notice_version_providers'] loop
      foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        perform pg_temp.check(not has_table_privilege(r, 'public.' || t, p)
                              and (p not in ('INSERT', 'UPDATE', 'REFERENCES') or not has_any_column_privilege(r, 'public.' || t, p)),
                              format('%s holds %s on %s', r, p, t));
      end loop;
    end loop;
    foreach p in array array['public.notice_facts(jsonb)', 'public.notice_check_dpo(uuid,uuid)', 'public.notice_unchanged()',
                             'public.notice_versions_generated()'] loop
      perform pg_temp.check(not has_function_privilege(r, p, 'EXECUTE'), format('%s can run %s', r, p));
    end loop;
    perform pg_temp.check(
      has_function_privilege(r, 'public.publish_notice(integer,text,text,text[],integer[],uuid[],integer,text,uuid,inet)', 'EXECUTE')
        = (r = 'hearth_app')
      and has_function_privilege(r, 'public.acknowledge_notice(uuid,text,uuid,inet)', 'EXECUTE') = (r = 'hearth_app')
      and has_function_privilege(r, 'public.transfer_send_state(text)', 'EXECUTE') = (r = 'hearth_app')
      and has_function_privilege(r, 'public.notice_provider_states()', 'EXECUTE') = (r in ('hearth_app', 'hearth_queue')),
      format('%s runs the wrong notice functions', r));
  end loop;
end
$$;
select pg_temp.check(to_regprocedure('public.publish_notice(integer,text,text,text[],integer[],uuid[],text,uuid,inet)') is null
                     and (select count(*) from pg_proc where proname = 'publish_notice') = 1,
                     '0010''s publish_notice(), which names no contact, is still there');
-- hearth_app's writes are refused outright (42501).
select pg_temp.act_as('1', 'a5');
select pg_temp.expect_error($$insert into public.notice_versions (org_id, version, body, published_by)
  values ('f1000000-0000-4000-8000-000000000000', 1, 'Planted', 'f1000000-0000-4000-8000-0000000000a5')$$, '42501');
select pg_temp.expect_error($$insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'f1000000-0000-4000-8000-0000000000e3',
          'in_app')$$, '42501');
select pg_temp.expect_error($$insert into public.notice_version_purposes (org_id, notice_version_id, purpose, register_version)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000e3', 'backups', 1)$$, '42501');
select pg_temp.expect_error($$insert into public.notice_version_providers (org_id, notice_version_id, clearance_id)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000e3', 'f1000000-0000-4000-8000-0000000000e5')$$,
  '42501');
select pg_temp.expect_error($$update public.notice_versions set body = 'Rewritten'$$, '42501');
select pg_temp.expect_error($$update public.notice_version_purposes set register_version = 2$$, '42501');
select pg_temp.expect_error($$delete from public.notice_version_providers$$, '42501');
select pg_temp.expect_error($$delete from public.notice_versions$$, '42501');
reset role;
-- hearth_queue reads only a version's id, number, org and generator and what it lists, never its
-- text, who published it, an acknowledgement, a version's providers or a clearance's facts.
select pg_temp.act_as_job('1', 'hearth_queue');
select pg_temp.check(count(*) = 1 and bool_and(generator is null and version = 0), 'hearth_queue can''t read the version''s columns')
from (select org_id, id, version, generator from public.notice_versions) v;
select pg_temp.check(count(*) = 1, 'hearth_queue can''t read what the version lists')
from (select org_id, notice_version_id, purpose, register_version from public.notice_version_purposes) l;
select pg_temp.expect_error($$select body from public.notice_versions$$, '42501');
select pg_temp.expect_error($$select published_by from public.notice_versions$$, '42501');
select pg_temp.expect_error($$select count(*) from public.notice_acknowledgments$$, '42501');
select pg_temp.expect_error($$select count(*) from public.notice_version_providers$$, '42501');
select pg_temp.expect_error($$select facts from public.transfer_clearances$$, '42501');
select pg_temp.expect_error($$select public.notice_facts('{}')$$, '42501');
reset role;

-- NTD-01 (ACC-11, C0.9 PD-34, C-03): row level security on both link tables, for each role that
-- reads them: with no org set nothing, and acting in an org only that org's row (the fixture's e3
-- links). hearth_queue can't read notice_version_providers at all (42501).
do $$
declare
  r text;
  t text;
  o text;
  seen bigint;
  other bigint;
begin
  foreach r in array array['hearth_app', 'hearth_queue'] loop
    foreach t in array array['notice_version_purposes', 'notice_version_providers'] loop
      if r = 'hearth_queue' and t = 'notice_version_providers' then
        perform pg_temp.act_as_job('1', r);
        perform pg_temp.expect_error(format('select count(*) from public.%I', t), '42501');
        perform set_config('role', 'none', true);
        continue;
      end if;
      perform set_config('app.org_id', '', true);
      perform set_config('role', r, true);
      execute format('select count(*) from public.%I', t) into seen;
      perform set_config('role', 'none', true);
      perform pg_temp.check(seen = 0, format('%s: %s saw %s row(s) with no org set', t, r, seen));
      foreach o in array array['1', '2'] loop
        if r = 'hearth_app' then
          perform pg_temp.act_as(o, 'a5');
        else
          perform pg_temp.act_as_job(o, r);
        end if;
        execute format('select count(*), count(*) filter (where org_id <> $1) from public.%I', t) into seen, other
          using pg_temp.id(o, '00');
        perform set_config('role', 'none', true);
        perform pg_temp.check(seen = 1 and other = 0, format('%s: acting in org %s, %s saw %s row(s), %s of another org', t, o, r,
                                                             seen, other));
      end loop;
    end loop;
  end loop;
end
$$;

-- NTD-03 (PDPA-02, PDPA-13, ACC-10, C0.9 PD-37, PD-49): only the DPO who is still at the org
-- publishes. Refused (42501): the Owner, an Admin, AI Admin, Leadership, the Compliance Officer, a
-- Team Admin, a Member, a DPO who has left (a9), a former Admin, an agent, an assistant, Hearth
-- itself, another org's DPO, no acting person or no org, a DPO whose role was revoked, and the
-- worker's roles, which can't run it at all. Nothing is written for any of them.
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
do $$
declare
  who text;
begin
  foreach who in array array['a1', 'a2', 'a3', 'a4', 'a6', 'a7', 'a8', 'a9', 'aa', 'ab', 'ac', 'a0'] loop
    perform pg_temp.act_as('1', who);
    perform pg_temp.expect_error($f$select * from pg_temp.publish(0)$f$, '42501', 'Only the Data Protection Officer can publish the notice.');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', pg_temp.id('2', 'a5')::text, true);
set local role hearth_app;
select pg_temp.expect_error($$select * from pg_temp.publish(0)$$, '42501', 'Only the Data Protection Officer can publish the notice.');
select set_config('app.user_id', '', true);
select pg_temp.expect_error($$select * from pg_temp.publish(0)$$, '42501', 'No org or user is set for this transaction');
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a5')::text, true);
select pg_temp.expect_error($$select * from pg_temp.publish_with(0, '{}', '{}', '{}')$$, '42501', 'No org or user is set%');
reset role;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge',
                           'hearth_job_revocation', 'hearth_worker'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error($f$select * from public.publish_notice(0, 'Body', 'c09.1', '{}', '{}', '{}', 1, null, null, null)$f$,
                                 '42501', 'permission denied%');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
update public.role_assignments set revoked_at = now(), revoked_by = pg_temp.id('2', 'a1')
where org_id = pg_temp.id('2', '00') and person_id = pg_temp.id('2', 'a5') and role = 'dpo';
select pg_temp.act_as('2', 'a5');
select pg_temp.expect_error($$select * from pg_temp.publish(0)$$, '42501', 'Only the Data Protection Officer can publish the notice.');
reset role;
select pg_temp.check(count(*) = 0, 'a refused publish wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
select pg_temp.check(count(*) = 2, 'a refused publish added a version') from public.notice_versions
where org_id in (pg_temp.id('1', '00'), pg_temp.id('2', '00'), pg_temp.id('3', '00'));

-- NTD-09, first part (PDPA-10, D46, C0.9 PD-41, PD-59, B-03): the transfer gate before the first
-- generated version. In org 1, whose latest version is a stand-in (e3), aws (cleared, e5) is
-- cleared and twilio (never cleared) not_cleared, as PR 1 answered; in org 3, with no version,
-- twilio is not_cleared and then, once its DPO clears it, no_notice, which transfer_cleared() reads
-- as cleared (PR 1's meaning, OD-01); notice_provider_states() lists each open clearance with
-- whether the latest version states it (e3 lists e5), and a clearance the stand-in doesn't link is
-- cleared all the same.
select pg_temp.act_as('1', 'a0');
select pg_temp.check(public.transfer_send_state('aws') = 'cleared' and public.transfer_cleared('aws')
                     and public.transfer_send_state('twilio') = 'not_cleared' and not public.transfer_cleared('twilio')
                     and public.transfer_send_state('no_such_provider') = 'not_cleared' and public.transfer_send_state(null) = 'not_cleared',
                     'the transfer gate does not answer as PR 1 did under a stand-in');
select pg_temp.check(array_agg(format('%s %s %s', provider, clearance, stated)) = array['aws ' || pg_temp.id('1', 'e5') || ' t'],
                     format('org 1''s stated clearances are %s', array_agg(format('%s %s %s', provider, clearance, stated))))
from public.notice_provider_states();
reset role;
-- Under the stand-in, a provider its links don't name is cleared all the same: the stand-in rule,
-- not the linked facts, answers it (B-03). Org 1's DPO clears twilio, which e3 doesn't link: its
-- sends go, and notice_provider_states() reports it unstated, since the reader applies the stand-in
-- rule itself. Rolled back (HT001), so the cases below see org 1 as the fixture left it.
do $$
begin
  perform pg_temp.act_as('1', 'a5');
  perform pg_temp.check((select changed from pg_temp.record('twilio', pg_temp.full_facts(), false))
                        and (select cleared from pg_temp.clear('twilio')), 'org 1''s DPO could not clear twilio');
  perform pg_temp.act_as('1', 'a0');
  perform pg_temp.check(public.transfer_send_state('twilio') = 'cleared' and public.transfer_cleared('twilio'),
                        'twilio, cleared under a stand-in that doesn''t link it, is not cleared');
  perform pg_temp.check(exists (select 1 from public.notice_provider_states() where provider = 'twilio' and not stated),
                        'org 1''s twilio, which the stand-in doesn''t link, reads as stated');
  raise exception 'roll the clearance back' using errcode = 'HT001';
exception when sqlstate 'HT001' then
  null;
end
$$;
select pg_temp.check(not exists (select 1 from public.transfer_clearances c
                                 where c.org_id = pg_temp.id('1', '00') and c.provider = 'twilio'),
                     'org 1''s twilio clearance outlived its case');
select pg_temp.act_as('3', 'a0');
select pg_temp.check(public.transfer_send_state('twilio') = 'not_cleared' and not public.transfer_cleared('twilio')
                     and not exists (select 1 from public.notice_provider_states()),
                     'org 3''s twilio reads as cleared before any clearance');
reset role;
select pg_temp.act_as('3', 'a5');
select pg_temp.check((select changed from pg_temp.record('twilio', pg_temp.full_facts(), false))
                     and (select cleared from pg_temp.clear('twilio')), 'org 3''s DPO could not clear twilio');
reset role;
select pg_temp.act_as('3', 'a0');
select pg_temp.check(public.transfer_send_state('twilio') = 'no_notice' and public.transfer_cleared('twilio'),
                     'twilio, cleared with no notice version, is not no_notice and cleared');
select pg_temp.check(count(*) = 1 and bool_and(provider = 'twilio' and not stated), 'org 3''s twilio reads as stated with no version')
from public.notice_provider_states();
reset role;
-- NTD-08, first part: with no version at all, there is nothing to acknowledge (22023).
select pg_temp.act_as('3', 'a8');
select pg_temp.expect_error(format($$select * from pg_temp.ack(gen_random_uuid(), %L)$$, pg_temp.id('3', 'e1')), '22023',
                            'There is no such version of the notice.');
reset role;

-- NTD-05 (PDPA-02, C0.9 PD-37, PD-38, B-05): the rules, each HF008 with a message the page can show,
-- in this order, as org 1's DPO from its stand-in (version 0). The fixture's org 1 has four active
-- purposes with no basis yet (version 1: accounts, backups, security_audit, service_operation) and
-- presence_receipts active on consent (version 2). Registers are arranged as the superuser.
select pg_temp.act_as('1', 'a5');
select pg_temp.expect_error($$select * from pg_temp.publish(0)$$, 'HF008',
                            'Record accounts''s legal basis and how long its data is kept before publishing.');
-- A blank body too: the purposes come first.
select pg_temp.expect_error($$select * from pg_temp.publish(0, '')$$, 'HF008', 'Record accounts''s legal basis%');
-- A stale draft is refused before any rule (HF007).
select pg_temp.expect_error($$select * from pg_temp.publish(null)$$, 'HF007',
                            'A newer version was published since you looked. Check the preview again.');
reset role;
select pg_temp.next_version('1', p, '{"basis": "employment", "retention": "Kept for 12 months"}')
from unnest(array['accounts', 'backups', 'security_audit', 'service_operation']) p;
-- Consent and deemed consent by notification (s15A) are each refused. Deemed consent by conduct
-- is stated from 0011 (OD-18, PD-73): on presence_receipts, which needs no switch, it passes the
-- rule, and with every later rule met the version publishes (rolled back, HT001, so the cases below
-- see version 0 as the latest). The publish route holds such a purpose back unless its withdrawal
-- by hand is written down (CONDUCT_WITHDRAWABLE, PD-86), which SQL doesn't repeat.
do $$
declare
  basis jsonb;
begin
  foreach basis in array array['{}'::jsonb,
                               '{"basis": "deemed_consent_notification", "basis_reference": "Assessment 4", "opt_out_days": 30}'] loop
    if basis <> '{}' then
      perform pg_temp.next_version('1', 'presence_receipts', basis);
    end if;
    perform pg_temp.act_as('1', 'a5');
    perform pg_temp.expect_error($f$select * from pg_temp.publish(0)$f$, 'HF008',
                                 'A purpose resting on consent or deemed consent by notification can''t be in the notice yet.');
    perform set_config('role', 'none', true);
  end loop;
  begin
    perform pg_temp.next_version('1', 'presence_receipts',
                                 '{"basis": "deemed_consent_conduct", "basis_reference": null, "opt_out_days": null}');
    perform pg_temp.act_as('1', 'a5');
    perform pg_temp.check((select version from pg_temp.publish(0)) = 1,
                          'a purpose on deemed consent by conduct held publishing back');
    raise exception 'roll the publish back' using errcode = 'HT001';
  exception when sqlstate 'HT001' then
    null;
  end;
end
$$;
select pg_temp.next_version('1', 'presence_receipts',
                            '{"basis": "legitimate_interests", "basis_reference": "Assessment 5", "opt_out_days": null}');
-- An active purpose listing a provider with no open clearance; a retired one, whatever it lists or
-- rests on, is listed with no rule (B-05): content_delivery, retired on consent, listing twilio.
select pg_temp.next_version('1', 'security_audit', '{"providers": ["twilio"]}');
select pg_temp.next_version('1', 'content_delivery',
                            '{"status": "retired", "basis": "consent", "retention": "Deleted 30 days after it ends", "providers": ["twilio"]}');
select pg_temp.act_as('1', 'a5');
select pg_temp.expect_error($$select * from pg_temp.publish(0)$$, 'HF008', 'security_audit lists twilio, which isn''t cleared.');
reset role;
select pg_temp.next_version('1', 'security_audit', '{"providers": ["aws"]}');
-- The body and the generator id: blank (JavaScript's whitespace too), over 100,000 characters, or
-- missing; a generator id that isn't one.
select pg_temp.act_as('1', 'a5');
do $$
declare
  b text;
  g text;
begin
  foreach b in array array['', E' \t\n' || U&'\00A0\3000\FEFF', repeat('x', 100001), null] loop
    perform pg_temp.expect_error(format($f$select * from pg_temp.publish(0, %L)$f$, b), 'HF008',
                                 'A notice needs its text, of at most 100,000 characters.');
  end loop;
  foreach g in array array['', 'C09.1', '-c09', 'c09 1', repeat('a', 33), null] loop
    perform pg_temp.expect_error(format($f$select * from pg_temp.publish(0, 'Privacy notice', %L)$f$, g), 'HF008',
                                 'A notice names the generator that wrote it.');
  end loop;
end
$$;
reset role;
select pg_temp.check(count(*) = 0, 'a refused publish wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint and action like 'notice.%';
select pg_temp.check(count(*) = 2, 'a refused publish added a version') from public.notice_versions
where org_id in (pg_temp.id('1', '00'), pg_temp.id('2', '00'), pg_temp.id('3', '00'));

-- NTD-06 (PDPA-03, ADM-06, C0.9 PD-33, PD-34, PD-66, B-05): org 1 publishes its first generated
-- version, numbered after its stand-in (1). It links exactly the sources it locked: every active and
-- retired non-AI purpose at its current version (content_delivery retired among them; nothing
-- planned), the open clearance e5, and the DPO's settings version it printed (e6's 1). One audit
-- row, ids and numbers only.
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
select pg_temp.act_as('1', 'a5');
select set_config('test.v1', notice::text, true) from pg_temp.publish(0) where version = 1;
select pg_temp.check(current_setting('test.v1', true) <> '', 'org 1''s first generated version is not version 1');
select pg_temp.check((s).keys = '{accounts,backups,content_delivery,presence_receipts,security_audit,service_operation}'
                     and (s).clearances = array[pg_temp.id('1', 'e5')], format('org 1''s sources are %s', s))
from (select pg_temp.sources() s) x;
select pg_temp.check(
  (select array_agg(format('%s:%s', l.purpose, l.register_version) order by l.purpose) from public.notice_version_purposes l
   where l.notice_version_id = current_setting('test.v1')::uuid)
  = (select array_agg(format('%s:%s', k, v) order by k) from unnest((s).keys, (s).versions) as x (k, v))
  and (select array_agg(l.clearance_id) from public.notice_version_providers l where l.notice_version_id = current_setting('test.v1')::uuid)
      = (s).clearances,
  'version 1 does not link exactly the sources')
from (select pg_temp.sources() s) x;
reset role;
select pg_temp.check(v.org_id = pg_temp.id('1', '00') and v.version = 1 and v.body = 'Privacy notice' and v.generator = 'c09.1'
                     and v.published_by = pg_temp.id('1', 'a5') and v.published_at = now() and v.dpo_settings_version = 1,
                     'version 1 was not stored as published, linking the contact it printed (e6, settings version 1)')
from public.notice_versions v where v.id = current_setting('test.v1')::uuid;
select pg_temp.check(count(*) = 1 and bool_and(
                       a.org_id = pg_temp.id('1', '00') and a.actor_id = pg_temp.id('1', 'a5') and a.action = 'notice.publish'
                       and a.target_type = 'notice_version' and a.target_id = current_setting('test.v1')
                       and a.request_id = 'req-notice' and a.device_id = 'd0000000-0000-4000-8000-0000000000d1'
                       and a.ip = '192.0.2.40' and a.reason is null and a.via is null and a.on_behalf_of_id is null
                       and a.details = jsonb_build_object(
                         'version', 1, 'was_version', 0, 'generator', 'c09.1',
                         'purposes', (select jsonb_object_agg(l.purpose, l.register_version) from public.notice_version_purposes l
                                      where l.notice_version_id = current_setting('test.v1')::uuid),
                         'clearances', jsonb_build_object('aws', pg_temp.id('1', 'e5')), 'contact_version', 1)),
                     format('the publish''s audit row is wrong: %s', array_agg(a.details)))
from public.audit_events a where a.id > current_setting('test.audit_max')::bigint;
-- Org 3 publishes its first version, numbered 0 (with no version before it), stating twilio.
select pg_temp.ready('3');
select pg_temp.act_as('3', 'a5');
select set_config('test.v3_0', notice::text, true) from pg_temp.publish(null) where version = 0;
select pg_temp.check(current_setting('test.v3_0', true) <> '', 'org 3''s first version is not version 0');
select pg_temp.check(
  (select array_agg(format('%s:%s', l.purpose, l.register_version) order by l.purpose) from public.notice_version_purposes l
   where l.notice_version_id = current_setting('test.v3_0')::uuid) = '{accounts:2,backups:2,security_audit:2,service_operation:2}'
  and (select array_agg(l.clearance_id) from public.notice_version_providers l where l.notice_version_id = current_setting('test.v3_0')::uuid)
      = (pg_temp.sources()).clearances,
  'org 3''s version 0 does not link exactly its sources');
reset role;
select pg_temp.check((a.details ->> 'version')::int = 0 and a.details -> 'was_version' = 'null'
                     and (a.details #>> '{clearances,twilio}')::uuid = (select id from public.transfer_clearances
                                                                        where org_id = pg_temp.id('3', '00') and withdrawn_at is null),
                     format('org 3''s publish audit row is wrong: %s', a.details))
from public.audit_events a where a.org_id = pg_temp.id('3', '00') and a.action = 'notice.publish';

-- NTD-04 (C0.9 PD-37, PD-52, PD-66, B-02): what the DPO saw is stale (HF007): a version that isn't
-- the latest, or none when one exists; sources other than those locked, purposes or clearances, in
-- any way; and a settings version other than the latest. The same sources in another order pass. Two first publishes: the second finds the first's
-- version (HF007), never a constraint's error (the concurrent orders run in check-concurrency, NTR-04).
select pg_temp.act_as('1', 'a5');
select pg_temp.expect_error($$select * from pg_temp.publish(0, 'Another body')$$, 'HF007', 'A newer version was published since you looked.%');
select pg_temp.expect_error($$select * from pg_temp.publish(null, 'Another body')$$, 'HF007', 'A newer version%');
select pg_temp.expect_error($$select * from pg_temp.publish(2, 'Another body')$$, 'HF007', 'A newer version%');
do $$
declare
  s record;
  c record;
begin
  s := pg_temp.sources();
  for c in
    select * from (values
      ('a purpose left out', s.keys[2:], s.versions[2:], s.clearances),
      ('an older register version', s.keys, array[s.versions[1] - 1] || s.versions[2:], s.clearances),
      ('a planned purpose added', s.keys || 'access_logs'::text, s.versions || 1, s.clearances),
      ('a purpose twice', s.keys || s.keys[1], s.versions || s.versions[1], s.clearances),
      ('keys and versions of different lengths', s.keys, s.versions[2:], s.clearances),
      ('no purposes', null::text[], null::integer[], s.clearances),
      ('no clearances', s.keys, s.versions, '{}'::uuid[]),
      ('no clearances (null)', s.keys, s.versions, null::uuid[]),
      ('another clearance', s.keys, s.versions, s.clearances || gen_random_uuid()),
      ('a clearance twice', s.keys, s.versions, s.clearances || s.clearances)
    ) as v (what, keys, versions, clearances)
  loop
    begin
      perform pg_temp.expect_error(format($f$select * from pg_temp.publish_with(1, %L, %L, %L, 'Another body')$f$,
                                          c.keys, c.versions, c.clearances), 'HF007',
                                   'The registers changed since this notice was prepared. Check the preview again, then publish.');
    exception when others then
      raise exception '%: %', c.what, sqlerrm;
    end;
  end loop;
  -- The DPO's settings version (0011, PD-66): one that isn't the latest, none while one is
  -- recorded, or one that doesn't exist, is stale too, with its own message, after the registers'.
  perform pg_temp.expect_error(format($f$select * from pg_temp.publish_with(1, %L, %L, %L, 'Another body', 'c09.1', %s)$f$,
                                      s.keys, s.versions, s.clearances, stale.v), 'HF007',
                               'The Data Protection Officer''s contact changed since this notice was prepared. Check the preview again, then publish.')
  from (values ('null'), ('0'), ('2')) as stale (v);
  perform pg_temp.expect_error(format($f$select * from pg_temp.publish_with(1, %L, %L, %L, 'Another body', 'c09.1', null)$f$,
                                      s.keys[2:], s.versions[2:], s.clearances), 'HF007', 'The registers changed since%');
  perform pg_temp.check((select version from pg_temp.publish_with(1, array(select k from unnest(s.keys) k order by k desc),
                                                                   array(select v from unnest(s.versions) with ordinality as x (v, n) order by n desc),
                                                                   s.clearances, 'Another body')) = 2,
                        'the same sources in another order were refused');
end
$$;
reset role;
select pg_temp.act_as('3', 'a5');
select pg_temp.expect_error($$select * from pg_temp.publish(null, 'Another body')$$, 'HF007', 'A newer version was published since you looked.%');
reset role;

-- NTD-05, continued: a draft identical to the latest version (the same generator, body and sources)
-- is refused (HF008); the same body from another generator, or after the sources moved, isn't (the
-- api warns same_text). A body of exactly 100,000 characters publishes.
select pg_temp.act_as('1', 'a5');
select pg_temp.expect_error($$select * from pg_temp.publish(2, 'Another body')$$, 'HF008', 'The published notice already says this.');
select pg_temp.check(version = 3, 'the same body from another generator was refused') from pg_temp.publish(2, 'Another body', 'c09.2');
select pg_temp.expect_error($$select * from pg_temp.publish(3, 'Another body', 'c09.2')$$, 'HF008', 'The published notice already says this.');
reset role;
select pg_temp.next_version('1', 'backups', '{"retention": "Kept for 35 days"}');
select pg_temp.act_as('1', 'a5');
select pg_temp.check(version = 4, 'the same body after the sources moved was refused') from pg_temp.publish(3, 'Another body', 'c09.2');
select pg_temp.check(version = 5, 'a body of 100,000 characters was refused') from pg_temp.publish(4, repeat('x', 100000));
reset role;

-- NTD-07 (PDPA-03, C0.9 PD-33, PD-41): a published version and what it lists never change, for the
-- superuser and the owner alike (23514); a stand-in can't follow a generated version, though one can
-- follow a stand-in (org 2); the generator id keeps its form.
do $$
declare
  stmt text;
begin
  foreach stmt in array array[
    $s$update public.notice_versions set body = 'Rewritten' where org_id = 'f1000000-0000-4000-8000-000000000000'$s$,
    $s$update public.notice_versions set generator = null where id = 'f1000000-0000-4000-8000-0000000000e3'$s$,
    $s$update public.notice_versions set published_at = now() where org_id = 'f2000000-0000-4000-8000-000000000000'$s$,
    $s$update public.notice_version_purposes set register_version = register_version$s$,
    $s$update public.notice_version_providers set clearance_id = clearance_id$s$] loop
    perform pg_temp.expect_error(stmt, '23514', 'A published notice never changes. Publish a new version instead.');
    perform set_config('role', 'hearth_owner', true);
    perform pg_temp.expect_error(stmt, '23514', 'A published notice never changes. Publish a new version instead.');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
select pg_temp.expect_error($$insert into public.notice_versions (org_id, version, body, published_by)
  values ('f1000000-0000-4000-8000-000000000000', 6, 'A stand-in', 'f1000000-0000-4000-8000-0000000000a5')$$, '23514',
  'A notice Hearth didn''t generate can''t follow one it did.');
set local role hearth_owner;
select pg_temp.expect_error($$insert into public.notice_versions (org_id, version, body, published_by)
  values ('f1000000-0000-4000-8000-000000000000', 6, 'A stand-in', 'f1000000-0000-4000-8000-0000000000a5')$$, '23514',
  'A notice Hearth didn''t generate can''t follow one it did.');
reset role;
select pg_temp.expect_error($$insert into public.notice_versions (org_id, version, body, published_by, generator)
  values ('f1000000-0000-4000-8000-000000000000', 6, 'Planted', 'f1000000-0000-4000-8000-0000000000a5', 'C09')$$, '23514',
  '%notice_versions_generator%');
insert into public.notice_versions (org_id, version, body, published_by)
values (pg_temp.id('2', '00'), 1, 'A second stand-in', pg_temp.id('2', 'a5'));
delete from public.notice_versions where org_id = pg_temp.id('2', '00') and version = 1;

-- NTD-08 (ACC-12, PDPA-03, ADM-06, C0.9 PD-42): acknowledging. Only the latest version (HF007 for an
-- older one); once (a second call, or one the DPO recorded, writes nothing and returns changed
-- false); one audit row; on the person's own device, not signed out (42501); only someone still at
-- the org (42501); an id that isn't one of the org's versions (22023); with no org or user set
-- (42501); never the worker's roles. A stand-in is acknowledged like any version (org 2).
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
select pg_temp.act_as('1', 'a8');
select set_config('test.latest', (pg_temp.latest()).id::text, true);
select pg_temp.expect_error(format($$select * from pg_temp.ack(%L, %L)$$, pg_temp.id('1', 'e3'), pg_temp.id('1', 'e1')), 'HF007',
                            'A newer version of the notice was published. Read it, then acknowledge it.');
select pg_temp.expect_error(format($$select * from pg_temp.ack(%L, %L)$$, current_setting('test.v1'), pg_temp.id('1', 'e1')), 'HF007');
select pg_temp.check(version = 5 and changed, 'a8 could not acknowledge the latest version')
from pg_temp.ack(current_setting('test.latest')::uuid, pg_temp.id('1', 'e1'));
select pg_temp.check(version = 5 and not changed, 'acknowledging again changed something')
from pg_temp.ack(current_setting('test.latest')::uuid, pg_temp.id('1', 'e1'));
reset role;
select pg_temp.check(count(*) = 1 and bool_and(method = 'in_app' and device_id = pg_temp.id('1', 'e1') and recorded_by is null
                                               and acknowledged_at = now()),
                     'a8''s acknowledgement was not recorded once, in the app, on e1')
from public.notice_acknowledgments where person_id = pg_temp.id('1', 'a8') and notice_version_id = current_setting('test.latest')::uuid;
select pg_temp.check(count(*) = 1 and bool_and(
                       a.actor_id = pg_temp.id('1', 'a8') and a.action = 'notice.acknowledge' and a.target_type = 'person'
                       and a.target_id = pg_temp.id('1', 'a8')::text and a.request_id = 'req-ack' and a.device_id = pg_temp.id('1', 'e1')
                       and a.ip = '192.0.2.41'
                       and a.details = jsonb_build_object('notice', current_setting('test.latest')::uuid, 'version', 5)),
                     format('expected one notice.acknowledge row, got %s', array_agg(a.details)))
from public.audit_events a where a.id > current_setting('test.audit_max')::bigint;
-- a7 (as the superuser: a device of their own, e8, and the DPO's record of their acknowledgement).
insert into public.devices (id, org_id, user_id, label) values (pg_temp.id('1', 'e8'), pg_temp.id('1', '00'), pg_temp.id('1', 'a7'), 'Phone');
insert into public.notice_acknowledgments (org_id, person_id, notice_version_id, method, recorded_by)
values (pg_temp.id('1', '00'), pg_temp.id('1', 'a7'), current_setting('test.latest')::uuid, 'recorded_by_dpo', pg_temp.id('1', 'a5'));
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
select pg_temp.act_as('1', 'a7');
select pg_temp.check(version = 5 and not changed, 'acknowledging a version the DPO recorded changed something')
from pg_temp.ack(current_setting('test.latest')::uuid, pg_temp.id('1', 'e8'));
select pg_temp.expect_error(format($$select * from pg_temp.ack(%L, %L)$$, current_setting('test.latest'), pg_temp.id('1', 'e1')), '42501',
                            'That device has been signed out.');
select pg_temp.expect_error(format($$select * from pg_temp.ack(%L, null)$$, current_setting('test.latest')), '42501',
                            'That device has been signed out.');
select pg_temp.expect_error(format($$select * from pg_temp.ack(%L, %L)$$, gen_random_uuid(), pg_temp.id('1', 'e8')), '22023',
                            'There is no such version of the notice.');
select pg_temp.expect_error(format($$select * from pg_temp.ack(%L, %L)$$, pg_temp.id('2', 'e3'), pg_temp.id('1', 'e8')), '22023');
select pg_temp.expect_error(format($$select * from pg_temp.ack(null, %L)$$, pg_temp.id('1', 'e8')), '22023');
reset role;
update public.devices set signed_out_at = now(), signed_out_by = pg_temp.id('1', 'a7') where id = pg_temp.id('1', 'e8');
select pg_temp.act_as('1', 'a7');
select pg_temp.expect_error(format($$select * from pg_temp.ack(%L, %L)$$, current_setting('test.latest'), pg_temp.id('1', 'e8')), '42501',
                            'That device has been signed out.');
reset role;
do $$
declare
  who text;
begin
  foreach who in array array['a9', 'ab', 'ac', 'a0'] loop
    perform pg_temp.act_as('1', who);
    perform pg_temp.expect_error(format($f$select * from pg_temp.ack(%L, %L)$f$, current_setting('test.latest'), pg_temp.id('1', 'e1')),
                                 '42501', 'Only someone still at the organisation can acknowledge its notice.');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', '', true);
set local role hearth_app;
select pg_temp.expect_error(format($$select * from pg_temp.ack(%L, %L)$$, current_setting('test.latest'), pg_temp.id('1', 'e1')), '42501',
                            'No org or user is set for this transaction');
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a8')::text, true);
select pg_temp.expect_error(format($$select * from pg_temp.ack(%L, %L)$$, current_setting('test.latest'), pg_temp.id('1', 'e1')), '42501',
                            'No org or user is set%');
reset role;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge',
                           'hearth_job_revocation', 'hearth_worker'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error(format($f$select * from public.acknowledge_notice(%L, null, %L, null)$f$,
                                        current_setting('test.latest'), pg_temp.id('1', 'e1')), '42501', 'permission denied%');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
select pg_temp.check(count(*) = 0, 'a refused or repeated acknowledgement wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
-- A stand-in is the latest in org 2: a8 acknowledged it (the fixture), a7 (with a device of their
-- own) now does.
insert into public.devices (id, org_id, user_id, label) values (pg_temp.id('2', 'e8'), pg_temp.id('2', '00'), pg_temp.id('2', 'a7'), 'Phone');
select pg_temp.act_as('2', 'a8');
select pg_temp.check(version = 0 and not changed, 'a8''s acknowledgement of org 2''s stand-in was not found')
from pg_temp.ack(pg_temp.id('2', 'e3'), pg_temp.id('2', 'e1'));
reset role;
select pg_temp.act_as('2', 'a7');
select pg_temp.check(version = 0 and changed, 'a7 could not acknowledge org 2''s stand-in') from pg_temp.ack(pg_temp.id('2', 'e3'), pg_temp.id('2', 'e8'));
reset role;
-- A new version needs acknowledging again (PDPA-03): org 3's a8 acknowledges version 0, its DPO
-- publishes version 1, and version 0 is then refused (HF007) and version 1 recorded.
select pg_temp.act_as('3', 'a8');
select pg_temp.check(version = 0 and changed, 'org 3''s a8 could not acknowledge version 0')
from pg_temp.ack(current_setting('test.v3_0')::uuid, pg_temp.id('3', 'e1'));
reset role;
select pg_temp.act_as('3', 'a5');
select set_config('test.v3_1', notice::text, true) from pg_temp.publish(0, 'Second notice') where version = 1;
reset role;
select pg_temp.act_as('3', 'a8');
select pg_temp.expect_error(format($$select * from pg_temp.ack(%L, %L)$$, current_setting('test.v3_0'), pg_temp.id('3', 'e1')), 'HF007');
select pg_temp.check(version = 1 and changed, 'org 3''s a8 could not acknowledge version 1')
from pg_temp.ack(current_setting('test.v3_1')::uuid, pg_temp.id('3', 'e1'));
reset role;

-- NTD-09, second part (PDPA-10, D46, C0.9 PD-41, PD-59, B-03, B-06): once a generated version is the
-- latest, a provider is cleared only while that version states its open clearance's notice facts.
-- Org 3's version 1 states twilio: cleared. "Save and keep cleared" with only a review date, a
-- safeguard, a zero-retention result or a written confirmation changed keeps it cleared; changing
-- any of the seven stated facts makes it unstated (transfer_cleared() false) until the facts are
-- back as stated, or a new version states them; a withdrawal is not_cleared, and clearing again on
-- the same facts is cleared; a provider cleared after the publish is unstated. notice_provider_states()
-- agrees, for hearth_app and hearth_queue alike, also in a read-only transaction, and lists nothing
-- with no org set; transfer_send_state() needs an org (42501), can't run read-only (25006), and the
-- worker's roles can't run it.
select pg_temp.act_as('3', 'a0');
select pg_temp.check(public.transfer_send_state('twilio') = 'cleared' and public.transfer_cleared('twilio'),
                     'twilio, stated by org 3''s version 1, is not cleared');
select pg_temp.check(count(*) = 1 and bool_and(provider = 'twilio' and stated), 'org 3''s twilio does not read as stated')
from public.notice_provider_states();
reset role;
select pg_temp.act_as('3', 'a5');
do $$
declare
  c record;
  state text;
begin
  for c in
    select * from (values
      ('review_on', jsonb_build_object('review_on', pg_temp.today() + 200), 'cleared'),
      ('safeguard', '{"safeguard": "dpa"}'::jsonb, 'cleared'),
      ('safeguard_reference', '{"safeguard_reference": "Another copy of the agreement"}', 'cleared'),
      ('countries_confirmed', '{"countries_confirmed": "A letter, schedule 3"}', 'cleared'),
      ('retention_confirmed', '{"retention_confirmed": "Another letter"}', 'cleared'),
      ('zero_retention', '{"zero_retention": "not_applicable"}', 'cleared'),
      ('services', '{"services": "Sign-in codes by text message and voice"}', 'unstated'),
      ('data_types', '{"data_types": "The phone number"}', 'unstated'),
      ('processing_countries', '{"processing_countries": ["US"]}', 'unstated'),
      ('storage_countries', '{"storage_countries": ["IE", "US"]}', 'unstated'),
      ('training', '{"training": "not_applicable"}', 'unstated'),
      ('provider_retention', '{"provider_retention": "Verification records for 90 days"}', 'unstated'),
      ('onward_recipients', '{"onward_recipients": "Mobile carriers and a backup provider"}', 'unstated')
    ) as v (fact, changes, expected)
  loop
    perform pg_temp.check((select cleared and changed from pg_temp.record('twilio', pg_temp.full_facts() || c.changes)),
                          format('saving twilio with %s changed did not keep it cleared', c.fact));
    state := public.transfer_send_state('twilio');
    perform pg_temp.check(state = c.expected and public.transfer_cleared('twilio') = (c.expected = 'cleared')
                          and (select bool_and(stated = (c.expected = 'cleared')) from public.notice_provider_states()),
                          format('with %s changed, twilio is %s, not %s', c.fact, state, c.expected));
    -- Back to the facts as recorded first, which version 1 states.
    perform pg_temp.check((select cleared and changed from pg_temp.record('twilio', pg_temp.full_facts())),
                          format('saving twilio back after %s did not keep it cleared', c.fact));
    perform pg_temp.check(public.transfer_send_state('twilio') = 'cleared', format('with %s back as stated, twilio is not cleared', c.fact));
  end loop;
end
$$;
select pg_temp.check((select changed and not cleared from pg_temp.withdraw('twilio')), 'org 3''s DPO could not withdraw twilio');
select pg_temp.check(public.transfer_send_state('twilio') = 'not_cleared' and not public.transfer_cleared('twilio')
                     and not exists (select 1 from public.notice_provider_states()),
                     'twilio withdrawn is not not_cleared');
select pg_temp.check((select cleared and changed from pg_temp.clear('twilio')), 'org 3''s DPO could not clear twilio again');
select pg_temp.check(public.transfer_send_state('twilio') = 'cleared' and public.transfer_cleared('twilio'),
                     'twilio cleared again on the facts version 1 states is not cleared');
-- A stated fact changed, and livekit cleared after the publish: unstated, until version 2 states both.
select pg_temp.check((select cleared from pg_temp.record('twilio', pg_temp.full_facts() || '{"onward_recipients": "None"}'))
                     and (select changed from pg_temp.record('livekit', pg_temp.full_facts() || '{"services": "Calls"}', false))
                     and (select cleared from pg_temp.clear('livekit')),
                     'org 3''s DPO could not change twilio and clear livekit');
select pg_temp.check(public.transfer_send_state('twilio') = 'unstated' and not public.transfer_cleared('twilio')
                     and public.transfer_send_state('livekit') = 'unstated' and not public.transfer_cleared('livekit'),
                     'a changed fact or a provider cleared after the publish is not unstated');
select pg_temp.check(array_agg(format('%s %s', provider, stated) order by provider) = '{"livekit f","twilio f"}',
                     format('org 3''s stated clearances are %s', array_agg(format('%s %s', provider, stated))))
from public.notice_provider_states();
select pg_temp.check(version = 2, 'org 3''s DPO could not publish version 2') from pg_temp.publish(1, 'Third notice');
select pg_temp.check(public.transfer_send_state('twilio') = 'cleared' and public.transfer_send_state('livekit') = 'cleared'
                     and (select bool_and(stated) and count(*) = 2 from public.notice_provider_states()),
                     'version 2 does not state twilio''s new facts and livekit');
reset role;
-- The worker's role reads the same, with no lock, in a read-only transaction; with no org set,
-- nothing.
select pg_temp.act_as('3', 'a0');
select set_config('test.states', (select string_agg(format('%s %s %s', provider, clearance, stated), ',' order by provider)
                                  from public.notice_provider_states()), true);
reset role;
select pg_temp.act_as_job('3', 'hearth_queue');
do $$
begin
  begin
    perform set_config('transaction_read_only', 'on', true);
    perform pg_temp.check((select string_agg(format('%s %s %s', provider, clearance, stated), ',' order by provider)
                           from public.notice_provider_states()) = current_setting('test.states'),
                          'hearth_queue reads other stated clearances, read-only');
    raise exception 'done' using errcode = 'HT001';
  exception when sqlstate 'HT001' then
    null;
  end;
end
$$;
select set_config('app.org_id', '', true);
select pg_temp.check(not exists (select 1 from public.notice_provider_states()), 'notice_provider_states() lists rows with no org set');
reset role;
select pg_temp.act_as('3', 'a0');
do $$
begin
  begin
    perform set_config('transaction_read_only', 'on', true);
    perform public.transfer_send_state('twilio');
    raise exception 'transfer_send_state ran in a read-only transaction';
  exception when read_only_sql_transaction then
    null;
  end;
end
$$;
select set_config('app.org_id', '', true);
select pg_temp.expect_error($$select public.transfer_send_state('twilio')$$, '42501', 'No org is set for this transaction');
select pg_temp.expect_error($$select public.transfer_cleared('twilio')$$, '42501', 'No org is set for this transaction');
reset role;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge',
                           'hearth_job_revocation', 'hearth_worker'] loop
    perform pg_temp.act_as_job('3', r);
    perform pg_temp.expect_error($f$select public.transfer_send_state('twilio')$f$, '42501', 'permission denied%');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
-- transfer_cleared() kept its signature, its owner and its definer rights (0009's grant stays: 030).
select pg_temp.check(prosecdef and proowner = 'hearth_owner'::regrole and prorettype = 'boolean'::regtype
                     and cardinality(proconfig) = 1 and proconfig[1] = 'search_path=""',
                     'transfer_cleared() changed its definition''s shape')
from pg_proc where oid = 'public.transfer_cleared(text)'::regprocedure;
select set_config('app.org_id', '', true), set_config('app.user_id', '', true);
