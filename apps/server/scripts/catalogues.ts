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
// (pg_proc.prosrc), `atomic` whether it is written with BEGIN ATOMIC (pg_proc.prosqlbody, with no
// source) and `executors` the runtime roles that may execute it, for bodyProblems.
export interface Fn {
  key: string
  definer: boolean
  trigger: boolean
  source?: string
  atomic?: boolean
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

// A function's body with its comments gone and every string literal (quoted, E'', dollar-quoted)
// emptied, in lower case, so a write named in a comment or a message isn't read as one. Quoted
// identifiers stay as written, quotes and case and all ("AuditData" is not auditdata).
export function stripSql(source: string): string {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]
    if (c === '-' && source[i + 1] === '-') {
      while (i < n && source[i] !== '\n') i += 1
      out += ' '
    } else if (c === '/' && source[i + 1] === '*') {
      let depth = 0
      do {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth += 1
          i += 2
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth -= 1
          i += 2
        } else i += 1
      } while (i < n && depth > 0)
      out += ' '
    } else if (c === "'") {
      const escapes = /[eE]/.test(source[i - 1] ?? '') && !/[A-Za-z0-9_$]/.test(source[i - 2] ?? '')
      i += 1
      while (i < n) {
        if (escapes && source[i] === '\\') i += 2
        else if (source[i] === "'" && source[i + 1] === "'") i += 2
        else if (source[i] === "'") {
          i += 1
          break
        } else i += 1
      }
      out += "''"
    } else if (c === '$' && !/[A-Za-z0-9_$]/.test(source[i - 1] ?? '')) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(i))?.[0]
      if (tag === undefined) {
        out += c
        i += 1
      } else {
        const end = source.indexOf(tag, i + tag.length)
        i = end < 0 ? n : end + tag.length
        out += "''"
      }
    } else if (c === '"') {
      const start = i
      i += 1
      while (i < n && !(source[i] === '"' && source[i + 1] !== '"')) i += source[i] === '"' ? 2 : 1
      i += 1
      out += source.slice(start, i)
    } else {
      out += c?.toLowerCase()
      i += 1
    }
  }
  return out
}

// An identifier: quoted (any characters, "" for a quote, its case kept) or not (folded to lower
// case, as Postgres does, which stripSql has done). IDENT captures it; ident() gives its name.
const IDENT = String.raw`("(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$]*)`
const IDENT_ANY = String.raw`(?:"(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$]*)`
const ident = (raw: string): string => (raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw)

// The columns a SET list names, read from just after `set`: each item, at the start and after
// each comma outside brackets, is `column = ...` or `(a, b) = ...`, and the list ends at the first
// item that isn't one (a FROM list's second table, RETURNING's second column), a semicolon or the
// bracket that closes its statement. A list it can't read gives '?', which no entry lists, so the
// check fails rather than miss a column.
function setColumns(text: string, from: number): string[] {
  const columns: string[] = []
  const ITEM = new RegExp(String.raw`^\s*(?:${IDENT}\s*(?:\[[^\]]*\]\s*)?|\(([^()]*)\)\s*)=(?!=)`, 'u')
  const NAME = new RegExp(String.raw`^\s*${IDENT}\s*$`, 'u')
  let depth = 0
  let item = true
  let i = from
  while (i < text.length) {
    if (item) {
      const match = ITEM.exec(text.slice(i))
      if (match === null) break
      columns.push(
        ...(match[1] !== undefined
          ? [ident(match[1])]
          : (match[2] ?? '').split(',').map(name => {
              const raw = NAME.exec(name)?.[1]
              return raw === undefined ? '?' : ident(raw)
            })),
      )
      i += match[0].length
      item = false
      continue
    }
    const c = text[i]
    if (depth === 0 && (c === ';' || c === ')' || c === ']')) break
    if (c === '(' || c === '[') depth += 1
    else if (c === ')' || c === ']') depth -= 1
    else if (c === ',' && depth === 0) item = true
    i += 1
  }
  return columns.length > 0 ? columns : ['?']
}

