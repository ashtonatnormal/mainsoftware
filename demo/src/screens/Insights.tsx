// People insights (ADM-14, D34, PDPA-18): counts and durations only.
import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Info } from 'lucide-react'
import { insights } from '../data/work'
import { ME, personById } from '../data/people'
import type { InsightRow } from '../types'
import { Avatar, cx, Page, Pill, SectionTitle, Segmented } from '../ui'

type Range = 'this' | 'last' | '30'
type Metric = 'messages' | 'talk' | 'rooms' | 'tasks'
type Col = 'messages' | 'reactions' | 'talkMin' | 'roomMin' | 'meetings' | 'tasksDone'

const ranges: { value: Range; label: string; caption: string }[] = [
  { value: 'this', label: 'This week', caption: 'Mon 12 Oct so far' },
  { value: 'last', label: 'Last week', caption: '5–9 Oct' },
  { value: '30', label: 'Last 30 days', caption: '12 Sep – 11 Oct' },
]

const metrics: { value: Metric; label: string; col: Col }[] = [
  { value: 'messages', label: 'Messages & reactions', col: 'messages' },
  { value: 'talk', label: 'Talk time', col: 'talkMin' },
  { value: 'rooms', label: 'Time in rooms & meetings', col: 'roomMin' },
  { value: 'tasks', label: 'Tasks completed', col: 'tasksDone' },
]

const columns: { key: Col; label: string }[] = [
  { key: 'messages', label: 'Messages' },
  { key: 'reactions', label: 'Reactions' },
  { key: 'talkMin', label: 'Talk time' },
  { key: 'roomMin', label: 'In rooms' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'tasksDone', label: 'Tasks done' },
]

/** Small, stable per-person wobble so other ranges don't look like a straight multiple. */
function wobble(id: string, salt: number) {
  let h = salt
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 997
  return 0.85 + (h % 31) / 100
}

function scaled(range: Range): InsightRow[] {
  if (range === 'last') return insights
  // "This week" is Monday morning only; "Last 30 days" is about four working weeks.
  const factor = range === 'this' ? 0.07 : 4.2
  return insights.map(r => {
    const w = (k: number) => factor * wobble(r.personId, k)
    return {
      personId: r.personId,
      messages: Math.round(r.messages * w(1)),
      reactions: Math.round(r.reactions * w(2)),
      talkMin: Math.round(r.talkMin * w(3)),
      roomMin: Math.round(r.roomMin * w(4)),
      meetings: Math.round(r.meetings * w(5)),
      tasksDone: Math.round(r.tasksDone * w(6)),
    }
  })
}

/** Minutes as "46 min" or "3.1 h". */
const time = (min: number) => (min < 60 ? `${min} min` : `${(min / 60).toFixed(1)} h`)

function valueOf(r: InsightRow, m: Metric) {
  return m === 'messages' ? r.messages + r.reactions : m === 'talk' ? r.talkMin : m === 'rooms' ? r.roomMin : r.tasksDone
}
function format(r: InsightRow, m: Metric) {
  return m === 'messages' ? String(r.messages + r.reactions) : m === 'talk' || m === 'rooms' ? time(valueOf(r, m)) : String(r.tasksDone)
}
function formatTotal(v: number, m: Metric) {
  return m === 'talk' || m === 'rooms' ? time(v) : v.toLocaleString('en-SG')
}
function detail(r: InsightRow, m: Metric) {
  if (m === 'messages') return `${r.messages} sent · ${r.reactions} reactions`
  if (m === 'rooms') return `${r.meetings} meetings attended`
  return undefined
}
const cell = (r: InsightRow, c: Col) => (c === 'talkMin' || c === 'roomMin' ? time(r[c]) : r[c].toLocaleString('en-SG'))

