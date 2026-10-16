// Five-field cron, in UTC (TECH-SPEC T15 item 13): minute (0-59), hour (0-23), day of the month
// (1-31), month (1-12) and day of the week (0-7, Sunday being 0 or 7). Each field is a list of `*`,
// a number or a range a-b, any of them with a step (/n), where a number with a step runs to the
// field's end (5/15 is 5-59/15). No names, and none of L, W, # or ?. Its own evaluator rather than
// a dependency: Hearth's schedules are few and fixed in code (jobs/maintenance.ts), and the
// occurrences come from the database's clock, which the scheduler passes in.
//
// The day of the month and the day of the week follow cron's old rule: when both are restricted
// (neither starts with *), a day matching either counts; otherwise both must match, so `*` in one
// leaves the other to decide.

export interface Cron {
  readonly expression: string
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly days: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  // 0-6, Sunday 0.
  readonly weekdays: ReadonlySet<number>
  readonly daysStar: boolean
  readonly weekdaysStar: boolean
}

const MINUTE = 60_000
// How far ahead (or back) an occurrence is looked for before an expression counts as impossible.
const SEARCH_MS = 5 * 366 * 24 * 60 * MINUTE

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of the month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of the week', min: 0, max: 7 },
] as const

// One field's values, or a message saying what is wrong with it.
function parseField(text: string, field: (typeof FIELDS)[number]): Set<number> {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const match = /^(?:(\*)|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part)
    if (!match) throw new Error(`cron: the ${field.name} field has a part cron can't read: ${part}`)
    const [, star, from, to, stepText] = match
    const step = stepText === undefined ? 1 : Number(stepText)
    const low = star !== undefined ? field.min : Number(from)
    const high =
      star !== undefined ? field.max : to !== undefined ? Number(to) : stepText !== undefined ? field.max : low
    if (low < field.min || high > field.max || low > high || step < 1) {
      throw new Error(`cron: the ${field.name} field must stay within ${field.min}-${field.max}: ${part}`)
    }
    for (let value = low; value <= high; value += step) values.add(value)
  }
  return values
}

export function parseCron(expression: string): Cron {
  const parts = expression.split(' ')
  if (parts.length !== 5 || parts.some(part => part === '')) {
    throw new Error(`cron: an expression has five fields separated by single spaces: ${expression}`)
  }
  const [minutes, hours, days, months, weekdays] = FIELDS.map((field, i) => parseField(parts[i] ?? '', field)) as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ]
  // Sunday is 0 or 7.
  if (weekdays.delete(7)) weekdays.add(0)
  return {
    expression,
    minutes,
    hours,
    days,
    months,
    weekdays,
    daysStar: (parts[2] ?? '').startsWith('*'),
    weekdaysStar: (parts[4] ?? '').startsWith('*'),
  }
}

function dayMatches(cron: Cron, at: Date): boolean {
  const day = cron.days.has(at.getUTCDate())
  const weekday = cron.weekdays.has(at.getUTCDay())
  return cron.daysStar || cron.weekdaysStar ? day && weekday : day || weekday
}

// The first matching minute strictly after `after`. Throws if none comes within 5 years (an
// impossible expression, such as the 31st of February).
export function nextAfter(cron: Cron, after: Date): Date {
  const start = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE
  const limit = after.getTime() + SEARCH_MS
  let t = new Date(start)
  while (t.getTime() <= limit) {
    const [y, m, d, h] = [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours()]
    if (!cron.months.has(m + 1)) t = new Date(Date.UTC(y, m + 1, 1))
    else if (!dayMatches(cron, t)) t = new Date(Date.UTC(y, m, d + 1))
    else if (!cron.hours.has(h)) t = new Date(Date.UTC(y, m, d, h + 1))
    else if (!cron.minutes.has(t.getUTCMinutes())) t = new Date(t.getTime() + MINUTE)
    else return t
  }
  throw new Error(`cron: ${cron.expression} never matches within 5 years`)
}

// The last matching minute at or before `at`. Throws if none came within 5 years.
export function previousAtOrBefore(cron: Cron, at: Date): Date {
  const limit = at.getTime() - SEARCH_MS
  let t = new Date(Math.floor(at.getTime() / MINUTE) * MINUTE)
  while (t.getTime() >= limit) {
    const [y, m, d, h] = [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours()]
    // Each jump lands on the last minute before the unit that didn't match.
    if (!cron.months.has(m + 1)) t = new Date(Date.UTC(y, m, 1) - MINUTE)
    else if (!dayMatches(cron, t)) t = new Date(Date.UTC(y, m, d) - MINUTE)
    else if (!cron.hours.has(h)) t = new Date(Date.UTC(y, m, d, h) - MINUTE)
    else if (!cron.minutes.has(t.getUTCMinutes())) t = new Date(t.getTime() - MINUTE)
    else return t
  }
  throw new Error(`cron: ${cron.expression} never matched within 5 years`)
}
