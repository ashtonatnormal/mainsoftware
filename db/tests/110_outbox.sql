-- INF-OUTBOX, T16, CLAUDE.md Database: the outbox (0007). hearth_app appends ids-only events in its
-- own org, as the principal its transaction acts as (or, when Hearth acts, as whoever it names);
-- each consumer moves only its own checkpoint; hearth_queue sees positions and times, never the
-- envelope; nobody deletes an event but purge_outbox(), which deletes by position after 14 days and
-- records the floor. Every case runs as hearth_app or the job role it tests unless it says it
-- arranges data as the superuser.
\ir fixtures/two_orgs.sql

-- An event in org 1 as hearth_app acting as `actor` (its app.user_id), naming `named` as the
-- event's actor, with `ids`.
create function pg_temp.append(actor text, named text, kind text, ids text) returns text language sql as $$
  select format($i$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, subject_ids, purpose, ids)
    values ('f1000000-0000-4000-8000-000000000000', 'signin.started', 'person', 'f1000000-0000-4000-8000-0000000000a8',
            %L, %L, '{f1000000-0000-4000-8000-0000000000a8}', 'accounts', %L)$i$,
    pg_temp.id('1', named), kind, ids)
$$;

-- 1. hearth_app appends in its own org, and not in another (42501).
select pg_temp.act_as('1', 'a8');
select pg_temp.expect_rows(pg_temp.append('a8', 'a8', 'human',
  '{"device": "f1000000-0000-4000-8000-0000000000e1", "session": "f1000000-0000-4000-8000-0000000000e2", "method": "sms_pin"}'), 1);
select pg_temp.expect_error($$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose)
  values ('f2000000-0000-4000-8000-000000000000', 'signin.started', 'person', 'f2000000-0000-4000-8000-0000000000a8',
          'f1000000-0000-4000-8000-0000000000a8', 'human', 'accounts')$$, '42501');
reset role;

-- 2. The actor's kind is its principal's (23503), and the actor is the principal the transaction
-- acts as: a person can't name someone else, and with nobody acting nobody can be named (42501).
-- Only Hearth, acting before a session exists or in a job, names whoever the event is about.
select pg_temp.act_as('1', 'a8');
select pg_temp.expect_error(pg_temp.append('a8', 'a8', 'system', '{}'), '23503', '%outbox_events_org_id_actor_id_actor_kind_fkey%');
select pg_temp.expect_error(pg_temp.append('a8', 'a1', 'human', '{}'), '42501', '%actor must be the principal acting%');
reset role;
select pg_temp.act_as('1', 'ab');
select pg_temp.expect_error(pg_temp.append('ab', 'a8', 'human', '{}'), '42501', '%actor must be the principal acting%');
select pg_temp.expect_rows(pg_temp.append('ab', 'ab', 'agent', '{}'), 1);
reset role;
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', '', true);
set local role hearth_app;
select pg_temp.expect_error(pg_temp.append('a8', 'a8', 'human', '{}'), '42501', '%actor must be the principal acting%');
reset role;
select pg_temp.act_as('1', 'a0');
select pg_temp.expect_rows(pg_temp.append('a0', 'a8', 'human', '{}'), 1);
select pg_temp.expect_rows(pg_temp.append('a0', 'a0', 'system', '{}'), 1);
reset role;
-- Hearth of org 2 is nobody in org 1.
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', pg_temp.id('2', 'a0')::text, true);
set local role hearth_app;
select pg_temp.expect_error(pg_temp.append('a0', 'a8', 'human', '{}'), '42501', '%actor must be the principal acting%');
reset role;

