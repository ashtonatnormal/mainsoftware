// The Rule 1-9 access suite (PRD §7.2, B.4; BUILD-PLAN C0.4, T10). One named case per rule
// requirement; the cases themselves are in src/testing/rules/. Cases the access core decides run
// now; the rest are todos tagged with the stage that builds them: `core` for a later non-AI step,
// `ai` for the AI layer. CI prints every case, todos included, so the suite lists every rule.
//
//   npx vitest run packages/access/rules.test.ts --reporter=verbose
//   npx vitest run packages/access/rules.test.ts --tags-filter=ai     (the AI cases only)
import { describe, expect, test } from 'vitest'
import { RULES } from './src/testing/rules/index.ts'

const ruleTag = (n: number) => `rule-${n}`

for (const { rule, title, cases } of RULES) {
  describe(`Rule ${rule}: ${title}`, () => {
    for (const c of cases) {
      if (c.status === 'c0') {
        test(`${c.id} ${c.name}`, { tags: [ruleTag(rule)] }, c.run)
      } else {
        test.todo(`${c.id} [${c.stage}] ${c.name}`, { tags: [ruleTag(rule), c.status] })
      }
    }
  })
}

describe('The suite itself', () => {
  const all = RULES.flatMap(r => r.cases.map(c => ({ ...c, rule: r.rule })))

  test('covers Rules 1 to 9, each with cases that run now', () => {
    expect(RULES.map(r => r.rule)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    for (const r of RULES)
      expect(
        r.cases.some(c => c.status === 'c0'),
        `Rule ${r.rule}`,
      ).toBe(true)
  })

  test('gives every case a unique id in its rule (R<rule>-<n>) and a requirement id in its name', () => {
    const ids = all.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of all) {
      expect(c.id, c.name).toMatch(new RegExp(`^R${c.rule}-\\d{2}[a-z]?$`))
      expect(c.name, c.id).toMatch(
        /\b(?:[A-Z]{2,6}-\d{2,3}[a-z]?|D\d{1,2}|T\d{1,2}|Rule \d|§\d|decision \d+|[A-Z]\d\.\d+)/,
      )
    }
  })

  test('gives every case that runs now a test, and every todo a stage and no test', () => {
    for (const c of all) {
      if (c.status === 'c0') expect(typeof c.run, c.id).toBe('function')
      else {
        expect(c.run, c.id).toBeUndefined()
        expect(c.stage, c.id).toMatch(/^(?:C\d\.\d{1,2}|A\d(?:\.\d)?)(?:, (?:C\d\.\d{1,2}|A\d(?:\.\d)?))*$/)
      }
    }
  })

  test('keeps the cases BUILD-PLAN names (C0.4 open items, BUILD-PLAN.md:841)', () => {
    const named = (id: string) => all.find(c => c.id === id)
    expect(named('R2-01')?.name).toContain('covers(audienceOf(#general), CFO-DM item) = false')
    expect(named('R2-01')?.status).toBe('c0')
    expect(named('R1-04')?.name).toMatch(/SRCH-04.*PRD-107/)
    expect(named('R1-04')?.status).toBe('c0')
  })
})
