// The one slide renderer (DOC-13): the canvas, the filmstrip thumbnails and
// present mode all draw slides with <SlideFrame>. A slide is laid out at a fixed
// 1280×720 design size and scaled to fit its box.
//
// Theme colours are slide content, not app chrome: a deck looks the same in the
// app's light and dark modes, so these are fixed values rather than the app tokens.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { Deck, Slide, SlideLayout } from '../../types'
import { cx } from '../../ui'

export const W = 1280
export const H = 720

export type ThemeId = Deck['theme']

export interface SlideTheme {
  name: string
  bg: string // content slides
  fg: string
  muted: string
  accent: string
  soft: string // panels, bullet markers on hero slides
  heroBg: string // title and section slides
  heroFg: string
  heroMuted: string
  heroAccent: string
}

// Every pairing here was checked for at least 4.5:1 contrast on its own ground.
export const themes: Record<ThemeId, SlideTheme> = {
  ember: {
    name: 'Ember', bg: '#fffaf5', fg: '#2a1a10', muted: '#6e5242', accent: '#c2410c', soft: '#ffe6d2',
    heroBg: '#b53d0b', heroFg: '#fffaf5', heroMuted: '#ffe1cc', heroAccent: '#ffd0ad',
  },
  slate: {
    name: 'Slate', bg: '#1b2130', fg: '#f1f3f7', muted: '#b4bccb', accent: '#ff9a5c', soft: '#283044',
    heroBg: '#11151f', heroFg: '#f8f9fb', heroMuted: '#b4bccb', heroAccent: '#ff9a5c',
  },
  teal: {
    name: 'Teal', bg: '#f1f8f7', fg: '#0f2a2a', muted: '#456463', accent: '#0b6e70', soft: '#d3ebe9',
    heroBg: '#0b5f61', heroFg: '#f4fbfa', heroMuted: '#c9e9e7', heroAccent: '#9fe0dc',
  },
}

export const layoutLabels: Record<SlideLayout, string> = {
  title: 'Title', section: 'Section', bullets: 'Bullets', 'two-column': 'Two columns', 'big-number': 'Big number', quote: 'Quote', image: 'Image',
}
export const layoutOrder: SlideLayout[] = ['title', 'section', 'bullets', 'two-column', 'big-number', 'quote', 'image']

/** Plain-text summary of a slide, for labels, notes and search. */
export function slideText(s: Slide): string[] {
  const out = [s.title]
  switch (s.layout) {
    case 'big-number': out.push([s.stat, s.statLabel].filter(Boolean).join(' ')); break
    case 'bullets': out.push(...(s.bullets ?? [])); break
    case 'two-column': for (const col of [s.left, s.right]) if (col) out.push(col.heading ?? '', ...col.bullets); break
    default: out.push(s.subtitle ?? '')
  }
  return out.map(t => t.trim()).filter(Boolean)
}

// ── Editing hooks ────────────────────────────────────────────────────────────
/** Field paths a slide can edit, e.g. "title", "bullets.2", "left.heading", "right.1". */
export type Field = string

export interface SlideEditor {
  set: (field: Field, value: string) => void
  /** Enter in a list item: add a new item after it. */
  insertAfter: (field: Field) => void
  /** Backspace in an empty list item: remove it. */
  remove: (field: Field) => void
}

/**
 * A piece of slide text. Read-only it is a plain element; editable it is a
 * plaintext contentEditable that React leaves alone while it has focus, so the
 * caret never jumps as the store updates.
 */
