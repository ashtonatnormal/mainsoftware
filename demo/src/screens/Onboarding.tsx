// First-run flow (ACC-14): welcome → phone → code → PIN → notice → install → done.
import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, Bell, Check, Delete, Flame, Hash, Lock, MessageSquare, PlusSquare, Share, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useStore } from '../store'
import { ME, ORG_NAME, personById } from '../data/people'
import { Avatar, Button, cx, Pill, personName } from '../ui'
import { NOTICE_DATE, NOTICE_VERSION, noticeSections } from './onboarding/notice'

const STEPS = ['welcome', 'phone', 'code', 'pin', 'notice', 'install', 'done'] as const
type Step = (typeof STEPS)[number]

const CODE = '482913'

export default function OnboardingScreen() {
  const { completeOnboarding } = useStore()
  const [i, setI] = useState(0)
  const step: Step = STEPS[i]
  const next = () => setI(n => Math.min(STEPS.length - 1, n + 1))
  const prev = () => setI(n => Math.max(0, n - 1))

  return (
    <div className="h-full overflow-y-auto bg-surface md:grid md:place-items-center md:bg-bg md:p-6">
      <div className="mx-auto flex h-full w-full max-w-md flex-col bg-surface md:h-auto md:min-h-[680px] md:rounded-3xl md:border md:border-line md:shadow-card">
        <div className="flex h-14 shrink-0 items-center gap-2 px-2">
          <div className="w-24">
            {i > 0 && (
              <button onClick={prev} className="inline-flex h-10 items-center gap-1 rounded-full px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg">
                <ArrowLeft size={18} /> Back
              </button>
            )}
          </div>
          <div className="flex flex-1 justify-center gap-1.5" aria-label={`Step ${i + 1} of ${STEPS.length}`} role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={i + 1}>
            {STEPS.map((s, n) => (
              <span key={s} className={cx('h-1.5 rounded-full transition-all', n === i ? 'w-5 bg-accent' : n < i ? 'w-1.5 bg-accent' : 'w-1.5 bg-line')} />
            ))}
          </div>
          <div className="flex w-24 justify-end">
            {step !== 'done' && (
              <button onClick={completeOnboarding} className="h-10 rounded-full px-3 text-[13px] font-medium text-muted hover:bg-surface-2 hover:text-fg">
                Skip intro
              </button>
            )}
          </div>
        </div>
        <div key={step} className="anim-in flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-2 pb-6">
          {step === 'welcome' && <Welcome onNext={next} />}
          {step === 'phone' && <PhoneStep onNext={next} />}
          {step === 'code' && <CodeStep onNext={next} />}
          {step === 'pin' && <PinStep onNext={next} />}
          {step === 'notice' && <NoticeStep onNext={next} />}
          {step === 'install' && <InstallStep onNext={next} />}
          {step === 'done' && <DoneStep onDone={completeOnboarding} />}
        </div>
      </div>
    </div>
  )
}

function StepTitle({ title, body }: { title: string; body?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="font-display text-2xl font-semibold leading-tight">{title}</h1>
      {body && <p className="mt-2 text-[15px] text-muted">{body}</p>}
    </div>
  )
}

/** Primary action pinned to the bottom of the step. */
function Footer({ children }: { children: ReactNode }) {
  return <div className="mt-auto flex flex-col gap-2 pt-6">{children}</div>
}

// ── 1 Welcome ────────────────────────────────────────────────────────────────
function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
        <span className="grid size-20 place-items-center rounded-[28px] bg-accent text-accent-fg shadow-card">
          <Flame size={44} aria-hidden />
        </span>
        <div>
          <h1 className="font-display text-3xl font-semibold">Welcome to Hearth</h1>
          <p className="mx-auto mt-3 max-w-xs text-[15px] text-muted">{ORG_NAME} uses Hearth for chat, voice rooms and meetings.</p>
        </div>
        <ul className="mt-2 flex flex-col gap-2 text-left text-sm text-muted">
          <li className="flex items-center gap-2"><MessageSquare size={16} className="text-accent-ink" aria-hidden /> Chat with your team and channels</li>
          <li className="flex items-center gap-2"><Hash size={16} className="text-accent-ink" aria-hidden /> Drop into voice rooms, no scheduling</li>
          <li className="flex items-center gap-2"><ShieldCheck size={16} className="text-accent-ink" aria-hidden /> Notes and answers from what you can open</li>
        </ul>
      </div>
      <Footer>
        <Button variant="primary" size="lg" onClick={onNext}>Continue</Button>
      </Footer>
    </>
  )
}

