-- PDPA-01, PDPA-04a, PDPA-13, D41, ADM-06, TECH-SPEC T22 (C0.9 PR 1): the processing register (0009).
-- Every org has every purpose's version 1 from the start, as processing_register_defaults() lists
-- them (RGS-01); the table's rules hold past the owner and the superuser (RGS-02); hearth_app only
-- reads it, hearth_queue reads its columns, and no runtime role writes it (RGS-03); row level
-- security keeps each org's rows (RGS-04); set_register_purpose() admits only the DPO who is still
-- at the org (RGS-05), and refuses each rule, a stale edit and an unknown purpose, writes nothing
-- for a no-op and one audit row per change (RGS-06); and the processing-restrictions hook admits
-- only a purpose resting on consent, which can't then leave it while a restriction is live (RGS-07).
-- Every case runs as hearth_app (act_as) or the job role it tests unless it says it arranges data
-- as the superuser.
\ir fixtures/two_orgs.sql

-- One org's untouched version-1 entries, and the defaults, each as 'purpose ai pinned needs_switch
-- status'.
create function pg_temp.first_versions(o text) returns text[] language sql as $$
  select array_agg(format('%s %s %s %s %s', r.purpose, r.ai, r.pinned, r.needs_switch, r.status) order by r.purpose)
  from public.processing_register r
  where r.org_id = pg_temp.id(o, '00') and r.version = 1 and r.recorded_by is null and r.basis is null
    and r.basis_reference is null and r.opt_out_days is null and r.retention is null and r.providers = '{}'
$$;
create function pg_temp.default_purposes() returns text[] language sql as $$
  select array_agg(format('%s %s %s %s %s', d.purpose, d.ai, d.pinned, d.needs_switch, d.status) order by d.purpose)
  from public.processing_register_defaults() d
$$;
-- One org's transfer entries untouched (revision 1, nobody, no fact), and the defaults, as
-- 'provider ai'.
create function pg_temp.first_entries(o text) returns text[] language sql as $$
  select array_agg(format('%s %s', t.provider, t.ai) order by t.provider)
  from public.transfer_register t
  where t.org_id = pg_temp.id(o, '00') and t.revision = 1 and t.updated_by is null
    and pg_catalog.jsonb_strip_nulls(public.transfer_register_facts(t))
        = '{"processing_countries": [], "storage_countries": [], "dpa_terms_confirmed": false}'
$$;
create function pg_temp.default_providers() returns text[] language sql as $$
  select array_agg(format('%s %s', d.provider, d.ai) order by d.provider) from public.transfer_register_defaults() d
$$;
-- set_register_purpose with the request's details, as the api's route calls it.
create function pg_temp.set_purpose(text, integer, text, text, text, integer, text, text[])
returns table (entry uuid, version integer, changed boolean) language sql as $$
  select * from public.set_register_purpose($1, $2, $3, $4, $5, $6, $7, $8, 'req-registers', pg_temp.id('1', 'e1'),
                                            '192.0.2.20')
$$;

