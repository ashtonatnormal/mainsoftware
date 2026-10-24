// Checks that the schema's refusals hold when two transactions race (C0.3, C0.5, CLAUDE.md
// Database). A check that refuses because something has ended (someone left, a team or department
// was archived, a device was signed out, a number was removed) reads that row FOR SHARE. A change
// to that row running at the same time makes the check wait, and it then sees what the change
// committed. Without the lock, both would commit: a role for someone who has left, or a session on
// a signed-out device. C0.5 adds a session lookup; a new device, session or passkey for someone
// leaving; ending someone's sessions during a sign-in; a number removed during a sign-in; and an
// admin acting while being deactivated. Rows are locked in one order (people, users, passkeys,
// phone_numbers, devices, sessions; 0006), so none of these can deadlock.
//
// C0.6 (0007) adds the queue, the scheduler, the outbox and feature flags, which the worker's job
// roles reach (taken with set local role, as the server's withOrg takes them): a flag change and a
// job's or consumer's fence, each order; a cohort narrowed under a fence; an enqueue that a flag
// change mustn't wait for; the lease sweep, a heartbeat, a give-back and a job's finish against each
// other; two claimers; two schedulers firing; two consumer rounds; a reset during a round; a purge
// during a round; the outbox's horizon; and a flag change by someone losing their right to it. A
// case that must not wait runs its second step with a 2 s lock timeout (alongside()).
//
// C0.9 (0009, TECH-SPEC T22) adds the registers: a code check (transfer_cleared(), as a send's
// transaction asks it) against a withdrawal, each order, and against "save and keep cleared"; a
// clearance against a change of its facts, each order; two changes to one purpose from one
// version; a DPO being deactivated, or losing the role, while changing a register; and a
// restriction (PDPA-04a) against a basis leaving consent, each order.
//
// C0.9 PR 2 (0010, TECH-SPEC T22 items 25 to 27 and 33) adds the notice, in an org of its own
// (NOTICE_FIXTURE), so publishing changes nothing the earlier cases read: two publishes from one
// seen, the first two included, and one after another from a stale seen (NTR-04, B-02); an
// acknowledgement against a publish, each order (NTR-01); a publish against a purpose change,
// each order (NTR-02); against "save and keep cleared", a withdrawal and a clearance (NTR-03); an
// acknowledgement against a deactivation and a device sign-out (NTR-05); a publish by a DPO being
// deactivated or losing the role (NTR-06); and a send against a publish, which never waits for it
// and never reads a stated clearance as not stated (NTR-07). The cases run in that order, each
// from the versions the one before left.
//
// C0.9 PR 3a (0011, TECH-SPEC T22 items 39, 40, 43 and 44) adds, after NTR-07, the DPO's contact,
// recorded acknowledgements and the break-glass re-clear: a publish against a contact change, each
// order (NTR-08); two contact changes from one version, and two first records, with the first
// committed and with it rolled back, in orgs of their own with no contact (CONTACT_FIXTURE, NTR-09);
// a recorded acknowledgement against a publish, each order (NTR-10); a record against its person's
// deactivation, and a record or a contact change by a DPO being deactivated or losing the role
// (NTR-11); a record against the person's own acknowledgement, each order (NTR-12); and, in an org
// of its own (BREAK_GLASS_FIXTURE), the re-clear against a DPO's sign-in, each order (BGR-01),
// against a DPO's sessions ending (BGR-02), against another re-clear (BGR-03), against the DPO's
// own clear in the app (BGR-04) and against the named DPO losing the role or being deactivated
// (BGR-05). The re-clear sets its own 2 s lock_timeout, so each case's first transaction commits as
// soon as the re-clear is seen waiting, as race() does. BGR-06 isn't a race but needs a connection
// of its own: a session that set a longer transaction_timeout, under a lower value the transaction
// set, outlives its old timer because the re-clear starts the timer again at 30 s. NTR-13 builds a
// database of its own up to 0010 and applies 0011 while a gated request holds the notice tables and
// then reads a clearance: the migration never waits while it holds one of the three, so neither
// fails.
//
// Each case opens two connections to a throwaway database (concurrency_check, built from
// db/migrations/ with the migrator, owned by hearth_owner), starts the change in one, starts the
// dependent write in the other, waits until Postgres reports that write waiting on a lock, commits
// the change and checks what the write did. CI's migrations job runs it after
// scripts/check-migrations.sh, which creates hearth_owner.
//
//   node apps/server/scripts/check-concurrency.ts
//
// Connects with the PG* variables as a superuser (default: the local stack) and refuses any host
// but this machine. Exits 1 if any case fails.
import { Client } from 'pg'
import { migrate } from '#src/db/migrations.ts'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const DB = 'concurrency_check'
const host = process.env.PGHOST ?? '127.0.0.1'
const connection = {
  host,
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
}

// One org with Hearth, an admin (a1), people b1-b9 and ba (b8 has an account and two devices),
// teams d1-d3 and a department c1. b7 is a DPO, b9 a Compliance Officer and ba in Leadership, and
// those three roles may read the audit log (D45).
//
// For C0.5's cases, people bb-bf, b0 and c2-c5 have accounts, and devices:
//   bb e3    bc e4    bd e6 with session f5    be e5    bf e8    b0 e9 with session f6
//   c2 ef with session f8    c3 (a PIN and passkey 9b)    c4 ea and number 9c    c5 an Admin, eb with session f7
// e7, ec, ed and ee, and sessions f3, f4, f9, fa and fb, are left for the cases to add.
// For C0.8's case (D46), person c9 holds no role and has no account; device d9 and session f0 are
// left for it. A session's
// token is its id's suffix, so its token_hash is sha256('<suffix>'). Every suffix must be two hex
// digits, since it ends a uuid: one that isn't breaks the whole fixture, every case with it.
const id = (suffix: string) => `c0000000-0000-4000-8000-0000000000${suffix}`
const ORG = id('00')
const ADMIN = id('a1')
// Hearth's own principal, which the worker's transactions act as.
const SYSTEM = id('a0')
// C0.6: the Owner who changes flags (c6), and Admins who are deactivated (c7) or lose the role (c8)
// while changing one.
const OWNER = id('c6')
const ids = (suffixes: string[]) => suffixes.map(s => `'${id(s)}'`).join(', ')
const SIGN_IN_PEOPLE = ['bb', 'bc', 'bd', 'be', 'bf', 'b0', 'c2', 'c3', 'c4', 'c5']
// C0.6 (0007), after the rest, with Hearth acting (an event's actor and a job's created_by are the
// acting principal). Owner c6, Admins c7 and c8. The org's flags come from the orgs trigger; these
// add k01-k16 for the cases that use them, on and unlocked (k04's cohort is b1 and b2). Running
// jobs, each under lease token 2x for job 1x: 11 (k01), 12 (k02) and 14 (k04, for b1); 16, 17, 18,
// 1a and 1b, whose leases have run out; 1c and 1d. Job 19 is queued. Schedules 30 (due now) and 31
// (due at a fixed time). Three outbox events, and the checkpoints of the cases' consumers, made by
// their own role, which alone may move them.
const C06_FIXTURE = `
  insert into public.principals (id, org_id, kind)
  select s.id, '${ORG}', 'human' from unnest(array[${ids(['c6', 'c7', 'c8'])}]::uuid[]) as s (id);
  insert into public.people (id, org_id, full_name, created_by)
  select s.id, '${ORG}', 'Person ' || s.id, '${SYSTEM}' from unnest(array[${ids(['c6', 'c7', 'c8'])}]::uuid[]) as s (id);
  insert into public.role_assignments (org_id, person_id, role, created_by) values
    ('${ORG}', '${id('c6')}', 'owner', '${ADMIN}'), ('${ORG}', '${id('c7')}', 'admin', '${ADMIN}'),
    ('${ORG}', '${id('c8')}', 'admin', '${ADMIN}');
  insert into public.feature_flags (org_id, key, enabled, locked)
  select '${ORG}', k, true, false
  from unnest(array['k01', 'k02', 'k03', 'k03.child', 'k03b', 'k03b.child', 'k05', 'k16']) as k;
  insert into public.feature_flags (org_id, key, enabled, locked, audience, cohort_people)
  values ('${ORG}', 'k04', true, false, 'cohort', array[${ids(['b1', 'b2'])}]::uuid[]);
  select set_config('app.user_id', '${SYSTEM}', true);
  insert into public.jobs (id, org_id, kind, feature_key, purpose, subject_id, state, attempts, lease_token, lease_expires_at,
                           claimed_by, started_at)
  select ('c0000000-0000-4000-8000-0000000000' || j.job)::uuid, '${ORG}', 'test.effect', j.feature, 'service_operation',
         j.subject::uuid, 'running', 1, ('c0000000-0000-4000-8000-0000000000' || j.lease)::uuid, now() + j.lease_left::interval,
         'worker-0', now()
  from (values ('11', '21', 'k01', null, '1 hour'), ('12', '22', 'k02', null, '1 hour'), ('14', '24', 'k04', '${id('b1')}', '1 hour'),
               ('16', '26', 'core.system', null, '-1 minute'), ('17', '27', 'core.system', null, '-1 minute'),
               ('18', '28', 'core.system', null, '-1 minute'), ('1a', '2a', 'core.system', null, '-1 minute'),
               ('1b', '2b', 'core.system', null, '-1 minute'), ('1c', '2c', 'core.system', null, '1 hour'),
               ('1d', '2d', 'core.system', null, '1 hour'))
    as j (job, lease, feature, subject, lease_left);
  insert into public.jobs (id, org_id, kind, feature_key, purpose) values
    ('${id('19')}', '${ORG}', 'test.claim', 'core.system', 'service_operation');
  insert into public.schedules (id, org_id, key, kind, cron, on_interrupt, next_run_at) values
    ('${id('30')}', '${ORG}', 'test.fire', 'test.fire', '0 * * * *', 'rerun', now() - interval '1 minute'),
    ('${id('31')}', '${ORG}', 'test.fire_late', 'test.fire_late', '0 * * * *', 'rerun', '2026-10-01 03:00:00+00');
  insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose, ids)
  select '${ORG}', 'flag.changed', 'feature_flag', f.id, '${SYSTEM}', 'system', 'service_operation',
         jsonb_build_object('key', f.key, 'enabled', f.enabled)
  from public.feature_flags f where f.org_id = '${ORG}' and f.key in ('k01', 'k02', 'k03');
  select set_config('app.org_id', '${ORG}', true);
  set local role hearth_job_offboarding;
  insert into public.outbox_checkpoints (org_id, consumer, role_name)
  select '${ORG}', c, 'hearth_job_offboarding' from unnest(array['race03', 'race03b', 'race12', 'race13', 'race14']) as c;
  insert into public.outbox_checkpoints (org_id, consumer, role_name, last_tx, last_id)
  select '${ORG}', 'race13b', 'hearth_job_offboarding', e.tx_id, e.id from public.outbox_events e order by e.id limit 1;
`
// C0.9 (0009), after the rest, as the owner. The org's register entries come from the trigger on
// orgs. DPOs 61, 62, 64 (deactivated in a case) and 66 (whose role is revoked in one), and 65, whom
// a restriction names. twilio, aws, livekit, apple_push and google_fcm have every clearing fact
// recorded by 61 (revision 2), and the first three are cleared by 61. session_sharing rests on
// deemed consent by conduct and content_delivery on consent (version 2, by 61), for the
// restriction cases; no restriction is live yet.
const C09_FIXTURE = `
  set local role hearth_owner;
  insert into public.principals (id, org_id, kind)
  select s.id, '${ORG}', 'human' from unnest(array[${ids(['61', '62', '64', '65', '66'])}]::uuid[]) as s (id);
  insert into public.people (id, org_id, full_name, created_by)
  select s.id, '${ORG}', 'Person ' || s.id, '${SYSTEM}' from unnest(array[${ids(['61', '62', '64', '65', '66'])}]::uuid[]) as s (id);
  insert into public.role_assignments (org_id, person_id, role, created_by)
  select '${ORG}', s.id, 'dpo', '${ADMIN}' from unnest(array[${ids(['61', '62', '64', '66'])}]::uuid[]) as s (id);
  update public.transfer_register set services = 'Test service', data_types = 'A number', processing_countries = '{US}',
    storage_countries = '{US}', countries_confirmed = 'Test DPA', safeguard = 'dpa', safeguard_reference = 'Test DPA',
    dpa_terms_confirmed = true, training = 'not_applicable', zero_retention = 'not_applicable',
    provider_retention = '30 days', retention_confirmed = 'Test DPA', onward_recipients = 'None',
    review_on = current_date + 365, revision = 2, updated_at = now(), updated_by = '${id('61')}'
  where org_id = '${ORG}' and provider in ('twilio', 'aws', 'livekit', 'apple_push', 'google_fcm');
  insert into public.transfer_clearances (org_id, entry_id, cleared_by, cleared_via)
  select '${ORG}', t.id, '${id('61')}', 'app' from public.transfer_register t
  where t.org_id = '${ORG}' and t.provider in ('twilio', 'aws', 'livekit');
  insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status, basis, retention,
                                          recorded_by)
  select r.org_id, r.purpose, r.ai, r.pinned, r.needs_switch, 2, 'active', b.basis, '1 year', '${id('61')}'
  from public.processing_register r
  join (values ('session_sharing', 'deemed_consent_conduct'), ('content_delivery', 'consent')) as b (purpose, basis)
    on b.purpose = r.purpose
  where r.org_id = '${ORG}' and r.version = 1;
`
// C0.9 PR 2 (0010): the notice's org, NOTICE_ORG, as the owner, with no version yet. Its Hearth
// principal n(a0); DPOs n(61) (who publishes), n(62) (who publishes alongside), n(63)
// (deactivated in a case) and n(64) (whose role is revoked in one); members n(71) to n(75), each
// with an account and a device n(e1) to n(e5). The four purposes active from the start (A-05) have a basis and a
// retention at version 2, so a draft can be published; twilio, aws, livekit and apple_push have
// every clearing fact recorded (revision 2), and twilio and aws are cleared. From 0011 (C0.9 PR
// 3a) the DPO's contact is recorded (version 1, by n(61)), so a publish passes the contact rule,
// and DPOs n(65) and n(67) are deactivated, and n(66) and n(68) lose the role, in NTR-11.
const n = (suffix: string) => `c0000000-0000-4000-8000-0000000001${suffix}`
const NOTICE_ORG = n('00')
const nids = (suffixes: string[]) => suffixes.map(s => `'${n(s)}'`).join(', ')
const NOTICE_PEOPLE = ['61', '62', '63', '64', '65', '66', '67', '68', '71', '72', '73', '74', '75']
const NOTICE_FIXTURE = `
  set local role hearth_owner;
  insert into public.orgs (id, name) values ('${NOTICE_ORG}', 'Concurrency check notice');
  insert into public.principals (id, org_id, kind, system_key) values ('${n('a0')}', '${NOTICE_ORG}', 'system', 'hearth');
  insert into public.principals (id, org_id, kind)
  select s.id, '${NOTICE_ORG}', 'human' from unnest(array[${nids(NOTICE_PEOPLE)}]::uuid[]) as s (id);
  insert into public.people (id, org_id, full_name, created_by)
  select s.id, '${NOTICE_ORG}', 'Person ' || s.id, '${n('a0')}' from unnest(array[${nids(NOTICE_PEOPLE)}]::uuid[]) as s (id);
  insert into public.role_assignments (org_id, person_id, role, created_by)
  select '${NOTICE_ORG}', s.id, 'dpo', '${n('a0')}'
  from unnest(array[${nids(['61', '62', '63', '64', '65', '66', '67', '68'])}]::uuid[]) as s (id);
  insert into public.users (id, org_id)
  select s.id, '${NOTICE_ORG}' from unnest(array[${nids(['71', '72', '73', '74', '75'])}]::uuid[]) as s (id);
  insert into public.devices (id, org_id, user_id, label)
  select ('c0000000-0000-4000-8000-0000000001e' || d.k)::uuid, '${NOTICE_ORG}',
         ('c0000000-0000-4000-8000-00000000017' || d.k)::uuid, 'Phone'
  from unnest(array['1', '2', '3', '4', '5']) as d (k);
  insert into public.processing_register (org_id, purpose, ai, pinned, needs_switch, version, status, basis, retention,
                                          recorded_by)
  select r.org_id, r.purpose, r.ai, r.pinned, r.needs_switch, 2, 'active', 'employment', '1 year', '${n('61')}'
  from public.processing_register r
  where r.org_id = '${NOTICE_ORG}' and r.version = 1 and r.status = 'active';
  update public.transfer_register set services = 'Test service', data_types = 'A number', processing_countries = '{US}',
    storage_countries = '{US}', countries_confirmed = 'Test DPA', safeguard = 'dpa', safeguard_reference = 'Test DPA',
    dpa_terms_confirmed = true, training = 'not_applicable', zero_retention = 'not_applicable',
    provider_retention = '30 days', retention_confirmed = 'Test DPA', onward_recipients = 'None',
    review_on = current_date + 365, revision = 2, updated_at = now(), updated_by = '${n('61')}'
  where org_id = '${NOTICE_ORG}' and provider in ('twilio', 'aws', 'livekit', 'apple_push');
  insert into public.transfer_clearances (org_id, entry_id, cleared_by, cleared_via)
  select '${NOTICE_ORG}', t.id, '${n('61')}', 'app' from public.transfer_register t
  where t.org_id = '${NOTICE_ORG}' and t.provider in ('twilio', 'aws');
  insert into public.dpo_settings (org_id, version, contact_title, contact_email, recorded_by)
  values ('${NOTICE_ORG}', 1, 'Data Protection Officer', 'dpo@race.example', '${n('61')}');
`
// C0.9 PR 3a (0011): two orgs with no contact, for two first records (NTR-09), one whose first
// record commits and one whose first rolls back: CONTACT_ORGS[0], with Hearth k(a0) and DPOs k(61)
// and k(62), and CONTACT_ORGS[1], with Hearth k(a1) and DPOs k(63) and k(64).
const k = (suffix: string) => `c0000000-0000-4000-8000-0000000002${suffix}`
const CONTACT_ORGS = [k('00'), k('01')] as const
const CONTACT_FIXTURE = `
  set local role hearth_owner;
  insert into public.orgs (id, name) values ('${k('00')}', 'Concurrency check contact'), ('${k('01')}', 'Concurrency check contact 2');
  insert into public.principals (id, org_id, kind, system_key)
  values ('${k('a0')}', '${k('00')}', 'system', 'hearth'), ('${k('a1')}', '${k('01')}', 'system', 'hearth');
  insert into public.principals (id, org_id, kind)
  select ('c0000000-0000-4000-8000-0000000002' || d.dpo)::uuid, ('c0000000-0000-4000-8000-0000000002' || d.org)::uuid, 'human'
  from (values ('61', '00'), ('62', '00'), ('63', '01'), ('64', '01')) as d (dpo, org);
  insert into public.people (id, org_id, full_name, created_by)
  select p.id, p.org_id, 'Person ' || p.id, case p.org_id when '${k('00')}' then '${k('a0')}'::uuid else '${k('a1')}'::uuid end
  from public.principals p where p.org_id in ('${k('00')}', '${k('01')}') and p.kind = 'human';
  insert into public.role_assignments (org_id, person_id, role, created_by)
  select p.org_id, p.id, 'dpo', p.created_by from public.people p where p.org_id in ('${k('00')}', '${k('01')}');
`
// C0.9 PR 3a (0011): the break-glass re-clear's org, as the owner. Its Hearth principal g(a0); DPOs
// g(81) and g(82), each with an account and a device (g(e1), g(e2)); member g(85), with an account
// and a device g(e5). Twilio's facts are recorded and cleared by the first-Owner bootstrap's
// clearance (no marker, as the set-up runs it), in g(81)'s name, which g(81) then withdrew. No DPO
// has a session yet, and the org has no notice version.
const g = (suffix: string) => `c0000000-0000-4000-8000-0000000003${suffix}`
const BREAK_GLASS_ORG = g('00')
// The bootstrap's clearance of Twilio, as the set-up calls it, on the same facts each time and a
// review date 30 days ahead, inside the re-clear's 90-day cap.
const bootstrapTwilio = (dpo: string, reason: string) =>
  `select public.bootstrap_transfer_clearance('twilio', '${g(dpo)}', 'Test service', 'A number', '{US}', '{US}',
     'Test DPA', 'dpa', 'Test DPA', null, true, 'not_applicable', 'not_applicable', '30 days', 'Test DPA', 'None',
     current_date + 30, '${reason}')`
