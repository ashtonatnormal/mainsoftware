// Settings — the avatar menu (§6.1): notifications, devices, assistant memory,
// privacy and your data, appearance, help.
import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { ArrowLeft, Bell, Brain, ChevronRight, CircleHelp, FileText, Laptop, LifeBuoy, Monitor, Moon, Palette, Pencil, RotateCcw, ShieldCheck, Smartphone, Sun, Tablet, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { ME, personById } from '../data/people'
import { AIMarker, Avatar, Button, cx, EmptyState, IconButton, Pill, Segmented, Sheet } from '../ui'
import type { Route } from '../types'
import { ACK_RECORD, DPO_NAME, NOTICE_DATE, NOTICE_VERSION, noticeSections } from './onboarding/notice'

type RouteSection = NonNullable<Extract<Route, { name: 'settings' }>['section']>
type SectionKey = RouteSection | 'appearance' | 'help'

const sections: { key: SectionKey; label: string; hint: string; icon: ComponentType<{ size?: number; className?: string }> }[] = [
  { key: 'notifications', label: 'Notifications', hint: 'Messages, mentions, quiet hours', icon: Bell },
  { key: 'devices', label: 'Devices', hint: '3 signed in', icon: Smartphone },
  { key: 'memory', label: 'Assistant memory', hint: 'What your assistant remembers', icon: Brain },
  { key: 'privacy', label: 'Privacy and your data', hint: 'Notice, requests, DPO contact', icon: ShieldCheck },
  { key: 'appearance', label: 'Appearance', hint: 'System, light or dark', icon: Palette },
  { key: 'help', label: 'Help', hint: 'How-tos and reporting a problem', icon: CircleHelp },
]

export default function SettingsScreen() {
  const { state, navigate } = useStore()
  const routeSection = state.route.name === 'settings' ? state.route.section : undefined
  const [open, setOpen] = useState<SectionKey | undefined>(routeSection)
  useEffect(() => {
    if (routeSection) setOpen(routeSection)
  }, [routeSection])

  const select = (key: SectionKey) => {
    setOpen(key)
    if (key === 'appearance' || key === 'help') {
      if (routeSection) navigate({ name: 'settings' }, { replace: true })
    } else navigate({ name: 'settings', section: key }, { replace: !!routeSection })
  }
  const close = () => {
    setOpen(undefined)
    if (routeSection) navigate({ name: 'settings' }, { replace: true })
  }
  // Desktop always shows a detail pane; phones show the list or one section.
  const shown: SectionKey = open ?? 'notifications'

  return (
    <div className="flex h-full">
      <aside className={cx('h-full w-full shrink-0 overflow-y-auto border-line md:w-80 md:border-r md:bg-surface', open ? 'hidden md:block' : 'block')}>
        <div className="mx-auto max-w-3xl px-4 py-5 md:px-3">
          <Profile />
          <nav aria-label="Settings sections" className="mt-5 overflow-hidden rounded-2xl border border-line bg-surface md:rounded-none md:border-0 md:bg-transparent">
            <ul className="divide-y divide-line md:divide-y-0">
              {sections.map(s => {
                const active = shown === s.key
                return (
                  <li key={s.key}>
                    <button
                      onClick={() => select(s.key)}
                      aria-current={open === s.key ? 'page' : undefined}
                      className={cx('flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-2 md:rounded-xl md:px-3 md:py-2.5', active && 'md:bg-surface-2')}
                    >
                      <span className={cx('grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2', active ? 'text-accent-ink md:bg-accent-soft' : 'text-muted')}>
                        <s.icon size={18} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium">{s.label}</span>
                        <span className="block truncate text-[13px] text-muted">{s.hint}</span>
                      </span>
                      <ChevronRight size={18} className="shrink-0 text-muted md:hidden" aria-hidden />
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>
          <div className="mt-5 px-1 md:px-3">
            <ReplayIntro />
          </div>
        </div>
      </aside>

      <section className={cx('h-full min-w-0 flex-1 flex-col', open ? 'flex' : 'hidden md:flex')} aria-label={sections.find(s => s.key === shown)?.label}>
        <div className="flex items-center gap-1 border-b border-line bg-surface px-2 py-2 md:hidden">
          <IconButton label="Back to settings" onClick={close}><ArrowLeft size={20} /></IconButton>
          <h1 className="truncate font-display text-lg font-semibold">{sections.find(s => s.key === shown)?.label}</h1>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div key={shown} className="mx-auto w-full max-w-2xl px-4 py-5 sm:px-6 md:py-8">
            <h1 className="mb-5 hidden font-display text-2xl font-semibold md:block">{sections.find(s => s.key === shown)?.label}</h1>
            {shown === 'notifications' && <Notifications />}
            {shown === 'devices' && <Devices />}
            {shown === 'memory' && <MemorySection />}
            {shown === 'privacy' && <Privacy />}
            {shown === 'appearance' && <Appearance />}
            {shown === 'help' && <Help />}
          </div>
        </div>
      </section>
    </div>
  )
}

// The app-wide :focus-visible outline in index.css sits outside Tailwind's layers, so it
// beats outline-none and rounded-*: it would draw a second ring and square the corners.
// Fields that draw their own focus ring override it with important (!) utilities.
const fieldClass = 'w-full resize-none rounded-xl! bg-surface-2 px-3 py-2 text-[15px] outline-hidden! placeholder:text-muted focus:ring-2 focus:ring-accent'

// ── Pieces ───────────────────────────────────────────────────────────────────
function Profile() {
  const { toast } = useStore()
  const me = personById[ME]
  return (
    <div className="flex items-center gap-4 px-1 md:flex-col md:items-start md:px-3">
      <Avatar id={ME} size="xl" status />
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-xl font-semibold">{me.name}</p>
        <p className="truncate text-sm text-muted">{me.title}</p>
        <p className="mt-1 flex items-center gap-1.5 text-[13px]">
          <span className="size-2 rounded-full bg-ok" aria-hidden /> Online
          <span className="text-muted">·</span>
          <button onClick={() => toast('Status editing comes later in the demo')} className="min-w-0 truncate text-accent-ink hover:underline">Focused on the Q4 launch</button>
        </p>
      </div>
    </div>
  )
}

function Switch({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx('relative h-7 w-12 shrink-0 rounded-full transition', checked ? 'bg-accent' : 'bg-line')}
    >
      <span className={cx('absolute top-1 left-1 size-5 rounded-full bg-white shadow-card transition-transform', checked && 'translate-x-5')} />
    </button>
  )
}

function Row({ title, body, children, icon }: { title: ReactNode; body?: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-3">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-medium">{title}</div>
        {body && <div className="text-[13px] text-muted">{body}</div>}
      </div>
      {children}
    </li>
  )
}

function Group({ title, children, note }: { title?: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="mb-6">
      {title && <h2 className="mb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">{title}</h2>}
      <ul className="divide-y divide-line border-y border-line">{children}</ul>
      {note && <p className="mt-2 text-[13px] text-muted">{note}</p>}
    </div>
  )
}

// ── Notifications (NOTIF-03) ─────────────────────────────────────────────────
function Notifications() {
  const [on, setOn] = useState({ dms: true, mentions: true, threads: true, meetings: true, nudges: false, quiet: true })
  const set = (k: keyof typeof on) => (v: boolean) => setOn(o => ({ ...o, [k]: v }))
  const items: { k: keyof typeof on; title: string; body: string }[] = [
    { k: 'dms', title: 'Direct messages', body: 'Every message sent to you' },
    { k: 'mentions', title: 'Mentions', body: 'When someone @mentions you or your team' },
    { k: 'threads', title: 'Thread replies', body: 'Replies in threads you’re part of' },
    { k: 'meetings', title: 'Meeting starting', body: '1 minute before, with a Join button' },
    { k: 'nudges', title: 'Assistant nudges', body: 'Reminders about replies and prep from your assistant' },
  ]
  return (
    <>
      <Group title="Notify me about">
        {items.map(i => (
          <Row key={i.k} title={<label htmlFor={`n-${i.k}`}>{i.title}</label>} body={i.body}>
            <Switch id={`n-${i.k}`} label={i.title} checked={on[i.k]} onChange={set(i.k)} />
          </Row>
        ))}
      </Group>
      <Group title="Quiet hours" note={on.quiet ? 'Calls from your manager and urgent @here posts still come through.' : undefined}>
        <Row title={<label htmlFor="n-quiet">Quiet hours</label>} body={on.quiet ? '6:00 pm – 8:30 am, and weekends' : 'Off'}>
          <Switch id="n-quiet" label="Quiet hours" checked={on.quiet} onChange={set('quiet')} />
        </Row>
      </Group>
    </>
  )
}

// ── Devices (ACC-04) ─────────────────────────────────────────────────────────
function Devices() {
  const { toast } = useStore()
  const [devices, setDevices] = useState([
    { id: 'iphone', name: 'iPhone 15', detail: 'This device · Singapore', icon: Smartphone, current: true },
    { id: 'mac', name: 'MacBook Air · Chrome', detail: 'Active today, 8:15 am', icon: Laptop, current: false },
    { id: 'ipad', name: 'iPad', detail: 'Last used 3 Oct', icon: Tablet, current: false },
  ])
  return (
    <Group title="Signed in" note="Lost a phone? Sign it out here, then ask an admin to change your number.">
      {devices.map(d => (
        <Row key={d.id} title={d.name} body={d.detail} icon={<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted"><d.icon size={20} aria-hidden /></span>}>
          {d.current ? (
            <Pill tone="ok">This device</Pill>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                setDevices(list => list.filter(x => x.id !== d.id))
                toast(`Signed out of ${d.name}`)
              }}
            >
              Sign out
            </Button>
          )}
        </Row>
      ))}
    </Group>
  )
}

// ── Assistant memory (PA-10) ─────────────────────────────────────────────────
function MemorySection() {
  const { state, deleteMemory, editMemory, setMemoryOn, toast } = useStore()
  const [editing, setEditing] = useState<string | null>(null)
  const [text, setText] = useState('')
  return (
    <>
      <Group>
        <Row title={<label htmlFor="mem-on">Memory</label>} body={state.memoryOn ? 'Your assistant remembers useful things to help you.' : 'Off. Your assistant won’t remember anything new or use what’s below.'}>
          <Switch id="mem-on" label="Assistant memory" checked={state.memoryOn} onChange={on => { setMemoryOn(on); toast(on ? 'Memory is on' : 'Memory is off') }} />
        </Row>
      </Group>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
          What your assistant remembers <span className="tabular text-fg">{state.memories.length}</span>
        </h2>
        <AIMarker label="Learned" />
      </div>
      {state.memories.length === 0 ? (
        <EmptyState icon={<Brain size={28} />} title="Nothing remembered" body="Your assistant has no memories about you." />
      ) : (
        <ul className={cx('divide-y divide-line border-y border-line', !state.memoryOn && 'opacity-60')}>
          {state.memories.map(m => (
            <li key={m.id} className="py-3">
              {editing === m.id ? (
                <form
                  onSubmit={e => {
                    e.preventDefault()
                    if (text.trim()) editMemory(m.id, text.trim())
                    setEditing(null)
                  }}
                  className="flex flex-col gap-2"
                >
                  <label htmlFor={`mem-${m.id}`} className="sr-only">Edit memory</label>
                  <textarea id={`mem-${m.id}`} value={text} autoFocus rows={2} onChange={e => setText(e.target.value)} className={fieldClass} />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(null)}>Cancel</Button>
                    <Button size="sm" variant="primary" type="submit">Save</Button>
                  </div>
                </form>
              ) : (
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px]">{m.text}</p>
                    <p className="mt-0.5 text-[13px] text-muted">Learned from: {m.learnedFrom}</p>
                  </div>
                  <IconButton label="Edit memory" className="size-9 text-muted" onClick={() => { setEditing(m.id); setText(m.text) }}><Pencil size={16} /></IconButton>
                  <IconButton label="Delete memory" className="size-9 text-muted hover:text-rec" onClick={() => { deleteMemory(m.id); toast('Memory deleted') }}><Trash2 size={16} /></IconButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[13px] text-muted">Only you can see your assistant’s memory. Deleting something removes it for good.</p>
    </>
  )
}

// ── Privacy and your data (PDPA-02/04/05/07/13) ─────────────────────────────
type RequestKind = 'access' | 'correct' | 'withdraw'
const requestCopy: Record<RequestKind, { button: string; title: string; intro: string; field: string; placeholder: string }> = {
  access: {
    button: 'Request a copy of my data',
    title: 'Request a copy of your data',
    intro: 'The DPO will gather data about you, check it for other people’s personal data, and send you a copy with how it was used in the past year.',
    field: 'Anything in particular? (optional)',
    placeholder: 'For example: recordings and transcripts from September',
  },
  correct: {
    button: 'Correct my data',
    title: 'Correct your data',
    intro: 'Tell the DPO what’s wrong. If it isn’t changed, a note of your request is kept with it.',
    field: 'What’s wrong and where is it?',
    placeholder: 'For example: the Ops standup notes on 9 Oct say I own the roster, but Marcus does',
  },
  withdraw: {
    button: 'Withdraw consent',
    title: 'Withdraw consent',
    intro: 'The DPO will reply explaining which purposes stop and which continue, because some processing doesn’t rely on consent.',
    field: 'What would you like to withdraw from?',
    placeholder: 'For example: being included in the transcription test set',
  },
}

function Privacy() {
  const { toast } = useStore()
  const [req, setReq] = useState<RequestKind | null>(null)
  const [detail, setDetail] = useState('')
  const [notice, setNotice] = useState(false)
  const submit = () => {
    setReq(null)
    setDetail('')
    toast('Request sent to the Data Protection Officer. You’ll get a reply within 30 days.')
  }
  const copy = req ? requestCopy[req] : null
  return (
    <>
      <div className="mb-6 rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ok-soft text-ok"><ShieldCheck size={20} aria-hidden /></span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">Privacy and recording notice</p>
            <p className="text-[13px] text-muted">{ACK_RECORD}</p>
          </div>
        </div>
        <ul className="mt-3 flex flex-col gap-1.5 text-sm">
          <li className="flex gap-2"><span className="mt-1.5 size-2 shrink-0 rounded-full bg-rec" aria-hidden />Every voice session with 2 or more people is recorded and transcribed.</li>
          <li className="flex gap-2"><span className="mt-1.5 size-2 shrink-0 rounded-full bg-agent" aria-hidden />The AI only uses what you can open. Providers never train on our data.</li>
          <li className="flex gap-2"><span className="mt-1.5 size-2 shrink-0 rounded-full bg-muted" aria-hidden />Recordings 120 days, voice messages 360 days, transcripts and notes 3 years.</li>
        </ul>
        <Button size="sm" className="mt-4" icon={<FileText size={14} />} onClick={() => setNotice(true)}>Read the full notice</Button>
      </div>

      <Group title="Your requests" note="Requests go to the DPO’s queue. You’ll get a reply within 30 days.">
        {(Object.keys(requestCopy) as RequestKind[]).map(k => (
          <li key={k}>
            <button onClick={() => setReq(k)} className="flex w-full items-center gap-3 py-3 text-left hover:text-accent-ink">
              <span className="flex-1 text-[15px] font-medium">{requestCopy[k].button}</span>
              <ChevronRight size={18} className="text-muted" aria-hidden />
            </button>
          </li>
        ))}
      </Group>

      <Group title="Data Protection Officer">
        <Row title={DPO_NAME} body="Founder, Tembusu Logistics · also published on our website" icon={<Avatar id={ME} size="md" />} />
      </Group>

      <Sheet
        open={!!copy}
        onClose={() => setReq(null)}
        title={copy?.title}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReq(null)}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={req !== 'access' && !detail.trim()}>Send request</Button>
          </>
        }
      >
        {copy && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">{copy.intro}</p>
            <label htmlFor="pdpa-detail" className="text-[13px] font-medium">{copy.field}</label>
            <textarea id="pdpa-detail" rows={4} value={detail} onChange={e => setDetail(e.target.value)} placeholder={copy.placeholder} className={fieldClass} />
            <p className="text-[13px] text-muted">Sent as Ashton Teo, +65 9123 4567. The DPO may check it’s you before replying.</p>
          </div>
        )}
      </Sheet>

      <Sheet open={notice} onClose={() => setNotice(false)} title={`Notice · version ${NOTICE_VERSION}`}>
        <p className="mb-3 text-[13px] text-muted">Effective {NOTICE_DATE}. {ACK_RECORD}.</p>
        <div className="divide-y divide-line">
          {noticeSections.map(s => (
            <section key={s.id} className="py-3 first:pt-0">
              <h3 className="font-display text-[15px] font-semibold">{s.title}</h3>
              <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-sm text-muted">
                {s.points.map(p => <li key={p}>{p}</li>)}
              </ul>
            </section>
          ))}
        </div>
      </Sheet>
    </>
  )
}

// ── Appearance ───────────────────────────────────────────────────────────────
function Appearance() {
  const { state, setTheme } = useStore()
  return (
    <>
      <Segmented
        value={state.theme}
        onChange={setTheme}
        options={[
          { value: 'system', label: <span className="inline-flex items-center gap-1.5"><Monitor size={14} aria-hidden /> System</span> },
          { value: 'light', label: <span className="inline-flex items-center gap-1.5"><Sun size={14} aria-hidden /> Light</span> },
          { value: 'dark', label: <span className="inline-flex items-center gap-1.5"><Moon size={14} aria-hidden /> Dark</span> },
        ]}
      />
      <p className="mt-3 text-[13px] text-muted">System follows your device’s setting. Your choice is saved on this device.</p>
    </>
  )
}

// ── Help ─────────────────────────────────────────────────────────────────────
const howTos = [
  { title: 'Join a room', steps: 'Open Rooms and tap Join on any room, or tap Join room at the top of a channel. A red dot shows the session is recorded.' },
  { title: 'Ask a question', steps: 'Tap Search, type a question and press Enter. Answers come only from things you can open, with links to the sources.' },
  { title: 'Turn a message into a task', steps: 'On desktop, hover a message and choose Create task. Suggested tasks from meetings wait in Tasks until you accept them.' },
]

function Help() {
  const { toast } = useStore()
  const [open, setOpen] = useState<string | null>(null)
  return (
    <>
      <Group title="How to">
        {howTos.map(h => (
          <li key={h.title}>
            <button onClick={() => setOpen(o => (o === h.title ? null : h.title))} aria-expanded={open === h.title} className="flex w-full items-center gap-3 py-3 text-left">
              <span className="flex-1 text-[15px] font-medium">{h.title}</span>
              <ChevronRight size={18} className={cx('text-muted transition-transform', open === h.title && 'rotate-90')} aria-hidden />
            </button>
            {open === h.title && <p className="anim-in pb-3 text-sm text-muted">{h.steps}</p>}
          </li>
        ))}
      </Group>
      <Group title="Contact">
        <Row title="Questions about your data" body={`Data Protection Officer: ${DPO_NAME}`} />
        <Row title="Report a problem" body="Goes to Hearth admins with your device details">
          <Button size="sm" icon={<LifeBuoy size={14} />} onClick={() => toast('Thanks. Your report was sent to the Hearth admins.')}>Report</Button>
        </Row>
      </Group>
    </>
  )
}

function ReplayIntro() {
  const replay = () => {
    try {
      const saved = JSON.parse(localStorage.getItem('hearth-demo') ?? '{}')
      localStorage.setItem('hearth-demo', JSON.stringify({ ...saved, onboarded: false }))
    } catch {
      /* storage unavailable: the reload still shows the intro on a fresh visit */
    }
    window.location.hash = ''
    window.location.reload()
  }
  return (
    <button onClick={replay} className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg">
      <RotateCcw size={16} aria-hidden /> Replay the intro
    </button>
  )
}