-- RGS-01 (PDPA-01, C0.9 PD-03, PD-06): every org has exactly the defaults' version 1 of each
-- purpose, naming nobody and recording nothing, and the defaults' entry for each provider, untouched:
-- the fixture orgs (beside the rows the fixture adds, e4 and e5) and an org made now, through the
-- orgs trigger. The defaults: 23 purposes, of which the two pinned (core.system's) and
-- security_audit and backups start active and every other one planned; the ten AI ones planned;
-- PDPA-04's list needs a switch, the transcription test set aside. Ten providers, openai and bedrock
-- the AI ones.
select pg_temp.check(cardinality(pg_temp.default_purposes()) = 23 and cardinality(pg_temp.default_providers()) = 10,
                     'the defaults do not list 23 purposes and 10 providers');
select pg_temp.check(
  array_agg(d.purpose order by d.purpose) filter (where d.status = 'active') = '{accounts,backups,security_audit,service_operation}'
  and array_agg(d.purpose order by d.purpose) filter (where d.pinned) = '{accounts,service_operation}'
  and array_agg(d.purpose order by d.purpose) filter (where d.ai) = '{agents,ai_cost_figures,ai_writing,assistant,meeting_notes,org_brain,people_inference,transcription,transcription_test_set,voice_message_transcription}'
  and array_agg(d.purpose order by d.purpose) filter (where d.needs_switch) = '{agents,ai_cost_figures,ai_writing,assistant,meeting_notes,org_brain,people_inference,recording_drop_in,recording_meetings,transcription,voice_message_transcription}'
  and bool_and(d.status in ('active', 'planned')),
  'the defaults do not start the purposes as C0.9 PD-06 says')
from public.processing_register_defaults() d;
select pg_temp.check(array_agg(d.provider order by d.provider) filter (where d.ai) = '{bedrock,openai}',
                     'the defaults do not mark exactly openai and bedrock as AI providers')
from public.transfer_register_defaults() d;
select pg_temp.check(pg_temp.first_versions('1') = pg_temp.default_purposes() and pg_temp.first_versions('2') = pg_temp.default_purposes(),
                     'a fixture org does not have exactly the defaults'' version 1 of each purpose');
select pg_temp.check(
  pg_temp.first_entries('1') = array_remove(pg_temp.default_providers(), 'aws f')
  and pg_temp.first_entries('2') = array_remove(pg_temp.default_providers(), 'aws f'),
  'a fixture org does not have the defaults'' entries (aws aside, which the fixture recorded)');
insert into public.orgs (id, name) values ('f3000000-0000-4000-8000-000000000000', 'A new org');
select pg_temp.check(pg_temp.first_versions('3') = pg_temp.default_purposes() and pg_temp.first_entries('3') = pg_temp.default_providers()
                     and (select count(*) from public.processing_register where org_id = pg_temp.id('3', '00')) = 23
                     and (select count(*) from public.transfer_register where org_id = pg_temp.id('3', '00')) = 10
                     and not exists (select 1 from public.transfer_clearances where org_id = pg_temp.id('3', '00')),
                     'a new org did not get exactly the defaults, with nothing cleared');

-- RGS-02 (PDPA-01, PDPA-04, D41, C0.9 PD-07, PD-11): the table's rules (23514), for the superuser
-- and the owner alike; each row breaks one rule. An AI purpose can't be anything but planned with
-- nothing recorded, even as the owner: only A0's migration lifts that lock.
do $$
declare
  who text;
  bad record;
begin
  foreach who in array array['none', 'hearth_owner'] loop
    perform set_config('role', who, true);
    for bad in
      select * from (values
        -- The second lock (D41): an AI purpose stays planned with nothing recorded.
        ('transcription', 'active', 'employment', null, null, 'A year', '{}', 'processing_register_ai_planned'),
        ('transcription', 'planned', 'employment', null, null, 'A year', '{}', 'processing_register_ai_planned'),
        ('transcription_test_set', 'planned', null, null, null, 'A year', '{}', 'processing_register_ai_planned'),
        ('org_brain', 'planned', null, null, null, null, '{aws}', 'processing_register_ai_planned'),
        -- Pinned: active, and never on a consent-type basis.
        ('accounts', 'retired', 'employment', null, null, 'A year', '{}', 'processing_register_pinned'),
        ('service_operation', 'planned', null, null, null, null, '{}', 'processing_register_pinned'),
        ('accounts', 'active', 'consent', null, null, 'A year', '{}', 'processing_register_pinned'),
        ('accounts', 'active', 'deemed_consent_conduct', null, null, 'A year', '{}', 'processing_register_pinned'),
        -- PDPA-04: a purpose that needs a switch rests on no consent-type basis (until C2.11).
        ('recording_meetings', 'active', 'consent', null, null, 'A year', '{}', 'processing_register_switch'),
        ('recording_drop_in', 'active', 'deemed_consent_conduct', null, null, 'A year', '{}', 'processing_register_switch'),
        ('recording_meetings', 'active', 'deemed_consent_notification', 'Assessment', 30, 'A year', '{}', 'processing_register_switch'),
        -- PDPA-01's attachments.
        ('security_audit', 'active', 'legitimate_interests', null, null, 'A year', '{}', 'processing_register_attachment'),
        ('security_audit', 'active', 'employment', 'A reference', null, 'A year', '{}', 'processing_register_attachment'),
        ('security_audit', 'active', 'deemed_consent_notification', 'Assessment', null, 'A year', '{}', 'processing_register_attachment'),
        ('security_audit', 'active', 'other_exception', null, null, 'A year', '{}', 'processing_register_attachment'),
        ('security_audit', 'active', 'employment', null, 30, 'A year', '{}', 'processing_register_attachment'),
        -- Once edited, only a planned purpose lacks a basis or retention.
        ('security_audit', 'active', null, null, null, null, '{}', 'processing_register_recorded'),
        ('backups', 'retired', 'employment', null, null, null, '{}', 'processing_register_recorded'),
        -- Shapes.
        ('backups', 'paused', 'employment', null, null, 'A year', '{}', 'processing_register_status_check'),
        ('backups', 'active', 'contract', null, null, 'A year', '{}', 'processing_register_basis_check'),
        ('backups', 'active', 'other_exception', ' Padded', null, 'A year', '{}', 'processing_register_basis_reference_check'),
        ('backups', 'active', 'employment', null, null, '', '{}', 'processing_register_retention_check'),
        ('access_logs', 'active', 'deemed_consent_notification', 'Assessment', 366, 'A year', '{}', 'processing_register_opt_out_days_check'),
        ('backups', 'active', 'employment', null, null, 'A year', '{AWS}', 'processing_register_providers_check'),
        ('backups', 'active', 'employment', null, null, 'A year', '{aws,NULL}', 'processing_register_providers_check'),
        ('backups', 'active', 'employment', null, null, 'A year', '{aws,""}', 'processing_register_providers_check')
      ) as v (purpose, status, basis, reference, days, retention, providers, rule)
    loop
      perform pg_temp.expect_error(format(
        $f$insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status, basis,
             basis_reference, opt_out_days, retention, providers, recorded_by)
           select r.org_id, r.purpose, r.ai, r.pinned, r.needs_switch, 7, %L, %L, %L, %L::integer, %L, %L::text[], %L
           from public.processing_register r where r.org_id = %L and r.purpose = %L and r.version = 1$f$,
        bad.status, bad.basis, bad.reference, bad.days, bad.retention, bad.providers, pg_temp.id('1', 'a5'),
        pg_temp.id('1', '00'), bad.purpose), '23514', '%' || bad.rule || '%');
    end loop;
    -- More than 20 providers.
    perform pg_temp.expect_error(format(
      $f$insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status, basis, retention,
           providers, recorded_by)
         values (%L, 'backups', false, false, false, 7, 'active', 'employment', 'A year',
                 array(select 'p' || n from generate_series(1, 21) n), %L)$f$,
      pg_temp.id('1', '00'), pg_temp.id('1', 'a5')), '23514', '%processing_register_providers_check%');
    -- Version 1 is Hearth's and names nobody; every later one names its recorder.
    perform pg_temp.expect_error(format(
      $f$insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status, basis, retention)
         values (%L, 'backups', false, false, false, 7, 'active', 'employment', 'A year')$f$,
      pg_temp.id('1', '00')), '23514', '%processing_register_recorded_by%');
    -- A version is recorded once.
    perform pg_temp.expect_error(format(
      $f$insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status)
         values (%L, 'backups', false, false, false, 1, 'active')$f$,
      pg_temp.id('1', '00')), '23505', '%processing_register_org_id_purpose_version_key%');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