// A schema-qualified table of public, quoted or not. A name after `public.` it can't read
// captures nothing, and is reported as the table '?', which no entry lists, so the check fails
// rather than miss the write.
const TABLE = String.raw`(?:public|"public")\s*\.\s*${IDENT}?`
const tableName = (raw: string | undefined): string => (raw === undefined ? '?' : ident(raw))

// The writes a function's body makes: every `insert into`, `update` (by each column its SET list
// names) and `delete from` a table of public, with or without ONLY, an upsert's `on conflict ... do
// update set` as an UPDATE of its columns, and `merge into` as an INSERT, a DELETE and an UPDATE of
// the columns its `then update set` names. Every SECURITY DEFINER function must schema-qualify its
// tables under search_path = '' (and every function here does). Dynamic SQL (EXECUTE) and BEGIN
// ATOMIC bodies can't be read this way, and bodyProblems refuses them.
export function bodyWrites(source: string): Array<{ table: string; op: Grant['op']; column?: string }> {
  const text = stripSql(source)
  const found: Array<{ at: number; table: string; op: Grant['op']; column?: string }> = []
  const inserts: Array<{ at: number; table: string }> = []
  for (const match of text.matchAll(new RegExp(String.raw`\binsert\s+into\s+${TABLE}`, 'gu'))) {
    const table = tableName(match[1])
    inserts.push({ at: match.index, table })
    found.push({ at: match.index, table, op: 'INSERT' })
  }
  for (const match of text.matchAll(new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${TABLE}`, 'gu'))) {
    found.push({ at: match.index, table: tableName(match[1]), op: 'DELETE' })
  }
  const update = new RegExp(
    String.raw`\bupdate\s+(?:only\s+)?${TABLE}(?:\s*\*)?(?:\s+(?:as\s+)?(?!set\b)${IDENT_ANY})?\s+set\b`,
    'gu',
  )
  for (const match of text.matchAll(update)) {
    for (const column of setColumns(text, match.index + match[0].length)) {
      found.push({ at: match.index, table: tableName(match[1]), op: 'UPDATE', column })
    }
  }
  for (const match of text.matchAll(new RegExp(String.raw`\bupdate\s+(?:only\s+)?${TABLE}`, 'gu'))) {
    if (!found.some(write => write.at === match.index)) {
      found.push({ at: match.index, table: tableName(match[1]), op: 'UPDATE', column: '?' })
    }
  }
  for (const match of text.matchAll(/\bon\s+conflict\b[^;]*?\bdo\s+update\s+set\b/g)) {
    const insert = inserts.filter(row => row.at < match.index).at(-1)
    for (const column of setColumns(text, match.index + match[0].length)) {
      found.push({ at: match.index, table: insert?.table ?? '?', op: 'UPDATE', column })
    }
  }
  for (const match of text.matchAll(new RegExp(String.raw`\bmerge\s+into\s+(?:only\s+)?${TABLE}`, 'gu'))) {
    const table = tableName(match[1])
    found.push({ at: match.index, table, op: 'INSERT' }, { at: match.index, table, op: 'DELETE' })
    const end = text.indexOf(';', match.index)
    const statement = text.slice(match.index, end < 0 ? text.length : end)
    for (const clause of statement.matchAll(/\bthen\s+update\s+set\b/g)) {
      for (const column of setColumns(text, match.index + clause.index + clause[0].length)) {
        found.push({ at: match.index, table, op: 'UPDATE', column })
      }
    }
  }
  const seen = new Map<string, { table: string; op: Grant['op']; column?: string }>()
  for (const { at: _, ...write } of found.sort((a, b) => a.at - b.at)) {
    const key = `${write.table}:${write.op}:${write.column ?? ''}`
    if (!seen.has(key)) seen.set(key, write)
  }
  return [...seen.values()]
}

// Functions whose body runs dynamic SQL (EXECUTE) that only changes the schema and writes no row,
// with why; bodyProblems refuses EXECUTE in any other. Adding one is a reviewed change.
export const DYNAMIC_DDL: Readonly<Record<string, string>> = {
  'create_data_access_partitions(integer)':
    "creates data_access_events' month partitions and turns on their row level security",
}

const verbOf = (op: Grant['op'], table: string, column?: string): string =>
  op === 'INSERT'
    ? `insert into public.${table}`
    : op === 'DELETE'
      ? `delete from public.${table}`
      : column === undefined
        ? `update public.${table}`
        : `update public.${table} set ${column}`

// Every write a function's body makes is in its entry's `writes`, with the same operation and, for
// an UPDATE, the same column, unless every runtime role that may execute it holds that write itself
// (the same column, for an UPDATE), so its grant's entry covers it (set_feature_flag()'s audit row).
// A trigger runs for whoever writes its table, so only its `writes` count. Without this, a function
// could write a table or a column its entry doesn't list, and the sweep would credit the write to
// another function's entry. A body this can't read is refused: one written with BEGIN ATOMIC
// (Postgres keeps no source text for it), and dynamic SQL outside DYNAMIC_DDL.
export function bodyProblems(
  writes: Readonly<Record<string, Coverage>>,
  functions: readonly Fn[],
  grants: readonly Grant[],
  dynamic: Readonly<Record<string, string>> = DYNAMIC_DDL,
): string[] {
  const problems: string[] = []
  for (const fn of functions) {
    if (fn.atomic === true) {
      problems.push(
        `public.${fn.key} is written with BEGIN ATOMIC, whose writes check-catalogues can't read: write its body as a quoted string (as $$ ... $$)`,
      )
      continue
    }
    if (fn.source !== undefined && /\bexecute\b/.test(stripSql(fn.source)) && dynamic[fn.key] === undefined) {
      problems.push(
        `public.${fn.key} runs dynamic SQL (EXECUTE), whose writes check-catalogues can't read: write them as plain statements, or, if it only changes the schema, add it to DYNAMIC_DDL in apps/server/scripts/catalogues.ts with why`,
      )
    }
    const declared = writes[fn.key]?.writes
    if (declared === undefined || fn.source === undefined) continue
    for (const { table, op, column } of bodyWrites(fn.source)) {
      const listed = declared.includes(op === 'UPDATE' ? `${table}.${column}:UPDATE` : `${table}:${op}`)
      if (listed) continue
      const executors = fn.executors ?? []
      const granted =
        !fn.trigger &&
        executors.length > 0 &&
        executors.every(role =>
          grants.some(
            grant =>
              grant.role === role &&
              grant.table === table &&
              grant.op === op &&
              (op !== 'UPDATE' || grant.column === column),
          ),
        )
      if (granted) continue
      const add = op === 'UPDATE' ? `'${table}.${column}:UPDATE'` : `'${table}:${op}'`
      problems.push(
        table === '?'
          ? `public.${fn.key} runs ${op === 'INSERT' ? 'insert into' : op === 'DELETE' ? 'delete from' : 'update'} a table of public whose name check-catalogues can't read: write it as a plain or quoted identifier`
          : column === '?'
          ? `public.${fn.key} runs update public.${table}, but check-catalogues can't read which columns it sets: name them in a plain SET list`
          : `public.${fn.key} runs ${verbOf(op, table, column)}, but its entry in apps/server/src/outbox/coverage.ts doesn't list that write: add ${add} to its writes`,
      )
    }
  }
  const keys = new Set(functions.map(fn => fn.key))
  for (const key of Object.keys(dynamic)) {
    if (!keys.has(key))
      problems.push(
        `DYNAMIC_DDL in apps/server/scripts/catalogues.ts lists ${key}, which no reachable function is: remove it`,
      )
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
