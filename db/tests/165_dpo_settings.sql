-- PDPA-13, PDPA-02, ACC-11, ADM-06, TECH-SPEC T22 items 39 and 40 (C0.9 PR 3a, OD-10, OD-11): the
-- DPO's business contact (0011). Row level security keeps each org's versions, and no job role
-- reads them (DCD-01); hearth_app only reads it and records it through set_dpo_contact() (DCD-02);
-- only the DPO who is still at the org records (DCD-03); versions number from 1, a stale edit is
-- refused, the same contact again writes nothing, text is trimmed and one audit row names the
-- fields that changed (DCD-04, PD-63); each rule is refused in contactProblems()'s order (DCD-05,
-- PD-64), and the table's checks back them (DCD-06); a version never changes (DCD-07); a publish
-- needs a contact, names the one its draft printed and links the one it locked (DCD-08, PD-66,
-- PD-67), never another org's (DCD-09); and a version 0010 published, which printed no contact, is
-- followed by one that does (DCD-10). Every case runs as hearth_app (act_as), the owner or the role
-- it tests unless it says it arranges data as the superuser. The contacts are made up, on .example.
\ir fixtures/two_orgs.sql

-- Today in the transaction's org's time zone.
create function pg_temp.today() returns date language sql as $$
  select (now() at time zone o.time_zone)::date from public.orgs o where o.id = current_setting('app.org_id')::uuid
$$;
-- set_dpo_contact with the request's details (the device a plain id), as the api's route calls it.
create function pg_temp.contact(seen integer, title text, email text, phone text default null, postal text default null)
returns table (version integer, changed boolean) language sql as $$
  select * from public.set_dpo_contact(seen, title, email, phone, postal, 'req-contact',
                                       'd0000000-0000-4000-8000-0000000000d2', '192.0.2.50')
$$;
-- The org's latest settings version, as the api's draft reads it; null with none.
create function pg_temp.contact_version() returns integer language sql as $$
  select max(s.version) from public.dpo_settings s where s.org_id = nullif(current_setting('app.org_id', true), '')::uuid
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
-- publish_notice with the current sources and the settings version given (the latest unless a
-- case names another), as the api's route calls it.
create function pg_temp.publish(seen integer, body text default 'Privacy notice', contact integer default pg_temp.contact_version())
returns table (notice uuid, version integer) language sql as $$
  select p.* from pg_temp.sources() s,
    public.publish_notice(seen, body, 'c09.2', s.keys, s.versions, s.clearances, contact, 'req-contact',
                          'd0000000-0000-4000-8000-0000000000d2', '192.0.2.50') p
$$;
-- Org o's registers made ready to publish (as the superuser, as 160's ready() does): every active
-- non-AI purpose with no basis or retention, or on a consent-type basis, gets a version on the
-- employment exception, recorded by the org's DPO.
create function pg_temp.ready(o text) returns void language plpgsql as $$
declare
  cur public.processing_register%rowtype;
begin
  for cur in
    select c.*
    from (select distinct on (r.purpose) r.* from public.processing_register r
          where r.org_id = pg_temp.id(o, '00') order by r.purpose, r.version desc) c
    where not c.ai and c.status = 'active'
      and (c.basis is null or c.retention is null or c.basis in ('consent', 'deemed_consent_conduct', 'deemed_consent_notification'))
  loop
    insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status, basis, retention,
                                            providers, recorded_by)
    values (cur.org_id, cur.purpose, cur.ai, cur.pinned, cur.needs_switch, cur.version + 1, 'active', 'employment',
            'Kept for 12 months', cur.providers, pg_temp.id(o, 'a5'));
  end loop;
end
$$;
-- A small org with no contact (as the superuser): Hearth, an Owner (a1), the DPO (a5) and a member
-- (a8) with an account and a device (e1). The orgs trigger gives it its register entries.
create function pg_temp.small_org(o text) returns void language plpgsql as $$
declare
  org uuid := pg_temp.id(o, '00');
