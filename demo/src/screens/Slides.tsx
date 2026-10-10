// Slides (DOC-13): a deck editor with one slide renderer for the canvas, the
// filmstrip and present mode. Editors type straight onto the slide; everyone
// who can open the deck can view and present it. AI help (D16) only suggests.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  ArrowDown, ArrowLeft, ArrowUp, Check, TriangleAlert, ChevronDown, ChevronRight, Copy, Ellipsis, ImageUp, LayoutTemplate, NotebookText, Palette, Play, Plus, Presentation, Sparkles, Star, Trash2, Undo2,
} from 'lucide-react'
import type { Deck, Doc, Slide, SlideLayout } from '../types'
import { useStore } from '../store'
import { ME } from '../data/people'
import { canEdit, folderPath, isTrashed } from '../drive'
import { canAddTo } from './drive/model'
import { folderName, useCopy } from './drive/actions'
import { KindIcon } from './drive/art'
import { FileCrumbs, ShareButton } from './drive/header'
import { Menu, type MenuItem } from './docs/ui'
import { listStamp } from '../time'
import { AIMarker, AvatarStack, Button, cx, EmptyState, IconButton, Pill, personShort, Sheet, SourceChips } from '../ui'
import { ShareDialog } from '../ui/share'
import { writeNotes } from './slides/ai'
import { convertLayout, insertAfter, isFreshDeck, newSlide, removeAt, setField, slideId } from './slides/model'
import { DraftSheet, LayoutSheet, ThemeSheet } from './slides/panels'
import { Present } from './slides/Present'
import { focusField, imageBox, layoutLabels, layoutOrder, SlideFrame, slideText, themes, type SlideEditor } from './slides/render'

// ── Small hooks ──────────────────────────────────────────────────────────────
// Phones in landscape are short: they keep the phone layout, where everything scrolls.
const wideQuery = '(min-width: 768px) and (min-height: 540px)'
function useWide() {
  return useSyncExternalStore(
    cb => { const m = window.matchMedia(wideQuery); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) },
    () => window.matchMedia(wideQuery).matches,
    () => true,
  )
}