-- 3. ids hold ids only (is_ids_only): uuids, codes, whole numbers 0 to 1,000,000, booleans and
-- lists of up to 100 uuids. Everything that most often carries someone's details is refused (23514).
select pg_temp.act_as('1', 'a8');
select pg_temp.expect_rows(pg_temp.append('a8', 'a8', 'human',
  '{"session": "f1000000-0000-4000-8000-0000000000e2", "reason": "device_sign_out", "count": 1000000, "zero": 0,
    "ok": true, "sessions": ["f1000000-0000-4000-8000-0000000000e2", "f2000000-0000-4000-8000-0000000000e2"], "none": []}'), 1);
do $$
declare
  bad text;
begin
  foreach bad in array array[
    '{"name": "Mel Member"}',                    -- a name
    '{"name": "mel member"}',                    -- a phrase, even in lower case
    '{"phone": "+6591234567"}',                  -- a phone number as text
    '{"phone": 91234567}',                       -- or as a number
    '{"n": -1}', '{"n": 1.5}', '{"n": 1000001}', -- numbers out of range
    '{"reason": "Deactivated"}',                 -- upper case
    '{"code": "' || repeat('a', 64) || '"}',     -- a code of 64 characters
    '{"chars": [72, 101, 108, 108, 111]}',       -- text spelled out as numbers
    '{"codes": ["abc", "def"]}',                 -- a list of codes, not ids
    '{"nested": {"session": "f1000000-0000-4000-8000-0000000000e2"}}',
    '{"lists": [["f1000000-0000-4000-8000-0000000000e2"]]}',
    '{"missing": null}',
    '{"Mel Member, +65 9123 4567, diagnosed with depression": true}', -- free text as a key (SQL-1)
    '{"Session": "f1000000-0000-4000-8000-0000000000e2"}',              -- a key not a code
    '{"' || repeat('k', 64) || '": true}',                              -- a key of 64 characters
    '{"many": [' || (select string_agg('"f1000000-0000-4000-8000-0000000000e2"', ',') from generate_series(1, 101)) || ']}',
    '[]', '"f1000000-0000-4000-8000-0000000000e2"'
  ] loop
    perform pg_temp.expect_error(pg_temp.append('a8', 'a8', 'human', bad), '23514', '%outbox_events_ids_only%');
  end loop;
end
$$;
-- A 63-character code passes.
select pg_temp.expect_rows(pg_temp.append('a8', 'a8', 'human', '{"code": "' || repeat('a', 63) || '"}'), 1);

-- 4. An unknown type, a partial ACL snapshot, a container without its id (23514).
select pg_temp.expect_error($$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'person.renamed', 'person', 'f1000000-0000-4000-8000-0000000000a8',
          'f1000000-0000-4000-8000-0000000000a8', 'human', 'accounts')$$, '23514', '%outbox_events_type%');
select pg_temp.expect_error($$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose, acl_tokens, index_class, acl_epoch)
  values ('f1000000-0000-4000-8000-000000000000', 'signin.started', 'person', 'f1000000-0000-4000-8000-0000000000a8',
          'f1000000-0000-4000-8000-0000000000a8', 'human', 'accounts', '{p:f1000000-0000-4000-8000-0000000000a8}', 'normal', 1)$$,
  '23514', '%outbox_events_acl_whole%');
select pg_temp.expect_error($$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose, container_type)
  values ('f1000000-0000-4000-8000-000000000000', 'signin.started', 'person', 'f1000000-0000-4000-8000-0000000000a8',
          'f1000000-0000-4000-8000-0000000000a8', 'human', 'accounts', 'channel')$$, '23514');
select pg_temp.expect_error($$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose, subject_ids)
  values ('f1000000-0000-4000-8000-000000000000', 'signin.started', 'person', 'f1000000-0000-4000-8000-0000000000a8',
          'f1000000-0000-4000-8000-0000000000a8', 'human', 'accounts', array[null]::uuid[])$$, '23514');
-- A snapshot holds only the tokens @hearth/access makes (SQL-1): free text, a token with another
-- prefix or an upper-case id, a null in more, or more that isn't a list of token lists is refused.
do $$
declare
  bad text[];
