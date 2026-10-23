// The DPO pages and their dialogs, rendered with react-dom/server in Node (C0.9 PD-26, PD-27;
// T21, D-03): the app's root over a router at /dpo/purposes, /dpo/transfers, /dpo/contact (C0.9
// PR 3a, PD-70) or /dpo/notice with the answers in the person's Query cache, and each dialog and
// refusal on its own. What the markup holds (the h1, the links between the pages, the cards, names,
// held buttons, the fields each basis takes, the contact's fields and the record dialog's) is
// checked here; how it behaves in a browser is dpo.spec.ts's.

import { MESSAGES, REAUTH_METHOD_MESSAGES } from '@hearth/shared'
import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiFailure } from '@/api/http.ts'
import { App } from '@/app/App.tsx'
import { RuntimeContext } from '@/app/runtime-context.ts'
import { formattersFor } from '@/lib/time.ts'
import { createLiveStore } from '@/live/live-status.ts'
import { createAppRouter } from '@/router/router.tsx'
import { createNoticeStore } from '@/session/notice.ts'
import { createQueryClient } from '@/session/query-client.ts'
import type { SessionRuntime } from '@/session/runtime.ts'
import { aiCopyIn } from '@/strings/ai-copy.ts'
import { DPO } from '@/strings/dpo.ts'
import { CONTACT } from '@/strings/dpo-contact.ts'
import { NOTICE_MARKERS, NOTICE_TAB } from '@/strings/dpo-notice.ts'
import { PURPOSES_COPY } from '@/strings/dpo-purposes.ts'
import { RECORD } from '@/strings/dpo-record.ts'
import { PROVIDER_CHECKS, TRANSFERS_COPY } from '@/strings/dpo-transfers.ts'
import { SHELL } from '@/strings/shell.ts'
import { ContactDialog } from './ContactScreen.tsx'
import { PurposeDialog } from './PurposesScreen.tsx'
import { contactQuery, noticeAdminQuery, noticePeopleQuery, registersQuery } from './queries.ts'
import { RecordDialog } from './RecordAcknowledgement.tsx'
import { ReadRefusal } from './RegisterPage.tsx'
import { ClearDialog, TransferDialog, WithdrawDialog } from './TransfersScreen.tsx'
import {
  COMPLETE_FACTS,
  contactAdminForClient,
  contactRow,
  NO_CONTACT_DRAFT,
  noticeAdminForClient,
  noticePeopleForClient,
  registersForClient,
  TODAY,
} from './testing/registers.ts'

// Ashton, the Tembusu seed's Owner and DPO (db/seed/tembusu.sql).
const ASHTON = {
  personId: 'b0000000-0000-4000-8000-000000000001',
  name: 'Ashton Teo',
  timeZone: 'Asia/Singapore',
  capabilities: { registers: true },
  notice: 'acknowledged' as const,
}

const CLEARED = {
  clearedOn: '2026-10-02',
  clearedBy: 'Ashton Teo',
  clearedVia: 'app',
  revision: 2,
  withdrawnOn: null,
  withdrawnBy: null,
  withdrawReason: null,
} as const

const REGISTERS = registersForClient(
  { security_audit: { version: 2, basis: 'legitimate_interests', basisReference: 'DPO file', retention: '13 months' } },
  { twilio: { ...COMPLETE_FACTS, revision: 2, clearance: CLEARED } },
)

const purpose = (key: string) => {
  const row = REGISTERS.purposes.find(each => each.purpose === key)
  if (row === undefined) throw new Error(`no ${key} in the fixture`)
  return row
}
const transfer = (key: string) => {
  const row = REGISTERS.transfers.find(each => each.provider === key)
  if (row === undefined) throw new Error(`no ${key} in the fixture`)
  return row
}

type NoticeAdmin = ReturnType<typeof noticeAdminForClient>

// Other answers in the cache: the contact page's (C0.9 PD-70) and the record dialog's people (PD-76).
interface Cached {
  readonly contact?: ReturnType<typeof contactAdminForClient>
  readonly people?: ReturnType<typeof noticePeopleForClient>
  // The people's read failed, with this.
  readonly peopleFailed?: ApiFailure
}

function runtime(registers?: typeof REGISTERS, notice?: NoticeAdmin, cached: Cached = {}): SessionRuntime {
  const queryClient = createQueryClient(() => {})
  queryClient.setQueryData(['session'], ASHTON)
  if (registers !== undefined) queryClient.setQueryData(registersQuery.queryKey, registers)
  if (notice !== undefined) queryClient.setQueryData(noticeAdminQuery.queryKey, notice)
  if (cached.contact !== undefined) queryClient.setQueryData(contactQuery.queryKey, cached.contact)
  if (cached.people !== undefined) queryClient.setQueryData(noticePeopleQuery.queryKey, cached.people)
  if (cached.peopleFailed !== undefined) {
    // A failed read stays failed as the dialog mounts (no retry on mount), as it shows once the
    // browser's first fetch has failed.
    queryClient.setQueryDefaults(noticePeopleQuery.queryKey, { retryOnMount: false })
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: noticePeopleQuery.queryKey })
      .setState({ status: 'error', error: cached.peopleFailed, fetchStatus: 'idle' })
  }
  const noop = () => {}
  return {
    info: ASHTON,
    queryClient,
    formatters: formattersFor(ASHTON.timeZone),
    live: createLiveStore('live'),
    // Ashton has acknowledged the current notice, so the shell's guard lets every path through.
    notice: createNoticeStore({
      initial: ASHTON.notice,
      live: { start: noop, resume: noop },
      refetchAll: noop,
      resetNotice: noop,
      fetchNotice: noop,
      refreshNotice: noop,
      post: noop,
    }),
    signOut: async () => 'ended',
    end: () => {},
  } as unknown as SessionRuntime
}

