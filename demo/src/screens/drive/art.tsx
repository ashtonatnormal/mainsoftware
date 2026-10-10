// Visual pieces for Drive items: kind icon tiles (token colours), thumbnails
// that show real content, and the generated art seeded images and videos use.
import type { CSSProperties, ReactNode } from 'react'
import { File as FileIcon, Film, Folder as FolderIcon, FileText, Image as ImageIcon, Music, Play, Presentation, Sheet as SheetIcon } from 'lucide-react'
import type { Deck, Doc, DocBlock, DriveKind, DriveUpload, Folder, Sheet, Slide } from '../../types'
import type { DriveEntry } from '../../drive'
import { cx } from '../../ui'
import { duration } from '../../time'
import { folderDot } from './model'

// ── Kind tiles ───────────────────────────────────────────────────────────────
const tone: Record<DriveKind, string> = {
  folder: 'bg-surface-2 text-fg',
  doc: 'bg-accent-soft text-accent-ink',
  sheet: 'bg-ok-soft text-ok',
  slides: 'bg-warn-soft text-warn',
  pdf: 'bg-rec-soft text-rec',
  image: 'bg-agent-soft text-agent',
  video: 'bg-agent-soft text-agent',
  audio: 'bg-agent-soft text-agent',
  file: 'bg-surface-2 text-muted',
}
const icons = { folder: FolderIcon, doc: FileText, sheet: SheetIcon, slides: Presentation, image: ImageIcon, video: Film, audio: Music, file: FileIcon }