/** Focus a canvas field once it has rendered (slides draw after their first measure). */
function focusSoon(root: () => HTMLElement | null, field: string, selectAll = false) {
  let tries = 0
  const tick = () => {
    const el = root()?.querySelector(`[data-field="${field}"]`)
    if (el) focusField(root(), field, selectAll)
    else if (tries++ < 20) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// ── Screen ───────────────────────────────────────────────────────────────────
export default function SlidesScreen() {
  const { state, navigate } = useStore()
  const deckId = state.route.name === 'slides' ? state.route.deckId : ''
  const deck = state.decks.find(d => d.id === deckId)
  if (!deck) {
    return (
      <div className="flex h-full flex-col">
        <BackHeader />
        <EmptyState
          icon={<Presentation size={32} />}
          title="This deck isn’t here"
          body="It may have been deleted, or the link is wrong. Your other decks are in Drive."
          action={<Button variant="primary" className="mt-2" onClick={() => navigate({ name: 'drive' })}>Open Drive</Button>}
        />
      </div>
    )
  }
  return <DeckEditor key={deck.id} deck={deck} />
}

function BackHeader() {
  const { back } = useStore()
  return (
    <header className="flex h-14 shrink-0 items-center border-b border-line bg-surface px-2">
      <IconButton label="Back" onClick={back}><ArrowLeft size={20} /></IconButton>
    </header>
  )
}

// ── Editor ───────────────────────────────────────────────────────────────────
type SheetName = 'add' | 'layout' | 'theme' | 'draft' | 'share' | 'ai' | null

function DeckEditor({ deck }: { deck: Deck }) {
  const api = useStore()
  const { state } = api
  const wide = useWide()
  const trashed = isTrashed(state.folders, deck)
  const editable = canEdit(deck) && !trashed
  const slides = deck.slides
  // A search result can open the deck at the slide it matched.
  const [sel, setSel] = useState(() => (state.route.name === 'slides' ? state.route.slide ?? 0 : 0))
  const idx = Math.max(0, Math.min(sel, slides.length - 1))
  const slide: Slide | undefined = slides[idx]
  const [sheet, setSheet] = useState<SheetName>(null)
  const [presenting, setPresenting] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [suggestion, setSuggestion] = useState<{ slideId: string; text: string } | null>(null)
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [deleted, setDeleted] = useState<{ slide: Slide; at: number } | null>(null)
  const [overflow, setOverflow] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<number | undefined>(undefined)

  // Always edit the latest deck, even when several edits land before a re-render.
  const deckRef = useRef(deck)
  deckRef.current = deck

  const commit = useCallback((next: Partial<Deck>) => {
    const d = { ...deckRef.current, ...next, updatedAt: api.state.clock, updatedBy: ME }
    deckRef.current = d
    api.updateDeck(d)
    setSaved('saving')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => setSaved('saved'), 700)
  }, [api])
  useEffect(() => () => window.clearTimeout(saveTimer.current), [])

  const setSlides = useCallback((fn: (s: Slide[]) => Slide[], extra?: Partial<Deck>) => commit({ ...extra, slides: fn(deckRef.current.slides) }), [commit])

  // Opening a deck counts as opening it (Recent in Drive). Once, on mount.
  const openedOnce = useRef(false)
  useEffect(() => {
    if (openedOnce.current) return
    openedOnce.current = true
    api.patchItem(deck.id, { lastOpenedAt: api.state.clock })
    if (editable && isFreshDeck(deck.slides, deck.title)) focusSoon(() => canvasRef.current, 'title', true)
  }, [api, deck.id, deck.slides, deck.title, editable])

  // Field to focus after a list edit (Enter adds a bullet, Backspace removes one).
  const pendingFocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (pendingFocus.current) {
      focusField(canvasRef.current, pendingFocus.current)
      pendingFocus.current = null
    }
  })

  const replaceSlide = useCallback((i: number, s: Slide, extra?: Partial<Deck>) => setSlides(list => list.map((x, j) => (j === i ? s : x)), extra), [setSlides])

  const edit: SlideEditor | undefined = useMemo(() => {
    if (!editable) return undefined
    const cur = () => deckRef.current.slides[idx]
    return {
      set: (field, value) => {
        const old = cur()
        if (!old) return
        // On a new deck the first slide's title names the deck too, until they differ.
        const d = deckRef.current
        const rename = field === 'title' && idx === 0 && old.layout === 'title' && value.trim() && (d.title.trim() === old.title.trim() || d.title === 'Untitled presentation')
        replaceSlide(idx, setField(old, field, value), rename ? { title: value.trim() } : undefined)
      },
      insertAfter: field => {
        const [s, next] = insertAfter(cur(), field)
        pendingFocus.current = next
        replaceSlide(idx, s)
      },
      remove: field => {
        const [s, prev] = removeAt(cur(), field)
        if (!prev) return
        pendingFocus.current = prev
        replaceSlide(idx, s)
      },
    }
  }, [editable, idx, replaceSlide])

  // ── Slide operations ──
  const select = (i: number) => { setSel(i); setConfirmDelete(false) }
  const addSlide = (layout: SlideLayout) => {
    const s = newSlide(layout)
    const at = slides.length ? idx + 1 : 0
    setSlides(list => [...list.slice(0, at), s, ...list.slice(at)])
    select(at)
    focusSoon(() => canvasRef.current, 'title')
  }
  const duplicate = () => {
    if (!slide) return
    setSlides(list => [...list.slice(0, idx + 1), { ...structuredClone(slide), id: slideId() }, ...list.slice(idx + 1)])
    select(idx + 1)
    api.toast(`Slide ${idx + 1} duplicated`)
  }
  const move = useCallback((by: -1 | 1) => {
    const list = deckRef.current.slides
    const to = idx + by
    if (to < 0 || to >= list.length) return
    const next = [...list]
    ;[next[idx], next[to]] = [next[to], next[idx]]
    setSlides(() => next)
    setSel(to)
  }, [idx, setSlides])
  const remove = () => {
    if (!slide) return
    setDeleted({ slide, at: idx })
    setSlides(list => list.filter((_, j) => j !== idx))
    setSel(Math.max(0, idx - 1))
    refocusDelete.current = true
    setConfirmDelete(false)
  }
  // Cancel (or Escape) puts focus back on the toolbar's Delete button rather than losing it to the page.
  const refocusDelete = useRef(false)
  const cancelDelete = () => { refocusDelete.current = true; setConfirmDelete(false) }
  useEffect(() => {
    if (confirmDelete || !refocusDelete.current) return
    refocusDelete.current = false
    document.querySelector<HTMLElement>('[role=toolbar][aria-label="Slide tools"] [aria-label="Delete slide"]:not(:disabled)')?.focus()
  }, [confirmDelete])
  const undoDelete = () => {
    if (!deleted) return
    const { slide: s, at } = deleted
    setSlides(list => [...list.slice(0, at), s, ...list.slice(at)])
    setSel(at)
    setDeleted(null)
  }
  // The undo offer stays until the next edit of the slide list, or 8 seconds.
  useEffect(() => {
    if (!deleted) return
    const t = window.setTimeout(() => setDeleted(null), 8000)
    return () => window.clearTimeout(t)
  }, [deleted])
  const changeLayout = (l: SlideLayout) => slide && replaceSlide(idx, convertLayout(slide, l))
  const addFromDoc = (drafted: Slide[], doc: Doc, title: string) => {
    const d = deckRef.current
    if (isFreshDeck(d.slides, d.title)) {
      commit({ slides: drafted, title: d.title === 'Untitled presentation' ? title : d.title })
      select(0)
    } else {
      const at = idx + 1
      setSlides(list => [...list.slice(0, at), ...drafted, ...list.slice(at)])
      select(at)
    }
    api.toast(`Added ${drafted.length} slides from “${doc.title}”`)
  }
  const present = () => {
    if (!slides.length) return
    document.documentElement.requestFullscreen?.().catch(() => {})
    setPresenting(idx)
  }
  const suggestNotes = () => {
    if (!slide) return
    setSuggestion({ slideId: slide.id, text: writeNotes(slide, idx, slides.length) })
    setNotesOpen(true)
    setSheet(null)
  }
  const acceptNotes = () => {
    if (!suggestion) return
    const i = deckRef.current.slides.findIndex(s => s.id === suggestion.slideId)
    if (i >= 0) replaceSlide(i, { ...deckRef.current.slides[i], notes: suggestion.text })
    setSuggestion(null)
  }

  // Alt+↑/↓ reorders the current slide (not while typing notes or the title).
  useEffect(() => {
    if (!editable || presenting !== null || sheet) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
      e.preventDefault()
      move(e.key === 'ArrowUp' ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editable, presenting, sheet, move])

  // ── Pieces ──
  const fileInput = useRef<HTMLInputElement>(null)
  const imageOverlay = editable && slide?.layout === 'image' && (
    <div className="absolute" style={{ left: `${imageBox.left * 100}%`, top: `${imageBox.top * 100}%`, width: `${imageBox.width * 100}%`, height: `${imageBox.height * 100}%` }}>
      <button
        onClick={() => fileInput.current?.click()}
        className="absolute bottom-[5%] left-[4%] inline-flex items-center gap-1.5 rounded-full bg-surface/95 px-3 py-1.5 text-[13px] font-medium text-fg shadow-card transition hover:bg-surface"
      >
        <ImageUp size={15} aria-hidden />{slide.imageUrl ? 'Replace image' : 'Add image'}
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose an image for this slide"
        onChange={e => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          if (!f.type.startsWith('image/')) { api.toast('That file isn’t an image. Pick a PNG, JPG, GIF or WebP.'); return }
          replaceSlide(idx, { ...deckRef.current.slides[idx], imageUrl: URL.createObjectURL(f) })
        }}
      />
    </div>
  )

  const canvas = slide ? (
    <div ref={canvasRef} className="w-full">
      <SlideFrame key={slide.id} slide={slide} theme={deck.theme} edit={edit} overlay={imageOverlay} className="shadow-card ring-1 ring-line" onOverflow={editable ? setOverflow : undefined} />
      {editable && overflow && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-warn" role="status">
          <TriangleAlert size={13} className="shrink-0" aria-hidden />
          Some text runs off the slide. Shorten it, or split it across two slides.
        </p>
      )}
    </div>
  ) : null

  const emptyDeck = !slides.length && (
    <div className="rounded-2xl border border-dashed border-line bg-surface">
      <EmptyState
        icon={<Presentation size={30} />}
        title="No slides yet"
        body={editable ? 'Start from a doc you can open, or pick a layout to add your first slide.' : 'The owner hasn’t added any slides yet.'}
      />
      {editable && <StartOffer onDraft={() => setSheet('draft')} onAdd={addSlide} className="px-5 pb-6" />}
    </div>
  )

  const freshOffer = editable && isFreshDeck(slides, deck.title) && (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="font-display text-[15px] font-semibold">Give it a title, then keep going</p>
      <p className="mt-0.5 mb-3 text-sm text-muted">Type on the slide to name it. Start from a doc, or add a slide.</p>
      <StartOffer onDraft={() => setSheet('draft')} onAdd={addSlide} />
    </div>
  )

  const notes = slide && (
    <NotesPanel
      slide={slide}
      index={idx}
      deck={deck}
      editable={editable}
      collapsible={!wide}
      open={wide || notesOpen}
      onToggle={() => setNotesOpen(v => !v)}
      onChange={text => replaceSlide(idx, { ...deckRef.current.slides[idx], notes: text })}
      suggestion={suggestion?.slideId === slide.id ? suggestion.text : null}
      onAccept={acceptNotes}
      onDiscard={() => setSuggestion(null)}
      onWrite={suggestNotes}
    />
  )

  const filmstrip = (
    <Filmstrip
      deck={deck}
      selected={idx}
      onSelect={select}
      onAdd={editable ? () => setSheet('add') : undefined}
      horizontal={!wide}
    />
  )

  const toolbar = (
    <Toolbar
      wide={wide}
      editable={editable}
      deck={deck}
      slide={slide}
      index={idx}
      confirmDelete={confirmDelete}
      onLayout={() => setSheet('layout')}
      onTheme={() => setSheet('theme')}
      onDuplicate={duplicate}
      onMove={move}
      onDelete={() => setConfirmDelete(true)}
      onCancelDelete={cancelDelete}
      onConfirmDelete={remove}
      onDraft={() => setSheet('draft')}
      onNotes={suggestNotes}
      onAI={() => setSheet('ai')}
      trashed={trashed}
    />
  )

  // ── More: copy and trash, as in Docs and Sheets ──
  const copy = useCopy()
  const [moreOpen, setMoreOpen] = useState(false)
  const path = folderPath(state.folders, deck.folderId)
  const home = path.length ? { name: 'drive' as const, folderId: path[path.length - 1].id } : { name: 'drive' as const, view: deck.ownerId === ME ? 'my' as const : 'shared' as const }
  const canTrash = canEdit(deck) && !trashed
  const moveToTrash = () => {
    api.trashItem(deck.id)
    // Back to the Drive you came from; otherwise to the deck's folder, replacing the deck in history.
    if (state.history[state.history.length - 1]?.name === 'drive') api.back()
    else api.navigate(home, { replace: true })
    api.toast(`Moved “${deck.title}” to trash`, { label: 'View trash', route: { name: 'drive', view: 'trash' } })
  }
  const moreItems: MenuItem[] = [
    { id: 'copy', label: 'Make a copy', note: `Saved in ${folderName(state, canAddTo(state, deck.folderId) ? deck.folderId : null)}`, icon: <Copy size={17} />, onSelect: () => copy({ kind: 'slides', item: deck }) },
    {
      id: 'trash', label: 'Move to trash', divider: true, danger: true, icon: <Trash2 size={17} />, disabled: !canTrash, onSelect: moveToTrash,
      note: trashed ? 'Already in the trash' : canTrash ? 'You can restore it from Trash for 30 days' : `Only ${personShort(deck.ownerId)} and editors can move it to trash`,
    },
  ]

  // In the trash itself, or inside a folder that is. Restoring brings back whichever it is.
  const trashedFolders = path.filter(f => f.trashed)
  const inFolder = !deck.trashed && trashedFolders.length > 0
  const canRestore = (!deck.trashed || canEdit(deck)) && trashedFolders.every(f => canEdit(f))
  const restore = () => {
    if (deck.trashed) api.restoreItem(deck.id)
    for (const f of trashedFolders) api.restoreItem(f.id)
    api.toast(trashedFolders.length ? `Restored “${trashedFolders[0].title}” from trash` : 'Restored from trash')
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <Header
        deck={deck} editable={editable} wide={wide} saved={saved} trashed={trashed} onShare={() => setSheet('share')} onPresent={present}
        more={
          <div className="relative">
            <IconButton label="More" aria-expanded={moreOpen} active={moreOpen} onClick={() => setMoreOpen(o => !o)}><Ellipsis size={20} /></IconButton>
            <Menu open={moreOpen} onClose={() => setMoreOpen(false)} items={moreItems} title="More" popover={wide} />
          </div>
        }
      />
      {trashed && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-rec-soft px-4 py-2 text-sm">
          <Trash2 size={16} className="shrink-0 text-rec" aria-hidden />
          <span className="min-w-0 flex-1 basis-56">
            {inFolder ? `This deck is in “${trashedFolders[0].title}”, which is in the trash.` : 'This deck is in the trash.'}
            {canRestore ? ` Restore ${inFolder ? 'the folder' : 'it'} to edit. You can still view and present it.` : ` Only ${inFolder ? personShort(trashedFolders[0].ownerId) : `${personShort(deck.ownerId)} and editors`} can restore it.`}
          </span>
          {canRestore && <Button size="sm" variant="secondary" icon={<Undo2 size={14} />} onClick={restore}>{inFolder ? 'Restore folder' : 'Restore'}</Button>}
        </div>
      )}
      {toolbar}
      {deleted && !confirmDelete && (
        <div className="anim-in flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5 sm:px-4" role="status">
          <span className="min-w-0 flex-1 truncate text-sm">Slide {deleted.at + 1} deleted</span>
          <Button size="sm" variant="ghost" icon={<Undo2 size={14} />} onClick={undoDelete}>Undo</Button>
        </div>
      )}

      {wide ? (
        <div className="flex min-h-0 flex-1">
          <aside className="w-48 shrink-0 overflow-y-auto border-r border-line bg-surface lg:w-56" aria-label="Slides">{filmstrip}</aside>
          <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full flex-col gap-4 px-6 py-6" style={{ maxWidth: 'max(420px, min(1100px, calc((100dvh - 330px) * 16 / 9)))' }}>
              {canvas}
              {emptyDeck}
              {freshOffer}
              {notes}
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-3 py-3">
            <div className="px-3">{canvas}{emptyDeck}</div>
            {filmstrip}
            {freshOffer && <div className="px-3">{freshOffer}</div>}
            {notes && <div className="px-3">{notes}</div>}
          </div>
        </div>
      )}

      <LayoutSheet open={sheet === 'add'} onClose={() => setSheet(null)} theme={deck.theme} mode="add" onPick={addSlide} />
      <LayoutSheet open={sheet === 'layout'} onClose={() => setSheet(null)} theme={deck.theme} mode="change" current={slide?.layout} onPick={changeLayout} />
      <ThemeSheet open={sheet === 'theme'} onClose={() => setSheet(null)} theme={deck.theme} sample={slides[0] ?? newSlide('title')} onPick={t => { commit({ theme: t }); setSheet(null) }} />
      <DraftSheet open={sheet === 'draft'} onClose={() => setSheet(null)} theme={deck.theme} onAdd={addFromDoc} />
      <ShareDialog itemId={deck.id} open={sheet === 'share'} onClose={() => setSheet(null)} />
      <Sheet open={sheet === 'ai'} onClose={() => setSheet(null)} title="Help me write">
        <div className="flex flex-col gap-2 pb-2">
          <AIAction icon={<Sparkles size={18} />} title="Draft slides from a doc" body="Pick a doc. You’ll see the slides before anything is added." onClick={() => setSheet('draft')} />
          <AIAction icon={<NotebookText size={18} />} title="Write speaker notes" body={slide ? `For slide ${idx + 1}, from what’s on it. You choose whether to keep them.` : 'Add a slide first.'} onClick={suggestNotes} disabled={!slide} />
        </div>
      </Sheet>

      {presenting !== null && (
        <Present deck={deck} start={presenting} onClose={at => { setPresenting(null); setSel(at) }} />
      )}
    </div>
  )
}