function Text({ field, value, edit, placeholder, className, style, list, as: Tag = 'div', label }: {
  field: Field; value: string; edit?: SlideEditor; placeholder: string; className?: string; style?: CSSProperties; list?: boolean; as?: 'div' | 'li' | 'p' | 'h1' | 'h2'; label: string
}) {
  const ref = useRef<HTMLElement | null>(null)
  const latest = useRef(value)
  latest.current = value
  useLayoutEffect(() => {
    const el = ref.current
    if (el && document.activeElement !== el && el.textContent !== value) el.textContent = value
  }, [value])
  if (!edit) {
    if (!value) return null
    return <Tag className={className} style={style}>{value}</Tag>
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault() // fields are single-line, Shift+Enter included
      if (list) edit.insertAfter(field)
      else e.currentTarget.blur()
    } else if (e.key === 'Backspace' && list && !e.currentTarget.textContent) {
      e.preventDefault()
      edit.remove(field)
    } else if (e.key === 'Escape') {
      e.currentTarget.blur()
    }
  }
  return (
    <Tag
      ref={ref as never}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-label={label}
      aria-multiline={false}
      spellCheck
      data-field={field}
      data-placeholder={placeholder}
      className={cx(
        // Ring and selection follow the text colour, so they read on every theme.
        'rounded-[6px] outline-none transition-[box-shadow] hover:shadow-[0_0_0_3px_color-mix(in_srgb,currentColor_25%,transparent)] focus:shadow-[0_0_0_4px_color-mix(in_srgb,currentColor_45%,transparent)]',
        'selection:bg-[color-mix(in_srgb,currentColor_30%,transparent)] selection:text-current',
        'empty:before:pointer-events-none empty:before:opacity-45 empty:before:content-[attr(data-placeholder)]',
        className,
      )}
      style={{ ...style, cursor: 'text', minWidth: 40 }}
      onInput={e => {
        const el = e.currentTarget
        if (!el.textContent && el.innerHTML) el.innerHTML = '' // drop the stray <br>, so the placeholder shows
        const text = el.textContent ?? ''
        if (/[\r\n]/.test(text)) el.textContent = text.replace(/[\r\n]+/g, ' ')
        edit.set(field, el.textContent ?? '')
      }}
      onKeyDown={onKeyDown}
      // A list item can shift under a focused field (Backspace removes the one before
      // it); once focus leaves, show what the store holds.
      onBlur={e => { if (e.currentTarget.textContent !== latest.current) e.currentTarget.textContent = latest.current }}
    />
  )
}

// ── Slide body ───────────────────────────────────────────────────────────────
/**
 * Pick a bullet size that keeps the list on the slide: a rough count of the
 * lines the list takes at each size (wider columns hold more per line).
 */
function fitSize(items: string[], sizes: number[], squeeze = 1) {
  for (const size of sizes) {
    const perLine = (1100 / squeeze) / (size * 0.52)
    const lines = items.reduce((n, b) => n + Math.max(1, Math.ceil(b.length / perLine)), 0)
    const height = lines * size * 1.3 + Math.max(0, items.length - 1) * size * 0.62
    if (height <= (squeeze > 1.5 ? 330 : 440)) return size
  }
  return sizes[sizes.length - 1]
}
const statSize = (len: number) => (len <= 6 ? 210 : len <= 9 ? 160 : len <= 12 ? 120 : 92)

const display = 'var(--font-display)'
const sans = 'var(--font-sans)'

function Bullets({ items, path, edit, t, size, hero }: { items: string[]; path: string; edit?: SlideEditor; t: SlideTheme; size: number; hero?: boolean }) {
  const list = items.length ? items : edit ? [''] : []
  return (
    <ul className="flex flex-col" style={{ gap: size * 0.62 }}>
      {list.map((b, i) => (
        <li key={i} className="flex items-start" style={{ gap: size * 0.7 }}>
          <span aria-hidden className="shrink-0 rounded-full" style={{ width: size * 0.32, height: size * 0.32, marginTop: size * 0.5, background: hero ? t.heroAccent : t.accent }} />
          <Text
            field={`${path}.${i}`}
            value={b}
            edit={edit}
            list
            label={`Bullet ${i + 1}`}
            placeholder="Add a point"
            className="min-w-0 flex-1 [overflow-wrap:anywhere]"
            style={{ fontSize: size, lineHeight: 1.3 }}
          />
        </li>
      ))}
    </ul>
  )
}

