// The Postgres error codes (SQLSTATE) the server acts on, Hearth's own among them, and what a
// failure may write to the logs (TECH-SPEC T15, T16, T17).
//
// Hearth's own codes are raised by migration 0007's functions, so the server can tell a refusal it
// expects from a failure:
//   HF001  a fence refused: the feature is off, or its flags changed since the server checked them
//          (feature_fence, job_fence, job_finish). The caller reloads the flags and decides again.
//   HF002  a job's lease has gone to another worker or the sweeper (job_fence, job_finish).
//   HF003  set_feature_flag(): the flag is locked; only a migration changes it.
//   HF004  set_feature_flag(): the change adds someone who isn't a person still at this org (A8).
import { z } from 'zod'

export const FEATURE_OFF = 'HF001'
export const LEASE_LOST = 'HF002'
export const FLAG_LOCKED = 'HF003'
export const INVALID_COHORT = 'HF004'
// invalid_parameter_value: set_feature_flag()'s unknown flag, a clean-up batch out of range.
export const INVALID_PARAMETER = '22023'
// insufficient_privilege: a refused person or role, and a fence or clean-up with no org set.
export const INSUFFICIENT_PRIVILEGE = '42501'

// The SQLSTATE of a Postgres error (pg's DatabaseError carries it as code), or undefined for
// anything else. Node's own network errors also carry a code (ECONNRESET), which isn't one.
export function sqlstateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const { code } = error
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined
}

// Worth trying again: a serialisation failure (40001), a deadlock (40P01), a lock not granted in
// time (55P03), a transaction that ran out of time (25P04, though Postgres ends the connection
// then, so it arrives as a lost connection), the server shutting down (57P01, 57P02, 57P03), a
// connection failure (class 08) and a lost connection, which pg reports with no SQLSTATE at all.
// A lost connection can hide a COMMIT that took effect, so whatever retries on one must be safe to
// run twice: a job's outcome writes are guarded by its lease and state, and the api's 409 try_again
// answers a request the client then repeats, which finds the change already made.
const RETRYABLE = new Set(['40001', '40P01', '55P03', '25P04', '57P01', '57P02', '57P03'])
const NETWORK = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'])
// pg's messages for a connection that ended or never came: the only signal it gives.
const LOST =
  /^(?:Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|Client was closed and is not queryable)/

export function retryable(error: unknown): boolean {
  const state = sqlstateOf(error)
  if (state !== undefined) return RETRYABLE.has(state) || state.startsWith('08')
  if (typeof error !== 'object' || error === null) return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (typeof code === 'string' && NETWORK.has(code)) return true
  return typeof message === 'string' && LOST.test(message)
}

// What a failure may log. Never its message: a Postgres message echoes input values ("invalid input
// syntax for type uuid: …") and so does a zod error's, and pino's error serializer would write the
// message and the stack's first line, which repeats it (CLAUDE.md, Security and privacy). These
// are enough to tell a retry or a dead job's cause apart without carrying anyone's data.
export interface FailureFields {
  // The error's class name: DatabaseError, ZodError, JobAborted, …
  error: string
  // Postgres: the SQLSTATE and the names of what refused, which are the schema's, never a value.
  sqlstate?: string
  constraint?: string
  table?: string
  column?: string
  routine?: string
  // zod: where each issue was and what kind it was.
  issues?: string[]
  // Node's code for a network error (ECONNRESET).
  code?: string
  // The stack's frames without the message line: function names and file positions, at most 10.
  stack?: string[]
}

const MAX_FRAMES = 10
// A schema name (a column, a constraint, a key), as Postgres and zod report them.
const NAME = /^[A-Za-z_][A-Za-z0-9_$.]{0,62}$/

const nameOf = (value: unknown): string | undefined =>
  typeof value === 'string' && NAME.test(value) ? value : undefined

export function failureFields(error: unknown): FailureFields {
  if (typeof error !== 'object' || error === null) return { error: typeof error }
  const fields: FailureFields = { error: nameOf(error.constructor?.name) ?? 'Object' }
  const state = sqlstateOf(error)
  if (state !== undefined) {
    fields.sqlstate = state
    const { constraint, table, column, routine } = error as Record<string, unknown>
    const named = { constraint, table, column, routine }
    for (const [key, value] of Object.entries(named)) {
      const name = nameOf(value)
      if (name !== undefined) fields[key as 'constraint' | 'table' | 'column' | 'routine'] = name
    }
  } else {
    const { code } = error as { code?: unknown }
    if (typeof code === 'string' && /^E[A-Z]{2,20}$/.test(code)) fields.code = code
  }
  if (error instanceof z.ZodError) {
    // A path holds schema keys and array positions; any other key (a record's, which could come
    // from the input) is left out.
    fields.issues = error.issues.slice(0, MAX_FRAMES).map(issue => {
      const path = issue.path.map(part => (typeof part === 'number' ? String(part) : (nameOf(part) ?? '?'))).join('.')
      return `${path === '' ? '(root)' : path}: ${issue.code}`
    })
  }
  const { stack, message } = error as { stack?: unknown; message?: unknown }
  if (typeof stack === 'string') {
    // V8 writes "Name: message", which may run over several lines, then one "    at …" line per
    // frame. Everything up to the end of the message goes, so a message line shaped like a frame
    // can't pass for one, and only the frames are kept.
    const end = typeof message === 'string' && message !== '' ? stack.indexOf(message) : -1
    const frames = (end >= 0 ? stack.slice(end + (message as string).length) : stack)
      .split('\n')
      .filter(line => /^\s+at /.test(line))
      .slice(0, MAX_FRAMES)
      .map(line => line.trim())
    if (frames.length > 0) fields.stack = frames
  }
  return fields
}
