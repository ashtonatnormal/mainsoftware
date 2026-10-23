// The DPO's Notice tab and the register pages' notice markers, pure, in Node (C0.9 PD-37 to PD-41,
// PD-48, PD-52, PD-59, PD-61; B-04, B-12, C-05, C-09; TECH-SPEC T22 items 25, 27 and 31): the
// answer of GET /api/admin/notice as the tab shows it (dpo/notice-model.ts), its calls
// (dpo/queries.ts), and the markers the registers' answer brings (dpo/notice-markers.tsx).
import {
  MESSAGES,
  NOTICE_PROBLEMS,
  NOTICE_PROVIDER_NAMES,
  NOTICE_WARNINGS,
  REAUTH_METHOD_MESSAGES,
} from '@hearth/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiFailure } from '@/api/http.ts'
import { formattersFor } from '@/lib/time.ts'
import { DPO } from '@/strings/dpo.ts'
import { NOTICE_MARKERS, NOTICE_PROBLEM_COPY, NOTICE_TAB, NOTICE_WARNING_COPY } from '@/strings/dpo-notice.ts'
import {
  factsSaveStops,
  factsStopText,
  noticeBadgeText,
  noticeBannerOf,
  noticeGenerated,
  providerMarkerText,
  purposeMarkerText,
  purposeSaveEffect,
} from './notice-markers.tsx'
import {
  changeGroups,
  noticeStatusOf,
  noticeTabView,
  publishBodyOf,
  publishHeldOf,
  publishRefusalOf,
} from './notice-model.ts'
import { noticeAdminQuery, publishNotice } from './queries.ts'
import {
  COMPLETE_FACTS,
  DIGEST,
  DRAFT_BODY,
  NEXT_ID,
  NOTICE_ID,
  noticeAdminForClient,
  registersForClient,
} from './testing/registers.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

// Dates as Ashton's zone shows them (the runtime's formatters).
const date = formattersFor('Asia/Singapore').date

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const CLEARED = {
  clearedOn: '2026-10-02',
  clearedBy: 'Ashton Teo',
  clearedVia: 'app',
  revision: 2,
  withdrawnOn: null,
  withdrawnBy: null,
  withdrawReason: null,
} as const