-- The owner can't make an AI purpose active by changing a version in place either.
set local role hearth_owner;
select pg_temp.expect_error($$update public.processing_register set status = 'active'
  where purpose = 'meeting_notes' and version = 1$$, '23514', '%processing_register_ai_planned%');
reset role;
select pg_temp.check(count(*) = 0, 'an AI purpose is recorded as something other than planned with nothing recorded')
from public.processing_register where ai and (status <> 'planned' or basis is not null or retention is not null or providers <> '{}');

-- RGS-03 (CLAUDE.md, Database; C0.9 PD-16, PD-20): who may do what with the registers, exactly,
-- for every runtime role: hearth_app reads three tables (never processing_restrictions) and runs
-- the DPO's four functions and the transfer gate; hearth_queue reads its columns; every other role
-- has nothing; nobody runs the bootstrap, the defaults or the helpers. (030 and 032 pin each role's
-- whole list.)
do $$
declare
  r text;
  actual text[];
  expected text[];
begin
  foreach r in array pg_temp.runtime_roles() || array['hearth_worker'] loop
    select coalesce(array_agg(g order by g), '{}') into actual
    from unnest(pg_temp.privileges_of(r)) g where g ~ '(register|transfer|restriction)';
    expected := case r
      when 'hearth_app' then array[
        'function clear_transfer_entry(text,bigint,text,uuid,inet): EXECUTE',
        'function record_transfer_entry(text,bigint,text,text,text[],text[],text,text,text,date,boolean,text,text,text,text,text,date,boolean,text,uuid,inet): EXECUTE',
        'function set_register_purpose(text,integer,text,text,text,integer,text,text[],text,uuid,inet): EXECUTE',
        'function transfer_cleared(text): EXECUTE',
        'function withdraw_transfer_clearance(text,text,uuid,inet): EXECUTE',
        'processing_register: SELECT', 'transfer_clearances: SELECT', 'transfer_register: SELECT']
      when 'hearth_queue' then array[
        'processing_register.basis: SELECT', 'processing_register.org_id: SELECT', 'processing_register.providers: SELECT',
        'processing_register.purpose: SELECT', 'processing_register.status: SELECT', 'processing_register.version: SELECT',
        'processing_restrictions.effective_at: SELECT', 'processing_restrictions.id: SELECT',
        'processing_restrictions.lifted_at: SELECT', 'processing_restrictions.org_id: SELECT',
        'processing_restrictions.person_id: SELECT', 'processing_restrictions.purpose: SELECT',
        'transfer_clearances.id: SELECT', 'transfer_clearances.org_id: SELECT', 'transfer_clearances.provider: SELECT',
        'transfer_clearances.withdrawn_at: SELECT',
        'transfer_register.org_id: SELECT', 'transfer_register.provider: SELECT', 'transfer_register.review_on: SELECT',
        'transfer_register.revision: SELECT']
      else '{}'::text[] end;
    perform pg_temp.check(actual = (select array_agg(e order by e) from unnest(expected) e) or (actual = '{}' and expected = '{}'),
                          format('%s on the registers: %s', r, actual));
  end loop;
