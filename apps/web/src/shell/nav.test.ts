import { describe, expect, it, vi } from 'vitest'
import { APP_PATHS } from '@/router/paths.ts'
import { aiCopyIn } from '@/strings/ai-copy.ts'
import { AVATAR_MENU, signOutItem } from './avatar-menu.ts'
import { activeTab, currentOf, MORE_ENTRIES, NAV, RAIL, TABS } from './nav.ts'

// The toast the sign-out item raises when the sign-out fails, without the app's store.
const toasts = vi.hoisted(() => [] as unknown[])
vi.mock('@/ui/toast.ts', () => ({ toast: (input: unknown) => toasts.push(input) }))

describe('T21 OD-02: the navigation (shell/nav.ts)', () => {
  it('NV-01 OD-02 PRD §6.1: tabs Today, Chats, Rooms, Tasks, More in order; the rail Today, Chats, Rooms, Tasks, Calendar, Drive; More lists Calendar and Drive', () => {
    expect(TABS.map(entry => entry.label)).toEqual(['Today', 'Chats', 'Rooms', 'Tasks', 'More'])
    expect(RAIL.map(entry => entry.label)).toEqual(['Today', 'Chats', 'Rooms', 'Tasks', 'Calendar', 'Drive'])
    expect(MORE_ENTRIES.map(entry => entry.label)).toEqual(['Calendar', 'Drive'])
    // Every entry is a registered app path, and every app path is reachable from both layouts.
    for (const entry of Object.values(NAV)) {
      expect(APP_PATHS as readonly string[], entry.id).toContain(entry.to)
      expect(entry.to, entry.id).toBe(`/${entry.id}`)
    }
    const phone = new Set([...TABS, ...MORE_ENTRIES].map(entry => entry.to))
    const rail = new Set(RAIL.map(entry => entry.to))
    for (const path of APP_PATHS) {
      expect(phone.has(path), path).toBe(true)
      if (path !== '/more') expect(rail.has(path), path).toBe(true)
    }
  })

  it('NV-02 T21 item 5 PRD:128 Principle 3: no AI, Ask, assistant or agent entry or path', () => {
    for (const entry of Object.values(NAV)) {
      expect(aiCopyIn(entry.label), entry.id).toBeUndefined()
      expect(aiCopyIn(entry.to.replaceAll('/', ' ')), entry.id).toBeUndefined()
    }
    // By whole segment: "tasks" holds "ask" and is no AI path.
    const named = (path: string) =>
      path.split('/').some(segment => /^(?:ask|assistants?|agents?|ai|co-?pilots?)$/i.test(segment))
    expect(APP_PATHS.filter(named)).toEqual([])
    expect(['/ask', '/agents', '/ai/x'].every(named)).toBe(true)
  })

  it('NV-03 T21 item 5: on phones Calendar and Drive mark More active; on the rail they mark themselves and More marks nothing; an unknown path marks nothing', () => {
    expect(activeTab('/calendar', 'phone')).toBe('more')
    expect(activeTab('/drive', 'phone')).toBe('more')
    expect(activeTab('/more', 'phone')).toBe('more')
    expect(activeTab('/calendar', 'rail')).toBe('calendar')
    expect(activeTab('/drive', 'rail')).toBe('drive')
    expect(activeTab('/more', 'rail')).toBeUndefined()
    for (const entry of TABS) expect(activeTab(entry.to, 'phone')).toBe(entry.id)
    for (const entry of RAIL) expect(activeTab(entry.to, 'rail')).toBe(entry.id)
    for (const path of ['/', '/xyz', '/chats/abc', '/sign-in', '/todayx']) {
      expect(activeTab(path, 'phone'), path).toBeUndefined()
      expect(activeTab(path, 'rail'), path).toBeUndefined()
    }
    // A trailing slash is the same place.
    expect(activeTab('/chats/', 'phone')).toBe('chats')
  })

  it('NV-05 WCAG 4.1.2: aria-current is "page" only on the link to the page shown; More holding Calendar or Drive on a phone is "true"', () => {
    for (const path of ['/calendar', '/drive', '/drive/']) {
      expect(currentOf(NAV.more, path, 'phone'), path).toBe('true')
      expect(
        TABS.filter(entry => entry.id !== 'more').map(entry => currentOf(entry, path, 'phone')),
        path,
      ).toEqual([undefined, undefined, undefined, undefined])
    }
    expect(currentOf(NAV.more, '/more', 'phone')).toBe('page')
    for (const entry of TABS) expect(currentOf(entry, entry.to, 'phone'), entry.id).toBe('page')
    for (const entry of RAIL) {
      expect(currentOf(entry, entry.to, 'rail'), entry.id).toBe('page')
      expect(currentOf(entry, `${entry.to}/`, 'rail'), entry.id).toBe('page')
    }
    for (const path of ['/xyz', '/chats/abc', '/more']) {
      expect(RAIL.map(entry => currentOf(entry, path, 'rail')).filter(Boolean), path).toEqual([])
    }
    expect(TABS.map(entry => currentOf(entry, '/xyz', 'phone')).filter(Boolean)).toEqual([])
  })

  it('NV-04 OD-05: AVATAR_MENU’s only C0.8 entry is Sign out, which asks the runtime to sign out and says so only when that failed', async () => {
    expect(AVATAR_MENU.map(item => item.label)).toEqual(['Sign out'])
    const runtime = (answer: 'ended' | 'failed') =>
      ({ signOut: vi.fn(async () => answer) }) as unknown as Parameters<typeof signOutItem.run>[0]

    const ended = runtime('ended')
    await signOutItem.run(ended)
    expect(ended.signOut).toHaveBeenCalledTimes(1)
    expect(toasts).toEqual([])

    const failed = runtime('failed')
    await signOutItem.run(failed)
    expect(toasts).toEqual([{ tone: 'error', text: "Couldn't sign out. Check your connection and try again." }])
  })
})