// ── 2 Phone number (ACC-01) ─────────────────────────────────────────────────
function PhoneStep({ onNext }: { onNext: () => void }) {
  const [num, setNum] = useState('9123 4567')
  const valid = num.replace(/\D/g, '').length === 8
  return (
    <>
      <StepTitle title="Your mobile number" body="Use the number your company added for you. We’ll text you a code." />
      <label htmlFor="ob-phone" className="mb-1.5 text-[13px] font-medium text-muted">Mobile number</label>
      <div className="flex h-14 items-center gap-3 rounded-2xl bg-surface-2 px-4 focus-within:ring-2 focus-within:ring-accent">
        <span className="text-lg font-semibold tabular text-muted">+65</span>
        <span className="h-6 w-px bg-line" aria-hidden />
        <input
          id="ob-phone"
          inputMode="tel"
          autoComplete="tel-national"
          value={num}
          onChange={e => setNum(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-lg font-semibold tabular tracking-wide outline-none"
        />
      </div>
      <p className="mt-3 text-[13px] text-muted">Only numbers on the {ORG_NAME} staff list can sign in.</p>
      <Footer>
        <Button variant="primary" size="lg" disabled={!valid} onClick={onNext}>Send code</Button>
      </Footer>
    </>
  )
}

// ── 3 SMS code ───────────────────────────────────────────────────────────────
function CodeStep({ onNext }: { onNext: () => void }) {
  const [filled, setFilled] = useState(0)
  const [resend, setResend] = useState(28)
  useEffect(() => {
    // Simulated SMS: the code arrives after a moment and fills in digit by digit.
    const start = window.setTimeout(() => {
      let n = 0
      const t = window.setInterval(() => {
        n += 1
        setFilled(n)
        if (n >= CODE.length) clearInterval(t)
      }, 90)
    }, 900)
    return () => clearTimeout(start)
  }, [])
  useEffect(() => {
    if (resend <= 0) return
    const t = window.setTimeout(() => setResend(r => r - 1), 1000)
    return () => clearTimeout(t)
  }, [resend])
  const done = filled >= CODE.length
  return (
    <>
      <StepTitle title="Enter the code" body={<>We sent a 6-digit code to <span className="font-medium text-fg tabular">+65 9123 4567</span>.</>} />
      <div className="flex justify-between gap-2" role="group" aria-label="6-digit code">
        {CODE.split('').map((d, n) => (
          <span
            key={n}
            className={cx(
              'grid h-14 flex-1 place-items-center rounded-xl border-2 font-display text-2xl font-semibold tabular transition',
              n < filled ? 'border-accent bg-accent-soft text-fg' : n === filled ? 'border-accent bg-surface-2' : 'border-transparent bg-surface-2',
            )}
          >
            {n < filled ? d : ''}
          </span>
        ))}
      </div>
      <p className="mt-4 text-[13px] text-muted" aria-live="polite">
        {done ? (
          <span className="inline-flex items-center gap-1 text-ok"><Check size={14} aria-hidden /> Code filled in from your messages</span>
        ) : (
          'Waiting for the text message…'
        )}
      </p>
      <p className="mt-1 text-[13px] text-muted tabular">{resend > 0 ? `Resend in 0:${String(resend).padStart(2, '0')}` : <button className="font-medium text-accent-ink">Resend code</button>}</p>
      <Footer>
        <Button variant="primary" size="lg" disabled={!done} onClick={onNext}>Continue</Button>
      </Footer>
    </>
  )
}

// ── 4 PIN (ACC-02) ───────────────────────────────────────────────────────────
function PinStep({ onNext }: { onNext: () => void }) {
  const [first, setFirst] = useState<string | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [ok, setOk] = useState(false)
  const confirming = first !== null

  const press = (d: string) => {
    if (ok || pin.length >= 6) return
    const p = pin + d
    setPin(p)
    setError('')
    if (p.length < 6) return
    window.setTimeout(() => {
      if (!confirming) {
        setFirst(p)
        setPin('')
      } else if (p === first) {
        setOk(true)
      } else {
        setError('Those PINs don’t match. Set your PIN again.')
        setFirst(null)
        setPin('')
      }
    }, 220)
  }

  return (
    <>
      <StepTitle
        title={ok ? 'PIN set' : confirming ? 'Confirm your PIN' : 'Set a 6-digit PIN'}
        body="You’ll need your PIN on a new device. Hearth won’t ask for it every time you open the app."
      />
      <div className="flex justify-center gap-3" aria-label={`${pin.length} of 6 digits entered`} role="status">
        {Array.from({ length: 6 }, (_, n) => (
          <span key={n} className={cx('size-3.5 rounded-full border-2 transition', ok ? 'border-ok bg-ok' : n < pin.length ? 'border-accent bg-accent' : 'border-line')} />
        ))}
      </div>
      <p className={cx('mt-3 min-h-5 text-center text-[13px]', error ? 'text-rec' : ok ? 'text-ok' : 'text-muted')} aria-live="polite">
        {error || (ok ? 'Your PIN is saved.' : confirming ? 'Enter the same 6 digits again.' : 'Avoid birthdays and repeated digits.')}
      </p>
      <div className="mx-auto mt-4 grid w-full max-w-72 grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => (
          <Key key={d} label={d} onClick={() => press(d)} disabled={ok} />
        ))}
        <span />
        <Key label="0" onClick={() => press('0')} disabled={ok} />
        <button
          aria-label="Delete digit"
          disabled={ok || !pin}
          onClick={() => setPin(p => p.slice(0, -1))}
          className="grid h-14 place-items-center rounded-2xl text-muted transition hover:bg-surface-2 disabled:opacity-40"
        >
          <Delete size={22} />
        </button>
      </div>
      <Footer>
        <Button variant="primary" size="lg" disabled={!ok} onClick={onNext}>Continue</Button>
      </Footer>
    </>
  )
}