end
$$;
select pg_temp.check(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join unnest(pg_temp.runtime_roles() || array['hearth_worker']) r
  where n.nspname = 'public'
    and p.proname in ('bootstrap_transfer_clearance', 'processing_register_defaults', 'transfer_register_defaults',
                      'transfer_register_facts', 'transfer_countries', 'registers_check_dpo', 'orgs_add_registers',
                      'transfer_register_check', 'transfer_clearances_check', 'processing_restrictions_check')
    and has_function_privilege(r, p.oid, 'EXECUTE')),
  'a runtime role can run the bootstrap, a defaults function, a helper or a trigger function of the registers');
-- Writes by any runtime role are refused (42501): the functions are the only writers.
select pg_temp.act_as('1', 'a5');
select pg_temp.expect_error($$insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status,
  basis, retention, recorded_by)
  values ('f1000000-0000-4000-8000-000000000000', 'backups', false, false, false, 2, 'active', 'employment', 'A year',
          'f1000000-0000-4000-8000-0000000000a5')$$, '42501');
select pg_temp.expect_error($$update public.processing_register set status = 'retired' where purpose = 'backups'$$, '42501');
select pg_temp.expect_error($$delete from public.processing_register where purpose = 'backups'$$, '42501');
select pg_temp.expect_error($$select count(*) from public.processing_restrictions$$, '42501');
select pg_temp.expect_error($$insert into public.processing_restrictions (org_id, person_id, purpose, effective_at, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'presence_receipts', now(),
          'f1000000-0000-4000-8000-0000000000a5')$$, '42501');
reset role;
select pg_temp.act_as_job('1', 'hearth_queue');
select pg_temp.expect_error($$insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status)
  values ('f1000000-0000-4000-8000-000000000000', 'backups', false, false, false, 2, 'planned')$$, '42501');
select pg_temp.expect_error($$update public.processing_restrictions set lifted_at = now()$$, '42501');
select pg_temp.expect_error($$delete from public.processing_restrictions$$, '42501');
select pg_temp.expect_error($$select recorded_by from public.processing_register$$, '42501');
reset role;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge', 'hearth_job_revocation'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error('select count(*) from public.processing_register', '42501');
    perform pg_temp.expect_error('select count(*) from public.processing_restrictions', '42501');
    perform set_config('role', 'none', true);
  end loop;
end
$$;

-- RGS-04 (ACC-11): row level security. With no org set, neither hearth_app nor hearth_queue sees a
-- row; acting in an org, each sees that org's rows and none of the other's.
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a5')::text, true);
set local role hearth_app;
select pg_temp.check((select count(*) from public.processing_register) = 0 and (select count(*) from public.transfer_register) = 0
                     and (select count(*) from public.transfer_clearances) = 0, 'hearth_app saw a register row with no org set');
reset role;
set local role hearth_queue;
select pg_temp.check((select count(*) from public.processing_register) = 0 and (select count(*) from public.transfer_register) = 0
                     and (select count(*) from public.transfer_clearances) = 0
                     and (select count(*) from public.processing_restrictions) = 0, 'hearth_queue saw a register row with no org set');
reset role;
select pg_temp.act_as('2', 'a5');
select pg_temp.check((select count(*) filter (where org_id = pg_temp.id('2', '00')) = 24 and count(*) = 24 from public.processing_register)
                     and (select count(*) filter (where org_id = pg_temp.id('2', '00')) = 10 and count(*) = 10 from public.transfer_register)
                     and (select count(*) filter (where org_id = pg_temp.id('2', '00')) = 1 and count(*) = 1 from public.transfer_clearances),
                     'hearth_app acting in org 2 did not see exactly org 2''s register rows');
reset role;
select pg_temp.act_as_job('1', 'hearth_queue');
select pg_temp.check((select count(*) filter (where org_id = pg_temp.id('1', '00')) = 24 and count(*) = 24 from public.processing_register)
                     and (select count(*) filter (where org_id = pg_temp.id('1', '00')) = 10 and count(*) = 10 from public.transfer_register)
                     and (select count(*) filter (where org_id = pg_temp.id('1', '00')) = 1 and count(*) = 1 from public.transfer_clearances)
                     and (select count(*) filter (where org_id = pg_temp.id('1', '00')) = 1 and count(*) = 1 from public.processing_restrictions),
                     'hearth_queue acting in org 1 did not see exactly org 1''s register rows');
reset role;

-- RGS-05 (PDPA-01 "maintained by the DPO", PDPA-13, ACC-10, C0.9 PD-20, PD-21): only the DPO who is
-- still at the org may change the processing register. Refused (42501): the Owner, an Admin, AI
-- Admin, Leadership, the Compliance Officer, a Team Admin, a Member, a DPO who has left, a former
-- Admin, an agent, an assistant, Hearth itself, another org's DPO, no acting person, a DPO whose
-- role was revoked, and the worker's roles, which can't run it at all.
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);
do $$
declare
  who text;