// ── Header ───────────────────────────────────────────────────────────────────
function Header({ deck, editable, wide, saved, trashed, onShare, onPresent, more }: { deck: Deck; editable: boolean; wide: boolean; saved: 'idle' | 'saving' | 'saved'; trashed: boolean; onShare: () => void; onPresent: () => void; more: ReactNode }) {
  const { state, back, navigate, renameItem, toggleStar } = useStore()
  const leave = () => (state.history.length ? back() : navigate({ name: 'drive', folderId: deck.folderId ?? undefined }))
  const status =
    saved === 'saving' ? 'Saving…'
    : saved === 'saved' ? 'Saved'
    : `Edited ${listStamp(deck.updatedAt).replace(/^(Yesterday|Today)/, w => w.toLowerCase())}${deck.updatedBy ? ` by ${deck.updatedBy === ME ? 'you' : personShort(deck.updatedBy)}` : ''}`
  const others = deck.presence.filter(p => p !== ME)

  return (
    <header className="flex min-h-14 shrink-0 items-center gap-0.5 border-b border-line bg-surface px-2 py-1.5 sm:gap-2 sm:px-3">
      <IconButton label="Back" onClick={leave}><ArrowLeft size={20} /></IconButton>
      <KindIcon kind="slides" size="md" className="hidden sm:grid" />
      <div className="min-w-0 flex-1">
        {editable ? (
          <>
            <label htmlFor="deck-title" className="sr-only">Deck title</label>
            <input
              id="deck-title"
              value={deck.title}
              onChange={e => renameItem(deck.id, e.target.value)}
              onBlur={e => !e.target.value.trim() && renameItem(deck.id, 'Untitled presentation')}
              onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
              className="-mx-1 w-full min-w-0 truncate rounded-md bg-transparent px-1 font-display text-[17px] leading-tight font-semibold outline-none hover:bg-surface-2 focus:bg-surface-2 sm:text-lg"
            />
          </>
        ) : (
          <h1 className="truncate font-display text-[17px] leading-tight font-semibold sm:text-lg">{deck.title}</h1>
        )}
        <FileCrumbs
          item={deck}
          compact={!wide}
          trailing={
            trashed ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-rec"><Trash2 size={12} aria-hidden />In trash</span>
            ) : (
              <>
                <span className={cx('flex min-w-0 items-center gap-1', saved === 'saved' && 'text-ok')} aria-live="polite">
                  {saved === 'saved' && <Check size={12} className="shrink-0" aria-hidden />}
                  <span className="truncate">{status}</span>
                </span>
                {!editable && <Pill className="ml-1 shrink-0">View only</Pill>}
              </>
            )
          }
        />
      </div>
      {wide && others.length > 0 && (
        <span className="flex items-center gap-1.5 pr-1" title={`${others.map(personShort).join(', ')} ${others.length === 1 ? 'is' : 'are'} here`}>
          <AvatarStack ids={others} size="sm" />
          <span className="sr-only">{others.map(personShort).join(', ')} viewing now</span>
        </span>
      )}
      {wide && <Button size="sm" variant="secondary" icon={<Play size={14} fill="currentColor" />} onClick={onPresent} disabled={!deck.slides.length}>Present</Button>}
      <IconButton label={deck.starred ? 'Remove from Starred' : 'Add to Starred'} aria-pressed={!!deck.starred} onClick={() => toggleStar(deck.id)}>
        <Star size={19} className={deck.starred ? 'fill-current text-warn' : 'text-muted'} />
      </IconButton>
      <ShareButton itemId={deck.id} onClick={onShare} compact={!wide} />
      {!wide && (
        <IconButton label="Present" onClick={onPresent} disabled={!deck.slides.length} className="disabled:opacity-50">
          <Play size={18} fill="currentColor" />
        </IconButton>
      )}
      {more}
    </header>
  )
}

