// Every label the DPO pages can render, held to AI_COPY (C0.9 PD-27, PD-31; decision 8, D41;
// TECH-SPEC T22 item 17), including what ST-02 (strings/strings.test.ts) can't see because it isn't
// in a table under strings/: the register's wording of each purpose shown (packages/shared
// PURPOSES), and the shared refusal copy the pages pass on in the server's words.
import { MESSAGES, NON_AI_PROVIDERS, NON_AI_PURPOSE_KEYS, PURPOSES, REAUTH_METHOD_MESSAGES } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { aiCopyIn } from '@/strings/ai-copy.ts'
import { API_COPY } from '@/strings/api.ts'
import * as DPO_TABLES from '@/strings/dpo.ts'
import * as PURPOSE_TABLES from '@/strings/dpo-purposes.ts'
import * as TRANSFER_TABLES from '@/strings/dpo-transfers.ts'
import { SHELL } from '@/strings/shell.ts'

// Every string a value holds, functions called with placeholder arguments, as ST-02 reads tables.
function stringsIn(value: unknown, where: string): { where: string; text: string }[] {
  if (typeof value === 'string') return [{ where, text: value }]
  if (typeof value === 'function') {
    const args = Array.from({ length: value.length }, () => 'X')
    return stringsIn((value as (...args: string[]) => unknown)(...args), `${where}()`)
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => stringsIn(item, `${where}[${index}]`))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => stringsIn(item, `${where}.${key}`))
  }
  return []
}

// The refusals the pages pass on as the server words them: the registers' routes and the PIN step
// (a code the client maps to its own copy, pin_reset_needed, is left out: the pages never show
// the shared line).
const PASSED_ON = [
  'invalid_request',
  'invalid_pin',
  'too_many_requests',
  'unavailable',
  'pin_wrong',
  'pin_locked',
  'forbidden',
  'not_found',
  'register_changed',
  'register_invalid',
  'try_again',
  'internal',
] as const satisfies readonly (keyof typeof MESSAGES)[]

describe('C0.9 PD-27 PD-31: the DPO pages’ copy', () => {
  it('DPP-06 decision 8: no label the pages can render matches AI_COPY: the purposes shown, the provider names, the bases and every problem and warning (strings/dpo*.ts), the shared refusals passed on, the re-authentication lines, and the titles and menu entry in strings/shell.ts', () => {
    const shown = [
      ...NON_AI_PURPOSE_KEYS.map(key => ({ where: `PURPOSES.${key}.register`, text: PURPOSES[key].register })),
      ...stringsIn(DPO_TABLES, 'strings/dpo.ts'),
      ...stringsIn(PURPOSE_TABLES, 'strings/dpo-purposes.ts'),
      ...stringsIn(TRANSFER_TABLES, 'strings/dpo-transfers.ts'),
      ...PASSED_ON.map(code => ({ where: `MESSAGES.${code}`, text: MESSAGES[code] })),
      ...stringsIn(REAUTH_METHOD_MESSAGES.pin, 'REAUTH_METHOD_MESSAGES.pin'),
      ...stringsIn(REAUTH_METHOD_MESSAGES.sign_in, 'REAUTH_METHOD_MESSAGES.sign_in'),
      { where: 'API_COPY.network', text: API_COPY.network },
      ...stringsIn(SHELL.dpo, 'SHELL.dpo'),
      { where: 'SHELL.account.dataProtection', text: SHELL.account.dataProtection },
    ]
    // The tables were read: every non-AI purpose, provider name, basis and problem.
    expect(shown.length).toBeGreaterThan(150)
    expect(Object.keys(DPO_TABLES.PROVIDER_NAMES).sort()).toEqual([...NON_AI_PROVIDERS].sort())
    expect(
      shown.filter(entry => aiCopyIn(entry.text) !== undefined).map(entry => `${entry.where}: ${entry.text}`),
    ).toEqual([])
    // The one shared line the pages replace, because it says "Ask".
    expect(aiCopyIn(MESSAGES.pin_reset_needed)).toBeDefined()
    expect(aiCopyIn(DPO_TABLES.DPO.reauth.pinResetNeeded)).toBeUndefined()
  })

  it('DPP-06 PD-27: the AI layer’s purposes and providers have no line on the pages: they are left out of the lists the pages draw from', () => {
    expect(NON_AI_PURPOSE_KEYS.filter(key => PURPOSES[key].ai)).toEqual([])
    expect(NON_AI_PROVIDERS).not.toContain('openai')
    expect(NON_AI_PROVIDERS).not.toContain('bedrock')
    expect(Object.keys(TRANSFER_TABLES.PROVIDER_CHECKS).sort()).toEqual([...NON_AI_PROVIDERS].sort())
  })
})
