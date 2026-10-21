import { describe, expect, it } from 'vitest'
import { announce, announcer, createAnnouncer } from './announce.ts'

// An announcer whose frames run when the test says, recording every state the regions pass through.
function fakeAnnouncer() {
  const frames: (() => void)[] = []
  const announcer = createAnnouncer({ requestFrame: task => frames.push(task) })
  const seen: string[] = []
  announcer.subscribe(() => {
    const { polite, assertive } = announcer.snapshot()
    seen.push(`${polite}|${assertive}`)
  })
  const flush = () => {
    while (frames.length > 0) frames.shift()?.()
  }
  return { announcer, seen, flush }
}

describe('T21: the announcer (X11)', () => {
  it('AN-01 X11: one queue for the app; polite unless asked', async () => {
    const a = fakeAnnouncer()
    a.announcer.announce('Reconnecting…')
    a.announcer.announce('Couldn’t sign out.', 'assertive')
    a.flush()
    // Each message clears its own region, then sets it a frame later, in order.
    expect(a.seen).toEqual(['|', 'Reconnecting…|', 'Reconnecting…|', 'Reconnecting…|Couldn’t sign out.'])
    // The app's announce() speaks through the one module store, politely by default.
    const before = announcer.snapshot()
    announce('Connected again.')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(announcer.snapshot()).toEqual({ ...before, polite: 'Connected again.' })
  })

  it('AN-02 X11: the same text twice is announced twice; an empty text not at all', () => {
    const a = fakeAnnouncer()
    a.announcer.announce('You can get a new code now.')
    a.announcer.announce('You can get a new code now.')
    a.announcer.announce('')
    a.announcer.announce('   ')
    a.flush()
    expect(a.seen).toEqual(['|', 'You can get a new code now.|', '|', 'You can get a new code now.|'])
    // Once the queue is empty, a later message starts it again.
    a.announcer.announce('Connected again.')
    a.flush()
    expect(a.seen.slice(-2)).toEqual(['|', 'Connected again.|'])
  })
})