async function appAt(
  path: string,
  registers: typeof REGISTERS | null = REGISTERS,
  notice?: NoticeAdmin,
  cached: Cached = {},
): Promise<string> {
  const session = runtime(registers ?? undefined, notice, cached)
  const router = createAppRouter(
    { runtime: session, storage: undefined },
    createMemoryHistory({ initialEntries: [path] }),
  )
  await router.load()
  return renderToStaticMarkup(<App router={router} runtime={session} />).replace(/<script\b.*?<\/script>/gs, '')
}

// A piece rendered on its own, inside what it reads: the person's QueryClient and runtime, and a
// router.
function alone(node: ReactNode, cached: Cached = {}): string {
  const session = runtime(REGISTERS, undefined, cached)
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ['/'] }) })
  return renderToStaticMarkup(
    <QueryClientProvider client={session.queryClient}>
      <RuntimeContext value={session}>
        <RouterContextProvider router={router}>{node}</RouterContextProvider>
      </RuntimeContext>
    </QueryClientProvider>,
  )
}

// The attributes of every element with this tag, in order (React's casing: autoComplete, inputMode).
function tags(markup: string, tag: string): Map<string, string>[] {
  return [...markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map(
    match => new Map([...(match[1] ?? '').matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(a => [a[1] ?? '', a[2] ?? ''])),
  )
}

const decoded = (text: string) =>
  text.replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&lt;', '<')

// The text of every element with this tag.
const textsOf = (markup: string, tag: string) =>
  [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*>(.*?)</${tag}>`, 'gs'))].map(match =>
    decoded((match[1] ?? '').replace(/<[^>]+>/g, '')),
  )

// What a reader meets: the text, and every aria-label, title and alt.
function readable(markup: string): string[] {
  const text = markup
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const names = [...markup.matchAll(/\b(?:aria-label|title|alt)="([^"]*)"/g)].map(match => match[1] ?? '')
  return [...text, ...names].map(decoded)
}

// The buttons, by their accessible name (aria-label, else the text), with whether each is held.
const buttons = (markup: string) =>
  [...markup.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].map(match => {
    const attributes = match[1] ?? ''
    const name = attributes.match(/aria-label="([^"]*)"/)?.[1] ?? (match[2] ?? '').replace(/<[^>]+>/g, '')
    return {
      name: decoded(name),
      held: /aria-disabled="true"/.test(attributes),
      type: attributes.match(/type="(\w+)"/)?.[1],
    }
  })

const optionsOf = (markup: string, name: string) => {
  const start = markup.search(new RegExp(`<select[^>]*name="${name}"`))
  return textsOf(markup.slice(start, markup.indexOf('</select>', start)), 'option')
}

describe('C0.9 PD-26: the DPO pages (dpo/)', () => {
  it('DPP-05 PDPA-01 PD-07 PD-27: /dpo/purposes is the shell’s page titled Processing register, with the links between the registers (Purposes current), a card per non-AI purpose with its status and an Edit named for it, the pinned purposes saying Hearth keeps them, and the two lines under the list', async () => {
    const markup = await appAt('/dpo/purposes')
    expect(textsOf(markup, 'h1')).toEqual(['Processing register'])
    const registers = tags(markup, 'nav').filter(nav => nav.get('aria-label') === 'Registers')
    expect(registers).toHaveLength(1)
    const links = [...markup.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gs)]
      .filter(match => /href="\/dpo\//.test(match[1] ?? ''))
      .map(match => [match[1]?.match(/href="([^"]*)"/)?.[1], match[1]?.match(/aria-current="([^"]*)"/)?.[1]])
    // The Registers links (C0.9 PD-48 adds the Notice tab's, PR 3a the contact page's), then the
    // banner's link to the Notice tab: on its first day the org has published no notice.
    expect(links).toEqual([
      ['/dpo/purposes', 'page'],
      ['/dpo/transfers', undefined],
      ['/dpo/contact', undefined],
      ['/dpo/notice', undefined],
      ['/dpo/notice', undefined],
    ])
    const cards = textsOf(markup, 'h2')
    expect(cards).toHaveLength(13)
    expect(cards[0]).toBe('Accounts and sign-in: the roster, phone numbers and one-time codes, devices, profiles')
    expect(cards).not.toContain('Transcribing sessions')
    expect(buttons(markup).filter(button => button.name.startsWith('Edit '))).toHaveLength(13)
    expect(buttons(markup).map(button => button.name)).toContain('Edit Security audit and monitoring')
    expect(markup.split(PURPOSES_COPY.pinned).length - 1).toBe(2)
    expect(readable(markup)).toEqual(
      expect.arrayContaining([PURPOSES_COPY.startsWhenNotified, PURPOSES_COPY.laterStages]),
    )
    // It claims nothing the cards contradict: the pinned purposes, security audit and backups show
    // as active before any notice exists, so the line sets them apart (T22 items 4 and 5).
    expect(PURPOSES_COPY.startsWhenNotified).toMatch(/^Apart from the purposes Hearth keeps active, /)
    expect(PURPOSES_COPY.startsWhenNotified).toContain('Hearth already keeps the audit log and backups.')
    expect(readable(markup).filter(text => aiCopyIn(text) !== undefined)).toEqual([])
    // No tab of the navigation claims the page.
    expect(
      tags(markup, 'a').filter(link => link.get('aria-current') && !link.get('href')?.startsWith('/dpo/')),
    ).toEqual([])
  })

  it('DPP-05 PDPA-10 PD-13 T22 item 3: /dpo/transfers is titled Transfer register, with a card per non-AI provider; Clear for use is held while facts are missing, a cleared provider offers Withdraw clearance, and each says what checks it', async () => {
    const markup = await appAt('/dpo/transfers')
    expect(textsOf(markup, 'h1')).toEqual(['Transfer register'])
    expect(textsOf(markup, 'h2')).toEqual([
      'Amazon Web Services',
      'AWS text messages',
      'Twilio Verify',
      'LiveKit Cloud',
      'Apple Push Notification service',
      'Firebase Cloud Messaging',
      'Mozilla Push Service',
      'Windows Push Notification Services',
    ])
    const all = buttons(markup)
    expect(all.filter(button => button.name === TRANSFERS_COPY.withdraw)).toEqual([
      { name: TRANSFERS_COPY.withdraw, held: false, type: 'button' },
    ])
    const clears = all.filter(button => button.name === TRANSFERS_COPY.clearForUse)
    expect(clears).toHaveLength(7)
    expect(clears.every(button => button.held)).toBe(true)
    expect(markup).toContain(TRANSFERS_COPY.clearHeld)
    expect(readable(markup)).toEqual(expect.arrayContaining(['Cleared on Fri 2 Oct 2026 by Ashton Teo']))
    expect(readable(markup).filter(text => aiCopyIn(text) !== undefined)).toEqual([])
  })

  it('DPP-05 T21 item 5: before the answer, the page says it is loading, in a status', async () => {
    const markup = await appAt('/dpo/purposes', null)
    expect(markup).toMatch(/<p role="status"[^>]*>Loading the register…<\/p>/)
    expect(textsOf(markup, 'h2')).toEqual([])
  })

  it('DPP-05 PD-11 PD-07: the purpose dialog offers only what can save: a pinned purpose its one status as text and no consent-type basis; one that needs a switch every status and no consent-type basis; a legitimate-interests entry its assessment field', () => {
    const accounts = alone(<PurposeDialog row={purpose('accounts')} onClose={() => {}} />)
    expect(textsOf(accounts, 'h2')[0]).toMatch(/^Edit Accounts and sign-in/)
    expect(tags(accounts, 'fieldset').length).toBe(1)
    expect(accounts).toContain('Status: </span>Active')
    expect(optionsOf(accounts, 'basis')).toEqual([
      'Not recorded',
      'Employment: managing the working relationship',
      'Legitimate interests',
      'Business improvement',
      'Another exception or legal requirement',
    ])

    const recording = alone(<PurposeDialog row={purpose('recording_meetings')} onClose={() => {}} />)
    expect(
      tags(recording, 'input')
        .filter(input => input.get('type') === 'radio')
        .map(input => input.get('value')),
    ).toEqual(['planned', 'active', 'retired'])
    expect(optionsOf(recording, 'basis')).not.toEqual(expect.arrayContaining(['Consent']))

    const audit = alone(<PurposeDialog row={purpose('security_audit')} onClose={() => {}} />)
    expect(textsOf(audit, 'label')).toEqual(
      expect.arrayContaining(['Where the legitimate interests assessment is kept', 'How long it’s kept']),
    )
    expect(textsOf(audit, 'label')).not.toContain('Opt-out window (days)')
    // Eight providers to choose from, none of the AI layer's; every control's text at 16 px.
    expect(tags(audit, 'input').filter(input => input.get('type') === 'checkbox')).toHaveLength(8)
    for (const control of [...tags(audit, 'textarea'), ...tags(audit, 'select')]) {
      expect(control.get('class')).toMatch(/\btext-base\b/)
    }
    // A complete entry: Save acts, and nothing is listed as blocking it.
    expect(buttons(audit).find(button => button.name === 'Save')).toMatchObject({ held: false, type: 'submit' })
    expect(audit).not.toContain(DPO.beforeSaving)
  })

  it('DPP-05 PD-05 PD-12: the transfer dialog of a cleared provider offers Save and keep cleared as its submit and a plain Save beside it; of one not cleared, Save alone, with what is still needed before clearing', () => {
    const twilio = transfer('twilio')
    const cleared = alone(<TransferDialog row={twilio} today={TODAY} onClose={() => {}} />)
    expect(buttons(cleared).filter(button => button.name !== 'Close')).toEqual([
      { name: 'Cancel', held: false, type: 'button' },
      { name: 'Save', held: false, type: 'button' },
      { name: 'Save and keep cleared', held: false, type: 'submit' },
    ])
    expect(cleared).toContain(TRANSFERS_COPY.nothingNeeded)
    expect(textsOf(cleared, 'label')).toEqual(
      expect.arrayContaining(['Countries it processes the data in', 'Review by']),
    )
    // The countries' names show as the field's hint.
    expect(cleared).toContain('Ireland, United States')

    const apple = transfer('apple_push')
    const empty = alone(<TransferDialog row={apple} today={TODAY} onClose={() => {}} />)
    expect(
      buttons(empty)
        .filter(button => button.name !== 'Close')
        .map(button => [button.name, button.type]),
    ).toEqual([
      ['Cancel', 'button'],
      ['Save', 'submit'],
    ])
    expect(empty).toContain(TRANSFERS_COPY.stillNeeded)
    expect(textsOf(empty, 'li')).toEqual(expect.arrayContaining(['What it’s used for', 'A review date']))
    for (const markup of [cleared, empty]) {
      expect(readable(markup).filter(text => aiCopyIn(text) !== undefined)).toEqual([])
    }
  })

  it('DPP-05 T22 item 3: the confirmations say what clearing records and what withdrawing stops, for Twilio Verify every sign-in code', () => {
    const twilio = transfer('twilio')
    const withdraw = alone(<WithdrawDialog row={twilio} today={TODAY} onClose={() => {}} />)
    expect(textsOf(withdraw, 'h2')).toEqual(['Withdraw Twilio Verify’s clearance?'])
    expect(withdraw).toContain('Nobody can get a sign-in code')
    expect(buttons(withdraw).map(button => button.name)).toEqual(['Close', 'Cancel', 'Withdraw clearance'])

    const aws = transfer('aws')
    const clear = alone(<ClearDialog row={aws} today={TODAY} onClose={() => {}} />)
    expect(textsOf(clear, 'h2')).toEqual(['Clear Amazon Web Services for use?'])
    expect(textsOf(clear, 'p')).toEqual([TRANSFERS_COPY.confirmClear.body, PROVIDER_CHECKS.aws.checkedBy])
  })

  it('DPP-05 PD-20 PD-30: a refused read shows the PIN step (a current-password PIN field, paste allowed), a new sign-in, or the DPO-only line', () => {
    const pin = alone(<ReadRefusal refusal={{ kind: 'pin' }} retry={() => {}} />)
    const field = tags(pin, 'input').find(input => input.get('name') === 'pin')
    expect(field?.get('autoComplete')).toBe('current-password')
    expect(field?.get('inputMode')).toBe('numeric')
    expect(textsOf(pin, 'label')).toEqual(['Your PIN'])
    expect(readable(pin)).toEqual(expect.arrayContaining([REAUTH_METHOD_MESSAGES.pin.method]))
    expect(buttons(pin).find(button => button.name === 'Confirm')).toMatchObject({ type: 'submit', held: false })

    const signIn = alone(<ReadRefusal refusal={{ kind: 'sign_in', text: 'Sign in again.' }} retry={() => {}} />)
    expect(buttons(signIn).map(button => button.name)).toEqual(['Sign out'])

    const forbidden = alone(<ReadRefusal refusal={{ kind: 'forbidden', text: DPO.forbidden }} retry={() => {}} />)
    expect(textsOf(forbidden, 'h2')).toEqual(['This page is for the Data Protection Officer.'])
  })
})

// The Registers links' targets, with which is current.
const registerLinks = (markup: string) => {
  const start = markup.indexOf('<nav aria-label="Registers"')
  const nav = markup.slice(start, markup.indexOf('</nav>', start))
  return [...nav.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gs)].map(match => ({
    href: match[1]?.match(/href="([^"]*)"/)?.[1],
    current: match[1]?.match(/aria-current="([^"]*)"/)?.[1],
    text: decoded(
      (match[2] ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    ),
  }))
}

describe('C0.9 PD-48 B-12: the Notice tab and the register pages’ notice markers (dpo/)', () => {
  it('NTW-09 PD-48 PDPA-03: /dpo/notice is the shell’s page titled Publish the notice (not /notice’s title) under the Registers links (Notice current): the published version with its status and a count of acknowledgements, what the next version changes and warns of, Publish acting, the words under h3s as text, and the versions published', async () => {
    const markup = await appAt('/dpo/notice', REGISTERS, noticeAdminForClient())
    expect(textsOf(markup, 'h1')).toEqual(['Publish the notice'])
    expect(SHELL.dpo.notice).not.toBe(SHELL.notice)
    expect(registerLinks(markup)).toEqual([
      { href: '/dpo/purposes', current: undefined, text: 'Purposes' },
      { href: '/dpo/transfers', current: undefined, text: 'Transfers' },
      { href: '/dpo/contact', current: undefined, text: 'Contact' },
      { href: '/dpo/notice', current: 'page', text: 'Notice' },
    ])
    expect(textsOf(markup, 'h2')).toEqual([
      'The published notice',
      'Publishing version 1',
      'Preview of version 1',
      'Published versions',
    ])
    const text = readable(markup)
    expect(text).toEqual(
      expect.arrayContaining([
        'Out of date',
        'Version 0, published Wed 21 Oct 2026 by Ashton Teo.',
        '9 of the 12 people at the organisation have acknowledged version 0.',
        NOTICE_TAB.draft.changes,
        'Backups',
        NOTICE_TAB.draft.warnings,
      ]),
    )
    expect(buttons(markup).find(button => button.name === 'Publish version 1')).toMatchObject({ held: false })
    // Beside the count, once a version is published (C0.9 OD-19).
    expect(buttons(markup).find(button => button.name === RECORD.open)).toMatchObject({ held: false, type: 'button' })
    // The words, drawn by /notice's reader one level down, as text: no markup of their own.
    expect(textsOf(markup, 'h3')).toEqual(['About this notice', 'Why your data is processed', 'Your rights'])
    expect(textsOf(markup, 'h4')).toEqual(['Accounts and sign-in'])
    expect(tags(markup, 'section').some(section => section.get('aria-label') === NOTICE_TAB.preview.label('1'))).toBe(
      true,
    )
    expect(text.filter(line => aiCopyIn(line) !== undefined)).toEqual([])
  })

  it('NTW-09 PD-37 C-05: with problems, the tab lists them under their purposes with a link to each register page that fixes them, holds Publish with the reason, and shows no words', async () => {
    const answer = noticeAdminForClient({
      draft: {
        version: 1,
        body: null,
        digest: null,
        problems: [
          { code: 'purpose_basis_missing', purpose: 'backups' },
          { code: 'free_text_ai_copy', provider: 'twilio', field: 'onward_recipients' },
        ],
        warnings: [],
        changes: null,
        upToDate: false,
      },
    })
    const markup = await appAt('/dpo/notice', REGISTERS, answer)
    expect(readable(markup)).toEqual(
      expect.arrayContaining([
        NOTICE_TAB.draft.problems,
        'Backups',
        'Record its legal basis.',
        'Twilio Verify',
        '“Who it passes the data on to” uses wording Hearth keeps off its screens. Reword it.',
        NOTICE_TAB.preview.hidden,
      ]),
    )
    const fixes = [...markup.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gs)]
      .filter(match => /Open the/.test(match[2] ?? ''))
      .map(match => [match[1]?.match(/href="([^"]*)"/)?.[1], decoded(match[2] ?? '')])
    expect(fixes).toEqual([
      ['/dpo/purposes', NOTICE_TAB.draft.toPurposes],
      ['/dpo/transfers', NOTICE_TAB.draft.toTransfers],
    ])
    expect(buttons(markup).find(button => button.name === 'Publish version 1')).toMatchObject({ held: true })
    expect(markup).toContain(DPO.fixFirst)
    expect(textsOf(markup, 'h3')).toEqual([])
    expect(readable(markup).filter(line => aiCopyIn(line) !== undefined)).toEqual([])
  })

  it('NTW-09 T21 item 5: before the answer, the Notice tab says it is loading, in a status, under the Registers links', async () => {
    const markup = await appAt('/dpo/notice', null)
    expect(markup).toMatch(/<p role="status"[^>]*>Loading the notice…<\/p>/)
    expect(registerLinks(markup).map(link => link.href)).toEqual([
      '/dpo/purposes',
      '/dpo/transfers',
      '/dpo/contact',
      '/dpo/notice',
    ])
    expect(textsOf(markup, 'h2')).toEqual([])
  })

  it('NTW-09 PD-40 PD-41 PD-48 PD-59 PD-61 B-04 B-12: the register pages badge the Notice link while the notice is out of date, show the banner (a stale pinned purpose listed by name), and mark the cards that wait for the next notice', async () => {
    const CLEARED = {
      clearedOn: '2026-10-02',
      clearedBy: 'Ashton Teo',
      clearedVia: 'app',
      revision: 2,
      withdrawnOn: null,
      withdrawnBy: null,
      withdrawReason: null,
    } as const
    const registers = registersForClient(
      { accounts: { version: 2, stale: true }, service_operation: { notified: true }, backups: { notified: true } },
      { twilio: { ...COMPLETE_FACTS, revision: 2, clearance: CLEARED, sendsWait: true } },
      'out_of_date',
    )
    const purposes = await appAt('/dpo/purposes', registers)
    expect(registerLinks(purposes).at(-1)).toEqual({
      href: '/dpo/notice',
      current: undefined,
      text: 'Notice Out of date',
    })
    expect(readable(purposes)).toEqual(
      expect.arrayContaining([
        NOTICE_MARKERS.banner.stale,
        'Accounts and sign-in: the roster, phone numbers and one-time codes, devices, profiles',
        NOTICE_MARKERS.banner.toNotice,
        NOTICE_MARKERS.pinnedStale,
      ]),
    )
    // security_audit is active, not pinned and not notified; backups is notified.
    expect(purposes.split(NOTICE_MARKERS.waitingForNotice).length - 1).toBe(1)
    expect(textsOf(purposes, 'h2')).toHaveLength(13)

    const transfers = await appAt('/dpo/transfers', registers)
    expect(registerLinks(transfers).at(-1)?.text).toBe('Notice Out of date')
    expect(transfers.split(NOTICE_MARKERS.sendsWaitTwilio).length - 1).toBe(1)
    expect(transfers).not.toContain(NOTICE_MARKERS.sendsWait)

    // Up to date: no badge and no banner.
    const upToDate = await appAt('/dpo/purposes', registersForClient({}, {}, 'up_to_date'))
    expect(registerLinks(upToDate).at(-1)?.text).toBe('Notice')
    expect(upToDate).not.toContain(NOTICE_MARKERS.banner.toNotice)
    for (const markup of [purposes, transfers, upToDate]) {
      expect(readable(markup).filter(line => aiCopyIn(line) !== undefined)).toEqual([])
    }
  })
})

// The attributes of the control a label names (its for= id), with the label's text.
function controlOf(markup: string, label: string): Map<string, string> | undefined {
  const match = [...markup.matchAll(/<label\b[^>]*for="([^"]*)"[^>]*>(.*?)<\/label>/gs)].find(
    each => decoded((each[2] ?? '').replace(/<[^>]+>/g, '')) === label,
  )
  const id = match?.[1]
  if (id === undefined) return undefined
  return [...tags(markup, 'input'), ...tags(markup, 'textarea'), ...tags(markup, 'select')].find(
    control => control.get('id') === id,
  )
}

// The text of the elements an aria-describedby names, in order.
const describedBy = (markup: string, control: Map<string, string> | undefined) =>
  (control?.get('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map(id => {
      const at = markup.indexOf(`id="${id}"`)
      const start = markup.indexOf('>', at) + 1
      return decoded(markup.slice(start, markup.indexOf('</', start)).replace(/<[^>]+>/g, ''))
    })

describe('C0.9 PD-70 OD-19: the contact page and recording an acknowledgement (dpo/)', () => {
  it('DPP-05 PDPA-13 OD-10 PD-70: /dpo/contact is the shell’s page titled Contact details under the four links (Contact current, the Notice link badged), saying what the contact is for; with none recorded it says publishing waits for it and offers Record contact details', async () => {
    const markup = await appAt('/dpo/contact', REGISTERS, undefined, { contact: contactAdminForClient() })
    expect(textsOf(markup, 'h1')).toEqual(['Contact details'])
    expect(registerLinks(markup)).toEqual([
      { href: '/dpo/purposes', current: undefined, text: 'Purposes' },
      { href: '/dpo/transfers', current: undefined, text: 'Transfers' },
      { href: '/dpo/contact', current: 'page', text: 'Contact' },
      { href: '/dpo/notice', current: undefined, text: 'Notice Not published' },
    ])
    // Each link a 44 px target, in a track that wraps at 320 px.
    expect(markup).toMatch(/<div class="inline-flex max-w-full flex-wrap/)
    expect(
      tags(markup, 'a')
        .filter(link => link.get('href')?.startsWith('/dpo/'))
        .every(link => /min-h-11 min-w-11/.test(link.get('class') ?? '')),
    ).toBe(true)
    expect(textsOf(markup, 'h2')).toEqual([CONTACT.none.title])
    expect(readable(markup)).toEqual(expect.arrayContaining([CONTACT.intro, CONTACT.none.body]))
    expect(buttons(markup).find(button => button.name === CONTACT.none.record)).toMatchObject({ held: false })
    expect(readable(markup).filter(text => aiCopyIn(text) !== undefined)).toEqual([])

    const loading = await appAt('/dpo/contact')
    expect(loading).toMatch(/<p role="status"[^>]*>Loading your contact details…<\/p>/)
  })

  it('DPP-05 PD-70 OD-11: with a contact, its card is headed by the role title, says in a pill whether the published notice gives it (with why and a link to the Notice tab when it doesn’t), lists its facts and offers Edit contact details', async () => {
    for (const [stated, pill, line] of [
      ['stated', CONTACT.stated.yes, undefined],
      ['not_printed', CONTACT.stated.no, CONTACT.stated.notPrintedLine],
      ['not_stated', CONTACT.stated.no, CONTACT.stated.noLine],
      ['unpublished', CONTACT.stated.none, undefined],
    ] as const) {
      const answer = contactAdminForClient({
        notice: stated === 'unpublished' ? 'none' : 'out_of_date',
        contact: contactRow(),
        stated,
      })
      const markup = await appAt('/dpo/contact', REGISTERS, undefined, { contact: answer })
      expect(textsOf(markup, 'h2'), stated).toEqual(['Data Protection Officer'])
      const text = readable(markup)
      expect(text, stated).toEqual(
        expect.arrayContaining([
          pill,
          'Email address',
          'dpo@tembusu.example',
          'Recorded',
          'Tue 20 Oct 2026 by Ashton Teo',
        ]),
      )
      const toNotice = [...markup.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gs)].filter(match => match[2] === CONTACT.toNotice)
      expect(toNotice.length, stated).toBe(line === undefined ? 0 : 1)
      if (line !== undefined) {
        expect(text, stated).toContain(line)
        expect(toNotice[0]?.[1], stated).toMatch(/href="\/dpo\/notice"/)
      }
      expect(
        buttons(markup).find(button => button.name === CONTACT.edit),
        stated,
      ).toMatchObject({ held: false })
      // The postal address keeps its lines.
      expect(markup, stated).toMatch(/whitespace-pre-line[^>]*>1 Example Road\nSingapore 000000</)
      expect(text.filter(each => aiCopyIn(each) !== undefined)).toEqual([])
    }
  })

  it('DPP-05 PD-64 PD-70 OD-10 KM-14: the dialog asks for a role title (filled in), then at least one channel: an email address and a phone number with their own types and keyboards, a postal address of three lines; no field lets the browser fill it, each is 16 px with its hint linked; what holds Save back is listed and its field marked; once a version is published it says the notice goes out of date', () => {
    const markup = alone(<ContactDialog answer={contactAdminForClient()} onClose={() => {}} />)
    expect(textsOf(markup, 'h2')).toEqual([CONTACT.dialog.recordTitle])
    expect(readable(markup)).toEqual(expect.arrayContaining([CONTACT.advice, CONTACT.dialog.channels]))
    expect(tags(markup, 'form')[0]?.has('noValidate')).toBe(true)
    const title = controlOf(markup, 'Role title')
    const email = controlOf(markup, 'Email address')
    const phone = controlOf(markup, 'Phone')
    const postal = controlOf(markup, 'Postal address')
    expect([title, email, phone].map(control => [control?.get('type'), control?.get('inputMode')])).toEqual([
      ['text', undefined],
      ['email', 'email'],
      ['tel', 'tel'],
    ])
    expect(title?.get('value')).toBe('Data Protection Officer')
    expect([title, email, phone, postal].map(control => control?.get('maxLength'))).toEqual(['120', '254', '30', '500'])
    expect(postal?.get('rows')).toBe('3')
    for (const control of [title, email, phone, postal]) {
      expect(control?.get('autoComplete')).toBe('off')
      expect(control?.get('class')).toMatch(/\btext-base\b/)
      expect(control?.get('class')).toMatch(/\bmin-h-11\b/)
    }
    expect(describedBy(markup, email)).toEqual([CONTACT.dialog.emailHint])
    expect(describedBy(markup, phone)).toEqual([CONTACT.dialog.phoneHint])
    // No channel yet: listed with no field marked, and Save held.
    expect(readable(markup)).toEqual(
      expect.arrayContaining([DPO.beforeSaving, 'Give an email address, a phone number or a postal address.']),
    )
    expect([title, email, phone, postal].some(control => control?.has('aria-invalid'))).toBe(false)
    expect(buttons(markup).find(button => button.name === 'Save')).toMatchObject({ held: true, type: 'submit' })
    expect(markup).not.toContain(CONTACT.dialog.staleWarning)

    // A problem with a field marks it, and its line describes it after the hint: here a title
    // recorded before its wording joined AI_COPY (PD-65), whose line names the field, never the word.
    const marked = alone(
      <ContactDialog
        answer={contactAdminForClient({ contact: contactRow({ title: 'AI Data Protection Officer' }) })}
        onClose={() => {}}
      />,
    )
    const markedTitle = controlOf(marked, 'Role title')
    expect(markedTitle?.get('aria-invalid')).toBe('true')
    expect(describedBy(marked, markedTitle)).toEqual([
      CONTACT.dialog.titleHint,
      'The role title uses wording Hearth keeps off its screens. Reword it.',
    ])
    expect(controlOf(marked, 'Email address')?.has('aria-invalid')).toBe(false)

    // Once a version is published, saving makes it out of date (OD-11).
    const edit = alone(
      <ContactDialog
        answer={contactAdminForClient({
          notice: 'out_of_date',
          contact: contactRow({ email: 'dpo@tembusu.example' }),
          stated: 'stated',
        })}
        onClose={() => {}}
      />,
    )
    expect(textsOf(edit, 'h2')).toEqual([CONTACT.dialog.editTitle])
    expect(edit).toContain(CONTACT.dialog.staleWarning)
    expect(buttons(edit).find(button => button.name === 'Save')).toMatchObject({ held: false })
    expect(readable(edit).filter(text => aiCopyIn(text) !== undefined)).toEqual([])
  })

  it('NTW-11 OD-10 PD-68: with no contact recorded, the Notice tab lists it under “Your contact details” and links the contact page', async () => {
    const markup = await appAt('/dpo/notice', REGISTERS, noticeAdminForClient({ draft: NO_CONTACT_DRAFT }))
    expect(readable(markup)).toEqual(
      expect.arrayContaining([
        NOTICE_TAB.draft.contactSubject,
        'Record your contact details, so the notice can say how to reach you.',
        NOTICE_TAB.preview.hidden,
      ]),
    )
    const fixes = [...markup.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gs)]
      .filter(match => /Open your/.test(match[2] ?? ''))
      .map(match => [match[1]?.match(/href="([^"]*)"/)?.[1], decoded(match[2] ?? '')])
    expect(fixes).toEqual([['/dpo/contact', NOTICE_TAB.draft.toContact]])
  })

  it('NTW-12 OD-19 PD-76: the record dialog reads the people as it opens: loading, a failed read with Try again, nobody else at the organisation, or the form', () => {
    const loading = alone(<RecordDialog version="0" onClose={() => {}} />)
    expect(textsOf(loading, 'h2')).toEqual(['Record an acknowledgement of version 0'])
    expect(loading).toMatch(/<p role="status"[^>]*>Loading the people at the organisation…<\/p>/)
    expect(readable(loading)).toContain(RECORD.intro)
    expect(buttons(loading).map(button => button.name)).toEqual(['Close', 'Cancel'])

    const failed = alone(<RecordDialog version="0" onClose={() => {}} />, {
      peopleFailed: new ApiFailure(500, 'internal', MESSAGES.internal),
    })
    expect(readable(failed)).toContain(MESSAGES.internal)
    expect(buttons(failed).map(button => button.name)).toEqual(['Close', DPO.retry, 'Cancel'])

    const nobody = alone(<RecordDialog version="0" onClose={() => {}} />, {
      people: noticePeopleForClient({ people: [] }),
    })
    expect(readable(nobody)).toContain(RECORD.nobody)
    expect(tags(nobody, 'form')).toEqual([])
    expect(buttons(nobody).map(button => button.name)).toEqual(['Close', 'Cancel'])
  })

  it('NTW-12 OD-19 PD-75 PD-76: the form picks who (Choose someone first, names with departments, no numbers), the day between the version’s publication and today, and how, each labelled with its hint; Record is held until nothing is missing, and a cut list says so', () => {
    const markup = alone(<RecordDialog version="0" onClose={() => {}} />, { people: noticePeopleForClient() })
    expect(tags(markup, 'form')[0]?.has('noValidate')).toBe(true)
    expect(textsOf(markup, 'label')).toEqual([RECORD.person, RECORD.day, RECORD.how])
    expect(optionsOf(markup, 'person')).toEqual([
      'Choose someone',
      'Ahmad Rahman (Commercial)',
      'Kelvin Tan',
      'Marcus Ong (Operations)',
      'Priya Nair (Operations)',
      'Rachel Goh (Commercial)',
    ])
    // No number is shown (PD-76).
    expect(readable(markup).filter(text => /\+\d|\d{8}/.test(text))).toEqual([])
    const day = controlOf(markup, RECORD.day)
    expect([day?.get('type'), day?.get('min'), day?.get('max')]).toEqual(['date', '2026-10-21', TODAY])
    expect(describedBy(markup, day)).toEqual(['From Wed 21 Oct 2026 to Thu 22 Oct 2026.'])
    const how = controlOf(markup, RECORD.how)
    expect([how?.get('type'), how?.get('maxLength'), how?.get('autoComplete')]).toEqual(['text', '500', 'off'])
    expect(describedBy(markup, how)).toEqual([RECORD.howHint])
    for (const control of [controlOf(markup, RECORD.person), day, how]) {
      expect(control?.get('class')).toMatch(/\btext-base\b/)
    }
    expect(readable(markup)).toEqual(
      expect.arrayContaining([RECORD.beforeRecording, RECORD.problems.person_missing, RECORD.problems.note_missing]),
    )
    expect(markup).not.toContain(RECORD.more)
    expect(markup).not.toContain(RECORD.sameDetails)
    expect(buttons(markup).find(button => button.name === RECORD.record)).toMatchObject({ held: true, type: 'submit' })
    expect(readable(markup).filter(text => aiCopyIn(text) !== undefined)).toEqual([])

    const cut = alone(<RecordDialog version="0" onClose={() => {}} />, {
      people: noticePeopleForClient({ more: true }),
    })
    expect(readable(cut)).toContain(RECORD.more)
  })
})
