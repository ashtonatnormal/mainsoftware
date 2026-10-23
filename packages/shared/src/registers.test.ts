// The registers' shared rules, and the api's bodies and answers (C0.9, TECH-SPEC T22). That the
// rules agree with migration 0009's is checked against the database by the DB tests (RGS-02,
// RGS-06, RGS-09) and the registers integration suite (RGS-I4).
import { describe, expect, it } from 'vitest'
import { PINNED_PURPOSES } from './flags.ts'
import { PROVIDERS, PURPOSE_KEYS, PURPOSES } from './purposes.ts'
import {
  BASES,
  BASIS_NEEDS,
  type Basis,
  basesFor,
  ClearTransferBody,
  CONSENT_BASES,
  NON_AI_PROVIDERS,
  NON_AI_PURPOSE_KEYS,
  PURPOSE_PROBLEMS,
  PURPOSE_STATUSES,
  type PurposeEntry,
  PurposeWriteResponse,
  purposeProblems,
  purposeWarnings,
  RecordTransferBody,
  RegistersResponse,
  RegistersResponseForClient,
  RegisterWriteResponseForClient,
  SetPurposeBody,
  SWITCH_BASES,
  statusesFor,
  TRANSFER_PROBLEMS,
  type TransferFacts,
  TransferWriteResponse,
  transferProblems,
  WithdrawTransferBody,
  ZERO_RETENTION,
} from './registers.ts'

const RETENTION = 'Two years after the person leaves'

// An entry with no problem for a purpose that isn't pinned and needs no switch.
const purpose = (change: Partial<PurposeEntry> = {}): PurposeEntry => ({
  status: 'active',
  basis: 'employment',
  basisReference: null,
  optOutDays: null,
  retention: RETENTION,
  providers: ['aws'],
  ...change,
})

// The attachments a basis takes, filled in, so only the rule under test can refuse.
const attached = (basis: Basis): Pick<PurposeEntry, 'basisReference' | 'optOutDays'> => ({
  basisReference: BASIS_NEEDS[basis].reference ? 'Assessment in the DPO’s file, 1 Oct 2026' : null,
  optOutDays: BASIS_NEEDS[basis].optOutDays ? 30 : null,
})

const TODAY = '2026-10-22'

// Every fact PD-12 needs, recorded: Twilio Verify's, fictional.
const FACTS: TransferFacts = {
  services: 'Verify: sign-in and re-authentication codes by SMS',
  dataTypes: 'Mobile number, channel, Service SID',
  processingCountries: ['US'],
  storageCountries: ['US'],
  countriesConfirmed: 'Data protection addendum, section 4, signed 1 Oct 2026',
  safeguard: 'dpa',
  safeguardReference: 'Data protection addendum, 1 Oct 2026',
  certificateVerifiedOn: null,
  dpaTermsConfirmed: true,
  training: 'not_applicable',
  zeroRetention: 'not_offered',
  providerRetention: 'Verification records for 90 days',
  retentionConfirmed: 'Support case, 2 Oct 2026',
  onwardRecipients: 'Mobile carriers',
  reviewOn: '2027-10-01',
}
const twilio = (change: Partial<TransferFacts> = {}) => ({ provider: 'twilio', ...FACTS, ...change })

describe('PDPA-01 C0.9 PD-11: the bases', () => {
  it('RGS-11 PDPA-01: seven bases, three of them consent-type, and every one a purpose needing a switch may not rest on yet', () => {
    expect(BASES).toHaveLength(7)
    expect([...CONSENT_BASES]).toEqual(['consent', 'deemed_consent_conduct', 'deemed_consent_notification'])
    // Deemed consent by conduct too: withdrawing it would need the switch as well (PDPA-04).
    expect([...SWITCH_BASES]).toEqual([...CONSENT_BASES])
    expect(Object.keys(BASIS_NEEDS)).toEqual([...BASES])
    const taking = (need: 'reference' | 'optOutDays') => BASES.filter(basis => BASIS_NEEDS[basis][need])
    expect(taking('reference')).toEqual(['legitimate_interests', 'deemed_consent_notification', 'other_exception'])
    expect(taking('optOutDays')).toEqual(['deemed_consent_notification'])
  })

  it('C0.9 PD-27: the pages list the 13 purposes and 8 providers outside the AI layer', () => {
    expect(NON_AI_PURPOSE_KEYS).toHaveLength(13)
    for (const key of NON_AI_PURPOSE_KEYS) expect(PURPOSES[key].ai, key).toBe(false)
    expect([...NON_AI_PROVIDERS]).toEqual(PROVIDERS.filter(key => key !== 'openai' && key !== 'bedrock'))
  })
})

