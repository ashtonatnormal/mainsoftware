import { useEffect, useState } from 'react'

/** True at desktop widths (the shell's md breakpoint, 768px). */
export function useWide(query = '(min-width: 768px)') {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setWide(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return wide
}

/** Focuses (and optionally selects part of) an input once a dialog has opened. */
export function focusSoon(el: HTMLInputElement | null, selectTo?: number) {
  window.setTimeout(() => {
    if (!el) return
    el.focus()
    if (selectTo !== undefined) el.setSelectionRange(0, selectTo)
  }, 30)
}

/** Per-viewer conveniences (list/grid, sort) remembered in this browser, if storage works. */
export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(`hearth-drive-${key}`)
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(`hearth-drive-${key}`, value)
  } catch {
    /* storage unavailable: fine */
  }
}