// ── Toolbar ──────────────────────────────────────────────────────────────────
function Toolbar(p: {
  wide: boolean; editable: boolean; deck: Deck; slide?: Slide; index: number; confirmDelete: boolean
  onLayout: () => void; onTheme: () => void; onDuplicate: () => void; onMove: (by: -1 | 1) => void; onDelete: () => void
  onCancelDelete: () => void; onConfirmDelete: () => void; onDraft: () => void; onNotes: () => void; onAI: () => void; trashed: boolean
}) {
  const { deck, slide, index, wide } = p
  const n = deck.slides.length
  if (p.trashed) return null // the trash banner above says what you can do
  if (!p.editable) {
    return (
      <div className="flex shrink-0 items-start gap-2 border-b border-line bg-surface px-4 py-2 text-sm text-muted">
        <Presentation size={15} className="mt-0.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">You can view and present this deck. Ask {deck.ownerId === ME ? 'an editor' : personShort(deck.ownerId)} if you need to edit it.</span>
      </div>
    )
  }
  if (p.confirmDelete && slide) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-rec-soft px-3 py-2 sm:px-4" role="alertdialog" aria-label="Confirm delete" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); p.onCancelDelete() } }}>
        <Trash2 size={16} className="shrink-0 text-rec" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Delete slide {index + 1}{slide.title ? ` “${slide.title}”` : ''}?</span>
        <Button size="sm" variant="ghost" onClick={p.onCancelDelete} autoFocus>Cancel</Button>
        <Button size="sm" variant="danger" onClick={p.onConfirmDelete}>Delete</Button>
      </div>
    )
  }
  const tb = 'size-9 disabled:opacity-35 disabled:pointer-events-none'
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-line bg-surface px-1.5 py-1 sm:px-3" role="toolbar" aria-label="Slide tools">
      {wide ? (
        <>
          <ToolButton icon={<LayoutTemplate size={16} />} onClick={p.onLayout} disabled={!slide}>{slide ? layoutLabels[slide.layout] : 'Layout'}<ChevronDown size={14} className="text-muted" aria-hidden /></ToolButton>
          <ToolButton icon={<Palette size={16} />} onClick={p.onTheme}>{themes[deck.theme].name}<ChevronDown size={14} className="text-muted" aria-hidden /></ToolButton>
          <span className="mx-1.5 h-5 w-px bg-line" aria-hidden />
        </>
      ) : (
        <>
          <IconButton label={`Layout: ${slide ? layoutLabels[slide.layout] : ''}`} className={tb} onClick={p.onLayout} disabled={!slide}><LayoutTemplate size={18} /></IconButton>
          <IconButton label={`Theme: ${themes[deck.theme].name}`} className={tb} onClick={p.onTheme}><Palette size={18} /></IconButton>
        </>
      )}
      <IconButton label="Duplicate slide" className={tb} onClick={p.onDuplicate} disabled={!slide}><Copy size={17} /></IconButton>
      <IconButton label="Move slide up (Alt+↑)" className={tb} onClick={() => p.onMove(-1)} disabled={!slide || index === 0}><ArrowUp size={17} /></IconButton>
      <IconButton label="Move slide down (Alt+↓)" className={tb} onClick={() => p.onMove(1)} disabled={!slide || index >= n - 1}><ArrowDown size={17} /></IconButton>
      <IconButton label="Delete slide" className={cx(tb, 'hover:text-rec')} onClick={p.onDelete} disabled={!slide}><Trash2 size={17} /></IconButton>
      <span className="flex-1" />
      {wide ? (
        <>
          <Button size="sm" variant="agent" icon={<Sparkles size={14} />} onClick={p.onDraft} aria-label="Draft slides from a doc" title="Draft slides from a doc"><span className="hidden lg:inline">Draft from a doc</span></Button>
          <Button size="sm" variant="agent" icon={<NotebookText size={14} />} onClick={p.onNotes} disabled={!slide} className="ml-1.5" aria-label="Write speaker notes" title="Write speaker notes"><span className="hidden lg:inline">Write speaker notes</span></Button>
        </>
      ) : (
        <IconButton label="Help me write" className={cx(tb, 'bg-agent-soft text-agent hover:bg-agent-soft')} onClick={p.onAI}><Sparkles size={17} /></IconButton>
      )}
    </div>
  )
}

