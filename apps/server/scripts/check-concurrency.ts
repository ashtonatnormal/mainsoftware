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
const ids = (suffixes: string[]) => suffixes.map(s => `'${id(s)}'`).join(', ')
const SIGN_IN_PEOPLE = ['bb', 'bc', 'bd', 'be', 'bf', 'b0', 'c2', 'c3', 'c4', 'c5']
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
`

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
// unless the step names someone) or as the owner, which the role-writing SECURITY DEFINER
// functions run as.
type Actor = 'app' | 'owner'
interface Step {
  as: Actor
  sql: string
  user?: string
}

async function begin(client: Client, step: Step): Promise<void> {
  await client.query('begin')
  await client.query("set local lock_timeout = '10s'")
  if (step.as === 'app') {
    await client.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [
      ORG,
      step.user ?? ADMIN,
    ])
    await client.query('set local role hearth_app')
  } else {
    await client.query('set local role hearth_owner')
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

function expect(ok: boolean, what: string): void {
  if (!ok) throw new Error(what)
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
