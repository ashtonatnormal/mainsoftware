// /notice and its body, rendered with react-dom/server in Node (C0.9 PD-33, PD-46; TECH-SPEC T22
// items 22 and 31): the app's root over a router loaded at /notice, as the boot renders it, with a
// stand-in runtime whose QueryClient holds GET /api/notice's answer. How it behaves in a browser
// (focus, polling, acknowledging) is the e2e suite's (sign-in.spec.ts SI-10, session-end.spec.ts
// SE-05).
import type { NoticeForClient, NoticeStanding } from '@hearth/shared'
import { createMemoryHistory } from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App } from '@/app/App.tsx'
import { formattersFor } from '@/lib/time.ts'
import { createLiveStore } from '@/live/live-status.ts'
import { createAppRouter } from '@/router/router.tsx'
import { createNoticeStore } from '@/session/notice.ts'
import { createQueryClient } from '@/session/query-client.ts'
import type { SessionRuntime } from '@/session/runtime.ts'
import { aiCopyIn } from '@/strings/ai-copy.ts'
import { NoticeBody, parseNotice } from './NoticeBody.tsx'
import { changeLines, noticeView } from './notice-model.ts'

// Nadia, from the Tembusu seed (db/seed/tembusu.sql): she hasn't acknowledged its notice.
const NADIA = {
  personId: 'b0000000-0000-4000-8000-000000000004',
  name: 'Nadia Rahman',
  timeZone: 'Asia/Singapore',
  capabilities: { registers: false },
  notice: 'required' as NoticeStanding,
}

const BODY = [
  '## About this notice',
  '',
  'This notice tells you what personal data Hearth processes.',
  '',
  '## Why your data is processed',
  '',
  '### Backups',
  '- Legal basis: the employment exception.',
  '- Kept for: 35 days.',
  '',
  '- A second list.',
].join('\n')

function answer(standing: NoticeStanding, extra: Partial<NoticeForClient> = {}): NoticeForClient {
  return {
    person: NADIA.personId,
    standing,
    current:
      standing === 'unpublished'
        ? null
        : {
            id: 'e0000000-0000-4000-8000-000000000001',
            version: 3,
            publishedAt: '2026-10-23T01:00:00.000Z',
            body: BODY,
          },
    contact: null,
    changes: null,
    mine: [],
    ...extra,
  }
}

