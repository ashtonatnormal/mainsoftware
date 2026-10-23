// Checks that the catalogues in code match the database the migrations build, both ways (C0.6;
// TECH-SPEC T16 item 7, T17 item 1, T18), against the scratch database scripts/check-migrations.sh
// builds (CHECK_DB, default hearth_check):
//   1. every way a runtime transaction can write a table in schema public is covered by
//      apps/server/src/outbox/coverage.ts: every INSERT, UPDATE (by column) and DELETE any runtime
//      role holds on one, every function of public such a role may execute, and every SECURITY
//      DEFINER and trigger function there, each with an event or a reasoned exemption; each
//      function's entry lists every table (every column, for an UPDATE) its body writes, and no
//      body is one this can't read (BEGIN ATOMIC, or EXECUTE outside DYNAMIC_DDL); no stale entry; MATCH names real
//      columns; no content table (packages/shared CONTENT_TABLES, or one an event with an ACL
//      snapshot covers) is exempt, by grant or through a function. scripts/check-migrations.sh
//      refuses any other schema, and rules, so nothing writes outside what this reads. Postgres's
//      own functions (pg_catalog's, such as the large-object ones every role may call by default)
//      aren't the schema's and aren't checked;
//   2. packages/shared EVENTS' names equal migration 0007's outbox_events_type list;
//   3. packages/shared FLAGS equals feature_flag_defaults() (keys, defaults and locks), with every
//      ai.* flag off and locked in both;
//   4. apps/server/src/db/roles.ts JOB_ROLES equals the job roles hearth_worker may SET;
//   5. every outbox consumer the worker runs (apps/server/src/worker/index.ts productionRegistries)
//      is bound in outbox_checkpoints_own_row() to exactly the role it runs as, and every name bound
//      there is one of them (0008, T16 item 3): read from the function's body, and tried in a
//      transaction it rolls back (a scratch org's checkpoint naming another job role must be
//      refused, one naming the consumer's own role accepted);
//   6. packages/shared PURPOSES, PINNED_PURPOSES and ACTIVE_FROM_START equal
//      processing_register_defaults() (keys, ai, pinned, needs_switch and the starting status), and
//      PROVIDERS and AI_PROVIDERS equal transfer_register_defaults() (keys and ai), both ways; every
//      org has exactly those rows (one this makes too, in a transaction it rolls back, whose rows
//      come from the trigger on orgs), and every later version keeps its version 1's fixed columns
//      (C0.9, TECH-SPEC T22 item 18); and, from C0.9 PR 2, NOTICE_TRANSFER_FACTS equals the keys
//      notice_facts() (0010) builds, each read from the snapshot's key of the same name (PD-41). No
//      runtime role may run notice_facts(), so this superuser calls it.
// The runtime roles are found as scripts/check-migrations.sh finds them: every role granted
// something in the database (the owner aside), and every role that can use one of them by SET or
// INHERIT. The integration suites' sweep (apps/server/src/testing/writes.ts) checks the writes the
// code actually makes; this checks every write the database allows.
//
//   node apps/server/scripts/check-catalogues.ts
//
// CI's migrations job runs it after the DB tests. Connects with the PG* variables as a superuser
// (default: the local stack) and refuses any host but this machine. Exits 1 on any problem.
import {
  ACTIVE_FROM_START,
  AI_PROVIDERS,
  EVENT_TYPES,
  FLAGS,
  NOTICE_TRANSFER_FACTS,
  PINNED_PURPOSES,
  PROVIDERS,
  PURPOSES,
} from '@hearth/shared'
import { Client } from 'pg'
import { JOB_ROLES } from '#src/db/roles.ts'
import { MATCH, WRITES } from '#src/outbox/coverage.ts'
import { productionRegistries } from '#src/worker/index.ts'
import {
  type BindingProbe,
  bindingProblems,
  bodyProblems,
  checkpointBindings,
  contentProblems,
  coverageProblems,
  eventProblems,
  type Fn,
  flagProblems,
  type Grant,
  matchProblems,
  noticeFactProbe,
  noticeFactProblems,
  type OrgRegisters,
  type ProviderDefault,
  type PurposeDefault,
  registerProblems,
  roleProblems,
} from './catalogues.ts'

// The worker's consumers, by name and role. Building the registries publishes nothing: the
// handlers' publisher is only called when a job runs, which never happens here.
const NO_PUBLISH = {
  valkey: { publish: async () => 0 },
  keyPrefix: 'check-catalogues:',
  logger: { warn: () => {}, error: () => {} },
}
const consumers = productionRegistries(NO_PUBLISH).consumers.map(({ name, role }) => ({ name, role }))

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const host = process.env.PGHOST ?? '127.0.0.1'
if (!LOCAL_HOSTS.has(host)) {
  process.stderr.write(`Refusing to check Postgres on ${host}: this runs on the local stack or in CI only.\n`)
  process.exit(2)
}
const database = process.env.CHECK_DB ?? 'hearth_check'

