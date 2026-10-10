// Shared UI kit for the Hearth demo. Screens should build from these pieces and
// the colour tokens in index.css (bg, surface, surface-2, fg, muted, line,
// accent, accent-soft, accent-ink, agent, agent-soft, rec, rec-soft, ok, ok-soft,
// warn, warn-soft, wall) so both themes stay correct.
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { ArrowLeft, Bot, Calendar, CheckSquare, FileText, MessageSquare, Mic, Sparkles, ThumbsDown, ThumbsUp, User, X } from 'lucide-react'
import type { PersonId, SourceRef } from '../types'
import { personById } from '../data/people'
import { useStore } from '../store'

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ')
}

export const personName = (id: PersonId) => personById[id]?.name ?? 'Someone'
export const personShort = (id: PersonId) => personById[id]?.short ?? 'Someone'

// ── Avatar ────────────────────────────────────────────────────────────────────
const sizes = { xs: 'size-5 text-[9px]', sm: 'size-7 text-[11px]', md: 'size-9 text-[13px]', lg: 'size-12 text-base', xl: 'size-20 text-2xl' } as const

export function Avatar({ id, size = 'md', speaking, status, className }: { id: PersonId; size?: keyof typeof sizes; speaking?: boolean; status?: boolean; className?: string }) {
  const p = personById[id]
  if (!p) return null
  const initials = p.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('')
  const iconSize = size === 'xs' ? 11 : size === 'sm' ? 14 : size === 'md' ? 17 : size === 'lg' ? 22 : 34
  const body =
    p.kind === 'agent' ? (
      <span className={cx('grid place-items-center rounded-[30%] bg-agent text-white', sizes[size])}><Bot size={iconSize} aria-hidden /></span>
    ) : p.kind === 'assistant' ? (
      <span className={cx('grid place-items-center rounded-full bg-accent text-accent-fg', sizes[size])}><Sparkles size={iconSize} aria-hidden /></span>
    ) : (
      <span
        className={cx('grid place-items-center rounded-full font-semibold text-white', sizes[size])}
        style={{ background: `oklch(0.58 0.12 ${p.hue})` }}
      >
        {initials}
      </span>
    )
  const dot = status && p.kind === 'human' && (
    <span
      className={cx(
        'absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-surface',
        size === 'xs' || size === 'sm' ? 'size-2' : 'size-2.5',
        p.status === 'online' ? 'bg-ok' : p.status === 'dnd' ? 'bg-rec' : p.status === 'away' ? 'bg-warn' : 'bg-muted',
      )}
    />
  )
  return (
    <span className={cx('relative inline-flex shrink-0', speaking && 'rounded-full anim-ring', className)} title={p.name} aria-label={p.name}>
      {body}
      {dot}
    </span>
  )
}

export function AvatarStack({ ids, max = 4, size = 'sm' }: { ids: PersonId[]; max?: number; size?: keyof typeof sizes }) {
  const shown = ids.slice(0, max)
  return (
    <span className="inline-flex items-center -space-x-1.5">
      {shown.map(id => (
        <Avatar key={id} id={id} size={size} className="ring-2 ring-surface rounded-full" />
      ))}
      {ids.length > max && <span className="ml-2 text-xs text-muted tabular">+{ids.length - max}</span>}
    </span>
  )
}

// ── Buttons ───────────────────────────────────────────────────────────────────
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'agent'
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-105 active:brightness-95',
  secondary: 'bg-surface-2 text-fg hover:bg-line',
  ghost: 'text-fg hover:bg-surface-2',
  danger: 'bg-rec text-white hover:brightness-105',
  agent: 'bg-agent-soft text-agent hover:brightness-95',
}

export function Button({ variant = 'secondary', size = 'md', icon, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : size === 'lg' ? 'h-12 px-6 text-base' : 'h-10 px-4 text-sm',
        variants[variant],
        className,
      )}
    >
      {icon}
      {children}
    </button>
  )
}

export function IconButton({ label, children, active, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx('grid size-10 shrink-0 place-items-center rounded-full transition hover:bg-surface-2', active && 'bg-surface-2 text-accent-ink', className)}
    >
      {children}
    </button>
  )
}

// ── Pills, badges, markers ────────────────────────────────────────────────────
type Tone = 'neutral' | 'accent' | 'agent' | 'rec' | 'ok' | 'warn'
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  accent: 'bg-accent-soft text-accent-ink',
  agent: 'bg-agent-soft text-agent',
  rec: 'bg-rec-soft text-rec',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
}

export function Pill({ tone = 'neutral', children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap', tones[tone], className)}>
      {icon}
      {children}
    </span>
  )
}

export const AgentBadge = () => <Pill tone="agent">Agent</Pill>

/** AMB-06: every AI output is marked. */
export function AIMarker({ label = 'AI' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-agent-soft px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-agent">
      <Sparkles size={10} aria-hidden />
      {label}
    </span>
  )
}