describe('C0.9 PD-48: the DPO’s Notice tab (dpo/notice-model.ts)', () => {
  it('NTW-09 PDPA-03 PD-48: a draft ready to publish shows the published version, when and by whom, that it is out of date, how many have acknowledged it (a count), what the next version changes in the registries’ order, what to check, the words, and Publish acting on the version and digest previewed', () => {
    const answer = noticeAdminForClient()
    const view = noticeTabView(answer, date)
    expect(view).toEqual({
      status: 'out_of_date',
      published: [
        'Version 0, published Wed 21 Oct 2026 by Ashton Teo.',
        NOTICE_TAB.published.outOfDate,
        '9 of the 12 people at the organisation have acknowledged version 0.',
      ],
      version: '1',
      first: false,
      changes: {
        groups: [
          { title: 'Now listed', lines: ['Backups'] },
          {
            title: 'Changed',
            lines: ['Accounts and sign-in: the roster, phone numbers and one-time codes, devices, profiles'],
          },
          { title: 'No longer listed', lines: ['Amazon Web Services'] },
        ],
        wording: false,
      },
      problems: [],
      fixAt: [],
      warnings: [NOTICE_WARNING_COPY.dpo_contact_pending()],
      publishHeld: undefined,
      body: DRAFT_BODY,
      history: [{ id: NOTICE_ID, lines: ['Version 0, published Wed 21 Oct 2026 by Ashton Teo.'] }],
    })
    expect(publishBodyOf(answer)).toEqual({ seen: 0, digest: DIGEST })
  })

  it('NTW-09 PD-48: the change list names each provider as the notice and its preview do, not as the transfer register does', () => {
    const groups = changeGroups({
      since: 0,
      purposes: { added: [], changed: [], removed: [] },
      providers: { added: ['aws_sms', 'google_fcm'], changed: ['microsoft_wns'], removed: [] },
      wording: false,
    })
    expect(groups?.groups).toEqual([
      { title: 'Now listed', lines: [NOTICE_PROVIDER_NAMES.aws_sms, NOTICE_PROVIDER_NAMES.google_fcm] },
      { title: 'Changed', lines: [NOTICE_PROVIDER_NAMES.microsoft_wns] },
    ])
    expect(groups?.groups[0]?.lines).toEqual([
      'Amazon Web Services End User Messaging',
      'Firebase Cloud Messaging (Google)',
    ])
  })

  it('NTW-09 OD-01 PD-48: before any version, the tab says nobody but the DPO can use Hearth until one is published, the first version is 0, Publish sends seen null, and there is no history', () => {
    const answer = noticeAdminForClient({
      latest: null,
      history: [],
      draft: {
        version: 0,
        body: DRAFT_BODY,
        digest: DIGEST,
        problems: [],
        warnings: [],
        changes: null,
        upToDate: false,
      },
    })
    const view = noticeTabView(answer, date)
    expect(noticeStatusOf(answer)).toBe('none')
    expect(view).toMatchObject({
      status: 'none',
      published: [NOTICE_TAB.published.none],
      version: '0',
      first: true,
      changes: undefined,
      publishHeld: undefined,
      history: [],
    })
    expect(publishBodyOf(answer)).toEqual({ seen: null, digest: DIGEST })
  })

  it('NTW-09 PD-37 PD-62 C-05: what holds publishing back is listed under the purpose or provider it names, never quoting the DPO’s text; each register page that fixes one is offered once; Publish is held and sends nothing, and the words aren’t shown', () => {
    const answer = noticeAdminForClient({
      draft: {
        version: 1,
        body: null,
        digest: null,
        problems: [
          { code: 'purpose_basis_missing', purpose: 'backups' },
          { code: 'purpose_retention_missing', purpose: 'backups' },
          { code: 'provider_not_cleared', purpose: 'security_audit', provider: 'twilio' },
          { code: 'free_text_ai_copy', provider: 'aws', field: 'onward_recipients' },
          { code: 'free_text_ai_copy', purpose: 'accounts', field: 'retention' },
        ],
        warnings: [],
        changes: null,
        upToDate: false,
      },
    })
    const view = noticeTabView(answer, date)
    expect(view.problems).toEqual([
      {
        key: 'purpose:backups',
        subject: 'Backups',
        lines: ['Record its legal basis.', 'Say how long its data is kept.'],
      },
      {
        key: 'purpose:security_audit',
        subject: 'Security audit and monitoring',
        lines: ['It lists Twilio Verify, which isn’t cleared for use.'],
      },
      {
        key: 'provider:aws',
        subject: 'Amazon Web Services',
        lines: ['“Who it passes the data on to” uses wording Hearth keeps off its screens. Reword it.'],
      },
      {
        key: 'purpose:accounts',
        subject: 'Accounts and sign-in: the roster, phone numbers and one-time codes, devices, profiles',
        lines: ['“How long it’s kept” uses wording Hearth keeps off its screens. Reword it.'],
      },
    ])
    expect(view.fixAt).toEqual(['purposes', 'transfers'])
    expect(view.publishHeld).toBe(DPO.fixFirst)
    expect(view.body).toBeUndefined()
    expect(view.changes).toBeUndefined()
    expect(publishBodyOf(answer)).toBeUndefined()
    // Only a provider's own facts send the DPO to the transfer register; a purpose's to the
    // processing register.
    const purposesOnly = noticeAdminForClient({
      draft: { ...answer.draft, problems: [{ code: 'purpose_consent_basis', purpose: 'presence_receipts' }] },
    })
    expect(noticeTabView(purposesOnly, date).fixAt).toEqual(['purposes'])
    expect(noticeTabView(purposesOnly, date).problems[0]?.lines).toEqual([NOTICE_PROBLEM_COPY.purpose_consent_basis()])
    // Every problem code has its line, and every warning code (Twilio Verify's sends_waiting its own).
    expect(Object.keys(NOTICE_PROBLEM_COPY).sort()).toEqual([...NOTICE_PROBLEMS].sort())
    expect(Object.keys(NOTICE_WARNING_COPY).sort()).toEqual([...NOTICE_WARNINGS, 'sends_waiting_twilio'].sort())
  })

  it('NTW-09 PD-37: a draft the published notice already says is up to date, Publish held for that reason; a placeholder as the latest version says so, in the history too; one person reads in the singular', () => {
    const unchanged = noticeAdminForClient({
      draft: {
        version: 1,
        body: DRAFT_BODY,
        digest: DIGEST,
        problems: [{ code: 'unchanged' }],
        warnings: [],
        changes: {
          since: 0,
          purposes: { added: [], changed: [], removed: [] },
          providers: { added: [], changed: [], removed: [] },
          wording: false,
        },
        upToDate: true,
      },
    })
    const view = noticeTabView(unchanged, date)
    expect(view.status).toBe('up_to_date')
    expect(view.published[1]).toBe(NOTICE_TAB.published.upToDate)
    expect(view.changes).toBeUndefined()
    expect(view.problems).toEqual([{ key: 'draft', subject: undefined, lines: [NOTICE_TAB.draft.alreadySays] }])
    expect(view.fixAt).toEqual([])
    expect(publishHeldOf(unchanged)).toBe(NOTICE_TAB.draft.alreadySays)

    const standIn = {
      id: NOTICE_ID,
      version: 0,
      publishedAt: '2026-10-01T01:00:00.000Z',
      publishedBy: null,
      generated: false,
    }
    const next = { ...standIn, id: NEXT_ID, version: 1, publishedBy: 'Ashton Teo', generated: true }
    const placeholder = noticeTabView(
      noticeAdminForClient({ latest: { ...standIn, acknowledged: 1, people: 1 }, history: [next, standIn] }),
      date,
    )
    expect(placeholder.published).toEqual([
      'Version 0, published Thu 1 Oct 2026.',
      NOTICE_TAB.published.standIn,
      '1 of the 1 person at the organisation has acknowledged version 0.',
    ])
    expect(placeholder.history).toEqual([
      { id: NEXT_ID, lines: ['Version 1, published Thu 1 Oct 2026 by Ashton Teo.'] },
      { id: NOTICE_ID, lines: ['Version 0, published Thu 1 Oct 2026.', NOTICE_TAB.history.standIn] },
    ])
  })

  it('NTW-09 PD-37 PD-59: the warnings name their provider in the registers’ words; a provider whose sends wait says nothing is sent to it, and Twilio Verify’s that only the DPO gets sign-in codes', () => {
    const view = noticeTabView(
      noticeAdminForClient({
        draft: {
          ...noticeAdminForClient().draft,
          warnings: [
            { code: 'provider_unlisted', provider: 'livekit' },
            { code: 'provider_review_due', provider: 'aws_sms' },
            { code: 'sends_waiting', provider: 'twilio' },
            { code: 'sends_waiting', provider: 'apple_push' },
            { code: 'same_text' },
            { code: 'dpo_contact_pending' },
            { code: 'production_access_pending' },
          ],
        },
      }),
      date,
    )
    expect(view.warnings).toEqual([
      'LiveKit Cloud is cleared, but no active purpose lists it. The notice names it anyway.',
      'The review of AWS text messages is due. Check its facts on the transfer register.',
      NOTICE_WARNING_COPY.sends_waiting_twilio(),
      'Nothing is sent to Apple Push Notification service until you publish: the published notice doesn’t state its facts.',
      NOTICE_WARNING_COPY.same_text(),
      NOTICE_WARNING_COPY.dpo_contact_pending(),
      NOTICE_WARNING_COPY.production_access_pending(),
    ])
  })

  it('NTW-09 PD-52 PD-30: a refused publish offers Reload in the tab’s own words for notice_changed and notice_invalid, the PIN step for a stale re-authentication, and the DPO-only line for forbidden', () => {
    const failure = (status: number, code: string, message: string, extra = {}) =>
      new ApiFailure(status, code, message, extra)
    expect(publishRefusalOf(failure(409, 'notice_changed', MESSAGES.notice_changed))).toEqual({
      kind: 'changed',
      text: NOTICE_TAB.changedSince,
    })
    expect(publishRefusalOf(failure(400, 'notice_invalid', MESSAGES.notice_invalid))).toEqual({
      kind: 'changed',
      text: NOTICE_TAB.invalid,
    })
    expect(
      publishRefusalOf(failure(403, 'reauth_required', REAUTH_METHOD_MESSAGES.pin.required, { method: 'pin' })),
    ).toEqual({ kind: 'pin' })
    expect(publishRefusalOf(failure(403, 'forbidden', MESSAGES.forbidden))).toEqual({
      kind: 'forbidden',
      text: DPO.forbidden,
    })
    expect(publishRefusalOf(new Error('a bug'))).toEqual({ kind: 'message', text: MESSAGES.internal })
  })

  it('NTW-09 PD-36 PD-48: the tab reads /api/admin/notice leniently, never again on focus or reconnect, and Publish posts the version and digest previewed to /api/admin/notice/publish and reads the new version', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const answers: Response[] = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const next = answers.shift()
      if (next === undefined) throw new TypeError('Failed to fetch')
      return next
    })
    expect(noticeAdminQuery.queryKey).toEqual(['notice-admin'])
    expect(noticeAdminQuery).toMatchObject({ staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false })
    answers.push(json(200, { ...noticeAdminForClient(), later: 'a field the server adds' }))
    const read = await noticeAdminQuery.queryFn?.({ signal: new AbortController().signal } as never)
    expect(read?.draft.version).toBe(1)
    expect(read).not.toHaveProperty('later')

    answers.push(json(200, { notice: NEXT_ID, version: 1 }))
    expect(await publishNotice({ seen: 0, digest: DIGEST })).toEqual({ version: 1 })
    expect(calls.map(call => [call.url, call.init?.method])).toEqual([
      ['/api/admin/notice', 'GET'],
      ['/api/admin/notice/publish', 'POST'],
    ])
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ seen: 0, digest: DIGEST })
  })
})

