// Settings and its Privacy section, rendered with react-dom/server in Node inside the shell (C0.9
// PD-47; PDPA-02 "always available in Settings", PDPA-03). How they lay out at each width is the
// e2e suite's (shell.spec.ts NTE-01).
import type { NoticeForClient } from '@hearth/shared'
import { createMemoryHistory } from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App } from '@/app/App.tsx'
import { formattersFor } from '@/lib/time.ts'
import { createLiveStore } from '@/live/live-status.ts'
import { APP_PATHS } from '@/router/paths.ts'
import { createAppRouter } from '@/router/router.tsx'
import { createNoticeStore } from '@/session/notice.ts'
import { createQueryClient } from '@/session/query-client.ts'
import type { SessionRuntime } from '@/session/runtime.ts'
import { aiCopyIn } from '@/strings/ai-copy.ts'
import { SETTINGS_SECTIONS } from './sections.ts'

// Marcus, from the Tembusu seed (db/seed/tembusu.sql), who has acknowledged its notice.
const MARCUS = {
  personId: 'b0000000-0000-4000-8000-000000000003',
  name: 'Marcus Lim',
  timeZone: 'Asia/Singapore',
  capabilities: { registers: false },
  notice: 'acknowledged' as const,
}

const ACKNOWLEDGED: NoticeForClient = {
  person: MARCUS.personId,
  standing: 'acknowledged',
  current: {
    id: 'e0000000-0000-4000-8000-000000000001',
    version: 1,
    publishedAt: '2026-10-23T01:00:00.000Z',
    body: '## About this notice\n\nThis notice tells you what personal data Hearth processes.\n\n### Backups\n- Kept for: 35 days.',
  },
  changes: null,
  mine: [
    { version: 1, acknowledgedAt: '2026-10-23T03:00:00.000Z', method: 'in_app' },
    { version: 0, acknowledgedAt: '2026-10-01T03:00:00.000Z', method: 'recorded_by_dpo' },
  ],
}

async function appAt(path: string, notice?: NoticeForClient): Promise<string> {
  const queryClient = createQueryClient(() => {})
  queryClient.setQueryData(['session'], MARCUS)
  if (notice !== undefined) queryClient.setQueryData(['notice'], notice)
  const noop = () => {}
  const runtime = {
    info: MARCUS,
    queryClient,
    formatters: formattersFor(MARCUS.timeZone),
    live: createLiveStore('live'),
    notice: createNoticeStore({
      initial: 'acknowledged',
      live: { start: noop, resume: noop },
      refetchAll: noop,
      resetNotice: noop,
      fetchNotice: noop,
      refreshNotice: noop,
      post: noop,
    }),
    signOut: async () => 'ended',
    end: noop,
  } as unknown as SessionRuntime
  const router = createAppRouter({ runtime, storage: undefined }, createMemoryHistory({ initialEntries: [path] }))
  await router.load()
  return renderToStaticMarkup(<App router={router} runtime={runtime} />).replace(/<script\b.*?<\/script>/gs, '')
}

const textsOf = (markup: string, tag: string) =>
  [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*>(.*?)</${tag}>`, 'gs'))].map(match =>
    (match[1] ?? '').replace(/<[^>]+>/g, '').replaceAll('&#x27;', "'"),
  )

// The screen's own part: what #screen holds, up to the toasts' region after it.
const screenOf = (markup: string) =>
  markup.slice(markup.indexOf('id="screen"'), markup.indexOf('aria-label="Notifications"'))

describe('C0.9 PD-47: Settings (settings/)', () => {
  it('NTW-08 PD-47 PDPA-02: the registry lists Privacy, an app path; /settings is its h1 and a 56 px link per section with its title and line', async () => {
    expect(SETTINGS_SECTIONS.map(section => [section.id, section.path, section.title])).toEqual([
      ['privacy', '/settings/privacy', 'Privacy'],
    ])
    for (const section of SETTINGS_SECTIONS) expect(APP_PATHS as readonly string[]).toContain(section.path)
    const markup = await appAt('/settings')
    expect(textsOf(markup, 'h1')).toEqual(['Settings'])
    const screen = screenOf(markup)
    expect(screen).toMatch(/<nav aria-label="Settings sections">/)
    const links = [...screen.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gs)].map(match => ({
      href: match[1]?.match(/href="([^"]*)"/)?.[1],
      text: (match[2] ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
      tall: (match[1] ?? '').includes('min-h-14'),
    }))
    expect(links).toEqual([
      { href: '/settings/privacy', text: 'Privacy The privacy notice, and when you acknowledged it', tall: true },
    ])
  })

  it('NTW-08 PDPA-03: /settings/privacy shows the current notice, when and how you acknowledged it, and your acknowledgements newest first', async () => {
    const markup = await appAt('/settings/privacy', ACKNOWLEDGED)
    expect(textsOf(markup, 'h1')).toEqual(['Privacy'])
    const screen = screenOf(markup)
    expect(textsOf(screen, 'h2')).toEqual(['Privacy notice', 'Your acknowledgements'])
    // The body's sections sit under the card's h2.
    expect(textsOf(screen, 'h3')).toEqual(['About this notice'])
    expect(textsOf(screen, 'h4')).toEqual(['Backups'])
    expect(textsOf(screen, 'p')).toEqual(
      expect.arrayContaining([
        'Version 1 · published Fri 23 Oct 2026',
        'You acknowledged version 1 on Fri 23 Oct 2026 (in the app).',
      ]),
    )
    expect(textsOf(screen, 'li').slice(-2)).toEqual([
      'Version 1, Fri 23 Oct 2026 (in the app)',
      'Version 0, Thu 1 Oct 2026 (recorded by the Data Protection Officer)',
    ])
    expect(
      textsOf(screen, 'p')
        .concat(textsOf(screen, 'li'))
        .filter(text => aiCopyIn(text) !== undefined),
    ).toEqual([])
  })

  it('NTW-08: before an answer it says it is loading; with none published, so; with none acknowledged, so', async () => {
    expect(screenOf(await appAt('/settings/privacy'))).toMatch(/<p role="status"[^>]*>Loading the notice…<\/p>/)
    const none = screenOf(
      await appAt('/settings/privacy', { ...ACKNOWLEDGED, standing: 'unpublished', current: null, mine: [] }),
    )
    expect(textsOf(none, 'p')).toEqual([
      'No privacy notice has been published yet.',
      'You haven’t acknowledged a version yet.',
    ])
    const notYet = screenOf(await appAt('/settings/privacy', { ...ACKNOWLEDGED, standing: 'required', mine: [] }))
    expect(textsOf(notYet, 'p')).toContain('You haven’t acknowledged version 1 yet.')
  })
})
