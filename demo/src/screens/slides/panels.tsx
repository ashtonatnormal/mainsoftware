// Sheets and pickers used by the slides editor.
import { useMemo, useState } from 'react'
import { Check, ChevronRight, FileText } from 'lucide-react'
import type { Doc, Slide, SlideLayout } from '../../types'
import { useStore } from '../../store'
import { AIMarker, Button, cx, Sheet, SourceChips } from '../../ui'
import { listStamp } from '../../time'
import { draftFromDoc, openableDocs } from './ai'
import { layoutSamples } from './model'
import { layoutLabels, layoutOrder, SlideFrame, themes, type ThemeId } from './render'

/** A grid of layouts drawn in the deck's theme. */
export function LayoutGrid({ theme, current, onPick, compact }: { theme: ThemeId; current?: SlideLayout; onPick: (l: SlideLayout) => void; compact?: boolean }) {
  return (
    <div className={cx('grid gap-3', compact ? 'grid-cols-3 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3')}>
      {layoutOrder.map(l => (
        <button
          key={l}
          onClick={() => onPick(l)}
          aria-pressed={current === l}
          className={cx('group flex min-w-0 flex-col gap-1.5 rounded-xl p-1.5 text-left transition hover:bg-surface-2', current === l && 'bg-accent-soft')}
        >
          <SlideFrame slide={layoutSamples[l]} theme={theme} className={cx('ring-1 ring-line', current === l && 'ring-2 ring-accent')} label={`${layoutLabels[l]} layout`} />
          <span className="flex items-center gap-1 truncate px-0.5 text-[13px] font-medium">
            {current === l && <Check size={13} className="shrink-0 text-accent-ink" aria-hidden />}
            {layoutLabels[l]}
          </span>
        </button>
      ))}
    </div>
  )
}

export function LayoutSheet({ open, onClose, theme, mode, current, onPick }: { open: boolean; onClose: () => void; theme: ThemeId; mode: 'add' | 'change'; current?: SlideLayout; onPick: (l: SlideLayout) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={mode === 'add' ? 'Add a slide' : 'Change layout'}>
      <p className="mb-3 text-sm text-muted">{mode === 'add' ? 'Pick a layout. The new slide goes after the one you’re on.' : 'Your text moves across to the new layout where it fits.'}</p>
      <LayoutGrid theme={theme} current={mode === 'change' ? current : undefined} onPick={l => { onPick(l); onClose() }} />
    </Sheet>
  )
}

export function ThemeSheet({ open, onClose, theme, sample, onPick }: { open: boolean; onClose: () => void; theme: ThemeId; sample: Slide; onPick: (t: ThemeId) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Deck theme">
      <p className="mb-3 text-sm text-muted">The theme applies to every slide. It looks the same for everyone, in light or dark mode.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(Object.keys(themes) as ThemeId[]).map(id => (
          <button key={id} onClick={() => onPick(id)} aria-pressed={theme === id} className={cx('flex flex-col gap-1.5 rounded-xl p-1.5 text-left transition hover:bg-surface-2', theme === id && 'bg-accent-soft')}>
            <SlideFrame slide={sample} theme={id} className={cx('ring-1 ring-line', theme === id && 'ring-2 ring-accent')} label={`${themes[id].name} theme`} />
            <span className="flex items-center gap-1 px-0.5 text-[13px] font-medium">
              {theme === id && <Check size={13} className="text-accent-ink" aria-hidden />}
              {themes[id].name}
              <span className="font-normal text-muted">· {id === 'slate' ? 'dark' : id === 'ember' ? 'warm light' : 'cool light'}</span>
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  )
}

const plural = (n: number, one: string, many: (n: number) => string) => (n === 1 ? one : many(n))

function summary(c: { bullets: number; numbers: number; quotes: number }) {
  const parts = [
    'a title slide',
    c.bullets && plural(c.bullets, '1 bullet slide', n => `${n} bullet slides`),
    c.numbers && plural(c.numbers, '1 big-number slide', n => `${n} big-number slides`),
    c.quotes && plural(c.quotes, '1 quote', n => `${n} quotes`),
  ].filter(Boolean) as string[]
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
  const out = text[0].toUpperCase() + text.slice(1) + '.'
  return parts.length === 1 ? `${out} The doc has no lists or paragraphs to turn into more.` : out
}

/** "Draft slides from a doc": pick a doc, preview the slides, then add or discard. */
export function DraftSheet({ open, onClose, theme, onAdd }: { open: boolean; onClose: () => void; theme: ThemeId; onAdd: (slides: Slide[], doc: Doc, title: string) => void }) {
  const { state } = useStore()
  const docs = useMemo(() => openableDocs(state.docs, state.folders), [state.docs, state.folders])
  const [docId, setDocId] = useState<string | null>(null)
  const doc = docs.find(d => d.id === docId)
  const draft = useMemo(() => (doc ? draftFromDoc(doc) : null), [doc])
  const close = () => { setDocId(null); onClose() }

  return (
    <Sheet
      open={open}
      onClose={close}
      title={doc ? 'Suggested slides' : 'Draft slides from a doc'}
      footer={doc && draft ? (
        <>
          <Button variant="ghost" onClick={close}>Discard</Button>
          <Button variant="primary" onClick={() => { onAdd(draft.slides, doc, draft.title); setDocId(null); onClose() }}>{plural(draft.slides.length, 'Add 1 slide', n => `Add ${n} slides`)}</Button>
        </>
      ) : undefined}
    >
      {!doc ? (
        <>
          <p className="mb-3 text-sm text-muted">Pick a doc you can open. You’ll see the slides before anything is added.</p>
          {docs.length ? (
            <ul className="-mx-2 divide-y divide-line">
              {docs.map(d => (
                <li key={d.id}>
                  <button onClick={() => setDocId(d.id)} className="flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 text-left transition hover:bg-surface-2">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink"><FileText size={17} aria-hidden /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium">{d.title}</span>
                      <span className="block truncate text-xs text-muted">{d.space} · edited {listStamp(d.updatedAt)} · {d.blocks.filter(b => b.type === 'h2').length} sections</span>
                    </span>
                    <ChevronRight size={16} className="shrink-0 text-muted" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted">No docs yet. Create one in Drive, then come back.</p>
          )}
        </>
      ) : draft && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <AIMarker label="Suggested" />
            <span className="text-sm text-muted">{summary(draft.counts)}</span>
          </div>
          <ol className="-mx-5 flex snap-x scroll-px-5 gap-3 overflow-x-auto px-5 pb-2" aria-label="Preview of the suggested slides">
            {draft.slides.map((s, i) => (
              <li key={s.id} className="w-44 shrink-0 snap-start sm:w-48">
                <SlideFrame slide={s} theme={theme} className="ring-1 ring-line" />
                <p className="mt-1 truncate text-xs text-muted"><span className="font-semibold text-fg tabular">{i + 1}</span> · {s.title}</p>
              </li>
            ))}
          </ol>
          <div>
            <p className="mb-1.5 text-xs text-muted">Based on</p>
            <SourceChips sources={[{ label: `${doc.title} (${doc.space})`, kind: 'doc', route: { name: 'docs', docId: doc.id } }]} />
          </div>
          <p className="text-xs text-muted">Shortened from the doc’s headings, lists and paragraphs. Check the wording before you present.</p>
        </div>
      )}
    </Sheet>
  )
}
