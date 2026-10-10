// Tasks (TASK-01..09): my tasks grouped by when they're due, suggestions from
// meetings and the assistant (nothing becomes a task until accepted, TASK-06),
// and a team view with a board on desktop.
import { useEffect, useState, type FormEvent } from 'react'
import { AlertCircle, Check, ChevronDown, ChevronRight, Columns3, List, MessageSquare, Mic, Pencil, Plus, Sparkles, User, X } from 'lucide-react'
import type { SuggestedTask, Task, TaskSource, TaskStatus } from '../types'
import { useStore } from '../store'
import { ME } from '../data/people'
import { AIMarker, Avatar, AvatarStack, Button, cx, EmptyState, personName, personShort, Pill, Segmented } from '../ui'

type Group = 'today' | 'week' | 'later'

// The demo week runs Mon 12 – Sun 18 Oct 2026; due labels are display strings
// ("Today 12:00 pm", "Tue 13 Oct"), so dates are compared as month * 100 + day.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEK_START = 9 * 100 + 12
const WEEK_END = 9 * 100 + 18

function dueOrdinal(due: string) {
  const m = due.match(/(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)/)
  return m ? MONTHS.indexOf(m[2].slice(0, 3)) * 100 + Number(m[1]) : undefined
}

function isOverdue(t: Task) {
  if (t.status === 'done' || !t.due) return false
  if (t.overdue || t.due.startsWith('Yesterday')) return true
  const d = dueOrdinal(t.due)
  return d !== undefined && d < WEEK_START
}

function groupOf(t: Task): Group {
  if (!t.due) return 'later'
  if (isOverdue(t) || t.due.startsWith('Today')) return 'today'
  const d = dueOrdinal(t.due)
  if (d !== undefined && d <= WEEK_END) return 'week'
  return 'later'
}

const groupLabels: Record<Group, string> = { today: 'Today', week: 'This week', later: 'Later' }
const statusLabel: Record<TaskStatus, string> = { todo: 'To do', doing: 'In progress', done: 'Done' }
const sourceIcons = { meeting: Mic, message: MessageSquare, assistant: Sparkles, manual: User }

function useWide() {
  const q = '(min-width: 768px)'
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

export default function TasksScreen() {
  const { state } = useStore()
  const [view, setView] = useState<'mine' | 'team'>('mine')
  const mineOpen = state.tasks.filter(t => t.assigneeIds.includes(ME))

  return (
    <div className="h-full overflow-y-auto">
      <div className={cx('mx-auto w-full px-4 py-5 sm:px-6', view === 'team' ? 'max-w-6xl' : 'max-w-3xl')}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="hidden font-display text-2xl font-semibold md:block">Tasks</h1>
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'mine', label: `My tasks · ${mineOpen.filter(t => t.status !== 'done').length}` },
              { value: 'team', label: 'Team' },
            ]}
          />
        </div>
        <QuickAdd />
        {view === 'mine' ? <MyTasks /> : <TeamTasks />}
      </div>
    </div>
  )
}

function QuickAdd() {
  const { addTask, toast } = useStore()
  const [text, setText] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const title = text.trim()
    if (!title) return
    addTask(title)
    setText('')
    toast('Added to My tasks')
  }
  return (
    <form onSubmit={submit} className="mb-6 flex items-center gap-2 rounded-full border border-line bg-surface py-1 pr-1 pl-4 focus-within:ring-2 focus-within:ring-accent">
      <Plus size={18} className="shrink-0 text-muted" aria-hidden />
      <label htmlFor="task-quick-add" className="sr-only">Add a task</label>
      <input id="task-quick-add" value={text} onChange={e => setText(e.target.value)} placeholder="Add a task…" className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] outline-none placeholder:text-muted" />
      <Button type="submit" size="sm" variant="primary" disabled={!text.trim()}>Add</Button>
    </form>
  )
}