begin
  foreach who in array array['a1', 'a2', 'a3', 'a4', 'a6', 'a7', 'a8', 'a9', 'aa', 'ab', 'ac', 'a0'] loop
    perform pg_temp.act_as('1', who);
    perform pg_temp.expect_error($f$select * from pg_temp.set_purpose('backups', 1, 'active', 'employment', null, null,
                                   '35 days', '{aws}')$f$, '42501', 'Only the Data Protection Officer can change the registers.');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', pg_temp.id('2', 'a5')::text, true);
set local role hearth_app;
select pg_temp.expect_error($$select * from pg_temp.set_purpose('backups', 1, 'active', 'employment', null, null, '35 days', '{}')$$,
                            '42501');
reset role;
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', '', true);
set local role hearth_app;
select pg_temp.expect_error($$select * from pg_temp.set_purpose('backups', 1, 'active', 'employment', null, null, '35 days', '{}')$$,
                            '42501');
reset role;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_purge',
                           'hearth_job_revocation', 'hearth_worker'] loop
    perform pg_temp.act_as_job('1', r);
    perform pg_temp.expect_error($f$select * from public.set_register_purpose('backups', 1, 'planned', null, null, null, null,
                                   '{}', null, null, null)$f$, '42501');
    perform set_config('role', 'none', true);
  end loop;
end
$$;
-- Org 2's DPO, once their role is revoked (as the superuser), is refused too.
update public.role_assignments set revoked_at = now(), revoked_by = pg_temp.id('2', 'a1')
where person_id = pg_temp.id('2', 'a5') and role = 'dpo';
select pg_temp.act_as('2', 'a5');
select pg_temp.expect_error($$select * from public.set_register_purpose('backups', 1, 'active', 'employment', null, null,
  '35 days', '{}', null, null, null)$$, '42501', 'Only the Data Protection Officer can change the registers.');
reset role;
select pg_temp.check(count(*) = 0, 'a refused change wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
select pg_temp.check(count(*) = 1, 'a refused change added a version of backups')
from public.processing_register where org_id = pg_temp.id('1', '00') and purpose = 'backups';
-- The DPO may.
select pg_temp.act_as('1', 'a5');
select pg_temp.check(changed and version = 2, 'the DPO could not record backups')
from pg_temp.set_purpose('backups', 1, 'active', 'employment', null, null, '35 days', '{aws}');
reset role;

-- RGS-06 (PDPA-01, PDPA-04, D41, ADM-06, C0.9 PD-04, PD-11, PD-21, PD-25): what the function refuses
-- and what it writes. Refused: an unknown purpose (22023); an edit from a version that isn't the
-- latest (HF005); each rule (HF006), with a message the page can show. A refused call writes nothing.
select set_config('test.audit_max', (select max(id)::text from public.audit_events), true);
select pg_temp.act_as('1', 'a5');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('no_such_purpose', 1, 'planned', null, null, null, null, '{}')$$,
                            '22023');
select pg_temp.expect_error($$select * from pg_temp.set_purpose(null, 1, 'planned', null, null, null, null, '{}')$$, '22023');
-- Stale: a version the DPO never saw, none, or one older than the latest (backups is at 2).
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 2, 'active', 'employment', null, null, 'A year', '{}')$$,
                            'HF005', 'This entry changed since you opened it. Reload it and try again.');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', null, 'active', 'employment', null, null, 'A year', '{}')$$,
                            'HF005');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('backups', 1, 'active', 'employment', null, null, '30 days', '{aws}')$$,
                            'HF005');
-- D41: an AI purpose stays planned until A0, whatever is sent, a no-op included.
select pg_temp.expect_error($$select * from pg_temp.set_purpose('transcription', 1, 'planned', null, null, null, null, '{}')$$,
                            'HF006', 'Purposes for later stages stay planned until their stage begins.');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('org_brain', 1, 'active', 'employment', null, null, 'A year', '{}')$$,
                            'HF006', 'Purposes for later stages%');
-- Shapes.
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'paused', 'employment', null, null, 'A year', '{}')$$,
                            'HF006', 'A purpose is planned, active or retired.');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, null, null, null, null, null, '{}')$$,
                            'HF006', 'A purpose is planned, active or retired.');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'active', 'contract', null, null, 'A year', '{}')$$,
                            'HF006', '%basis isn''t one the register records%');
-- C0.9 PD-07: a pinned purpose stays active and never rests on consent.
select pg_temp.expect_error($$select * from pg_temp.set_purpose('accounts', 1, 'retired', 'employment', null, null, 'A year', '{}')$$,
                            'HF006', 'Hearth needs this purpose for sign-in and its own upkeep%');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('service_operation', 1, 'planned', null, null, null, null, '{}')$$,
                            'HF006', 'Hearth needs this purpose%');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('accounts', 1, 'active', 'consent', null, null, 'A year', '{}')$$,
                            'HF006', 'Hearth needs this purpose%');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('accounts', 1, 'active', 'deemed_consent_conduct', null, null, 'A year', '{}')$$,
                            'HF006', 'Hearth needs this purpose%');