describe('PDPA-01 C0.9 PD-04 PD-07 PD-11: purposeProblems mirrors set_register_purpose()', () => {
  it('RGS-11: an entry the rules allow has no problem, and a planned one needs nothing recorded', () => {
    expect(purposeProblems('security_audit', purpose())).toEqual([])
    expect(purposeProblems('accounts', purpose())).toEqual([])
    for (const status of ['planned', 'active', 'retired'] as const) {
      expect(purposeProblems('presence_receipts', purpose({ status })), status).toEqual([])
    }
    const nothing = purpose({ status: 'planned', basis: null, retention: null, providers: [] })
    expect(purposeProblems('presence_receipts', nothing)).toEqual([])
  })

  it('RGS-11 D41: an AI purpose stays planned with nothing recorded, and a key that isn’t a purpose is refused', () => {
    for (const key of PURPOSE_KEYS.filter(k => PURPOSES[k].ai)) {
      expect(purposeProblems(key, purpose()), key).toEqual(['ai_purpose'])
      expect(purposeProblems(key, purpose({ status: 'planned', basis: null, retention: null })), key).toEqual([
        'ai_purpose',
      ])
    }
    expect(purposeProblems('acounts', purpose())).toEqual(['unknown_purpose'])
    expect(purposeProblems('constructor', purpose())).toEqual(['unknown_purpose'])
  })

  it('RGS-11 C0.9 PD-07: a pinned purpose stays active and never rests on a consent-type basis', () => {
    for (const key of PINNED_PURPOSES) {
      expect(purposeProblems(key, purpose({ status: 'planned' })), key).toEqual(['pinned_inactive'])
      expect(purposeProblems(key, purpose({ status: 'retired' })), key).toEqual(['pinned_inactive'])
      for (const basis of CONSENT_BASES) {
        expect(purposeProblems(key, purpose({ basis, ...attached(basis) })), `${key} ${basis}`).toEqual([
          'pinned_consent',
        ])
      }
      expect(
        purposeProblems(key, purpose({ basis: 'legitimate_interests', ...attached('legitimate_interests') })),
      ).toEqual([])
    }
  })

  it('RGS-11 PDPA-04 C0.9 PD-11: a purpose that needs a switch rests on no consent-type basis, whatever its status', () => {
    for (const key of ['recording_meetings', 'recording_drop_in'] as const) {
      for (const basis of CONSENT_BASES) {
        for (const status of PURPOSE_STATUSES) {
          expect(
            purposeProblems(key, purpose({ status, basis, ...attached(basis) })),
            `${key} ${basis} ${status}`,
          ).toEqual(['needs_switch'])
        }
      }
      expect(purposeProblems(key, purpose())).toEqual([])
    }
    // One that needs none may rest on consent; the warnings say what that means.
    for (const basis of CONSENT_BASES) {
      expect(purposeProblems('session_slides', purpose({ basis, ...attached(basis) })), basis).toEqual([])
    }
  })

  it('RGS-11 PD-04: once the DPO edits it, an active or retired purpose needs a basis and a retention', () => {
    for (const status of ['active', 'retired'] as const) {
      expect(purposeProblems('backups', purpose({ status, basis: null })), status).toEqual(['basis_missing'])
      expect(purposeProblems('backups', purpose({ status, retention: null })), status).toEqual(['retention_missing'])
      // Spaces alone are no retention: the table stores text trimmed.
      expect(purposeProblems('backups', purpose({ status, retention: '   ' })), status).toEqual(['retention_missing'])
    }
  })

  it('RGS-11 PDPA-01: each basis takes exactly its attachments', () => {
    expect(purposeProblems('access_logs', purpose({ basis: 'legitimate_interests' }))).toEqual(['reference_missing'])
    expect(purposeProblems('access_logs', purpose({ basis: 'other_exception', basisReference: ' ' }))).toEqual([
      'reference_missing',
    ])
    expect(purposeProblems('access_logs', purpose({ basisReference: 'A file' }))).toEqual(['reference_extra'])
    expect(
      purposeProblems('access_logs', purpose({ status: 'planned', basis: null, basisReference: 'A file' })),
    ).toEqual(['reference_extra'])
    const s15A = { basis: 'deemed_consent_notification', basisReference: 'Assessment' } as const
    expect(purposeProblems('presence_receipts', purpose(s15A))).toEqual(['opt_out_missing'])
    expect(purposeProblems('presence_receipts', purpose({ ...s15A, optOutDays: 30 }))).toEqual([])
    expect(purposeProblems('presence_receipts', purpose({ optOutDays: 30 }))).toEqual(['opt_out_extra'])
    for (const days of [1, 365]) {
      expect(purposeProblems('presence_receipts', purpose({ ...s15A, optOutDays: days })), String(days)).toEqual([])
    }
    for (const days of [0, -1, 366, 1.5]) {
      expect(purposeProblems('presence_receipts', purpose({ ...s15A, optOutDays: days })), String(days)).toEqual([
        'opt_out_range',
      ])
    }
  })

  it('RGS-11 D41: an entry lists only known providers outside the AI layer', () => {
    expect(purposeProblems('content_delivery', purpose({ providers: [...NON_AI_PROVIDERS] }))).toEqual([])
    expect(purposeProblems('content_delivery', purpose({ providers: ['aws', 'openai'] }))).toEqual(['provider_ai'])
    expect(purposeProblems('content_delivery', purpose({ providers: ['bedrock'] }))).toEqual(['provider_ai'])
    expect(purposeProblems('content_delivery', purpose({ providers: ['sendgrid'] }))).toEqual(['provider_unknown'])
  })

  it('RGS-11: problems come in PURPOSE_PROBLEMS order, however many there are', () => {
    const everything = purpose({
      status: 'retired',
      basis: 'consent',
      basisReference: 'A file',
      optOutDays: 400,
      retention: null,
      providers: ['sendgrid', 'openai'],
    })
    expect(purposeProblems('accounts', everything)).toEqual([
      'pinned_inactive',
      'pinned_consent',
      'retention_missing',
      'reference_extra',
      'opt_out_extra',
      'opt_out_range',
      'provider_unknown',
      'provider_ai',
    ])
    expect(new Set(PURPOSE_PROBLEMS).size).toBe(PURPOSE_PROBLEMS.length)
  })

  it('RGS-11 C0.9 PD-07 PD-11: the page offers exactly the statuses and bases that save', () => {
    for (const key of PURPOSE_KEYS) {
      const statuses = statusesFor(key)
      const bases = basesFor(key)
      if (PURPOSES[key].ai) {
        expect([statuses, bases], key).toEqual([[], []])
        continue
      }
      for (const status of PURPOSE_STATUSES) {
        for (const basis of BASES) {
          const problems = purposeProblems(key, purpose({ status, basis, ...attached(basis) }))
          const offered = statuses.includes(status) && bases.includes(basis)
          expect(problems.length === 0, `${key} ${status} ${basis}`).toBe(offered)
        }
      }
    }
    expect(statusesFor('accounts')).toEqual(['active'])
    expect(basesFor('recording_meetings')).not.toContain('deemed_consent_conduct')
    expect(basesFor('presence_receipts')).toEqual(BASES)
    expect([statusesFor('acounts'), basesFor('acounts')]).toEqual([[], []])
  })
})

