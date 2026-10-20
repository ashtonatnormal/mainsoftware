// Every string table the app shows from (T21; CLAUDE.md Conventions, decision 8, D29): the
// kit's (ui/strings.ts) and each screen's in strings/. New tables in strings/ are read without a
// change here. A table may hold functions that build a line from a value; each is called with
// placeholder arguments and its result read too.
import { describe, expect, it } from 'vitest'
import { UI } from '../ui/strings.ts'
import { AI_COPY, aiCopyIn } from './ai-copy.ts'

const tables: Record<string, unknown> = {
  'ui/strings.ts': UI,
  ...import.meta.glob(['./*.ts', '!./*.test.ts', '!./ai-copy.ts'], { eager: true }),
}

// Every string a value holds, with where it was found.
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

const all = Object.entries(tables).flatMap(([file, table]) => stringsIn(table, file))

// American spellings that slip into copy, as whole-word stems. "Program" (software) and "license"
// (the verb) are British too, so they're not here.
const AMERICAN = [
  /\bcolor/i,
  /\bcenter(?:s|ed|ing)?\b/i,
  /\bfavor/i,
  /\bbehavior/i,
  /\bhonor/i,
  /\blabor/i,
  /\bneighbor/i,
  /\bgray\b/i,
  /\bcatalog\b/i,
  /\bdialog\b/i,
  /\bcancel(?:ed|ing)\b/i,
  /\btravel(?:ed|ing)\b/i,
  /\benroll(?:s|ment)?\b/i,
  /\bfulfill\b/i,
  /\bmodeled\b/i,
  /\b(?:organiz|recogniz|realiz|apologiz|customiz|authoriz|prioritiz|summariz|minimiz|maximiz|finaliz|personaliz|synchroniz|analyz)/i,
  /\bdefense\b/i,
  /\boffense\b/i,
]

describe('T21: the string tables', () => {
  it('sanity: the kit table and every table in strings/ are read, and hold strings', () => {
    expect(Object.keys(tables)).toContain('ui/strings.ts')
    expect(all.length).toBeGreaterThan(0)
    expect(all.some(entry => entry.text === 'Skip to content')).toBe(true)
  })

  it('ST-01 CL Conventions D29: no American spellings from a short list (color, center, organization, canceled, …) in strings/ and ui/strings.ts', () => {
    const found = all.filter(entry => AMERICAN.some(pattern => pattern.test(entry.text)))
    expect(found).toEqual([])
    // The list itself catches what it says it does.
    for (const text of ['Color', 'centered', 'Organization', 'canceled', 'favorite', 'gray'])
      expect(
        AMERICAN.some(pattern => pattern.test(text)),
        text,
      ).toBe(true)
    for (const text of ['Colour', 'centred', 'organisation', 'cancelled', 'favourite', 'grey', 'Cancel'])
      expect(
        AMERICAN.some(pattern => pattern.test(text)),
        text,
      ).toBe(false)
  })

  it('ST-02 decision 8 D41: no string in those tables matches AI_COPY (ask, AI, assistant, agent, copilot, coming soon, ✦)', () => {
    const found = all.filter(entry => aiCopyIn(entry.text)).map(entry => `${entry.where}: ${entry.text}`)
    expect(found).toEqual([])
    for (const text of ['Ask Hearth', 'AI summary', 'Your assistant', 'Agents', 'Copilot', 'Coming soon', '✦ New'])
      expect(aiCopyIn(text), text).toBeDefined()
    for (const text of ['Tasks', 'Basket', 'Again', 'Main', 'Send a new code', 'Chats'])
      expect(aiCopyIn(text), text).toBeUndefined()
    expect(AI_COPY.length).toBeGreaterThanOrEqual(7)
  })
})
