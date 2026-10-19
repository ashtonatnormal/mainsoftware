// Dates and times on screen (T21; X14, SHL-13, OD-10). The model holds a time only as epoch
// milliseconds; it becomes text at render, in the viewer's zone (their profile's, else the org's,
// from GET /api/session), never as a stored string. The style is day first, with a 12-hour clock:
// 'Sun 11 Oct 2026', '2:30 pm', 'Sun 11 Oct 2026, 2:30 pm'.
//
// Building an Intl.DateTimeFormat is slow, so there is one per zone and kind, made on first use and
// kept in a module Map that holds zone names only (SHL-13). The text is assembled from
// formatToParts, not format(): engines disagree on en-GB's punctuation ('Sun, 11 Oct' or
// 'Sun 11 Oct') and on the day period's case, and hourCycle h12 (not hour12, which some engines
// read as h11 for en-GB and print 0:05) keeps midnight as 12. Nothing in C0.8 shows a time yet;
// C1 is the first caller.
import { DEFAULT_TIME_ZONE } from '@hearth/shared'

export type EpochMs = number

export interface Formatters {
  date(ms: EpochMs): string
  time(ms: EpochMs): string
  dateTime(ms: EpochMs): string
}

type Kind = 'date' | 'time'

const OPTIONS: Record<Kind, Intl.DateTimeFormatOptions> = {
  date: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' },
  time: { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' },
}

const cache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string, kind: Kind): Intl.DateTimeFormat {
  const key = `${kind} ${timeZone}`
  let formatter = cache.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { ...OPTIONS[kind], timeZone })
    cache.set(key, formatter)
  }
  return formatter
}

// The zone if this browser knows it, else Singapore's: a zone name from an older tz database, or a
// typo in a profile, must not stop the screen rendering.
function knownZone(timeZone: string): string {
  try {
    formatterFor(timeZone, 'date')
    return timeZone
  } catch (error) {
    if (error instanceof RangeError) return DEFAULT_TIME_ZONE
    throw error
  }
}

function partsOf(formatter: Intl.DateTimeFormat, ms: EpochMs): Map<string, string> {
  return new Map(formatter.formatToParts(ms).map(part => [part.type, part.value]))
}

export function formattersFor(timeZone: string): Formatters {
  const zone = knownZone(timeZone)
  const date = (ms: EpochMs) => {
    const parts = partsOf(formatterFor(zone, 'date'), ms)
    return [parts.get('weekday'), parts.get('day'), parts.get('month'), parts.get('year')].join(' ')
  }
  const time = (ms: EpochMs) => {
    const parts = partsOf(formatterFor(zone, 'time'), ms)
    return `${parts.get('hour')}:${parts.get('minute')} ${parts.get('dayPeriod')?.toLocaleLowerCase('en-GB')}`
  }
  return { date, time, dateTime: ms => `${date(ms)}, ${time(ms)}` }
}
