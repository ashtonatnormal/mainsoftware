// The web shell's answers (T21 item 10, T17 item 11): strict where the server types its reply,
// lenient where the web app reads it (P6).
import { describe, expect, test } from 'vitest'
import {
  ApiErrorBody,
  DEFAULT_TIME_ZONE,
  FlagsResponse,
  NOTICE_STANDINGS,
  readFlagsAnswer,
  SessionResponse,
  SessionResponseForClient,
} from './web.ts'

const personId = '0b9e6f2e-3c1a-4d5b-8e7f-1a2b3c4d5e6f'
const capabilities = { registers: false }
const notice = 'acknowledged'

describe('T21 item 10: GET /api/session', () => {
  test('T21 item 10 C0.9 PD-46: the answer is the person, a name, a zone, capability booleans and the notice standing, and nothing more', () => {
    const answer = { personId, name: 'Ahmad', timeZone: 'Asia/Kuala_Lumpur', capabilities, notice }
    expect(SessionResponse.parse(answer)).toEqual(answer)
    for (const extra of [{ phone: '+65 8000 0003' }, { roles: ['admin'] }, { orgId: personId }]) {
      expect(SessionResponse.safeParse({ ...answer, ...extra }).success, Object.keys(extra)[0]).toBe(false)
    }
    expect(SessionResponse.safeParse({ ...answer, personId: personId.toUpperCase() }).success).toBe(false)
    expect(SessionResponse.safeParse({ ...answer, name: '' }).success).toBe(false)
    expect(SessionResponse.safeParse({ ...answer, timeZone: '' }).success).toBe(false)
  })

  test('C0.9 PD-26 T21 item 10: capabilities are booleans can() decides, never roles, and the server always sends them', () => {
    const answer = { personId, name: 'Ashton', timeZone: DEFAULT_TIME_ZONE, notice }
    for (const registers of [true, false]) {
      expect(SessionResponse.parse({ ...answer, capabilities: { registers } }).capabilities).toEqual({ registers })
    }
    for (const bad of [
      undefined,
      null,
      {},
      { registers: 'true' },
      { registers: 1 },
      { registers: true, roles: ['dpo'] },
      { registers: true, admin: true },
      ['registers'],
    ]) {
      expect(SessionResponse.safeParse({ ...answer, capabilities: bad }).success, JSON.stringify(bad)).toBe(false)
    }
  })

  test('migration 0002: a name is bounded at 200 characters as Postgres counts them, emoji included', () => {
    const answer = { personId, timeZone: DEFAULT_TIME_ZONE, capabilities, notice }
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
    expect(
      SessionResponseForClient.parse({ personId, name: 'Ahmad', timeZone: 'UTC', notice, canAdmin: true }),
    ).toEqual({
      personId,
      name: 'Ahmad',
      timeZone: 'UTC',
      capabilities: { registers: false },
      notice,
    })
    expect(SessionResponseForClient.safeParse({ name: 'Ahmad', timeZone: 'UTC' }).success).toBe(false)
    expect(SessionResponseForClient.safeParse({ personId, timeZone: 'UTC' }).success).toBe(false)
  })

  test('C0.9 PD-26 P6: SessionResponseForClient reads a capability true only when the answer says true', () => {
    const answer = { personId, name: 'Ashton', timeZone: 'UTC' }
    const read = (value: unknown) => SessionResponseForClient.parse({ ...answer, capabilities: value }).capabilities
    expect(read({ registers: true })).toEqual({ registers: true })
    // A capability the client doesn't know yet is dropped, and the ones it knows still read.
    expect(read({ registers: true, admin: true })).toEqual({ registers: true })
    for (const value of [
      { registers: false },
      { registers: 'true' },
      { registers: 1 },
      {},
      null,
      'registers',
      [true],
    ]) {
      expect(read(value), JSON.stringify(value)).toEqual({ registers: false })
    }
    // An answer from before C0.9, with no capabilities, offers nothing.
    expect(SessionResponseForClient.parse(answer).capabilities).toEqual({ registers: false })
  })

  test('PDPA-03 ACC-12 C0.9 PD-43: the server always sends the standing, one of acknowledged, required and unpublished', () => {
    expect([...NOTICE_STANDINGS]).toEqual(['acknowledged', 'required', 'unpublished'])
    const answer = { personId, name: 'Nadia', timeZone: DEFAULT_TIME_ZONE, capabilities }
    for (const standing of NOTICE_STANDINGS) {
      expect(SessionResponse.parse({ ...answer, notice: standing }).notice).toBe(standing)
    }
    for (const bad of [undefined, null, '', 'Acknowledged', 'none', true, 0, { standing: 'acknowledged' }]) {
      expect(SessionResponse.safeParse({ ...answer, notice: bad }).success, JSON.stringify(bad)).toBe(false)
    }
  })

  test('P6 C0.9 PD-46: SessionResponseForClient reads a standing it can’t read as required, so /notice decides', () => {
    const answer = { personId, name: 'Nadia', timeZone: 'UTC', capabilities }
    for (const standing of NOTICE_STANDINGS) {
      expect(SessionResponseForClient.parse({ ...answer, notice: standing }).notice).toBe(standing)
    }
    // Missing (an answer from before C0.9 PR 2), unknown or of another type: never read as acknowledged.
    for (const value of [undefined, null, '', 'ACKNOWLEDGED', 'exempt', true, 1, ['acknowledged']]) {
      expect(SessionResponseForClient.parse({ ...answer, notice: value }).notice, JSON.stringify(value)).toBe(
        'required',
      )
    }
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
