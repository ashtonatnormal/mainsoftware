import fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  ATTEMPT_COOKIE,
  addCookie,
  attemptCookie,
  clearedCookie,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
} from '#src/auth/cookies.ts'

// Well-formed values: 43 base64url characters, as newSecret() makes.
const TOKEN = `${'A'.repeat(21)}_-${'z'.repeat(20)}`
const OTHER = '0'.repeat(43)

describe('T5 CLAUDE.md Security: the sign-in cookies', () => {
  it('writes the session cookie as a __Host- cookie, HttpOnly, Secure and SameSite=Lax', () => {
    expect(sessionCookie(TOKEN, 7_776_000)).toBe(
      `__Host-hearth_session=${TOKEN}; Path=/; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax`,
    )
  })

  it('writes the attempt cookie for 10 minutes, SameSite=Strict', () => {
    expect(attemptCookie(TOKEN)).toBe(
      `__Host-hearth_attempt=${TOKEN}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Strict`,
    )
  })

  it('clears each with the same name and attributes', () => {
    expect(clearedCookie('session')).toBe('__Host-hearth_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax')
    expect(clearedCookie('attempt')).toBe(
      '__Host-hearth_attempt=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
    )
  })

  it('reads the one value, ignoring other cookies', () => {
    expect(readCookie(`${SESSION_COOKIE}=${TOKEN}`, SESSION_COOKIE)).toBe(TOKEN)
    expect(readCookie(`theme=dark; ${SESSION_COOKIE}=${TOKEN};${ATTEMPT_COOKIE}=${OTHER}`, SESSION_COOKIE)).toBe(TOKEN)
    expect(readCookie(`theme=dark; ${SESSION_COOKIE}=${TOKEN}; ${ATTEMPT_COOKIE}=${OTHER}`, ATTEMPT_COOKIE)).toBe(OTHER)
    expect(readCookie([`theme=dark`, `${SESSION_COOKIE}=${TOKEN}`], SESSION_COOKIE)).toBe(TOKEN)
  })

  it('counts as none: no header, no such cookie, a duplicate name, or a malformed value', () => {
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined()
    expect(readCookie('', SESSION_COOKIE)).toBeUndefined()
    expect(readCookie('theme=dark', SESSION_COOKIE)).toBeUndefined()
    expect(readCookie(`hearth_session=${TOKEN}`, SESSION_COOKIE)).toBeUndefined()
    expect(readCookie(`x${SESSION_COOKIE}=${TOKEN}`, SESSION_COOKIE)).toBeUndefined()
    expect(readCookie(`${SESSION_COOKIE}=${TOKEN}; ${SESSION_COOKIE}=${OTHER}`, SESSION_COOKIE)).toBeUndefined()
    expect(readCookie(`${SESSION_COOKIE}=${TOKEN}; ${SESSION_COOKIE}=${TOKEN}`, SESSION_COOKIE)).toBeUndefined()
    for (const value of [TOKEN.slice(1), `${TOKEN}A`, `${TOKEN.slice(1)}=`, `${TOKEN.slice(1)}+`, `"${TOKEN}"`, '']) {
      expect(readCookie(`${SESSION_COOKIE}=${value}`, SESSION_COOKIE), value).toBeUndefined()
    }
    expect(readCookie(SESSION_COOKIE, SESSION_COOKIE)).toBeUndefined()
  })

  it('adds a cookie to a reply without dropping one already there', async () => {
    const app = fastify()
    app.get('/', async (_request, reply) => {
      addCookie(reply, sessionCookie(TOKEN, 60))
      addCookie(reply, clearedCookie('attempt'))
      return {}
    })
    try {
      const response = await app.inject({ method: 'GET', url: '/' })
      expect(response.headers['set-cookie']).toEqual([sessionCookie(TOKEN, 60), clearedCookie('attempt')])
    } finally {
      await app.close()
    }
  })
})
