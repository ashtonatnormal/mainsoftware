// A stand-in for pg's Pool in unit tests (test-only; the image leaves testing/ out). Its one client
// records every statement with its values and answers each with the rows `answer` gives, or
// throws the error it returns, so a test can follow a service's SQL without a database.
import type { Pool } from 'pg'
import { createDatabase, type Database } from '#src/db/database.ts'

export interface Statement {
  text: string
  values: unknown[]
}

export type Answer = (statement: Statement) => unknown[] | Error

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
      const rows = answer(statement)
      if (rows instanceof Error) throw rows
      return { command: 'SELECT', rowCount: rows.length, rows }
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
