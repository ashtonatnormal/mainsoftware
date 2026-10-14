-- ACC-01, ACC-02, ACC-04, ACC-05, ACC-06, PRD-53, T5, T14, CLAUDE.md Database: what sign-in stores
-- (0006) and the two lookups that run before the org is known. The lookups take no acting user,
-- so there are no ACC-10 role cases: they must work with no org set and ignore one that is set.
-- Every case runs as hearth_app (set local role, or pg_temp.act_as) unless it says it arranges
-- data as the superuser; session_replication_role = replica turns triggers off, to set up a state
-- the triggers would otherwise never leave behind.
\ir fixtures/two_orgs.sql

-- What each lookup returns, as text, so a case can compare a whole result with what it expects.
-- They run as whoever calls them.
create function pg_temp.sessions_for(token bytea, max_idle interval) returns text[] language sql as $$
  select coalesce(array_agg(format('%s %s %s %s', s.session_id, s.org_id, s.user_id, s.device_id) order by s.session_id), '{}')
  from public.session_by_token(token, max_idle) s
$$;
create function pg_temp.people_for(e164 text) returns text[] language sql as $$
  select coalesce(array_agg(format('%s %s %s', p.phone_number_id, p.org_id, p.person_id) order by p.org_id), '{}')
  from public.person_by_phone(e164) p
$$;
-- No org and no user set, as before sign-in.
create function pg_temp.no_org() returns void language sql as $$
  select set_config('app.org_id', '', true), set_config('app.user_id', '', true), set_config('role', 'hearth_app', true)
$$;

-- The fixture's current numbers, which have random ids, read as the superuser for the cases to
-- compare with: org 1's a8 and a9 (who has left), and org 2's a8.
select set_config('test.number_1_a8', id::text, true) from public.phone_numbers
where org_id = pg_temp.id('1', '00') and e164 = '+6510000008' and removed_at is null;
select set_config('test.number_1_a9', id::text, true) from public.phone_numbers
where org_id = pg_temp.id('1', '00') and e164 = '+6510000009' and removed_at is null;
select set_config('test.number_2_a8', id::text, true) from public.phone_numbers
where org_id = pg_temp.id('2', '00') and e164 = '+6520000008' and removed_at is null;
-- The fixture's org 1 session e2, on a8's device e1.
select set_config('test.token_1', encode(decode(md5('session 1') || md5('token 1'), 'hex'), 'hex'), true);
select set_config('test.session_1',
  format('%s %s %s %s', pg_temp.id('1', 'e2'), pg_temp.id('1', '00'), pg_temp.id('1', 'a8'), pg_temp.id('1', 'e1')), true);
-- A PIN hash in the one shape the server issues (argon2id, m=19456, t=2, p=1).
select set_config('test.pin_hash', '$argon2id$v=19$m=19456,t=2,p=1$' || repeat('A', 22) || '$' || repeat('B', 43), true);