// ── My tasks ──────────────────────────────────────────────────────────────────
function MyTasks() {
  const { state } = useStore()
  const [showDone, setShowDone] = useState(false)
  const mine = state.tasks.filter(t => t.assigneeIds.includes(ME))
  const open = mine.filter(t => t.status !== 'done')
  const done = mine.filter(t => t.status === 'done')
  const groups = (['today', 'week', 'later'] as Group[]).map(g => ({ g, items: open.filter(t => groupOf(t) === g) })).filter(x => x.items.length)

  return (
    <div className="flex flex-col gap-7">
      {state.suggested.length > 0 && <Suggested />}

      {groups.length === 0 && <EmptyState icon={<Check size={28} />} title="Nothing on your list" body="Tasks you add or accept from meetings show up here." />}

      {groups.map(({ g, items }) => (
        <section key={g} aria-labelledby={`tg-${g}`}>
          <h2 id={`tg-${g}`} className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
            {groupLabels[g]} <span className="tabular text-fg">{items.length}</span>
          </h2>
          <ul className="divide-y divide-line border-y border-line">
            {items.map(t => <TaskRow key={t.id} task={t} />)}
          </ul>
        </section>
      ))}

      {done.length > 0 && (
        <section>
          <button onClick={() => setShowDone(s => !s)} aria-expanded={showDone} className="mb-1 flex items-center gap-1 rounded-md text-[11px] font-bold uppercase tracking-[0.08em] text-muted hover:text-fg">
            {showDone ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Done <span className="tabular text-fg">{done.length}</span>
          </button>
          {showDone && (
            <ul className="divide-y divide-line border-y border-line">
              {done.map(t => <TaskRow key={t.id} task={t} />)}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

function Suggested() {
  const { state } = useStore()
  return (
    <section aria-labelledby="tg-suggested" className="rounded-2xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <h2 id="tg-suggested" className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Suggested for you</h2>
        <AIMarker />
      </div>
      <p className="px-4 pt-1 pb-2 text-xs text-muted">From meetings and your assistant. Nothing becomes a task until you accept it.</p>
      <ul className="divide-y divide-line border-t border-line">
        {state.suggested.map(s => <SuggestedRow key={s.id} item={s} />)}
      </ul>
    </section>
  )
}

function SuggestedRow({ item }: { item: SuggestedTask }) {
  const { acceptSuggested, dismissSuggested } = useStore()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(item.title)
  const [due, setDue] = useState(item.due ?? '')

  if (editing) {
    return (
      <li className="anim-in px-4 py-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={e => {
            e.preventDefault()
            acceptSuggested(item.id, { title: title.trim() || item.title, due: due.trim() || undefined })
          }}
        >
          <label htmlFor={`sg-title-${item.id}`} className="text-xs font-medium text-muted">Task</label>
          <input id={`sg-title-${item.id}`} value={title} onChange={e => setTitle(e.target.value)} className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-[15px] outline-none focus:ring-2 focus:ring-accent" />
          <label htmlFor={`sg-due-${item.id}`} className="text-xs font-medium text-muted">Due</label>
          <input id={`sg-due-${item.id}`} value={due} onChange={e => setDue(e.target.value)} placeholder="e.g. Fri 16 Oct" className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-[15px] outline-none focus:ring-2 focus:ring-accent sm:max-w-48" />
          <div className="mt-1 flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" icon={<Check size={14} />}>Accept with changes</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      </li>
    )
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{item.title}</p>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {item.due && <span>Due {item.due}</span>}
          <SourceChip source={item.source} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={() => acceptSuggested(item.id)}>Accept</Button>
        <Button size="sm" variant="secondary" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>Edit</Button>
        <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => dismissSuggested(item.id)}>Dismiss</Button>
      </div>
    </li>
  )
}

function SourceChip({ source }: { source?: TaskSource }) {
  const { navigate } = useStore()
  if (!source) return null
  const Icon = sourceIcons[source.kind]
  const body = (
    <>
      <Icon size={12} className="shrink-0" aria-hidden />
      <span className="truncate">{source.label}</span>
    </>
  )
  const cls = 'inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted'
  return source.route ? (
    <button onClick={() => navigate(source.route!)} className={cx(cls, 'transition hover:text-fg')}>{body}</button>
  ) : (
    <span className={cls}>{body}</span>
  )
}

function Checkbox({ task }: { task: Task }) {
  const { setTaskStatus, toast } = useStore()
  const done = task.status === 'done'
  return (
    <button
      role="checkbox"
      aria-checked={done}
      aria-label={done ? `Mark “${task.title}” as not done` : `Mark “${task.title}” as done`}
      onClick={() => {
        setTaskStatus(task.id, done ? 'todo' : 'done')
        if (!done) toast('Marked as done')
      }}
      className={cx('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border-2 transition', done ? 'border-ok bg-ok text-white' : 'border-muted hover:border-accent')}
    >
      {done && <Check size={14} strokeWidth={3} />}
    </button>
  )
}

function DueLabel({ task }: { task: Task }) {
  if (!task.due) return null
  if (task.status === 'done') return <span>{task.due}</span>
  if (isOverdue(task)) return <span className="inline-flex items-center gap-1 font-semibold text-rec"><AlertCircle size={12} aria-hidden />Overdue · {task.due}</span>
  if (task.due.startsWith('Today')) return <span className="font-semibold text-accent-ink">{task.due}</span>
  return <span>{task.due}</span>
}

function TaskRow({ task, showAssignees }: { task: Task; showAssignees?: boolean }) {
  const done = task.status === 'done'
  const others = task.assigneeIds.filter(id => id !== ME)
  return (
    <li className="flex items-start gap-3 py-3">
      <Checkbox task={task} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p className={cx('min-w-0 flex-1', done && 'text-muted line-through')}>
            {task.priority === 'high' && !done && <span className="mr-1.5 inline-flex translate-y-[-1px] items-center rounded bg-rec-soft px-1 text-[10px] font-bold uppercase tracking-wide text-rec">High</span>}
            {task.title}
          </p>
          {(showAssignees ? task.assigneeIds : others).length > 0 && <AvatarStack ids={showAssignees ? task.assigneeIds : others} max={3} size="xs" />}
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <DueLabel task={task} />
          {task.status === 'doing' && <Pill tone="accent">In progress</Pill>}
          <SourceChip source={task.source} />
          {!!task.comments && (
            <span className="inline-flex items-center gap-1" aria-label={`${task.comments} comments`}><MessageSquare size={12} aria-hidden />{task.comments}</span>
          )}
        </div>
      </div>
    </li>
  )
}

// ── Team ──────────────────────────────────────────────────────────────────────
function TeamTasks() {
  const { state } = useStore()
  const wide = useWide()
  const [layout, setLayout] = useState<'list' | 'board'>('list')
  const teams = [...new Set(state.tasks.map(t => t.team ?? 'Other'))].sort()
  const board = wide && layout === 'board'

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{state.tasks.length} tasks across {teams.length} teams</p>
        {wide && (
          <Segmented
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'list', label: <span className="inline-flex items-center gap-1.5"><List size={14} aria-hidden />List</span> },
              { value: 'board', label: <span className="inline-flex items-center gap-1.5"><Columns3 size={14} aria-hidden />Board</span> },
            ]}
          />
        )}
      </div>

      {board ? (
        <div className="grid grid-cols-3 gap-4">
          {(['todo', 'doing', 'done'] as TaskStatus[]).map(st => {
            const items = state.tasks.filter(t => t.status === st)
            return (
              <section key={st} className="flex min-w-0 flex-col gap-2 rounded-2xl bg-surface-2 p-3">
                <h2 className="flex items-center gap-2 px-1 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
                  {statusLabel[st]} <span className="tabular text-fg">{items.length}</span>
                </h2>
                {items.map(t => <BoardCard key={t.id} task={t} />)}
                {!items.length && <p className="px-1 py-4 text-center text-xs text-muted">Nothing here</p>}
              </section>
            )
          })}
        </div>
      ) : (
        teams.map(team => {
          const items = state.tasks.filter(t => (t.team ?? 'Other') === team)
          return (
            <section key={team}>
              <h2 className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
                {team} <span className="tabular text-fg">{items.length}</span>
              </h2>
              <ul className="divide-y divide-line border-y border-line">
                {items.map(t => <TeamRow key={t.id} task={t} />)}
              </ul>
            </section>
          )
        })
      )}
    </div>
  )
}