begin
  insert into public.orgs (id, name) values (org, 'Contact org ' || o);
  insert into public.principals (id, org_id, kind, system_key) values (pg_temp.id(o, 'a0'), org, 'system', 'hearth');
  insert into public.principals (id, org_id, kind) select pg_temp.id(o, s), org, 'human' from unnest(array['a1', 'a5', 'a8']) s;
  insert into public.people (id, org_id, full_name, created_by)
  select pg_temp.id(o, s), org, 'Person ' || s || ' ' || o, pg_temp.id(o, 'a0') from unnest(array['a1', 'a5', 'a8']) s;
  insert into public.role_assignments (org_id, person_id, role, created_by) values
    (org, pg_temp.id(o, 'a1'), 'owner', pg_temp.id(o, 'a0')),
    (org, pg_temp.id(o, 'a5'), 'dpo', pg_temp.id(o, 'a1'));
  insert into public.users (id, org_id) values (pg_temp.id(o, 'a5'), org), (pg_temp.id(o, 'a8'), org);
  insert into public.devices (id, org_id, user_id, label) values (pg_temp.id(o, 'e1'), org, pg_temp.id(o, 'a8'), 'Phone ' || o);
end
$$;
select pg_temp.small_org('4');
select pg_temp.ready('4');

-- DCD-01 (ACC-11): row level security on dpo_settings, for hearth_app, the one role that reads it:
-- with no org set nothing, acting in an org only that org's versions (the fixture's e6). Each job
-- role, and hearth_worker, can't read it at all (42501).
do $$
declare
  o text;
  r text;
  seen bigint;
  other bigint;
begin
  perform set_config('app.org_id', '', true);
  perform set_config('role', 'hearth_app', true);
  select count(*) into seen from public.dpo_settings;
  perform set_config('role', 'none', true);
  perform pg_temp.check(seen = 0, format('hearth_app saw %s contact version(s) with no org set', seen));
  foreach o in array array['1', '2'] loop
    perform pg_temp.act_as(o, 'a8');
    select count(*), count(*) filter (where org_id <> pg_temp.id(o, '00')) into seen, other from public.dpo_settings;
    perform set_config('role', 'none', true);
    perform pg_temp.check(seen = 1 and other = 0,
                          format('acting in org %s, hearth_app saw %s contact version(s), %s of another org', o, seen, other));
  end loop;
  perform pg_temp.act_as('4', 'a5');
  select count(*) into seen from public.dpo_settings;
  perform set_config('role', 'none', true);
  perform pg_temp.check(seen = 0, format('org 4, with no contact, has %s version(s)', seen));
  foreach r in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge',
                           'hearth_job_revocation', 'hearth_worker'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error('select count(*) from public.dpo_settings', '42501', 'permission denied%');
    perform set_config('role', 'none', true);
  end loop;
end
$$;