-- 1. person_by_phone with no org set: a current number names its org and person, whichever org
-- holds it; a removed number names nobody; someone who has left is still found (the server
-- decides what to do with them, in the org's own transaction, so the attempt can be audited).
select pg_temp.no_org();
select pg_temp.check(pg_temp.people_for('+6510000008') =
                     array[format('%s %s %s', current_setting('test.number_1_a8'), pg_temp.id('1', '00'), pg_temp.id('1', 'a8'))],
                     'person_by_phone did not find org 1''s a8 with no org set');
select pg_temp.check(pg_temp.people_for('+6520000008') =
                     array[format('%s %s %s', current_setting('test.number_2_a8'), pg_temp.id('2', '00'), pg_temp.id('2', 'a8'))],
                     'person_by_phone did not find org 2''s a8');
select pg_temp.check(pg_temp.people_for('+6519999999') = '{}', 'person_by_phone found a removed number');
select pg_temp.check(pg_temp.people_for('+6510000009') =
                     array[format('%s %s %s', current_setting('test.number_1_a9'), pg_temp.id('1', '00'), pg_temp.id('1', 'a9'))],
                     'person_by_phone did not find the current number of someone who has left');
select pg_temp.check(pg_temp.people_for('not a number') = '{}', 'person_by_phone found something for a non-number');
select pg_temp.check(pg_temp.people_for(null) = '{}', 'person_by_phone found something for null');

-- 2. The org and user the server sets are ignored: acting in org 2, org 1's number is still found.
select pg_temp.act_as('2', 'a1');
select pg_temp.check(pg_temp.people_for('+6510000008') =
                     array[format('%s %s %s', current_setting('test.number_1_a8'), pg_temp.id('1', '00'), pg_temp.id('1', 'a8'))],
                     'person_by_phone used the org set in the transaction');
reset role;

-- 3. A number current in two orgs returns both (the server then treats it as not on the roster).
-- Org 2's aa gives up their own number first, since a person has one current number.
update public.phone_numbers set removed_at = now(), removed_by = pg_temp.id('2', 'a1')
where org_id = pg_temp.id('2', '00') and person_id = pg_temp.id('2', 'aa') and removed_at is null;
insert into public.phone_numbers (org_id, person_id, e164, created_by)
values (pg_temp.id('2', '00'), pg_temp.id('2', 'aa'), '+6510000001', pg_temp.id('2', 'a1'));
select pg_temp.no_org();
select pg_temp.check(cardinality(pg_temp.people_for('+6510000001')) = 2
                     and (pg_temp.people_for('+6510000001'))[1] like format('%% %s %s', pg_temp.id('1', '00'), pg_temp.id('1', 'a1'))
                     and (pg_temp.people_for('+6510000001'))[2] like format('%% %s %s', pg_temp.id('2', '00'), pg_temp.id('2', 'aa')),
                     'person_by_phone did not return both orgs'' rows for a number current in both');
reset role;
-- Any country's number works the same way (the owner's decision, 2026-10-13: team members live
-- overseas). Org 1's aa moves to a Malaysian number.
update public.phone_numbers set removed_at = now(), removed_by = pg_temp.id('1', 'a1')
where org_id = pg_temp.id('1', '00') and person_id = pg_temp.id('1', 'aa') and removed_at is null;
insert into public.phone_numbers (org_id, person_id, e164, created_by)
values (pg_temp.id('1', '00'), pg_temp.id('1', 'aa'), '+60123456789', pg_temp.id('1', 'a1'));
select pg_temp.no_org();
select pg_temp.check(cardinality(pg_temp.people_for('+60123456789')) = 1
                     and (pg_temp.people_for('+60123456789'))[1] like format('%% %s %s', pg_temp.id('1', '00'), pg_temp.id('1', 'aa')),
                     'person_by_phone did not find an overseas number');
select pg_temp.check(pg_temp.people_for('+6510000010') = '{}', 'person_by_phone found aa''s old number');
reset role;

-- 4. Both lookups return ids only.
select pg_temp.check(pg_get_function_result('public.person_by_phone(text)'::regprocedure) =
                     'TABLE(phone_number_id uuid, org_id uuid, person_id uuid)', 'person_by_phone returns more than ids');
select pg_temp.check(pg_get_function_result('public.session_by_token(bytea,interval)'::regprocedure) =
                     'TABLE(session_id uuid, org_id uuid, user_id uuid, device_id uuid)', 'session_by_token returns more than ids');

-- 5. session_by_token with no org set finds a live session from its token's hash, and ignores an
-- org that is set.
select pg_temp.no_org();
select pg_temp.check(pg_temp.sessions_for(decode(current_setting('test.token_1'), 'hex'), '30 days') =
                     array[current_setting('test.session_1')], 'session_by_token did not find a live session with no org set');
select pg_temp.act_as('2', 'a1');
select pg_temp.check(pg_temp.sessions_for(decode(current_setting('test.token_1'), 'hex'), '30 days') =
                     array[current_setting('test.session_1')], 'session_by_token used the org set in the transaction');
reset role;

-- 6. What it never returns: a revoked, expired or idle session, one on a signed-out device, one of
-- someone who has left, a hash of the wrong length, or an idle limit out of range. Set up as the
-- superuser, looked up as hearth_app.
insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at, revoked_at, revoked_by, revoke_reason)
values (pg_temp.id('1', 'f1'), pg_temp.id('1', '00'), pg_temp.id('1', 'a8'), pg_temp.id('1', 'e1'), sha256('revoked'),
        now() + interval '1 day', now(), pg_temp.id('1', 'a8'), 'sign_out');