// The runtime roles, as scripts/check-migrations.sh finds them.
const RUNTIME = `
  with recursive rel as (
    select c.oid, c.relowner, c.relacl from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
  ), fn as (
    select p.oid, p.proowner, p.proacl from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  ), runtime (oid) as (
    select a.grantee from rel cross join lateral aclexplode(relacl) a where a.grantee not in (0, rel.relowner)
    union
    select a.grantee from rel join pg_attribute att on att.attrelid = rel.oid and att.attnum > 0
      cross join lateral aclexplode(att.attacl) a where a.grantee not in (0, rel.relowner)
    union
    select a.grantee from fn cross join lateral aclexplode(fn.proacl) a where a.grantee not in (0, fn.proowner)
    union
    select m.member from pg_auth_members m join runtime r on r.oid = m.roleid where m.set_option or m.inherit_option
  )
  select r.oid, r.rolname from runtime x join pg_roles r on r.oid = x.oid`

// Every write grant of every runtime role: a row INSERT when it may insert any column, an UPDATE
// per column it may update, a DELETE.
const GRANTS = `
  with runtime as (${RUNTIME}),
  tables as (
    select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
  ),
  columns as (
    select t.oid, t.relname, a.attnum, a.attname from tables t
    join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  )
  select distinct r.rolname as role, c.relname as table, 'INSERT' as op, null as column
  from runtime r join columns c on has_column_privilege(r.oid, c.oid, c.attnum, 'INSERT')
  union all
  select r.rolname, c.relname, 'UPDATE', c.attname
  from runtime r join columns c on has_column_privilege(r.oid, c.oid, c.attnum, 'UPDATE')
  union all
  select r.rolname, t.relname, 'DELETE', null
  from runtime r join tables t on has_table_privilege(r.oid, t.oid, 'DELETE')
  order by 1, 2, 3, 4`

// Every function a runtime transaction can reach: executable by a runtime role, SECURITY DEFINER,
// or a trigger function. Functions that belong to an extension aren't the schema's own.
const FUNCTIONS = `
  with runtime as (${RUNTIME})
  select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as key, p.prosecdef as definer,
         p.prorettype = 'trigger'::regtype as trigger, p.prosrc as source,
         p.prosqlbody is not null as atomic,
         array(select r.rolname::text from runtime r where has_function_privilege(r.oid, p.oid, 'EXECUTE') order by 1)
           as executors
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and (p.prosecdef or p.prorettype = 'trigger'::regtype
         or exists (select 1 from runtime r where has_function_privilege(r.oid, p.oid, 'EXECUTE')))
  order by 1`

const client = new Client({
  host,
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
  database,
})

try {
  await client.connect()
} catch {
  process.stderr.write(`Can't connect to ${database}: run scripts/check-migrations.sh first (with the stack up).\n`)
  process.exit(2)
}