describe('PDPA-01 C0.9 PD-11: the warnings, which never block', () => {
  it('RGS-12 PDPA-01: business improvement covers use only, so it always warns', () => {
    expect(purposeWarnings('content_delivery', { basis: 'business_improvement' })).toEqual(['business_improvement'])
    expect(purposeProblems('content_delivery', purpose({ basis: 'business_improvement' }))).toEqual([])
  })

  it('RGS-12 PDPA-01 PDPA-04 REC-04: a consent-type basis warns that a withdrawal is handled by hand, and more for what the recording policy keeps', () => {
    for (const basis of CONSENT_BASES) {
      expect(purposeWarnings('presence_receipts', { basis }), basis).toEqual(['withdrawal_by_hand'])
      expect(purposeWarnings('session_slides', { basis }), basis).toEqual(['no_opt_out_consent', 'withdrawal_by_hand'])
      // The recording purposes are refused it too (needs_switch); the warning still says why.
      expect(purposeWarnings('recording_meetings', { basis }), basis).toEqual([
        'no_opt_out_consent',
        'withdrawal_by_hand',
      ])
    }
  })

  it('RGS-12: other bases, no basis, an AI purpose and an unknown key warn of nothing', () => {
    for (const basis of ['employment', 'legitimate_interests', 'other_exception'] as const) {
      expect(purposeWarnings('session_slides', { basis }), basis).toEqual([])
    }
    expect(purposeWarnings('session_slides', { basis: null })).toEqual([])
    expect(purposeWarnings('meeting_notes', { basis: 'consent' })).toEqual([])
    expect(purposeWarnings('acounts', { basis: 'consent' })).toEqual([])
  })
})

