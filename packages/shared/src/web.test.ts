// The web shell's answers (T21 item 10, T17 item 11): strict where the server types its reply,
// lenient where the web app reads it (P6).
import { describe, expect, test } from 'vitest'
import {
  ApiErrorBody,
  DEFAULT_TIME_ZONE,
  FlagsResponse,
  readFlagsAnswer,
  SessionResponse,
  SessionResponseForClient,
} from './web.ts'

const personId = '0b9e6f2e-3c1a-4d5b-8e7f-1a2b3c4d5e6f'

describe('T21 item 10: GET /api/session', () => {
  test('OD-22: the answer is the person, a name and a zone, and nothing more', () => {
    const answer = { personId, name: 'Ahmad', timeZone: 'Asia/Kuala_Lumpur' }
    expect(SessionResponse.parse(answer)).toEqual(answer)
    for (const extra of [{ phone: '+65 8000 0003' }, { roles: ['admin'] }, { orgId: personId }]) {
      expect(SessionResponse.safeParse({ ...answer, ...extra }).success, Object.keys(extra)[0]).toBe(false)
    }
    expect(SessionResponse.safeParse({ ...answer, personId: personId.toUpperCase() }).success).toBe(false)
    expect(SessionResponse.safeParse({ ...answer, name: '' }).success).toBe(false)
    expect(SessionResponse.safeParse({ ...answer, timeZone: '' }).success).toBe(false)
  })

  test('migration 0002: a name is bounded at 200 characters as Postgres counts them, emoji included', () => {
    const answer = { personId, timeZone: DEFAULT_TIME_ZONE }
    expect(SessionResponse.safeParse({ ...answer, name: 'a'.repeat(200) }).success).toBe(true)
    expect(SessionResponse.safeParse({ ...answer, name: 'a'.repeat(201) }).success).toBe(false)
    // 200 code points, 400 UTF-16 units: the database holds it, so the answer must carry it.
    expect(SessionResponse.safeParse({ ...answer, name: '🙂'.repeat(200) }).success).toBe(true)
    expect(SessionResponse.safeParse({ ...answer, name: '🙂'.repeat(201) }).success).toBe(false)
  })

  test('SW-03: SessionResponseForClient falls back to Asia/Singapore for an empty zone', () => {
    expect(DEFAULT_TIME_ZONE).toBe('Asia/Singapore')
    for (const timeZone of ['', undefined, null, 7]) {
      expect(SessionResponseForClient.parse({ personId, name: 'Ahmad', timeZone }).timeZone, String(timeZone)).toBe(
        'Asia/Singapore',
      )
    }
    expect(SessionResponseForClient.parse({ personId, name: 'Ahmad', timeZone: 'Europe/London' }).timeZone).toBe(
      'Europe/London',
    )
    // A field added later is dropped, not refused; a missing person or name still fails.
    expect(SessionResponseForClient.parse({ personId, name: 'Ahmad', timeZone: 'UTC', canAdmin: true })).toEqual({
      personId,
      name: 'Ahmad',
      timeZone: 'UTC',
    })
    expect(SessionResponseForClient.safeParse({ name: 'Ahmad', timeZone: 'UTC' }).success).toBe(false)
    expect(SessionResponseForClient.safeParse({ personId, timeZone: 'UTC' }).success).toBe(false)
  })
})

describe('T17 item 11: GET /api/flags', () => {
  test('SW-01 T17 item 11: FlagsResponse is strict (no extra keys, booleans only)', () => {
    expect(FlagsResponse.parse({ flags: {} })).toEqual({ flags: {} })
    expect(FlagsResponse.parse({ flags: { 'it.client': true, 'core.chat': false } })).toEqual({
      flags: { 'it.client': true, 'core.chat': false },
    })
    for (const answer of [
      { flags: {}, revision: 3 },
      { flags: {}, cohort: { people: [], roles: [] } },
      { flags: { 'it.client': 'true' } },
      { flags: { 'it.client': 1 } },
      { flags: { 'it.client': null } },
      { flags: { 'it.client': { enabled: true } } },
      { flags: { 'It.Client': true } },
      { flags: { [`a${'.b'.repeat(50)}`]: true } },
      { flags: [] },
      {},
    ]) {
      expect(FlagsResponse.safeParse(answer).success, JSON.stringify(answer)).toBe(false)
    }
  })

  test('SW-02 P6: readFlagsAnswer reads non-true as false and a bad shape as {}', () => {
    expect(readFlagsAnswer({ flags: { a: true, b: false, c: 'true', d: 1, e: null, f: {} } })).toEqual({
      a: true,
      b: false,
      c: false,
      d: false,
      e: false,
      f: false,
    })
    for (const value of [undefined, null, 'flags', 1, [], { flags: null }, { flags: [true] }, { flags: 'a' }, {}]) {
      expect(readFlagsAnswer(value), JSON.stringify(value)).toEqual({})
    }
    // A key that isn't a flag key is dropped; extra fields beside flags are ignored.
    expect(readFlagsAnswer({ flags: { 'Bad Key': true, __proto__x: true, ok: true }, revision: 2 })).toEqual({
      ok: true,
    })
  })

  test('P6: a key the answer lacks reads undefined, never an inherited value, and the result is frozen', () => {
    const flags = readFlagsAnswer({ flags: JSON.parse('{"__proto__": true, "x": true}') })
    expect(flags).toEqual({ x: true })
    expect(flags.constructor).toBeUndefined()
    expect(flags.toString).toBeUndefined()
    expect(Object.isFrozen(flags)).toBe(true)
  })
})

describe('every /api refusal', () => {
  test('T20 T21: ApiErrorBody reads a refusal with or without a message, and keeps its extras', () => {
    expect(ApiErrorBody.parse({ error: 'Not Found' })).toEqual({ error: 'Not Found' })
    expect(ApiErrorBody.parse({ error: 'code_wrong', message: "That code isn't right.", triesLeft: 3 })).toEqual({
      error: 'code_wrong',
      message: "That code isn't right.",
      triesLeft: 3,
    })
    for (const body of [{}, { error: '' }, { error: 7 }, { error: 'x'.repeat(65) }, { error: 'x', message: 3 }, null]) {
      expect(ApiErrorBody.safeParse(body).success, JSON.stringify(body)).toBe(false)
    }
  })
})