try {
  const grants = (await client.query<Grant & { column: string | null }>(GRANTS)).rows.map(row =>
    row.column === null ? { role: row.role, table: row.table, op: row.op } : row,
  ) as Grant[]
  const functions = (await client.query<Fn>(FUNCTIONS)).rows
  const columns = new Set(
    (
      await client.query<{ name: string }>(`
        select c.relname || '.' || a.attname as name from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where n.nspname = 'public' and c.relkind in ('r', 'p')`)
    ).rows.map(row => row.name),
  )
  const check = (
    await client.query<{ definition: string }>(`
      select pg_get_constraintdef(c.oid) as definition from pg_constraint c
      where c.conrelid = 'public.outbox_events'::regclass and c.conname = 'outbox_events_type'`)
  ).rows[0]?.definition
  const types = [...(check ?? '').matchAll(/'([^']+)'::text/g)].map(match => match[1] ?? '')
  const defaults = (
    await client.query<{ key: string; enabled: boolean; locked: boolean }>(
      'select key, enabled, locked from public.feature_flag_defaults()',
    )
  ).rows
  // rds_iam, which IAM sign-in needs on RDS, is no job role.
  const settable = (
    await client.query<{ role: string }>(`
      select r.rolname as role from pg_auth_members m
      join pg_roles r on r.oid = m.roleid join pg_roles w on w.oid = m.member
      where w.rolname = 'hearth_worker' and m.set_option and r.rolname <> 'rds_iam'
      order by 1`)
  ).rows.map(row => row.role)

  const ownRow = (
    await client.query<{ source: string }>(`
      select p.prosrc as source from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'outbox_checkpoints_own_row'`)
  ).rows
  const bound = ownRow.length === 1 ? checkpointBindings(ownRow[0]?.source ?? '') : undefined
  const probes = await probeBindings()
  const purposeDefaults = (
    await client.query<PurposeDefault>(
      'select purpose, ai, pinned, needs_switch, status from public.processing_register_defaults()',
    )
  ).rows
  const providerDefaults = (
    await client.query<ProviderDefault>('select provider, ai from public.transfer_register_defaults()')
  ).rows
  const orgs = await readOrgRegisters()
  // Every key a clearance's snapshot may hold (transfer_register_facts(), 0009), each with a value
  // of its own name, so notice_facts() shows which it reads and from where.
  const snapshotKeys = (
    await client.query<{ key: string }>(
      'select jsonb_object_keys(public.transfer_register_facts(null::public.transfer_register)) as key',
    )
  ).rows.map(row => row.key)
  const noticeFacts = (
    await client.query<{ facts: unknown }>('select public.notice_facts($1::jsonb) as facts', [
      JSON.stringify(noticeFactProbe([...new Set([...snapshotKeys, ...NOTICE_TRANSFER_FACTS])])),
    ])
  ).rows[0]?.facts

  const problems = [
    ...coverageProblems(WRITES, grants, functions),
    ...bodyProblems(WRITES, functions, grants),
    ...matchProblems(WRITES, MATCH, columns),
    ...contentProblems(WRITES),
    ...(check === undefined ? ['outbox_events has no outbox_events_type check'] : eventProblems(EVENT_TYPES, types)),
    ...flagProblems(FLAGS, defaults),
    ...roleProblems(JOB_ROLES, settable),
    ...bindingProblems(consumers, bound, probes),
    ...registerProblems(
      {
        purposes: PURPOSES,
        pinned: PINNED_PURPOSES,
        activeFromStart: ACTIVE_FROM_START,
        providers: PROVIDERS,
        aiProviders: AI_PROVIDERS,
      },
      purposeDefaults,
      providerDefaults,
      orgs,
    ),
    ...noticeFactProblems(NOTICE_TRANSFER_FACTS, noticeFacts),
  ]
  if (problems.length > 0) {
    process.stderr.write(`The catalogues and the database disagree:\n${problems.map(p => `  - ${p}`).join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(
      `OK: ${grants.length} write grants and ${functions.length} functions covered; ${types.length} event types, ${defaults.length} flags, ${settable.length} job roles, ${consumers.length} consumers' checkpoint bindings, ${purposeDefaults.length} purposes and ${providerDefaults.length} providers in ${orgs.length} orgs' registers, and ${NOTICE_TRANSFER_FACTS.length} stated notice facts match.\n`,
    )
  }
} finally {
  await client.end()
}

// Tries each consumer's checkpoint in a scratch org, as this superuser (who may use every role, so
// only the binding can refuse), in one transaction it rolls back: nothing it writes stays.
async function probeBindings(): Promise<BindingProbe[]> {
  const probes: BindingProbe[] = []
  await client.query('begin')
  try {
    const org = (
      await client.query<{ id: string }>(`insert into public.orgs (name) values ('check-catalogues') returning id`)
    ).rows[0]?.id
    const accepted = async (consumer: string, role: string): Promise<boolean> => {
      await client.query('savepoint probe')
      try {
        await client.query('insert into public.outbox_checkpoints (org_id, consumer, role_name) values ($1, $2, $3)', [
          org,
          consumer,
          role,
        ])
        return true
      } catch (error) {
        if ((error as { code?: unknown }).code === '42501') return false
        throw error
      } finally {
        await client.query('rollback to savepoint probe')
      }
    }
    for (const { name, role } of consumers) {
      const other = JOB_ROLES.find(r => r !== role) ?? 'hearth_queue'
      probes.push({
        consumer: name,
        otherRefused: !(await accepted(name, other)),
        ownAccepted: await accepted(name, role),
      })
    }
  } finally {
    await client.query('rollback')
  }
  return probes
}

// Every org's register rows, as this superuser (who skips row level security), with one more org
// made in the same transaction, which it rolls back: its rows come from orgs_add_registers(), so a
// new org is checked too, whatever orgs the database already holds.
async function readOrgRegisters(): Promise<OrgRegisters[]> {
  await client.query('begin')
  try {
    await client.query(`insert into public.orgs (name) values ('check-catalogues registers')`)
    const purposes = (
      await client.query<PurposeDefault & { org: string }>(`
        select org_id::text as org, purpose, ai, pinned, needs_switch, status
        from public.processing_register where version = 1`)
    ).rows
    const providers = (
      await client.query<ProviderDefault & { org: string }>(
        'select org_id::text as org, provider, ai from public.transfer_register',
      )
    ).rows
    const drifted = (
      await client.query<{ org: string; purpose: string; version: number }>(`
        select r.org_id::text as org, r.purpose, r.version from public.processing_register r
        join public.processing_register f on f.org_id = r.org_id and f.purpose = r.purpose and f.version = 1
        where r.version > 1 and (r.ai, r.pinned, r.needs_switch) is distinct from (f.ai, f.pinned, f.needs_switch)`)
    ).rows
    const ids = (await client.query<{ id: string }>('select id::text as id from public.orgs order by id')).rows
    return ids.map(({ id }) => ({
      org: id,
      purposes: purposes.filter(row => row.org === id).map(({ org: _, ...row }) => row),
      providers: providers.filter(row => row.org === id).map(({ org: _, ...row }) => row),
      drifted: drifted.filter(row => row.org === id).map(({ org: _, ...row }) => row),
    }))
  } finally {
    await client.query('rollback')
  }
}