describe('PDPA-10 D46 C0.9 PD-12: transferProblems mirrors transfer_clearances_check()', () => {
  it('RGS-13: every fact recorded, with a review date after today, can be cleared', () => {
    expect(transferProblems(twilio(), TODAY)).toEqual([])
    expect(transferProblems({ ...twilio(), provider: 'aws' }, TODAY)).toEqual([])
  })

  it('RGS-13: nothing recorded lists every fact, in the trigger’s order', () => {
    const empty: TransferFacts = {
      services: null,
      dataTypes: null,
      processingCountries: [],
      storageCountries: [],
      countriesConfirmed: null,
      safeguard: null,
      safeguardReference: null,
      certificateVerifiedOn: null,
      dpaTermsConfirmed: false,
      training: null,
      zeroRetention: null,
      providerRetention: null,
      retentionConfirmed: null,
      onwardRecipients: null,
      reviewOn: null,
    }
    expect(transferProblems({ provider: 'livekit', ...empty }, TODAY)).toEqual(
      TRANSFER_PROBLEMS.filter(
        p =>
          !['unknown_provider', 'ai_provider', 'certificate_unverified', 'certificate_future', 'review_due'].includes(
            p,
          ),
      ),
    )
  })

  it('RGS-13: each fact missing is refused on its own', () => {
    const missing: [Partial<TransferFacts>, string][] = [
      [{ services: null }, 'services'],
      [{ dataTypes: '  ' }, 'data_types'],
      [{ processingCountries: [] }, 'processing_countries'],
      [{ storageCountries: [] }, 'storage_countries'],
      [{ countriesConfirmed: null }, 'countries_confirmed'],
      [{ safeguard: null }, 'safeguard'],
      [{ safeguardReference: '' }, 'safeguard_reference'],
      [{ dpaTermsConfirmed: false }, 'dpa_terms'],
      [{ training: null }, 'training'],
      [{ zeroRetention: null }, 'zero_retention'],
      [{ zeroRetention: 'pending' }, 'zero_retention'],
      [{ providerRetention: null }, 'provider_retention'],
      [{ retentionConfirmed: null }, 'retention_confirmed'],
      [{ onwardRecipients: null }, 'onward_recipients'],
      [{ reviewOn: null }, 'review_on'],
    ]
    for (const [change, problem] of missing) {
      expect(transferProblems(twilio(change), TODAY), JSON.stringify(change)).toEqual([problem])
    }
    // Every result but pending is a result.
    for (const zeroRetention of ZERO_RETENTION.filter(r => r !== 'pending')) {
      expect(transferProblems(twilio({ zeroRetention }), TODAY), zeroRetention).toEqual([])
    }
  })

  it('RGS-13 PDPA-10: a certification counts only once its certificate is verified, on a day already passed', () => {
    const certified = { safeguard: 'certification', safeguardReference: 'ISO/IEC 27701 certificate' } as const
    expect(transferProblems(twilio(certified), TODAY)).toEqual(['certificate_unverified'])
    expect(transferProblems(twilio({ ...certified, certificateVerifiedOn: TODAY }), TODAY)).toEqual([])
    expect(transferProblems(twilio({ ...certified, certificateVerifiedOn: '2026-10-23' }), TODAY)).toEqual([
      'certificate_future',
    ])
  })

  it('RGS-13 C0.9 PD-13: the review date must fall after today in the org’s zone', () => {
    expect(transferProblems(twilio({ reviewOn: '2026-10-23' }), TODAY)).toEqual([])
    expect(transferProblems(twilio({ reviewOn: TODAY }), TODAY)).toEqual(['review_due'])
    expect(transferProblems(twilio({ reviewOn: '2025-12-31' }), TODAY)).toEqual(['review_due'])
  })

  it('RGS-13 D41: an AI provider is never cleared before A0, and a key that isn’t a provider never', () => {
    for (const provider of ['openai', 'bedrock']) {
      expect(transferProblems({ ...twilio(), provider }, TODAY), provider).toEqual(['ai_provider'])
    }
    expect(transferProblems({ ...twilio(), provider: 'sendgrid' }, TODAY)).toEqual(['unknown_provider'])
    expect(new Set(TRANSFER_PROBLEMS).size).toBe(TRANSFER_PROBLEMS.length)
  })
})