insert into public.sessions (id, org_id, user_id, device_id, token_hash, created_at, expires_at)
values (pg_temp.id('1', 'f2'), pg_temp.id('1', '00'), pg_temp.id('1', 'a8'), pg_temp.id('1', 'e1'), sha256('expired'),
        now() - interval '3 days', now() - interval '1 day');
insert into public.sessions (id, org_id, user_id, device_id, token_hash, created_at, last_seen_at, expires_at)
values (pg_temp.id('1', 'f3'), pg_temp.id('1', '00'), pg_temp.id('1', 'a8'), pg_temp.id('1', 'e1'), sha256('idle'),
        now() - interval '40 days', now() - interval '31 days', now() + interval '50 days');
-- To test the lookup's own joins rather than the triggers, which would end these sessions anyway,
-- the device is signed out and the person deactivated with triggers off: org 2's e1 is signed out
-- while its session e2 stays open, and org 1's a7 leaves with a device and an open session.
insert into public.devices (id, org_id, user_id, label) values (pg_temp.id('1', 'e4'), pg_temp.id('1', '00'), pg_temp.id('1', 'a7'), 'Leaver phone');
insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at)
values (pg_temp.id('1', 'f4'), pg_temp.id('1', '00'), pg_temp.id('1', 'a7'), pg_temp.id('1', 'e4'), sha256('leaver'), now() + interval '1 day');
set local session_replication_role = replica;
update public.devices set signed_out_at = now(), signed_out_by = pg_temp.id('2', 'a1') where id = pg_temp.id('2', 'e1');
update public.people set deactivated_at = now(), deactivated_by = pg_temp.id('1', 'a1') where id = pg_temp.id('1', 'a7');
set local session_replication_role = origin;
select pg_temp.check((select revoked_at is null from public.sessions where id = pg_temp.id('2', 'e2'))
                     and (select revoked_at is null from public.sessions where id = pg_temp.id('1', 'f4')),
                     'the set-up ended a session it meant to leave open');
select pg_temp.no_org();
select pg_temp.check(pg_temp.sessions_for(sha256('revoked'), '30 days') = '{}', 'session_by_token found a revoked session');
select pg_temp.check(pg_temp.sessions_for(sha256('expired'), '30 days') = '{}', 'session_by_token found an expired session');
select pg_temp.check(pg_temp.sessions_for(sha256('idle'), '30 days') = '{}', 'session_by_token found a session idle past the limit');
select pg_temp.check(pg_temp.sessions_for(sha256('idle'), '60 days') =
                     array[format('%s %s %s %s', pg_temp.id('1', 'f3'), pg_temp.id('1', '00'), pg_temp.id('1', 'a8'), pg_temp.id('1', 'e1'))],
                     'session_by_token did not find a session idle within a longer limit');
select pg_temp.check(pg_temp.sessions_for(decode(md5('session 2') || md5('token 2'), 'hex'), '30 days') = '{}',
                     'session_by_token found a session on a signed-out device');
select pg_temp.check(pg_temp.sessions_for(sha256('leaver'), '30 days') = '{}', 'session_by_token found the session of someone who has left');
select pg_temp.check(pg_temp.sessions_for(substring(decode(current_setting('test.token_1'), 'hex') from 1 for 31), '30 days') = '{}',
                     'session_by_token accepted a 31-byte hash');
select pg_temp.check(pg_temp.sessions_for(decode(current_setting('test.token_1'), 'hex'), null) = '{}', 'session_by_token accepted no idle limit');
select pg_temp.check(pg_temp.sessions_for(decode(current_setting('test.token_1'), 'hex'), '30 seconds') = '{}',
                     'session_by_token accepted an idle limit under a minute');
select pg_temp.check(pg_temp.sessions_for(decode(current_setting('test.token_1'), 'hex'), '2161 hours') = '{}',
                     'session_by_token accepted an idle limit over 90 days');
