import type { NoticeStanding } from '@hearth/shared'
import { describe, expect, it, vi } from 'vitest'
import { createNoticeStore } from './notice.ts'

// The store over recording stand-ins for what it moves: the live connection, Query and the channel.
function store(initial: NoticeStanding) {
  const steps: string[] = []
  const notice = createNoticeStore({
    initial,
    live: { start: () => steps.push('start'), resume: () => steps.push('resume') },
    refetchAll: () => steps.push('refetch'),
    resetNotice: () => steps.push('reset'),
    fetchNotice: () => steps.push('fetch'),
    post: () => steps.push('post'),
  })
  const seen: NoticeStanding[] = []
  notice.subscribe(() => seen.push(notice.standing()))
  return { notice, steps, seen }
}

describe('C0.9 PD-46: the notice store (session/notice.ts)', () => {
  it('NTW-02 T22 item 31: acknowledging here starts or resumes the live connection, fetches every query again and tells the other tabs; from elsewhere it tells nobody', () => {
    const here = store('required')
    here.notice.acknowledged('here')
    expect(here.notice.standing()).toBe('acknowledged')
    expect(here.seen).toEqual(['acknowledged'])
    // start() opens it the first time and does nothing after; resume() ends only a 4403 pause.
    expect(here.steps).toEqual(['start', 'resume', 'refetch', 'post'])
    expect(here.notice.mark()).toEqual({ acknowledgements: 1, requirements: 0 })

    const elsewhere = store('required')
    elsewhere.notice.acknowledged('elsewhere')
    expect(elsewhere.steps).toEqual(['start', 'resume', 'refetch'])
    // Told again while acknowledged: nothing more is fetched, and nobody is told.
    elsewhere.notice.acknowledged('elsewhere')
    expect(elsewhere.steps).toEqual(['start', 'resume', 'refetch', 'start', 'resume'])
    expect(elsewhere.seen).toEqual(['acknowledged'])
  })

  it('NTW-02 PD-46: a hint makes the standing required and resets the cached notice answer, from acknowledged or unpublished (the DPO’s own publish); while required already it changes nothing', () => {
    for (const initial of ['acknowledged', 'unpublished'] as const) {
      const { notice, steps, seen } = store(initial)
      notice.required()
      expect(notice.standing(), initial).toBe('required')
      expect(seen, initial).toEqual(['required'])
      expect(steps, initial).toEqual(['reset'])
      notice.required()
      expect(steps, initial).toEqual(['reset'])
      expect(seen, initial).toEqual(['required'])
    }
  })

  it('NTW-02 PD-46: an answer saying acknowledged moves the standing forward unless its request crossed a move to required; any other moves it only when it crossed no acknowledgement', () => {
    const { notice, steps, seen } = store('required')
    // Sent before an acknowledgement here (which it doesn't know of): still true, so it moves.
    const before = notice.mark()
    notice.heard('acknowledged', before, 'notice')
    expect(notice.standing()).toBe('acknowledged')
    expect(steps).toEqual(['start', 'resume', 'refetch'])
    // No post: the answer came from the server, not from this tab's acknowledgement.
    const acked = { ...before, acknowledgements: before.acknowledgements - 1 }
    notice.heard('required', acked, 'notice')
    expect(notice.standing()).toBe('acknowledged')
    notice.heard('required', notice.mark(), 'notice')
    expect(notice.standing()).toBe('required')
    // Published or not is the server's to say, both ways.
    notice.heard('unpublished', notice.mark(), 'notice')
    expect(notice.standing()).toBe('unpublished')
    notice.heard('unpublished', notice.mark(), 'notice')
    expect(seen).toEqual(['acknowledged', 'required', 'unpublished'])
  })

  it('NTW-02 PD-46: an acknowledged answer whose request was sent before a move to required changes nothing, since it may speak of a version since replaced; one sent after it moves the standing', () => {
    const { notice, steps, seen } = store('acknowledged')
    // A session request in flight while acknowledged; a 403 notice_required lands first.
    const inFlight = notice.mark()
    notice.required()
    expect(notice.mark()).toEqual({ acknowledgements: 0, requirements: 1 })
    notice.heard('acknowledged', inFlight, 'session')
    expect(notice.standing()).toBe('required')
    expect(steps).toEqual(['reset'])
    notice.heard('acknowledged', notice.mark(), 'session')
    expect(notice.standing()).toBe('acknowledged')
    expect(seen).toEqual(['required', 'acknowledged'])
  })

  it('NTW-02 PD-46: the session asking for the notice resets the cached notice answer, as a hint does; GET /api/notice saying so keeps the answer it brought', () => {
    const fromSession = store('acknowledged')
    fromSession.notice.heard('required', fromSession.notice.mark(), 'session')
    expect(fromSession.notice.standing()).toBe('required')
    expect(fromSession.steps).toEqual(['reset'])
    const fromNotice = store('acknowledged')
    fromNotice.notice.heard('required', fromNotice.notice.mark(), 'notice')
    expect(fromNotice.notice.standing()).toBe('required')
    expect(fromNotice.steps).toEqual([])
  })

  it('NTW-02 T22 item 31: check() asks GET /api/notice only while the standing isn’t acknowledged', () => {
    const { notice, steps } = store('required')
    notice.check()
    expect(steps).toEqual(['fetch'])
    notice.acknowledged('elsewhere')
    steps.length = 0
    notice.check()
    expect(steps).toEqual([])
  })

  it('NTW-02 WS-01: the return path is kept in memory, only an app path, and read once', () => {
    const { notice } = store('required')
    notice.rememberReturn('/tasks')
    expect(notice.takeReturn()).toBe('/tasks')
    expect(notice.takeReturn()).toBeUndefined()
    // A path the shell doesn't register, or /notice itself, forgets the older one.
    notice.rememberReturn('/dpo/purposes')
    notice.rememberReturn('/notice')
    expect(notice.takeReturn()).toBeUndefined()
    notice.rememberReturn('/settings/privacy?x=1')
    expect(notice.takeReturn()).toBeUndefined()
  })

  it('NTW-02: a listener that throws stops neither the others nor the change; a stopped one hears nothing', () => {
    const notice = createNoticeStore({
      initial: 'acknowledged',
      live: { start: () => {}, resume: () => {} },
      refetchAll: () => {},
      resetNotice: () => {
        throw new Error('reset failed')
      },
      fetchNotice: () => {},
      post: () => {},
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const second = vi.fn()
    notice.subscribe(() => {
      throw new Error('listener failed')
    })
    const stop = notice.subscribe(() => {})
    notice.subscribe(second)
    stop()
    notice.required()
    expect(notice.standing()).toBe('required')
    expect(second).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledTimes(2)
    logged.mockRestore()
  })
})