describe('C0.9 PD-20 PD-21: the bodies the routes take', () => {
  const set = {
    purpose: 'security_audit',
    seen: 1,
    status: 'active',
    basis: 'legitimate_interests',
    basisReference: '  Assessment in the DPO’s file  ',
    optOutDays: null,
    retention: RETENTION,
    providers: ['aws'],
  }

  it('RGS-14: SetPurposeBody is strict, trims what the DPO types and reads blank as nothing', () => {
    expect(SetPurposeBody.parse(set)).toEqual({ ...set, basisReference: 'Assessment in the DPO’s file' })
    expect(SetPurposeBody.parse({ ...set, retention: '   ' }).retention).toBeNull()
    for (const bad of [
      { ...set, extra: 1 },
      { ...set, purpose: 'acounts' },
      { ...set, seen: 0 },
      { ...set, status: 'on' },
      { ...set, basis: 'contract' },
      { ...set, optOutDays: 1.5 },
      { ...set, providers: ['sendgrid'] },
      { ...set, providers: Array.from({ length: 21 }, () => 'aws') },
      { ...set, retention: 'x'.repeat(1001) },
    ]) {
      expect(SetPurposeBody.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false)
    }
    // An AI key and an AI provider parse, so can() answers the first (403) and the shared problems
    // the second (400 register_invalid); a window out of range is a problem the page explains.
    expect(SetPurposeBody.safeParse({ ...set, purpose: 'org_brain' }).success).toBe(true)
    expect(SetPurposeBody.safeParse({ ...set, providers: ['openai'] }).success).toBe(true)
    expect(SetPurposeBody.safeParse({ ...set, optOutDays: 400 }).success).toBe(true)
  })

  it('RGS-14 PDPA-10: RecordTransferBody stores countries upper case, once each and sorted', () => {
    const body = { provider: 'twilio', seen: 3, ...FACTS, processingCountries: ['us', 'SG', 'US'], keepCleared: true }
    const parsed = RecordTransferBody.parse(body)
    expect(parsed.processingCountries).toEqual(['SG', 'US'])
    expect(parsed.keepCleared).toBe(true)
    for (const bad of [
      { ...body, processingCountries: ['USA'] },
      { ...body, storageCountries: Array.from({ length: 61 }, () => 'SG') },
      { ...body, reviewOn: '2027-02-30' },
      { ...body, reviewOn: '1 Oct 2027' },
      { ...body, safeguard: 'contract' },
      { ...body, keepCleared: undefined },
      { ...body, extra: true },
    ]) {
      expect(RecordTransferBody.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false)
    }
  })

  it('RGS-14 C0.9 PD-21: clearing names the revision it clears; a withdrawal names none, so it is never refused as stale', () => {
    expect(ClearTransferBody.parse({ provider: 'aws', seen: 2 })).toEqual({ provider: 'aws', seen: 2 })
    expect(ClearTransferBody.safeParse({ provider: 'aws' }).success).toBe(false)
    expect(WithdrawTransferBody.parse({ provider: 'twilio' })).toEqual({ provider: 'twilio' })
    expect(WithdrawTransferBody.safeParse({ provider: 'twilio', seen: 2 }).success).toBe(false)
    expect(WithdrawTransferBody.safeParse({ provider: 'sendgrid' }).success).toBe(false)
  })
})

