import { afterEach, describe, expect, it, vi } from 'vitest'
import { formattersFor } from './time.ts'

// Sunday 11 October 2026, 2:30 pm in Singapore (UTC+8).
const SUNDAY_AFTERNOON = Date.UTC(2026, 9, 11, 6, 30)

describe('T21: dates and times (X14)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("TM-01 X14 OD-10 SHEET-15: 'Sun 11 Oct 2026' and '2:30 pm', '12:05 am' in en-GB", () => {
    const sg = formattersFor('Asia/Singapore')
    expect(sg.date(SUNDAY_AFTERNOON)).toBe('Sun 11 Oct 2026')
    expect(sg.time(SUNDAY_AFTERNOON)).toBe('2:30 pm')
    expect(sg.dateTime(SUNDAY_AFTERNOON)).toBe('Sun 11 Oct 2026, 2:30 pm')
    // Five past midnight is 12:05 am, never 0:05.
    expect(sg.time(Date.UTC(2026, 9, 10, 16, 5))).toBe('12:05 am')
    expect(sg.time(Date.UTC(2026, 9, 11, 4, 0))).toBe('12:00 pm')
  })

  it('TM-02 X14 CAL-06: one instant in Asia/Singapore and Europe/London across the October change', () => {
    const sg = formattersFor('Asia/Singapore')
    const london = formattersFor('Europe/London')
    // London leaves summer time at 01:00 UTC on Sunday 25 October 2026; Singapore has no change.
    const before = Date.UTC(2026, 9, 25, 0, 30)
    const after = Date.UTC(2026, 9, 25, 1, 30)
    expect(london.dateTime(before)).toBe('Sun 25 Oct 2026, 1:30 am')
    expect(london.dateTime(after)).toBe('Sun 25 Oct 2026, 1:30 am')
    expect(sg.dateTime(before)).toBe('Sun 25 Oct 2026, 8:30 am')
    expect(sg.dateTime(after)).toBe('Sun 25 Oct 2026, 9:30 am')
    // The same instant is a different day in each zone.
    const lateLondon = Date.UTC(2026, 9, 24, 22, 0)
    expect(london.date(lateLondon)).toBe('Sat 24 Oct 2026')
    expect(sg.date(lateLondon)).toBe('Sun 25 Oct 2026')
  })

  it('TM-03 SHL-13: one cached formatter per zone and kind', () => {
    const made = vi.spyOn(Intl, 'DateTimeFormat')
    // A zone no other test uses, so the cache starts empty for it.
    const first = formattersFor('Pacific/Chatham')
    for (let i = 0; i < 5; i++) {
      first.date(SUNDAY_AFTERNOON + i)
      first.time(SUNDAY_AFTERNOON + i)
      first.dateTime(SUNDAY_AFTERNOON + i)
    }
    const second = formattersFor('Pacific/Chatham')
    second.dateTime(SUNDAY_AFTERNOON)
    expect(made).toHaveBeenCalledTimes(2)
    expect(made.mock.calls.map(([, options]) => options?.timeZone)).toEqual(['Pacific/Chatham', 'Pacific/Chatham'])
  })

  it('TM-04: an unknown zone falls back to Asia/Singapore', () => {
    const unknown = formattersFor('Mars/Olympus_Mons')
    expect(unknown.dateTime(SUNDAY_AFTERNOON)).toBe('Sun 11 Oct 2026, 2:30 pm')
    expect(formattersFor('').time(SUNDAY_AFTERNOON)).toBe('2:30 pm')
  })
})