/** REC-05: the recording indicator. */
export function RecordingIndicator({ compact, label = 'Recording' }: { compact?: boolean; label?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 font-semibold text-rec', compact ? 'text-[11px]' : 'text-xs')}>
      <span className="size-2 rounded-full bg-rec anim-pulse" aria-hidden />
      {label}
    </span>
  )
}

export function UnreadBadge({ count, muted }: { count: number; muted?: boolean }) {
  if (!count) return null
  return (
    <span className={cx('grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-bold tabular', muted ? 'bg-surface-2 text-muted' : 'bg-accent text-accent-fg')}>
      {count > 99 ? '99+' : count}
    </span>
  )
}

const sourceIcons = { doc: FileText, message: MessageSquare, session: Mic, task: CheckSquare, event: Calendar, person: User }

/** Principle 5: every AI answer links to what it was based on. */
export function SourceChips({ sources, numbered = true }: { sources: SourceRef[]; numbered?: boolean }) {
  const { navigate } = useStore()
  if (!sources.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.map((s, i) => {
        const Icon = sourceIcons[s.kind]
        return (
          <button
            key={i}
            onClick={() => navigate(s.route)}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-fg transition hover:border-agent hover:text-agent"
          >
            {numbered && <span className="font-bold text-agent tabular">{i + 1}</span>}
            <Icon size={12} className="shrink-0 text-muted" aria-hidden />
            <span className="truncate">{s.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Renders answer text with [1]-style markers as small superscript citations. */
export function CitedText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(\[\d+\])/g)
  return (
    <p className={className}>
      {parts.map((p, i) =>
        /^\[\d+\]$/.test(p) ? (
          <sup key={i} className="mx-0.5 rounded bg-agent-soft px-1 text-[10px] font-bold text-agent">{p.slice(1, -1)}</sup>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </p>
  )
}

export function Feedback() {
  const { toast } = useStore()
  return (
    <span className="inline-flex items-center gap-0.5 text-muted">
      <IconButton label="Helpful" className="size-8" onClick={() => toast('Thanks — feedback noted')}><ThumbsUp size={14} /></IconButton>
      <IconButton label="Not helpful" className="size-8" onClick={() => toast('Thanks — we’ll use this to improve')}><ThumbsDown size={14} /></IconButton>
    </span>
  )
}

// ── Layout helpers ────────────────────────────────────────────────────────────
/** Header for a screen or a detail pane. `back` shows a back arrow (phone-style). */
export function ScreenHeader({ title, subtitle, back, actions, leading, className }: { title: ReactNode; subtitle?: ReactNode; back?: boolean | (() => void); actions?: ReactNode; leading?: ReactNode; className?: string }) {
  const store = useStore()
  return (
    <header className={cx('flex min-h-14 items-center gap-2 border-b border-line bg-surface px-2 py-2 sm:px-4', className)}>
      {back && (
        <IconButton label="Back" onClick={typeof back === 'function' ? back : store.back}>
          <ArrowLeft size={20} />
        </IconButton>
      )}
      {leading}
      <div className="min-w-0 flex-1">
        <h1 className="truncate font-display text-lg font-semibold leading-tight">{title}</h1>
        {subtitle && <div className="truncate text-xs text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  )
}

/** Scrollable page body with consistent gutters. */
export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cx('mx-auto w-full px-4 py-5 sm:px-6', wide ? 'max-w-5xl' : 'max-w-3xl', className)}>{children}</div>
    </div>
  )
}

export function SectionTitle({ children, action, count }: { children: ReactNode; action?: ReactNode; count?: number }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
        {children}
        {count !== undefined && <span className="tabular text-fg">{count}</span>}
      </h2>
      {action}
    </div>
  )
}

export function Card({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag onClick={onClick} className={cx('block w-full rounded-2xl border border-line bg-surface text-left', onClick && 'transition hover:border-muted', className)}>
      {children}
    </Tag>
  )
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 text-muted">{icon}</div>}
      <p className="font-display text-lg font-semibold">{title}</p>
      {body && <p className="max-w-sm text-sm text-muted">{body}</p>}
      {action}
    </div>
  )
}

/** Bottom sheet on phones, centred dialog on larger screens. */
export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <button aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div ref={ref} tabIndex={-1} className="anim-in relative flex max-h-[88%] w-full flex-col rounded-t-3xl bg-surface shadow-card outline-none sm:max-w-lg sm:rounded-3xl" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <h2 className="flex-1 font-display text-lg font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange, className }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx('inline-flex rounded-full bg-surface-2 p-1', className)} role="tablist">
      {options.map(o => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx('rounded-full px-3 py-1.5 text-[13px] font-medium transition', value === o.value ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Small "Example data" marker so nobody mistakes the demo for real records. */
export const DemoNote = ({ children }: { children: ReactNode }) => <p className="text-[11px] text-muted">{children}</p>