const BREAK_GLASS_FIXTURE = `
  set local role hearth_owner;
  insert into public.orgs (id, name) values ('${BREAK_GLASS_ORG}', 'Concurrency check break-glass');
  insert into public.principals (id, org_id, kind, system_key) values ('${g('a0')}', '${BREAK_GLASS_ORG}', 'system', 'hearth');
  insert into public.principals (id, org_id, kind)
  select s.id, '${BREAK_GLASS_ORG}', 'human' from unnest(array['${g('81')}', '${g('82')}', '${g('85')}']::uuid[]) as s (id);
  insert into public.people (id, org_id, full_name, created_by)
  select s.id, '${BREAK_GLASS_ORG}', 'Person ' || s.id, '${g('a0')}'
  from unnest(array['${g('81')}', '${g('82')}', '${g('85')}']::uuid[]) as s (id);
  insert into public.role_assignments (org_id, person_id, role, created_by)
  values ('${BREAK_GLASS_ORG}', '${g('81')}', 'dpo', '${g('a0')}'), ('${BREAK_GLASS_ORG}', '${g('82')}', 'dpo', '${g('a0')}');
  insert into public.users (id, org_id)
  select s.id, '${BREAK_GLASS_ORG}' from unnest(array['${g('81')}', '${g('82')}', '${g('85')}']::uuid[]) as s (id);
  insert into public.devices (id, org_id, user_id, label) values
    ('${g('e1')}', '${BREAK_GLASS_ORG}', '${g('81')}', 'Phone'), ('${g('e2')}', '${BREAK_GLASS_ORG}', '${g('82')}', 'Phone'),
    ('${g('e5')}', '${BREAK_GLASS_ORG}', '${g('85')}', 'Phone');
  select set_config('app.org_id', '${BREAK_GLASS_ORG}', true), set_config('app.user_id', '${g('a0')}', true);
  ${bootstrapTwilio('81', 'Concurrency check: the first set-up')};
  update public.transfer_clearances set withdrawn_at = now(), withdrawn_by = '${g('81')}', withdraw_reason = 'dpo_decision'
  where org_id = '${BREAK_GLASS_ORG}' and provider = 'twilio';
  select set_config('app.org_id', '', true), set_config('app.user_id', '', true);
`
// A PIN hash in the one shape the server issues (0006; DB test 100 uses the same).
const PIN_HASH = "'$argon2id$v=19$m=19456,t=2,p=1$' || repeat('A', 22) || '$' || repeat('B', 43)"
const FIXTURE = `
  insert into public.orgs (id, name) values ('${ORG}', 'Concurrency check');
  insert into public.principals (id, org_id, kind, system_key) values ('${id('a0')}', '${ORG}', 'system', 'hearth');
  insert into public.principals (id, org_id, kind)
  select s.id, '${ORG}', 'human' from unnest(array['${id('a1')}', ${ids(['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'ba', 'c9', ...SIGN_IN_PEOPLE])}]::uuid[]) as s (id);
  insert into public.people (id, org_id, full_name, created_by)
  select p.id, '${ORG}', 'Person ' || p.id, '${id('a0')}' from public.principals p where p.kind = 'human';
  insert into public.users (id, org_id)
  select s.id, '${ORG}' from unnest(array[${ids(['b8', ...SIGN_IN_PEOPLE])}]::uuid[]) as s (id);
  update public.users set pin_hash = ${PIN_HASH}, pin_key_id = '0123456789abcdef', pin_set_at = now()
  where id = '${id('c3')}';
  insert into public.passkeys (id, org_id, user_id, credential_id, public_key, backed_up)
  values ('${id('9b')}', '${ORG}', '${id('c3')}', sha256('cred c3'::bytea), sha256('pk c3'::bytea), true);
  insert into public.phone_numbers (id, org_id, person_id, e164, created_by)
  values ('${id('9c')}', '${ORG}', '${id('c4')}', '+6590000004', '${ADMIN}');
  insert into public.departments (id, org_id, name, created_by) values ('${id('c1')}', '${ORG}', 'Operations', '${ADMIN}');
  insert into public.teams (id, org_id, name, created_by) values
    ('${id('d1')}', '${ORG}', 'Crew', '${ADMIN}'), ('${id('d2')}', '${ORG}', 'Night crew', '${ADMIN}'),
    ('${id('d3')}', '${ORG}', 'Day crew', '${ADMIN}');
  insert into public.devices (id, org_id, user_id, label) values
    ('${id('e1')}', '${ORG}', '${id('b8')}', 'Phone'), ('${id('e2')}', '${ORG}', '${id('b8')}', 'Laptop'),
    ('${id('e3')}', '${ORG}', '${id('bb')}', 'Phone'), ('${id('e4')}', '${ORG}', '${id('bc')}', 'Phone'),
    ('${id('e5')}', '${ORG}', '${id('be')}', 'Phone'), ('${id('e6')}', '${ORG}', '${id('bd')}', 'Phone'),
    ('${id('e8')}', '${ORG}', '${id('bf')}', 'Phone'), ('${id('e9')}', '${ORG}', '${id('b0')}', 'Phone'),
    ('${id('ea')}', '${ORG}', '${id('c4')}', 'Phone'), ('${id('eb')}', '${ORG}', '${id('c5')}', 'Phone'),
    ('${id('ef')}', '${ORG}', '${id('c2')}', 'Phone');
  insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at) values
    ('${id('f5')}', '${ORG}', '${id('bd')}', '${id('e6')}', sha256('f5'::bytea), now() + interval '1 day'),
    ('${id('f6')}', '${ORG}', '${id('b0')}', '${id('e9')}', sha256('f6'::bytea), now() + interval '1 day'),
    ('${id('f7')}', '${ORG}', '${id('c5')}', '${id('eb')}', sha256('f7'::bytea), now() + interval '1 day'),
    ('${id('f8')}', '${ORG}', '${id('c2')}', '${id('ef')}', sha256('f8'::bytea), now() + interval '1 day');
  insert into public.role_assignments (org_id, person_id, role, created_by) values
    ('${ORG}', '${id('b7')}', 'dpo', '${ADMIN}'), ('${ORG}', '${id('b9')}', 'compliance_officer', '${ADMIN}'),
    ('${ORG}', '${id('ba')}', 'leadership', '${ADMIN}'), ('${ORG}', '${id('c5')}', 'admin', '${ADMIN}');
  insert into public.audit_log_readers (org_id, role, created_by) values
    ('${ORG}', 'dpo', '${ADMIN}'), ('${ORG}', 'compliance_officer', '${ADMIN}'), ('${ORG}', 'leadership', '${ADMIN}');
${C06_FIXTURE}${C09_FIXTURE}${NOTICE_FIXTURE}${CONTACT_FIXTURE}${BREAK_GLASS_FIXTURE}`

function url(database: string): string {
  const result = new URL(`postgres://${connection.host.includes(':') ? `[${connection.host}]` : connection.host}`)
  result.port = String(connection.port)
  result.username = connection.user
  result.password = connection.password
  result.pathname = `/${database}`
  return result.toString()
}

async function connect(database: string): Promise<Client> {
  const client = new Client({ ...connection, database })
  await client.connect()
  return client
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// A transaction as the server makes one (hearth_app, with the org and the user set, the admin
// unless the step names someone), as the owner, which the role-writing SECURITY DEFINER functions
// run as, or (C0.6) as the worker makes one: Hearth's system principal acting, as one job role.
type Actor = 'app' | 'owner' | 'queue' | 'offboarding' | 'purge'
interface Step {
  as: Actor
  sql: string
  user?: string
  // The org the transaction acts in: ORG unless a case names the notice's (C0.9 PR 2).
  org?: string
}
const JOB_ROLES = { queue: 'hearth_queue', offboarding: 'hearth_job_offboarding', purge: 'hearth_job_purge' } as const

async function begin(client: Client, step: Step): Promise<void> {
  await client.query('begin')
  await client.query("set local lock_timeout = '10s'")
  if (step.as === 'app') {
    await client.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [
      step.org ?? ORG,
      step.user ?? ADMIN,
    ])
    await client.query('set local role hearth_app')
  } else if (step.as === 'owner') {
    await client.query('set local role hearth_owner')
  } else {
    await client.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [
      step.org ?? ORG,
      SYSTEM,
    ])
    await client.query(`set local role ${JOB_ROLES[step.as]}`)
  }
}

