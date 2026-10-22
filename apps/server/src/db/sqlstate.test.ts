import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { failureFields, retryable, sqlstateOf } from '#src/db/sqlstate.ts'
import { pgError } from '#src/testing/pool.ts'

// What a person might type, or a row might hold: it must reach no log line.
const SENTINEL = 'Sentinel Tan +6590000099'

// A Postgres error as pg's DatabaseError arrives: the message, the detail and where echo values.
class DatabaseError extends Error {
  code: string
  detail: string
  where: string
  constraint: string
  table: string
  column: string
  routine: string
  constructor(message: string) {
    super(message)
    this.code = '23505'
    this.detail = `Key (e164)=(${SENTINEL}) already exists.`
    this.where = `SQL function with ${SENTINEL}`
    this.constraint = 'phone_numbers_e164_unique'
    this.table = 'phone_numbers'
    this.column = 'e164'
    this.routine = '_bt_check_unique'
  }
}

describe('C0.6 T15 which failures are worth trying again', () => {
  it('retries conflicts, timeouts, a server shutting down and connection failures', () => {
    for (const code of ['40001', '40P01', '55P03', '25P04', '57P01', '57P02', '57P03', '08006', '08001']) {
      expect(retryable(pgError(code)), code).toBe(true)
    }
  })

  it('retries a lost connection, which pg reports with no SQLSTATE (a transaction timeout among them)', () => {
    expect(retryable(new Error('Connection terminated unexpectedly'))).toBe(true)
    expect(retryable(new Error('Connection terminated due to connection timeout'))).toBe(true)
    expect(retryable(new Error('timeout exceeded when trying to connect'))).toBe(true)
    expect(retryable(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true)
  })

  it('retries a broken pipe, whose five-letter code (EPIPE) is no SQLSTATE (CodeRabbit)', () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    expect(sqlstateOf(epipe)).toBeUndefined()
    expect(retryable(epipe)).toBe(true)
    for (const code of ['EPERM', 'EBUSY']) expect(sqlstateOf({ code }), code).toBeUndefined()
    const fields = failureFields(epipe)
    expect(fields.code).toBe('EPIPE')
    expect(fields.sqlstate).toBeUndefined()
  })

  it('does not retry a constraint failure, a refusal, Hearth’s own codes or a plain bug', () => {
    for (const code of [
      '23505',
      '23514',
      '23503',
      '42501',
      '22023',
      'HF001',
      'HF002',
      'HF003',
      'HF004',
      'HF005',
      'HF006',
    ]) {
      expect(retryable(pgError(code)), code).toBe(false)
    }
    expect(retryable(new TypeError('x is not a function'))).toBe(false)
    expect(retryable('a string')).toBe(false)
    expect(retryable(undefined)).toBe(false)
  })

  it('reads a SQLSTATE only from a five-character code', () => {
    expect(sqlstateOf(pgError('HF001'))).toBe('HF001')
    expect(sqlstateOf(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBeUndefined()
    expect(sqlstateOf({ code: 40001 })).toBeUndefined()
  })
})

describe('C0.6 T15 item 5: what a failure may log, never its message', () => {
  it('keeps a Postgres error’s code and the names of what refused, and drops its message, detail and where', () => {
    const fields = failureFields(new DatabaseError(`duplicate key value ${SENTINEL}`))
    expect(fields).toMatchObject({
      error: 'DatabaseError',
      sqlstate: '23505',
      constraint: 'phone_numbers_e164_unique',
      table: 'phone_numbers',
      column: 'e164',
      routine: '_bt_check_unique',
    })
    expect(fields.stack?.length).toBeGreaterThan(0)
    expect(fields.stack?.every(frame => frame.startsWith('at '))).toBe(true)
    expect(JSON.stringify(fields)).not.toContain('Sentinel')
  })

  it('keeps a zod error’s paths and issue codes, never the input it echoes', () => {
    const schema = z.strictObject({ person: z.uuid(), names: z.array(z.uuid()) })
    const parsed = schema.safeParse({ person: SENTINEL, names: [SENTINEL], [SENTINEL]: 1 })
    expect(parsed.success).toBe(false)
    const fields = failureFields(parsed.error)
    expect(fields.error).toBe('ZodError')
    expect(fields.issues).toEqual(expect.arrayContaining(['person: invalid_format', 'names.0: invalid_format']))
    expect(JSON.stringify(fields)).not.toContain('Sentinel')
  })

  it('drops a plain error’s message even when it spans lines shaped like stack frames', () => {
    const error = new Error(`first line ${SENTINEL}\n    at ${SENTINEL} (file.ts:1:2)`)
    const fields = failureFields(error)
    expect(fields.error).toBe('Error')
    expect(fields.stack?.length).toBeGreaterThan(0)
    expect(JSON.stringify(fields)).not.toContain('Sentinel')
  })

  it('keeps a network error’s code, and copes with what isn’t an error', () => {
    expect(failureFields(Object.assign(new Error(`connect ${SENTINEL}`), { code: 'ECONNREFUSED' }))).toMatchObject({
      error: 'Error',
      code: 'ECONNREFUSED',
    })
    expect(failureFields(SENTINEL)).toEqual({ error: 'string' })
    expect(failureFields(null)).toEqual({ error: 'object' })
    expect(JSON.stringify(failureFields({ message: SENTINEL }))).not.toContain('Sentinel')
  })
})
