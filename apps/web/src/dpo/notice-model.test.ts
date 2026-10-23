// The DPO's Notice tab and the register pages' notice markers, pure, in Node (C0.9 PD-37 to PD-41,
// PD-48, PD-52, PD-59, PD-61; B-04, B-12, C-05, C-09; TECH-SPEC T22 items 25, 27 and 31): the
// answer of GET /api/admin/notice as the tab shows it (dpo/notice-model.ts), its calls
// (dpo/queries.ts), and the markers the registers' answer brings (dpo/notice-markers.tsx). From
// C0.9 PR 3a: the DPO's contact in the draft (NTW-11; OD-10, OD-11, PD-65 to PD-68, PD-86) and
// recording an acknowledgement made outside Hearth (NTW-12; OD-19, PD-75, PD-76).
import {
  MESSAGES,
  NOTICE_PEOPLE_MAX,
  NOTICE_PROBLEMS,
  NOTICE_PROVIDER_NAMES,
  NOTICE_WARNINGS,
  NoticeAdminResponseForClient,
  REAUTH_METHOD_MESSAGES,
  RECORD_PROBLEMS,
  RecordAcknowledgementBody,
} from '@hearth/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiFailure } from '@/api/http.ts'
import { formattersFor } from '@/lib/time.ts'
import { DPO } from '@/strings/dpo.ts'
import { NOTICE_MARKERS, NOTICE_PROBLEM_COPY, NOTICE_TAB, NOTICE_WARNING_COPY } from '@/strings/dpo-notice.ts'
import { RECORD } from '@/strings/dpo-record.ts'
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
  EMPTY_RECORD,
  fixPages,
  noticeStatusOf,
  noticeTabView,
  problemGroups,
  publishBodyOf,
  publishHeldOf,
  publishRefusalOf,
  recordEditor,
  recordedText,
  recordLines,
  recordOptions,
  recordRefusalOf,
  recordView,
  warningLine,
} from './notice-model.ts'
import { noticeAdminQuery, noticePeopleQuery, publishNotice, recordAcknowledgement } from './queries.ts'
import {
  COMPLETE_FACTS,
  DIGEST,
  DRAFT_BODY,
  NEXT_ID,
  NO_CONTACT_DRAFT,
  NOTICE_ID,
  noticeAdminAnswer,
  noticeAdminForClient,
  noticePeopleForClient,
  PEOPLE,
  registersForClient,
  TODAY,
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
        contact: undefined,
        wording: false,
      },
      problems: [],
      fixAt: [],
      warnings: [NOTICE_WARNING_COPY.production_access_pending()],
      publishHeld: undefined,
      body: DRAFT_BODY,
      history: [{ id: NOTICE_ID, lines: ['Version 0, published Wed 21 Oct 2026 by Ashton Teo.'] }],
      record: { version: '0' },
    })
    expect(publishBodyOf(answer)).toEqual({ seen: 0, digest: DIGEST })
  })

  it('NTW-09 PD-48: the change list names each provider as the notice and its preview do, not as the transfer register does', () => {
    const groups = changeGroups({
      since: 0,
      purposes: { added: [], changed: [], removed: [] },
      providers: { added: ['aws_sms', 'google_fcm'], changed: ['microsoft_wns'], removed: [] },
      contact: 'same',
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
      // Nothing to record an acknowledgement of yet (C0.9 OD-19).
      record: undefined,
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
          contact: 'same',
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

describe('C0.9 OD-10 OD-11: the DPO’s contact on the Notice tab (dpo/notice-model.ts)', () => {
  it('NTW-11 OD-10 PD-65 PD-68: no contact recorded holds publishing back under “Your contact details”, with a link to the contact page, and shows no words; the contact’s own text using AI wording joins that group, by its field', () => {
    const answer = noticeAdminForClient({ draft: NO_CONTACT_DRAFT })
    const view = noticeTabView(answer, date)
    expect(view.problems).toEqual([
      { key: 'contact', subject: NOTICE_TAB.draft.contactSubject, lines: [NOTICE_PROBLEM_COPY.dpo_contact_pending()] },
    ])
    expect(view.fixAt).toEqual(['contact'])
    expect(view.publishHeld).toBe(DPO.fixFirst)
    expect(view.body).toBeUndefined()
    expect(view.warnings).toEqual([NOTICE_WARNING_COPY.production_access_pending()])
    expect(NOTICE_PROBLEM_COPY.dpo_contact_pending()).toBe(
      'Record your contact details, so the notice can say how to reach you.',
    )
    const free = problemGroups([
      { code: 'free_text_ai_copy', field: 'contact_title' },
      { code: 'free_text_ai_copy', field: 'contact_postal' },
      { code: 'free_text_ai_copy', purpose: 'backups', field: 'retention' },
    ])
    expect(free).toEqual([
      {
        key: 'contact',
        subject: 'Your contact details',
        lines: [
          '“Role title” uses wording Hearth keeps off its screens. Reword it.',
          '“Postal address” uses wording Hearth keeps off its screens. Reword it.',
        ],
      },
      {
        key: 'purpose:backups',
        subject: 'Backups',
        lines: ['“How long it’s kept” uses wording Hearth keeps off its screens. Reword it.'],
      },
    ])
    expect(fixPages([{ code: 'free_text_ai_copy', field: 'contact_email' }])).toEqual(['contact'])
  })

  it('NTW-11 OD-18 PD-86: a purpose on deemed consent by conduct that can’t be stopped for one person is listed under its purpose and fixed on the processing register; the pages are offered purposes, transfers, contact, each once', () => {
    const problems = [
      { code: 'dpo_contact_pending' },
      { code: 'purpose_conduct_unstoppable', purpose: 'security_audit' },
      { code: 'provider_not_cleared', purpose: 'security_audit', provider: 'twilio' },
      { code: 'purpose_consent_basis', purpose: 'backups' },
    ] as const
    expect(problemGroups(problems)).toEqual([
      { key: 'contact', subject: 'Your contact details', lines: [NOTICE_PROBLEM_COPY.dpo_contact_pending()] },
      {
        key: 'purpose:security_audit',
        subject: 'Security audit and monitoring',
        lines: [
          'It rests on deemed consent by conduct, but Hearth can’t yet stop it for one person who withdraws, so the notice can’t promise that. Choose another basis.',
          'It lists Twilio Verify, which isn’t cleared for use.',
        ],
      },
      {
        key: 'purpose:backups',
        subject: 'Backups',
        lines: [
          'It rests on consent or deemed consent by notification, which the notice can’t state yet. Choose another basis.',
        ],
      },
    ])
    expect(fixPages(problems)).toEqual(['purposes', 'transfers', 'contact'])
    expect(fixPages([{ code: 'purpose_conduct_unstoppable', purpose: 'backups' }])).toEqual(['purposes'])
  })

  it('NTW-11 OD-11 PD-67 PD-68: the contact is no longer a warning; what the next version changes says when it gives the contact for the first time or another one, and that alone is a change to show', () => {
    expect(NOTICE_WARNINGS as readonly string[]).not.toContain('dpo_contact_pending')
    expect(Object.keys(NOTICE_WARNING_COPY)).not.toContain('dpo_contact_pending')
    expect(warningLine({ code: 'production_access_pending' })).toBe(NOTICE_WARNING_COPY.production_access_pending())
    const none = { added: [], changed: [], removed: [] }
    expect(changeGroups({ since: 0, purposes: none, providers: none, contact: 'added', wording: false })).toEqual({
      groups: [],
      contact: 'The notice gives your contact details for the first time.',
      wording: false,
    })
    expect(changeGroups({ since: 0, purposes: none, providers: none, contact: 'changed', wording: false })).toEqual({
      groups: [],
      contact: 'Your contact details change.',
      wording: false,
    })
    expect(changeGroups({ since: 0, purposes: none, providers: none, contact: 'same', wording: false })).toBeUndefined()
    // From the answer, and an unreadable marker claims nothing (ChangesForClient's catch).
    const answer = noticeAdminAnswer()
    const withContact = (contact: string) =>
      NoticeAdminResponseForClient.parse({
        ...answer,
        draft: { ...answer.draft, changes: { ...answer.draft.changes, contact } },
      })
    expect(noticeTabView(withContact('changed'), date).changes?.contact).toBe(NOTICE_TAB.draft.contact)
    expect(noticeTabView(withContact('a marker this build can’t read'), date).changes?.contact).toBeUndefined()
  })
})

describe('C0.9 OD-19: recording an acknowledgement made outside Hearth (dpo/notice-model.ts)', () => {
  it('NTW-12 OD-19: the button shows only once a version is published', () => {
    expect(recordView(noticeAdminForClient())).toEqual({ version: '0' })
    expect(recordView({ latest: null })).toBeUndefined()
  })

  it('NTW-12 PD-76: the people are listed in the answer’s order after “Choose someone”, by name with the department in brackets, never a number or whether they acknowledged; two of one name and department gain their manager, then the day they were added, and the dialog warns when nothing tells them apart', () => {
    const people = noticePeopleForClient()
    expect(recordOptions(people.people)).toEqual({
      options: [
        { value: '', label: 'Choose someone' },
        { value: PEOPLE[0]?.id, label: 'Ahmad Rahman (Commercial)' },
        { value: PEOPLE[1]?.id, label: 'Kelvin Tan' },
        { value: PEOPLE[2]?.id, label: 'Marcus Ong (Operations)' },
        { value: PEOPLE[3]?.id, label: 'Priya Nair (Operations)' },
        { value: PEOPLE[4]?.id, label: 'Rachel Goh (Commercial)' },
      ],
      same: false,
    })
    const twin = (id: string, manager: string | null, addedOn: string) => ({
      id,
      name: 'Siti Rahim',
      department: 'Finance',
      manager,
      addedOn,
    })
    const ids = ['b0000000-0000-4000-8000-000000000101', 'b0000000-0000-4000-8000-000000000102'] as const
    expect(
      recordOptions([twin(ids[0], 'Tan Wei Ling', '2026-10-01'), twin(ids[1], 'Priya Nair', '2026-10-01')]).options,
    ).toEqual([
      { value: '', label: 'Choose someone' },
      { value: ids[0], label: 'Siti Rahim (Finance), reports to Tan Wei Ling' },
      { value: ids[1], label: 'Siti Rahim (Finance), reports to Priya Nair' },
    ])
    expect(
      recordOptions([twin(ids[0], 'Priya Nair', '2026-08-01'), twin(ids[1], 'Priya Nair', '2026-10-01')]).options,
    ).toEqual([
      { value: '', label: 'Choose someone' },
      { value: ids[0], label: 'Siti Rahim (Finance), reports to Priya Nair, added Sat 1 Aug 2026' },
      { value: ids[1], label: 'Siti Rahim (Finance), reports to Priya Nair, added Thu 1 Oct 2026' },
    ])
    const same = recordOptions([twin(ids[0], null, '2026-10-01'), twin(ids[1], null, '2026-10-01')])
    expect(same.same).toBe(true)
    expect(same.options.slice(1).map(option => option.label)).toEqual([
      'Siti Rahim (Finance), added Thu 1 Oct 2026',
      'Siti Rahim (Finance), added Thu 1 Oct 2026',
    ])
    // A cut list says so, with the figure the server cuts at.
    expect(RECORD.more).toContain(NOTICE_PEOPLE_MAX.toLocaleString('en-GB'))
  })

  it('NTW-12 OD-19 PD-75: the record is held back until someone is chosen, a day from the version’s publication to today and a note of how on one line; then it posts the person, the version read, the day and the note, trimmed', () => {
    const people = noticePeopleForClient()
    const empty = recordEditor(people, EMPTY_RECORD)
    expect(empty.version).toBe('0')
    expect(empty.problems).toEqual([
      'Choose who acknowledged it.',
      'Give the day they acknowledged it.',
      'Say how they acknowledged it.',
    ])
    expect(empty.recording).toBeUndefined()
    const rachel = PEOPLE[4]?.id ?? ''
    for (const [acknowledgedOn, held] of [
      ['2026-10-20', true],
      ['2026-10-21', false],
      [TODAY, false],
      ['2026-10-23', true],
    ] as const) {
      const editor = recordEditor(people, { person: rachel, acknowledgedOn, note: 'Signed a printed copy' })
      expect(editor.problems, acknowledgedOn).toEqual(
        held ? ['Give a day from the day version 0 was published to today.'] : [],
      )
    }
    expect(recordEditor(people, { person: rachel, acknowledgedOn: TODAY, note: 'x'.repeat(501) }).problems).toEqual([
      'Keep it to 500 characters.',
    ])
    expect(recordEditor(people, { person: rachel, acknowledgedOn: TODAY, note: 'one\ntwo' }).problems).toEqual([
      'Keep it on one line.',
    ])
    expect(recordLines([...RECORD_PROBLEMS], '3')).toHaveLength(RECORD_PROBLEMS.length)
    const ready = recordEditor(people, {
      person: rachel,
      acknowledgedOn: '2026-10-21',
      note: '  Signed a printed copy at induction ',
    })
    expect(ready.recording).toEqual({
      name: 'Rachel Goh',
      body: {
        person: rachel,
        notice: NOTICE_ID,
        acknowledgedOn: '2026-10-21',
        note: 'Signed a printed copy at induction',
      },
    })
    expect(RecordAcknowledgementBody.parse(ready.recording?.body)).toEqual(ready.recording?.body)
  })

  it('NTW-12 PD-76: the toast says what was recorded, or that they had already acknowledged; a refusal says a newer version was published (Reload), what to check, that only someone else still at the organisation can be recorded for, or asks for the PIN', () => {
    expect(recordedText({ changed: true }, 'Rachel Goh', '0')).toBe('Recorded: Rachel Goh acknowledged version 0.')
    expect(recordedText({ changed: false }, 'Rachel Goh', '0')).toBe(
      'Rachel Goh had already acknowledged version 0, so nothing was recorded.',
    )
    const failure = (status: number, code: string, extra = {}) =>
      new ApiFailure(status, code, (MESSAGES as Record<string, string>)[code] ?? MESSAGES.internal, extra)
    expect(recordRefusalOf(failure(409, 'notice_changed'), '0')).toEqual({ kind: 'changed', text: RECORD.newer })
    expect(recordRefusalOf(failure(400, 'notice_invalid'), '0')).toEqual({ kind: 'message', text: RECORD.invalid('0') })
    expect(recordRefusalOf(failure(403, 'forbidden'), '0')).toEqual({ kind: 'message', text: RECORD.refused })
    expect(recordRefusalOf(failure(403, 'reauth_required', { method: 'pin' }), '0')).toEqual({ kind: 'pin' })
    expect(recordRefusalOf(failure(404, 'not_found'), '0')).toEqual({ kind: 'message', text: MESSAGES.not_found })
  })

  it('NTW-12 PD-76: the dialog reads /api/admin/notice/people leniently, never again on focus or reconnect, and Record posts its body to /api/admin/notice/acknowledgements/record and reads whether it changed anything', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const answers: Response[] = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const next = answers.shift()
      if (next === undefined) throw new TypeError('Failed to fetch')
      return next
    })
    expect(noticePeopleQuery.queryKey).toEqual(['notice-people'])
    expect(noticePeopleQuery).toMatchObject({ staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false })
    const unreadable = { id: 'not an id', name: 'Someone', department: null, manager: null, addedOn: '2026-10-01' }
    answers.push(json(200, { ...noticePeopleForClient(), people: [...PEOPLE, unreadable], later: true }))
    const read = await noticePeopleQuery.queryFn?.({ signal: new AbortController().signal } as never)
    expect(read?.people.map(person => person.name)).toEqual(PEOPLE.map(person => person.name))
    expect(read).not.toHaveProperty('later')

    const body = {
      person: PEOPLE[4]?.id ?? '',
      notice: NOTICE_ID,
      acknowledgedOn: '2026-10-21',
      note: 'Signed a printed copy at induction',
    }
    answers.push(json(200, { version: 0, changed: true }))
    expect(await recordAcknowledgement(body)).toEqual({ version: 0, changed: true })
    expect(calls.map(call => [call.url, call.init?.method])).toEqual([
      ['/api/admin/notice/people', 'GET'],
      ['/api/admin/notice/acknowledgements/record', 'POST'],
    ])
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual(body)
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