select pg_temp.check(pg_temp.sessions_for(decode(current_setting('test.token_1'), 'hex'), '1 minute') = array[current_setting('test.session_1')]
                     and pg_temp.sessions_for(decode(current_setting('test.token_1'), 'hex'), '2160 hours') = array[current_setting('test.session_1')],
                     'session_by_token refused an idle limit at the edge of its range');
reset role;

-- 7. The PIN columns (ACC-02, T6): a hash in the issued shape, with its key id and when it was set,
-- all three or none; nothing else.
select pg_temp.act_as('1', 'a8');
select pg_temp.expect_rows(format($$update public.users set pin_hash = %L, pin_key_id = '0123456789abcdef', pin_set_at = now()
  where id = %L$$, current_setting('test.pin_hash'), pg_temp.id('1', 'a8')), 1);
select pg_temp.expect_error(format($$update public.users set pin_hash = %L where id = %L$$, current_setting('test.pin_hash'), pg_temp.id('1', 'a6')),
  '23514', '%users_pin_complete%');
select pg_temp.expect_error(format($$update public.users set pin_hash = %L, pin_key_id = '0123456789abcdef', pin_set_at = now() where id = %L$$,
  '$2b$12$' || repeat('a', 53), pg_temp.id('1', 'a6')), '23514', '%users_pin_hash%');
select pg_temp.expect_error(format($$update public.users set pin_hash = %L, pin_key_id = '0123456789abcdef', pin_set_at = now() where id = %L$$,
  replace(current_setting('test.pin_hash'), 'm=19456', 'm=65536'), pg_temp.id('1', 'a6')), '23514', '%users_pin_hash%');
select pg_temp.expect_error(format($$update public.users set pin_hash = %L, pin_key_id = '0123456789ABCDEF', pin_set_at = now() where id = %L$$,
  current_setting('test.pin_hash'), pg_temp.id('1', 'a6')), '23514', '%users_pin_key_id%');
select pg_temp.expect_error(format($$update public.users set pin_hash = %L, pin_key_id = '0123456789abcde', pin_set_at = now() where id = %L$$,
  current_setting('test.pin_hash'), pg_temp.id('1', 'a6')), '23514', '%users_pin_key_id%');
-- An admin reset records who and when together, and who is a principal of the org.
select pg_temp.expect_error(format($$update public.users set pin_reset_at = now() where id = %L$$, pg_temp.id('1', 'a6')),
  '23514', '%users_pin_reset_by%');
select pg_temp.expect_error(format($$update public.users set pin_reset_at = now(), pin_reset_by = %L where id = %L$$,
  pg_temp.id('2', 'a2'), pg_temp.id('1', 'a6')), '23503', '%users_pin_reset_by_fkey%');
select pg_temp.expect_rows(format($$update public.users set pin_reset_at = now(), pin_reset_by = %L where id = %L$$,
  pg_temp.id('1', 'a2'), pg_temp.id('1', 'a6')), 1);