describe('C0.9 PD-48 B-04 C-09: the register pages’ notice markers (dpo/notice-markers.tsx)', () => {
  it('NTW-09 PD-48 C-09: the badge and banner say whether a notice is published and up to date; a pinned purpose that is stale gets its own banner, listing it, but only once something is published', () => {
    expect(noticeBadgeText('up_to_date')).toBeUndefined()
    expect(noticeBadgeText('out_of_date')).toBe('Out of date')
    expect(noticeBadgeText('none')).toBe('Not published')

    expect(noticeBannerOf(registersForClient())).toEqual({ kind: 'none', text: NOTICE_MARKERS.banner.none })
    expect(noticeBannerOf(registersForClient({}, {}, 'up_to_date'))).toBeUndefined()
    expect(noticeBannerOf(registersForClient({}, {}, 'out_of_date'))).toEqual({
      kind: 'out_of_date',
      text: NOTICE_MARKERS.banner.outOfDate,
    })
    const stale = registersForClient({ accounts: { version: 2, stale: true } }, {}, 'out_of_date')
    expect(noticeBannerOf(stale)).toEqual({
      kind: 'stale',
      text: NOTICE_MARKERS.banner.stale,
      purposes: ['Accounts and sign-in: the roster, phone numbers and one-time codes, devices, profiles'],
    })
    // With nothing published nothing can be stale (C-09): the not-published banner, whatever a row says.
    expect(noticeBannerOf(registersForClient({ accounts: { stale: true } }))?.kind).toBe('none')
  })

  it('NTW-09 PD-40 PD-41 PD-59 PD-61: a card says an active purpose that isn’t pinned waits for a notice that lists it, a stale pinned one that it applies to everyone already, and a cleared provider whose facts the notice doesn’t state that nothing is sent to it (Twilio Verify: only the DPO gets codes)', () => {
    const registers = registersForClient(
      {
        security_audit: { notified: false },
        backups: { notified: true },
        accounts: { stale: true },
      },
      {
        twilio: { ...COMPLETE_FACTS, revision: 2, clearance: CLEARED, sendsWait: true },
        aws: { ...COMPLETE_FACTS, revision: 2, clearance: CLEARED, sendsWait: true },
        livekit: {
          ...COMPLETE_FACTS,
          revision: 2,
          clearance: {
            ...CLEARED,
            withdrawnOn: '2026-10-03',
            withdrawnBy: 'Ashton Teo',
            withdrawReason: 'dpo_decision',
          },
          sendsWait: true,
        },
      },
      'out_of_date',
    )
    const purpose = (key: string) => {
      const row = registers.purposes.find(each => each.purpose === key)
      if (row === undefined) throw new Error(key)
      return row
    }
    const provider = (key: string) => {
      const row = registers.transfers.find(each => each.provider === key)
      if (row === undefined) throw new Error(key)
      return row
    }
    expect(purposeMarkerText(purpose('security_audit'))).toBe(NOTICE_MARKERS.waitingForNotice)
    expect(purposeMarkerText(purpose('backups'))).toBeUndefined()
    // Planned: nothing to wait for.
    expect(purposeMarkerText(purpose('recording_meetings'))).toBeUndefined()
    expect(purposeMarkerText(purpose('accounts'))).toBe(NOTICE_MARKERS.pinnedStale)
    expect(purposeMarkerText(purpose('service_operation'))).toBeUndefined()

    expect(providerMarkerText(provider('twilio'))).toBe(NOTICE_MARKERS.sendsWaitTwilio)
    expect(providerMarkerText(provider('aws'))).toBe(NOTICE_MARKERS.sendsWait)
    // A withdrawn clearance sends nothing anyway; its card says that already.
    expect(providerMarkerText(provider('livekit'))).toBeUndefined()
    expect(providerMarkerText(provider('apple_push'))).toBeUndefined()
  })

  it('NTW-09 B-04 PD-40 PD-41 C-09: once a generated version is published, saving a changed pinned purpose asks first, a changed notified one says what serves it stops, and a change to a stated fact of a cleared provider the notice states says what stops; before one (none, or a placeholder) nothing does', () => {
    // Generated: the latest version lists the pinned purposes, at their versions or older ones.
    expect(noticeGenerated(registersForClient())).toBe(false)
    expect(noticeGenerated(registersForClient({}, {}, 'out_of_date'))).toBe(false)
    expect(noticeGenerated(registersForClient({ accounts: { notified: true } }, {}, 'up_to_date'))).toBe(true)
    expect(noticeGenerated(registersForClient({ service_operation: { stale: true } }, {}, 'out_of_date'))).toBe(true)

    const registers = registersForClient(
      { accounts: { notified: true }, backups: { notified: true } },
      {
        twilio: { ...COMPLETE_FACTS, revision: 2, clearance: CLEARED },
        aws: { ...COMPLETE_FACTS, revision: 2, clearance: CLEARED, sendsWait: true },
      },
      'up_to_date',
    )
    const purpose = (key: string) => registers.purposes.find(each => each.purpose === key) ?? registers.purposes[0]
    const provider = (key: string) => registers.transfers.find(each => each.provider === key) ?? registers.transfers[0]
    const accounts = purpose('accounts')
    const backups = purpose('backups')
    const audit = purpose('security_audit')
    if (accounts === undefined || backups === undefined || audit === undefined) throw new Error('fixture')
    expect(purposeSaveEffect(accounts, true, true)).toBe('confirm')
    expect(purposeSaveEffect(accounts, false, true)).toBeUndefined()
    expect(purposeSaveEffect(accounts, true, false)).toBeUndefined()
    expect(purposeSaveEffect(backups, true, true)).toBe('stops')
    // Not notified already: a change stops nothing more.
    expect(purposeSaveEffect(audit, true, true)).toBeUndefined()

    const twilio = provider('twilio')
    const aws = provider('aws')
    const apple = provider('apple_push')
    if (twilio === undefined || aws === undefined || apple === undefined) throw new Error('fixture')
    expect(factsSaveStops(twilio, true, true)).toBe(true)
    expect(factsSaveStops(twilio, false, true)).toBe(false)
    expect(factsSaveStops(twilio, true, false)).toBe(false)
    // Its sends wait already, or it isn't cleared: nothing more stops.
    expect(factsSaveStops(aws, true, true)).toBe(false)
    expect(factsSaveStops(apple, true, true)).toBe(false)
    expect(factsStopText(twilio, 'Twilio Verify')).toBe(NOTICE_MARKERS.factsStopTwilio)
    expect(factsStopText(aws, 'Amazon Web Services')).toBe(NOTICE_MARKERS.factsStop('Amazon Web Services'))
  })
})