// Whether the backend is waiting on a lock, asked of Postgres for up to 5 seconds.
async function waitsOnLock(watcher: Client, pid: number): Promise<boolean> {
  for (let tries = 0; tries < 100; tries += 1) {
    const result = await watcher.query<{ wait: string | null }>(
      'select wait_event_type as wait from pg_stat_activity where pid = $1',
      [pid],
    )
    if (result.rows[0]?.wait === 'Lock') return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

// Starts `first` and leaves it open, runs `second` in another connection until it waits on a
// lock, then commits `first` (or, with firstEnds 'rollback', rolls it back). Returns whether
// `second` waited and the error it ended with, if any; `second` commits if it succeeded.
async function race(
  watcher: Client,
  first: Step,
  second: Step,
  firstEnds: 'commit' | 'rollback' = 'commit',
): Promise<{ waited: boolean; error?: string }> {
  const a = await connect(DB)
  const b = await connect(DB)
  try {
    const pid = (await b.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid ?? 0
    await begin(a, first)
    await a.query(first.sql)
    await begin(b, second)
    const pending = b.query(second.sql).then(
      () => undefined,
      (error: unknown) => message(error),
    )
    const waited = await waitsOnLock(watcher, pid)
    await a.query(firstEnds)
    const error = await pending
    await b.query(error === undefined ? 'commit' : 'rollback')
    return error === undefined ? { waited } : { waited, error }
  } finally {
    await a.end()
    await b.end()
  }
}

// Starts `first` and leaves it open, then runs `second` in another connection, which must not wait
// for it: a lock it waits on for 2 s fails it. Commits `second` (or rolls it back after an error),
// then `first`, and returns the error `second` ended with, if any.
async function alongside(first: Step, second: Step): Promise<string | undefined> {
  const a = await connect(DB)
  const b = await connect(DB)
  try {
    await begin(a, first)
    await a.query(first.sql)
    await begin(b, second)
    await b.query("set local lock_timeout = '2s'")
    const error = await b.query(second.sql).then(
      () => undefined,
      (failure: unknown) => message(failure),
    )
    await b.query(error === undefined ? 'commit' : 'rollback')
    await a.query('commit')
    return error
  } finally {
    await a.end()
    await b.end()
  }
}

function expect(ok: boolean, what: string): void {
  if (!ok) throw new Error(what)
}

// One value the watcher reads (as the superuser), as text.
async function scalar(watcher: Client, sql: string, values: unknown[] = []): Promise<string | null> {
  const result = await watcher.query<{ v: string | null }>(sql, values)
  return result.rows[0]?.v ?? null
}

// A change first, then a write it must refuse.
function refused(first: Step, second: Step, refusal: string): (watcher: Client) => Promise<void> {
  return async watcher => {
    const { waited, error } = await race(watcher, first, second)
    expect(waited, 'the write did not wait for the change, so it could not see it')
    expect(
      error?.includes(refusal) === true,
      `expected "${refusal}", got ${error === undefined ? 'success' : `"${error}"`}`,
    )
  }
}

const deactivate = (person: string): Step => ({
  as: 'app',
  sql: `update public.people set deactivated_at = now(), deactivated_by = '${ADMIN}' where id = '${id(person)}'`,
})
const archive = (table: 'teams' | 'departments', suffix: string): Step => ({
  as: 'app',
  sql: `update public.${table} set archived_at = now(), archived_by = '${ADMIN}' where id = '${id(suffix)}'`,
})
const signOut = (suffix: string): Step => ({
  as: 'app',
  sql: `update public.devices set signed_out_at = now(), signed_out_by = '${ADMIN}' where id = '${id(suffix)}'`,
})
const join = (team: string, n: number): Step => ({
  as: 'app',
  sql: `insert into public.team_memberships (org_id, team_id, person_id, created_by)
        values ('${ORG}', '${id(team)}', '${id(`b${n}`)}', '${ADMIN}')`,
})
const grant = (n: number, role: string, team?: string): Step => ({
  as: 'owner',
  sql: `insert into public.role_assignments (org_id, person_id, role, team_id, created_by)
        values ('${ORG}', '${id(`b${n}`)}', '${role}', ${team === undefined ? 'null' : `'${id(team)}'`}, '${ADMIN}')`,
})
const signIn = (device: string, session: string): Step => ({
  as: 'app',
  sql: `insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at)
        values ('${id(session)}', '${ORG}', '${id('b8')}', '${id(device)}', sha256('${session}'::bytea), now() + interval '1 day')`,
})

// C0.5. A session starts for someone on their own device, as the server's sign-in does it.
const signInAs = (person: string, device: string, session: string): Step => ({
  as: 'app',
  user: id(person),
  sql: `insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at)
        values ('${id(session)}', '${ORG}', '${id(person)}', '${id(device)}', sha256('${session}'::bytea), now() + interval '1 day')`,
})
const addDevice = (person: string, device: string): Step => ({
  as: 'app',
  user: id(person),
  sql: `insert into public.devices (id, org_id, user_id, label) values ('${id(device)}', '${ORG}', '${id(person)}', 'New phone')`,
})
const addPasskey = (person: string, device: string): Step => ({
  as: 'app',
  user: id(person),
  sql: `insert into public.passkeys (org_id, user_id, credential_id, public_key, backed_up, created_device_id)
        values ('${ORG}', '${id(person)}', sha256('cred ${person}'::bytea), sha256('pk ${person}'::bytea), true, '${id(device)}')`,
})
// A whole sign-in as the server runs it: the person FOR SHARE first, then `extra` (e.g. the
// passkey row FOR UPDATE), then a new device and session.
const signInNow = (person: string, device: string, session: string, extra = ''): Step => ({
  as: 'app',
  user: id(person),
  sql: `select 1 from public.people where org_id = '${ORG}' and id = '${id(person)}' and deactivated_at is null for share;
        ${extra}
        insert into public.devices (id, org_id, user_id, label) values ('${id(device)}', '${ORG}', '${id(person)}', 'New phone');
        insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at)
        values ('${id(session)}', '${ORG}', '${id(person)}', '${id(device)}', sha256('${session}'::bytea), now() + interval '1 day')`,
})
// Ending all of someone's sessions as the server does: the person's row first.
const signOutAll = (person: string): Step => ({
  as: 'app',
  sql: `select 1 from public.people where org_id = '${ORG}' and id = '${id(person)}' for no key update;
        update public.devices set signed_out_at = now(), signed_out_by = '${ADMIN}'
        where org_id = '${ORG}' and user_id = '${id(person)}' and signed_out_at is null`,
})
// An admin's PIN reset (ACC-06): the person's row first, then the PIN, then their sessions.
const resetPin = (person: string): Step => ({
  as: 'app',
  sql: `select 1 from public.people where org_id = '${ORG}' and id = '${id(person)}' for no key update;
        update public.users set pin_hash = null, pin_key_id = null, pin_set_at = null, pin_failures = 0,
          pin_reset_at = now(), pin_reset_by = '${ADMIN}' where org_id = '${ORG}' and id = '${id(person)}';
        update public.sessions set revoked_at = now(), revoked_by = '${ADMIN}', revoke_reason = 'pin_reset'
        where org_id = '${ORG}' and user_id = '${id(person)}' and revoked_at is null`,
})
const removeNumber = (number: string): Step => ({
  as: 'app',
  sql: `update public.phone_numbers set removed_at = now(), removed_by = '${ADMIN}' where org_id = '${ORG}' and id = '${id(number)}'`,
})
// A finished sign-in issuing its session: the person FOR SHARE, then the number the code went to,
// FOR SHARE and still theirs, or nothing is issued; then the device and session.
const issueThrough = (person: string, number: string, device: string, session: string): Step => ({
  as: 'app',
  user: id(person),
  sql: `do $$ begin
          perform 1 from public.people where org_id = '${ORG}' and id = '${id(person)}' and deactivated_at is null for share;
          perform 1 from public.phone_numbers
          where org_id = '${ORG}' and id = '${id(number)}' and person_id = '${id(person)}' and removed_at is null for share;
          if not found then raise exception 'the number was removed'; end if;
          insert into public.devices (id, org_id, user_id, label) values ('${id(device)}', '${ORG}', '${id(person)}', 'New phone');
          insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at)
          values ('${id(session)}', '${ORG}', '${id(person)}', '${id(device)}', sha256('${session}'::bytea), now() + interval '1 day');
        end $$`,
})
// C0.8 (D46). A role grant as C0.16 will make one for someone with no live session: their person row
// FOR NO KEY UPDATE first, then the role row (the owner plays it; no session is ended, since
// role_changed arrives only with C0.16's migration).
const grantPinRole = (person: string, role: string): Step => ({
  as: 'owner',
  sql: `select 1 from public.people where org_id = '${ORG}' and id = '${id(person)}' for no key update;
        insert into public.role_assignments (org_id, person_id, role, created_by)
        values ('${ORG}', '${id(person)}', '${role}', '${ADMIN}')`,
})
// A code-only sign-in's finish as the server runs it (sign-in.ts finish()): the person FOR SHARE,
// then their roles read as their own statement with no lock, and only for someone with no PIN
// role the account, device and session.
const codeOnlyFinish = (person: string, device: string, session: string): Step => ({
  as: 'app',
  user: SYSTEM,
  sql: `do $$ begin
          perform 1 from public.people where org_id = '${ORG}' and id = '${id(person)}' and deactivated_at is null for share;
          if exists (select 1 from public.role_assignments where org_id = '${ORG}' and person_id = '${id(person)}'
                     and revoked_at is null and role in ('owner', 'admin', 'ai_admin', 'leadership', 'dpo', 'compliance_officer'))
          then raise exception 'pin role: the PIN step, no session'; end if;
          insert into public.users (id, org_id) values ('${id(person)}', '${ORG}') on conflict (id) do nothing;
          insert into public.devices (id, org_id, user_id, label) values ('${id(device)}', '${ORG}', '${id(person)}', 'New phone');
          insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at)
          values ('${id(session)}', '${ORG}', '${id(person)}', '${id(device)}', sha256('${session}'::bytea), now() + interval '1 day');
        end $$`,
})

// The acting session, re-read FOR SHARE at the start of every POST before can() decides (person,
// device, session, in that order).
const actAs = (person: string, device: string, session: string): Step => ({
  as: 'app',
  user: id(person),
  sql: `do $$ begin
          perform s.reauthenticated_at > now() - interval '5 minutes'
          from public.people p
          join public.devices d on d.org_id = p.org_id and d.user_id = p.id
          join public.sessions s on s.org_id = d.org_id and s.device_id = d.id
          where p.org_id = '${ORG}' and p.id = '${id(person)}' and d.id = '${id(device)}' and s.id = '${id(session)}'
            and s.revoked_at is null and s.expires_at > now() and s.last_seen_at > now() - interval '30 days'
            and d.signed_out_at is null and p.deactivated_at is null
          for share of p, d, s;
          if not found then raise exception 'the actor has left'; end if;
        end $$`,
})

// What the watcher reads after a case: why each session ended, and whether each device is signed out.
async function revokeReasons(watcher: Client, sessions: string[]): Promise<Array<string | null>> {
  const result = await watcher.query<{ id: string; reason: string | null }>(
    'select id, revoke_reason as reason from public.sessions where id = any($1::uuid[])',
    [sessions.map(id)],
  )
  return sessions.map(s => result.rows.find(row => row.id === id(s))?.reason ?? null)
}
async function signedOut(watcher: Client, devices: string[]): Promise<boolean> {
  const result = await watcher.query<{ n: string }>(
    'select count(*) as n from public.devices where id = any($1::uuid[]) and signed_out_at is not null',
    [devices.map(id)],
  )
  return Number(result.rows[0]?.n) === devices.length
}

const readAuditLog = (reader: string): Step => ({
  as: 'app',
  user: id(reader),
  sql: "select count(*) from public.read_audit_events(now() - interval '1 day', now() + interval '1 day')",
})

// C0.6 (0007): the statements the worker and the flags route make (TECH-SPEC T15 to T17), each as the
// role that makes it.

// A flag change through set_feature_flag(), by the Owner unless a step names someone.
const setFlag = (key: string, enabled: boolean, options: { user?: string; people?: string[] } = {}): Step => ({
  as: 'app',
  user: options.user ?? OWNER,
  sql: `select public.set_feature_flag('${key}', ${enabled}, '${options.people === undefined ? 'org' : 'cohort'}',
          array[${ids(options.people ?? [])}]::uuid[], '{}', 'race', null, null)`,
})
// C0.9 (0009): the statements the DPO's routes and a send's transaction make (TECH-SPEC T22 items 8
// and 13), each as hearth_app acting as the person the server would set.

// A send's question (sign-in.ts deliverCode, as Hearth): a provider not cleared refuses it, so a
// case can tell what it read.
const codeCheck = (provider: string): Step => ({
  as: 'app',
  user: SYSTEM,
  sql: `do $$ begin
          if not public.transfer_cleared('${provider}') then raise exception 'the code check found ${provider} not cleared'; end if;
        end $$`,
})
const withdrawClearance = (provider: string, dpo = '61'): Step => ({
  as: 'app',
  user: id(dpo),
  sql: `select * from public.withdraw_transfer_clearance('${provider}', 'race', null, null)`,
})
const clearEntry = (provider: string, seen: number, dpo = '61'): Step => ({
  as: 'app',
  user: id(dpo),
  sql: `select * from public.clear_transfer_entry('${provider}', ${seen}, 'race', null, null)`,
})
// The fixture's facts with the provider's retention changed: "Save" or, with keepCleared, "Save and
// keep cleared".
const recordFacts = (provider: string, seen: number, retention: string, keepCleared: boolean, dpo = '61'): Step => ({
  as: 'app',
  user: id(dpo),
  sql: `select * from public.record_transfer_entry('${provider}', ${seen}, 'Test service', 'A number', '{US}', '{US}',
          'Test DPA', 'dpa', 'Test DPA', null, true, 'not_applicable', 'not_applicable', '${retention}', 'Test DPA', 'None',
          current_date + 365, ${keepCleared}, 'race', null, null)`,
})
// A purpose's next version, on a basis that isn't consent-type.
const setPurpose = (purpose: string, seen: number, status: string, dpo = '61'): Step => ({
  as: 'app',
  user: id(dpo),
  sql: `select * from public.set_register_purpose('${purpose}', ${seen}, '${status}', 'employment', null, null, '1 year',
          '{}'::text[], 'race', null, null)`,
})
// A person's withdrawal of a purpose (PDPA-04a). Nothing writes one until C2.11, so the owner plays it.
const restrict = (person: string, purpose: string): Step => ({
  as: 'owner',
  sql: `insert into public.processing_restrictions (org_id, person_id, purpose, effective_at, created_by)
        values ('${ORG}', '${id(person)}', '${purpose}', now(), '${id('61')}')`,
})
const REGISTER_DPO_REFUSED = 'Only the Data Protection Officer can change the registers.'
const REGISTER_CHANGED = 'This entry changed since you opened it. Reload it and try again.'

// C0.9 PR 2 (0010): the statements the notice's routes and a send make in NOTICE_ORG, each as
// hearth_app acting as the person the server would set. A publish names the sources its draft
// was made from as the route does, read in its own statement before publish_notice() locks
// anything, and (unless the case gives one) the latest version it saw: so one that waits sees,
// once its locks are granted, whatever committed meanwhile. From 0011 the sources include the
// DPO's settings version the draft printed, the latest when the statement starts (PD-66).
const LATEST_VERSION = `(select max(v.version) from public.notice_versions v where v.org_id = '${NOTICE_ORG}')`
const LATEST_ID = `(select v.id from public.notice_versions v where v.org_id = '${NOTICE_ORG}' order by v.version desc limit 1)`
const LATEST_CONTACT = `(select max(s.version) from public.dpo_settings s where s.org_id = '${NOTICE_ORG}')`
const SOURCES = `(select distinct on (r.purpose) r.purpose, r.version, r.status from public.processing_register r
                  where r.org_id = '${NOTICE_ORG}' and not r.ai order by r.purpose, r.version desc)`
const publish = (body: string, options: { dpo?: string; seen?: number | null } = {}): Step => ({
  as: 'app',
  org: NOTICE_ORG,
  user: n(options.dpo ?? '61'),
  sql: `select * from public.publish_notice(
          ${options.seen === undefined ? LATEST_VERSION : options.seen === null ? 'null' : options.seen}::integer,
          '${body}', 'c09.1',
          array(select x.purpose from ${SOURCES} x where x.status <> 'planned' order by x.purpose),
          array(select x.version from ${SOURCES} x where x.status <> 'planned' order by x.purpose),
          array(select c.id from public.transfer_clearances c
                join public.transfer_register t on t.org_id = c.org_id and t.id = c.entry_id
                where c.org_id = '${NOTICE_ORG}' and c.withdrawn_at is null and not t.ai),
          ${LATEST_CONTACT}::integer, 'race', null, null)`,
})
// Member n(7k) acknowledges the version their screen showed: the latest when the statement starts.
const acknowledge = (k: string): Step => ({
  as: 'app',
  org: NOTICE_ORG,
  user: n(`7${k}`),
  sql: `select * from public.acknowledge_notice(${LATEST_ID}, 'race', '${n(`e${k}`)}', null)`,
})
// A send's question in NOTICE_ORG (sign-in.ts deliverCode, as Hearth): anything but cleared refuses
// it, naming what it read.
const sendState = (provider: string): Step => ({
  as: 'app',
  org: NOTICE_ORG,
  user: n('a0'),
  sql: `do $$ declare state text := public.transfer_send_state('${provider}'); begin
          if state <> 'cleared' then raise exception 'the send read ${provider} %', state; end if;
        end $$`,
})
const noticePurpose = (purpose: string, seen: number): Step => ({
  as: 'app',
  org: NOTICE_ORG,
  user: n('61'),
  sql: `select * from public.set_register_purpose('${purpose}', ${seen}, 'active', 'employment', null, null, '1 year',
          '{}'::text[], 'race', null, null)`,
})
const noticeRecordFacts = (provider: string, seen: number, retention: string): Step => ({
  as: 'app',
  org: NOTICE_ORG,
  user: n('62'),
  sql: `select * from public.record_transfer_entry('${provider}', ${seen}, 'Test service', 'A number', '{US}', '{US}',
          'Test DPA', 'dpa', 'Test DPA', null, true, 'not_applicable', 'not_applicable', '${retention}', 'Test DPA', 'None',
          current_date + 365, true, 'race', null, null)`,
})
const noticeWithdraw = (provider: string): Step => ({
  as: 'app',
  org: NOTICE_ORG,
  user: n('62'),
  sql: `select * from public.withdraw_transfer_clearance('${provider}', 'race', null, null)`,
})
const noticeClear = (provider: string, seen: number): Step => ({
  as: 'app',
  org: NOTICE_ORG,
  user: n('62'),
  sql: `select * from public.clear_transfer_entry('${provider}', ${seen}, 'race', null, null)`,
})
const NOTICE_NEWER = 'A newer version was published since you looked. Check the preview again.'
const NOTICE_SOURCES_MOVED =
  'The registers changed since this notice was prepared. Check the preview again, then publish.'
const NOTICE_ACK_NEWER = 'A newer version of the notice was published. Read it, then acknowledge it.'
const NOTICE_DPO_REFUSED = 'Only the Data Protection Officer can publish the notice.'

// C0.9 PR 3a (0011): the statements the contact page's and the record dialog's routes make, each as
// hearth_app acting as the person the server would set (NOTICE_ORG unless a case names another).
// A contact change from the version the page showed (seen), as set_dpo_contact() takes it.
const contactChange = (seen: number | null, email: string, options: { dpo?: string; org?: string } = {}): Step => ({
  as: 'app',
  org: options.org ?? NOTICE_ORG,
  user: options.dpo ?? n('61'),
  sql: `select * from public.set_dpo_contact(${seen === null ? 'null' : seen}::integer, 'Data Protection Officer',
          '${email}', null, null, 'race', null, null)`,
})
// The DPO's record of member n(7k)'s acknowledgement of the version their dialog showed (the latest
// when the statement starts), on today in the org's zone; with unchanged, it must change nothing.
const recordCall = (k: string) =>
  `public.record_notice_acknowledgement('${n(`7${k}`)}', ${LATEST_ID}, (now() at time zone 'Asia/Singapore')::date,
     'Signed a printed copy', 'race', null, null)`
const recordAck = (k: string, options: { dpo?: string; unchanged?: boolean } = {}): Step => ({
  as: 'app',
  org: NOTICE_ORG,
  user: n(options.dpo ?? '62'),
  sql:
    options.unchanged === true
      ? `do $$ begin if (select changed from ${recordCall(k)}) then raise exception 'the record changed something'; end if; end $$`
      : `select * from ${recordCall(k)}`,
})
// Member n(7k)'s own acknowledgement, which must change nothing.
const acknowledgeUnchanged = (k: string): Step => ({
  as: 'app',
  org: NOTICE_ORG,
  user: n(`7${k}`),
  sql: `do $$ begin
          if (select changed from public.acknowledge_notice(${LATEST_ID}, 'race', '${n(`e${k}`)}', null)) then
            raise exception 'the acknowledgement changed something';
          end if;
        end $$`,
})
const deactivateIn = (org: string, person: string, by: string): Step => ({
  as: 'app',
  org,
  user: by,
  sql: `update public.people set deactivated_at = now(), deactivated_by = '${by}' where org_id = '${org}' and id = '${person}'`,
})
const revokeDpo = (org: string, person: string, by: string): Step => ({
  as: 'owner',
  sql: `update public.role_assignments set revoked_at = now(), revoked_by = '${by}'
        where org_id = '${org}' and person_id = '${person}' and role = 'dpo' and revoked_at is null`,
})
const CONTACT_CHANGED = 'Your contact details changed since you opened them. Reload them and try again.'
const NOTICE_CONTACT_MOVED =
  "The Data Protection Officer's contact changed since this notice was prepared. Check the preview again, then publish."
const RECORD_NEWER = 'A newer version of the notice was published. Record the acknowledgement of that one.'

// The break-glass re-clear (0011, C0.9 OD-20) as the bootstrap script's recovery mode runs it: as
// the owner, acting as the org's Hearth principal, with the emergency marker set in the
// transaction, naming the DPO who decided.
const reclear = (dpo: string): Step => ({
  as: 'owner',
  sql: `select set_config('app.org_id', '${BREAK_GLASS_ORG}', true), set_config('app.user_id', '${g('a0')}', true),
               set_config('hearth.break_glass', 'twilio_reclear', true);
        ${bootstrapTwilio(dpo, 'Concurrency check: Twilio withdrawn and no DPO signed in')}`,
})
// A DPO's sign-in issuing its session, as sign-in.ts finish() does: the person FOR SHARE first,
// then (with check) the transfer gate, then the session on their device.
const dpoSignIn = (dpo: string, device: string, session: string, check = false): Step => ({
  as: 'app',
  org: BREAK_GLASS_ORG,
  user: g('a0'),
  sql: `do $$ begin
          perform 1 from public.people where org_id = '${BREAK_GLASS_ORG}' and id = '${g(dpo)}' and deactivated_at is null
          for share;
          if not found then raise exception 'the DPO has left'; end if;
          ${check ? "if not public.transfer_cleared('twilio') then raise exception 'the sign-in found twilio not cleared'; end if;" : ''}
          insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at)
          values ('${g(session)}', '${BREAK_GLASS_ORG}', '${g(dpo)}', '${g(device)}', sha256('bg ${session}'::bytea),
                  now() + interval '7 days');
        end $$`,
})
const REGISTER_SIGNED_IN = 'A Data Protection Officer is signed in, so they clear Twilio Verify again in Hearth.'
const REGISTER_NOT_DPO = 'The person named as the DPO must be at the organisation and hold the DPO role.'
const REGISTER_CLEARED_ALREADY = 'Twilio Verify is cleared already. The DPO changes its entry in Hearth.'
// The break-glass org between cases (the watcher, as the superuser): Twilio withdrawn by g(81), and
// every session ended, so the next case starts with Twilio not cleared and no DPO signed in.
async function resetBreakGlass(watcher: Client): Promise<void> {
  await watcher.query(
    `update public.transfer_clearances set withdrawn_at = now(), withdrawn_by = $2, withdraw_reason = 'dpo_decision'
     where org_id = $1 and provider = 'twilio' and withdrawn_at is null`,
    [BREAK_GLASS_ORG, g('81')],
  )
  await watcher.query(
    `update public.sessions set revoked_at = now(), revoked_by = user_id, revoke_reason = 'sign_out'
     where org_id = $1 and revoked_at is null`,
    [BREAK_GLASS_ORG],
  )
}
// Twilio's open clearances in the break-glass org, as "cleared_via cleared_by-suffix".
const openTwilio = (watcher: Client) =>
  scalar(
    watcher,
    `select string_agg(cleared_via || ' ' || right(cleared_by::text, 2), ',') as v from public.transfer_clearances
     where org_id = $1 and provider = 'twilio' and withdrawn_at is null`,
    [BREAK_GLASS_ORG],
  )

// One step alone, in a transaction of its own: the error it ended with, if any (committed if none).
async function alone(step: Step): Promise<string | undefined> {
  const a = await connect(DB)
  try {
    await begin(a, step)
    const error = await a.query(step.sql).then(
      () => undefined,
      (failure: unknown) => message(failure),
    )
    await a.query(error === undefined ? 'commit' : 'rollback')
    return error
  } finally {
    await a.end()
  }
}

// The notice org's versions, as "number:generator".
const noticeVersions = (watcher: Client) =>
  scalar(
    watcher,
    `select string_agg(version || ':' || coalesce(generator, 'stand-in'), ',' order by version) as v
     from public.notice_versions where org_id = $1`,
    [NOTICE_ORG],
  )

// A job's last transaction: its effect (one more job, queued by a key the case names), then
// job_finish with the lineage revisions the job was admitted under.
const finishJob = (job: string, lease: string, seen: number[], effect: string): Step => ({
  as: 'offboarding',
  sql: `insert into public.jobs (org_id, kind, feature_key, purpose, idempotency_key)
        values ('${ORG}', 'test.effect', 'core.system', 'accounts', '${effect}');
        select public.job_finish('${id(job)}', '${id(lease)}', '{${seen.join(',')}}')`,
})
// A consumer's round ending with feature_fence: its effect (its checkpoint moved), then the fence.
const fenceRound = (consumer: string, feature: string, seen: number[]): Step => ({
  as: 'offboarding',
  sql: `update public.outbox_checkpoints set processed = processed + 1, updated_at = now()
        where org_id = '${ORG}' and consumer = '${consumer}';
        select public.feature_fence('${feature}', '{${seen.join(',')}}')`,
})
// The scheduler's lease sweep (as hearth_queue), over the given jobs only, so cases don't touch each
// other's: expired leases, skipping rows another transaction holds, each requeued. It fails unless
// it took exactly `takes`.
const sweep = (jobs: string[], takes: string[]): Step => ({
  as: 'queue',
  sql: `do $$
        declare
          swept uuid[];
        begin
          with due as (
            select j.id from public.jobs j
            where j.org_id = '${ORG}' and j.state = 'running' and j.lease_expires_at < now() and j.id in (${ids(jobs)})
            order by j.lease_expires_at
            for no key update skip locked
            limit 100
          ), moved as (
            update public.jobs j set state = 'queued', lease_token = null, lease_expires_at = null, reason = 'lease_expired',
              run_after = now() + interval '5 seconds'
            from due where j.id = due.id
            returning j.id
          )
          select coalesce(array_agg(m.id order by m.id), '{}') into swept from moved m;
          if swept is distinct from array[${ids(takes)}]::uuid[] then
            raise exception 'the sweep took %', swept;
          end if;
        end $$`,
})
// A heartbeat (hearth_queue): one statement renewing the org's running jobs under their tokens. It
// fails unless it renewed `renews` of them.
const heartbeat = (job: string, lease: string, renews: number): Step => ({
  as: 'queue',
  sql: `do $$
        declare
          n bigint;
        begin
          update public.jobs j set lease_expires_at = now() + interval '30 seconds'
          from unnest(array['${id(job)}']::uuid[], array['${id(lease)}']::uuid[]) as t (id, token)
          where j.org_id = '${ORG}' and j.id = t.id and j.lease_token = t.token and j.state = 'running';
          get diagnostics n = row_count;
          if n <> ${renews} then
            raise exception 'the heartbeat renewed % job(s)', n;
          end if;
        end $$`,
})
// A job given back uncounted (hearth_queue: a shutdown), under the lease it was claimed with. It
// fails unless it changed `changes` jobs.
const giveBack = (job: string, lease: string, changes: number): Step => ({
  as: 'queue',
  sql: `do $$
        declare
          n bigint;
        begin
          update public.jobs set state = 'queued', lease_token = null, lease_expires_at = null, attempts = attempts - 1,
            give_backs = give_backs + 1, reason = 'shutdown', run_after = now()
          where org_id = '${ORG}' and id = '${id(job)}' and lease_token = '${id(lease)}' and state = 'running';
          get diagnostics n = row_count;
          if n <> ${changes} then
            raise exception 'the give-back changed % job(s)', n;
          end if;
        end $$`,
})
// A claim (hearth_queue) of queued jobs of one kind whose flags are on, skipping rows another
// claimer holds. It fails unless it claimed `claims` jobs.
const claim = (kind: string, worker: string, claims: number): Step => ({
  as: 'queue',
  sql: `do $$
        declare
          n bigint;
        begin
          with next as (
            select j.id from public.jobs j
            where j.org_id = '${ORG}' and j.state = 'queued' and j.run_after <= now() and j.attempts < j.max_attempts
              and j.kind = any(array['${kind}'])
              and not exists (select 1 from public.feature_flags f
                              where f.org_id = j.org_id and not f.enabled
                                and (j.feature_key = f.key or starts_with(j.feature_key, f.key || '.')))
            order by j.run_after, j.id
            for update skip locked
            limit 4
          )
          update public.jobs j set state = 'running', attempts = j.attempts + 1, lease_token = gen_random_uuid(),
            lease_expires_at = now() + interval '30 seconds', started_at = coalesce(j.started_at, now()), claimed_by = '${worker}'
          from next where j.id = next.id;
          get diagnostics n = row_count;
          if n <> ${claims} then
            raise exception 'the claim took % job(s)', n;
          end if;
        end $$`,
})
// The scheduler firing one schedule (hearth_queue): the due schedule FOR NO KEY UPDATE SKIP LOCKED,
// its run for the occurrence (none if it exists already: then no job either), the run's job, and
// the next occurrence. It fails unless it queued `queues` jobs.
const fire = (schedule: string, queues: number): Step => ({
  as: 'queue',
  sql: `do $$
        declare
          s record;
          run uuid;
          n int := 0;
        begin
          for s in select id, kind, on_interrupt, next_run_at from public.schedules
                   where org_id = '${ORG}' and retired_at is null and next_run_at <= now() and id = '${id(schedule)}'
                   order by next_run_at
                   for no key update skip locked
                   limit 20
          loop
            insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt)
            values ('${ORG}', s.id, s.next_run_at, s.on_interrupt)
            on conflict do nothing
            returning id into run;
            if run is not null then
              insert into public.jobs (org_id, kind, feature_key, purpose, schedule_run_id, idempotency_key)
              values ('${ORG}', s.kind, 'core.system', 'service_operation', run, 'run:' || run);
              n := n + 1;
            end if;
            update public.schedules set next_run_at = now() + interval '1 day', last_fired_at = now()
            where org_id = '${ORG}' and id = s.id;
          end loop;
          if n <> ${queues} then
            raise exception 'the scheduler queued % job(s)', n;
          end if;
        end $$`,
})
// One consumer round (as hearth_job_offboarding), as ConsumerRunner makes it: the advisory lock for
// (consumer, org), or stop; the checkpoint; the batch below the horizon, read before anything is
// written; its effects (one job per event, which nothing deduplicates); the checkpoint moved by
// compare-and-set; the fence last.
const round = (consumer: string, effectKind: string): Step => ({
  as: 'offboarding',
  sql: `do $$
        declare
          v_tx xid8;
          v_id bigint;
          v_last_tx xid8;
          v_last_id bigint;
          v_ids bigint[];
          v_n int;
        begin
          if not pg_try_advisory_xact_lock(hashtextextended('hearth.outbox:${consumer}:${ORG}', 0)) then
            return;
          end if;
          select c.last_tx, c.last_id into v_tx, v_id from public.outbox_checkpoints c
          where c.org_id = '${ORG}' and c.consumer = '${consumer}';
          select coalesce(array_agg(b.id order by b.tx_id, b.id), '{}'), count(*) into v_ids, v_n
          from (select e.id, e.tx_id from public.outbox_events e
                where e.org_id = '${ORG}' and (e.tx_id, e.id) > (v_tx, v_id)
                  and e.tx_id < pg_snapshot_xmin(pg_current_snapshot())
                order by e.tx_id, e.id
                limit 500) b;
          if v_n = 0 then
            return;
          end if;
          select e.tx_id, e.id into v_last_tx, v_last_id from public.outbox_events e where e.org_id = '${ORG}' and e.id = v_ids[v_n];
          insert into public.jobs (org_id, kind, feature_key, purpose, payload)
          select '${ORG}', '${effectKind}', 'core.system', 'accounts', jsonb_build_object('event', x) from unnest(v_ids) as x;
          update public.outbox_checkpoints set last_tx = v_last_tx, last_id = v_last_id, processed = processed + v_n, updated_at = now()
          where org_id = '${ORG}' and consumer = '${consumer}' and last_tx = v_tx and last_id = v_id;
          if not found then
            raise exception 'the checkpoint moved during the round';
          end if;
          perform public.feature_fence('core.system', '{1}');
        end $$`,
})
// ConsumerRunner.reset: the round's advisory lock, waited for, then the checkpoint back to the start.
const resetConsumer = (consumer: string): Step => ({
  as: 'offboarding',
  sql: `select pg_advisory_xact_lock(hashtextextended('hearth.outbox:${consumer}:${ORG}', 0));
        update public.outbox_checkpoints set last_tx = '0', last_id = 0, updated_at = now()
        where org_id = '${ORG}' and consumer = '${consumer}'`,
})
// The floor and the batch in one statement (TECH-SPEC T16 item 6), from a checkpoint.
const FLOOR_AND_BATCH = `
  with f as (select last_tx, last_id from public.outbox_floors where org_id = $1),
  b as (
    select id, tx_id from public.outbox_events
    where org_id = $1 and (tx_id, id) > ($2::xid8, $3::bigint) and tx_id < pg_snapshot_xmin(pg_current_snapshot())
    order by tx_id, id
    limit 500)
  select f.last_tx::text as floor_tx, f.last_id::text as floor_id, b.id::text as id, b.tx_id::text as tx_id
  from (select) as one left join f on true left join b on true
  order by b.tx_id, b.id`

async function jobState(watcher: Client, job: string): Promise<string | null> {
  return scalar(watcher, 'select state as v from public.jobs where id = $1', [id(job)])
}
async function effects(watcher: Client, key: string): Promise<number> {
  return Number(await scalar(watcher, 'select count(*)::text as v from public.jobs where idempotency_key = $1', [key]))
}

const CASES: Array<[string, (watcher: Client) => Promise<void>]> = [
  [
    'ACC-10: someone leaving is not given a role at the same time',
    refused(
      deactivate('b1'),
      grant(1, 'leadership'),
      "That person has left the organisation, so they can't be given a role.",
    ),
  ],
  [
    'ACC-07: someone leaving does not join a team at the same time',
    refused(deactivate('b2'), join('d1', 2), "That person has left the organisation, so they can't join a team."),
  ],
  [
    'ACC-07: nobody starts reporting to a manager who is leaving at the same time',
    refused(
      deactivate('b3'),
      { as: 'app', sql: `update public.people set manager_id = '${id('b3')}' where id = '${id('b4')}'` },
      'That manager has left the organisation.',
    ),
  ],
  [
    'ACC-07: nobody joins a team being archived at the same time',
    refused(archive('teams', 'd2'), join('d2', 4), 'That team is archived, so nobody can join it.'),
  ],
  [
    'ACC-10: nobody becomes Team Admin of a team being archived at the same time',
    refused(
      { ...archive('teams', 'd3'), as: 'owner' },
      grant(5, 'team_admin', 'd3'),
      'That team is archived, so nobody can be its Team Admin.',
    ),
  ],
  [
    'ACC-07: nobody is added to a department being archived at the same time',
    refused(
      archive('departments', 'c1'),
      { as: 'app', sql: `update public.people set department_id = '${id('c1')}' where id = '${id('b6')}'` },
      'That department is archived, so nobody can be added to it.',
    ),
  ],
  [
    'ACC-04: no session starts on a device being signed out at the same time',
    refused(signOut('e1'), signIn('e1', 'f1'), 'That device has been signed out.'),
  ],
  [
    'ADM-06, D45: the audit log is not read by someone whose reading role is being revoked',
    refused(
      {
        as: 'owner',
        sql: `update public.role_assignments set revoked_at = now(), revoked_by = '${ADMIN}'
              where org_id = '${ORG}' and person_id = '${id('b7')}' and role = 'dpo'`,
      },
      readAuditLog('b7'),
      'None of your roles can read the audit log.',
    ),
  ],
  [
    'ADM-06, D45: the audit log is not read through a role being taken off the readers list',
    refused(
      {
        as: 'owner',
        sql: `update public.audit_log_readers set removed_at = now(), removed_by = '${ADMIN}'
              where org_id = '${ORG}' and role = 'compliance_officer' and removed_at is null`,
      },
      readAuditLog('b9'),
      'None of your roles can read the audit log.',
    ),
  ],
  [
    'ADM-06, D45: the audit log is not read by someone being deactivated',
    refused(deactivate('ba'), readAuditLog('ba'), 'None of your roles can read the audit log.'),
  ],
  [
    'ACC-04: a device signed out while a session starts on it ends that session',
    async watcher => {
      const { waited, error } = await race(watcher, signIn('e2', 'f2'), signOut('e2'))
      expect(waited, 'the sign-out did not wait for the new session')
      expect(error === undefined, `the sign-out failed: ${error}`)
      const session = await watcher.query<{ reason: string | null }>(
        'select revoke_reason as reason from public.sessions where id = $1',
        [id('f2')],
      )
      expect(session.rows[0]?.reason === 'device_sign_out', 'the new session is still open on a signed-out device')
    },
  ],
  [
    'ACC-05: no session starts for someone being deactivated at the same time',
    refused(
      deactivate('bb'),
      signInAs('bb', 'e3', 'f3'),
      "That person has left the organisation, so they can't sign in.",
    ),
  ],
  [
    'ACC-05: someone deactivated while a session starts has that session ended',
    async watcher => {
      const { waited, error } = await race(watcher, signInAs('bc', 'e4', 'f4'), deactivate('bc'))
      expect(waited, 'the deactivation did not wait for the new session')
      expect(error === undefined, `the deactivation failed: ${error}`)
      const [reason] = await revokeReasons(watcher, ['f4'])
      expect(reason === 'deactivated', `the new session of someone who has left ended with ${reason ?? 'nothing'}`)
      expect(await signedOut(watcher, ['e4']), 'the device of someone who has left is still signed in')
    },
  ],
  [
    'ACC-05: no device is added for someone being deactivated at the same time',
    refused(
      deactivate('be'),
      addDevice('be', 'e7'),
      'That person has left the organisation, so no device can be added for them.',
    ),
  ],
  [
    'ACC-05: no passkey is added for someone being deactivated at the same time',
    refused(
      deactivate('bf'),
      addPasskey('bf', 'e8'),
      "That person has left the organisation, so they can't add a passkey.",
    ),
  ],
  [
    'ACC-05 T5: a session lookup waits for a deactivation in progress and then finds nothing',
    async watcher => {
      const { waited, error } = await race(watcher, deactivate('bd'), {
        as: 'app',
        sql: `do $$ begin
                if exists (select 1 from public.session_by_token(sha256('f5'::bytea), '30 days')) then
                  raise exception 'the lookup found the session of someone who has left';
                end if;
              end $$`,
      })
      expect(waited, 'the lookup did not wait for the deactivation')
      expect(error === undefined, `the lookup failed: ${error}`)
    },
  ],
  [
    "ACC-05 T5: a session lookup takes the person's row before the device's, so it never deadlocks with a deactivation",
    async watcher => {
      // A holds b0's person row (an update no trigger watches), as a deactivation would before it
      // goes on to the devices. The lookup in B must wait there, holding nothing of b0's device.
      const a = await connect(DB)
      const b = await connect(DB)
      try {
        const pid = (await b.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid ?? 0
        await begin(a, { as: 'app', sql: '' })
        await a.query(`update public.people set full_name = full_name where org_id = '${ORG}' and id = '${id('b0')}'`)
        await begin(b, { as: 'app', sql: '' })
        const pending = b.query("select * from public.session_by_token(sha256('f6'::bytea), '30 days')").then(
          result => result.rows.length,
          (error: unknown) => message(error),
        )
        const waited = await waitsOnLock(watcher, pid)
        // Under Postgres's deadlock_timeout (1 s), so a wrong order shows as this timeout rather
        // than as the lookup being picked to fail.
        await a.query("set local lock_timeout = '500ms'")
        const device = await a
          .query(`select id from public.devices where org_id = '${ORG}' and user_id = '${id('b0')}' for update`)
          .then(
            () => undefined,
            (error: unknown) => message(error),
          )
        await a.query('rollback')
        const found = await pending
        await b.query('rollback')
        expect(waited, "the lookup did not wait for the person's row")
        expect(
          device === undefined && typeof found === 'number',
          `the lookup locked the device before the person: ${device ?? found}`,
        )
        expect(found === 1, `once the person's row was free, the lookup found ${found} session(s) instead of 1`)
      } finally {
        await a.end()
        await b.end()
      }
    },
  ],
  [
    "ACC-04: signing all of someone's devices out ends a sign-in in progress",
    async watcher => {
      const { waited, error } = await race(watcher, signInNow('c2', 'ec', 'f9'), signOutAll('c2'))
      expect(waited, 'signing out did not wait for the sign-in')
      expect(error === undefined, `signing out failed: ${error}`)
      const reasons = await revokeReasons(watcher, ['f8', 'f9'])
      expect(
        reasons.every(reason => reason === 'device_sign_out'),
        `the sessions ended with ${reasons.map(reason => reason ?? 'nothing').join(' and ')}`,
      )
      expect(await signedOut(watcher, ['ec', 'ef']), 'a device is still signed in')
    },
  ],
  [
    'ACC-06: a PIN reset ends a passkey sign-in in progress',
    async watcher => {
      const passkey = `select 1 from public.passkeys where org_id = '${ORG}' and id = '${id('9b')}' for update;`
      const { waited, error } = await race(watcher, signInNow('c3', 'ed', 'fa', passkey), resetPin('c3'))
      expect(waited, 'the PIN reset did not wait for the sign-in')
      expect(error === undefined, `the PIN reset failed: ${error}`)
      const [reason] = await revokeReasons(watcher, ['fa'])
      expect(reason === 'pin_reset', `the new session ended with ${reason ?? 'nothing'}`)
      const pin = await watcher.query<{ cleared: boolean }>(
        'select pin_hash is null as cleared from public.users where id = $1',
        [id('c3')],
      )
      expect(pin.rows[0]?.cleared === true, 'the PIN is still set')
    },
  ],
  [
    "D46 AQ-02: a code-only sign-in finish waits for a role grant holding the person's row, then reads the role and issues nothing",
    async watcher => {
      const { waited, error } = await race(watcher, grantPinRole('c9', 'admin'), codeOnlyFinish('c9', 'd9', 'f0'))
      expect(waited, 'the finish did not wait for the grant, so it could not see it')
      expect(error?.includes('pin role') === true, `expected the PIN step, got ${error ?? 'a session'}`)
      const made = await watcher.query('select 1 from public.sessions where user_id = $1', [id('c9')])
      expect(made.rowCount === 0, 'a session was issued to a PIN-role holder on the code alone')
    },
  ],
  [
    'ACC-06 T14: no session is issued through a number being removed at the same time',
    refused(removeNumber('9c'), issueThrough('c4', '9c', 'ee', 'fb'), 'the number was removed'),
  ],
  [
    "§9.4 ACC-05: an admin being deactivated can't act at the same moment",
    refused(deactivate('c5'), actAs('c5', 'eb', 'f7'), 'the actor has left'),
  ],
  [
    'T17 PRD-65: a job finishing while its flag is switched off waits for the change, then commits nothing',
    async watcher => {
      await refused(
        setFlag('k01', false),
        finishJob('11', '21', [1], 'effect:e01'),
        'That feature is switched off (k01).',
      )(watcher)
      expect((await effects(watcher, 'effect:e01')) === 0, 'the effect committed after the flag was switched off')
      expect((await jobState(watcher, '11')) === 'running', 'the job finished after its flag was switched off')
    },
  ],
  [
    'T17 PRD-65: a flag change waits for a job finishing under it, and the effect commits first',
    async watcher => {
      const { waited, error } = await race(watcher, finishJob('12', '22', [1], 'effect:e02'), setFlag('k02', false))
      expect(waited, 'the flag change did not wait for the job holding its flag')
      expect(error === undefined, `the flag change failed: ${error}`)
      expect((await effects(watcher, 'effect:e02')) === 1, 'the effect did not commit')
      expect((await jobState(watcher, '12')) === 'succeeded', 'the job did not finish')
      const revision = await scalar(watcher, "select revision::text as v from public.feature_flags where key = 'k02'")
      expect(revision === '2', `the flag change did not commit after it (revision ${revision})`)
    },
  ],
  [
    'T17 PRD-65: a consumer fencing a feature waits for a flag above it being switched off, then commits nothing',
    async watcher => {
      const before = await scalar(
        watcher,
        "select processed::text as v from public.outbox_checkpoints where consumer = 'race03'",
      )
      await refused(
        setFlag('k03', false),
        fenceRound('race03', 'k03.child', [1, 1]),
        'That feature is switched off (k03).',
      )(watcher)
      const after = await scalar(
        watcher,
        "select processed::text as v from public.outbox_checkpoints where consumer = 'race03'",
      )
      expect(before === after, "the round's effect committed after the flag above was switched off")
    },
  ],
  [
    "T17 PRD-65: a change to a flag above a feature waits for a consumer's fence, which commits first",
    async watcher => {
      const { waited, error } = await race(watcher, fenceRound('race03b', 'k03b.child', [1, 1]), setFlag('k03b', false))
      expect(waited, "the flag change did not wait for the consumer's fence")
      expect(error === undefined, `the flag change failed: ${error}`)
      const processed = await scalar(
        watcher,
        "select processed::text as v from public.outbox_checkpoints where consumer = 'race03b'",
      )
      expect(processed === '1', "the round's effect did not commit")
    },
  ],
  [
    'T17 PRD-65: a job for someone a cohort is narrowed to leave out waits for the change, then commits nothing',
    async watcher => {
      // Narrowed to b4, who is still at the org (b1 and b2 have left by now, and a cohort may
      // name only people still here).
      await refused(
        setFlag('k04', true, { people: ['b4'] }),
        finishJob('14', '24', [1], 'effect:e04'),
        "That feature's flags have changed since this work checked them.",
      )(watcher)
      expect((await effects(watcher, 'effect:e04')) === 0, 'the effect committed after its person left the cohort')
    },
  ],
  [
    'T17: a flag change does not wait for a job being queued for its feature',
    async watcher => {
      const enqueue: Step = {
        as: 'offboarding',
        sql: `insert into public.jobs (org_id, kind, feature_key, purpose, idempotency_key)
              values ('${ORG}', 'test.effect', 'k05', 'accounts', 'effect:e05')`,
      }
      const error = await alongside(enqueue, setFlag('k05', false))
      expect(error === undefined, `the flag change waited for, or failed beside, the enqueue: ${error}`)
      expect((await effects(watcher, 'effect:e05')) === 1, 'the job was not queued')
    },
  ],
  [
    'T15: the lease sweep passes a job its finishing transaction holds, and sweeps the rest',
    async watcher => {
      const error = await alongside(finishJob('16', '26', [1], 'effect:e06'), sweep(['16', '18'], ['18']))
      expect(error === undefined, `the sweep waited for the finishing job, or took it: ${error}`)
      expect((await jobState(watcher, '16')) === 'succeeded', 'the job the sweep passed by did not finish')
      expect((await jobState(watcher, '18')) === 'queued', 'the sweep did not requeue the job whose lease ran out')
    },
  ],
  [
    'T15: a job whose lease the sweep has taken back cannot finish (HF002)',
    async watcher => {
      await refused(
        sweep(['17'], ['17']),
        finishJob('17', '27', [1], 'effect:e06b'),
        "That job is no longer this worker's to finish.",
      )(watcher)
      expect((await effects(watcher, 'effect:e06b')) === 0, 'the swept job committed its effect')
      expect((await jobState(watcher, '17')) === 'queued', 'the swept job is not queued')
    },
  ],
  [
    'T15: a heartbeat renewing first leaves the sweep nothing to take',
    async watcher => {
      const error = await alongside(heartbeat('1a', '2a', 1), sweep(['1a'], []))
      expect(error === undefined, `the sweep waited for the heartbeat, or took the job: ${error}`)
      const later = await connect(DB)
      try {
        await begin(later, sweep(['1a'], []))
        await later.query(sweep(['1a'], []).sql)
        await later.query('commit')
      } finally {
        await later.end()
      }
      expect((await jobState(watcher, '1a')) === 'running', 'the renewed job was swept')
    },
  ],
  [
    'T15: a heartbeat after the sweep renews nothing',
    async watcher => {
      const { waited, error } = await race(watcher, sweep(['1b'], ['1b']), heartbeat('1b', '2b', 0))
      expect(waited, 'the heartbeat did not wait for the sweep')
      expect(error === undefined, `the heartbeat failed: ${error}`)
      expect((await jobState(watcher, '1b')) === 'queued', 'the swept job is not queued')
    },
  ],
  [
    'T15: a job given back cannot then finish (HF002)',
    async watcher => {
      await refused(
        giveBack('1c', '2c', 1),
        finishJob('1c', '2c', [1], 'effect:e08'),
        "That job is no longer this worker's to finish.",
      )(watcher)
      expect((await effects(watcher, 'effect:e08')) === 0, 'the job given back committed its effect')
      expect((await jobState(watcher, '1c')) === 'queued', 'the job given back is not queued')
    },
  ],
  [
    'T15: a give-back after the job finished changes nothing',
    async watcher => {
      const { waited, error } = await race(watcher, finishJob('1d', '2d', [1], 'effect:e08b'), giveBack('1d', '2d', 0))
      expect(waited, 'the give-back did not wait for the finishing job')
      expect(error === undefined, `the give-back failed: ${error}`)
      expect((await jobState(watcher, '1d')) === 'succeeded', 'the finished job was given back')
      expect((await effects(watcher, 'effect:e08b')) === 1, 'the effect did not commit')
    },
  ],
  [
    'T15: of two claimers, one claims the job and the other neither waits nor claims it',
    async watcher => {
      const error = await alongside(claim('test.claim', 'worker-a', 1), claim('test.claim', 'worker-b', 0))
      expect(error === undefined, `the second claimer waited or claimed: ${error}`)
      const claimed = await scalar(
        watcher,
        "select format('%s %s %s', state, attempts, claimed_by) as v from public.jobs where id = $1",
        [id('19')],
      )
      expect(claimed === 'running 1 worker-a', `the job is ${claimed}`)
    },
  ],
  [
    'T15: two schedulers firing one schedule make one run and one job',
    async watcher => {
      const error = await alongside(fire('30', 1), fire('30', 0))
      expect(error === undefined, `the second scheduler waited or fired: ${error}`)
      const runs = await scalar(
        watcher,
        `select format('%s %s', count(distinct r.id), count(j.id)) as v
         from public.schedule_runs r left join public.jobs j on j.schedule_run_id = r.id where r.schedule_id = $1`,
        [id('30')],
      )
      expect(runs === '1 1', `the schedule has ${runs} run(s) and job(s)`)
    },
  ],
  [
    'T15: a firing whose run already exists queues no job, though it read the schedule too',
    async watcher => {
      const late: Step = {
        as: 'queue',
        sql: `do $$
              declare
                run uuid;
              begin
                insert into public.schedule_runs (org_id, schedule_id, scheduled_for, on_interrupt)
                values ('${ORG}', '${id('31')}', '2026-10-01 03:00:00+00', 'rerun')
                on conflict do nothing
                returning id into run;
                if run is not null then
                  raise exception 'a second run was made for one occurrence';
                end if;
              end $$`,
      }
      const { waited, error } = await race(watcher, fire('31', 1), late)
      expect(waited, 'the second firing did not wait for the first run')
      expect(error === undefined, `the second firing failed: ${error}`)
      const runs = await scalar(
        watcher,
        `select format('%s %s', count(distinct r.id), count(j.id)) as v
         from public.schedule_runs r left join public.jobs j on j.schedule_run_id = r.id where r.schedule_id = $1`,
        [id('31')],
      )
      expect(runs === '1 1', `the schedule has ${runs} run(s) and job(s)`)
    },
  ],
  [
    'T16: of two rounds of one consumer in one org, one runs and the other is busy; no event is handled twice',
    async watcher => {
      const busy: Step = {
        as: 'offboarding',
        sql: `do $$ begin
                if pg_try_advisory_xact_lock(hashtextextended('hearth.outbox:race12:${ORG}', 0)) then
                  raise exception 'a second round ran at the same time';
                end if;
              end $$`,
      }
      const error = await alongside(round('race12', 'test.handled12'), busy)
      expect(error === undefined, `the second round waited or ran: ${error}`)
      // A round after both: nothing left to handle.
      const again = await connect(DB)
      try {
        await begin(again, round('race12', 'test.handled12'))
        await again.query(round('race12', 'test.handled12').sql)
        await again.query('commit')
      } finally {
        await again.end()
      }
      const handled = await scalar(
        watcher,
        `select format('%s %s', count(*), count(distinct payload ->> 'event')) as v from public.jobs where kind = 'test.handled12'`,
      )
      const events = await scalar(watcher, 'select count(*)::text as v from public.outbox_events where org_id = $1', [
        ORG,
      ])
      expect(handled === `${events} ${events}`, `the rounds handled ${handled} (all, distinct) of ${events} events`)
    },
  ],
  [
    'T16: a reset waits for the round in progress, then wins',
    async watcher => {
      const { waited, error } = await race(watcher, round('race13', 'test.handled13'), resetConsumer('race13'))
      expect(waited, 'the reset did not wait for the round')
      expect(error === undefined, `the reset failed: ${error}`)
      const checkpoint = await scalar(
        watcher,
        "select format('%s %s %s', last_tx, last_id, processed > 0) as v from public.outbox_checkpoints where consumer = 'race13'",
      )
      expect(checkpoint === '0 0 t', `the checkpoint is ${checkpoint}, not the reset's after the round's`)
    },
  ],
  [
    "T16: a reset that slips in without the round's lock makes the round's compare-and-set match nothing",
    async watcher => {
      const roundSide = await connect(DB)
      const resetSide = await connect(DB)
      try {
        await begin(roundSide, { as: 'offboarding', sql: '' })
        const read = await roundSide.query<{ last_tx: string; last_id: string }>(
          "select last_tx::text, last_id::text from public.outbox_checkpoints where org_id = $1 and consumer = 'race13b'",
          [ORG],
        )
        const at = read.rows[0]
        expect(at !== undefined && at.last_tx !== '0', 'the round read no checkpoint, or one at the start')
        await begin(resetSide, { as: 'offboarding', sql: '' })
        await resetSide.query(
          "update public.outbox_checkpoints set last_tx = '0', last_id = 0, updated_at = now() where org_id = $1 and consumer = 'race13b'",
          [ORG],
        )
        await resetSide.query('commit')
        const moved = await roundSide.query(
          `update public.outbox_checkpoints set last_tx = $3::xid8, last_id = $4, processed = processed + 1
           where org_id = $1 and consumer = 'race13b' and last_tx = $2::xid8 and last_id = $5`,
          [ORG, at?.last_tx, at?.last_tx, Number(at?.last_id) + 1, at?.last_id],
        )
        await roundSide.query('rollback')
        expect(moved.rowCount === 0, "the round's compare-and-set moved a checkpoint the reset had moved")
      } finally {
        await roundSide.end()
        await resetSide.end()
      }
      const checkpoint = await scalar(
        watcher,
        "select format('%s %s', last_tx, last_id) as v from public.outbox_checkpoints where consumer = 'race13b'",
      )
      expect(checkpoint === '0 0', `the checkpoint is ${checkpoint}, not the reset's`)
    },
  ],
  [
    'T16: the outbox horizon hides a later event until an earlier writer commits, then shows both in order',
    async () => {
      const early = await connect(DB)
      const late = await connect(DB)
      const reader = await connect(DB)
      const append = (
        n: number,
      ) => `insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose)
        values ('${ORG}', 'signin.started', 'person', '${id(`b${n}`)}', '${ADMIN}', 'human', 'accounts')`
      const visible = async () => {
        await begin(reader, { as: 'offboarding', sql: '' })
        const rows = await reader.query<{ entity: string }>(
          `select entity_id::text as entity from public.outbox_events
           where org_id = $1 and type = 'signin.started' and tx_id < pg_snapshot_xmin(pg_current_snapshot()) order by tx_id, id`,
          [ORG],
        )
        await reader.query('commit')
        return rows.rows.map(row => row.entity)
      }
      try {
        await begin(early, { as: 'app', sql: '' })
        await early.query(append(1))
        await begin(late, { as: 'app', sql: '' })
        await late.query(append(2))
        await late.query('commit')
        const during = await visible()
        expect(during.length === 0, `while the earlier writer was open the consumer saw ${during.length} event(s)`)
        await early.query('commit')
        const after = await visible()
        expect(
          after.join(' ') === `${id('b1')} ${id('b2')}`,
          `after both committed the consumer saw ${after.length} event(s), not both in order`,
        )
      } finally {
        await early.end()
        await late.end()
        await reader.end()
      }
    },
  ],
  [
    'T16: a purge committing during a round shows the round its floor above its checkpoint, with the rest, in one statement',
    async watcher => {
      // Everything so far is made 15 days old (the superuser), and two new events follow.
      await watcher.query(`update public.outbox_events set at = now() - interval '15 days' where org_id = $1`, [ORG])
      await watcher.query(`begin; select set_config('app.user_id', '${SYSTEM}', true);
        insert into public.outbox_events (org_id, type, entity_type, entity_id, actor_id, actor_kind, purpose)
        select '${ORG}', 'flag.changed', 'feature_flag', gen_random_uuid(), '${SYSTEM}', 'system', 'service_operation'
        from generate_series(1, 2);
        commit`)
      const roundSide = await connect(DB)
      const purgeSide = await connect(DB)
      try {
        await begin(roundSide, { as: 'offboarding', sql: '' })
        const read = await roundSide.query<{ last_tx: string; last_id: string }>(
          "select last_tx::text, last_id::text from public.outbox_checkpoints where org_id = $1 and consumer = 'race14'",
          [ORG],
        )
        const at = read.rows[0]
        expect(at?.last_tx === '0' && at.last_id === '0', 'the consumer is not at the start')
        await begin(purgeSide, { as: 'purge', sql: '' })
        const purged = await purgeSide.query<{ n: number }>('select public.purge_outbox(5000) as n')
        await purgeSide.query('commit')
        expect((purged.rows[0]?.n ?? 0) > 0, 'the purge deleted nothing')
        const seen = await roundSide.query<{
          floor_tx: string | null
          floor_id: string | null
          id: string | null
          tx_id: string | null
        }>(FLOOR_AND_BATCH, [ORG, at?.last_tx, at?.last_id])
        await roundSide.query('rollback')
        const floor = seen.rows[0]
        expect(
          floor?.floor_tx !== null && floor?.floor_tx !== undefined,
          'the round did not see the floor the purge wrote',
        )
        const below = seen.rows.filter(
          row =>
            row.id !== null &&
            (BigInt(row.tx_id ?? 0) < BigInt(floor?.floor_tx ?? 0) ||
              (row.tx_id === floor?.floor_tx && BigInt(row.id) <= BigInt(floor?.floor_id ?? 0))),
        )
        expect(below.length === 0, `the round saw ${below.length} event(s) at or below the floor`)
        expect(
          seen.rows.filter(row => row.id !== null).length === 2,
          `the round saw ${seen.rows.length} event(s) above the floor, not the 2 new ones`,
        )
      } finally {
        await roundSide.end()
        await purgeSide.end()
      }
    },
  ],
  [
    'T17 R2E2E-2: a cohort cannot name someone being deactivated at the same moment',
    refused(
      deactivate('b6'),
      setFlag('k16', true, { people: ['b6'] }),
      'A cohort can only add people who are still at this organisation.',
    ),
  ],
  [
    'T17 CLAUDE.md: an Admin being deactivated cannot change a flag at the same moment',
    refused(
      deactivate('c7'),
      setFlag('k16', false, { user: id('c7') }),
      'Only an Owner or Admin can change a feature flag.',
    ),
  ],
  [
    'T17 CLAUDE.md: an Admin whose role is being revoked cannot change a flag at the same moment',
    refused(
      {
        as: 'owner',
        sql: `update public.role_assignments set revoked_at = now(), revoked_by = '${ADMIN}'
              where org_id = '${ORG}' and person_id = '${id('c8')}' and role = 'admin'`,
      },
      setFlag('k16', false, { user: id('c8') }),
      'Only an Owner or Admin can change a feature flag.',
    ),
  ],
  [
    // The people a change adds are judged against the cohort read before the flag's row is locked, so
    // a change committed in between makes it try again (40001, the route's 409 try_again).
    'T17: a cohort judged against a cohort that changed meanwhile is tried again',
    refused(
      {
        as: 'app',
        user: OWNER,
        // b5 is still here; the no-op update holds its row, so the change below waits for this one.
        sql: `update public.people set deactivated_at = null where id = '${id('b5')}' and deactivated_at is null;
              select public.set_feature_flag('k16', true, 'cohort', array['${id('b9')}']::uuid[], '{}', 'race', null, null)`,
      },
      setFlag('k16', true, { people: ['b5'] }),
      'This flag changed at the same moment. Try again.',
    ),
  ],
  [
    // The send's FOR SHARE on the open clearance waits for the withdrawal's update, then sees it
    // ended (T22 item 8; PD-15's bound covers only a withdrawal committing after this decision).
    'PDPA-10 T22: a code check waits for a withdrawal in progress, then finds Twilio not cleared',
    refused(withdrawClearance('twilio'), codeCheck('twilio'), 'the code check found twilio not cleared'),
  ],
  [
    'PDPA-10 T22: a withdrawal waits for a code check that has read the clearance',
    async watcher => {
      const { waited, error } = await race(watcher, codeCheck('aws'), withdrawClearance('aws'))
      expect(waited, 'the withdrawal did not wait for the code check holding the clearance')
      expect(error === undefined, `the withdrawal failed: ${error}`)
      const reason = await scalar(
        watcher,
        `select withdraw_reason as v from public.transfer_clearances where org_id = $1 and provider = 'aws'`,
        [ORG],
      )
      expect(reason === 'dpo_decision', `the clearance ended with ${reason ?? 'nothing'}`)
    },
  ],
  [
    // The clearance the check waited on ends, and the next is granted, in one commit: the
    // function's second read finds the new one (T22 item 8).
    'PDPA-10 T22: saving new facts and keeping the clearance never leaves a code check reading not cleared',
    async watcher => {
      const { waited, error } = await race(watcher, recordFacts('livekit', 2, '60 days', true), codeCheck('livekit'))
      expect(waited, 'the code check did not wait for the save in progress')
      expect(error === undefined, `the code check read: ${error}`)
      const open = await scalar(
        watcher,
        `select register_revision::text as v from public.transfer_clearances
         where org_id = $1 and provider = 'livekit' and withdrawn_at is null`,
        [ORG],
      )
      expect(open === '3', `the open clearance rests on revision ${open ?? 'none'}, not the new facts' 3`)
    },
  ],
  [
    'PDPA-10 T22: a clearance and a change to its facts never pass each other',
    async watcher => {
      // A change of facts that waits for a clearance in progress sees it, and ends it.
      const first = await race(
        watcher,
        clearEntry('apple_push', 2),
        recordFacts('apple_push', 2, '60 days', false, '62'),
      )
      expect(first.waited, 'the change of facts did not wait for the clearance in progress')
      expect(first.error === undefined, `the change of facts failed: ${first.error}`)
      const ended = await scalar(
        watcher,
        `select withdraw_reason || ' ' || register_revision as v from public.transfer_clearances
         where org_id = $1 and provider = 'apple_push'`,
        [ORG],
      )
      expect(ended === 'facts_changed 2', `the clearance on the old facts ended as ${ended ?? 'nothing'}`)
      // A clearance that waits for a change of facts in progress is refused as made from the old
      // revision (HF005), never granted on facts the DPO hasn't seen.
      const second = await race(
        watcher,
        recordFacts('apple_push', 3, '90 days', false),
        clearEntry('apple_push', 3, '62'),
      )
      expect(second.waited, 'the clearance did not wait for the change of facts in progress')
      expect(second.error?.includes(REGISTER_CHANGED) === true, `expected HF005, got ${second.error ?? 'success'}`)
      const open = await scalar(
        watcher,
        `select count(*)::text as v from public.transfer_clearances where org_id = $1 and provider = 'apple_push'
         and withdrawn_at is null`,
        [ORG],
      )
      expect(open === '0', `${open} clearance(s) of apple_push are open`)
    },
  ],
  [
    'PDPA-01 T22: of two changes to one purpose from one version, the second waits and is refused (HF005)',
    refused(
      setPurpose('presence_receipts', 1, 'active'),
      setPurpose('presence_receipts', 1, 'retired', '62'),
      REGISTER_CHANGED,
    ),
  ],
  [
    'PDPA-13 T22: a DPO being deactivated can’t change a register at the same moment',
    refused(deactivate('64'), setPurpose('access_logs', 1, 'active', '64'), REGISTER_DPO_REFUSED),
  ],
  [
    'PDPA-13 T22: a DPO whose role is being revoked can’t change a register at the same moment',
    refused(
      {
        as: 'owner',
        sql: `update public.role_assignments set revoked_at = now(), revoked_by = '${ADMIN}'
              where org_id = '${ORG}' and person_id = '${id('66')}' and role = 'dpo'`,
      },
      withdrawClearance('aws', '66'),
      REGISTER_DPO_REFUSED,
    ),
  ],
  [
    'PDPA-04a T22: a restriction and a basis leaving consent never pass each other',
    async watcher => {
      // A basis leaving consent waits for a restriction in progress, then keeps to consent (HF006).
      const first = await race(watcher, restrict('65', 'session_sharing'), setPurpose('session_sharing', 2, 'active'))
      expect(first.waited, 'the change of basis did not wait for the restriction in progress')
      expect(
        first.error?.includes('Withdrawals are recorded against this purpose') === true,
        `expected the change of basis refused, got ${first.error ?? 'success'}`,
      )
      // A restriction waits for a basis leaving consent in progress, then finds the purpose no longer
      // rests on consent.
      const second = await race(
        watcher,
        setPurpose('content_delivery', 2, 'active'),
        restrict('65', 'content_delivery'),
      )
      expect(second.waited, 'the restriction did not wait for the change of basis in progress')
      expect(
        second.error?.includes('applies only to a purpose the register records as resting on consent') === true,
        `expected the restriction refused, got ${second.error ?? 'success'}`,
      )
    },
  ],
  [
    // B-02: the org's own row is what two publishes take turns on, so two first publishes (no
    // version to lock yet) serialise like any two, and the second is refused as stale (HF007),
    // never by the numbering's checks (23505 or 23514).
    'NTR-04 PDPA-03 C0.9 B-02: of two publishes from one seen, the first two included, the second waits and is refused (HF007); one after another from a stale seen is refused at once',
    async watcher => {
      const first = await race(watcher, publish('Race v0'), publish('Race v0 again', { dpo: '62' }))
      expect(first.waited, 'the second first publish did not wait for the first')
      expect(first.error?.includes(NOTICE_NEWER) === true, `expected HF007, got ${first.error ?? 'success'}`)
      const second = await race(
        watcher,
        publish('Race v1', { seen: 0 }),
        publish('Race v1 again', { dpo: '62', seen: 0 }),
      )
      expect(second.waited, 'the second publish from one seen did not wait for the first')
      expect(second.error?.includes(NOTICE_NEWER) === true, `expected HF007, got ${second.error ?? 'success'}`)
      // P1 committed before P2 starts: P2's seen is a version that is no longer the latest.
      const stale = await alone(publish('Race v1 late', { seen: 0 }))
      expect(stale?.includes(NOTICE_NEWER) === true, `expected HF007, got ${stale ?? 'success'}`)
      const versions = await noticeVersions(watcher)
      expect(versions === '0:c09.1,1:c09.1', `the org has versions ${versions ?? 'none'}`)
    },
  ],
  [
    'NTR-01 PDPA-03 C0.9 PD-42: an acknowledgement waits for a publish in progress and is refused (HF007); a publish waits for an acknowledgement in progress, which stays the older version’s',
    async watcher => {
      const first = await race(watcher, publish('Race v2'), acknowledge('1'))
      expect(first.waited, 'the acknowledgement did not wait for the publish in progress')
      expect(first.error?.includes(NOTICE_ACK_NEWER) === true, `expected HF007, got ${first.error ?? 'success'}`)
      const second = await race(watcher, acknowledge('1'), publish('Race v3'))
      expect(second.waited, 'the publish did not wait for the acknowledgement in progress')
      expect(second.error === undefined, `the publish failed: ${second.error}`)
      const acknowledged = await scalar(
        watcher,
        `select string_agg(v.version::text, ',' order by v.version) as v from public.notice_acknowledgments a
         join public.notice_versions v on v.org_id = a.org_id and v.id = a.notice_version_id
         where a.org_id = $1 and a.person_id = $2`,
        [NOTICE_ORG, n('71')],
      )
      expect(acknowledged === '2', `n(71) acknowledged versions ${acknowledged ?? 'none'}, not 2 alone`)
      const versions = await noticeVersions(watcher)
      expect(versions?.endsWith(',2:c09.1,3:c09.1') === true, `the org has versions ${versions ?? 'none'}`)
    },
  ],
  [
    'NTR-02 PDPA-01 C0.9 PD-34 PD-40: a publish waits for a purpose change in progress and is refused as made from older sources (HF007); a purpose change waits for a publish in progress, which lists the version it locked',
    async watcher => {
      const first = await race(watcher, noticePurpose('presence_receipts', 1), publish('Race v4'))
      expect(first.waited, 'the publish did not wait for the purpose change in progress')
      expect(first.error?.includes(NOTICE_SOURCES_MOVED) === true, `expected HF007, got ${first.error ?? 'success'}`)
      const second = await race(watcher, publish('Race v4'), noticePurpose('presence_receipts', 2))
      expect(second.waited, 'the purpose change did not wait for the publish in progress')
      expect(second.error === undefined, `the purpose change failed: ${second.error}`)
      const listed = await scalar(
        watcher,
        `select l.register_version::text as v from public.notice_version_purposes l
         join public.notice_versions v on v.org_id = l.org_id and v.id = l.notice_version_id
         where l.org_id = $1 and v.version = 4 and l.purpose = 'presence_receipts'`,
        [NOTICE_ORG],
      )
      expect(listed === '2', `version 4 lists presence_receipts at ${listed ?? 'none'}, not the version 2 it locked`)
    },
  ],
  [
    'NTR-03 PDPA-10 C0.9 PD-34 PD-41: a publish waits for "save and keep cleared" or a clearance in progress and is refused (HF007); a withdrawal waits for a publish in progress, which lists the clearance then open',
    async watcher => {
      const kept = await race(watcher, noticeRecordFacts('twilio', 2, '60 days'), publish('Race v5'))
      expect(kept.waited, 'the publish did not wait for "save and keep cleared" in progress')
      expect(kept.error?.includes(NOTICE_SOURCES_MOVED) === true, `expected HF007, got ${kept.error ?? 'success'}`)
      const withdrawn = await race(watcher, publish('Race v5'), noticeWithdraw('aws'))
      expect(withdrawn.waited, 'the withdrawal did not wait for the publish in progress')
      expect(withdrawn.error === undefined, `the withdrawal failed: ${withdrawn.error}`)
      const listed = await scalar(
        watcher,
        `select (c.withdrawn_at is not null)::text as v from public.notice_version_providers l
         join public.notice_versions v on v.org_id = l.org_id and v.id = l.notice_version_id
         join public.transfer_clearances c on c.org_id = l.org_id and c.id = l.clearance_id
         where l.org_id = $1 and v.version = 5 and c.provider = 'aws'`,
        [NOTICE_ORG],
      )
      expect(
        listed === 'true',
        `version 5 lists aws's clearance as ${listed ?? 'missing'}, not the one since withdrawn`,
      )
      const cleared = await race(watcher, noticeClear('apple_push', 2), publish('Race v6'))
      expect(cleared.waited, 'the publish did not wait for the clearance in progress')
      expect(
        cleared.error?.includes(NOTICE_SOURCES_MOVED) === true,
        `expected HF007, got ${cleared.error ?? 'success'}`,
      )
    },
  ],
  [
    'NTR-07 PDPA-10 C0.9 PD-15 PD-41: a send never waits for a publish, nor a publish for a send, and a clearance the notice states never reads as anything but cleared',
    async watcher => {
      // A version that states the clearances open now (twilio's "kept cleared" one among them).
      const stated = await alone(publish('Race v6'))
      expect(stated === undefined, `the publish failed: ${stated}`)
      const during = await alongside(publish('Race v7'), sendState('twilio'))
      expect(during === undefined, `a send during a publish read: ${during}`)
      const before = await alongside(sendState('twilio'), publish('Race v8'))
      expect(before === undefined, `a publish during a send failed: ${before}`)
      const after = await alone(sendState('twilio'))
      expect(after === undefined, `a send after the publishes read: ${after}`)
      const versions = await noticeVersions(watcher)
      expect(versions?.endsWith(',6:c09.1,7:c09.1,8:c09.1') === true, `the org has versions ${versions ?? 'none'}`)
    },
  ],
  [
    'NTR-05 ACC-12 C0.9 PD-42: an acknowledgement waits for its person’s deactivation, or its device’s sign-out, in progress, and is refused',
    async watcher => {
      await refused(
        {
          as: 'app',
          org: NOTICE_ORG,
          user: n('61'),
          sql: `update public.people set deactivated_at = now(), deactivated_by = '${n('61')}' where id = '${n('72')}'`,
        },
        acknowledge('2'),
        'Only someone still at the organisation can acknowledge its notice.',
      )(watcher)
      await refused(
        {
          as: 'app',
          org: NOTICE_ORG,
          user: n('73'),
          sql: `update public.devices set signed_out_at = now(), signed_out_by = '${n('73')}' where id = '${n('e3')}'`,
        },
        acknowledge('3'),
        'That device has been signed out.',
      )(watcher)
      // Someone else's acknowledgement waits for nothing.
      expect((await alone(acknowledge('4'))) === undefined, 'n(74) could not acknowledge')
    },
  ],
  [
    'NTR-06 PDPA-13 C0.9 PD-49: a DPO being deactivated, or whose role is being revoked, can’t publish at the same moment',
    async watcher => {
      await refused(
        {
          as: 'app',
          org: NOTICE_ORG,
          user: n('61'),
          sql: `update public.people set deactivated_at = now(), deactivated_by = '${n('61')}' where id = '${n('63')}'`,
        },
        publish('Race v9', { dpo: '63' }),
        NOTICE_DPO_REFUSED,
      )(watcher)
      await refused(
        {
          as: 'owner',
          sql: `update public.role_assignments set revoked_at = now(), revoked_by = '${n('61')}'
                where org_id = '${NOTICE_ORG}' and person_id = '${n('64')}' and role = 'dpo'`,
        },
        publish('Race v9', { dpo: '64' }),
        NOTICE_DPO_REFUSED,
      )(watcher)
    },
  ],
  [
    'NTR-08 PDPA-02 C0.9 OD-11 PD-66: a publish waits for a contact change in progress and is refused as made from the older contact (HF007); a contact change waits for a publish in progress, which links the settings version it locked',
    async watcher => {
      const first = await race(watcher, contactChange(1, 'dpo2@race.example'), publish('Race v9'))
      expect(first.waited, 'the publish did not wait for the contact change in progress')
      expect(first.error?.includes(NOTICE_CONTACT_MOVED) === true, `expected HF007, got ${first.error ?? 'success'}`)
      const second = await race(watcher, publish('Race v9'), contactChange(2, 'dpo3@race.example', { dpo: n('62') }))
      expect(second.waited, 'the contact change did not wait for the publish in progress')
      expect(second.error === undefined, `the contact change failed: ${second.error}`)
      const linked = await scalar(
        watcher,
        `select format('%s:%s', v.version, v.dpo_settings_version) as v from public.notice_versions v
         where v.org_id = $1 order by v.version desc limit 1`,
        [NOTICE_ORG],
      )
      expect(
        linked === '9:2',
        `the latest version links ${linked ?? 'nothing'}, not 9:2 (the settings version it locked)`,
      )
      const contact = await scalar(
        watcher,
        'select max(version)::text as v from public.dpo_settings where org_id = $1',
        [NOTICE_ORG],
      )
      expect(contact === '3', `the contact is at version ${contact ?? 'none'}, not 3`)
    },
  ],
  [
    // C0.9 PD-63: with no version recorded there is nothing to lock, so the second of two first
    // records waits on the unique (org_id, version) index, and is refused as stale (HF005), never
    // with 23505; when the first rolls back it records version 1 itself.
    'NTR-09 PDPA-13 C0.9 OD-10 PD-63: of two contact changes from one version the second waits and is refused (HF005); of two first records the second waits on the index and is refused (HF005), or records version 1 when the first rolled back',
    async watcher => {
      await refused(
        contactChange(3, 'dpo4@race.example'),
        contactChange(3, 'dpo5@race.example', { dpo: n('62') }),
        CONTACT_CHANGED,
      )(watcher)
      const [committed, rolledBack] = CONTACT_ORGS
      const first = await race(
        watcher,
        contactChange(null, 'dpo@contact.example', { dpo: k('61'), org: committed }),
        contactChange(null, 'privacy@contact.example', { dpo: k('62'), org: committed }),
      )
      expect(first.waited, 'the second first record did not wait for the first')
      expect(first.error?.includes(CONTACT_CHANGED) === true, `expected HF005, got ${first.error ?? 'success'}`)
      const second = await race(
        watcher,
        contactChange(null, 'dpo@contact.example', { dpo: k('63'), org: rolledBack }),
        contactChange(null, 'privacy@contact.example', { dpo: k('64'), org: rolledBack }),
        'rollback',
      )
      expect(second.waited, 'the second first record did not wait for the first, rolled back')
      expect(second.error === undefined, `the second first record failed: ${second.error}`)
      const recorded = await scalar(
        watcher,
        `select string_agg(format('%s %s %s', case when s.org_id = $1 then 'committed' else 'rolled back' end, s.version,
                                  s.contact_email), ',' order by s.org_id, s.version) as v
         from public.dpo_settings s where s.org_id = any($2::uuid[])`,
        [committed, [committed, rolledBack]],
      )
      expect(
        recorded === 'committed 1 dpo@contact.example,rolled back 1 privacy@contact.example',
        `the contact orgs hold ${recorded ?? 'nothing'}`,
      )
    },
  ],
  [
    'NTR-10 PDPA-03 C0.9 OD-19 PD-75: a recorded acknowledgement waits for a publish in progress and is refused (HF007); a publish waits for a record in progress, which stays the older version’s',
    async watcher => {
      const first = await race(watcher, publish('Race v10'), recordAck('5'))
      expect(first.waited, 'the record did not wait for the publish in progress')
      expect(first.error?.includes(RECORD_NEWER) === true, `expected HF007, got ${first.error ?? 'success'}`)
      const second = await race(watcher, recordAck('5'), publish('Race v11'))
      expect(second.waited, 'the publish did not wait for the record in progress')
      expect(second.error === undefined, `the publish failed: ${second.error}`)
      const recorded = await scalar(
        watcher,
        `select string_agg(v.version || ' ' || a.method, ',' order by v.version) as v from public.notice_acknowledgments a
         join public.notice_versions v on v.org_id = a.org_id and v.id = a.notice_version_id
         where a.org_id = $1 and a.person_id = $2`,
        [NOTICE_ORG, n('75')],
      )
      expect(
        recorded === '10 recorded_by_dpo',
        `n(75)'s acknowledgements are ${recorded ?? 'none'}, not version 10's alone`,
      )
    },
  ],
  [
    'NTR-11 PDPA-03 PDPA-13 C0.9 OD-19 ACC-05: a record waits for its person’s deactivation in progress, and a record or a contact change waits for its DPO’s deactivation or loss of the role, and each is refused (42501)',
    async watcher => {
      const before = await scalar(
        watcher,
        `select (select count(*) from public.notice_acknowledgments where org_id = $1) || ' ' ||
                (select max(version) from public.dpo_settings where org_id = $1) as v`,
        [NOTICE_ORG],
      )
      await refused(
        deactivateIn(NOTICE_ORG, n('73'), n('61')),
        recordAck('3'),
        'Only someone still at the organisation can have an acknowledgement recorded.',
      )(watcher)
      await refused(
        deactivateIn(NOTICE_ORG, n('65'), n('61')),
        recordAck('4', { dpo: '65' }),
        NOTICE_DPO_REFUSED,
      )(watcher)
      await refused(revokeDpo(NOTICE_ORG, n('66'), n('61')), recordAck('4', { dpo: '66' }), NOTICE_DPO_REFUSED)(watcher)
      await refused(
        deactivateIn(NOTICE_ORG, n('67'), n('61')),
        contactChange(3, 'dpo6@race.example', { dpo: n('67') }),
        REGISTER_DPO_REFUSED,
      )(watcher)
      await refused(
        revokeDpo(NOTICE_ORG, n('68'), n('61')),
        contactChange(3, 'dpo6@race.example', { dpo: n('68') }),
        REGISTER_DPO_REFUSED,
      )(watcher)
      const after = await scalar(
        watcher,
        `select (select count(*) from public.notice_acknowledgments where org_id = $1) || ' ' ||
                (select max(version) from public.dpo_settings where org_id = $1) as v`,
        [NOTICE_ORG],
      )
      expect(after === before, `the refused writes changed the org: ${before ?? ''} before, ${after ?? ''} after`)
    },
  ],
  [
    // The second writer waits on the unique (org_id, person_id, notice_version_id) index for the
    // first, then finds its row and writes nothing (changed false): one row and one audit row.
    'NTR-12 PDPA-03 C0.9 OD-19 PD-42: a record and the person’s own acknowledgement of one version never both write, in either order',
    async watcher => {
      const first = await race(watcher, acknowledge('1'), recordAck('1', { unchanged: true }))
      expect(first.waited, 'the record did not wait for the acknowledgement in progress')
      expect(first.error === undefined, `the record wrote: ${first.error}`)
      const second = await race(watcher, recordAck('4'), acknowledgeUnchanged('4'))
      expect(second.waited, 'the acknowledgement did not wait for the record in progress')
      expect(second.error === undefined, `the acknowledgement wrote: ${second.error}`)
      for (const [member, method] of [
        ['71', 'in_app notice.acknowledge'],
        ['74', 'recorded_by_dpo notice.acknowledgement_recorded'],
      ] as const) {
        const written = await scalar(
          watcher,
          `select string_agg(a.method || ' ' || e.action, ',') as v from public.notice_acknowledgments a
           join public.audit_events e on e.org_id = a.org_id and e.target_type = 'person' and e.target_id = a.person_id::text
             and e.details ->> 'notice' = a.notice_version_id::text
           where a.org_id = $1 and a.person_id = $2 and a.notice_version_id = ${LATEST_ID}`,
          [NOTICE_ORG, n(member)],
        )
        expect(
          written === method,
          `n(${member})'s acknowledgement of the latest version and its audit rows are ${written ?? 'none'}`,
        )
      }
    },
  ],
  [
    'BGR-01 PDPA-10 C0.9 OD-20 PD-79: a re-clear waits for a DPO’s sign-in in progress and is refused (a DPO is signed in); a DPO’s sign-in waits for a re-clear in progress, then finds Twilio cleared',
    async watcher => {
      await refused(dpoSignIn('81', 'e1', 'f1'), reclear('81'), REGISTER_SIGNED_IN)(watcher)
      expect((await openTwilio(watcher)) === null, 'a refused re-clear cleared Twilio')
      await resetBreakGlass(watcher)
      const { waited, error } = await race(watcher, reclear('81'), dpoSignIn('81', 'e1', 'f2', true))
      expect(waited, 'the sign-in did not wait for the re-clear in progress')
      expect(error === undefined, `the sign-in failed: ${error}`)
      const open = await openTwilio(watcher)
      expect(open === 'break_glass 81', `Twilio's open clearances are ${open ?? 'none'}`)
      await resetBreakGlass(watcher)
    },
  ],
  [
    'BGR-02 PDPA-10 C0.9 OD-20 PD-79: a re-clear waits for a DPO’s sessions ending (every device, or one) and then clears Twilio',
    async watcher => {
      const issue = async (device: string, session: string) => {
        await watcher.query('insert into public.devices (id, org_id, user_id, label) values ($1, $2, $3, $4)', [
          g(device),
          BREAK_GLASS_ORG,
          g('82'),
          'Phone',
        ])
        await watcher.query(
          `insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at)
           values ($1, $2, $3, $4, sha256($5::bytea), now() + interval '7 days')`,
          [g(session), BREAK_GLASS_ORG, g('82'), g(device), `bg ${session}`],
        )
      }
      await issue('e3', 'f3')
      const all = await race(
        watcher,
        {
          as: 'app',
          org: BREAK_GLASS_ORG,
          user: g('82'),
          sql: `select 1 from public.people where org_id = '${BREAK_GLASS_ORG}' and id = '${g('82')}' for no key update;
                update public.devices set signed_out_at = now(), signed_out_by = '${g('82')}'
                where org_id = '${BREAK_GLASS_ORG}' and user_id = '${g('82')}' and signed_out_at is null`,
        },
        reclear('82'),
      )
      expect(all.waited, 'the re-clear did not wait for every device being signed out')
      expect(all.error === undefined, `the re-clear failed: ${all.error}`)
      await resetBreakGlass(watcher)
      await issue('e4', 'f4')
      const one = await race(
        watcher,
        {
          as: 'app',
          org: BREAK_GLASS_ORG,
          user: g('82'),
          sql: `select 1 from public.people where org_id = '${BREAK_GLASS_ORG}' and id = '${g('82')}' for share;
                update public.devices set signed_out_at = now(), signed_out_by = '${g('82')}' where id = '${g('e4')}'`,
        },
        reclear('82'),
      )
      expect(one.waited, 'the re-clear did not wait for one device being signed out')
      expect(one.error === undefined, `the re-clear failed: ${one.error}`)
      const open = await openTwilio(watcher)
      expect(open === 'break_glass 82', `Twilio's open clearances are ${open ?? 'none'}`)
      await resetBreakGlass(watcher)
    },
  ],
  [
    'BGR-03 PDPA-10 C0.9 OD-20 PD-79: of two re-clears at once, the second waits on the DPOs’ rows and is refused (cleared already)',
    async watcher => {
      await refused(reclear('81'), reclear('82'), REGISTER_CLEARED_ALREADY)(watcher)
      const open = await openTwilio(watcher)
      expect(open === 'break_glass 81', `Twilio's open clearances are ${open ?? 'none'}`)
      await resetBreakGlass(watcher)
    },
  ],
  [
    'BGR-04 PDPA-10 C0.9 OD-20 PD-79: a re-clear waits for the DPO’s own clear in the app in progress and is refused (a DPO is signed in)',
    async watcher => {
      await watcher.query('insert into public.devices (id, org_id, user_id, label) values ($1, $2, $3, $4)', [
        g('e6'),
        BREAK_GLASS_ORG,
        g('82'),
        'Phone',
      ])
      await watcher.query(
        `insert into public.sessions (id, org_id, user_id, device_id, token_hash, expires_at)
         values ($1, $2, $3, $4, sha256($5::bytea), now() + interval '7 days')`,
        [g('f6'), BREAK_GLASS_ORG, g('82'), g('e6'), 'bg f6'],
      )
      await refused(
        {
          as: 'app',
          org: BREAK_GLASS_ORG,
          user: g('82'),
          sql: `select * from public.clear_transfer_entry('twilio',
                  (select t.revision from public.transfer_register t
                   where t.org_id = '${BREAK_GLASS_ORG}' and t.provider = 'twilio'), 'race', null, null)`,
        },
        reclear('81'),
        REGISTER_SIGNED_IN,
      )(watcher)
      const open = await openTwilio(watcher)
      expect(open === 'app 82', `Twilio's open clearances are ${open ?? 'none'}`)
      await resetBreakGlass(watcher)
    },
  ],
  [
    'BGR-05 PDPA-10 C0.9 OD-20 PD-79: a re-clear waits for the named DPO losing the role, or being deactivated, and is refused',
    async watcher => {
      // The revocation holds only the role row, so the re-clear's FOR SHARE on it is what waits.
      await refused(revokeDpo(BREAK_GLASS_ORG, g('81'), g('85')), reclear('81'), REGISTER_NOT_DPO)(watcher)
      expect((await openTwilio(watcher)) === null, 'a re-clear naming a DPO who lost the role cleared Twilio')
      await watcher.query(
        `insert into public.role_assignments (org_id, person_id, role, created_by) values ($1, $2, 'dpo', $3)`,
        [BREAK_GLASS_ORG, g('81'), g('a0')],
      )
      // The deactivation holds the person's row, which the holders loop waits for and then reads
      // again without them.
      await refused(deactivateIn(BREAK_GLASS_ORG, g('82'), g('85')), reclear('82'), REGISTER_NOT_DPO)(watcher)
      expect((await openTwilio(watcher)) === null, 'a re-clear naming a DPO who left cleared Twilio')
      // g(82) back at the org, past keep_history (the watcher is the superuser), for later cases.
      await watcher.query('begin')
      await watcher.query('set local session_replication_role = replica')
      await watcher.query(
        'update public.people set deactivated_at = null, deactivated_by = null where org_id = $1 and id = $2',
        [BREAK_GLASS_ORG, g('82')],
      )
      await watcher.query('commit')
      await resetBreakGlass(watcher)
    },
  ],
  [
    'BGR-06 PDPA-10 C0.9 OD-20 PD-79: the re-clear starts its transaction’s timer again at 30 s, under a longer one its session set and a lower value set over it',
    async watcher => {
      // The session's 4 s timer starts at begin; lowering the value to 2 s doesn't shorten it. A
      // re-clear 1.5 s in that kept it would be ended at 4 s, inside the 3 s sleep after it.
      const a = new Client({ ...connection, database: DB, options: '-c transaction_timeout=4s' })
      a.on('error', () => {})
      await a.connect()
      try {
        await a.query('begin')
        await a.query('set local role hearth_owner')
        await a.query("select set_config('transaction_timeout', '2s', true)")
        await a.query('select pg_sleep(1.5)')
        await a.query(reclear('81').sql)
        const after = await a
          .query<{ v: string }>("select pg_sleep(3), current_setting('transaction_timeout') as v")
          .then(
            result => result.rows[0]?.v ?? null,
            (error: unknown) => `ended: ${message(error)}`,
          )
        expect(after === '30s', `4.5 s into the transaction, 3 s after the re-clear, it read ${after ?? 'nothing'}`)
        await a.query('rollback')
      } finally {
        await a.end().catch(() => {})
      }
      expect((await openTwilio(watcher)) === null, 'the rolled-back re-clear cleared Twilio')
    },
  ],
  [
    'NTR-13 C0.9 PR 3a: 0011 applied while a gated request holds the notice tables and then reads a clearance never waits holding one of the three, so both commit',
    async watcher => {
      const db = 'concurrency_0011_check'
      const admin = await connect('postgres')
      try {
        await admin.query(`drop database if exists ${db} with (force)`)
        await admin.query(`create database ${db} owner hearth_owner template template0`)
      } finally {
        await admin.end()
      }
      try {
        const built = await migrate({ databaseUrl: url(db), role: 'hearth_owner', before: '0011' })
        if (built.error !== undefined) throw new Error(`the migrations before 0011 failed: ${message(built.error)}`)
        // As the notice gate reads (requireNotice), then a re-authentication code's transfer check.
        const request = await connect(db)
        try {
          const pid = (await request.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid ?? 0
          await request.query('begin')
          await request.query("set local lock_timeout = '10s'")
          await request.query('select count(*) from public.notice_versions')
          await request.query('select count(*) from public.notice_acknowledgments')
          const migrating = migrate({ databaseUrl: url(db), role: 'hearth_owner' })
          expect(await heldUp(watcher, db, pid), '0011 was never held up by the request')
          const read = await request.query('select count(*) from public.transfer_clearances').then(
            () => undefined,
            (error: unknown) => message(error),
          )
          await request.query(read === undefined ? 'commit' : 'rollback')
          const { error } = await migrating
          expect(read === undefined, `the request's clearance read failed: ${read}`)
          expect(error === undefined, `0011 failed: ${error === undefined ? '' : message(error)}`)
        } finally {
          await request.end()
        }
      } finally {
        const cleanup = await connect('postgres')
        await cleanup.query(`drop database if exists ${db} with (force)`)
        await cleanup.end()
      }
    },
  ],
]

// Whether the migrator in `db` (any backend there but `except`) is held up, asked of Postgres for
// up to 10 seconds: sleeping between attempts at its locks, or waiting on a table.
async function heldUp(watcher: Client, db: string, except: number): Promise<boolean> {
  for (let tries = 0; tries < 200; tries += 1) {
    const result = await watcher.query<{ n: string }>(
      `select count(*) as n from pg_stat_activity
       where datname = $1 and pid <> $2 and (wait_event = 'PgSleep' or (wait_event_type = 'Lock' and wait_event = 'relation'))`,
      [db, except],
    )
    if (Number(result.rows[0]?.n ?? 0) > 0) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

async function main(): Promise<number> {
  if (!LOCAL_HOSTS.has(host)) {
    console.error(`check-concurrency: refusing ${host}: point PG* at the local stack or CI's service`)
    return 2
  }
  const admin = await connect('postgres')
  try {
    await admin.query(`drop database if exists ${DB} with (force)`)
    await admin.query(`create database ${DB} owner hearth_owner template template0`)
  } finally {
    await admin.end()
  }
  let failed = 0
  try {
    const { error } = await migrate({ databaseUrl: url(DB), role: 'hearth_owner' })
    if (error !== undefined) throw new Error(`migrations failed: ${message(error)}`)
    const watcher = await connect(DB)
    try {
      await watcher.query(`begin; set local role hearth_owner; ${FIXTURE} commit;`)
      for (const [name, check] of CASES) {
        try {
          await check(watcher)
          console.log(`ok    ${name}`)
        } catch (error) {
          failed += 1
          console.error(`FAIL  ${name}: ${message(error)}`)
        }
      }
    } finally {
      await watcher.end()
    }
  } finally {
    const cleanup = await connect('postgres')
    await cleanup.query(`drop database if exists ${DB} with (force)`)
    await cleanup.end()
  }
  return failed === 0 ? 0 : 1
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(`check-concurrency: ${message(error)}`)
  return 1
})