reset role;
-- A failure count needs the time of the last failure (with triggers off, so the failure trigger
-- can't stamp it).
set local session_replication_role = replica;
select pg_temp.expect_error(format($$update public.users set pin_failures = 1 where id = %L$$, pg_temp.id('1', 'a6')),
  '23514', '%users_pin_failed_at%');
set local session_replication_role = origin;

-- 8. The failure count (PRD-53) goes up one at a time or back to zero, and the database stamps
-- when the last failure happened.
select pg_temp.act_as('1', 'a8');
select pg_temp.expect_rows(format($$update public.users set pin_failures = pin_failures + 1 where id = %L$$, pg_temp.id('1', 'a8')), 1);
select pg_temp.check(pin_failures = 1 and pin_last_failed_at = now(), 'the first failure was not stamped with the database''s time')
from public.users where id = pg_temp.id('1', 'a8');
select pg_temp.expect_rows(format($$update public.users set pin_failures = pin_failures + 1 where id = %L$$, pg_temp.id('1', 'a8')), 1);
select pg_temp.expect_error(format($$update public.users set pin_failures = 4 where id = %L$$, pg_temp.id('1', 'a8')),
  '23514', 'A PIN''s failure count only goes up by one%');
select pg_temp.expect_error(format($$update public.users set pin_failures = 1 where id = %L$$, pg_temp.id('1', 'a8')),
  '23514', 'A PIN''s failure count only goes up by one%');
select pg_temp.expect_rows(format($$update public.users set pin_failures = 0 where id = %L$$, pg_temp.id('1', 'a8')), 1);
select pg_temp.check(pin_failures = 0 and pin_last_failed_at is null, 'a count back to zero kept the last failure''s time')
from public.users where id = pg_temp.id('1', 'a8');
select pg_temp.expect_rows(format($$update public.users set pin_failures = 1 where id = %L$$, pg_temp.id('1', 'a8')), 1);
reset role;
-- The superuser can move the last failure back (the integration tests' harness does, to age a
-- lock) without the trigger stamping it again.
update public.users set pin_last_failed_at = pin_last_failed_at - interval '1 hour' where id = pg_temp.id('1', 'a8');
select pg_temp.check(pin_failures = 1 and pin_last_failed_at = now() - interval '1 hour', 'moving the last failure back was not kept')
from public.users where id = pg_temp.id('1', 'a8');
-- An admin reset clears the PIN, the count and its time together.
select pg_temp.act_as('1', 'a2');
select pg_temp.expect_rows(format($$update public.users set pin_hash = null, pin_key_id = null, pin_set_at = null, pin_failures = 0,
  pin_reset_at = now(), pin_reset_by = %L where id = %L$$, pg_temp.id('1', 'a2'), pg_temp.id('1', 'a8')), 1);
select pg_temp.check(pin_hash is null and pin_failures = 0 and pin_last_failed_at is null and pin_reset_by = pg_temp.id('1', 'a2'),
                     'the admin reset did not clear the PIN and its failures')
from public.users where id = pg_temp.id('1', 'a8');
reset role;

-- 9. What hearth_app may not do (a privilege error, not a row level security refusal): delete
-- accounts, passkeys, sessions or devices; change a passkey's key or credential id or a person's
-- passkey user handle; choose when a PIN last failed; or name a new row's id or times where the
-- database chooses them.
select pg_temp.act_as('1', 'a2');
select pg_temp.expect_error($$delete from public.users$$, '42501', 'permission denied%');
select pg_temp.expect_error($$delete from public.passkeys$$, '42501', 'permission denied%');
select pg_temp.expect_error($$delete from public.sessions$$, '42501', 'permission denied%');
select pg_temp.expect_error($$delete from public.devices$$, '42501', 'permission denied%');
select pg_temp.expect_error($$update public.passkeys set public_key = decode(md5('c') || md5('d'), 'hex')$$, '42501', 'permission denied%');
select pg_temp.expect_error($$update public.passkeys set credential_id = decode(md5('another credential'), 'hex')$$, '42501', 'permission denied%');
select pg_temp.expect_error($$update public.users set passkey_user_handle = gen_random_uuid()$$, '42501', 'permission denied%');
select pg_temp.expect_error($$update public.users set pin_last_failed_at = now() - interval '1 hour'$$, '42501', 'permission denied%');
select pg_temp.expect_error(format($$insert into public.passkeys (org_id, user_id, credential_id, public_key, backed_up, created_at)
  values (%L, %L, decode(md5('dated credential'), 'hex'), decode(md5('e') || md5('f'), 'hex'), false, now() - interval '1 day')$$,
  pg_temp.id('1', '00'), pg_temp.id('1', 'a1')), '42501', 'permission denied%');
select pg_temp.expect_error(format($$insert into public.passkeys (id, org_id, user_id, credential_id, public_key, backed_up)
  values (%L, %L, %L, decode(md5('chosen id'), 'hex'), decode(md5('g') || md5('h'), 'hex'), false)$$,
  pg_temp.id('1', 'e8'), pg_temp.id('1', '00'), pg_temp.id('1', 'a1')), '42501', 'permission denied%');
do $$
declare
  times text;
begin
  foreach times in array array['created_at', 'last_seen_at', 'reauthenticated_at'] loop
    perform pg_temp.expect_error(format($s$insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at, %I)
      values (%L, %L, %L, sha256(%L), now() + interval '1 day', now() - interval '1 day')$s$,
      times, pg_temp.id('1', '00'), pg_temp.id('1', 'a8'), pg_temp.id('1', 'e1'), 'chosen ' || times), '42501', 'permission denied%');
  end loop;
