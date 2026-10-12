// Checks that the schema's refusals hold when two transactions race (C0.3, CLAUDE.md Database).
// A check that refuses because something has ended (someone left, a team or department was
// archived, a device was signed out) reads that row FOR SHARE. A change to that row running at the
// same time makes the check wait, and it then sees what the change committed. Without the lock,
// both would commit: a role for someone who has left, or a session on a signed-out device.
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

// One org with Hearth, an admin (a1), people b1-b8 (b8 has an account and two devices), teams
// d1-d3 and a department c1.
const id = (suffix: string) => `c0000000-0000-4000-8000-0000000000${suffix}`
const ORG = id('00')
const ADMIN = id('a1')
const FIXTURE = `
  insert into public.orgs (id, name) values ('${ORG}', 'Concurrency check');
  insert into public.principals (id, org_id, kind, system_key) values ('${id('a0')}', '${ORG}', 'system', 'hearth');
  insert into public.principals (id, org_id, kind)
  select s.id, '${ORG}', 'human' from unnest(array['${id('a1')}', ${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `'${id(`b${n}`)}'`).join(', ')}]::uuid[]) as s (id);
  insert into public.people (id, org_id, full_name, created_by)
  select p.id, '${ORG}', 'Person ' || p.id, '${id('a0')}' from public.principals p where p.kind = 'human';
  insert into public.users (id, org_id) values ('${id('b8')}', '${ORG}');
  insert into public.departments (id, org_id, name, created_by) values ('${id('c1')}', '${ORG}', 'Operations', '${ADMIN}');
  insert into public.teams (id, org_id, name, created_by) values
    ('${id('d1')}', '${ORG}', 'Crew', '${ADMIN}'), ('${id('d2')}', '${ORG}', 'Night crew', '${ADMIN}'),
    ('${id('d3')}', '${ORG}', 'Day crew', '${ADMIN}');
  insert into public.devices (id, org_id, user_id, label) values
    ('${id('e1')}', '${ORG}', '${id('b8')}', 'Phone'), ('${id('e2')}', '${ORG}', '${id('b8')}', 'Laptop');
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

// A transaction as the server makes one (hearth_app, with the org and user set) or as the owner,
// which the role-writing SECURITY DEFINER functions run as.
type Actor = 'app' | 'owner'
interface Step {
  as: Actor
  sql: string
}

async function begin(client: Client, actor: Actor): Promise<void> {
  await client.query('begin')
  await client.query("set local lock_timeout = '10s'")
  if (actor === 'app') {
    await client.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [ORG, ADMIN])
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
    await begin(a, first.as)
    await a.query(first.sql)
    await begin(b, second.as)
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

const deactivate = (n: number): Step => ({
  as: 'app',
  sql: `update public.people set deactivated_at = now(), deactivated_by = '${ADMIN}' where id = '${id(`b${n}`)}'`,
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

const CASES: Array<[string, (watcher: Client) => Promise<void>]> = [
  [
    'ACC-10: someone leaving is not given a role at the same time',
    refused(
      deactivate(1),
      grant(1, 'leadership'),
      "That person has left the organisation, so they can't be given a role.",
    ),
  ],
  [
    'ACC-07: someone leaving does not join a team at the same time',
    refused(deactivate(2), join('d1', 2), "That person has left the organisation, so they can't join a team."),
  ],
  [
    'ACC-07: nobody starts reporting to a manager who is leaving at the same time',
    refused(
      deactivate(3),
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
