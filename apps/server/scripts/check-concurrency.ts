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
// e7, ec, ed and ee, and sessions f3, f4, f9, fa and fb, are left for the cases to add. A session's
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
// A PIN hash in the one shape the server issues (0006; DB test 100 uses the same).
const PIN_HASH = "'$argon2id$v=19$m=19456,t=2,p=1$' || repeat('A', 22) || '$' || repeat('B', 43)"
const FIXTURE = `
  insert into public.orgs (id, name) values ('${ORG}', 'Concurrency check');
  insert into public.principals (id, org_id, kind, system_key) values ('${id('a0')}', '${ORG}', 'system', 'hearth');
  insert into public.principals (id, org_id, kind)
  select s.id, '${ORG}', 'human' from unnest(array['${id('a1')}', ${ids(['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'ba', ...SIGN_IN_PEOPLE])}]::uuid[]) as s (id);
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
${C06_FIXTURE}`

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
}
const JOB_ROLES = { queue: 'hearth_queue', offboarding: 'hearth_job_offboarding', purge: 'hearth_job_purge' } as const

async function begin(client: Client, step: Step): Promise<void> {
  await client.query('begin')
  await client.query("set local lock_timeout = '10s'")
  if (step.as === 'app') {
    await client.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [
      ORG,
      step.user ?? ADMIN,
    ])
    await client.query('set local role hearth_app')
  } else if (step.as === 'owner') {
    await client.query('set local role hearth_owner')
  } else {
    await client.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [ORG, SYSTEM])
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
// lock, then commits `first`. Returns whether `second` waited and the error it ended with, if
// any; `second` commits if it succeeded.
async function race(watcher: Client, first: Step, second: Step): Promise<{ waited: boolean; error?: string }> {
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
    await a.query('commit')
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
        finishJob('11', '21', [1], 'effect:01'),
        'That feature is switched off (k01).',
      )(watcher)
      expect((await effects(watcher, 'effect:01')) === 0, 'the effect committed after the flag was switched off')
      expect((await jobState(watcher, '11')) === 'running', 'the job finished after its flag was switched off')
    },
  ],
  [
    'T17 PRD-65: a flag change waits for a job finishing under it, and the effect commits first',
    async watcher => {
      const { waited, error } = await race(watcher, finishJob('12', '22', [1], 'effect:02'), setFlag('k02', false))
      expect(waited, 'the flag change did not wait for the job holding its flag')
      expect(error === undefined, `the flag change failed: ${error}`)
      expect((await effects(watcher, 'effect:02')) === 1, 'the effect did not commit')
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
      await refused(
        setFlag('k04', true, { people: ['b2'] }),
        finishJob('14', '24', [1], 'effect:04'),
        "That feature's flags have changed since this work checked them.",
      )(watcher)
      expect((await effects(watcher, 'effect:04')) === 0, 'the effect committed after its person left the cohort')
    },
  ],
  [
    'T17: a flag change does not wait for a job being queued for its feature',
    async watcher => {
      const enqueue: Step = {
        as: 'offboarding',
        sql: `insert into public.jobs (org_id, kind, feature_key, purpose, idempotency_key)
              values ('${ORG}', 'test.effect', 'k05', 'accounts', 'effect:05')`,
      }
      const error = await alongside(enqueue, setFlag('k05', false))
      expect(error === undefined, `the flag change waited for, or failed beside, the enqueue: ${error}`)
      expect((await effects(watcher, 'effect:05')) === 1, 'the job was not queued')
    },
  ],
  [
    'T15: the lease sweep passes a job its finishing transaction holds, and sweeps the rest',
    async watcher => {
      const error = await alongside(finishJob('16', '26', [1], 'effect:06'), sweep(['16', '18'], ['18']))
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
        finishJob('17', '27', [1], 'effect:06b'),
        "That job is no longer this worker's to finish.",
      )(watcher)
      expect((await effects(watcher, 'effect:06b')) === 0, 'the swept job committed its effect')
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
        finishJob('1c', '2c', [1], 'effect:08'),
        "That job is no longer this worker's to finish.",
      )(watcher)
      expect((await effects(watcher, 'effect:08')) === 0, 'the job given back committed its effect')
      expect((await jobState(watcher, '1c')) === 'queued', 'the job given back is not queued')
    },
  ],
  [
    'T15: a give-back after the job finished changes nothing',
    async watcher => {
      const { waited, error } = await race(watcher, finishJob('1d', '2d', [1], 'effect:08b'), giveBack('1d', '2d', 0))
      expect(waited, 'the give-back did not wait for the finishing job')
      expect(error === undefined, `the give-back failed: ${error}`)
      expect((await jobState(watcher, '1d')) === 'succeeded', 'the finished job was given back')
      expect((await effects(watcher, 'effect:08b')) === 1, 'the effect did not commit')
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
]

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