end
$$;
select pg_temp.expect_error(format($$insert into public.users (id, org_id, pin_failures) values (%L, %L, 0)$$,
  pg_temp.id('1', 'aa'), pg_temp.id('1', '00')), '42501', 'permission denied%');
-- The first sign-in makes the account naming only the person and org, and a second one at the
-- same time finds it there.
select pg_temp.expect_rows(format($$insert into public.users (id, org_id) values (%L, %L) on conflict (id) do nothing$$,
  pg_temp.id('1', 'aa'), pg_temp.id('1', '00')), 1);
select pg_temp.expect_rows(format($$insert into public.users (id, org_id) values (%L, %L) on conflict (id) do nothing$$,
  pg_temp.id('1', 'aa'), pg_temp.id('1', '00')), 0);
select pg_temp.check(u.pin_hash is null and u.pin_failures = 0 and u.created_at = now()
                     and u.passkey_user_handle is not null and u.passkey_user_handle <> a8.passkey_user_handle,
                     'a new account did not start empty, with its own passkey user handle')
from public.users u, public.users a8 where u.id = pg_temp.id('1', 'aa') and a8.id = pg_temp.id('1', 'a8');
reset role;

-- 10. Sessions (T5): at most 90 days; the database writes when one started, was last seen and last
-- re-authenticated (a sign-in counts as one); why one ended is one of the known codes.
-- 0006 adds the rule on why a session ended NOT VALID and validates it when no session made
-- before 0006 kept an older reason, as on every build without such sessions (with them, it stays
-- NOT VALID and still applies to new rows: scripts/check-sign-in-upgrade.sh).
select pg_temp.check(bool_and(convalidated) and count(*) = 3,
                     'the session rules were not all validated on a database with no older sessions')
from pg_constraint where conrelid = 'public.sessions'::regclass
  and conname in ('sessions_revoke_reason', 'sessions_at_most_90_days', 'sessions_reauthenticated_after_start');
select pg_temp.act_as('1', 'a8');
select pg_temp.expect_error(format($$insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at)
  values (%L, %L, %L, sha256('too long'), now() + interval '2161 hours')$$,
  pg_temp.id('1', '00'), pg_temp.id('1', 'a8'), pg_temp.id('1', 'e1')), '23514', '%sessions_at_most_90_days%');
select pg_temp.expect_rows(format($$insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at)
  values (%L, %L, %L, %L, sha256('ninety days'), now() + interval '2160 hours')$$,
  pg_temp.id('1', 'f5'), pg_temp.id('1', '00'), pg_temp.id('1', 'a8'), pg_temp.id('1', 'e1')), 1);
select pg_temp.check(created_at = now() and last_seen_at = now() and reauthenticated_at = now(),
                     'a new session did not start, and start re-authenticated, at the database''s time')
from public.sessions where id = pg_temp.id('1', 'f5');
select pg_temp.expect_error(format($$update public.sessions set revoked_at = now(), revoked_by = %L, revoke_reason = 'logged_out' where id = %L$$,
  pg_temp.id('1', 'a8'), pg_temp.id('1', 'f5')), '23514', '%sessions_revoke_reason%');
select pg_temp.expect_rows(format($$update public.sessions set revoked_at = now(), revoked_by = %L, revoke_reason = 'pin_reset' where id = %L$$,
  pg_temp.id('1', 'a8'), pg_temp.id('1', 'f5')), 1);
reset role;
-- Age e2 by two days with triggers off, then ask for a future re-authentication and a past last
-- use: both are stored as now.
set local session_replication_role = replica;
update public.sessions set created_at = now() - interval '2 days', last_seen_at = now() - interval '2 days',
  reauthenticated_at = now() - interval '2 days' where id = pg_temp.id('1', 'e2');
set local session_replication_role = origin;
select pg_temp.act_as('1', 'a8');
select pg_temp.expect_rows(format($$update public.sessions set reauthenticated_at = now() + interval '1 day' where id = %L$$, pg_temp.id('1', 'e2')), 1);
select pg_temp.check(reauthenticated_at = now() and last_seen_at = now() - interval '2 days',
                     'a re-authentication was stored at a time the write chose')