export default function InsightsScreen() {
  const [range, setRange] = useState<Range>('last')
  const [team, setTeam] = useState('all')
  const [metric, setMetric] = useState<Metric>('messages')
  const [sort, setSort] = useState<{ col: Col; desc: boolean }>({ col: 'messages', desc: true })

  const rows = useMemo(() => scaled(range), [range])
  const teams = useMemo(() => [...new Set(insights.map(r => personById[r.personId]?.team).filter(Boolean))].sort(), [])
  const visible = rows.filter(r => team === 'all' || personById[r.personId]?.team === team)
  const ranked = [...visible].sort((a, b) => valueOf(b, metric) - valueOf(a, metric))
  const max = Math.max(1, ...visible.map(r => valueOf(r, metric)))
  const sorted = [...visible].sort((a, b) => (sort.desc ? b[sort.col] - a[sort.col] : a[sort.col] - b[sort.col]))
  const colMax = Object.fromEntries(columns.map(c => [c.key, Math.max(1, ...visible.map(r => r[c.key]))])) as Record<Col, number>
  const metricLabel = metrics.find(m => m.value === metric)!.label
  const rangeInfo = ranges.find(r => r.value === range)!

  const chooseMetric = (m: Metric) => {
    setMetric(m)
    setSort({ col: metrics.find(x => x.value === m)!.col, desc: true })
  }

  const teamTotals = teams
    .map(t => {
      const members = rows.filter(r => personById[r.personId]?.team === t)
      return { team: t, people: members.length, total: members.reduce((n, r) => n + valueOf(r, metric), 0) }
    })
    .sort((a, b) => b.total - a.total)
  const teamMax = Math.max(1, ...teamTotals.map(t => t.total))
  const mine = rows.find(r => r.personId === ME)

  return (
    <Page wide className="max-w-6xl">
      <header className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="hidden font-display text-2xl font-semibold md:block">People insights</h1>
        <Pill tone="accent">Visible to leadership and admins</Pill>
      </header>

      <div className="mb-2 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <Segmented value={range} onChange={setRange} options={ranges.map(r => ({ value: r.value, label: r.label }))} className="flex w-full sm:inline-flex sm:w-auto [&>button]:flex-1 [&>button]:whitespace-nowrap" />
        <div className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 sm:flex">
          <Select id="ins-team" label="Team" value={team} onChange={setTeam} options={[{ value: 'all', label: 'All teams' }, ...teams.map(t => ({ value: t, label: t }))]} />
          <Select id="ins-metric" label="Metric" value={metric} onChange={v => chooseMetric(v as Metric)} options={metrics.map(m => ({ value: m.value, label: m.label }))} />
        </div>
      </div>
      <p className="mb-6 text-[12px] text-muted">{rangeInfo.label} · {rangeInfo.caption} · Example data{range !== 'last' ? ', scaled from last week' : ''}</p>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          {/* Phone: ranked list for the chosen metric */}
          <section className="lg:hidden" aria-label={`Ranked by ${metricLabel}`}>
            <SectionTitle count={ranked.length}>{metricLabel}</SectionTitle>
            <ol className="divide-y divide-line border-y border-line">
              {ranked.map((r, i) => {
                const p = personById[r.personId]
                const v = valueOf(r, metric)
                return (
                  <li key={r.personId} className="flex items-center gap-3 py-3" title={`${p.name}: ${format(r, metric)}`}>
                    <span className="w-5 shrink-0 text-right text-[13px] font-semibold text-muted tabular">{i + 1}</span>
                    <Avatar id={r.personId} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{p.name}{r.personId === ME && <span className="text-muted"> (you)</span>}</span>
                        <span className="shrink-0 text-[15px] font-semibold tabular">{format(r, metric)}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <Bar value={v} max={max} />
                      </div>
                      <p className="mt-1 truncate text-[12px] text-muted">{p.team}{detail(r, metric) ? ` · ${detail(r, metric)}` : ''}</p>
                    </div>
                  </li>
                )
              })}
            </ol>
          </section>

          {/* Desktop: all metrics, sortable */}
          <section className="hidden lg:block" aria-label="All metrics">
            <SectionTitle count={sorted.length}>Everyone</SectionTitle>
            <table className="w-full table-fixed border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-muted">
                  <th scope="col" className="w-10 py-2 font-medium">#</th>
                  <th scope="col" className="py-2 font-medium">Person</th>
                  {columns.map(c => {
                    const active = sort.col === c.key
                    return (
                      <th key={c.key} scope="col" aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'} className="w-[12%] py-2 text-right font-medium whitespace-nowrap">
                        <button
                          onClick={() => setSort(s => ({ col: c.key, desc: s.col === c.key ? !s.desc : true }))}
                          className={cx('inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-fg', active && 'text-fg')}
                        >
                          {c.label}
                          {active ? sort.desc ? <ArrowDown size={12} aria-hidden /> : <ArrowUp size={12} aria-hidden /> : <span className="w-3" />}
                        </button>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sorted.map((r, i) => {
                  const p = personById[r.personId]
                  return (
                    <tr key={r.personId} className={cx('hover:bg-surface-2/60', r.personId === ME && 'bg-accent-soft/40')}>
                      <td className="py-2.5 text-muted tabular">{i + 1}</td>
                      <td className="py-2.5 pr-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <Avatar id={r.personId} size="sm" />
                          <div className="min-w-0">
                            <p className="truncate font-medium">{p.name}{r.personId === ME && <span className="text-muted"> (you)</span>}</p>
                            <p className="truncate text-[12px] text-muted">{p.team}</p>
                          </div>
                        </div>
                      </td>
                      {columns.map(c => (
                        <td key={c.key} className="py-2.5 pl-2 text-right tabular" title={`${p.name} · ${columns.find(x => x.key === c.key)!.label}: ${cell(r, c.key)}`}>
                          <span className={cx(sort.col === c.key ? 'font-semibold' : 'text-fg')}>{cell(r, c.key)}</span>
                          {sort.col === c.key && (
                            <span className="mt-1 flex justify-end">
                              <Bar value={r[c.key]} max={colMax[c.key]} className="w-full max-w-24" />
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-8">
          {mine && (
            <section aria-label="Your own figures" className="rounded-2xl border border-line bg-surface p-4">
              <div className="mb-3 flex items-center gap-3">
                <Avatar id={ME} size="md" />
                <div className="min-w-0">
                  <p className="font-display text-[15px] font-semibold">Your own figures</p>
                  <p className="text-[12px] text-muted">Everyone can see their own</p>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Messages', v: mine.messages.toLocaleString('en-SG'), sub: `${mine.reactions} reactions` },
                  { label: 'Talk time', v: time(mine.talkMin), sub: 'from your own mic' },
                  { label: 'In rooms', v: time(mine.roomMin), sub: `${mine.meetings} meetings` },
                  { label: 'Tasks done', v: String(mine.tasksDone), sub: rangeInfo.label.toLowerCase() },
                ].map(s => (
                  <div key={s.label} className="rounded-xl bg-surface-2 px-3 py-2.5">
                    <dt className="text-[12px] text-muted">{s.label}</dt>
                    <dd className="font-display text-xl font-semibold tabular">{s.v}</dd>
                    <dd className="truncate text-[11px] text-muted">{s.sub}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <section aria-label="Team totals">
            <SectionTitle>Team totals · {metricLabel}</SectionTitle>
            <ul className="divide-y divide-line border-y border-line">
              {teamTotals.map(t => (
                <li key={t.team}>
                  <button onClick={() => setTeam(x => (x === t.team ? 'all' : t.team))} aria-pressed={team === t.team} className={cx('w-full px-1 py-2.5 text-left transition hover:bg-surface-2', team === t.team && 'bg-accent-soft/50')}>
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.team}</span>
                      <span className="text-[12px] text-muted">{t.people} {t.people === 1 ? 'person' : 'people'}</span>
                      <span className="w-16 text-right text-sm font-semibold tabular">{formatTotal(t.total, metric)}</span>
                    </span>
                    <Bar value={t.total} max={teamMax} className="mt-1.5" />
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-muted">Tap a team to filter the list.</p>
          </section>

          <section className="flex gap-3 rounded-2xl bg-surface-2 p-4 text-[13px]" aria-label="About these figures">
            <Info size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden />
            <p className="text-muted">
              <span className="font-medium text-fg">Counts and durations only — the AI never scores what people say.</span> Talk time can be wrong when people share a meeting-room device or there’s background noise. Restricted rooms are excluded. Every view of a person’s figures is logged.
            </p>
          </section>
        </aside>
      </div>
    </Page>
  )
}

/** Horizontal bar drawn to scale: accent fill on a surface-2 track, rounded data end. */
function Bar({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = Math.max(2, (value / max) * 100)
  return (
    <span className={cx('block h-1.5 w-full overflow-hidden rounded-full bg-surface-2', className)} aria-hidden>
      <span className="block h-full rounded-full bg-accent transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
    </span>
  )
}

// The app-wide :focus-visible outline in index.css sits outside Tailwind's layers, so it
// beats outline-none and rounded-*: it would draw a second ring and square the corners.
// The select draws their own focus ring override it with important (!) utilities.
function Select({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">{label}</label>
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-9 w-full min-w-0 rounded-full! border border-line bg-surface px-3 text-[13px] font-medium text-fg outline-hidden! focus:ring-2 focus:ring-accent"
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}
