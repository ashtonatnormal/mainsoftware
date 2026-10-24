// The DPO pages' logic (dpo/model.ts) and calls (dpo/queries.ts), in Node (C0.9 PD-20 to PD-27;
// TECH-SPEC T22 items 2, 3, 13 and 15).
import {
  MESSAGES,
  PURPOSE_STATUSES,
  REAUTH_METHOD_MESSAGES,
  RecordTransferBody,
  SetPurposeBody,
  TransferWriteResponse,
} from '@hearth/shared'
import { MutationObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiFailure } from '@/api/http.ts'
import { dayText as timeDayText } from '@/lib/time.ts'
import { createQueryClient } from '@/session/query-client.ts'
import { DPO } from '@/strings/dpo.ts'
import { PURPOSE_PROBLEM_COPY } from '@/strings/dpo-purposes.ts'
import { PROVIDER_CHECKS, TRANSFER_PROBLEM_COPY, TRANSFERS_COPY } from '@/strings/dpo-transfers.ts'
import { dayText, failureOf, landedText, pinEntryProblem, pinOutcomeOf, refusalOf } from './model.ts'
import { purposeBodyOf, purposeEditor, purposeFormOf, purposeView } from './purposes-model.ts'
import { pinStepOptions, reauthWithPin, registersQuery, sendWrite, WRITE_PATHS } from './queries.ts'
import { COMPLETE_FACTS, registersForClient, TODAY } from './testing/registers.ts'
import { countriesOf, recordBodyOf, reviewOf, transferEditor, transferFormOf, transferView } from './transfers-model.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const purposeOf = (registers: ReturnType<typeof registersForClient>, key: string) => {
  const row = registers.purposes.find(each => each.purpose === key)
  if (row === undefined) throw new Error(`no ${key}`)
  return row
}
const transferOf = (registers: ReturnType<typeof registersForClient>, key: string) => {
  const row = registers.transfers.find(each => each.provider === key)
  if (row === undefined) throw new Error(`no ${key}`)
  return row
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('C0.9 PD-26: the DPO pages’ model (dpo/model.ts)', () => {
  it('DPP-01 PDPA-01 PD-06 PD-27: the answer maps to the cards (status, basis or Not recorded, retention, providers, who recorded it) and only non-AI rows reach the page; the form maps back to the body the api takes, with the version it read', () => {
    const registers = registersForClient({
      security_audit: {
        version: 2,
        basis: 'legitimate_interests',
        basisReference: 'Assessment in the DPO’s file',
        retention: '13 months',
        providers: ['aws'],
        recordedOn: '2026-10-20',
        recordedBy: 'Ashton Teo',
      },
    })
    expect(registers.purposes.map(row => row.purpose)).not.toContain('transcription')
    expect(registers.purposes).toHaveLength(13)
    expect(registers.transfers.map(row => row.provider)).toEqual([
      'aws',
      'aws_sms',
      'twilio',
      'livekit',
      'apple_push',
      'google_fcm',
      'mozilla_push',
      'microsoft_wns',
    ])

    const accounts = purposeView(purposeOf(registers, 'accounts'))
    expect(accounts).toMatchObject({ status: 'active', statusLabel: 'Active', pinned: true })
    expect(accounts.facts).toEqual([
      { term: 'Legal basis', value: 'Not recorded' },
      { term: 'How long it’s kept', value: 'Not recorded' },
      { term: 'Who receives it', value: 'Nobody outside Hearth' },
      { term: 'Version', value: '1' },
      { term: 'Recorded', value: 'Set by Hearth, Thu 1 Oct 2026' },
    ])

    const audit = purposeOf(registers, 'security_audit')
    expect(purposeView(audit)).toMatchObject({ label: 'Security audit and monitoring', pinned: false })
    expect(purposeView(audit).facts).toEqual([
      { term: 'Legal basis', value: 'Legitimate interests' },
      { term: 'Where the legitimate interests assessment is kept', value: 'Assessment in the DPO’s file' },
      { term: 'How long it’s kept', value: '13 months' },
      { term: 'Who receives it', value: 'Amazon Web Services' },
      { term: 'Version', value: '2' },
      { term: 'Recorded', value: 'Tue 20 Oct 2026 by Ashton Teo' },
    ])

    // The form round-trips to a body the strict schema takes, from the version shown.
    const form = { ...purposeFormOf(audit), retention: '  12 months ', providers: ['twilio', 'aws', 'aws'] }
    const body = purposeBodyOf(audit, form)
    expect(body).toEqual({
      purpose: 'security_audit',
      seen: 2,
      status: 'active',
      basis: 'legitimate_interests',
      basisReference: 'Assessment in the DPO’s file',
      optOutDays: null,
      retention: '12 months',
      providers: ['aws', 'twilio'],
    })
    expect(SetPurposeBody.safeParse(body).success).toBe(true)
  })

  it('DPP-01 PDPA-10 PD-05: a transfer row maps to its form and back to the body, countries typed in any case once each and sorted, the revision it read, and keepCleared as asked', () => {
    const registers = registersForClient({}, { twilio: { ...COMPLETE_FACTS, revision: 3 } })
    const twilio = transferOf(registers, 'twilio')
    const form = transferFormOf(twilio)
    expect(form.processingCountries).toBe('US')
    expect(form.storageCountries).toBe('IE, US')
    const typed = { ...form, storageCountries: 'us sg,  ie;US' }
    const body = recordBodyOf(twilio, typed, true)
    expect(body).toMatchObject({ provider: 'twilio', seen: 3, storageCountries: ['IE', 'SG', 'US'], keepCleared: true })
    expect(RecordTransferBody.safeParse(body).success).toBe(true)
    // The certificate's date is sent only with a certification.
    const dated = { ...form, certificateVerifiedOn: '2026-09-01' }
    expect(recordBodyOf(twilio, dated, false).certificateVerifiedOn).toBeNull()
    expect(recordBodyOf(twilio, { ...dated, safeguard: 'certification' }, false).certificateVerifiedOn).toBe(
      '2026-09-01',
    )

    expect(countriesOf('sg, US us')).toEqual({ codes: ['SG', 'US'], valid: true })
    expect(countriesOf('')).toEqual({ codes: [], valid: true })
    expect(countriesOf('Singapore').valid).toBe(false)
    expect(countriesOf('S1').valid).toBe(false)
    expect(dayText('2026-10-22')).toBe('Thu 22 Oct 2026')
    // Re-exported from lib/time.ts, where Settings reads it without the DPO's chunk (C0.9 PD-75).
    expect(dayText).toBe(timeDayText)
  })

  it('DPP-01 PD-20 PD-21: the calls go to their /api/admin/registers paths with the bodies given, the registers are read leniently and never again on focus or reconnect, and the PIN goes to /api/auth/reauth/pin', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const answers: Response[] = []
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const next = answers.shift()
      if (next === undefined) throw new TypeError('Failed to fetch')
      return next
    })

    expect(registersQuery.queryKey).toEqual(['registers'])
    expect(registersQuery).toMatchObject({ refetchOnWindowFocus: false, refetchOnReconnect: false })
    answers.push(json(200, { ...registersForClient(), later: 'a field the server adds' }))
    const read = await registersQuery.queryFn?.({ signal: new AbortController().signal } as never)
    expect(read?.purposes).toHaveLength(13)

    const written = TransferWriteResponse.parse({
      entry: 'c0000000-0000-4000-8000-000000000001',
      revision: 2,
      cleared: true,
      changed: true,
    })
    const writes = [
      { kind: 'purpose', body: { purpose: 'backups' } },
      { kind: 'record', body: { provider: 'aws' } },
      { kind: 'clear', body: { provider: 'aws', seen: 2 } },
      { kind: 'withdraw', body: { provider: 'aws' } },
    ] as const
    for (const write of writes) {
      answers.push(json(200, written))
      expect(await sendWrite(write as Parameters<typeof sendWrite>[0])).toEqual({ changed: true })
    }
    // A write that changed nothing says so, never its saved line (PD-21).
    expect(landedText({ changed: true }, DPO.saved)).toBe('Saved.')
    expect(landedText({ changed: false }, DPO.saved)).toBe('Nothing changed.')
    expect(landedText({ changed: false }, TRANSFERS_COPY.clearedToast('LiveKit Cloud'))).toBe('Nothing changed.')
    answers.push(json(200, { status: 'reauthenticated', validForSeconds: 300 }))
    await reauthWithPin('284917')

    expect(calls.map(call => [call.url, call.init?.method])).toEqual([
      ['/api/admin/registers', 'GET'],
      ['/api/admin/registers/purposes/set', 'POST'],
      ['/api/admin/registers/transfers/record', 'POST'],
      ['/api/admin/registers/transfers/clear', 'POST'],
      ['/api/admin/registers/transfers/withdraw', 'POST'],
      ['/api/auth/reauth/pin', 'POST'],
    ])
    expect(calls.slice(1, 5).map(call => JSON.parse(String(call.init?.body)))).toEqual(writes.map(write => write.body))
    expect(JSON.parse(String(calls[5]?.init?.body))).toEqual({ pin: '284917' })
    expect(Object.keys(WRITE_PATHS).sort()).toEqual(['clear', 'purpose', 'record', 'withdraw'])
  })

  it('DPP-02 PDPA-01 PD-07 PD-11: each basis brings the field it takes and no other; a pinned purpose offers Active alone and no consent-type basis; one that needs a switch offers no consent-type basis; the rest offer every status and basis', () => {
    const registers = registersForClient()
    const backups = purposeOf(registers, 'backups')
    const form = purposeFormOf(backups)

    const withBasis = (basis: Parameters<typeof purposeEditor>[1]['basis']) =>
      purposeEditor('backups', { ...form, basis })
    expect(withBasis('legitimate_interests')).toMatchObject({
      referenceLabel: 'Where the legitimate interests assessment is kept',
      takesOptOut: false,
    })
    expect(withBasis('deemed_consent_notification')).toMatchObject({
      referenceLabel: 'Where the assessment is kept',
      takesOptOut: true,
    })
    expect(withBasis('other_exception')).toMatchObject({
      referenceLabel: 'The provision relied on',
      takesOptOut: false,
    })
    for (const basis of ['employment', 'business_improvement', 'consent', 'deemed_consent_conduct', ''] as const) {
      expect(withBasis(basis), basis).toMatchObject({ referenceLabel: undefined, takesOptOut: false })
    }

    // What a field the basis doesn't take held is never sent, so it can't be a problem.
    const typedThenChanged = {
      ...form,
      basis: 'employment' as const,
      basisReference: 'left over',
      optOutDays: '30',
      retention: '7 years',
    }
    expect(purposeEditor('backups', typedThenChanged).problems).toEqual([])
    expect(purposeBodyOf(backups, typedThenChanged)).toMatchObject({ basisReference: null, optOutDays: null })

    // Problems, worded, in the shared rules' order; Active needs a basis and a retention.
    expect(purposeEditor('backups', { ...form, basis: '', retention: '' }).problems).toEqual([
      'basis_missing',
      'retention_missing',
    ])
    expect(
      purposeEditor('backups', { ...form, basis: 'deemed_consent_notification', retention: 'x', optOutDays: '400' })
        .problems,
    ).toEqual(['reference_missing', 'opt_out_range'])
    expect(
      purposeEditor('backups', { ...form, basis: 'deemed_consent_notification', retention: 'x', optOutDays: 'two' })
        .problems,
    ).toEqual(['reference_missing', 'opt_out_range'])
    expect(
      purposeEditor('presence_receipts', { ...form, status: 'planned', basis: '', retention: '' }).problems,
    ).toEqual([])
    for (const problem of ['basis_missing', 'retention_missing', 'opt_out_range'] as const) {
      expect(PURPOSE_PROBLEM_COPY[problem]).toMatch(/\.$/)
    }

    // Warnings never block.
    const consent = purposeEditor('presence_receipts', { ...form, basis: 'consent', retention: '30 days' })
    expect(consent).toMatchObject({ problems: [], warnings: ['withdrawal_by_hand'] })
    expect(purposeEditor('session_slides', { ...form, basis: 'consent', retention: 'x' }).warnings).toEqual([
      'no_opt_out_consent',
      'withdrawal_by_hand',
    ])
    expect(purposeEditor('backups', { ...form, basis: 'business_improvement', retention: 'x' }).warnings).toEqual([
      'business_improvement',
    ])

    // What each kind of purpose is offered.
    const pinned = purposeEditor('accounts', purposeFormOf(purposeOf(registers, 'accounts')))
    expect(pinned.statuses).toEqual(['active'])
    expect(pinned.bases).toEqual(['employment', 'legitimate_interests', 'business_improvement', 'other_exception'])
    const recording = purposeEditor('recording_meetings', purposeFormOf(purposeOf(registers, 'recording_meetings')))
    expect(recording.statuses).toEqual(PURPOSE_STATUSES)
    expect(recording.bases).toEqual(['employment', 'legitimate_interests', 'business_improvement', 'other_exception'])
    const plain = purposeEditor('presence_receipts', purposeFormOf(purposeOf(registers, 'presence_receipts')))
    expect(plain.bases).toHaveLength(7)
  })

  it('DPP-03 PDPA-10 PD-12 PD-13 T22 item 3: a card says whether the provider is cleared, by whom, at set-up or since withdrawn; the review date is overdue only once passed while cleared; Clear for use is held until nothing is missing; and what checks each provider today', () => {
    const cleared = (via: 'app' | 'bootstrap' | 'break_glass', by: string | null) => ({
      clearedOn: '2026-10-02',
      clearedBy: by,
      clearedVia: via,
      revision: 2,
      withdrawnOn: null,
      withdrawnBy: null,
      withdrawReason: null,
    })
    const registers = registersForClient(
      {},
      {
        twilio: {
          ...COMPLETE_FACTS,
          revision: 2,
          clearance: cleared('bootstrap', 'Ashton Teo'),
          reviewOn: '2026-10-01',
        },
        aws: { ...COMPLETE_FACTS, revision: 2, clearance: cleared('app', 'Ashton Teo'), updatedBy: 'Ashton Teo' },
        livekit: {
          ...COMPLETE_FACTS,
          revision: 3,
          clearance: {
            ...cleared('app', 'Ashton Teo'),
            withdrawnOn: '2026-10-10',
            withdrawnBy: 'Ashton Teo',
            withdrawReason: 'dpo_decision',
          },
        },
        apple_push: {
          ...COMPLETE_FACTS,
          revision: 4,
          clearance: {
            ...cleared('app', 'Ashton Teo'),
            withdrawnOn: '2026-10-11',
            withdrawnBy: 'Ashton Teo',
            withdrawReason: 'facts_changed',
          },
        },
        mozilla_push: { reviewOn: TODAY },
      },
    )
    const twilio = transferView(transferOf(registers, 'twilio'), TODAY)
    expect(twilio).toMatchObject({
      name: 'Twilio Verify',
      cleared: true,
      clearance: 'Cleared at set-up on Fri 2 Oct 2026',
      review: { text: 'Review overdue since Thu 1 Oct 2026', overdue: true },
      checkedBy: PROVIDER_CHECKS.twilio.checkedBy,
    })
    expect(twilio.checkedBy).toMatch(/sign-in or re-authentication code/)
    expect(twilio.withdrawing).toMatch(/Nobody can get a sign-in code/)
    const aws = transferView(transferOf(registers, 'aws'), TODAY)
    expect(aws).toMatchObject({ clearance: 'Cleared on Fri 2 Oct 2026 by Ashton Teo', review: { overdue: false } })
    expect(aws.withdrawing).toMatch(/stops nothing yet/)
    expect(aws.facts).toContainEqual({ term: 'Stores in', value: 'Ireland, United States' })
    expect(transferView(transferOf(registers, 'livekit'), TODAY)).toMatchObject({
      cleared: false,
      clearance: 'Clearance withdrawn on Sat 10 Oct 2026',
      clearHeld: undefined,
    })
    expect(transferView(transferOf(registers, 'apple_push'), TODAY).clearance).toBe(
      'Clearance ended on Sun 11 Oct 2026, when new facts were saved',
    )
    // Not cleared: a review date today is not overdue; and nothing recorded holds Clear for use.
    const mozilla = transferView(transferOf(registers, 'mozilla_push'), TODAY)
    expect(mozilla).toMatchObject({ cleared: false, clearance: undefined, clearHeld: TRANSFERS_COPY.clearHeld })
    // Twilio Verify not cleared says what that stops: never cleared, withdrawn, or ended by a plain
    // Save of new facts.
    const never = registersForClient()
    expect(transferView(transferOf(never, 'twilio'), TODAY).clearance).toBe(
      'No sign-in code is sent until it’s cleared.',
    )
    for (const [withdrawReason, line] of [
      ['dpo_decision', 'Clearance withdrawn on Sat 10 Oct 2026. No sign-in code is sent until it’s cleared again.'],
      [
        'facts_changed',
        'Clearance ended on Sat 10 Oct 2026, when new facts were saved. No sign-in code is sent until it’s cleared again.',
      ],
    ] as const) {
      const ended = registersForClient(
        {},
        {
          twilio: {
            ...COMPLETE_FACTS,
            revision: 3,
            clearance: {
              ...cleared('app', 'Ashton Teo'),
              withdrawnOn: '2026-10-10',
              withdrawnBy: 'Ashton Teo',
              withdrawReason,
            },
          },
        },
      )
      expect(transferView(transferOf(ended, 'twilio'), TODAY)).toMatchObject({ cleared: false, clearance: line })
    }
    expect(mozilla.review).toEqual({ text: 'Review by Thu 22 Oct 2026', overdue: false })
    expect(reviewOf(transferOf(registers, 'aws_sms'), TODAY)).toBeUndefined()
    // Every provider shown says what checks it; only Twilio Verify is checked today.
    for (const row of registers.transfers) {
      const checks = transferView(row, TODAY).checkedBy
      expect(checks === PROVIDER_CHECKS.twilio.checkedBy, row.provider).toBe(row.provider === 'twilio')
    }
  })

  it('DPP-03 OD-20 PD-80: Twilio Verify cleared again by the break-glass re-clear says so, so the DPO coming back sees why it is cleared and that it wasn’t them; withdrawing it, and a plain Save that ends it, say only that re-clear restores codes once every DPO’s session has ended', () => {
    const registers = registersForClient(
      {},
      {
        twilio: {
          ...COMPLETE_FACTS,
          revision: 3,
          clearance: {
            clearedOn: '2026-10-02',
            clearedBy: 'Ashton Teo',
            clearedVia: 'break_glass',
            revision: 3,
            withdrawnOn: null,
            withdrawnBy: null,
            withdrawReason: null,
          },
        },
      },
    )
    const twilio = transferView(transferOf(registers, 'twilio'), TODAY)
    expect(twilio).toMatchObject({
      cleared: true,
      clearance: 'Cleared again by the emergency re-clear on Fri 2 Oct 2026. Check its facts and review date.',
    })
    expect(twilio.withdrawing.endsWith(TRANSFERS_COPY.twilioLastSession)).toBe(true)
    expect(TRANSFERS_COPY.twilioLastSession).toBe(
      'If every Data Protection Officer’s session ends before Twilio Verify is cleared again, only the emergency re-clear in the runbook restores sign-in codes.',
    )
    // Only Twilio Verify's warning says it: no other provider has a re-clear.
    for (const row of registers.transfers.filter(each => each.provider !== 'twilio')) {
      expect(transferView(row, TODAY).withdrawing, row.provider).not.toContain(TRANSFERS_COPY.twilioLastSession)
    }
  })

  it('DPP-03 PD-05 PD-12: Still needed lists every missing fact in order; Save and keep cleared is held while one is missing; a plain Save of changed facts on a cleared entry asks first, and of unchanged ones doesn’t; a wrongly typed country holds Save', () => {
    const registers = registersForClient(
      {},
      {
        twilio: {
          ...COMPLETE_FACTS,
          revision: 2,
          clearance: {
            clearedOn: '2026-10-02',
            clearedBy: 'Ashton Teo',
            clearedVia: 'app',
            revision: 2,
            withdrawnOn: null,
            withdrawnBy: null,
            withdrawReason: null,
          },
        },
      },
    )
    const empty = transferOf(registers, 'apple_push')
    expect(transferEditor(empty, transferFormOf(empty), TODAY).problems).toEqual([
      'services',
      'data_types',
      'processing_countries',
      'storage_countries',
      'countries_confirmed',
      'safeguard',
      'safeguard_reference',
      'dpa_terms',
      'training',
      'zero_retention',
      'provider_retention',
      'retention_confirmed',
      'onward_recipients',
      'review_on',
    ])
    for (const problem of transferEditor(empty, transferFormOf(empty), TODAY).problems) {
      expect(TRANSFER_PROBLEM_COPY[problem], problem).not.toBe('')
    }

    const twilio = transferOf(registers, 'twilio')
    const form = transferFormOf(twilio)
    const unchanged = transferEditor(twilio, form, TODAY)
    expect(unchanged).toMatchObject({
      problems: [],
      changed: false,
      cleared: true,
      saveEndsClearance: false,
      keepClearedHeld: undefined,
    })
    const typo = transferEditor(twilio, { ...form, services: 'Texting sign-in codes and nothing else' }, TODAY)
    expect(typo).toMatchObject({ changed: true, saveEndsClearance: true, keepClearedHeld: undefined })
    const incomplete = transferEditor(twilio, { ...form, onwardRecipients: ' ', zeroRetention: 'pending' }, TODAY)
    expect(incomplete.problems).toEqual(['zero_retention', 'onward_recipients'])
    expect(incomplete.keepClearedHeld).toBe(TRANSFERS_COPY.saveKeepClearedHeld)
    expect(transferEditor(twilio, { ...form, reviewOn: TODAY }, TODAY).problems).toEqual(['review_due'])
    const countries = transferEditor(twilio, { ...form, processingCountries: 'Singapore' }, TODAY)
    expect(countries).toMatchObject({ processingInvalid: true, saveHeld: TRANSFERS_COPY.countriesInvalid })
    expect(countries.keepClearedHeld).toBe(TRANSFERS_COPY.countriesInvalid)
  })

  it('DPP-04 D46 PD-30 T20 item 6: a refusal naming the PIN brings the PIN step; any other method (sign_in, and code, which these pages have no step for) only a new sign-in; forbidden says the page is the DPO’s; register_changed offers Reload; anything else is the server’s words', () => {
    const failure = (code: string, extra = {}, serverMessage = 'server words') => ({ code, serverMessage, extra })
    expect(refusalOf(failure('reauth_required', { method: 'pin' }))).toEqual({ kind: 'pin' })
    for (const method of ['sign_in', 'code'] as const) {
      expect(refusalOf(failure('reauth_required', { method }))).toEqual({
        kind: 'sign_in',
        text: REAUTH_METHOD_MESSAGES.sign_in.required,
      })
    }
    // No method named reads as sign_in, which always works.
    expect(refusalOf(failure('reauth_required')).kind).toBe('sign_in')
    expect(refusalOf(failure('forbidden'))).toEqual({
      kind: 'forbidden',
      text: 'This page is for the Data Protection Officer.',
    })
    expect(refusalOf(failure('register_changed', {}, MESSAGES.register_changed))).toEqual({
      kind: 'changed',
      text: MESSAGES.register_changed,
    })
    expect(refusalOf(failure('register_invalid', {}, MESSAGES.register_invalid))).toEqual({
      kind: 'message',
      text: MESSAGES.register_invalid,
    })
    expect(refusalOf(failureOf(new Error('a bug')))).toEqual({ kind: 'message', text: MESSAGES.internal })

    // The PIN step's own refusals.
    expect(pinOutcomeOf(failure('pin_wrong', {}, MESSAGES.pin_wrong))).toEqual({
      kind: 'field',
      text: MESSAGES.pin_wrong,
    })
    expect(pinOutcomeOf(failure('reauth_method', { method: 'sign_in' }))).toEqual({
      kind: 'sign_in',
      text: REAUTH_METHOD_MESSAGES.sign_in.method,
    })
    expect(pinOutcomeOf(failure('pin_reset_needed', {}, MESSAGES.pin_reset_needed))).toEqual({
      kind: 'field',
      text: DPO.reauth.pinResetNeeded,
    })
    // A lock only an Owner lifts: the server's line (auth/errors.ts PIN_ADMIN_LOCKED_MESSAGE) says
    // "Ask", so the pages word it; a lock that ends is said in the server's words.
    const adminLocked = "Your PIN is locked. Ask an Owner to reset it. They'll check it's you first."
    expect(pinOutcomeOf(failure('pin_locked', { pin: { state: 'admin_locked' } }, adminLocked))).toEqual({
      kind: 'field',
      text: DPO.reauth.pinAdminLocked,
    })
    expect(
      pinOutcomeOf(
        failure('pin_locked', { pin: { state: 'locked', until: '2026-10-22T09:00:00Z' } }, MESSAGES.pin_locked),
      ),
    ).toEqual({ kind: 'field', text: MESSAGES.pin_locked })
    expect(pinEntryProblem('12345')).toBe(MESSAGES.invalid_pin)
    expect(pinEntryProblem('284917')).toBeUndefined()
  })

  it('DPP-04 PD-30 WS-01: the PIN step’s mutation keeps the PIN out of Query’s cache: it takes no variables, reads the PIN on each try (a retry after try_again sends it again), empties the step’s holder once settled, and is dropped once no step observes it', async () => {
    const client = createQueryClient(() => {}, { random: () => 0 })
    const sent: string[] = []
    const answers: (ApiFailure | undefined)[] = [
      new ApiFailure(409, 'try_again', MESSAGES.try_again),
      undefined,
      new ApiFailure(401, 'pin_wrong', MESSAGES.pin_wrong),
    ]
    const entered = { current: '284917' }
    const observer = new MutationObserver(
      client,
      pinStepOptions(entered, async pin => {
        sent.push(pin)
        const answer = answers.shift()
        if (answer !== undefined) throw answer
      }),
    )
    const cached = () =>
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map(mutation => mutation.state),
      )
    await observer.mutate()
    expect(sent).toEqual(['284917', '284917'])
    expect(entered.current).toBe('')
    expect(cached()).not.toContain('284917')
    // A wrong PIN: refused, and held nowhere either.
    entered.current = '615203'
    await expect(observer.mutate()).rejects.toMatchObject({ code: 'pin_wrong' })
    expect(sent.at(-1)).toBe('615203')
    expect(entered.current).toBe('')
    expect(cached()).not.toMatch(/284917|615203/)
    // Once no step observes it, it is gone at once (gcTime 0).
    observer.reset()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(client.getMutationCache().getAll()).toEqual([])
  })
})
