// A stand-in for pg's Pool in unit tests (test-only; the image leaves testing/ out). Its one client
// records every statement with its values and answers each with the rows `answer` gives, or
// throws the error it returns, so a test can follow a service's SQL without a database. An INSERT,
// UPDATE or DELETE reports as such, affecting as many rows as it returns, or one when it returns
// none (a write without RETURNING that worked), unless the answer says how many ({ affected }).
import type { Pool } from 'pg'
import { createDatabase, type Database } from '#src/db/database.ts'

export interface Statement {
  text: string
  values: unknown[]
}

export type Answer = (statement: Statement) => unknown[] | Error | { affected: number; rows?: unknown[] }

// Postgres's SQLSTATE on an error, as pg's DatabaseError carries it (with the constraint's name
// when one refused).
export function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error(`postgres error ${code}`), { code, constraint })
}

// `wait`, when given, runs before each statement is answered, so a test can hold the database.
export function scriptedPool(
  answer: Answer = () => [],
  wait?: (statement: Statement) => Promise<void>,
): {
  db: Database
  statements: Statement[]
  // The statements' text alone, whitespace collapsed, for comparing SQL.
  texts: () => string[]
  released: () => number
} {
  const statements: Statement[] = []
  let released = 0
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      const statement = { text: text.replace(/\s+/g, ' ').trim(), values }
      statements.push(statement)
      if (wait) await wait(statement)
      const answered = answer(statement)
      if (answered instanceof Error) throw answered
      const write = /^(insert|update|delete|merge)\b/i.exec(statement.text)?.[1]?.toUpperCase()
      const rows = Array.isArray(answered) ? answered : (answered.rows ?? [])
      const rowCount = Array.isArray(answered)
        ? rows.length > 0 || write === undefined || /\breturning\b/i.test(statement.text)
          ? rows.length
          : 1
        : answered.affected
      return { command: write ?? 'SELECT', rowCount, rows }
    },
    release: () => {
      released++
    },
  }
  const pool = { connect: async () => client, end: async () => {}, options: {} } as unknown as Pool
  return {
    db: createDatabase(pool),
    statements,
    texts: () => statements.map(statement => statement.text),
    released: () => released,
  }
}

// The org's system principal row, which withOrg({ system: true }) reads first.
export const systemPrincipal =
  (id: string): Answer =>
  ({ text }) =>
    text.includes("from principals where org_id = $1 and kind = 'system'") ? [{ id }] : []

// The outbox events a scripted transaction appended (outbox/append.ts), read back from its
// INSERTs: the type, the entity's id, the subjects, the ids, and the actor named (undefined when the
// transaction's acting principal is used).
export function appended(statements: readonly Statement[]): Array<{
  type: unknown
  entity: unknown
  subjects: unknown
  ids: unknown
  actor: unknown
}> {
  return statements
    .filter(statement => statement.text.startsWith('insert into outbox_events'))
    .map(({ text, values }) => {
      const ids = values.find(value => typeof value === 'string' && value.startsWith('{'))
      return {
        type: values[1],
        entity: values[3],
        subjects: values.find(Array.isArray),
        ids: typeof ids === 'string' ? JSON.parse(ids) : undefined,
        actor: text.includes('from principals p') ? undefined : values[10],
      }
    })
}