from public.sessions where id = pg_temp.id('1', 'e2');
select pg_temp.expect_rows(format($$update public.sessions set last_seen_at = now() - interval '40 days' where id = %L$$, pg_temp.id('1', 'e2')), 1);
select pg_temp.check(last_seen_at = now(), 'a last use was stored at a time the write chose')
from public.sessions where id = pg_temp.id('1', 'e2');
reset role;
-- A re-authentication can't come before the session started, even with triggers off.
set local session_replication_role = replica;
select pg_temp.expect_error(format($$update public.sessions set reauthenticated_at = created_at - interval '1 hour' where id = %L$$,
  pg_temp.id('1', 'e2')), '23514', '%sessions_reauthenticated_after_start%');
set local session_replication_role = origin;

-- 11. Deactivating someone (ACC-05) ends their open sessions and signs their devices out in the
-- same transaction, with the deactivation's when and who; what had already ended keeps its own.
-- Then nothing new starts for them, and their passkeys stay (unusable while they have left).
insert into public.sessions (id, org_id, user_id, device_id, token_hash, created_at, expires_at, revoked_at, revoked_by, revoke_reason)
values (pg_temp.id('1', 'f6'), pg_temp.id('1', '00'), pg_temp.id('1', 'a8'), pg_temp.id('1', 'e1'), sha256('already ended'),
        now() - interval '2 hours', now() + interval '1 day', now() - interval '1 hour', pg_temp.id('1', 'a8'), 'sign_out');
select pg_temp.act_as('1', 'a2');
select pg_temp.expect_rows(format($$update public.people set deactivated_at = now(), deactivated_by = %L where id = %L$$,
  pg_temp.id('1', 'a2'), pg_temp.id('1', 'a8')), 1);
select pg_temp.check(revoked_at = now() and revoked_by = pg_temp.id('1', 'a2') and revoke_reason = 'deactivated',
                     'deactivating a8 did not end their open session')
from public.sessions where id = pg_temp.id('1', 'e2');
select pg_temp.check(signed_out_at = now() and signed_out_by = pg_temp.id('1', 'a2'), 'deactivating a8 did not sign their device out')
from public.devices where id = pg_temp.id('1', 'e1');
select pg_temp.check(revoked_at = now() - interval '1 hour' and revoked_by = pg_temp.id('1', 'a8') and revoke_reason = 'sign_out',
                     'deactivating a8 changed a session that had already ended')
from public.sessions where id = pg_temp.id('1', 'f6');
select pg_temp.check(revoke_reason = 'pin_reset', 'deactivating a8 changed why another ended session ended')
from public.sessions where id = pg_temp.id('1', 'f5');
select pg_temp.check(removed_at is null, 'deactivating a8 removed their passkey')
from public.passkeys where id = pg_temp.id('1', 'e7');
reset role;
select pg_temp.check(p.deactivated_at is null and s.revoked_at is null, 'deactivating org 1''s a8 reached org 2''s')
from public.people p join public.sessions s on s.org_id = p.org_id and s.user_id = p.id
where p.id = pg_temp.id('2', 'a8') and s.id = pg_temp.id('2', 'e2');
-- A device a8 still had open (left with triggers off) can't start a session either: the person is
-- checked before the device.
set local session_replication_role = replica;
insert into public.devices (id, org_id, user_id, label) values (pg_temp.id('1', 'e5'), pg_temp.id('1', '00'), pg_temp.id('1', 'a8'), 'Old tablet');
set local session_replication_role = origin;
select pg_temp.act_as('1', 'a8');
select pg_temp.expect_error(format($$insert into public.devices (org_id, user_id, label) values (%L, %L, 'New phone')$$,
  pg_temp.id('1', '00'), pg_temp.id('1', 'a8')), '23514', 'That person has left the organisation, so no device can be added for them.');
select pg_temp.expect_error(format($$insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at)
  values (%L, %L, %L, sha256('after leaving, signed-out device'), now() + interval '1 day')$$,
  pg_temp.id('1', '00'), pg_temp.id('1', 'a8'), pg_temp.id('1', 'e1')), '23514', 'That person has left the organisation, so they can''t sign in.');
