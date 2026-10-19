// Media queries as React state (T21; SHL-16, R-15). Layout follows CSS (the rail variant, sm:), so
// these are for behaviour only: whether to animate, or which presentation a component picks. They
// read matchMedia through useSyncExternalStore, so a change re-renders at once, and the server
// snapshot is false, so react-dom/server markup tests render with no window.
import { useCallback, useSyncExternalStore } from 'react'

const hasMatchMedia = () => typeof matchMedia === 'function'

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!hasMatchMedia()) return () => {}
      const list = matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => hasMatchMedia() && matchMedia(query).matches,
    () => false,
  )
}

export const usePrefersReducedMotion = (): boolean => useMediaQuery('(prefers-reduced-motion: reduce)')
