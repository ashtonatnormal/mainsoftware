// Pure slide edits: field updates, list items, layout changes and new slides.
import type { Slide, SlideLayout } from '../../types'

let seq = 0
export const slideId = () => `sl_${Date.now().toString(36)}${(seq++).toString(36)}`

type Col = NonNullable<Slide['left']>

/** The list a field path points into, e.g. "bullets.2" → bullets, "left.0" → left.bullets. */
function listOf(s: Slide, key: string): string[] | undefined {
  if (key === 'bullets') return s.bullets
  if (key === 'left' || key === 'right') return s[key]?.bullets
}

function withList(s: Slide, key: string, list: string[]): Slide {
  if (key === 'bullets') return { ...s, bullets: list }
  const side = key as 'left' | 'right'
  return { ...s, [side]: { ...(s[side] ?? {}), bullets: list } as Col }
}

export function setField(s: Slide, field: string, value: string): Slide {
  const [key, sub] = field.split('.')
  if (sub === undefined) return { ...s, [key]: value }
  if (sub === 'heading') {
    const side = key as 'left' | 'right'
    return { ...s, [side]: { bullets: [], ...(s[side] ?? {}), heading: value } }
  }
  const list = [...(listOf(s, key) ?? [])]
  const i = Number(sub)
  while (list.length <= i) list.push('')
  list[i] = value
  return withList(s, key, list)
}

/** Insert an empty item after a list field. Returns the slide and the new field. */
export function insertAfter(s: Slide, field: string): [Slide, string] {
  const [key, sub] = field.split('.')
  const list = [...(listOf(s, key) ?? [])]
  const i = Math.min(Number(sub), list.length - 1) + 1
  list.splice(i, 0, '')
  return [withList(s, key, list), `${key}.${i}`]
}

/** Remove a list item. Returns the slide and the field to focus next (the one before). */
export function removeAt(s: Slide, field: string): [Slide, string | null] {
  const [key, sub] = field.split('.')
  const list = [...(listOf(s, key) ?? [])]
  const i = Number(sub)
  if (list.length <= 1) return [s, null] // keep one empty item to type into
  list.splice(i, 1)
  const prev = i > 0 ? `${key}.${i - 1}` : `${key}.0`
  return [withList(s, key, list), prev]
}

/** Example content for a new slide of each layout (empty fields show placeholders). */
export function newSlide(layout: SlideLayout): Slide {
  const id = slideId()
  switch (layout) {
    case 'title': return { id, layout, title: '', subtitle: '' }
    case 'section': return { id, layout, title: '', subtitle: '' }
    case 'bullets': return { id, layout, title: '', bullets: [''] }
    case 'two-column': return { id, layout, title: '', left: { heading: '', bullets: [''] }, right: { heading: '', bullets: [''] } }
    case 'big-number': return { id, layout, title: '', stat: '', statLabel: '' }
    case 'quote': return { id, layout, title: '', subtitle: '' }
    case 'image': return { id, layout, title: '', subtitle: '', imageHue: 200 }
  }
}

/** Sample slides for the layout picker. */
export const layoutSamples: Record<SlideLayout, Slide> = {
  title: { id: 'x1', layout: 'title', title: 'Presentation title', subtitle: 'Subtitle and date' },
  section: { id: 'x2', layout: 'section', title: 'Section', subtitle: 'What this part covers' },
  bullets: { id: 'x3', layout: 'bullets', title: 'Key points', bullets: ['First point', 'Second point', 'Third point'] },
  'two-column': { id: 'x4', layout: 'two-column', title: 'Compare', left: { heading: 'Before', bullets: ['Point', 'Point'] }, right: { heading: 'After', bullets: ['Point', 'Point'] } },
  'big-number': { id: 'x5', layout: 'big-number', title: 'One number', stat: '98%', statLabel: 'What it means' },
  quote: { id: 'x6', layout: 'quote', title: 'A line worth remembering.', subtitle: 'Who said it' },
  image: { id: 'x7', layout: 'image', title: 'Picture', subtitle: 'A short caption', imageHue: 200 },
}

/** Change a slide's layout, carrying its text across where it fits. */
export function convertLayout(s: Slide, layout: SlideLayout): Slide {
  if (s.layout === layout) return s
  const points = [
    ...(s.bullets ?? []),
    ...(s.left?.bullets ?? []),
    ...(s.right?.bullets ?? []),
  ].filter(Boolean)
  const lead = s.layout === 'big-number' ? [s.stat, s.statLabel].filter(Boolean).join(' ') : s.subtitle ?? ''
  const all = points.length ? points : lead ? [lead] : []
  const base: Slide = { id: s.id, layout, title: s.title, notes: s.notes }
  switch (layout) {
    case 'title':
    case 'section':
    case 'quote':
      return { ...base, subtitle: lead || points[0] || '' }
    case 'image':
      return { ...base, subtitle: lead || points[0] || '', imageHue: s.imageHue ?? 200, imageUrl: s.imageUrl }
    case 'bullets':
      return { ...base, bullets: all.length ? all : [''] }
    case 'two-column': {
      if (s.left || s.right) return { ...base, left: s.left, right: s.right }
      const half = Math.ceil(all.length / 2)
      return { ...base, left: { heading: '', bullets: all.slice(0, half).length ? all.slice(0, half) : [''] }, right: { heading: '', bullets: all.slice(half).length ? all.slice(half) : [''] } }
    }
    case 'big-number': {
      const m = all.join(' ').match(/(S\$\s?)?\d[\d,.]*%?/)
      return { ...base, stat: m?.[0] ?? '', statLabel: lead && s.layout !== 'big-number' ? lead : points[0] ?? '' }
    }
  }
}

/** Is this the untouched first slide of a brand-new deck? */
export function isFreshDeck(slides: Slide[], deckTitle: string) {
  if (slides.length !== 1) return false
  const s = slides[0]
  return s.layout === 'title' && !s.subtitle && !s.notes && (s.title === deckTitle || !s.title)
}
