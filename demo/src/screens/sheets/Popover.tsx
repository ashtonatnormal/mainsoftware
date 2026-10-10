// A small menu that opens under a button. It's fixed-positioned so it escapes
// the toolbar's horizontal scroll, and it closes on Escape or a click outside.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from '../../ui'

export function Popover({ anchor, open, onClose, children, align = 'left', label }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; children: ReactNode; align?: 'left' | 'right'; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor) return
    const place = () => {
      const a = anchor.getBoundingClientRect()
      const w = ref.current?.offsetWidth ?? 200
      const h = ref.current?.offsetHeight ?? 0
      let left = align === 'right' ? a.right - w : a.left
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
      let top = a.bottom + 4
      if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 4)
      setPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, anchor, align])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); anchor?.focus(); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])]
      if (!items.length) return
      e.preventDefault()
      const i = items.indexOf(document.activeElement as HTMLElement)
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus()
    }
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchor?.contains(t)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    ref.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true) }
  }, [open, onClose, anchor])

  if (!open) return null
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={cx('anim-in fixed z-50 min-w-48 rounded-2xl border border-line bg-surface p-1.5 shadow-card', !pos && 'invisible')}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0 }}
    >
      {children}
    </div>
  )
}

export function MenuItem({ icon, children, onClick, danger, disabled, hint }: { icon?: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cx('flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition hover:bg-surface-2 disabled:opacity-50 disabled:hover:bg-transparent', danger ? 'text-rec' : 'text-fg')}
    >
      {icon && <span className={cx('shrink-0', danger ? 'text-rec' : 'text-muted')}>{icon}</span>}
      <span className="min-w-0 flex-1">{children}</span>
      {hint && <span className="shrink-0 text-xs text-muted">{hint}</span>}
    </button>
  )
}
