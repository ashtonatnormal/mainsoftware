// Checks that the catalogues in code match the database the migrations build, both ways (C0.6;
// TECH-SPEC T16 item 7, T17 item 1, T18), against the scratch database scripts/check-migrations.sh
// builds (CHECK_DB, default hearth_check):
//   1. every way a runtime transaction can write is covered by apps/server/src/outbox/coverage.ts:
//      every INSERT, UPDATE (by column) and DELETE any runtime role holds, every function such a
//      role may execute, and every SECURITY DEFINER and trigger function, each with an event or a
//      reasoned exemption; no stale entry; MATCH names real columns; no content table is exempt;
//   2. packages/shared EVENTS' names equal migration 0007's outbox_events_type list;
//   3. packages/shared FLAGS equals feature_flag_defaults() (keys, defaults and locks), with every
//      ai.* flag off and locked in both;
//   4. apps/server/src/db/roles.ts JOB_ROLES equals the job roles hearth_worker may SET.
// The runtime roles are found as scripts/check-migrations.sh finds them: every role granted
// something in the database (the owner aside), and every role that can use one of them by SET or
// INHERIT. The integration suites' sweep (apps/server/src/testing/writes.ts) checks the writes the
// code actually makes; this checks every write the database allows.
//
//   node apps/server/scripts/check-catalogues.ts
//
// CI's migrations job runs it after the DB tests. Connects with the PG* variables as a superuser
// (default: the local stack) and refuses any host but this machine. Exits 1 on any problem.
import { EVENT_TYPES, FLAGS } from '@hearth/shared'
import { Client } from 'pg'
import { JOB_ROLES } from '#src/db/roles.ts'
import { MATCH, WRITES } from '#src/outbox/coverage.ts'
import {
  contentProblems,
  coverageProblems,
  eventProblems,
  type Fn,
  flagProblems,
  type Grant,
  matchProblems,
  roleProblems,
} from './catalogues.ts'

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
         p.prorettype = 'trigger'::regtype as trigger
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

  const problems = [
    ...coverageProblems(WRITES, grants, functions),
    ...matchProblems(WRITES, MATCH, columns),
    ...contentProblems(WRITES),
    ...(check === undefined ? ['outbox_events has no outbox_events_type check'] : eventProblems(EVENT_TYPES, types)),
    ...flagProblems(FLAGS, defaults),
    ...roleProblems(JOB_ROLES, settable),
  ]
  if (problems.length > 0) {
    process.stderr.write(`The catalogues and the database disagree:\n${problems.map(p => `  - ${p}`).join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(
      `OK: ${grants.length} write grants and ${functions.length} functions covered; ${types.length} event types, ${defaults.length} flags and ${settable.length} job roles match.\n`,
    )
  }
} finally {
  await client.end()
}