export function KindIcon({ kind, color, size = 'md', className }: { kind: DriveKind; color?: Folder['color']; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const box = size === 'sm' ? 'size-6 rounded-md' : size === 'lg' ? 'size-12 rounded-2xl' : 'size-10 rounded-xl'
  const px = size === 'sm' ? 14 : size === 'lg' ? 24 : 19
  const Icon = kind === 'pdf' ? null : icons[kind]
  return (
    <span className={cx('relative grid shrink-0 place-items-center', box, tone[kind], className)} aria-hidden>
      {Icon ? <Icon size={px} /> : <span className={cx('font-bold tracking-tight', size === 'sm' ? 'text-[8px]' : size === 'lg' ? 'text-[13px]' : 'text-[10px]')}>PDF</span>}
      {kind === 'folder' && color && (
        <span className={cx('absolute rounded-full ring-2 ring-surface', folderDot[color], size === 'sm' ? '-right-0.5 -bottom-0.5 size-2' : '-right-0.5 -bottom-0.5 size-3')} />
      )}
    </span>
  )
}

// ── Generated art (example images have no pixels, so we draw from their hue) ──
const ok = (l: number, c: number, h: number, a = 1) => `oklch(${l} ${c} ${h} / ${a})`

/** A floor plan for layouts, otherwise a soft "photo" scene. Example content, so it isn't themed. */
export function GeneratedArt({ hue = 200, plan, className, style }: { hue?: number; plan?: boolean; className?: string; style?: CSSProperties }) {
  if (plan) {
    const bays = Array.from({ length: 14 })
    return (
      <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" className={className} style={{ background: ok(0.95, 0.03, hue), ...style }} role="img" aria-label="Generated floor plan preview">
        <defs>
          <pattern id={`grid-${hue}`} width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke={ok(0.6, 0.06, hue, 0.18)} strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="400" height="300" fill={`url(#grid-${hue})`} />
        <rect x="24" y="24" width="352" height="252" rx="6" fill="none" stroke={ok(0.42, 0.09, hue)} strokeWidth="4" />
        {bays.map((_, i) => {
          const col = i % 7
          const row = Math.floor(i / 7)
          return <rect key={i} x={46 + col * 46} y={52 + row * 92} width="34" height="64" rx="3" fill={ok(0.62, 0.11, hue, 0.55)} stroke={ok(0.42, 0.09, hue)} strokeWidth="1.5" />
        })}
        <rect x="46" y="226" width="300" height="26" rx="4" fill={ok(0.75, 0.14, 60, 0.6)} stroke={ok(0.55, 0.15, 50)} strokeDasharray="6 4" />
        <rect x="350" y="96" width="26" height="40" fill={ok(0.95, 0.03, hue)} />
        <rect x="350" y="160" width="26" height="40" fill={ok(0.95, 0.03, hue)} />
        <path d="M356 100v32M356 164v32" stroke={ok(0.42, 0.09, hue)} strokeWidth="3" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" className={className} style={style} role="img" aria-label="Generated image preview">
      <defs>
        <linearGradient id={`sky-${hue}`} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor={ok(0.8, 0.08, hue)} />
          <stop offset="1" stopColor={ok(0.45, 0.1, hue + 25)} />
        </linearGradient>
      </defs>
      <rect width="400" height="300" fill={`url(#sky-${hue})`} />
      <circle cx="310" cy="70" r="38" fill={ok(0.95, 0.05, hue + 40, 0.55)} />
      <path d="M0 220 Q100 170 200 205 T400 190 V300 H0Z" fill={ok(0.35, 0.07, hue + 10, 0.55)} />
      <rect x="110" y="120" width="70" height="110" rx="6" fill={ok(0.3, 0.05, hue, 0.7)} />
      <rect x="128" y="96" width="10" height="134" fill={ok(0.25, 0.04, hue, 0.8)} />
      <rect x="196" y="190" width="120" height="40" rx="8" fill={ok(0.82, 0.14, 75, 0.85)} />
      <circle cx="222" cy="236" r="14" fill={ok(0.2, 0.02, hue)} />
      <circle cx="292" cy="236" r="14" fill={ok(0.2, 0.02, hue)} />
      <path d="M0 252 H400 V300 H0Z" fill={ok(0.25, 0.03, hue, 0.6)} />
    </svg>
  )
}

// ── Slide faces (theme colours are slide content, so they don't follow app light/dark) ──
export const slideTheme: Record<Deck['theme'], { bg: string; fg: string; accent: string; muted: string }> = {
  ember: { bg: ok(0.97, 0.025, 70), fg: ok(0.27, 0.04, 40), accent: ok(0.64, 0.19, 42), muted: ok(0.5, 0.04, 50) },
  slate: { bg: ok(0.26, 0.025, 255), fg: ok(0.96, 0.01, 255), accent: ok(0.78, 0.14, 65), muted: ok(0.75, 0.02, 255) },
  teal: { bg: ok(0.46, 0.08, 195), fg: ok(0.98, 0.01, 190), accent: ok(0.88, 0.1, 175), muted: ok(0.86, 0.04, 190) },
}

export function SlideFace({ slide, theme, className }: { slide: Slide; theme: Deck['theme']; className?: string }) {
  const t = slideTheme[theme]
  const big = slide.layout === 'title' || slide.layout === 'section'
  return (
    <div className={cx('relative flex aspect-video w-full flex-col justify-center overflow-hidden rounded-md px-[8%]', className)} style={{ background: t.bg, color: t.fg, containerType: 'inline-size' }}>
      <span className="absolute top-0 left-0 h-[6%] w-[22%]" style={{ background: t.accent }} />
      {slide.layout === 'big-number' && slide.stat ? (
        <>
          <span className="font-display leading-none font-bold" style={{ fontSize: '17cqw', color: t.accent }}>{slide.stat}</span>
          <span className="mt-[2%] line-clamp-2 leading-tight" style={{ fontSize: '5cqw', color: t.muted }}>{slide.statLabel}</span>
        </>
      ) : (
        <>
          <span className={cx('line-clamp-2 font-display leading-[1.1] font-semibold', !big && 'self-start')} style={{ fontSize: big ? '9cqw' : '7cqw' }}>{slide.title}</span>
          {slide.subtitle && <span className="mt-[3%] line-clamp-1" style={{ fontSize: '4.6cqw', color: t.muted }}>{slide.subtitle}</span>}
          {slide.bullets && (
            <span className="mt-[3%] flex flex-col gap-[1.5%]" style={{ fontSize: '4.2cqw', color: t.muted }}>
              {slide.bullets.slice(0, 3).map((b, i) => <span key={i} className="line-clamp-1">• {b}</span>)}
            </span>
          )}
        </>
      )}
    </div>
  )
}

// ── Thumbnails ───────────────────────────────────────────────────────────────
/** A paper page with tiny lines of real text. */
function Paper({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('absolute inset-x-4 top-3 bottom-0 overflow-hidden rounded-t-md border border-b-0 border-line bg-surface px-3 pt-2.5 shadow-card', className)}>
      {children}
    </div>
  )
}

export function DocLines({ blocks, limit = 7, className }: { blocks: DocBlock[]; limit?: number; className?: string }) {
  const shown = blocks.filter(b => b.text.trim() || b.type === 'todo').slice(0, limit)
  return (
    <div className={cx('flex flex-col gap-[3px] text-[8px] leading-[1.35] text-muted', className)}>
      {shown.map((b, i) =>
        b.type === 'h1' ? <p key={i} className="truncate font-display text-[10px] font-semibold text-fg">{b.text}</p>
          : b.type === 'h2' ? <p key={i} className="mt-0.5 truncate text-[8.5px] font-semibold text-fg">{b.text}</p>
            : b.type === 'li' ? <p key={i} className="truncate">• {b.text || ' '}</p>
              : b.type === 'todo' ? <p key={i} className="flex items-center gap-1 truncate"><span className={cx('inline-block size-[7px] shrink-0 rounded-[2px] border border-muted', b.done && 'bg-ok border-ok')} />{b.text || ' '}</p>
                : b.type === 'quote' ? <p key={i} className="truncate border-l-2 border-accent pl-1 italic">{b.text}</p>
                  : <p key={i} className="line-clamp-2">{b.text}</p>,
      )}
    </div>
  )
}

function SheetGrid({ sheet }: { sheet: Sheet }) {
  const tab = sheet.tabs[0]
  const rows = Math.min(6, tab?.rows ?? 0)
  const cols = Math.min(4, tab?.cols ?? 0)
  return (
    <div className="absolute inset-x-3 top-3 bottom-0 overflow-hidden rounded-t-md border border-b-0 border-line bg-surface shadow-card">
      <table className="w-full table-fixed border-collapse text-[8px] leading-tight">
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} className={cx(r < (tab.frozenRows ?? 0) && 'bg-surface-2')}>
              {Array.from({ length: cols }, (_, c) => {
                const cell = tab.cells[`${String.fromCharCode(65 + c)}${r + 1}`]
                const v = cell?.v && !cell.v.startsWith('=') ? cell.v : ''
                const num = v !== '' && !Number.isNaN(Number(v))
                return (
                  <td key={c} className={cx('h-[17px] truncate border border-line px-1', cell?.b ? 'font-semibold text-fg' : 'text-muted', num && 'text-right tabular')}>
                    {num ? Number(v).toLocaleString('en-SG') : v}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const isPlan = (u: DriveUpload) => /floor plan|layout/i.test(`${u.title} ${u.previewText ?? ''}`)

export function Thumb({ entry }: { entry: DriveEntry }) {
  switch (entry.kind) {
    case 'doc':
      return <Paper><DocLines blocks={(entry.item as Doc).blocks} /></Paper>
    case 'sheet':
      return <SheetGrid sheet={entry.item as Sheet} />
    case 'slides': {
      const deck = entry.item as Deck
      return (
        <div className="absolute inset-0 grid place-items-center px-4 py-3">
          {deck.slides[0] ? <SlideFace slide={deck.slides[0]} theme={deck.theme} className="shadow-card" /> : <span className="text-xs text-muted">No slides yet</span>}
        </div>
      )
    }
    case 'folder':
      return <div className="absolute inset-0 grid place-items-center"><KindIcon kind="folder" color={(entry.item as Folder).color} size="lg" /></div>
    default: {
      const u = entry.item as DriveUpload
      if (u.kind === 'image')
        return u.url ? <img src={u.url} alt="" className="absolute inset-0 size-full object-cover" /> : <GeneratedArt hue={u.hue} plan={isPlan(u)} className="absolute inset-0 size-full" />
      if (u.kind === 'video')
        return (
          <div className="absolute inset-0">
            {u.url ? <video src={u.url} muted preload="metadata" className="size-full object-cover" /> : <GeneratedArt hue={u.hue} className="size-full" />}
            <span className="absolute inset-0 grid place-items-center"><span className="grid size-10 place-items-center rounded-full bg-black/55 text-white"><Play size={18} className="ml-0.5" fill="currentColor" aria-hidden /></span></span>
            {u.durationSec !== undefined && <span className="absolute right-2 bottom-2 rounded bg-black/60 px-1.5 text-[11px] font-medium text-white tabular">{duration(u.durationSec)}</span>}
          </div>
        )
      if (u.kind === 'audio')
        return (
          <div className="absolute inset-0 flex items-center justify-center gap-[3px] px-6">
            {Array.from({ length: 28 }, (_, i) => <span key={i} className="w-1 rounded-full bg-agent/70" style={{ height: `${18 + 38 * Math.abs(Math.sin(i * 1.3))}%` }} />)}
          </div>
        )
      if (u.previewText)
        return (
          <Paper>
            {u.kind === 'pdf' && <p className="mb-1 truncate text-[9px] font-semibold text-fg">{u.title.replace(/\.pdf$/i, '')}</p>}
            <p className={cx('text-[8px] leading-[1.4] text-muted', u.kind === 'file' && 'font-mono whitespace-pre-wrap')}>{u.previewText.slice(0, 320)}</p>
          </Paper>
        )
      return <div className="absolute inset-0 grid place-items-center"><KindIcon kind={u.kind} size="lg" /></div>
    }
  }
}