function TeamRow({ task }: { task: Task }) {
  const done = task.status === 'done'
  return (
    <li className="flex items-center gap-3 py-2.5">
      <AvatarStack ids={task.assigneeIds} max={2} size="sm" />
      <div className="min-w-0 flex-1">
        <p className={cx(done && 'text-muted line-through')}>{task.title}</p>
        <p className="truncate text-xs text-muted">
          {task.assigneeIds.map(id => (id === ME ? 'You' : (task.assigneeIds.length > 1 ? personShort(id) : personName(id)))).join(' and ')}
          {task.due && <> · <DueLabel task={task} /></>}
        </p>
      </div>
      <StatusPill status={task.status} />
    </li>
  )
}

function StatusPill({ status }: { status: TaskStatus }) {
  return <Pill tone={status === 'done' ? 'ok' : status === 'doing' ? 'accent' : 'neutral'}>{statusLabel[status]}</Pill>
}

function BoardCard({ task }: { task: Task }) {
  const done = task.status === 'done'
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
      <p className={cx('text-sm', done && 'text-muted line-through')}>
        {task.priority === 'high' && !done && <span className="mr-1.5 rounded bg-rec-soft px-1 text-[10px] font-bold uppercase tracking-wide text-rec">High</span>}
        {task.title}
      </p>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
        <span className="flex shrink-0 -space-x-1.5">{task.assigneeIds.map(id => <Avatar key={id} id={id} size="xs" className="rounded-full ring-2 ring-surface" />)}</span>
        <span className="min-w-0 truncate">{task.team}</span>
        <span className="ml-auto shrink-0"><DueLabel task={task} /></span>
      </div>
    </div>
  )
}
