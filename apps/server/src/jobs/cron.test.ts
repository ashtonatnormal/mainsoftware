import { describe, expect, it } from 'vitest'
import { nextAfter, parseCron, previousAtOrBefore } from '#src/jobs/cron.ts'

const at = (iso: string) => new Date(iso)
const next = (expression: string, after: string) => nextAfter(parseCron(expression), at(after)).toISOString()
const previous = (expression: string, before: string) =>
  previousAtOrBefore(parseCron(expression), at(before)).toISOString()

describe('C0.6 T15 item 13 five-field cron in UTC', () => {
  it('reads every field: numbers, lists, ranges and steps, Sunday as 0 or 7', () => {
    const cron = parseCron('0,30 9-17/4 1,15 */3 1-5')
    expect([...cron.minutes]).toEqual([0, 30])
    expect([...cron.hours]).toEqual([9, 13, 17])
    expect([...cron.days]).toEqual([1, 15])
    expect([...cron.months]).toEqual([1, 4, 7, 10])
    expect([...cron.weekdays]).toEqual([1, 2, 3, 4, 5])
    expect([...parseCron('* * * * 7').weekdays]).toEqual([0])
    expect([...parseCron('* * * * 5-7').weekdays].sort()).toEqual([0, 5, 6])
    // A number with a step runs to the field's end.
    expect([...parseCron('5/20 * * * *').minutes]).toEqual([5, 25, 45])
    expect(parseCron('17 3 * * *')).toMatchObject({ daysStar: true, weekdaysStar: true })
  })

  it('refuses what it can’t read: names, L, W, #, ?, out of range, backwards ranges, a zero step, wrong field counts', () => {
    for (const expression of [
      '* * * * MON',
      '* * L * *',
      '* * 15W * *',
      '* * * * 1#2',
      '* * ? * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * 32 * *',
      '* * * 13 *',
      '* * * 0 *',
      '* * * * 8',
      '5-1 * * * *',
      '*/0 * * * *',
      '* * * *',
      '* * * * * *',
      '*  * * * *',
      '',
      '1,,2 * * * *',
      '-1 * * * *',
    ]) {
      expect(() => parseCron(expression), expression).toThrow(/^cron: /)
    }
  })

  it('finds the next matching minute strictly after the given time, seconds dropped', () => {
    expect(next('* * * * *', '2026-10-14T10:00:00Z')).toBe('2026-10-14T10:01:00.000Z')
    expect(next('* * * * *', '2026-10-14T10:00:59.999Z')).toBe('2026-10-14T10:01:00.000Z')
    expect(next('17 3 * * *', '2026-10-14T03:16:59Z')).toBe('2026-10-14T03:17:00.000Z')
    // Exactly at an occurrence: the next one, not the same.
    expect(next('17 3 * * *', '2026-10-14T03:17:00Z')).toBe('2026-10-15T03:17:00.000Z')
    expect(next('47 3 * * *', '2026-10-14T23:00:00Z')).toBe('2026-10-15T03:47:00.000Z')
    expect(next('*/15 * * * *', '2026-10-14T10:16:00Z')).toBe('2026-10-14T10:30:00.000Z')
    expect(next('0 9-17/4 * * *', '2026-10-14T13:00:00Z')).toBe('2026-10-14T17:00:00.000Z')
  })

  it('rolls over hours, days, month ends and years, and keeps to leap days', () => {
    expect(next('0 0 * * *', '2026-12-31T23:59:00Z')).toBe('2027-01-01T00:00:00.000Z')
    expect(next('0 0 31 * *', '2026-10-31T00:00:00Z')).toBe('2026-12-31T00:00:00.000Z')
    expect(next('0 0 29 2 *', '2026-01-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z')
    expect(next('30 12 1 */6 *', '2026-07-01T12:30:00Z')).toBe('2027-01-01T12:30:00.000Z')
  })

  it('matches a day of the month or a day of the week when both are restricted, and both when one is *', () => {
    // The 1st, or any Monday: 2026-10-14 is a Wednesday, so Monday the 19th comes first.
    expect(next('0 9 1 * 1', '2026-10-14T00:00:00Z')).toBe('2026-10-19T09:00:00.000Z')
    expect(next('0 9 1 * 1', '2026-10-27T00:00:00Z')).toBe('2026-11-01T09:00:00.000Z')
    // Only Mondays (the day of the month is *).
    expect(next('0 9 * * 1', '2026-10-27T00:00:00Z')).toBe('2026-11-02T09:00:00.000Z')
    // A day-of-month step counts as *, so both must match: a Monday that is also odd.
    expect(next('0 9 */2 * 1', '2026-10-14T00:00:00Z')).toBe('2026-10-19T09:00:00.000Z')
    expect(next('0 9 */2 * 1', '2026-10-20T00:00:00Z')).toBe('2026-11-09T09:00:00.000Z')
  })

  it('throws for an expression that never matches within 5 years', () => {
    expect(() => nextAfter(parseCron('0 0 31 2 *'), at('2026-10-14T00:00:00Z'))).toThrow(/never matches/)
    expect(() => nextAfter(parseCron('0 0 30 2 *'), at('2026-10-14T00:00:00Z'))).toThrow(/never matches/)
    expect(() => previousAtOrBefore(parseCron('0 0 31 4 *'), at('2026-10-14T00:00:00Z'))).toThrow(/never matched/)
  })

  it('finds the last matching minute at or before a time, for the scheduler’s latest occurrence', () => {
    expect(previous('17 3 * * *', '2026-10-14T03:17:00Z')).toBe('2026-10-14T03:17:00.000Z')
    expect(previous('17 3 * * *', '2026-10-14T03:16:59Z')).toBe('2026-10-13T03:17:00.000Z')
    expect(previous('* * * * *', '2026-10-14T10:00:42Z')).toBe('2026-10-14T10:00:00.000Z')
    expect(previous('0 0 1 1 *', '2026-10-14T00:00:00Z')).toBe('2026-01-01T00:00:00.000Z')
    expect(previous('0 0 29 2 *', '2027-06-01T00:00:00Z')).toBe('2024-02-29T00:00:00.000Z')
    expect(previous('0 9 1 * 1', '2026-10-18T23:59:00Z')).toBe('2026-10-12T09:00:00.000Z')
  })

  it('agrees with itself: each occurrence’s previous is itself, and stepping finds no other in between', () => {
    for (const expression of ['17 3 * * *', '*/7 1-5 * * 2,4', '0 0 1,15 * *', '5 */6 * 2 0']) {
      const cron = parseCron(expression)
      let t = at('2026-01-01T00:00:00Z')
      for (let n = 0; n < 50; n++) {
        const following = nextAfter(cron, t)
        expect(previousAtOrBefore(cron, following).getTime(), expression).toBe(following.getTime())
        // A minute before the occurrence, the previous one is the one before it.
        expect(previousAtOrBefore(cron, new Date(following.getTime() - 60_000)).getTime()).toBeLessThanOrEqual(
          t.getTime(),
        )
        t = following
      }
    }
  })
})
