// The lower-case uuid form (C0.7, m4): LowerUuid and UUID_PATTERN accept exactly what the
// database's is_ids_only() accepts as a uuid, so a value the gateway or the revocation consumer
// reads is one the database would take.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { LowerUuid, UUID_PATTERN, UUID_SOURCE } from './ids.ts'

// is_ids_only()'s uuid regex, as migration 0007 writes it (db/migrations/0007_queue_outbox_flags.sql).
const IS_IDS_ONLY_UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

const accepted = [
  'a0000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '0123abcd-4567-89ef-0123-456789abcdef',
]
const refused = [
  'A0000000-0000-4000-8000-000000000001', // upper case
  'a0000000-0000-4000-8000-00000000000F', // one upper-case digit
  '{a0000000-0000-4000-8000-000000000001}',
  'urn:uuid:a0000000-0000-4000-8000-000000000001',
  'a00000000000400080000000000000001', // no hyphens
  'a0000000-0000-4000-8000-0000000000011', // one digit too many
  'a0000000-0000-4000-8000-00000000001', // one too few
  'g0000000-0000-4000-8000-000000000001',
  ' a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001\n',
  '',
]

describe('m4 T16 item 15: the lower-case uuid', () => {
  it('m4: UUID_PATTERN is is_ids_only()’s uuid regex', () => {
    expect(UUID_PATTERN.source).toBe(IS_IDS_ONLY_UUID)
    expect(`^${UUID_SOURCE}$`).toBe(IS_IDS_ONLY_UUID)
    expect(UUID_PATTERN.flags).toBe('')
  })

  it('m4: LowerUuid and UUID_PATTERN accept the lower-case form and nothing else', () => {
    const database = new RegExp(IS_IDS_ONLY_UUID)
    for (const value of [...accepted, ...refused]) {
      const expected = database.test(value)
      expect(UUID_PATTERN.test(value), JSON.stringify(value)).toBe(expected)
      expect(LowerUuid.safeParse(value).success, JSON.stringify(value)).toBe(expected)
    }
    for (const value of accepted) expect(LowerUuid.safeParse(value).success, value).toBe(true)
    for (const value of refused) expect(LowerUuid.safeParse(value).success, JSON.stringify(value)).toBe(false)
    for (const value of [1, null, undefined, ['a0000000-0000-4000-8000-000000000001']]) {
      expect(LowerUuid.safeParse(value).success, JSON.stringify(value)).toBe(false)
    }
  })

  it('m4: z.uuid() alone takes an upper-case uuid the database refuses, which is why LowerUuid exists', () => {
    const upper = 'A0000000-0000-4000-8000-000000000001'
    expect(z.uuid().safeParse(upper).success).toBe(true)
    expect(LowerUuid.safeParse(upper).success).toBe(false)
  })
})