/** Generated stand-in picture for image slides without an upload. */
function ImageFill({ hue = 30 }: { hue?: number }) {
  return (
    <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, oklch(0.72 0.11 ${hue}) 0%, oklch(0.5 0.13 ${hue + 25}) 100%)` }}>
      <svg viewBox="0 0 400 300" className="absolute inset-0 size-full" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <circle cx="300" cy="80" r="34" fill="white" fillOpacity="0.55" />
        <path d="M0 300 L120 150 L200 230 L260 180 L400 300 Z" fill="white" fillOpacity="0.28" />
        <path d="M0 300 L90 210 L170 300 Z" fill="white" fillOpacity="0.2" />
      </svg>
    </div>
  )
}

function SlideBody({ slide: s, t, edit }: { slide: Slide; t: SlideTheme; edit?: SlideEditor }) {
  const pad = 96
  const titleStyle = (size: number, color: string): CSSProperties => ({ fontFamily: display, fontSize: size, lineHeight: 1.08, fontWeight: 700, color, letterSpacing: '-0.01em' })
  switch (s.layout) {
    case 'title':
      return (
        <div className="absolute inset-0 flex flex-col justify-center" style={{ background: t.heroBg, color: t.heroFg, padding: `0 ${pad + 16}px` }}>
          <div aria-hidden style={{ width: 120, height: 10, borderRadius: 5, background: t.heroAccent, marginBottom: 44 }} />
          <Text as="h1" field="title" value={s.title} edit={edit} label="Slide title" placeholder="Add a title" className="[overflow-wrap:anywhere]" style={titleStyle(s.title.length > 40 ? 76 : 96, t.heroFg)} />
          <Text field="subtitle" value={s.subtitle ?? ''} edit={edit} label="Subtitle" placeholder="Add a subtitle" className="[overflow-wrap:anywhere]" style={{ fontFamily: sans, fontSize: 36, lineHeight: 1.3, color: t.heroMuted, marginTop: 32 }} />
        </div>
      )
    case 'section':
      return (
        <div className="absolute inset-0 flex items-center" style={{ background: t.heroBg, color: t.heroFg, padding: `0 ${pad + 16}px` }}>
          <div aria-hidden className="shrink-0 self-stretch" style={{ width: 14, background: t.heroAccent, margin: '200px 64px 200px 0', borderRadius: 7 }} />
          <div className="min-w-0 flex-1">
            <Text as="h1" field="title" value={s.title} edit={edit} label="Section title" placeholder="Section title" className="[overflow-wrap:anywhere]" style={titleStyle(84, t.heroFg)} />
            <Text field="subtitle" value={s.subtitle ?? ''} edit={edit} label="Subtitle" placeholder="Add a subtitle" className="[overflow-wrap:anywhere]" style={{ fontFamily: sans, fontSize: 34, lineHeight: 1.3, color: t.heroMuted, marginTop: 28 }} />
          </div>
        </div>
      )
    case 'bullets': {
      const size = fitSize(s.bullets ?? [], [38, 32, 28, 24, 20], s.title.length > 40 ? 1.25 : 1)
      return (
        <div className="absolute inset-0 flex flex-col" style={{ background: t.bg, color: t.fg, padding: `${pad - 16}px ${pad}px` }}>
          <Text as="h2" field="title" value={s.title} edit={edit} label="Slide title" placeholder="Add a title" className="[overflow-wrap:anywhere]" style={{ ...titleStyle(60, t.fg), marginBottom: 52 }} />
          <div className="min-h-0 flex-1"><Bullets items={s.bullets ?? []} path="bullets" edit={edit} t={t} size={size} /></div>
        </div>
      )
    }
    case 'two-column': {
      const longest = [s.left?.bullets ?? [], s.right?.bullets ?? []].sort((a, b) => b.join('').length + b.length * 30 - a.join('').length - a.length * 30)[0]
      const size = fitSize(longest, [30, 26, 22, 19, 17], 2.1)
      const col = (side: 'left' | 'right') => {
        const c = s[side] ?? { bullets: [] }
        return (
          <div className="min-w-0 flex-1 rounded-[28px]" style={{ background: t.soft, padding: '40px 44px' }}>
            <Text field={`${side}.heading`} value={c.heading ?? ''} edit={edit} label={`${side === 'left' ? 'Left' : 'Right'} heading`} placeholder="Heading" className="[overflow-wrap:anywhere]" style={{ fontFamily: display, fontSize: 36, fontWeight: 700, color: t.accent, marginBottom: 28, lineHeight: 1.15 }} />
            <Bullets items={c.bullets} path={side} edit={edit} t={t} size={size} />
          </div>
        )
      }
      return (
        <div className="absolute inset-0 flex flex-col" style={{ background: t.bg, color: t.fg, padding: `${pad - 16}px ${pad}px` }}>
          <Text as="h2" field="title" value={s.title} edit={edit} label="Slide title" placeholder="Add a title" className="[overflow-wrap:anywhere]" style={{ ...titleStyle(56, t.fg), marginBottom: 44 }} />
          <div className="flex min-h-0 flex-1" style={{ gap: 40 }}>{col('left')}{col('right')}</div>
        </div>
      )
    }
    case 'big-number':
      return (
        <div className="absolute inset-0 flex flex-col justify-center" style={{ background: t.bg, color: t.fg, padding: `0 ${pad + 16}px` }}>
          <Text field="title" value={s.title} edit={edit} label="Slide title" placeholder="What the number is about" className="[overflow-wrap:anywhere]" style={{ fontFamily: sans, fontSize: 34, fontWeight: 600, color: t.muted, letterSpacing: '0.01em' }} />
          <Text field="stat" value={s.stat ?? ''} edit={edit} label="Big number" placeholder="0" className="tabular whitespace-nowrap" style={{ fontFamily: display, fontSize: statSize((s.stat ?? '').length), fontWeight: 800, lineHeight: 1, color: t.accent, margin: '24px 0 28px', letterSpacing: '-0.03em' }} />
          <Text field="statLabel" value={s.statLabel ?? ''} edit={edit} label="What the number means" placeholder="What the number means" className="[overflow-wrap:anywhere]" style={{ fontFamily: sans, fontSize: 40, lineHeight: 1.3, color: t.fg, maxWidth: 1000 }} />
        </div>
      )
    case 'quote':
      return (
        <div className="absolute inset-0 flex flex-col justify-center" style={{ background: t.bg, color: t.fg, padding: `0 ${pad + 40}px` }}>
          <div aria-hidden style={{ fontFamily: 'Georgia, serif', fontSize: 220, lineHeight: 0.6, height: 110, color: t.accent }}>“</div>
          <Text as="p" field="title" value={s.title} edit={edit} label="Quote" placeholder="Add the quote" className="[overflow-wrap:anywhere]" style={{ fontFamily: display, fontSize: s.title.length > 90 ? 50 : 64, lineHeight: 1.2, fontWeight: 600, color: t.fg }} />
          <div className="flex items-center" style={{ gap: 20, marginTop: 44 }}>
            <span aria-hidden style={{ width: 48, height: 4, background: t.accent, borderRadius: 2 }} />
            <Text field="subtitle" value={s.subtitle ?? ''} edit={edit} label="Attribution" placeholder="Who said it" className="min-w-0 [overflow-wrap:anywhere]" style={{ fontFamily: sans, fontSize: 32, color: t.muted }} />
          </div>
        </div>
      )
    case 'image':
      return (
        <div className="absolute inset-0 flex" style={{ background: t.bg, color: t.fg }}>
          <div className="relative h-full overflow-hidden" style={{ width: 720 }}>
            {s.imageUrl ? <img src={s.imageUrl} alt={s.title || 'Slide image'} className="absolute inset-0 size-full object-cover" /> : <ImageFill hue={s.imageHue} />}
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-center" style={{ padding: '0 72px' }}>
            <Text as="h2" field="title" value={s.title} edit={edit} label="Slide title" placeholder="Add a title" className="[overflow-wrap:anywhere]" style={titleStyle(60, t.fg)} />
            <Text field="subtitle" value={s.subtitle ?? ''} edit={edit} label="Caption" placeholder="Add a caption" className="[overflow-wrap:anywhere]" style={{ fontFamily: sans, fontSize: 32, lineHeight: 1.35, color: t.muted, marginTop: 28 }} />
          </div>
        </div>
      )
  }
}

/** Where the image sits on an image slide, as fractions of the slide, for overlays. */
export const imageBox = { left: 0, top: 0, width: 720 / W, height: 1 }

// ── Frame: scale the 1280×720 slide to its box ───────────────────────────────
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/**
 * A slide scaled to the width of its box (16:9). `edit` turns on direct
 * editing; `overlay` renders on top in screen pixels (e.g. a "Replace image" button).
 */
export function SlideFrame({ slide, theme, edit, overlay, className, rounded = true, label, onOverflow }: {
  slide: Slide; theme: ThemeId; edit?: SlideEditor; overlay?: ReactNode; className?: string; rounded?: boolean; label?: string
  /** Called with true when some text runs past the slide's edge. */
  onOverflow?: (over: boolean) => void
}) {
  const [ref, w] = useWidth<HTMLDivElement>()
  useLayoutEffect(() => {
    const root = ref.current
    if (!onOverflow || !root || !w) return
    const box = root.getBoundingClientRect()
    const over = [...root.querySelectorAll<HTMLElement>('[data-field], li')].some(el => {
      const r = el.getBoundingClientRect()
      return r.height > 0 && (r.bottom > box.bottom + 1 || r.right > box.right + 1)
    })
    onOverflow(over)
  })
  const t = themes[theme] ?? themes.ember
  return (
    <div
      ref={ref}
      className={cx('relative aspect-video w-full overflow-hidden text-left', rounded && 'rounded-[3%/5.3%]', className)}
      style={{ background: slide.layout === 'title' || slide.layout === 'section' ? t.heroBg : t.bg }}
      role={edit ? undefined : 'img'}
      aria-label={edit ? undefined : label ?? slideText(slide).join('. ')}
    >
      {w > 0 && (
        <div className="absolute top-0 left-0 origin-top-left" style={{ width: W, height: H, transform: `scale(${w / W})` }} aria-hidden={edit ? undefined : true}>
          <SlideBody slide={slide} t={t} edit={edit} />
        </div>
      )}
      {overlay}
    </div>
  )
}

/** Focus a field on a canvas and put the caret at its end. */
export function focusField(root: HTMLElement | null, field: Field, selectAll = false) {
  const el = root?.querySelector<HTMLElement>(`[data-field="${field}"]`)
  if (!el) return
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  if (!selectAll) range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}