function runtime(person: typeof NADIA, noticeAnswer: NoticeForClient | undefined): SessionRuntime {
  const queryClient = createQueryClient(() => {})
  queryClient.setQueryData(['session'], person)
  if (noticeAnswer !== undefined) queryClient.setQueryData(['notice'], noticeAnswer)
  const noop = () => {}
  return {
    info: person,
    queryClient,
    formatters: formattersFor(person.timeZone),
    live: createLiveStore('connecting'),
    notice: createNoticeStore({
      initial: person.notice,
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
}

async function noticeAt(noticeAnswer: NoticeForClient | undefined, person = NADIA): Promise<string> {
  const session = runtime(person, noticeAnswer)
  const router = createAppRouter(
    { runtime: session, storage: undefined },
    createMemoryHistory({ initialEntries: ['/notice'] }),
  )
  await router.load()
  return renderToStaticMarkup(<App router={router} runtime={session} />).replace(/<script\b.*?<\/script>/gs, '')
}

const textsOf = (markup: string, tag: string) =>
  [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*>(.*?)</${tag}>`, 'gs'))].map(match =>
    (match[1] ?? '')
      .replace(/<[^>]+>/g, '')
      .replaceAll('&#x27;', "'")
      .replaceAll('&amp;', '&'),
  )

const tags = (markup: string, tag: string) =>
  [...markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map(m => m[1] ?? '')

// What a reader meets: the text and every aria-label.
function readable(markup: string): string[] {
  const text = markup
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const names = [...markup.matchAll(/\baria-label="([^"]*)"/g)].map(match => match[1] ?? '')
  return [...text, ...names]
}

describe('C0.9 PD-33: the notice body (notice/NoticeBody.tsx)', () => {
  it('NTW-01 PD-33 WS-07: the line format reads into sections, entries, paragraphs and lists; a blank line ends a list; a bare or unspaced marker is a paragraph as written; nothing is dropped', () => {
    expect(parseNotice(BODY)).toEqual([
      { kind: 'section', text: 'About this notice' },
      { kind: 'paragraph', text: 'This notice tells you what personal data Hearth processes.' },
      { kind: 'section', text: 'Why your data is processed' },
      { kind: 'entry', text: 'Backups' },
      { kind: 'list', items: ['Legal basis: the employment exception.', 'Kept for: 35 days.'] },
      { kind: 'list', items: ['A second list.'] },
    ])
    expect(parseNotice('##No space\r\n## \r\n-x\n- \n#### Four\nPlain')).toEqual([
      { kind: 'paragraph', text: '##No space' },
      { kind: 'paragraph', text: '## ' },
      { kind: 'paragraph', text: '-x' },
      { kind: 'paragraph', text: '- ' },
      { kind: 'paragraph', text: '#### Four' },
      { kind: 'paragraph', text: 'Plain' },
    ])
    // A paragraph between items ends the list.
    expect(parseNotice('- a\nb\n- c')).toEqual([
      { kind: 'list', items: ['a'] },
      { kind: 'paragraph', text: 'b' },
      { kind: 'list', items: ['c'] },
    ])
  })

  it('NTW-01 WS-07: it renders text only, headings at the level asked and entries one below; markup in a body stays text', () => {
    const markup = renderToStaticMarkup(<NoticeBody body={`${BODY}\n\n<b>bold</b> & <script>x</script>`} />)
    expect(textsOf(markup, 'h2')).toEqual(['About this notice', 'Why your data is processed'])
    expect(textsOf(markup, 'h3')).toEqual(['Backups'])
    expect(markup.match(/<ul\b/g)).toHaveLength(2)
    expect(markup).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; &lt;script&gt;x&lt;/script&gt;')
    expect(markup).not.toMatch(/<b>|<script>/)
    const settings = renderToStaticMarkup(<NoticeBody body={BODY} level={3} />)
    expect(textsOf(settings, 'h3')).toEqual(['About this notice', 'Why your data is processed'])
    expect(textsOf(settings, 'h4')).toEqual(['Backups'])
    expect(settings).not.toMatch(/<h2\b/)
  })
})

describe('C0.9 PD-46: /notice (notice/NoticeScreen.tsx)', () => {
  it('NTW-07 PDPA-03 OD-04: required, it stands outside the shell with one h1, the version and its date, the body in a labelled focusable region, the box to tick at 44 px, Acknowledge and Sign out, and no Skip', async () => {
    const markup = await noticeAt(answer('required'))
    expect(tags(markup, 'main')).toHaveLength(1)
    expect(tags(markup, 'nav')).toEqual([])
    expect(markup).not.toMatch(/aria-haspopup="menu"/)
    expect(textsOf(markup, 'h1')).toEqual(['Privacy notice'])
    expect(textsOf(markup, 'p')).toContain('Version 3 · published Fri 23 Oct 2026')
    const region = tags(markup, 'section').find(attributes =>
      attributes.includes('aria-label="Privacy notice, version 3"'),
    )
    expect(region).toMatch(/tabindex="0"/)
    expect(region).toMatch(/overflow-y-auto/)
    expect(textsOf(markup, 'h2')).toEqual(['About this notice', 'Why your data is processed'])
    const box = tags(markup, 'input').find(attributes => attributes.includes('type="checkbox"'))
    expect(box).toBeDefined()
    expect(box).not.toMatch(/\bchecked\b/)
    expect(markup).toMatch(/class="relative flex min-h-11[^"]*"/)
    expect(textsOf(markup, 'span')).toContain('I’ve read the privacy notice, version 3.')
    expect(textsOf(markup, 'button')).toEqual(['Acknowledge', 'Sign out'])
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*min-h-12[^>]*>Acknowledge<\/button>/)
    expect(readable(markup).filter(text => /\bskip\b/i.test(text))).toEqual([])
    expect(readable(markup).filter(text => aiCopyIn(text) !== undefined)).toEqual([])
  })

  it('NTW-07 PD-46: what changed since the last version acknowledged shows above the body, worded by purpose and provider', async () => {
    const markup = await noticeAt(
      answer('required', {
        changes: {
          since: 2,
          purposes: { added: ['backups'], changed: ['accounts'], removed: [] },
          providers: { added: [], changed: ['twilio'], removed: ['livekit'] },
          contact: 'same',
          wording: true,
        },
      }),
    )
    expect(textsOf(markup, 'h2')[0]).toBe('What’s changed since version 2')
    expect(textsOf(markup, 'li').slice(0, 4)).toEqual([
      'Backups',
      'Accounts and sign-in: the roster, phone numbers and one-time codes, devices, profiles',
      'Twilio Verify',
      'LiveKit Cloud',
    ])
    expect(textsOf(markup, 'p')).toEqual(
      expect.arrayContaining(['Now listed', 'Changed', 'No longer listed', 'The notice’s wording has changed.']),
    )
    // Nothing it can name changed: no callout.
    expect(
      changeLines({
        since: 1,
        purposes: { added: [], changed: [], removed: [] },
        providers: { added: [], changed: [], removed: [] },
        contact: 'same',
        wording: false,
      }),
    ).toBeUndefined()
  })

  it('NTW-07 OD-11 PD-67: a new contact, or the contact given for the first time, is a line of its own after the lists and before the wording, and alone is enough to show the callout', async () => {
    const none = { added: [], changed: [], removed: [] }
    for (const [contact, line] of [
      ['changed', 'The Data Protection Officer’s contact details have changed.'],
      ['added', 'The notice now gives the Data Protection Officer’s contact details.'],
    ] as const) {
      const changes = { since: 2, purposes: none, providers: none, contact, wording: false }
      expect(changeLines(changes)?.contact).toBe(contact)
      const markup = await noticeAt(answer('required', { changes }))
      expect(textsOf(markup, 'h2')[0]).toBe('What’s changed since version 2')
      expect(textsOf(markup, 'p')).toContain(line)
      // Nothing listed above the body: the contact's line alone.
      expect(textsOf(markup.slice(0, markup.indexOf('aria-label="Privacy notice, version 3"')), 'li')).toEqual([])
    }
    const both = await noticeAt(
      answer('required', {
        changes: {
          since: 2,
          purposes: { added: ['backups'], changed: [], removed: [] },
          providers: none,
          contact: 'changed',
          wording: true,
        },
      }),
    )
    const callout = both.slice(0, both.indexOf('aria-label="Privacy notice, version 3"'))
    const at = (text: string) => callout.indexOf(text)
    expect(at('Backups')).toBeLessThan(at('The Data Protection Officer’s contact details have changed.'))
    expect(at('The Data Protection Officer’s contact details have changed.')).toBeLessThan(
      at('The notice’s wording has changed.'),
    )
  })

  it('NTW-07 OD-01 PD-68: before any version, the DPO is offered the notice tab, their contact details and the register, in that order, anyone else is told Hearth isn’t open yet; both can sign out', async () => {
    const member = await noticeAt(answer('unpublished'))
    expect(textsOf(member, 'h1')).toEqual(['Privacy notice'])
    expect(textsOf(member, 'h2')).toEqual(['Hearth isn’t open yet'])
    expect(textsOf(member, 'button')).toEqual(['Sign out'])
    expect(member).not.toMatch(/href="\/dpo/)

    const dpo = await noticeAt(answer('unpublished'), { ...NADIA, capabilities: { registers: true } })
    expect(textsOf(dpo, 'h2')).toEqual(['Publish the privacy notice'])
    expect(dpo).toMatch(/<a\b[^>]*href="\/dpo\/notice"[^>]*>Publish the notice<\/a>/)
    expect(dpo).toMatch(/<a\b[^>]*href="\/dpo\/purposes"[^>]*>Open the processing register<\/a>/)
    expect(
      [...dpo.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map(match => [
        match[1],
        match[2]?.replaceAll('&#x27;', "'"),
      ]),
    ).toEqual([
      ['/dpo/notice', 'Publish the notice'],
      ['/dpo/contact', 'Record your contact details'],
      ['/dpo/purposes', 'Open the processing register'],
    ])
    expect(textsOf(dpo, 'p')).toContain(
      'Nobody can use Hearth until the notice is published. Record your contact details and each purpose’s legal basis and how long its data is kept, then publish the notice.',
    )
    expect(textsOf(dpo, 'button')).toEqual(['Sign out'])
  })

  it('NTW-07 PD-46: already acknowledged, it says when and offers Continue; loading and failed say so', async () => {
    const markup = await noticeAt(
      answer('acknowledged', {
        mine: [
          {
            version: 3,
            acknowledgedAt: '2026-10-23T02:00:00.000Z',
            method: 'in_app',
            acknowledgedOn: null,
            note: null,
          },
          {
            version: 2,
            acknowledgedAt: '2026-09-01T02:00:00.000Z',
            method: 'in_app',
            acknowledgedOn: null,
            note: null,
          },
        ],
      }),
    )
    expect(textsOf(markup, 'p')).toContain('You acknowledged version 3 on Fri 23 Oct 2026.')
    expect(textsOf(markup, 'button')).toEqual(['Continue'])
    expect(tags(markup, 'input')).toEqual([])

    const loading = await noticeAt(undefined)
    expect(loading).toMatch(/<p role="status"[^>]*>Loading the notice…<\/p>/)
    expect(noticeView(undefined, true, false)).toEqual({ kind: 'failed' })
    expect(noticeView(answer('required'), false, false).kind).toBe('required')
    // A published version is never shown as unpublished, nor a missing one as required.
    expect(noticeView({ ...answer('required'), current: null }, false, true)).toEqual({
      kind: 'unpublished',
      dpo: true,
    })
  })
})
