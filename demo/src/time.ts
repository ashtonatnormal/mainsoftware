// The demo runs at a fixed moment so its story stays coherent:
// Monday 12 October 2026, 8:42 AM in Singapore.
export const NOW = Date.parse('2026-10-12T08:42:00+08:00')
const TZ = 'Asia/Singapore'

export const at = (iso: string) => Date.parse(`${iso}+08:00`)
export const minutesAgo = (m: number) => NOW - m * 60_000

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-SG', { timeZone: TZ, ...opts })
const timeFmt = fmt({ hour: 'numeric', minute: '2-digit', hour12: true })
const dayFmt = fmt({ weekday: 'short', day: 'numeric', month: 'short' })
const weekdayFmt = fmt({ weekday: 'short' })
const longDayFmt = fmt({ weekday: 'long', day: 'numeric', month: 'long' })

const dayKey = (ms: number) => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)

/** "8:42 am" */
export const clock = (ms: number) => timeFmt.format(ms).replace(/[\u202f\u00a0]/g, ' ').toLowerCase()
/** "Mon 12 Oct" */
export const shortDay = (ms: number) => dayFmt.format(ms)
/** "Monday 12 October" */
export const longDay = (ms: number) => longDayFmt.format(ms)

export function isToday(ms: number) {
  return dayKey(ms) === dayKey(NOW)
}

export function isYesterday(ms: number) {
  return dayKey(ms) === dayKey(NOW - 86_400_000)
}

/** Chat-list style stamp: "8:42 am", "Yesterday", "Fri", "9 Oct" */
export function listStamp(ms: number) {
  if (isToday(ms)) return clock(ms)
  if (isYesterday(ms)) return 'Yesterday'
  if (NOW - ms < 6 * 86_400_000) return weekdayFmt.format(ms)
  return fmt({ day: 'numeric', month: 'short' }).format(ms)
}

/** Day separator in a conversation: "Today", "Yesterday", "Fri 9 Oct" */
export function dayLabel(ms: number) {
  if (isToday(ms)) return 'Today'
  if (isYesterday(ms)) return 'Yesterday'
  return shortDay(ms)
}

export function sameDay(a: number, b: number) {
  return dayKey(a) === dayKey(b)
}

/** "0:42", "12:05", "1:02:10" */
export function duration(sec: number) {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`
}

/** "12 min", "1 h 05 min" */
export function minutesLabel(sec: number) {
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/** "in 18 min", "2 h ago" */
export function relative(ms: number) {
  const diff = Math.round((ms - NOW) / 60_000)
  const abs = Math.abs(diff)
  const unit = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`
  if (abs < 1) return 'now'
  return diff > 0 ? `in ${unit}` : `${unit} ago`
}