-- DCD-02 (CLAUDE.md, Database): hearth_app holds SELECT alone on dpo_settings, at table and column
-- level, and records only through set_dpo_contact(); no runtime role (nor hearth_worker) writes,
-- empties, references or triggers on it or runs its trigger function, and only hearth_app runs the
-- writer. (030 and 032 pin each role's whole list.)
do $$
declare
  r text;
  p text;
begin
  foreach r in array pg_temp.runtime_roles() || array['hearth_worker'] loop
    foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      perform pg_temp.check(not has_table_privilege(r, 'public.dpo_settings', p)
                            and (p not in ('INSERT', 'UPDATE', 'REFERENCES') or not has_any_column_privilege(r, 'public.dpo_settings', p)),
                            format('%s holds %s on dpo_settings', r, p));
    end loop;
    perform pg_temp.check(has_table_privilege(r, 'public.dpo_settings', 'SELECT') = (r = 'hearth_app')
                          and has_function_privilege(r, 'public.set_dpo_contact(integer,text,text,text,text,text,uuid,inet)', 'EXECUTE')
                              = (r = 'hearth_app')
                          and not has_function_privilege(r, 'public.dpo_settings_unchanged()', 'EXECUTE'),
                          format('%s reads the contact, runs its writer or its trigger function wrongly', r));
  end loop;
end
$$;
select pg_temp.act_as('1', 'a5');
select pg_temp.expect_error($$insert into public.dpo_settings (org_id, version, contact_title, contact_email, recorded_by)
  values ('f1000000-0000-4000-8000-000000000000', 2, 'Data Protection Officer', 'planted@fixture.example',
          'f1000000-0000-4000-8000-0000000000a5')$$, '42501');
reset role;

-- DCD-03 (PDPA-13, ACC-10, C0.9 PD-63): only the DPO who is still at the org records the contact.
-- Refused (42501, registers_check_dpo()'s message): the Owner, an Admin, AI Admin, Leadership, the
-- Compliance Officer, a Team Admin, a Member, a DPO who has left (a9, role never revoked), a former
-- Admin, an agent, an assistant, Hearth itself, no acting person or no org, and a DPO whose role was
-- revoked (org 2's a5); the worker's roles can't run it at all. Nothing is written for any of them.
-- Then org 1's DPO records its second version.
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
do $$
declare
  who text;
begin
  foreach who in array array['a1', 'a2', 'a3', 'a4', 'a6', 'a7', 'a8', 'a9', 'aa', 'ab', 'ac', 'a0'] loop
    perform pg_temp.act_as('1', who);
    perform pg_temp.expect_error($f$select * from pg_temp.contact(1, 'Data Protection Officer', 'dpo@planted.example')$f$, '42501',
                                 'Only the Data Protection Officer can change the registers.');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', '', true);
set local role hearth_app;
select pg_temp.expect_error($$select * from pg_temp.contact(1, 'Data Protection Officer', 'dpo@planted.example')$$, '42501',
                            'No org or user is set for this transaction');
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a5')::text, true);
select pg_temp.expect_error($$select * from pg_temp.contact(1, 'Data Protection Officer', 'dpo@planted.example')$$, '42501',
                            'No org or user is set for this transaction');
reset role;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge',
                           'hearth_job_revocation', 'hearth_worker'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error($f$select * from public.set_dpo_contact(1, 'Data Protection Officer', 'dpo@planted.example',
                                   null, null, null, null, null)$f$, '42501', 'permission denied%');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
update public.role_assignments set revoked_at = now(), revoked_by = pg_temp.id('2', 'a1')
where org_id = pg_temp.id('2', '00') and person_id = pg_temp.id('2', 'a5') and role = 'dpo';
select pg_temp.act_as('2', 'a5');
select pg_temp.expect_error($$select * from pg_temp.contact(1, 'Data Protection Officer', 'dpo@planted.example')$$, '42501',
                            'Only the Data Protection Officer can change the registers.');
reset role;
select pg_temp.check(count(*) = 0, 'a refused contact change wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
select pg_temp.check(count(*) = 2 and bool_and(version = 1), 'a refused contact change recorded a version')
from public.dpo_settings where org_id in (pg_temp.id('1', '00'), pg_temp.id('2', '00'));
select pg_temp.act_as('1', 'a5');
select pg_temp.check(version = 2 and changed, 'org 1''s DPO could not record its contact''s next version')
from pg_temp.contact(1, 'Data Protection Officer', 'privacy@fixture.example');
reset role;

-- DCD-08, first part (OD-11, PD-68): with no contact recorded, publishing is refused (HF008), the
-- fourth rule: after the registers' (org 4's are ready, and it lists no provider) and before the
-- body's (a blank body is refused for the contact first). A settings version named while none is
-- recorded is stale (HF007).
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
select pg_temp.act_as('4', 'a5');
select pg_temp.expect_error($$select * from pg_temp.publish(null)$$, 'HF008',
                            'Record the Data Protection Officer''s contact before publishing.');
select pg_temp.expect_error($$select * from pg_temp.publish(null, '')$$, 'HF008',
                            'Record the Data Protection Officer''s contact before publishing.');
select pg_temp.expect_error($$select * from pg_temp.publish(null, 'Privacy notice', 1)$$, 'HF007',
                            'The Data Protection Officer''s contact changed since this notice was prepared.%');
reset role;

-- DCD-04 (PDPA-13, ADM-06, C0.9 PD-63): in org 4, the first record (seen null) is version 1, in the
-- DPO's name; the same contact again (text trimmed of JavaScript's whitespace at both ends, and a
-- field of only whitespace read as not recorded) writes nothing; the next record (seen 1) is version
-- 2, its postal address keeping its lines. A stale seen is refused (HF005), and so is seen null once
-- a version exists. One audit row per version: notice.contact_set, naming the fields that changed
-- and never their values.
select pg_temp.act_as('4', 'a5');
select pg_temp.check(version = 1 and changed, 'org 4''s first contact is not version 1')
from pg_temp.contact(null, 'Data Protection Officer', 'dpo@org4.example');
select pg_temp.check(version = 1 and not changed, 'the same contact, padded, changed something')
from pg_temp.contact(1, E'\u00a0Data Protection Officer\t', E' dpo@org4.example\u3000', E' \t\ufeff', '');
select pg_temp.check(version = 2 and changed, 'org 4''s second contact is not version 2')
from pg_temp.contact(1, 'Data Protection Office', 'dpo@org4.example', '+65 8000 0196', E'\n1 Example Road\nSingapore 000000 ');
select pg_temp.check(version = 2 and not changed, 'the same second contact changed something')
from pg_temp.contact(2, 'Data Protection Office', 'dpo@org4.example', '+65 8000 0196', E'1 Example Road\nSingapore 000000');
select pg_temp.expect_error($$select * from pg_temp.contact(1, 'Data Protection Officer', 'dpo@org4.example')$$, 'HF005',
                            'Your contact details changed since you opened them. Reload them and try again.');
select pg_temp.expect_error($$select * from pg_temp.contact(null, 'Data Protection Officer', 'dpo@org4.example')$$, 'HF005',
                            'Your contact details changed since you opened them. Reload them and try again.');
select pg_temp.expect_error($$select * from pg_temp.contact(3, 'Data Protection Officer', 'dpo@org4.example')$$, 'HF005');
reset role;
select pg_temp.check(array_agg(format('%s|%s|%s|%s|%s|%s', version, contact_title, contact_email, contact_phone, contact_postal,
                                      recorded_by = pg_temp.id('4', 'a5') and recorded_at = now()) order by version)
                     = array['1|Data Protection Officer|dpo@org4.example|||t',
                             E'2|Data Protection Office|dpo@org4.example|+65 8000 0196|1 Example Road\nSingapore 000000|t'],
                     format('org 4''s versions are %s', array_agg(format('%s %s %s %s', version, contact_title, contact_phone,
                                                                         contact_postal) order by version)))
from public.dpo_settings where org_id = pg_temp.id('4', '00');
select pg_temp.check(count(*) = 2
                     and bool_and(a.org_id = pg_temp.id('4', '00') and a.actor_id = pg_temp.id('4', 'a5')
                                  and a.action = 'notice.contact_set' and a.target_type = 'dpo_settings'
                                  and a.target_id = s.id::text and a.request_id = 'req-contact'
                                  and a.device_id = 'd0000000-0000-4000-8000-0000000000d2' and a.ip = '192.0.2.50'
                                  and a.reason is null and a.via is null and a.on_behalf_of_id is null)
                     and array_agg(a.details order by a.id)
                         = array['{"version": 1, "was_version": null, "changed": ["title", "email"]}'::jsonb,
                                 '{"version": 2, "was_version": 1, "changed": ["title", "phone", "postal"]}'::jsonb],
                     format('the contact''s audit rows are wrong: %s', array_agg(a.details order by a.id)))
from public.audit_events a join public.dpo_settings s on s.id::text = a.target_id
where a.id > current_setting('test.audit_max')::bigint;

-- DCD-05 (PDPA-13, C0.9 PD-64): each rule, in contactProblems()'s order, refused (HF006) with a
-- message the page can show, writing nothing. With several broken, the first in order is named.
-- The edges pass: a title of 120 characters, an email address of 254, a number of 7 and of 15
-- digits, and a postal address of 500 characters on several lines (rolled back, HT001).
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
select pg_temp.act_as('4', 'a5');
do $$
declare
  c record;
  -- 254 characters, every label at its longest.
  long_email constant text := repeat('a', 64) || '@' || repeat('b', 63) || '.' || repeat('c', 63) || '.' || repeat('d', 61);
begin
  for c in
    select * from (values
      ('no title', null, 'dpo@org4.example', null, null, 'Give the role title people write to, such as Data Protection Officer.'),
      ('a title of only whitespace', E' \t\u00a0\ufeff\n', 'dpo@org4.example', null, null, 'Give the role title people write to%'),
      ('no title and no channel', '', null, null, null, 'Give the role title people write to%'),
      ('a title of 121 characters', repeat('T', 121), 'dpo@org4.example', null, null,
       'Keep the role title to one line of at most 120 characters.'),
      ('a title on two lines', E'Data Protection\nOfficer', 'dpo@org4.example', null, null, 'Keep the role title to one line%'),
      ('a title with a control character', E'Data Protection\u0007Officer', 'dpo@org4.example', null, null,
       'Keep the role title to one line%'),
      ('no channel', 'Data Protection Officer', null, null, null,
       'Give at least one way to reach you outside Hearth: an email address, a phone number or a postal address.'),
      ('channels of only whitespace', 'Data Protection Officer', E' \u3000', E'\t', E'\n \n', 'Give at least one way to reach you%'),
      ('an email with no @', 'Data Protection Officer', 'no-at-sign', null, null, 'Enter an email address such as name@example.org.'),
      ('an email with a space', 'Data Protection Officer', 'a b@x.example', null, null, 'Enter an email address%'),
      ('an email with ?', 'Data Protection Officer', 'a?b@x.example', null, null, 'Enter an email address%'),
      ('an email with %', 'Data Protection Officer', 'a%20b@x.example', null, null, 'Enter an email address%'),
      ('an email of 255 characters', 'Data Protection Officer', long_email || 'd', null, null, 'Enter an email address%'),
      ('a bad email and a bad phone', 'Data Protection Officer', 'no-at-sign', 'call me', null, 'Enter an email address%'),
      ('a phone with no +', 'Data Protection Officer', null, '6000 0000', null,
       'Enter the phone number with + and the country code, such as +65.'),
      ('a phone with words', 'Data Protection Officer', null, '+65 call', null, 'Enter the phone number%'),
      ('a phone with two hyphens together', 'Data Protection Officer', null, '+65--60000000', null, 'Enter the phone number%'),
      ('a phone of 16 digits', 'Data Protection Officer', null, '+1234567890123456', null, 'Enter the phone number%'),
      ('a bad phone and a long address', 'Data Protection Officer', null, '6000', repeat('p', 501), 'Enter the phone number%'),
      ('a postal address of 501 characters', 'Data Protection Officer', null, null, repeat('p', 501),
       'Keep the postal address to 500 characters of plain text.'),
      ('a postal address with a tab', 'Data Protection Officer', null, null, E'1 Example Road\tSingapore',
       'Keep the postal address to 500 characters%'),
      ('a postal address with a blank line', 'Data Protection Officer', null, null, E'1 Example Road\n\nSingapore',
       'Keep the postal address to 500 characters%'),
      ('a postal address with a line of spaces', 'Data Protection Officer', null, null, E'1 Example Road\n \t\nSingapore',
       'Keep the postal address to 500 characters%')
    ) as v (what, title, email, phone, postal, message)
  loop
    begin
      perform pg_temp.expect_error(format($f$select * from pg_temp.contact(2, %L, %L, %L, %L)$f$, c.title, c.email, c.phone, c.postal),
                                   'HF006', c.message);
    exception when others then
      raise exception '%: %', c.what, sqlerrm;
    end;
  end loop;
  begin
    perform pg_temp.check((select version = 3 from pg_temp.contact(2, repeat('T', 120), long_email, '+1234567',
                                                                   repeat('p', 249) || E'\n' || repeat('q', 250))),
                          'a contact at every limit was refused');
    perform pg_temp.check((select version = 4 from pg_temp.contact(3, 'Data Protection Officer', null, '+1 234-567-890-12345')),
                          'a number of 15 digits, spaced and hyphenated, was refused');
    raise exception 'roll the edges back' using errcode = 'HT001';
  exception when sqlstate 'HT001' then
    null;
  end;
end
$$;
reset role;
select pg_temp.check(count(*) = 0, 'a refused contact change wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
select pg_temp.check(max(version) = 2, 'a refused contact change recorded a version')
from public.dpo_settings where org_id = pg_temp.id('4', '00');

-- DCD-06 (C0.9 PD-64): the table's checks back the rules, whoever writes (a superuser's insert here):
-- each bad shape is refused (23514, naming its dpo_settings_* constraint), and so is a version with
-- no channel or a title padded with spaces.
do $$
declare
  c record;
begin
  for c in
    select * from (values
      (' Padded', 'dpo@org4.example', null, null, 'dpo_settings_title'),
      ('', 'dpo@org4.example', null, null, 'dpo_settings_title'),
      (repeat('T', 121), 'dpo@org4.example', null, null, 'dpo_settings_title'),
      (E'Data\nProtection', 'dpo@org4.example', null, null, 'dpo_settings_title'),
      ('Data Protection Officer', 'no-at-sign', null, null, 'dpo_settings_email'),
      ('Data Protection Officer', 'a#b@x.example', null, null, 'dpo_settings_email'),
      ('Data Protection Officer', repeat('a', 64) || '@' || repeat('b', 63) || '.' || repeat('c', 63) || '.' || repeat('d', 62),
       null, null, 'dpo_settings_email'),
      ('Data Protection Officer', null, '6000 0000', null, 'dpo_settings_phone'),
      ('Data Protection Officer', null, null, ' 1 Example Road', 'dpo_settings_postal'),
      ('Data Protection Officer', null, null, E'1 Example Road\n\nSingapore', 'dpo_settings_postal'),
      ('Data Protection Officer', null, null, E'1 Example Road\tSingapore', 'dpo_settings_postal'),
      ('Data Protection Officer', null, null, repeat('p', 501), 'dpo_settings_postal'),
      ('Data Protection Officer', null, null, null, 'dpo_settings_channel')
    ) as v (title, email, phone, postal, constraint_name)
  loop
    perform pg_temp.expect_error(format($f$insert into public.dpo_settings (org_id, version, contact_title, contact_email,
                                            contact_phone, contact_postal, recorded_by) values (%L, 9, %L, %L, %L, %L, %L)$f$,
                                        pg_temp.id('4', '00'), c.title, c.email, c.phone, c.postal, pg_temp.id('4', 'a5')),
                                 '23514', '%' || c.constraint_name || '%');
  end loop;
end
$$;
select pg_temp.expect_error($$insert into public.dpo_settings (org_id, version, contact_title, contact_email, recorded_by)
  values ('f4000000-0000-4000-8000-000000000000', 0, 'Data Protection Officer', 'dpo@org4.example',
          'f4000000-0000-4000-8000-0000000000a5')$$, '23514', '%dpo_settings_version_check%');
select pg_temp.expect_error($$insert into public.dpo_settings (org_id, version, contact_title, contact_email, recorded_by)
  values ('f4000000-0000-4000-8000-000000000000', 2, 'Data Protection Officer', 'dpo@org4.example',
          'f4000000-0000-4000-8000-0000000000a5')$$, '23505', '%dpo_settings_org_version%');

-- DCD-07 (CLAUDE.md, store the context; C0.9 PD-63): a recorded version never changes, for the
-- superuser and the owner alike (23514, with its message), and hearth_app can neither update nor
-- delete one (42501).
do $$
declare
  stmt text;
begin
  foreach stmt in array array[
    $s$update public.dpo_settings set contact_email = 'changed@org4.example' where org_id = 'f4000000-0000-4000-8000-000000000000'$s$,
    $s$update public.dpo_settings set recorded_at = recorded_at where id = 'f1000000-0000-4000-8000-0000000000e6'$s$] loop
    perform pg_temp.expect_error(stmt, '23514', 'Recorded contact details never change. Record a new version instead.');
    perform set_config('role', 'hearth_owner', true);
    perform pg_temp.expect_error(stmt, '23514', 'Recorded contact details never change. Record a new version instead.');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
select pg_temp.act_as('4', 'a5');
select pg_temp.expect_error($$update public.dpo_settings set contact_email = 'changed@org4.example'$$, '42501');
select pg_temp.expect_error($$delete from public.dpo_settings$$, '42501');
reset role;

-- DCD-08, continued (OD-11, PD-66, PD-67): org 4 publishes its first version, which links the
-- settings version it locked (2) and names it in its audit row; a settings version that isn't the
-- latest, or none while one is recorded, is stale (HF007, the contact's message). The same draft
-- again is "already says this" (HF008); after a new settings version, the same words publish (the
-- api warns same_text), linking it.
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
select pg_temp.act_as('4', 'a5');
select pg_temp.expect_error($$select * from pg_temp.publish(null, 'Privacy notice', 1)$$, 'HF007',
                            'The Data Protection Officer''s contact changed since this notice was prepared. Check the preview again, then publish.');
select pg_temp.expect_error($$select * from pg_temp.publish(null, 'Privacy notice', null)$$, 'HF007',
                            'The Data Protection Officer''s contact changed since this notice was prepared.%');
select set_config('test.v0', notice::text, true) from pg_temp.publish(null) where version = 0;
select pg_temp.check(current_setting('test.v0', true) <> '', 'org 4 could not publish its first version');
select pg_temp.expect_error($$select * from pg_temp.publish(0)$$, 'HF008', 'The published notice already says this.');
select pg_temp.check(version = 3 and changed, 'org 4''s DPO could not record a third version')
from pg_temp.contact(2, 'Data Protection Office', 'dpo@org4.example', '+65 8000 0197', E'1 Example Road\nSingapore 000000');
select pg_temp.expect_error($$select * from pg_temp.publish(0, 'Privacy notice', 2)$$, 'HF007',
                            'The Data Protection Officer''s contact changed since this notice was prepared.%');
select set_config('test.v1', notice::text, true) from pg_temp.publish(0) where version = 1;
select pg_temp.check(current_setting('test.v1', true) <> '', 'the same words under a new settings version were refused');
reset role;
select pg_temp.check(array_agg(format('%s:%s', version, dpo_settings_version) order by version) = '{0:2,1:3}',
                     format('org 4''s versions link %s', array_agg(format('%s:%s', version, dpo_settings_version) order by version)))
from public.notice_versions where org_id = pg_temp.id('4', '00');
select pg_temp.check(array_agg((a.details ->> 'contact_version')::int order by a.id) = '{2,3}'
                     and bool_and(a.action = 'notice.publish'),
                     format('the publishes'' audit rows name %s', array_agg(a.details ->> 'contact_version' order by a.id)))
from public.audit_events a
where a.id > current_setting('test.audit_max')::bigint and a.action = 'notice.publish';
-- A version links an existing settings version of its own org only (as the superuser: the foreign
-- key alone stands in the way): org 4 has no version 9.
select pg_temp.expect_error($$insert into public.notice_versions (org_id, version, body, published_by, generator, dpo_settings_version)
  values ('f4000000-0000-4000-8000-000000000000', 2, 'Planted', 'f4000000-0000-4000-8000-0000000000a5', 'c09.2', 9)$$,
  '23503', '%notice_versions_dpo_settings%');

-- DCD-09 (ACC-11): across orgs. Org 1's DPO named in an org 2 transaction records nothing there
-- (42501), and org 2's contact stays as it was; org 2's version can't link a settings version only
-- org 1 has (org 1's 2, recorded in DCD-03), nor a contact be recorded by another org's person (as
-- the superuser: the foreign keys alone stand in the way).
select set_config('app.org_id', pg_temp.id('2', '00')::text, true), set_config('app.user_id', pg_temp.id('1', 'a5')::text, true);
set local role hearth_app;
select pg_temp.expect_error($$select * from pg_temp.contact(1, 'Data Protection Officer', 'dpo@planted.example')$$, '42501',
                            'Only the Data Protection Officer can change the registers.');
reset role;
select set_config('app.org_id', '', true), set_config('app.user_id', '', true);
select pg_temp.check(count(*) = 1 and bool_and(id = pg_temp.id('2', 'e6') and contact_email = 'dpo-2@fixture.example'),
                     'org 2''s contact changed from another org')
from public.dpo_settings where org_id = pg_temp.id('2', '00');
select pg_temp.expect_error($$insert into public.notice_versions (org_id, version, body, published_by, generator, dpo_settings_version)
  values ('f2000000-0000-4000-8000-000000000000', 1, 'Planted', 'f2000000-0000-4000-8000-0000000000a5', 'c09.2', 2)$$,
  '23503', '%notice_versions_dpo_settings%');
select pg_temp.expect_error($$insert into public.dpo_settings (org_id, version, contact_title, contact_email, recorded_by)
  values ('f2000000-0000-4000-8000-000000000000', 2, 'Data Protection Officer', 'dpo@planted.example',
          'f1000000-0000-4000-8000-0000000000a5')$$, '23503', '%dpo_settings_org_id_recorded_by_fkey%');

-- DCD-10 (OD-11, PD-66, PD-67; RR-12): a version 0010 published, as PR 2's deployments hold one: in
-- org 5, a generated version (c09.1) linking its purposes' current versions and no contact (it
-- printed none), written as the superuser, as 0010's publish_notice() left it. Its DPO then records
-- a contact (version 1), and a publish of the same body, generator and sources isn't "already says
-- this": it links settings version 1.
select pg_temp.small_org('5');
select pg_temp.ready('5');
select set_config('app.org_id', pg_temp.id('5', '00')::text, true);
insert into public.notice_versions (id, org_id, version, body, published_by, generator)
values (pg_temp.id('5', 'e3'), pg_temp.id('5', '00'), 0, 'Privacy notice', pg_temp.id('5', 'a5'), 'c09.1');
insert into public.notice_version_purposes (org_id, notice_version_id, purpose, register_version)
select pg_temp.id('5', '00'), pg_temp.id('5', 'e3'), k, v from unnest((pg_temp.sources()).keys, (pg_temp.sources()).versions) as x (k, v);
select pg_temp.check((select count(*) from public.notice_version_purposes where notice_version_id = pg_temp.id('5', 'e3')) > 0
                     and (pg_temp.sources()).clearances = '{}',
                     'org 5''s 0010 version lists no purpose, or org 5 has a clearance');
select set_config('app.org_id', '', true);
select pg_temp.act_as('5', 'a5');
select pg_temp.check(version = 1 and changed, 'org 5''s DPO could not record a contact')
from pg_temp.contact(null, 'Data Protection Officer', 'dpo@org5.example');
select pg_temp.check(p.version = 1, 'the same words as 0010''s version, now with a contact, were refused')
from public.publish_notice(0, 'Privacy notice', 'c09.1', (pg_temp.sources()).keys, (pg_temp.sources()).versions, '{}', 1,
                           'req-contact', null, null) p;
reset role;
select pg_temp.check(array_agg(format('%s:%s:%s', version, generator, coalesce(dpo_settings_version::text, '-')) order by version)
                     = '{0:c09.1:-,1:c09.1:1}',
                     format('org 5''s versions are %s', array_agg(format('%s:%s:%s', version, generator, dpo_settings_version) order by version)))
from public.notice_versions where org_id = pg_temp.id('5', '00');
select set_config('app.org_id', '', true), set_config('app.user_id', '', true);
