// The two cookies sign-in uses, written by hand (no plugin). Both are __Host- cookies: Secure,
// Path=/ and no Domain, so only the app's own host gets them, and HttpOnly, so no script can read
// them (CLAUDE.md, Security and privacy; T5).
// - The session cookie holds the session token. SameSite=Lax, as CLAUDE.md sets it.
// - The attempt cookie holds a sign-in attempt's id between steps. SameSite=Strict, since only
//   the app's own fetches ever send it.
import type { FastifyReply } from 'fastify'
import { ATTEMPT_TTL_MS } from '#src/auth/policy.ts'

export const SESSION_COOKIE = '__Host-hearth_session'
export const ATTEMPT_COOKIE = '__Host-hearth_attempt'

function cookie(name: string, value: string, maxAgeSeconds: number, sameSite: 'Lax' | 'Strict'): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=${sameSite}`
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return cookie(SESSION_COOKIE, token, maxAgeSeconds, 'Lax')
}

export function attemptCookie(id: string): string {
  return cookie(ATTEMPT_COOKIE, id, ATTEMPT_TTL_MS / 1000, 'Strict')
}

// The same name and attributes with an empty value and Max-Age=0, which removes the cookie.
export function clearedCookie(which: 'session' | 'attempt'): string {
  return which === 'session' ? cookie(SESSION_COOKIE, '', 0, 'Lax') : cookie(ATTEMPT_COOKIE, '', 0, 'Strict')
}

// Both values are 32 random bytes in base64url (crypto.ts newSecret).
const VALUE = /^[A-Za-z0-9_-]{43}$/

// The cookie's value, if the request carries exactly one cookie of that name with a well-formed
// value; anything else (none, two, a malformed value) counts as none.
export function readCookie(header: string | string[] | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  const pairs = (Array.isArray(header) ? header.join(';') : header).split(';')
  const values = pairs
    .map(pair => pair.trim())
    .filter(pair => pair.includes('=') && pair.slice(0, pair.indexOf('=')) === name)
    .map(pair => pair.slice(pair.indexOf('=') + 1))
  const [value] = values
  return values.length === 1 && value !== undefined && VALUE.test(value) ? value : undefined
}

// Adds a Set-Cookie header, keeping any already on the reply (Fastify appends Set-Cookie values).
export function addCookie(reply: FastifyReply, setCookie: string): void {
  reply.header('set-cookie', setCookie)
}
