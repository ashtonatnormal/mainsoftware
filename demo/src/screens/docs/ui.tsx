// Small pieces for the doc screen: media queries, the phone keyboard inset and
// a menu that is a popover on desktop and a bottom sheet on phones.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BookOpen, Compass, FileText, Hand, NotebookPen } from 'lucide-react'
import type { DocTemplateId } from '../../types'
import { cx, Sheet } from '../../ui'

/** One icon per doc template, wherever templates are offered (the blank doc, the Drive's New › Doc). */
export const templateIcons: Record<DocTemplateId, ReactNode> = {
  blank: <FileText size={16} />, 'meeting-notes': <NotebookPen size={16} />, 'project-brief': <Compass size={16} />, policy: <BookOpen size={16} />, onboarding: <Hand size={16} />,
}

export function useMedia(query: string) {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatch(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}

/** How much of the layout the on-screen keyboard covers (iOS keeps the layout viewport). */
export function useKeyboardInset() {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const on = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    vv.addEventListener('resize', on)
    vv.addEventListener('scroll', on)
    return () => {
      vv.removeEventListener('resize', on)
      vv.removeEventListener('scroll', on)
    }
  }, [])
  return inset
}

export interface MenuItem {
  id: string
  label: string
  icon: ReactNode
  onSelect: () => void
  note?: string
  disabled?: boolean
  danger?: boolean
  divider?: boolean
}

/** Popover under its trigger on desktop (wrap the trigger in a `relative` element); a sheet on phones. */
export function Menu({ open, onClose, items, title, popover, align = 'right', side = 'below', width = 'w-72' }: { open: boolean; onClose: () => void; items: MenuItem[]; title: string; popover: boolean; align?: 'left' | 'right'; side?: 'above' | 'below'; width?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // The button that opened the menu gets focus back when it closes, before an item
  // runs, so a dialog the item opens returns focus there too.
  const opener = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  if (open && !wasOpen.current) opener.current = document.activeElement as HTMLElement | null
  wasOpen.current = open
  const refocus = () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }) }
  useEffect(() => {
    if (!open || !popover) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); refocus(); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      if (!btns.length) return
      e.preventDefault()
      const i = btns.indexOf(document.activeElement as HTMLButtonElement)
      btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length].focus()
    }
    window.addEventListener('keydown', onKey, true)
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, popover])
  if (!open) return null
  const list = items.map(it => (
    <div key={it.id}>
      {it.divider && <div className="my-1.5 border-t border-line" />}
      <button
        role="menuitem"
        disabled={it.disabled}
        onClick={() => { onClose(); refocus(); it.onSelect() }}
        className={cx('flex w-full items-start gap-3 px-4 py-2.5 text-left transition hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:-outline-offset-2 disabled:cursor-not-allowed', popover ? 'rounded-xl px-3 py-2' : '', it.danger && !it.disabled ? 'text-rec' : '', it.disabled && 'opacity-60')}
      >
        <span className={cx('mt-0.5 shrink-0', it.danger && !it.disabled ? 'text-rec' : 'text-muted')}>{it.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{it.label}</span>
          {it.note && <span className="block text-xs text-muted">{it.note}</span>}
        </span>
      </button>
    </div>
  ))
  if (!popover) {
    return (
      <Sheet open onClose={onClose} title={title}>
        <div role="menu" aria-label={title} className="-mx-5 -my-2 pb-2">{list}</div>
      </Sheet>
    )
  }
  return (
    <>
      <button aria-label="Close menu" tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => { onClose(); refocus() }} />
      <div ref={ref} role="menu" aria-label={title} className={cx('anim-in absolute z-50 rounded-2xl border border-line bg-surface p-1.5 text-fg shadow-card', side === 'below' ? 'top-full mt-1.5' : 'bottom-full mb-1.5', width, align === 'right' ? 'right-0' : 'left-0')}>
        {list}
      </div>
    </>
  )
}
