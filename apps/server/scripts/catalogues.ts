// What check-catalogues.ts compares, as pure functions over what it reads from the database, so
// catalogues.test.ts can prove each check fails when it should (TECH-SPEC T16 item 7, T17 item 1,
// T18). Each problem names the gap and how to close it.
import { CONTENT_TABLES, EVENTS, type EventType, type FlagSpec, isAiFlag } from '@hearth/shared'
import { type Coverage, grantKey } from '#src/outbox/coverage.ts'

// A write a runtime role may make through a grant: a row operation by table, an update by column.
export interface Grant {
  role: string
  table: string
  op: 'INSERT' | 'UPDATE' | 'DELETE'
  column?: string
}

// A function a runtime transaction can reach: one a runtime role may execute, a SECURITY DEFINER
// function, or a trigger function. `key` is '<name>(<argument types>)'; `source` its body
// (pg_proc.prosrc) and `executors` the runtime roles that may execute it, for bodyProblems.
export interface Fn {
  key: string
  definer: boolean
  trigger: boolean
  source?: string
  executors?: readonly string[]
}

const grantText = (grant: Grant) =>
  grant.op === 'UPDATE'
    ? `${grant.role} may UPDATE public.${grant.table}.${grant.column}`
    : `${grant.role} may ${grant.op} rows of public.${grant.table}`

// 1. Every way to write is covered, and no entry is stale.
export function coverageProblems(
  writes: Readonly<Record<string, Coverage>>,
  grants: readonly Grant[],
  functions: readonly Fn[],
): string[] {
  const problems: string[] = []
  const known = new Set<string>()
  for (const grant of grants) {
    const key = grantKey(grant.role, grant.table, grant.op, grant.column)
    known.add(key)
    if (writes[key] === undefined) {
      problems.push(
        `${grantText(grant)}, but apps/server/src/outbox/coverage.ts doesn't say which event covers it or why it's exempt: add '${key}'`,
      )
    }
  }
  for (const fn of functions) {
    known.add(fn.key)
    const entry = writes[fn.key]
    const kind = fn.trigger ? 'trigger function' : fn.definer ? 'SECURITY DEFINER function' : 'function'
    if (entry === undefined) {
      problems.push(
        `the ${kind} public.${fn.key} can run in a runtime transaction, but apps/server/src/outbox/coverage.ts doesn't list what it writes (writes: [] if nothing) and what covers it: add '${fn.key}'`,
      )
    } else if (entry.writes === undefined) {
      problems.push(
        `apps/server/src/outbox/coverage.ts's '${fn.key}' must list the writes it makes (writes: [] if none)`,
      )
    }
  }
  for (const key of Object.keys(writes)) {
    if (!known.has(key)) {
      problems.push(
        `apps/server/src/outbox/coverage.ts covers '${key}', which no runtime role's grant or reachable function matches any more: remove it`,
      )
    }
  }
  return problems
}

// The tables a function's body writes, by operation: every `insert into`, `update` and `delete from`
// a schema-qualified table of public, as every SECURITY DEFINER function must name them under
// search_path = '' (and as every function here does). A write built in dynamic SQL (EXECUTE) isn't
// seen.
export function bodyWrites(source: string): Array<{ table: string; op: Grant['op'] }> {
  const found = new Map<string, { table: string; op: Grant['op'] }>()
  for (const match of source.matchAll(/\b(insert\s+into|update|delete\s+from)\s+public\.([a-z_][a-z0-9_]*)\b/gi)) {
    const verb = (match[1] ?? '').toLowerCase()
    const op = verb.startsWith('insert') ? 'INSERT' : verb.startsWith('delete') ? 'DELETE' : 'UPDATE'
    const table = (match[2] ?? '').toLowerCase()
    found.set(`${table}:${op}`, { table, op })
  }
  return [...found.values()]
}

// Every table a function's body writes is in its entry's `writes`, with the same operation (an
// UPDATE by any column), unless every runtime role that may execute it holds that write itself, so
// its grant's entry covers it (set_feature_flag()'s audit row). A trigger runs for whoever writes
// its table, so only its `writes` count. Without this, a function could write a table its entry
// doesn't list, and the sweep would credit the write to another function's entry.
export function bodyProblems(
  writes: Readonly<Record<string, Coverage>>,
  functions: readonly Fn[],
  grants: readonly Grant[],
): string[] {
  const problems: string[] = []
  for (const fn of functions) {
    const declared = writes[fn.key]?.writes
    if (declared === undefined || fn.source === undefined) continue
    for (const { table, op } of bodyWrites(fn.source)) {
      const listed = declared.some(write =>
        op === 'UPDATE' ? write.startsWith(`${table}.`) && write.endsWith(':UPDATE') : write === `${table}:${op}`,
      )
      if (listed) continue
      const executors = fn.executors ?? []
      const granted =
        !fn.trigger &&
        executors.length > 0 &&
        executors.every(role => grants.some(grant => grant.role === role && grant.table === table && grant.op === op))
      if (granted) continue
      problems.push(
        `public.${fn.key} runs ${op === 'INSERT' ? 'insert into' : op === 'DELETE' ? 'delete from' : 'update'} public.${table}, but its entry in apps/server/src/outbox/coverage.ts doesn't list that write: add it to its writes`,
      )
    }
  }
  return problems
}