begin
  foreach bad slice 1 in array array[
    array['{"Mel Member said: I quit"}', '[]', 'outbox_events_acl_tokens'],
    array['{x:f1000000-0000-4000-8000-0000000000a8}', '[]', 'outbox_events_acl_tokens'],
    array['{p:F1000000-0000-4000-8000-0000000000A8}', '[]', 'outbox_events_acl_tokens'],
    array['{p:f1000000-0000-4000-8000-0000000000a8,NULL}', '[]', 'outbox_events_acl_tokens'],
    array['{p:f1000000-0000-4000-8000-0000000000a8}', '[{"note": "free text here"}]', 'outbox_events_acl_more'],
    array['{p:f1000000-0000-4000-8000-0000000000a8}', '["p:f1000000-0000-4000-8000-0000000000a8"]', 'outbox_events_acl_more'],
    array['{p:f1000000-0000-4000-8000-0000000000a8}', '[["Mel Member said: I quit"]]', 'outbox_events_acl_more'],
    array['{p:f1000000-0000-4000-8000-0000000000a8}', '[[null]]', 'outbox_events_acl_more'],
    array['{p:f1000000-0000-4000-8000-0000000000a8}', '{"p": "f1000000-0000-4000-8000-0000000000a8"}', 'outbox_events_acl_more'],
    array['{p:f1000000-0000-4000-8000-0000000000a8}', '"free text"', 'outbox_events_acl_more']
  ] loop
    perform pg_temp.expect_error(format($i$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose, acl_tokens, acl_more, index_class, acl_epoch)
      values ('f1000000-0000-4000-8000-000000000000', 'signin.started', 'person', 'f1000000-0000-4000-8000-0000000000a8',
              'f1000000-0000-4000-8000-0000000000a8', 'human', 'accounts', %L, %L, 'normal', 1)$i$, bad[1], bad[2]),
      '23514', '%' || bad[3] || '%');
  end loop;
end
$$;
-- A whole snapshot passes, an empty one (nobody) and one with further clauses of every token kind too.
select pg_temp.expect_rows($$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose, acl_tokens, acl_more, index_class, acl_epoch)
  values ('f1000000-0000-4000-8000-000000000000', 'signin.started', 'person', 'f1000000-0000-4000-8000-0000000000a8',
          'f1000000-0000-4000-8000-0000000000a8', 'human', 'accounts', '{}', '[]', 'normal', 1),
         ('f1000000-0000-4000-8000-000000000000', 'signin.started', 'person', 'f1000000-0000-4000-8000-0000000000a8',
          'f1000000-0000-4000-8000-0000000000a8', 'human', 'accounts',
          '{o:f1000000-0000-4000-8000-000000000000,t:f1000000-0000-4000-8000-0000000000d1}',
          '[["ta:f1000000-0000-4000-8000-0000000000d1", "m:f1000000-0000-4000-8000-0000000000d1"], ["e:f1000000-0000-4000-8000-0000000000d1", "p:f1000000-0000-4000-8000-0000000000a8"], []]',
          'normal', 1)$$, 2);
select pg_temp.expect_rows($$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose, acl_tokens, acl_more, index_class, acl_epoch)
  values ('f1000000-0000-4000-8000-000000000000', 'signin.started', 'person', 'f1000000-0000-4000-8000-0000000000a8',
          'f1000000-0000-4000-8000-0000000000a8', 'human', 'accounts', '{p:f1000000-0000-4000-8000-0000000000a8}', '[]', 'normal', 1)$$, 1);
reset role;

-- 5. hearth_job_offboarding reads its own org's events, all of them, and nothing of another org's.
select set_config('test.org1_events', (select count(*)::text from public.outbox_events where org_id = pg_temp.id('1', '00')), true);
select pg_temp.act_as_job('1', 'hearth_job_offboarding');
select pg_temp.check((select count(*) from public.outbox_events) = current_setting('test.org1_events')::bigint
                     and (select count(*) from public.outbox_events where org_id <> pg_temp.id('1', '00')) = 0,
                     'hearth_job_offboarding did not see exactly its org''s events');
select pg_temp.check((select count(*) from public.outbox_events where subject_ids @> array[pg_temp.id('1', 'a8')]) > 0,
                     'hearth_job_offboarding could not read the envelope');