function Key({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={`Digit ${label}`}
      className="grid h-14 place-items-center rounded-2xl bg-surface-2 font-display text-2xl font-semibold tabular transition hover:bg-line active:scale-95 disabled:opacity-40"
    >
      {label}
    </button>
  )
}

// ── 5 Privacy and recording notice (PDPA-02/03) ─────────────────────────────
function NoticeStep({ onNext }: { onNext: () => void }) {
  const [read, setRead] = useState(false)
  return (
    <>
      <StepTitle title="Privacy and recording" body="Please read how Hearth records meetings and uses your data." />
      <div className="-mx-1 min-h-40 flex-1 overflow-y-auto rounded-2xl border border-line bg-bg px-4 py-3 md:max-h-[42vh]" tabIndex={0} aria-label="Privacy and recording notice">
        <div className="mb-3 flex items-center gap-2">
          <Pill tone="rec" icon={<span className="size-1.5 rounded-full bg-rec" aria-hidden />}>Meetings are recorded</Pill>
          <span className="text-[11px] text-muted">Version {NOTICE_VERSION} · {NOTICE_DATE}</span>
        </div>
        <div className="divide-y divide-line">
          {noticeSections.map(s => (
            <section key={s.id} className="py-3 first:pt-0 last:pb-1">
              <h2 className="font-display text-[15px] font-semibold">{s.title}</h2>
              <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-sm text-muted marker:text-line">
                {s.points.map(p => <li key={p}>{p}</li>)}
              </ul>
            </section>
          ))}
        </div>
      </div>
      <label htmlFor="ob-ack" className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl bg-surface-2 p-3 text-sm">
        <input id="ob-ack" type="checkbox" checked={read} onChange={e => setRead(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--accent)]" />
        <span>I’ve read the privacy and recording notice (version {NOTICE_VERSION}, {NOTICE_DATE})</span>
      </label>
      <Footer>
        <Button variant="primary" size="lg" disabled={!read} onClick={onNext}>Acknowledge</Button>
      </Footer>
    </>
  )
}