select pg_temp.expect_error(format($$insert into public.sessions (org_id, user_id, device_id, token_hash, expires_at)
  values (%L, %L, %L, sha256('after leaving, open device'), now() + interval '1 day')$$,
  pg_temp.id('1', '00'), pg_temp.id('1', 'a8'), pg_temp.id('1', 'e5')), '23514', 'That person has left the organisation, so they can''t sign in.');
select pg_temp.expect_error(format($$insert into public.passkeys (org_id, user_id, credential_id, public_key, backed_up)
  values (%L, %L, decode(md5('after leaving'), 'hex'), decode(md5('i') || md5('j'), 'hex'), true)$$,
  pg_temp.id('1', '00'), pg_temp.id('1', 'a8')), '23514', '%can''t add a passkey.');
reset role;

-- 12. Passkeys (ACC-02): a credential id is unique across orgs; only the known transports; a
-- removal records who and when and can't be undone; the device it was added on is the person's
-- own, and it outlives that device.
select pg_temp.expect_error(format($$insert into public.passkeys (org_id, user_id, credential_id, public_key, backed_up)
  values (%L, %L, decode(md5('credential 1'), 'hex'), decode(md5('k') || md5('l'), 'hex'), true)$$,
  pg_temp.id('2', '00'), pg_temp.id('2', 'a8')), '23505', '%passkeys_credential_id_unique%');
select pg_temp.act_as('2', 'a8');
select pg_temp.expect_error(format($$insert into public.passkeys (org_id, user_id, credential_id, public_key, backed_up, transports)
  values (%L, %L, decode(md5('bluetooth'), 'hex'), decode(md5('m') || md5('n'), 'hex'), true, '{bluetooth}')$$,
  pg_temp.id('2', '00'), pg_temp.id('2', 'a8')), '23514', '%passkeys_transports_check%');
select pg_temp.expect_rows(format($$insert into public.passkeys (org_id, user_id, credential_id, public_key, backed_up, transports)
  values (%L, %L, decode(md5('second passkey'), 'hex'), decode(md5('o') || md5('p'), 'hex'), false, '{internal,hybrid}')$$,
  pg_temp.id('2', '00'), pg_temp.id('2', 'a8')), 1);
select pg_temp.check(count(*) = 1 and bool_and(created_at = now() and counter = 0 and removed_at is null),
                     'a new passkey did not start at the database''s time with a zero counter')
from public.passkeys where credential_id = decode(md5('second passkey'), 'hex');
select pg_temp.expect_error($$update public.passkeys set counter = 4294967296$$, '23514', '%passkeys_counter_check%');
select pg_temp.expect_rows(format($$update public.passkeys set removed_at = now(), removed_by = %L where id = %L$$,
  pg_temp.id('2', 'a8'), pg_temp.id('2', 'e7')), 1);
select pg_temp.expect_error(format($$update public.passkeys set removed_at = null, removed_by = null where id = %L$$, pg_temp.id('2', 'e7')),
  '23514', 'That has already ended%');
select pg_temp.expect_error(format($$update public.passkeys set removed_by = %L where id = %L$$, pg_temp.id('2', 'a2'), pg_temp.id('2', 'e7')),
  '23514', 'That has already ended%');
-- Org 2's a7 can't name a8's device as the one their passkey was added on.
select pg_temp.expect_error(format($$insert into public.passkeys (org_id, user_id, credential_id, public_key, backed_up, created_device_id)
  values (%L, %L, decode(md5('borrowed device'), 'hex'), decode(md5('q') || md5('r'), 'hex'), true, %L)$$,
  pg_temp.id('2', '00'), pg_temp.id('2', 'a7'), pg_temp.id('2', 'e1')), '23503', '%passkeys_org_id_user_id_created_device_id_fkey%');
reset role;
-- When the retention engine deletes a device (PDPA-09), the passkey added on it stays, without it.
delete from public.sessions where device_id = pg_temp.id('1', 'e1');
delete from public.devices where id = pg_temp.id('1', 'e1');
select pg_temp.check(count(*) = 1 and bool_and(created_device_id is null and user_id = pg_temp.id('1', 'a8')),
                     'the passkey did not outlive the device it was added on')
from public.passkeys where id = pg_temp.id('1', 'e7');