select pg_temp.expect_error($$delete from public.outbox_events$$, '42501');
select pg_temp.expect_error($$update public.outbox_events set purpose = 'accounts'$$, '42501');
reset role;
-- So does the revocation consumer's role (0008), which reads the same envelope (its sessions and
-- subjects) and can't change or remove an event either.
select pg_temp.act_as_job('1', 'hearth_job_revocation');
select pg_temp.check((select count(*) from public.outbox_events) = current_setting('test.org1_events')::bigint
                     and (select count(*) from public.outbox_events where org_id <> pg_temp.id('1', '00')) = 0,
                     'hearth_job_revocation did not see exactly its org''s events');
select pg_temp.check((select count(*) from public.outbox_events where subject_ids @> array[pg_temp.id('1', 'a8')]) > 0,
                     'hearth_job_revocation could not read the envelope');
select pg_temp.expect_error($$delete from public.outbox_events$$, '42501');
select pg_temp.expect_error($$update public.outbox_events set purpose = 'accounts'$$, '42501');
select pg_temp.expect_error($$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'signin.ended', 'person', 'f1000000-0000-4000-8000-0000000000a8',
          'f1000000-0000-4000-8000-0000000000a0', 'system', 'accounts')$$, '42501');
reset role;

-- 6. hearth_queue sees positions and times, for the lag metric and the restore check, never the
-- envelope; and it deletes nothing.
select pg_temp.act_as_job('1', 'hearth_queue');
select pg_temp.check((select count(*) from (select org_id, id, tx_id, at from public.outbox_events) e)
                     = current_setting('test.org1_events')::bigint, 'hearth_queue did not see its org''s positions');
select pg_temp.expect_error($$select subject_ids from public.outbox_events$$, '42501');
select pg_temp.expect_error($$select ids from public.outbox_events$$, '42501');
select pg_temp.expect_error($$select * from public.outbox_events$$, '42501');
select pg_temp.expect_error($$delete from public.outbox_events$$, '42501');
select pg_temp.expect_error($$insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose)
  values ('f1000000-0000-4000-8000-000000000000', 'flag.changed', 'feature_flag', 'f1000000-0000-4000-8000-0000000000a8',
          'f1000000-0000-4000-8000-0000000000a0', 'system', 'service_operation')$$, '42501');
reset role;

-- 7. Checkpoints: each is moved only by the role it names (outbox_checkpoints_own_row). The
-- offboarding consumer's role starts and moves its own; it can't start one in another role's name,
-- or in the name of a role that doesn't exist, or move one that names another role (42501).
select pg_temp.act_as_job('1', 'hearth_job_offboarding');
select pg_temp.expect_rows($$insert into public.outbox_checkpoints (org_id, consumer, role_name, last_tx, last_id)
  values ('f1000000-0000-4000-8000-000000000000', 'second', 'hearth_job_offboarding', '0', 0)$$, 1);
select pg_temp.expect_rows($$update public.outbox_checkpoints set last_tx = '5', last_id = 7, processed = processed + 2, updated_at = now()
  where consumer = 'offboarding'$$, 1);
