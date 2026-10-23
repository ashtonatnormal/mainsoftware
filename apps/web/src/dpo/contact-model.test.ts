// The DPO's contact page, pure, in Node (PDPA-13, PDPA-02; C0.9 OD-10, OD-11, PD-64, PD-70): GET
// /api/admin/notice/contact's answer as the page shows it, the form and the body the api takes,
// what holds a save back, what a refused save says (dpo/contact-model.ts), and its calls
// (dpo/queries.ts). How the page and the dialog render is dpo.markup.test.tsx's; how they behave in
// a browser, dpo.spec.ts's (DPP-E7).
import { MESSAGES, REAUTH_METHOD_MESSAGES, SetContactBody } from '@hearth/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiFailure } from '@/api/http.ts'
import { CONTACT } from '@/strings/dpo-contact.ts'
import {
  contactBodyOf,
  contactEditor,
  contactFormOf,
  contactRefusalOf,
  contactSavedText,
  contactView,
  DEFAULT_TITLE,
} from './contact-model.ts'
import { CONTACT_SAVE_MOVES, contactQuery, noticeAdminQuery, registersQuery, saveContact } from './queries.ts'
import { contactAdminForClient, contactRow } from './testing/registers.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('C0.9 PD-70: the DPO’s contact page (dpo/contact-model.ts)', () => {
  it('CTW-01 PD-70: with no contact the page offers to record one, whatever the notice; with one, its card says whether the published notice gives it: in it, not yet (an earlier contact, or none printed, each with its line), not published yet, or nothing when the marker can’t be read', () => {
    expect(contactView(contactAdminForClient())).toEqual({ kind: 'none' })
    // A version is published, but it was published before any contact was recorded.
    expect(contactView(contactAdminForClient({ notice: 'out_of_date', stated: 'not_printed' }))).toEqual({
      kind: 'none',
    })

    const row = contactRow()
    const view = (stated: 'unpublished' | 'stated' | 'not_printed' | 'not_stated') =>
      contactView(
        contactAdminForClient({ notice: stated === 'unpublished' ? 'none' : 'out_of_date', contact: row, stated }),
      )
    expect(view('stated')).toEqual({
      kind: 'contact',
      title: 'Data Protection Officer',
      pill: { tone: 'ok', text: 'In the published notice' },
      line: undefined,
      facts: [
        { term: 'Email address', value: 'dpo@tembusu.example' },
        { term: 'Phone', value: 'Not recorded' },
        { term: 'Postal address', value: '1 Example Road\nSingapore 000000', lines: true },
        { term: 'Recorded', value: 'Tue 20 Oct 2026 by Ashton Teo' },
      ],
    })
    expect(view('not_printed')).toMatchObject({
      pill: { tone: 'warn', text: CONTACT.stated.no },
      line: CONTACT.stated.notPrintedLine,
    })
    expect(view('not_stated')).toMatchObject({
      pill: { tone: 'warn', text: CONTACT.stated.no },
      line: CONTACT.stated.noLine,
    })
    expect(view('unpublished')).toMatchObject({ pill: { tone: 'muted', text: CONTACT.stated.none }, line: undefined })
    // An unreadable marker shows no pill and claims nothing.
    expect(contactView({ contact: row, stated: null })).toMatchObject({ pill: undefined, line: undefined })
    // Nobody named: the day alone.
    expect(contactView({ contact: { ...row, recordedBy: null }, stated: 'stated' })).toMatchObject({
      facts: expect.arrayContaining([{ term: 'Recorded', value: 'Tue 20 Oct 2026' }]),
    })
  })

  it('CTW-02 OD-10: the form starts from the current contact, or with none from the role title alone, never a person’s name', () => {
    expect(contactFormOf(null)).toEqual({ title: 'Data Protection Officer', email: '', phone: '', postal: '' })
    expect(DEFAULT_TITLE).toBe('Data Protection Officer')
    expect(contactFormOf(contactRow({ phone: '+65 8000 0198' }))).toEqual({
      title: 'Data Protection Officer',
      email: 'dpo@tembusu.example',
      phone: '+65 8000 0198',
      postal: '1 Example Road\nSingapore 000000',
    })
  })

  it('CTW-03 PD-25 PD-64: the body sends the settings version the page read (null before any), each field trimmed and a blank one as not recorded, and the postal address’s lines as the api keeps them', () => {
    const form = {
      title: '  Data Protection Officer ',
      email: ' dpo@tembusu.example ',
      phone: '   ',
      postal: ' 1 Example Road \r\n\r\n  Singapore   000000\n',
    }
    const body = contactBodyOf(null, form)
    expect(body).toEqual({
      seen: null,
      title: 'Data Protection Officer',
      email: 'dpo@tembusu.example',
      phone: null,
      postal: '1 Example Road\nSingapore 000000',
    })
    // What the api reads it as is what was sent.
    expect(SetContactBody.parse(body)).toEqual(body)
    expect(contactBodyOf(contactRow({ version: 4 }), form).seen).toBe(4)
    expect(contactBodyOf(null, { ...form, postal: ' \n ' }).postal).toBeNull()
    // A tab pasted into the role title (a text input keeps it) is a space, as the api reads it.
    const tabbed = contactBodyOf(null, { ...form, title: 'Data\tProtection Officer' })
    expect(tabbed.title).toBe('Data Protection Officer')
    expect(SetContactBody.parse(tabbed)).toEqual(tabbed)
  })

  it('CTW-04 PD-64 OD-11: what holds a save back is listed in set_dpo_contact()’s order, each with the field it is about (a missing channel with none), checked on the body the save would send; a save warns the notice goes out of date only once a version is published', () => {
    const none = contactAdminForClient()
    const empty = contactEditor({ title: '', email: '', phone: '', postal: '' }, none)
    expect(empty.problems).toEqual([
      { field: 'title', text: 'Give a role title.' },
      { field: undefined, text: 'Give an email address, a phone number or a postal address.' },
    ])
    const wrong = contactEditor(
      { title: 'x'.repeat(121), email: 'dpo at tembusu', phone: '8000 0198', postal: 'y'.repeat(501) },
      none,
    )
    expect(wrong.problems).toEqual([
      { field: 'title', text: 'Keep the role title to one line of at most 120 characters.' },
      { field: 'email', text: 'Enter an email address such as name@example.org.' },
      { field: 'phone', text: 'Enter the phone number starting with + and the country code.' },
      { field: 'postal', text: 'Keep the postal address to 500 characters.' },
    ])
    // Words Hearth keeps off its screens name the field, never the words (C-05).
    const copy = contactEditor({ title: 'AI Data Protection Officer', email: '', phone: '', postal: '1 Road' }, none)
    expect(copy.problems).toEqual([
      { field: 'title', text: 'The role title uses wording Hearth keeps off its screens. Reword it.' },
    ])
    // Stray spaces and blank lines the api drops are never held against the form, nor a tab pasted
    // into the role title, which looks like one line and is sent as one.
    expect(
      contactEditor({ title: 'Data\tProtection Officer', email: 'dpo@tembusu.example', phone: '', postal: '' }, none)
        .problems,
    ).toEqual([])
    expect(
      contactEditor(
        {
          title: ' Data Protection Officer ',
          email: '',
          phone: '',
          postal: '\n 1 Example Road \n\n Singapore 000000 \n',
        },
        none,
      ).problems,
    ).toEqual([])
    expect(empty.stale).toBe(false)
    expect(
      contactEditor(contactFormOf(null), contactAdminForClient({ notice: 'up_to_date', stated: 'not_printed' })).stale,
    ).toBe(true)
  })

  it('CTW-05 PD-21 PD-25 PD-30: a save that changed nothing says so; a refusal offers Reload when the contact moved, asks to check each field when a rule wasn’t caught, asks for the PIN, says the page is the DPO’s, or gives the server’s words', () => {
    expect(contactSavedText({ changed: true })).toBe('Contact details saved.')
    expect(contactSavedText({ changed: false })).toBe('Nothing changed.')
    const failure = (status: number, code: string, extra = {}) =>
      new ApiFailure(status, code, (MESSAGES as Record<string, string>)[code] ?? MESSAGES.internal, extra)
    expect(contactRefusalOf(failure(409, 'register_changed'))).toEqual({ kind: 'changed', text: CONTACT.changedSince })
    expect(contactRefusalOf(failure(400, 'register_invalid'))).toEqual({ kind: 'message', text: CONTACT.invalid })
    expect(
      contactRefusalOf(new ApiFailure(403, 'reauth_required', REAUTH_METHOD_MESSAGES.pin.required, { method: 'pin' })),
    ).toEqual({ kind: 'pin' })
    expect(contactRefusalOf(failure(403, 'forbidden'))).toMatchObject({ kind: 'forbidden' })
    expect(contactRefusalOf(failure(409, 'try_again'))).toEqual({ kind: 'message', text: MESSAGES.try_again })
    expect(contactRefusalOf(new Error('a bug'))).toEqual({ kind: 'message', text: MESSAGES.internal })
  })

  it('CTW-05 PD-70: the page reads /api/admin/notice/contact leniently, never again on focus or reconnect; Save posts the body to /api/admin/notice/contact/set and reads the version and whether it changed, and a save reads the contact, the registers and the Notice tab again', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const answers: Response[] = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const next = answers.shift()
      if (next === undefined) throw new TypeError('Failed to fetch')
      return next
    })
    expect(contactQuery.queryKey).toEqual(['notice-contact'])
    expect(contactQuery).toMatchObject({ staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false })
    expect(CONTACT_SAVE_MOVES).toEqual([contactQuery.queryKey, registersQuery.queryKey, noticeAdminQuery.queryKey])

    answers.push(json(200, { ...contactAdminForClient({ contact: contactRow() }), later: true }))
    const read = await contactQuery.queryFn?.({ signal: new AbortController().signal } as never)
    expect(read?.contact?.email).toBe('dpo@tembusu.example')
    expect(read).not.toHaveProperty('later')

    const body = contactBodyOf(null, contactFormOf(null))
    answers.push(json(200, { version: 1, changed: true }))
    expect(await saveContact({ ...body, email: 'dpo@tembusu.example' })).toEqual({ version: 1, changed: true })
    expect(calls.map(call => [call.url, call.init?.method])).toEqual([
      ['/api/admin/notice/contact', 'GET'],
      ['/api/admin/notice/contact/set', 'POST'],
    ])
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      seen: null,
      title: 'Data Protection Officer',
      email: 'dpo@tembusu.example',
      phone: null,
      postal: null,
    })
  })
})