function ToolButton({ icon, children, onClick, disabled }: { icon: ReactNode; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition hover:bg-surface-2 disabled:opacity-50">
      {icon}{children}
    </button>
  )
}

function AIAction({ icon, title, body, onClick, disabled }: { icon: ReactNode; title: string; body: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="flex w-full items-start gap-3 rounded-2xl border border-line p-3 text-left transition hover:border-agent disabled:opacity-50">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-agent-soft text-agent">{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-muted">{body}</span>
      </span>
    </button>
  )
}

/** "Start from a doc, or pick a layout": shown on a new or empty deck. */
function StartOffer({ onDraft, onAdd, className }: { onDraft: () => void; onAdd: (l: SlideLayout) => void; className?: string }) {
  return (
    <div className={cx('flex flex-col gap-3', className)}>
      <Button variant="agent" icon={<Sparkles size={15} />} onClick={onDraft} className="self-start">Start from a doc</Button>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted">or add</span>
        {layoutOrder.filter(l => l !== 'title').map(l => (
          <button key={l} onClick={() => onAdd(l)} className="inline-flex h-8 items-center gap-1 rounded-full border border-line px-3 text-[13px] transition hover:border-accent hover:text-accent-ink">
            <Plus size={13} aria-hidden />{layoutLabels[l]}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Filmstrip ────────────────────────────────────────────────────────────────
function Filmstrip({ deck, selected, onSelect, onAdd, horizontal }: { deck: Deck; selected: number; onSelect: (i: number) => void; onAdd?: () => void; horizontal: boolean }) {
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
    const list = listRef.current
    if (!el || !list) return
    // Scroll only the strip itself, never the page around it.
    if (horizontal) {
      const l = el.offsetLeft - list.offsetLeft, r = l + el.offsetWidth
      if (l < list.scrollLeft) list.scrollTo({ left: l - 12 })
      else if (r > list.scrollLeft + list.clientWidth) list.scrollTo({ left: r - list.clientWidth + 12 })
    } else {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [selected, horizontal])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey) return
    const back = horizontal ? 'ArrowLeft' : 'ArrowUp', fwd = horizontal ? 'ArrowRight' : 'ArrowDown'
    if (e.key !== back && e.key !== fwd) return
    e.preventDefault()
    const to = Math.max(0, Math.min(deck.slides.length - 1, selected + (e.key === fwd ? 1 : -1)))
    onSelect(to)
    listRef.current?.querySelector<HTMLElement>(`[data-index="${to}"]`)?.focus()
  }

  const add = onAdd && (
    <button
      onClick={onAdd}
      className={cx(
        'flex shrink-0 items-center justify-center gap-1.5 rounded-xl border border-dashed border-line text-[13px] font-medium text-muted transition hover:border-accent hover:text-accent-ink',
        horizontal ? 'aspect-video w-28 flex-col' : 'h-10 w-full',
      )}
    >
      <Plus size={16} aria-hidden />{horizontal ? 'Add' : 'Add slide'}
    </button>
  )

  return (
    <div className={cx(horizontal ? 'flex min-w-0' : 'flex flex-col gap-3 p-3')}>
      <ol
        ref={listRef}
        aria-label="Slides"
        onKeyDown={onKeyDown}
        className={cx(horizontal ? 'flex min-w-0 flex-1 gap-2.5 overflow-x-auto px-3 pt-0.5 pb-1' : 'flex flex-col gap-3')}
        style={horizontal ? { scrollbarWidth: 'none' } : undefined}
      >
        {deck.slides.map((s, i) => (
          <li key={s.id} className={cx('flex shrink-0', horizontal ? 'w-28 flex-col gap-1' : 'items-start gap-2')}>
            {!horizontal && <span className={cx('w-4 pt-1 text-right text-xs tabular', i === selected ? 'font-bold text-accent-ink' : 'text-muted')}>{i + 1}</span>}
            <button
              data-index={i}
              onClick={() => onSelect(i)}
              aria-current={i === selected ? 'true' : undefined}
              aria-label={`Slide ${i + 1}: ${slideText(s)[0] || layoutLabels[s.layout]}`}
              tabIndex={i === selected ? 0 : -1}
              className={cx('block min-w-0 flex-1 rounded-[9px] p-[3px] transition', i === selected ? 'bg-accent' : 'hover:bg-line')}
            >
              <SlideFrame slide={s} theme={deck.theme} className="rounded-[6px]!" rounded={false} />
            </button>
            {horizontal && <span className={cx('text-center text-[11px] tabular', i === selected ? 'font-bold text-accent-ink' : 'text-muted')}>{i + 1}</span>}
          </li>
        ))}
        {horizontal && add && <li className="shrink-0">{add}</li>}
      </ol>
      {!deck.slides.length && !horizontal && <p className="px-1 text-xs text-muted">No slides yet.</p>}
      {!horizontal && add}
    </div>
  )
}

// ── Speaker notes ────────────────────────────────────────────────────────────
function NotesPanel(p: {
  slide: Slide; index: number; deck: Deck; editable: boolean; collapsible: boolean; open: boolean; onToggle: () => void
  onChange: (t: string) => void; suggestion: string | null; onAccept: () => void; onDiscard: () => void; onWrite: () => void
}) {
  const { slide, index, deck } = p
  const id = `notes-${slide.id}`
  const head = (
    <div className="flex items-center gap-2">
      {p.collapsible ? (
        <button onClick={p.onToggle} aria-expanded={p.open} aria-controls={id} className="-ml-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-1 text-left">
          <ChevronRight size={16} className={cx('shrink-0 text-muted transition-transform', p.open && 'rotate-90')} aria-hidden />
          <span className="shrink-0 text-[13px] font-semibold whitespace-nowrap">Speaker notes</span>
          {!p.open && <span className="min-w-0 truncate text-xs text-muted">{slide.notes?.trim() ? `· ${slide.notes}` : '· none yet'}</span>}
        </button>
      ) : p.editable ? (
        <label htmlFor={id} className="flex-1 text-[13px] font-semibold">Speaker notes <span className="font-normal text-muted">· slide {index + 1}</span></label>
      ) : (
        <h2 className="flex-1 text-[13px] font-semibold">Speaker notes <span className="font-normal text-muted">· slide {index + 1}</span></h2>
      )}
      {p.editable && p.open && !p.suggestion && (
        <Button size="sm" variant="ghost" icon={<Sparkles size={14} className="text-agent" />} onClick={p.onWrite} className="text-agent">Write for me</Button>
      )}
    </div>
  )
  return (
    <section className="rounded-2xl border border-line bg-surface px-4 py-3" aria-label="Speaker notes">
      {head}
      {p.open && (
        <div className="mt-2 flex flex-col gap-3">
          {p.collapsible && p.editable && <label htmlFor={id} className="sr-only">Speaker notes for slide {index + 1}</label>}
          {p.editable ? (
            <textarea
              id={id}
              value={slide.notes ?? ''}
              onChange={e => p.onChange(e.target.value)}
              rows={3}
              placeholder="What to say on this slide. Only you see these when presenting (press N)."
              className="w-full resize-y rounded-xl bg-surface-2 px-3 py-2 text-[15px] leading-relaxed outline-none placeholder:text-muted focus:ring-2 focus:ring-accent"
            />
          ) : (
            <p id={id} className={cx('text-[15px] leading-relaxed whitespace-pre-wrap', !slide.notes && 'text-muted')}>{slide.notes || 'No speaker notes on this slide.'}</p>
          )}
          {p.suggestion && (
            <div className="anim-in rounded-xl border border-agent/40 bg-agent-soft/60 p-3">
              <div className="mb-1.5 flex items-center gap-2">
                <AIMarker label="Suggested notes" />
              </div>
              <p className="text-[15px] leading-relaxed">{p.suggestion}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">Based on</span>
                <SourceChips numbered={false} sources={[{ label: `Slide ${index + 1} · ${deck.title}`, kind: 'slides', route: { name: 'slides', deckId: deck.id } }]} />
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={p.onDiscard}>Discard</Button>
                <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={p.onAccept}>{slide.notes?.trim() ? 'Replace notes' : 'Accept'}</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
