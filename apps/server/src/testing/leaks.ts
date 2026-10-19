// The sweep every sign-in suite on the stack runs in its afterAll (test-only; the image leaves
// testing/ out): the live one (auth/sign-in.integration.test.ts) and the dormant passkeys' (D46,
// auth/passkeys.integration.test.ts), so the paths a reviewed flip of PASSKEYS_ON would turn on are
// swept as the live ones are. No log line or audit row holds a number, code, PIN, session token or
// attempt id; every /api reply was no-store, held no token or attempt id, and none was a 500; and
// no Node warning fired.
import { expect } from 'vitest'
import type { Stack } from '#src/testing/stack.ts'

type Swept = Pick<Stack, 'logs' | 'replies' | 'warnings' | 'issued' | 'pins' | 'numbers' | 'sms' | 'query'>

// The text with every uuid and timestamp taken out, so a 6-digit code or PIN can be looked for
// as a whole number without matching inside an id or a time.
function scrub(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?/g, 'TIME')
}

// What a run must never write anywhere: the numbers it used, the codes sent, the PINs typed, and
// the tokens and attempt ids issued. Returns what a text holds of them.
function leaksIn(s: Swept, text: string): string[] {
  const found: string[] = []
  const clean = scrub(text)
  const whole = (digits: string) => new RegExp(`(?<![0-9])${digits}(?![0-9])`).test(clean)
  for (const e164 of s.numbers) if (text.includes(e164) || whole(e164.slice(3))) found.push(`number ${e164}`)
  for (const { code } of s.sms.sent) if (whole(code)) found.push(`code ${code}`)
  for (const pin of s.pins) if (/^[0-9]{6}$/.test(pin) && whole(pin)) found.push(`PIN ${pin}`)
  for (const secret of s.issued) if (text.includes(secret)) found.push('a token or attempt id')
  return found
}

export async function expectNothingLeaked(s: Swept): Promise<void> {
  // No log line holds a number, code, PIN, token or attempt id (time, pid and the response time
  // are left out: they're numbers that could look like a code).
  for (const line of s.logs) {
    const { time: _time, pid: _pid, responseTime: _responseTime, ...rest } = line
    expect(leaksIn(s, JSON.stringify(rest)), JSON.stringify(rest)).toEqual([])
  }
  // Nor does any audit row, read whole.
  const rows = await s.query<{ row: string }>('select to_jsonb(a)::text as row from audit_events a')
  for (const { row } of rows) expect(leaksIn(s, row), row).toEqual([])
  // Every /api reply was no-store, held no token or attempt id, and none was a 500.
  for (const reply of s.replies) {
    expect(reply.cacheControl, `${reply.method} ${reply.url}`).toBe('no-store')
    expect(
      [...s.issued].some(secret => reply.text.includes(secret)),
      `${reply.method} ${reply.url}`,
    ).toBe(false)
    expect(reply.error, `${reply.method} ${reply.url}`).not.toBe('internal')
  }
  // No Node warning fired: the experimental Web Crypto ones included, which only the passkey paths
  // (@simplewebauthn) can cause, so the dormant suite is the one that would see them.
  expect(s.warnings.map(warning => `${warning.name}: ${warning.message}`)).toEqual([])
}