-- PDPA-04, C0.9 PD-11: a purpose whose withdrawal needs a switch rests on no consent-type basis,
-- planned or not, until C2.11.
select pg_temp.expect_error($$select * from pg_temp.set_purpose('recording_meetings', 1, 'active', 'consent', null, null, 'A year', '{}')$$,
                            'HF006', 'Until per-person switches exist, this purpose can''t rest on consent or deemed consent.');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('recording_meetings', 1, 'planned', 'deemed_consent_conduct', null, null, null, '{}')$$,
                            'HF006', 'Until per-person switches exist%');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('recording_drop_in', 1, 'active', 'deemed_consent_notification', 'Assessment', 30, 'A year', '{}')$$,
                            'HF006', 'Until per-person switches exist%');
-- PDPA-01's attachments, missing or extra.
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'active', 'legitimate_interests', null, null, 'A year', '{}')$$,
                            'HF006', 'Record where the legitimate interests assessment is kept.');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'active', 'deemed_consent_notification', 'Assessment', null, 'A year', '{}')$$,
                            'HF006', 'Record where the assessment for deemed consent by notification is kept, and its opt-out window.');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'active', 'deemed_consent_notification', null, 30, 'A year', '{}')$$,
                            'HF006', 'Record where the assessment for deemed consent by notification is kept%');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'active', 'other_exception', null, null, 'A year', '{}')$$,
                            'HF006', 'Record the provision relied on.');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'active', 'employment', 'A reference', null, 'A year', '{}')$$,
                            'HF006', 'Only legitimate interests, deemed consent by notification and another exception take a reference.');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'planned', null, 'A reference', null, null, '{}')$$,
                            'HF006', 'Only legitimate interests%take a reference.');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'active', 'employment', null, 30, 'A year', '{}')$$,
                            'HF006', 'Only deemed consent by notification takes an opt-out window.');
-- Active or retired needs a basis and a retention once the DPO has edited it.
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'active', null, null, null, 'A year', '{}')$$,
                            'HF006', 'An active or retired purpose needs its basis and how long its data is kept.');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'active', 'employment', null, null, null, '{}')$$,
                            'HF006', 'An active or retired purpose needs%');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('content_delivery', 1, 'retired', 'employment', null, null, null, '{}')$$,
                            'HF006', 'An active or retired purpose needs%');
-- Providers: the transfer register's, never an AI one, none empty.
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'active', 'employment', null, null, 'A year', '{nope}')$$,
                            'HF006', 'Only providers in the transfer register can be listed, and not those for later stages.');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'active', 'employment', null, null, 'A year', '{aws,openai}')$$,
                            'HF006', 'Only providers in the transfer register%');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'active', 'employment', null, null, 'A year', '{aws,NULL}')$$,
                            'HF006', 'Only providers in the transfer register%');
