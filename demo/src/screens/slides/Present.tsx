// Present mode: a full-viewport overlay that shows one slide at a time.
// Keys: →, Space, PageDown next; ←, PageUp previous; Home/End; N notes; Esc exits.
// Tap the right or left half, or swipe on a phone.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, NotebookText, X } from 'lucide-react'
import type { Deck } from '../../types'
import { cx } from '../../ui'
import { SlideFrame } from './render'

export function Present({ deck, start, onClose }: { deck: Deck; start: number; onClose: (at: number) => void }) {
  const total = deck.slides.length
  const [i, setI] = useState(Math.min(start, Math.max(0, total - 1)))
  const [notes, setNotes] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const atEnd = i >= total
  const slide = deck.slides[Math.min(i, total - 1)]

  const close = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    onClose(Math.min(i, total - 1))
  }, [i, total, onClose])
  const next = useCallback(() => setI(x => Math.min(x + 1, total)), [total])
  const prev = useCallback(() => setI(x => Math.max(x - 1, 0)), [])

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key
      if (k === 'ArrowRight' || k === 'ArrowDown' || k === ' ' || k === 'PageDown' || k === 'Enter') next()
      else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace') prev()
      else if (k === 'Home') setI(0)
      else if (k === 'End') setI(total - 1)
      else if (k === 'Escape') close()
      else if (k === 'n' || k === 'N') setNotes(v => !v)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [next, prev, close, total])

  // Leaving fullscreen with the browser's own Esc also leaves present mode.
  useEffect(() => {
    let was = !!document.fullscreenElement
    const onChange = () => {
      const now = !!document.fullscreenElement
      if (was && !now) onClose(Math.min(i, total - 1))
      was = now
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [i, total, onClose])

  useEffect(() => { root.current?.focus() }, [])

  // Tap halves and swipe
  const touch = useRef<{ x: number; y: number } | null>(null)
  const swiped = useRef(false)
  const onPointerDown = (e: React.PointerEvent) => { touch.current = { x: e.clientX, y: e.clientY }; swiped.current = false }
  const onPointerUp = (e: React.PointerEvent) => {
    const t = touch.current
    touch.current = null
    if (!t) return
    const dx = e.clientX - t.x, dy = e.clientY - t.y
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      swiped.current = true
      if (dx < 0) next()
      else prev()
    }
  }
  const onStageClick = (e: React.MouseEvent) => {
    if (swiped.current) { swiped.current = false; return }
    if (atEnd) { close(); return }
    const r = e.currentTarget.getBoundingClientRect()
    if (e.clientX - r.left < r.width / 2) prev()
    else next()
  }

  const note = slide?.notes?.trim()
  return (
    <div
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`Presenting ${deck.title}`}
      className="fixed inset-0 z-[70] flex flex-col bg-black text-white outline-none select-none"
      style={{ padding: 'env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px)' }}
    >
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-2 sm:p-6"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onClick={onStageClick}
        style={{ touchAction: 'pan-y' }}
      >
        {atEnd ? (
          <div className="text-center">
            <p className="font-display text-2xl font-semibold">End of slides</p>
            <p className="mt-2 text-sm text-white/70">Tap or press Esc to leave</p>
          </div>
        ) : (
          <div className="w-full" style={{ maxWidth: 'min(100%, calc((100dvh - 8rem) * 16 / 9))' }} aria-live="polite">
            <SlideFrame key={slide.id} slide={slide} theme={deck.theme} rounded={false} className="anim-in shadow-2xl" label={`Slide ${i + 1} of ${total}`} />
          </div>
        )}
      </div>

      {notes && (
        <div className="max-h-[32%] shrink-0 overflow-y-auto border-t border-white/15 bg-black/85 px-5 py-3 sm:px-8">
          <p className="text-[11px] font-bold tracking-[0.08em] text-white/60 uppercase">Speaker notes</p>
          <p className="mt-1 max-w-3xl text-[15px] leading-relaxed text-white/90">{note || (atEnd ? 'No more slides.' : 'No notes on this slide.')}</p>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1 px-2 pb-2 sm:px-4">
        <PBtn label="Leave present mode (Esc)" onClick={close}><X size={20} /></PBtn>
        <span className="min-w-0 flex-1 truncate px-1 text-sm text-white/70">{deck.title}</span>
        <PBtn label={notes ? 'Hide speaker notes (N)' : 'Show speaker notes (N)'} onClick={() => setNotes(v => !v)} active={notes}><NotebookText size={19} /></PBtn>
        <PBtn label="Previous slide" onClick={prev} disabled={i === 0}><ChevronLeft size={22} /></PBtn>
        <span className="min-w-14 text-center text-sm font-semibold tabular" aria-live="polite">{atEnd ? `${total} / ${total}` : `${i + 1} / ${total}`}</span>
        <PBtn label="Next slide" onClick={next} disabled={atEnd}><ChevronRight size={22} /></PBtn>
      </div>
    </div>
  )
}

function PBtn({ label, children, onClick, disabled, active }: { label: string; children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cx('grid size-11 shrink-0 place-items-center rounded-full text-white/85 transition hover:bg-white/15 disabled:opacity-30', active && 'bg-white/20 text-white')}
    >
      {children}
    </button>
  )
}