// Every table an entry requires an event for must say which column the event names, and the column
// must exist.
export function matchProblems(
  writes: Readonly<Record<string, Coverage>>,
  match: Readonly<Record<string, string>>,
  columns: ReadonlySet<string>,
): string[] {
  const problems: string[] = []
  for (const [table, column] of Object.entries(match)) {
    if (!columns.has(`${table}.${column}`)) {
      problems.push(`apps/server/src/outbox/coverage.ts's MATCH names public.${table}.${column}, which doesn't exist`)
    }
  }
  for (const [key, coverage] of Object.entries(writes)) {
    if (!('events' in coverage)) continue
    const tables = /^hearth_[a-z0-9_]+ ([a-z_]+)[.:]/.exec(key)?.[1]
    const written =
      tables !== undefined ? [tables] : (coverage.writes ?? []).map(write => /^([a-z_]+)[.:]/.exec(write)?.[1])
    for (const table of written) {
      if (table !== undefined && match[table] === undefined) {
        problems.push(
          `'${key}' needs an event, but MATCH in apps/server/src/outbox/coverage.ts doesn't say which column of ${table} the event must name`,
        )
      }
    }
  }
  return problems
}

// A content table may not have an exemption, by its grant or through a function that writes it:
// every content write appends its event with its snapshot (CLAUDE.md, Build order). The content
// tables are packages/shared CONTENT_TABLES, and any table an entry covers with an event that
// carries an ACL snapshot.
export function contentProblems(
  writes: Readonly<Record<string, Coverage>>,
  carriesSnapshot: (type: EventType) => boolean = type => (EVENTS[type].acl as string) === 'snapshot',
  contentTables: readonly string[] = CONTENT_TABLES,
): string[] {
  const tableOf = (key: string): string | undefined => /^hearth_[a-z0-9_]+ ([a-z_]+)[.:]/.exec(key)?.[1]
  const writtenBy = (key: string, coverage: Coverage): string[] => {
    const table = tableOf(key)
    if (table !== undefined) return [table]
    return (coverage.writes ?? []).flatMap(write => /^([a-z_][a-z0-9_]*)[.:]/.exec(write)?.[1] ?? [])
  }
  const content = new Set<string>(contentTables)
  for (const [key, coverage] of Object.entries(writes)) {
    if ('events' in coverage && coverage.events.some(carriesSnapshot)) {
      for (const table of writtenBy(key, coverage)) content.add(table)
    }
  }
  const problems: string[] = []
  for (const [key, coverage] of Object.entries(writes)) {
    if (!('exempt' in coverage)) continue
    for (const table of new Set(writtenBy(key, coverage))) {
      if (content.has(table)) {
        problems.push(
          `'${key}' is exempt, but writes ${table}, which holds content, whose every write appends its event with an ACL snapshot`,
        )
      }
    }
  }
  return problems
}

// 2. The catalogue's names equal the outbox's type check, both ways.
export function eventProblems(catalogue: readonly string[], database: readonly string[]): string[] {
  const inDatabase = new Set(database)
  const inCatalogue = new Set(catalogue)
  return [
    ...catalogue
      .filter(type => !inDatabase.has(type))
      .map(type => `${type} is in packages/shared EVENTS but not in outbox_events_type: a migration adds it`),
    ...database
      .filter(type => !inCatalogue.has(type))
      .map(type => `${type} is in outbox_events_type but not in packages/shared EVENTS: add it to the catalogue`),
  ]
}

// 3. The flag registry equals feature_flag_defaults(), both ways, and every ai.* flag is off and
// locked in both.
export function flagProblems(
  registry: Readonly<Record<string, FlagSpec>>,
  defaults: readonly { key: string; enabled: boolean; locked: boolean }[],
): string[] {
  const problems: string[] = []
  const byKey = new Map(defaults.map(row => [row.key, row]))
  for (const [key, spec] of Object.entries(registry)) {
    const row = byKey.get(key)
    if (row === undefined) {
      problems.push(`${key} is in packages/shared FLAGS but not in feature_flag_defaults(): a migration adds it`)
      continue
    }
    if (row.enabled !== spec.default || row.locked !== spec.locked) {
      problems.push(
        `${key}: FLAGS says default ${spec.default}, locked ${spec.locked}; feature_flag_defaults() says ${row.enabled}, ${row.locked}`,
      )
    }
    if (isAiFlag(key) && (spec.default || !spec.locked))
      problems.push(`${key} is an AI flag, so FLAGS must keep it off and locked until A0`)
  }
  for (const row of defaults) {
    if (!Object.hasOwn(registry, row.key)) {
      problems.push(`${row.key} is in feature_flag_defaults() but not in packages/shared FLAGS: register it`)
    }
    if (isAiFlag(row.key) && (row.enabled || !row.locked)) {
      problems.push(`${row.key} is an AI flag, so feature_flag_defaults() must keep it off and locked until A0`)
    }
  }
  return problems
}

// 4. JOB_ROLES equals the job roles hearth_worker may take.
export function roleProblems(code: readonly string[], database: readonly string[]): string[] {
  return [
    ...code
      .filter(role => !database.includes(role))
      .map(
        role => `${role} is in apps/server/src/db/roles.ts JOB_ROLES, but hearth_worker can't SET it in the database`,
      ),
    ...database
      .filter(role => !code.includes(role))
      .map(role => `hearth_worker can SET ${role}, which apps/server/src/db/roles.ts JOB_ROLES doesn't list`),
  ]
}