reset role;
select pg_temp.check(count(*) = 0, 'a refused change wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
select pg_temp.check(count(*) = 0, 'a refused change added a version')
from public.processing_register where org_id = pg_temp.id('1', '00') and version > 1 and purpose <> 'presence_receipts' and purpose <> 'backups';

-- A change: the next version, the fixed facts copied, providers sorted and once each, the DPO named,
-- and one audit row naming the request, device and address, the version and status before and
-- after, the basis before and after, and which fields changed.
select pg_temp.act_as('1', 'a5');
select pg_temp.check(changed and version = 2, 'recording security_audit did not make version 2')
from pg_temp.set_purpose('security_audit', 1, 'active', 'legitimate_interests', 'Assessment file 3', null,
                         '12 months after the event', '{twilio,aws,aws}');
reset role;
select pg_temp.check(r.status = 'active' and r.basis = 'legitimate_interests' and r.basis_reference = 'Assessment file 3'
                     and r.opt_out_days is null and r.retention = '12 months after the event' and r.providers = '{aws,twilio}'
                     and not r.ai and not r.pinned and not r.needs_switch and r.recorded_by = pg_temp.id('1', 'a5')
                     and r.recorded_at = now(),
                     'version 2 does not hold the change')
from public.processing_register r where r.org_id = pg_temp.id('1', '00') and r.purpose = 'security_audit' and r.version = 2;
select pg_temp.check(a.actor_id = pg_temp.id('1', 'a5') and a.action = 'register.purpose_set' and a.target_type = 'processing_purpose'
                     and a.target_id = 'security_audit' and a.request_id = 'req-registers' and a.device_id = pg_temp.id('1', 'e1')
                     and a.ip = '192.0.2.20' and a.via is null and a.on_behalf_of_id is null
                     and a.details = jsonb_build_object('version', 2, 'was_version', 1, 'status', 'active', 'was_status', 'active',
                                                        'basis', 'legitimate_interests', 'was_basis', null,
                                                        'changed', jsonb_build_array('basis', 'basis_reference', 'retention', 'providers')),
                     format('the audit row does not record the change: %s', a.details))
from public.audit_events a where a.id = (select max(id) from public.audit_events where action = 'register.purpose_set');
-- A no-op (the same values, providers in another order or twice) writes nothing and returns the
-- current version.
select set_config('test.audit_max', (select max(id)::text from public.audit_events), true);
select pg_temp.act_as('1', 'a5');
select pg_temp.check(not changed and version = 2
                     and entry = (select id from public.processing_register
                                  where org_id = pg_temp.id('1', '00') and purpose = 'security_audit' and version = 2),
                     'a no-op made a new version')
from pg_temp.set_purpose('security_audit', 2, 'active', 'legitimate_interests', 'Assessment file 3', null,
                         '12 months after the event', '{twilio,aws,twilio}');
-- An untouched planned purpose sent back as it is changes nothing either.
select pg_temp.check(not changed and version = 1, 'resending a planned purpose made a version')
from pg_temp.set_purpose('content_delivery', 1, 'planned', null, null, null, null, '{}');
-- A second change from version 1 is now stale (HF005).
select pg_temp.expect_error($$select * from pg_temp.set_purpose('security_audit', 1, 'active', 'employment', null, null, 'A year', '{}')$$,
                            'HF005');
reset role;
select pg_temp.check(count(*) = 0, 'a no-op wrote to the audit log')
from public.audit_events where id > current_setting('test.audit_max')::bigint;
-- Each basis the register records, where its purpose allows it: a pinned purpose on employment (its
-- version 1 named no basis); deemed consent by notification with its assessment and window; another
-- exception with its provision; deemed consent by conduct for a purpose that needs no switch; and
-- retiring a purpose. Each adds one version and one audit row.
select set_config('test.audit_max', (select max(id)::text from public.audit_events), true);
select pg_temp.act_as('1', 'a5');
select pg_temp.check(changed and version = 2, 'the DPO could not record accounts'' basis')
from pg_temp.set_purpose('accounts', 1, 'active', 'employment', null, null, 'While they work here, then 12 months', '{twilio}');
select pg_temp.check(changed and version = 2, 'deemed consent by notification was refused')
from pg_temp.set_purpose('access_logs', 1, 'active', 'deemed_consent_notification', 'Assessment file 9', 30, '6 months', '{}');
select pg_temp.check(changed and version = 3, 'another exception was refused')
from pg_temp.set_purpose('backups', 2, 'active', 'other_exception', 'The provision', null, '35 days', '{aws}');
select pg_temp.check(changed and version = 2, 'deemed consent by conduct was refused for a purpose with no switch')
from pg_temp.set_purpose('session_slides', 1, 'planned', 'deemed_consent_conduct', null, null, 'With the session record', '{}');
select pg_temp.check(changed and version = 3, 'retiring access_logs was refused')
from pg_temp.set_purpose('access_logs', 2, 'retired', 'deemed_consent_notification', 'Assessment file 9', 30, '6 months', '{}');
reset role;
select pg_temp.check(r.pinned and not r.ai and r.basis = 'employment' and r.status = 'active', 'accounts'' version 2 lost its fixed facts')
from public.processing_register r where r.org_id = pg_temp.id('1', '00') and r.purpose = 'accounts' and r.version = 2;
select pg_temp.check(r.opt_out_days = 30 and r.status = 'retired', 'access_logs'' version 3 does not hold its window and status')
from public.processing_register r where r.org_id = pg_temp.id('1', '00') and r.purpose = 'access_logs' and r.version = 3;
select pg_temp.check(count(*) = 5 and bool_and(action = 'register.purpose_set' and actor_id = pg_temp.id('1', 'a5')),
                     format('expected one audit row per change, got %s', count(*)))
from public.audit_events where id > current_setting('test.audit_max')::bigint;
-- Every later version keeps its version 1's fixed facts, and versions run 1, 2, 3 with no gap.
select pg_temp.check(not exists (
  select 1 from public.processing_register v join public.processing_register f
    on f.org_id = v.org_id and f.purpose = v.purpose and f.version = 1
  where (v.ai, v.pinned, v.needs_switch) is distinct from (f.ai, f.pinned, f.needs_switch)),
  'a version changed its purpose''s fixed facts');
select pg_temp.check(bool_and(n = top), 'a purpose''s versions skip a number')
from (select org_id, purpose, count(*) as n, max(version) as top from public.processing_register group by org_id, purpose) v;
-- Another org's register is untouched.
select pg_temp.check(count(*) = 23 + 1, 'a change reached org 2''s register')
from public.processing_register where org_id = pg_temp.id('2', '00');

-- RGS-07 (PDPA-04a, C0.9 PD-10): the processing-restrictions hook. A restriction is admitted only
-- for a purpose whose latest version rests on a consent-type basis (23514, as the superuser, since
-- nothing writes it until C2.11); one is live per person and purpose; its lift is kept as recorded;
-- and while one is live the purpose's basis can't leave consent-type (HF006), though it may move
-- between consent-type bases. Org 1's presence_receipts rests on consent (version 2) with a8's
-- restriction live (e4).
select pg_temp.expect_error($$insert into public.processing_restrictions (org_id, person_id, purpose, effective_at, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'content_delivery', now(),
          'f1000000-0000-4000-8000-0000000000a5')$$, '23514',
  'A processing switch applies only to a purpose the register records as resting on consent.');
select pg_temp.expect_error($$insert into public.processing_restrictions (org_id, person_id, purpose, effective_at, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'security_audit', now(),
          'f1000000-0000-4000-8000-0000000000a5')$$, '23514', 'A processing switch applies only%');
select pg_temp.expect_error($$insert into public.processing_restrictions (org_id, person_id, purpose, effective_at, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a7', 'no_such_purpose', now(),
          'f1000000-0000-4000-8000-0000000000a5')$$, '23514', 'A processing switch applies only%');
select pg_temp.expect_error($$insert into public.processing_restrictions (org_id, person_id, purpose, effective_at, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'presence_receipts', now(),
          'f1000000-0000-4000-8000-0000000000a5')$$, '23505', '%processing_restrictions_live%');
insert into public.processing_restrictions (org_id, person_id, purpose, effective_at, created_by)
  values (pg_temp.id('1', '00'), pg_temp.id('1', 'a7'), 'presence_receipts', now(), pg_temp.id('1', 'a5'));
-- Leaving consent-type while restrictions are live is refused, planned or not; moving between
-- consent-type bases is allowed.
select pg_temp.act_as('1', 'a5');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('presence_receipts', 2, 'active', 'employment', null, null, 'A year', '{}')$$,
                            'HF006', 'Withdrawals are recorded against this purpose, so its basis stays consent-based until they''re lifted.');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('presence_receipts', 2, 'planned', null, null, null, null, '{}')$$,
                            'HF006', 'Withdrawals are recorded against this purpose%');