// ── 6 Install and notifications (ACC-14) ────────────────────────────────────
function InstallStep({ onNext }: { onNext: () => void }) {
  const [notif, setNotif] = useState<'off' | 'asking' | 'on'>('off')
  const [warn, setWarn] = useState(false)
  const turnOn = () => {
    setWarn(false)
    setNotif('asking')
    window.setTimeout(() => setNotif('on'), 900)
  }
  return (
    <>
      <StepTitle title="Add Hearth to your Home Screen" body="On iPhone, Hearth works best from the Home Screen. It’s also how notifications reach you." />
      <div className="flex items-stretch gap-4">
        <PhoneMock />
        <ol className="flex flex-1 flex-col justify-center gap-4 text-sm">
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent-ink">1</span>
            <span>Tap <span className="font-semibold whitespace-nowrap"><Share size={14} className="inline align-[-2px]" aria-hidden /> Share</span> in Safari’s toolbar.</span>
          </li>
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent-ink">2</span>
            <span>Choose <span className="font-semibold"><PlusSquare size={14} className="inline align-[-2px]" aria-hidden /> Add to Home Screen</span>.</span>
          </li>
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent-ink">3</span>
            <span>Open Hearth from your Home Screen.</span>
          </li>
        </ol>
      </div>

      <div className="mt-6 rounded-2xl border border-line p-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink"><Bell size={20} aria-hidden /></span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">Notifications</p>
            <p className="text-[13px] text-muted">For messages, mentions and meetings starting.</p>
          </div>
        </div>
        <div className="mt-3" aria-live="polite">
          {notif === 'on' ? (
            <div className="anim-in flex items-center gap-3 rounded-xl bg-surface-2 p-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-fg"><Flame size={16} aria-hidden /></span>
              <div className="min-w-0 flex-1 text-[13px]">
                <p className="font-semibold">Hearth</p>
                <p className="truncate text-muted">This is a test notification.</p>
              </div>
              <Pill tone="ok" icon={<Check size={12} aria-hidden />}>Received</Pill>
            </div>
          ) : (
            <Button variant="primary" className="w-full" onClick={turnOn} disabled={notif === 'asking'}>
              {notif === 'asking' ? 'Sending a test notification…' : 'Turn on notifications'}
            </Button>
          )}
          {notif === 'on' && <p className="mt-2 text-[13px] font-medium text-ok">Test notification received. You’re all set.</p>}
        </div>
      </div>

      {warn && notif !== 'on' && (
        <div className="anim-in mt-4 flex gap-3 rounded-2xl bg-warn-soft p-3 text-sm" role="alert">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warn" aria-hidden />
          <div>
            <p className="font-medium">You may miss messages until notifications are on.</p>
            <p className="mt-0.5 text-[13px] text-muted">Today will remind you until it’s done.</p>
          </div>
        </div>
      )}

      <Footer>
        {notif === 'on' ? (
          <Button variant="primary" size="lg" onClick={onNext}>Continue</Button>
        ) : warn ? (
          <Button variant="secondary" size="lg" onClick={onNext}>Skip anyway</Button>
        ) : (
          <Button variant="ghost" size="lg" onClick={() => setWarn(true)}>Skip for now</Button>
        )}
      </Footer>
    </>
  )
}

/** A small iPhone drawn with shapes: Safari with the Share button highlighted and the share sheet. */
function PhoneMock() {
  return (
    <div className="relative h-52 w-28 shrink-0 rounded-[22px] border-4 border-fg/80 bg-bg p-1" aria-hidden>
      <div className="mx-auto mb-1 h-1.5 w-10 rounded-full bg-fg/80" />
      <div className="mx-1 h-2 rounded bg-surface-2" />
      <div className="mx-1 mt-1.5 space-y-1">
        <div className="h-1.5 w-3/4 rounded bg-line" />
        <div className="h-1.5 w-1/2 rounded bg-line" />
      </div>
      {/* Share sheet */}
      <div className="absolute inset-x-1 bottom-7 rounded-xl bg-surface p-1.5 shadow-card">
        <div className="mb-1 h-1 w-6 rounded bg-line mx-auto" />
        <div className="flex items-center gap-1 rounded-md bg-accent-soft px-1 py-1 text-[7px] font-semibold text-accent-ink">
          <PlusSquare size={9} /> Add to Home Screen
        </div>
        <div className="mt-1 h-1.5 w-2/3 rounded bg-surface-2" />
        <div className="mt-1 h-1.5 w-1/2 rounded bg-surface-2" />
      </div>
      {/* Safari toolbar */}
      <div className="absolute inset-x-1 bottom-1 flex h-5 items-center justify-around rounded-b-[14px] bg-surface-2">
        <span className="h-1 w-2 rounded bg-line" />
        <span className="grid size-4 place-items-center rounded-full bg-accent text-accent-fg ring-2 ring-accent-soft"><Share size={9} /></span>
        <span className="h-1 w-2 rounded bg-line" />
      </div>
    </div>
  )
}

// ── 7 Done ───────────────────────────────────────────────────────────────────
function DoneStep({ onDone }: { onDone: () => void }) {
  const me = personById[ME]
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-8 text-center">
        <Avatar id={ME} size="xl" />
        <div>
          <h1 className="font-display text-3xl font-semibold">You’re in</h1>
          <p className="mt-2 font-medium">{personName(ME)}</p>
          <p className="text-sm text-muted">{me.title}</p>
        </div>
        <div className="mt-2 w-full rounded-2xl bg-surface-2 p-4 text-left">
          <p className="text-sm">You’ve been added to:</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {['announcements', 'ops-north-site', 'welcome'].map(c => (
              <li key={c} className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-[13px] font-medium">
                <Hash size={13} className="text-muted" aria-hidden />{c}
              </li>
            ))}
          </ul>
          <p className="mt-3 flex items-center gap-1.5 text-[13px] text-muted"><Lock size={13} aria-hidden /> Your PIN and notice acknowledgment are saved.</p>
        </div>
      </div>
      <Footer>
        <Button variant="primary" size="lg" onClick={onDone}>Open Hearth</Button>
      </Footer>
    </>
  )
}