describe('C0.9 PD-20 PD-27: the answers', () => {
  const entry = 'a0000000-0000-4000-8000-0000000000e1'
  const purposeRow = {
    purpose: 'accounts',
    version: 1,
    status: 'active',
    basis: null,
    basisReference: null,
    optOutDays: null,
    retention: null,
    providers: [],
    pinned: true,
    needsSwitch: false,
    recordedOn: '2026-10-01',
    recordedBy: null,
  }
  const transferRow = {
    provider: 'twilio',
    revision: 2,
    ...FACTS,
    updatedOn: '2026-10-01',
    updatedBy: null,
    clearance: {
      clearedOn: '2026-10-01',
      clearedBy: 'Ashton Tan',
      clearedVia: 'bootstrap',
      revision: 2,
      withdrawnOn: null,
      withdrawnBy: null,
      withdrawReason: null,
    },
  }
  const answer = { today: TODAY, purposes: [purposeRow], transfers: [transferRow] }

  it('RGS-14: RegistersResponse is strict and carries nothing of the AI layer', () => {
    expect(RegistersResponse.parse(answer)).toEqual(answer)
    expect(
      RegistersResponse.parse({ ...answer, transfers: [{ ...transferRow, clearance: null }] }).transfers,
    ).toHaveLength(1)
    for (const bad of [
      { ...answer, extra: 1 },
      { ...answer, today: '22/10/2026' },
      { ...answer, purposes: [{ ...purposeRow, purpose: 'org_brain' }] },
      { ...answer, purposes: [{ ...purposeRow, providers: ['openai'] }] },
      { ...answer, purposes: [{ ...purposeRow, retention: '' }] },
      { ...answer, purposes: [{ ...purposeRow, roles: ['dpo'] }] },
      { ...answer, transfers: [{ ...transferRow, provider: 'bedrock' }] },
      { ...answer, transfers: [{ ...transferRow, processingCountries: ['us'] }] },
      { ...answer, transfers: [{ ...transferRow, clearance: { ...transferRow.clearance, clearedVia: 'script' } }] },
      { ...answer, transfers: [{ ...transferRow, updatedBy: 'a'.repeat(201) }] },
    ]) {
      expect(RegistersResponse.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false)
    }
    // Text is bounded as Postgres bounds it, in code points: 1,000 emoji are 1,000 characters.
    const emoji = '🙂'.repeat(1000)
    expect(RegistersResponse.safeParse({ ...answer, purposes: [{ ...purposeRow, retention: emoji }] }).success).toBe(
      true,
    )
  })

  it('RGS-14 P6 C0.9 PD-27: the web app drops what it can’t read, AI rows included, and still shows the rest', () => {
    const read = RegistersResponseForClient.parse({
      ...answer,
      later: true,
      purposes: [
        { ...purposeRow, later: 1 },
        { ...purposeRow, purpose: 'org_brain' },
        { ...purposeRow, purpose: 'acounts' },
        { ...purposeRow, purpose: 'backups', recordedBy: 7 },
        'not a row',
      ],
      transfers: [
        { ...transferRow, clearance: { ...transferRow.clearance, clearedBy: '' } },
        { ...transferRow, provider: 'openai' },
      ],
    })
    expect(read.purposes.map(row => row.purpose)).toEqual(['accounts', 'backups'])
    expect(read.purposes[0]).toEqual(purposeRow)
    expect(read.purposes[1]?.recordedBy).toBeNull()
    expect(read.transfers.map(row => row.provider)).toEqual(['twilio'])
    expect(read.transfers[0]?.clearance?.clearedBy).toBeNull()
    expect(Object.keys(read)).toEqual(['today', 'purposes', 'transfers'])
    expect(RegistersResponseForClient.safeParse({ purposes: [], transfers: [] }).success).toBe(false)
  })

  it('RGS-14: each write answers its entry, its version or revision, and whether anything changed', () => {
    expect(PurposeWriteResponse.parse({ entry, version: 2, changed: true })).toEqual({
      entry,
      version: 2,
      changed: true,
    })
    expect(PurposeWriteResponse.safeParse({ entry, version: 2, changed: true, basis: 'consent' }).success).toBe(false)
    expect(TransferWriteResponse.parse({ entry, revision: 3, cleared: false, changed: false }).cleared).toBe(false)
    expect(
      TransferWriteResponse.safeParse({ entry: entry.toUpperCase(), revision: 3, cleared: false, changed: false })
        .success,
    ).toBe(false)
    expect(RegisterWriteResponseForClient.parse({ entry, revision: 3, cleared: true, changed: true })).toEqual({
      changed: true,
    })
  })
})
