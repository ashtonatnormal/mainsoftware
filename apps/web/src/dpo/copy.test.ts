// Every label the DPO pages can render, held to AI_COPY (C0.9 PD-27, PD-31, PD-48, PD-53; decision
// 8, D41; TECH-SPEC T22 items 17 and 31), including what ST-02 (strings/strings.test.ts) can't see
// because it isn't in a table under strings/: the register's wording of each purpose shown
// (packages/shared PURPOSES), and the shared refusal copy the pages pass on in the server's words.
// The notice's own words are the server's draft, which NTW-10 (notice/notice-copy.test.ts) holds
// to AI_COPY branch by branch, and the DPO's free text in it publishing refuses (PD-62). From C0.9
// PR 3a: the contact page's copy (strings/dpo-contact.ts), the record dialog's
// (strings/dpo-record.ts) and the transfer page's break-glass lines (PD-65, PD-70, PD-76, PD-80).
import { MESSAGES, NON_AI_PROVIDERS, NON_AI_PURPOSE_KEYS, PURPOSES, REAUTH_METHOD_MESSAGES } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { aiCopyIn } from '@/strings/ai-copy.ts'
import { API_COPY } from '@/strings/api.ts'
import * as DPO_TABLES from '@/strings/dpo.ts'
import * as CONTACT_TABLES from '@/strings/dpo-contact.ts'
import * as NOTICE_TABLES from '@/strings/dpo-notice.ts'
import * as PURPOSE_TABLES from '@/strings/dpo-purposes.ts'
import * as RECORD_TABLES from '@/strings/dpo-record.ts'
import * as TRANSFER_TABLES from '@/strings/dpo-transfers.ts'
import { NOTICE } from '@/strings/notice.ts'
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
// the shared line; pin_locked is the lock that ends, since the one only an Owner lifts has its own
// line, checked below).
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
  // The Notice tab's read refused before the DPO has acknowledged the latest version, as the tab
  // moves to /notice; notice_changed and notice_invalid it words itself (dpo/notice-model.ts).
  'notice_required',
] as const satisfies readonly (keyof typeof MESSAGES)[]

describe('C0.9 PD-27 PD-31: the DPO pages’ copy', () => {
  it('DPP-06 decision 8 PD-53 PD-65: no label the pages can render matches AI_COPY: the purposes shown, the provider names, the bases and every problem and warning (strings/dpo*.ts, the Notice tab’s, the notice markers’, the contact page’s and the record dialog’s included), the shared refusals passed on, the re-authentication lines, and the titles and menu entry in strings/shell.ts', () => {
    const shown = [
      ...NON_AI_PURPOSE_KEYS.map(key => ({ where: `PURPOSES.${key}.register`, text: PURPOSES[key].register })),
      ...stringsIn(DPO_TABLES, 'strings/dpo.ts'),
      ...stringsIn(PURPOSE_TABLES, 'strings/dpo-purposes.ts'),
      ...stringsIn(TRANSFER_TABLES, 'strings/dpo-transfers.ts'),
      ...stringsIn(NOTICE_TABLES, 'strings/dpo-notice.ts'),
      ...stringsIn(CONTACT_TABLES, 'strings/dpo-contact.ts'),
      ...stringsIn(RECORD_TABLES, 'strings/dpo-record.ts'),
      ...PASSED_ON.map(code => ({ where: `MESSAGES.${code}`, text: MESSAGES[code] })),
      ...stringsIn(REAUTH_METHOD_MESSAGES.pin, 'REAUTH_METHOD_MESSAGES.pin'),
      ...stringsIn(REAUTH_METHOD_MESSAGES.sign_in, 'REAUTH_METHOD_MESSAGES.sign_in'),
      { where: 'API_COPY.network', text: API_COPY.network },
      ...stringsIn(SHELL.dpo, 'SHELL.dpo'),
      { where: 'SHELL.account.dataProtection', text: SHELL.account.dataProtection },
    ]
    // The tables were read: every non-AI purpose, provider name, basis and problem, and the notice's.
    expect(shown.length).toBeGreaterThan(200)
    expect(shown.filter(entry => entry.where.startsWith('strings/dpo-notice.ts')).length).toBeGreaterThan(50)
    expect(shown.filter(entry => entry.where.startsWith('strings/dpo-record.ts')).length).toBeGreaterThan(30)
    expect(shown.filter(entry => entry.where.startsWith('strings/dpo-contact.ts')).length).toBeGreaterThan(40)
    expect(shown).toContainEqual({
      where: 'strings/dpo-transfers.ts.TRANSFERS_COPY.twilioLastSession',
      text: TRANSFER_TABLES.TRANSFERS_COPY.twilioLastSession,
    })
    expect(Object.keys(DPO_TABLES.PROVIDER_NAMES).sort()).toEqual([...NON_AI_PROVIDERS].sort())
    expect(
      shown.filter(entry => aiCopyIn(entry.text) !== undefined).map(entry => `${entry.where}: ${entry.text}`),
    ).toEqual([])
    // The server's lines the pages replace, because they say "Ask": pin_reset_needed, and
    // pin_locked's once only an Owner can unlock it (apps/server auth/errors.ts
    // PIN_ADMIN_LOCKED_MESSAGE, which the web app can't import; dpo/model.ts pinOutcomeOf).
    expect(aiCopyIn(MESSAGES.pin_reset_needed)).toBeDefined()
    expect(aiCopyIn(DPO_TABLES.DPO.reauth.pinResetNeeded)).toBeUndefined()
    expect(aiCopyIn("Your PIN is locked. Ask an Owner to reset it. They'll check it's you first.")).toBeDefined()
    expect(aiCopyIn(DPO_TABLES.DPO.reauth.pinAdminLocked)).toBeUndefined()
  })

  it('DPP-06 PD-27: the AI layer’s purposes and providers have no line on the pages: they are left out of the lists the pages draw from', () => {
    expect(NON_AI_PURPOSE_KEYS.filter(key => PURPOSES[key].ai)).toEqual([])
    expect(NON_AI_PROVIDERS).not.toContain('openai')
    expect(NON_AI_PROVIDERS).not.toContain('bedrock')
    expect(Object.keys(TRANSFER_TABLES.PROVIDER_CHECKS).sort()).toEqual([...NON_AI_PROVIDERS].sort())
  })

  it('DPP-06 OD-01: before any version, the Notice tab, the register banner and /notice agree that nobody can use Hearth, the DPO included (the gateway admits nobody)', () => {
    const lines = [
      NOTICE_TABLES.NOTICE_TAB.published.none,
      NOTICE_TABLES.NOTICE_MARKERS.banner.none,
      NOTICE.unpublished.dpoBody,
    ]
    for (const line of lines) {
      expect(line).toMatch(/\b[Nn]obody can use Hearth\b/)
      expect(line).not.toMatch(/\bbut you\b/)
    }
  })
})
