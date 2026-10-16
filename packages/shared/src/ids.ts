// The structural guarantee behind the database's is_ids_only() (migration 0007; TECH-SPEC T15 item
// 8, T16 item 15): outbox events' ids and job payloads hold ids, never someone's details. Each
// event type's ids schema and each job kind's payload schema must be a z.strictObject whose every
// field, optional or not, is named by a key as IDS_KEY says and is one of:
//   z.uuid()                                   an id
//   z.enum([...]) or z.literal(...)            codes: lower-case, dotted, under 64 characters
//                                              (or a literal boolean)
//   z.boolean()
//   z.int().min(0).max(n), n ≤ 1,000,000       a bounded whole number
//   z.array(z.uuid()).max(n), n ≤ 100          a list of ids
// So a free string (a pattern included), an unbounded or negative number and a nested object are
// refused. is_ids_only() is the database's backstop for the same rule.
import { z } from 'zod'

// A uuid in the database's text form, lower case: what uuid columns print, and the only form
// is_ids_only()'s uuid regex (migration 0007) and enqueue() accept. z.uuid() takes upper case too,
// so a value read from a frame or an event that goes on to the database, or is compared with its
// ids, is read with LowerUuid (C0.7: the gateway's topics and positions, the revocation consumer).
export const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`)
export const LowerUuid = z.string().regex(UUID_PATTERN)

// A code as is_ids_only() accepts one.
export const CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/
export const CODE_MAX = 63
// A field name as is_ids_only() accepts one: lower case, no dots, at most 63 characters, so a
// camelCase name (teamId) or someone's details used as a key are refused here, not by the insert.
export const IDS_KEY = /^[a-z][a-z0-9_]{0,62}$/
export const IDS_NUMBER_MAX = 1_000_000
export const IDS_LIST_MAX = 100

// zod 4 keeps each schema's definition on _zod.def; only the fields read here are typed.
interface Def {
  type: string
  format?: string
  checks?: readonly { _zod: { def: CheckDef } }[]
  shape?: Record<string, Schema>
  catchall?: Schema
  innerType?: Schema
  element?: Schema
}
interface CheckDef {
  check: string
  format?: string
  value?: unknown
  inclusive?: boolean
  maximum?: number
}
interface Schema {
  _zod: { def: Def; values?: ReadonlySet<unknown> }
}

const isCode = (value: unknown): boolean => typeof value === 'string' && CODE.test(value) && value.length <= CODE_MAX

function checksOf(def: Def): CheckDef[] {
  return (def.checks ?? []).map(check => check._zod.def)
}

// Why a field's schema isn't an ids leaf, or undefined if it is.
function leafProblem(schema: Schema, optionalAllowed: boolean): string | undefined {
  const def = schema._zod.def
  switch (def.type) {
    case 'optional':
      if (!optionalAllowed || def.innerType === undefined) return 'an optional inside an optional'
      return leafProblem(def.innerType, false)
    case 'string':
      if (def.format !== 'uuid') return 'a string that is not z.uuid()'
      if (checksOf(def).length > 0) return 'a uuid with further checks'
      return undefined
    case 'enum':
    case 'literal': {
      const values = [...(schema._zod.values ?? [])]
      if (values.length === 0) return `an ${def.type} with no values`
      const bad = values.find(value => !(isCode(value) || (def.type === 'literal' && typeof value === 'boolean')))
      return bad === undefined ? undefined : `an ${def.type} value that is not a code (${JSON.stringify(bad)})`
    }
    case 'boolean':
      return checksOf(def).length > 0 ? 'a boolean with checks' : undefined
    case 'number': {
      const checks = checksOf(def)
      const whole = def.format === 'safeint' || checks.some(c => c.check === 'number_format' && c.format === 'safeint')
      if (!whole) return 'a number that is not a whole number (z.int())'
      const low = checks.find(c => c.check === 'greater_than')
      const high = checks.find(c => c.check === 'less_than')
      if (low === undefined || typeof low.value !== 'number' || low.value < (low.inclusive ? 0 : -1)) {
        return 'a whole number without a minimum of 0 or more'
      }
      if (high === undefined || typeof high.value !== 'number' || high.value > IDS_NUMBER_MAX) {
        return `a whole number without a maximum of at most ${IDS_NUMBER_MAX}`
      }
      const other = checks.find(c => !['number_format', 'greater_than', 'less_than'].includes(c.check))
      return other === undefined ? undefined : `a whole number with a ${other.check} check`
    }
    case 'array': {
      const element = def.element
      if (element === undefined || element._zod.def.type !== 'string' || leafProblem(element, false) !== undefined) {
        return 'a list of something other than uuids'
      }
      const max = checksOf(def).find(c => c.check === 'max_length')
      if (max?.maximum === undefined || max.maximum > IDS_LIST_MAX)
        return `a list without a maximum of at most ${IDS_LIST_MAX}`
      return undefined
    }
    case 'object':
      return 'a nested object'
    default:
      return `a ${def.type}`
  }
}

// Every way the schema breaks the rule, one line per field; empty when it holds.
export function idsProblems(schema: z.ZodType): string[] {
  const def = (schema as unknown as Schema)._zod.def
  if (def.type !== 'object' || def.shape === undefined) return ['not an object schema']
  const problems: string[] = []
  if (def.catchall?._zod.def.type !== 'never') problems.push('not a z.strictObject, so it would keep unknown keys')
  for (const [field, value] of Object.entries(def.shape)) {
    if (!IDS_KEY.test(field)) problems.push(`${JSON.stringify(field)}: a field name that is not a lower-case code`)
    const problem = leafProblem(value, true)
    if (problem !== undefined) problems.push(`${field}: ${problem}`)
  }
  return problems
}

// Throws, naming each field, unless the schema holds ids only.
export function idsLeaves(schema: z.ZodType, name = 'schema'): void {
  const problems = idsProblems(schema)
  if (problems.length > 0)
    throw new Error(`${name} must hold ids only (packages/shared ids.ts): ${problems.join('; ')}`)
}