select pg_temp.check(changed and version = 3, 'moving between consent-type bases was refused')
from pg_temp.set_purpose('presence_receipts', 2, 'active', 'deemed_consent_conduct', null, null, 'Until withdrawn', '{}');
reset role;
-- The hook reads the latest version (3, deemed consent by conduct), which admits another.
insert into public.processing_restrictions (org_id, person_id, purpose, effective_at, created_by)
  values (pg_temp.id('1', '00'), pg_temp.id('1', 'a6'), 'presence_receipts', now(), pg_temp.id('1', 'a5'));
-- A lift is recorded once (keep_history), and the lifted and its lifter go together.
update public.processing_restrictions set lifted_at = now(), lifted_by = pg_temp.id('1', 'a5') where id = pg_temp.id('1', 'e4');
select pg_temp.expect_error($$update public.processing_restrictions set lifted_at = now() - interval '1 day'
  where id = 'f1000000-0000-4000-8000-0000000000e4'$$, '23514', '%already ended%');
select pg_temp.expect_error($$update public.processing_restrictions set lifted_at = null, lifted_by = null
  where id = 'f1000000-0000-4000-8000-0000000000e4'$$, '23514', '%already ended%');
select pg_temp.expect_error($$update public.processing_restrictions set lifted_at = now()
  where person_id = 'f1000000-0000-4000-8000-0000000000a7' and purpose = 'presence_receipts'$$, '23514',
  '%processing_restrictions_lifted%');
-- With a8's lifted, a7's and a6's are still live: the basis still can't leave.
select pg_temp.act_as('1', 'a5');
select pg_temp.expect_error($$select * from pg_temp.set_purpose('presence_receipts', 3, 'active', 'employment', null, null, 'A year', '{}')$$,
                            'HF006', 'Withdrawals are recorded%');
reset role;
-- Once every one is lifted it may, and the hook then refuses a new one.
update public.processing_restrictions set lifted_at = now(), lifted_by = pg_temp.id('1', 'a5')
where org_id = pg_temp.id('1', '00') and lifted_at is null;
select pg_temp.act_as('1', 'a5');
select pg_temp.check(changed and version = 4, 'leaving consent with no restriction live was refused')
from pg_temp.set_purpose('presence_receipts', 3, 'active', 'employment', null, null, 'A year', '{}');
reset role;
select pg_temp.expect_error($$insert into public.processing_restrictions (org_id, person_id, purpose, effective_at, created_by)
  values ('f1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-0000000000a8', 'presence_receipts', now(),
          'f1000000-0000-4000-8000-0000000000a5')$$, '23514', 'A processing switch applies only%');
-- Org 2's live restriction (its e4) is untouched by all of this.
select pg_temp.check(count(*) = 1 and bool_and(lifted_at is null), 'org 1''s changes reached org 2''s restriction')
from public.processing_restrictions where org_id = pg_temp.id('2', '00');
