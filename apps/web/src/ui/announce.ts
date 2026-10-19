// The app's one announcer (T21; X11). The demo's live regions either chattered (one per keystroke)
// or stayed silent; here every spoken status goes through announce(), deliberately: reconnecting
// and connected again, "You can get a new code now.", a sign-in step's change. Never per
// keystroke, and never for what focus already reads.
//
// <Announcer/> (in the app's root) renders two visually hidden live regions, polite and assertive,
// from this store. Each message clears its region, then sets the text on the next frame, so the
// same text twice is read twice (a live region speaks changes only). Messages queue, one a frame
// pair, so two in a row are both read. Empty text is ignored.

export type Politeness = 'polite' | 'assertive'

export interface AnnouncerState {
  readonly polite: string
  readonly assertive: string
}

export interface Announcer {
  announce(text: string, politeness?: Politeness): void
  subscribe(listener: () => void): () => void
  snapshot(): AnnouncerState
}

export function createAnnouncer(deps: { requestFrame(task: () => void): void }): Announcer {
  let state: AnnouncerState = { polite: '', assertive: '' }
  const listeners = new Set<() => void>()
  const queue: { text: string; politeness: Politeness }[] = []
  let busy = false

  const set = (next: AnnouncerState) => {
    state = next
    for (const listener of listeners) listener()
  }

  const pump = () => {
    const next = queue.shift()
    if (!next) {
      busy = false
      return
    }
    set({ ...state, [next.politeness]: '' })
    deps.requestFrame(() => {
      set({ ...state, [next.politeness]: next.text })
      deps.requestFrame(pump)
    })
  }

  return {
    announce(text, politeness = 'polite') {
      if (text.trim() === '') return
      queue.push({ text, politeness })
      if (!busy) {
        busy = true
        pump()
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => state,
  }
}

const requestFrame = (task: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => task())
  else setTimeout(task, 16)
}

// The one store the app announces through.
export const announcer = createAnnouncer({ requestFrame })

export function announce(text: string, politeness: Politeness = 'polite'): void {
  announcer.announce(text, politeness)
}