select pg_temp.expect_error($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f1000000-0000-4000-8000-000000000000', 'planted', 'hearth_queue')$$, '42501', '%Only the role that runs a consumer%');
select pg_temp.expect_error($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f1000000-0000-4000-8000-000000000000', 'planted', 'hearth_job_nobody')$$, '42501', '%Only the role that runs a consumer%');
select pg_temp.expect_error($$update public.outbox_checkpoints set role_name = 'hearth_queue' where consumer = 'offboarding'$$, '42501');
select pg_temp.expect_error($$delete from public.outbox_checkpoints$$, '42501');
reset role;
-- A checkpoint the purge job's role runs (arranged as the superuser, who may act as any role):
-- the offboarding role, which may update checkpoints, can't move it.
insert into public.outbox_checkpoints (org_id, consumer, role_name) values (pg_temp.id('1', '00'), 'purge_side', 'hearth_job_purge');
select pg_temp.act_as_job('1', 'hearth_job_offboarding');
select pg_temp.expect_error($$update public.outbox_checkpoints set last_id = 9 where consumer = 'purge_side'$$, '42501',
                            '%Only the role that runs a consumer%');
reset role;
-- Nor does a checkpoint change hands, even for the superuser.
select pg_temp.expect_error($$update public.outbox_checkpoints set role_name = 'hearth_queue' where consumer = 'offboarding'
  and org_id = 'f1000000-0000-4000-8000-000000000000'$$, '42501', '%Only the role that runs a consumer%');
-- hearth_queue reads checkpoints but moves none; hearth_worker, with no role taken, touches nothing.
select pg_temp.act_as_job('1', 'hearth_queue');
select pg_temp.check((select count(*) from public.outbox_checkpoints) = 3, 'hearth_queue did not see its org''s checkpoints');
select pg_temp.expect_error($$update public.outbox_checkpoints set last_id = 9$$, '42501');
reset role;
select pg_temp.act_as_job('1', 'hearth_worker');
select pg_temp.expect_error($$select count(*) from public.outbox_checkpoints$$, '42501');
select pg_temp.expect_error($$select count(*) from public.outbox_events$$, '42501');
reset role;

-- 7b. The revocation consumer's role (0008) starts and moves its own checkpoint, and no other: not
-- offboarding's, whether named or reached by an update that names no consumer (42501); nor may
-- offboarding's role move the revocation checkpoint. After 7, so hearth_queue's count there holds.
select pg_temp.act_as_job('1', 'hearth_job_revocation');
select pg_temp.expect_rows($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f1000000-0000-4000-8000-000000000000', 'revocation', 'hearth_job_revocation')$$, 1);
select pg_temp.expect_rows($$update public.outbox_checkpoints set last_tx = '5', last_id = 7, processed = processed + 2, updated_at = now()
  where consumer = 'revocation'$$, 1);
select pg_temp.expect_error($$update public.outbox_checkpoints set last_id = 9 where consumer = 'offboarding'$$, '42501',
                            '%Only the role that runs a consumer%');
select pg_temp.expect_error($$update public.outbox_checkpoints set last_id = 9$$, '42501', '%Only the role that runs a consumer%');
select pg_temp.expect_error($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f1000000-0000-4000-8000-000000000000', 'planted', 'hearth_job_offboarding')$$, '42501', '%Only the role that runs a consumer%');
select pg_temp.expect_error($$delete from public.outbox_checkpoints$$, '42501');
reset role;
select pg_temp.act_as_job('1', 'hearth_job_offboarding');
select pg_temp.expect_error($$update public.outbox_checkpoints set last_id = 9 where consumer = 'revocation'$$, '42501',
                            '%Only the role that runs a consumer%');
reset role;
select pg_temp.check(last_tx = '5' and last_id = 7 and processed = 2, 'the revocation checkpoint did not hold its own move alone')
from public.outbox_checkpoints where org_id = pg_temp.id('1', '00') and consumer = 'revocation';
select pg_temp.check(last_id <> 9, 'another role moved the offboarding checkpoint')
from public.outbox_checkpoints where org_id = pg_temp.id('1', '00') and consumer = 'offboarding';

-- 7c. Each consumer the server runs is bound to its role (0008): in an org where a consumer has no
-- checkpoint yet, the other consumer's role can't start it under its own role name, so it can't
-- plant the position the consumer would read from, or keep the consumer from moving it (42501).
-- Org 2, with its offboarding checkpoint removed as the superuser, has neither consumer's yet.
-- Nobody pairs a bound consumer with another role, the superuser included, and each role still
-- starts and moves its own.
delete from public.outbox_checkpoints where org_id = pg_temp.id('2', '00') and consumer = 'offboarding';
select pg_temp.act_as_job('2', 'hearth_job_revocation');
select pg_temp.expect_error($$insert into public.outbox_checkpoints (org_id, consumer, role_name, last_tx, last_id)
  values ('f2000000-0000-4000-8000-000000000000', 'offboarding', 'hearth_job_revocation', '1000000', 999999)$$, '42501',
  '%Only the role that runs a consumer%');
reset role;
select pg_temp.act_as_job('2', 'hearth_job_offboarding');
select pg_temp.expect_error($$insert into public.outbox_checkpoints (org_id, consumer, role_name, last_tx, last_id)
  values ('f2000000-0000-4000-8000-000000000000', 'revocation', 'hearth_job_offboarding', '1000000', 999999)$$, '42501',
  '%Only the role that runs a consumer%');
reset role;
select pg_temp.expect_error($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f2000000-0000-4000-8000-000000000000', 'revocation', 'hearth_job_purge')$$, '42501', '%Only the role that runs a consumer%');
select pg_temp.act_as_job('2', 'hearth_job_offboarding');
select pg_temp.expect_rows($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f2000000-0000-4000-8000-000000000000', 'offboarding', 'hearth_job_offboarding')$$, 1);
select pg_temp.expect_rows($$update public.outbox_checkpoints set last_id = 2 where consumer = 'offboarding'$$, 1);
reset role;
select pg_temp.act_as_job('2', 'hearth_job_revocation');
select pg_temp.expect_rows($$insert into public.outbox_checkpoints (org_id, consumer, role_name)
  values ('f2000000-0000-4000-8000-000000000000', 'revocation', 'hearth_job_revocation')$$, 1);
select pg_temp.expect_rows($$update public.outbox_checkpoints set last_id = 3 where consumer = 'revocation'$$, 1);
reset role;
select pg_temp.check(count(*) = 2 and bool_and(role_name = 'hearth_job_' || consumer and last_tx = '0'
                                              and last_id = case consumer when 'offboarding' then 2 else 3 end),
                     'a consumer''s org 2 checkpoint was started by another role, or not moved by its own')
from public.outbox_checkpoints where org_id = pg_temp.id('2', '00');
-- A row that broke the binding before 0008 (planted here as the superuser with triggers off, since
-- nobody can plant one now): the role it names can't move it either.
set local session_replication_role = replica;
update public.outbox_checkpoints set role_name = 'hearth_job_offboarding'
where org_id = pg_temp.id('2', '00') and consumer = 'revocation';
set local session_replication_role = origin;
select pg_temp.act_as_job('2', 'hearth_job_offboarding');
select pg_temp.expect_error($$update public.outbox_checkpoints set last_id = 9 where consumer = 'revocation'$$, '42501',
                            '%Only the role that runs a consumer%');
reset role;

-- 8. Nobody deletes an event directly, the purge job's role included (42501): rows leave only
-- through purge_outbox().
select pg_temp.act_as_job('1', 'hearth_job_purge');
select pg_temp.expect_error($$delete from public.outbox_events$$, '42501');
select pg_temp.expect_error($$select count(*) from public.outbox_events$$, '42501');
reset role;

-- 9. purge_outbox(). Arranged as the superuser: org 1's events from transactions that have ended
-- (positions below every running transaction: small xids, as Postgres numbers them from 3), some
-- older than 14 days. e1 (xid 5) and e3 (xid 7) are 15 days old; e2 (xid 6) and e4 (xid 8) one day
-- old. e5 is 15 days old but was written by this test's own transaction, which hasn't ended, and so
-- were the events above. Org 2 has a 15-day-old event too.
select set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
insert into public.outbox_events (org_id, tx_id, at, type, entity_type, entity_id, actor_id, actor_kind, purpose, ids)
select pg_temp.id('1', '00'), e.tx::xid8, now() - e.age, 'flag.changed', 'feature_flag', gen_random_uuid(), pg_temp.id('1', 'a0'),
       'system', 'service_operation', jsonb_build_object('key', e.name)
from (values ('e1', '5', interval '15 days'), ('e2', '6', interval '1 day'), ('e3', '7', interval '15 days'),
             ('e4', '8', interval '1 day')) as e (name, tx, age);
insert into public.outbox_events (org_id, at, type, entity_type, entity_id, actor_id, actor_kind, purpose, ids)
values (pg_temp.id('1', '00'), now() - interval '15 days', 'flag.changed', 'feature_flag', gen_random_uuid(), pg_temp.id('1', 'a0'),
        'system', 'service_operation', '{"key": "e5"}');
select set_config('app.user_id', pg_temp.id('2', 'a0')::text, true);
insert into public.outbox_events (org_id, tx_id, at, type, entity_type, entity_id, actor_id, actor_kind, purpose, ids)
values (pg_temp.id('2', '00'), '4', now() - interval '15 days', 'flag.changed', 'feature_flag', gen_random_uuid(), pg_temp.id('2', 'a0'),
        'system', 'service_operation', '{"key": "o2"}');
select set_config('test.org1_events', (select count(*)::text from public.outbox_events where org_id = pg_temp.id('1', '00')), true);
select set_config('test.e3', (select id::text from public.outbox_events where ids ->> 'key' = 'e3'), true);
select set_config('test.e2', (select id::text from public.outbox_events where ids ->> 'key' = 'e2'), true);
select set_config('test.audit_max', (select coalesce(max(id), 0)::text from public.audit_events), true);

-- The batch and the org are checked first: no org or no acting principal (42501), a batch outside 1
-- to 10,000 (22023). Nobody but the purge job's role may call it.
select set_config('app.org_id', '', true), set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
set local role hearth_job_purge;
select pg_temp.expect_error($$select public.purge_outbox(10)$$, '42501');
reset role;
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', '', true);
set local role hearth_job_purge;
select pg_temp.expect_error($$select public.purge_outbox(10)$$, '42501');
reset role;
-- Only Hearth itself cleans up (SQL-4): with a person (the DPO) or another org's Hearth as the
-- transaction's principal, the purge job's role is refused (42501), so the audit row can't name them.
select set_config('app.org_id', pg_temp.id('1', '00')::text, true), set_config('app.user_id', pg_temp.id('1', 'a5')::text, true);
set local role hearth_job_purge;
select pg_temp.expect_error($$select public.purge_outbox(10)$$, '42501', 'Only Hearth itself cleans up%');
reset role;
select set_config('app.user_id', pg_temp.id('2', 'a0')::text, true);
set local role hearth_job_purge;
select pg_temp.expect_error($$select public.purge_outbox(10)$$, '42501', 'Only Hearth itself cleans up%');
reset role;
select pg_temp.act_as_job('1', 'hearth_job_purge');
select pg_temp.expect_error($$select public.purge_outbox(0)$$, '22023');
select pg_temp.expect_error($$select public.purge_outbox(10001)$$, '22023');
select pg_temp.expect_error($$select public.purge_outbox(null)$$, '22023');
reset role;
do $$
declare
  r text;
begin
  foreach r in array array['hearth_app', 'hearth_queue', 'hearth_job_offboarding', 'hearth_job_partitions', 'hearth_job_revocation',
                           'hearth_worker'] loop
    perform set_config('role', r, true);
    perform pg_temp.expect_error('select public.purge_outbox(10)', '42501');
    perform set_config('role', 'none', true);
  end loop;
end
$$;

-- A batch of 2 takes the lowest positions first: e1, then e2, which is young but lies below the
-- edge (e3, the furthest old event whose transaction has ended), so the floor stays exact. The
-- floor moves to the last one deleted, and one audit row records the batch.
select pg_temp.act_as_job('1', 'hearth_job_purge');
select pg_temp.check(public.purge_outbox(2) = 2, 'the first batch did not delete two events');
reset role;
select pg_temp.check((select string_agg(ids ->> 'key', ',' order by tx_id, id) from public.outbox_events
                      where org_id = pg_temp.id('1', '00') and ids ->> 'key' like 'e%') = 'e3,e4,e5',
                     'the first batch did not delete e1 and e2 by position');
select pg_temp.check(last_tx = '6' and last_id = current_setting('test.e2')::bigint, format('the floor is at (%s, %s), not e2', last_tx, last_id))
from public.outbox_floors where org_id = pg_temp.id('1', '00');
-- The rest of the batch up to the edge, then nothing more: e4 is young and above the edge, and e5
-- and the other events of this test's transaction are above every running transaction.
select pg_temp.act_as_job('1', 'hearth_job_purge');
select pg_temp.check(public.purge_outbox(5000) = 1, 'the second batch did not delete only e3');
select pg_temp.check(public.purge_outbox(5000) = 0, 'a third batch deleted something');
reset role;
select pg_temp.check((select string_agg(ids ->> 'key', ',' order by tx_id, id) from public.outbox_events
                      where org_id = pg_temp.id('1', '00') and ids ->> 'key' like 'e%') = 'e4,e5',
                     'the purge did not stop at the edge');
select pg_temp.check((select count(*) from public.outbox_events where org_id = pg_temp.id('1', '00'))
                     = current_setting('test.org1_events')::bigint - 3, 'the purge deleted an event it should have kept');
select pg_temp.check((select count(*) from public.outbox_events where org_id = pg_temp.id('2', '00') and ids ->> 'key' = 'o2') = 1,
                     'the purge reached another org');
select pg_temp.check(last_tx = '7' and last_id = current_setting('test.e3')::bigint, format('the floor is at (%s, %s), not e3', last_tx, last_id))
from public.outbox_floors where org_id = pg_temp.id('1', '00');
select pg_temp.check((select last_tx from public.outbox_floors where org_id = pg_temp.id('2', '00')) = '0',
                     'the purge moved another org''s floor');
-- One audit row per batch that deleted something, with Hearth as the actor, naming how many rows
-- and the floor, and nothing else.
select pg_temp.check(array_agg(format('%s %s %s %s %s', org_id = pg_temp.id('1', '00'), action, actor_id = pg_temp.id('1', 'a0'),
                                       target_type, target_id = pg_temp.id('1', '00')::text) order by id)
                     = array['t maintenance.purge t outbox_events t', 't maintenance.purge t outbox_events t']
                     and array_agg(details order by id) = array[
                       jsonb_build_object('rows', 2, 'floor_tx', '6', 'floor_id', current_setting('test.e2')::bigint),
                       jsonb_build_object('rows', 1, 'floor_tx', '7', 'floor_id', current_setting('test.e3')::bigint)],
                     format('the purge did not write one audit row per batch, with Hearth acting: %s', array_agg(details order by id)))
from public.audit_events where id > current_setting('test.audit_max')::bigint;

-- The floor only moves forward: an old event that turns up below it (a restore, say) is deleted,
-- and the floor stays where it was.
select set_config('app.user_id', pg_temp.id('1', 'a0')::text, true);
insert into public.outbox_events (org_id, tx_id, at, type, entity_type, entity_id, actor_id, actor_kind, purpose, ids)
values (pg_temp.id('1', '00'), '3', now() - interval '20 days', 'flag.changed', 'feature_flag', gen_random_uuid(), pg_temp.id('1', 'a0'),
        'system', 'service_operation', '{"key": "e0"}');
select pg_temp.act_as_job('1', 'hearth_job_purge');
select pg_temp.check(public.purge_outbox(5000) = 1, 'the purge did not delete the old event below the floor');
reset role;
select pg_temp.check(last_tx = '7' and last_id = current_setting('test.e3')::bigint, format('the floor moved back to (%s, %s)', last_tx, last_id))
from public.outbox_floors where org_id = pg_temp.id('1', '00');

-- With no floor yet (org 2's is removed as the superuser), the first batch writes one.
delete from public.outbox_floors where org_id = pg_temp.id('2', '00');
select pg_temp.act_as_job('2', 'hearth_job_purge');
select pg_temp.check(public.purge_outbox(5000) = 1, 'org 2''s old event was not deleted');
reset role;
select pg_temp.check((select last_tx from public.outbox_floors where org_id = pg_temp.id('2', '00')) = '4',
                     'the purge did not write org 2''s floor');
