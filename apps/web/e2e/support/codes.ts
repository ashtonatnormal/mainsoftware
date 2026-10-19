// How the suite reads a sign-in code (T21, T20; AUTH-DESIGN §6.2, §10.5, INTEGRATION.md item 5).
// The api role runs the fake SMS provider, which sends nothing and prints one line to stderr for each
// code it would text, never to the JSON log, with the number masked to its last two digits:
//   [local only, not a log line] Hearth code for +65 xxxxxx03: 123456
// (apps/server/src/auth/sms/fake.ts createFakeVerify; its unit test pins the shape). The line names
// no purpose, because re-authentication codes use it too. The api's command appends stdout and
// stderr to playwright/logs/api.log, so a test takes the log's size before it asks for a code and
// reads the first line after that offset for its number: an older code is never read, and a new
// request after a replaced code gets the new one. A number off the roster gets no text and no line.
//
// The pattern and the masking live here only (K-43): a change to the fake's line breaks its unit
// test first, then this file.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { maskNumber } from '@hearth/shared'
import { API_LOG } from './env.ts'

// INTEGRATION.md item 5's pattern: the masked number, then the 6 digits at the line's end.
export const CODE_LINE = /code for (\+\d+ x*\d{2}): (\d{6})$/gm

// The log's size now: read codes after this.
export function logOffset(path: string = API_LOG): number {
  return existsSync(path) ? statSync(path).size : 0
}

// The text written to the log from byte `from`.
export function logSince(from: number, path: string = API_LOG): string {
  if (!existsSync(path)) return ''
  const size = statSync(path).size
  if (size <= from) return ''
  const buffer = Buffer.alloc(size - from)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, buffer.length, from)
  } finally {
    closeSync(fd)
  }
  return buffer.toString('utf8')
}

// The codes printed for this number in some text, in order.
export function codesIn(text: string, e164: string): string[] {
  const masked = maskNumber(e164)
  return [...text.matchAll(CODE_LINE)].filter(match => match[1] === masked).map(match => match[2] ?? '')
}

// The first code printed for this number after `from`, polling up to timeoutMs.
export async function readCode(e164: string, from: number, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [code] = codesIn(logSince(from), e164)
    if (code !== undefined) return code
    if (Date.now() > deadline) throw new Error(`no code for ${maskNumber(e164)} in the api log within ${timeoutMs} ms`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
