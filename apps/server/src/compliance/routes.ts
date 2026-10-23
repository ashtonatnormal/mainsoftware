// /api/admin/registers (C0.9 PD-20, PD-21, PD-25; TECH-SPEC T22 items 13 and 14): the DPO reads
// the processing register (PDPA-01) and the transfer register (PDPA-10), records a purpose's next
// version, records a provider's facts, clears a provider for use and withdraws a clearance. The
// registers are the DPO's alone (PDPA-13): can() decides each request (register.read,
// register.purpose.set, register.transfer.set), with a re-authentication from the last 5 minutes,
// which for the DPO is the PIN (PD-30), and refuses AI purposes and providers until A0 (D41). Not
// Rule 9: the registers hold no content, and nothing here reaches the privileged module.
//
// Each write runs in one transaction, as the signed-in DPO:
//   1. can() decides, after re-reading the acting session FOR SHARE (authorise);
//   2. the shared rules (packages/shared registers.ts) refuse what the body itself shows to be
//      wrong, 400 register_invalid, before the database is asked. A transfer entry's facts are
//      stored, so whether they are complete enough to clear is transfer_clearances_check()'s to
//      say (the same rules, in the same order: RGS-I4);
//   3. the checked function (migration 0009) re-checks the DPO FOR SHARE, locks the entry, refuses
//      a stale edit (HF005, 409 register_changed, which the page answers with a Reload) or a rule
//      (HF006, 400 register_invalid), writes nothing for a change that changes nothing, and writes
//      the audit event (ADM-06);
//   4. on a real change, register.purpose_changed or register.transfer_changed goes to the outbox
//      in the same transaction (T16; PD-22).
// Nothing is published after the commit: the api keeps no copy of the registers (its sends ask
// transfer_send_state() in their own transactions, PD-15), and the worker sees the change at its
// next flag read, within one poll (PD-16).
//
// From C0.9 PR 2 the read also says how the published notice stands against the registers (PD-48):
// per purpose, whether the latest version lists it at its current version (notified, PD-40) and,
// for a pinned purpose, whether the latest generated version no longer does (stale, PD-61); per
// provider, whether its sends wait for a version that states its facts (sendsWait, PD-41); and
// whether publishing now would write a new version (notice), from the same draft the Notice tab
// shows (compliance/notice.ts noticeDraft()). None of them changes what a write may do.
import {
  type ClearTransferBody,
  isAiProvider,
  NON_AI_PROVIDERS,
  NON_AI_PURPOSE_KEYS,
  type PurposeRowJSON,
  type PurposeWriteJSON,
  purposeProblems,
  type RecordTransferBody,
  type RegistersJSON,
  type SetPurposeBody,
  type TransferRowJSON,
  type TransferWriteJSON,
  type WithdrawTransferBody,
} from '@hearth/shared'
import { sql } from 'kysely'
import type { z } from 'zod'
import { authorise } from '#src/access/world.ts'
import type { Api } from '#src/api.ts'
import { ApiError } from '#src/auth/errors.ts'
import { inSession, type SessionIds } from '#src/auth/sessions.ts'
import { noticeDraft, noticeStatusOf } from '#src/compliance/notice.ts'
import { type RegisterState, readRegisterState } from '#src/compliance/registers.ts'
import type { InOrg } from '#src/db/database.ts'
import {
  INSUFFICIENT_PRIVILEGE,
  INVALID_PARAMETER,
  REGISTER_CHANGED,
  REGISTER_INVALID,
  sqlstateOf,
} from '#src/db/sqlstate.ts'
import type { Answer, ReqInfo } from '#src/http.ts'
import { appendOutbox } from '#src/outbox/append.ts'

// The codes only these routes answer, which the registers' integration suite must see (and the
// sign-in suite's sweep of every code leaves to it).
export const REGISTER_ERRORS = ['register_changed', 'register_invalid'] as const

// A check constraint (23514) of a register's own table: a fact's shape the table refuses, such as a
// certification with no verification date. The body's schema and the shared rules catch each
// before the database, so this is a backstop that answers as the rule it is. Postgres names the
// constraint, and each of these tables' names starts with its table's (0009). A check of any other
// table the functions write (the audit log's, say), or one a trigger raises with no constraint,
// is a fault in the server, which answers 500 and is logged.
const CHECK_VIOLATION = '23514'
const REGISTER_CONSTRAINT = /^(?:processing_register|transfer_register|transfer_clearances)_/

function registerCheck(error: unknown): boolean {
  const { constraint } = error as { constraint?: unknown }
  return typeof constraint === 'string' && REGISTER_CONSTRAINT.test(constraint)
}

// What the registers' functions refuse with, as the api answers it (PD-25). A lock not granted in
// time (55P03), a deadlock or a serialisation failure is the api's 409 try_again already
// (auth/errors.ts fromDatabase).
function refusalOf(error: unknown): ApiError | undefined {
  switch (sqlstateOf(error)) {
    case REGISTER_CHANGED:
      return new ApiError(409, 'register_changed')
    case REGISTER_INVALID:
      return new ApiError(400, 'register_invalid')
    case CHECK_VIOLATION:
      return registerCheck(error) ? new ApiError(400, 'register_invalid') : undefined
    case INVALID_PARAMETER:
      return new ApiError(404, 'not_found')
    case INSUFFICIENT_PRIVILEGE:
      return new ApiError(403, 'forbidden')
    default:
      return undefined
  }
}

async function refusing<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error) {
    throw refusalOf(error) ?? error
  }
}

// --- GET /api/admin/registers ---------------------------------------------------------------------

type PurposeRow = {
  purpose: string
  version: number
  status: PurposeRowJSON['status']
  basis: PurposeRowJSON['basis']
  basis_reference: string | null
  opt_out_days: number | null
  retention: string | null
  providers: string[]
  pinned: boolean
  needs_switch: boolean
  recorded_on: string
  recorded_by: string | null
}

// bigint columns arrive as strings; dates are read as text, YYYY-MM-DD.
type TransferRow = {
  provider: string
  revision: string
  services: string | null
  data_types: string | null
  processing_countries: string[]
  storage_countries: string[]
  countries_confirmed: string | null
  safeguard: TransferRowJSON['safeguard']
  safeguard_reference: string | null
  certificate_verified_on: string | null
  dpa_terms_confirmed: boolean
  training: TransferRowJSON['training']
  zero_retention: TransferRowJSON['zeroRetention']
  provider_retention: string | null
  retention_confirmed: string | null
  onward_recipients: string | null
  review_on: string | null
  updated_on: string
  updated_by: string | null
  cleared_on: string | null
  cleared_by: string | null
  cleared_via: 'app' | 'bootstrap' | null
  cleared_revision: string | null
  withdrawn_on: string | null
  withdrawn_by: string | null
  withdraw_reason: 'dpo_decision' | 'facts_changed' | null
}

// Each purpose's current entry (its highest version) outside the AI layer, with the name of who
// recorded it from the roster (none for version 1, which is Hearth's), and days in the org's time
// zone, never times (as the devices list gives them, admin/people.ts).
async function readPurposes(trx: InOrg, orgId: string, state: RegisterState): Promise<PurposeRowJSON[]> {
  const { rows } = await sql<PurposeRow>`
    select distinct on (r.purpose) r.purpose, r.version, r.status, r.basis, r.basis_reference, r.opt_out_days,
      r.retention, r.providers, r.pinned, r.needs_switch,
      ((r.recorded_at at time zone o.time_zone)::date)::text as recorded_on,
      p.full_name as recorded_by
    from processing_register r
    join orgs o on o.id = r.org_id
    left join people p on p.org_id = r.org_id and p.id = r.recorded_by
    where r.org_id = ${orgId} and not r.ai
    order by r.purpose, r.version desc`.execute(trx)
  const byKey = new Map(rows.map(row => [row.purpose, row]))
  // In PURPOSES order; an AI key never leaves, whatever the table says (C0.9 PD-27).
  return NON_AI_PURPOSE_KEYS.flatMap(purpose => {
    const row = byKey.get(purpose)
    if (row === undefined) return []
    return [
      {
        purpose,
        version: row.version,
        status: row.status,
        basis: row.basis,
        basisReference: row.basis_reference,
        optOutDays: row.opt_out_days,
        retention: row.retention,
        providers: row.providers.filter(provider => !isAiProvider(provider)) as PurposeRowJSON['providers'],
        pinned: row.pinned,
        needsSwitch: row.needs_switch,
        recordedOn: row.recorded_on,
        recordedBy: row.recorded_by,
        notified: state.notified.has(purpose),
        stale: state.stale.has(purpose),
      },
    ]
  })
}

// Each provider's entry outside the AI layer, with its open clearance, or else the last that
// ended (none if it was never cleared), and the names of who recorded the facts (none while they
// are Hearth's: the starting row's, or the bootstrap's), cleared and withdrew.
async function readTransfers(trx: InOrg, orgId: string, state: RegisterState): Promise<TransferRowJSON[]> {
  const { rows } = await sql<TransferRow>`
    select t.provider, t.revision, t.services, t.data_types, t.processing_countries, t.storage_countries,
      t.countries_confirmed, t.safeguard, t.safeguard_reference, t.certificate_verified_on::text as certificate_verified_on,
      t.dpa_terms_confirmed, t.training, t.zero_retention, t.provider_retention, t.retention_confirmed,
      t.onward_recipients, t.review_on::text as review_on,
      ((t.updated_at at time zone o.time_zone)::date)::text as updated_on,
      u.full_name as updated_by,
      c.cleared_on, c.cleared_by, c.cleared_via, c.cleared_revision, c.withdrawn_on, c.withdrawn_by, c.withdraw_reason
    from transfer_register t
    join orgs o on o.id = t.org_id
    left join people u on u.org_id = t.org_id and u.id = t.updated_by
    left join lateral (
      select ((x.cleared_at at time zone o.time_zone)::date)::text as cleared_on, cp.full_name as cleared_by,
        x.cleared_via, x.register_revision as cleared_revision,
        ((x.withdrawn_at at time zone o.time_zone)::date)::text as withdrawn_on, wp.full_name as withdrawn_by,
        x.withdraw_reason
      from transfer_clearances x
      left join people cp on cp.org_id = x.org_id and cp.id = x.cleared_by
      left join people wp on wp.org_id = x.org_id and wp.id = x.withdrawn_by
      where x.org_id = t.org_id and x.entry_id = t.id
      order by x.withdrawn_at is null desc, x.cleared_at desc, x.id
      limit 1
    ) c on true
    where t.org_id = ${orgId} and not t.ai`.execute(trx)
  const byKey = new Map(rows.map(row => [row.provider, row]))
  return NON_AI_PROVIDERS.flatMap(provider => {
    const row = byKey.get(provider)
    if (row === undefined) return []
    // Cleared, and the latest generated version states other facts (or none) for it: nothing is
    // sent to it until a version that states these is published (PD-41). Before the first generated
    // version (none, or a stand-in) nothing waits.
    const entry = state.providers.get(provider)
    const sendsWait =
      entry !== undefined && entry.clearance !== null && state.notice?.generated === true && !entry.stated
    return [
      {
        provider,
        // Revisions stay far below 2^53.
        revision: Number(row.revision),
        services: row.services,
        dataTypes: row.data_types,
        processingCountries: row.processing_countries,
        storageCountries: row.storage_countries,
        countriesConfirmed: row.countries_confirmed,
        safeguard: row.safeguard,
        safeguardReference: row.safeguard_reference,
        certificateVerifiedOn: row.certificate_verified_on,
        dpaTermsConfirmed: row.dpa_terms_confirmed,
        training: row.training,
        zeroRetention: row.zero_retention,
        providerRetention: row.provider_retention,
        retentionConfirmed: row.retention_confirmed,
        onwardRecipients: row.onward_recipients,
        reviewOn: row.review_on,
        updatedOn: row.updated_on,
        updatedBy: row.updated_by,
        sendsWait,
        clearance:
          row.cleared_on === null || row.cleared_via === null || row.cleared_revision === null
            ? null
            : {
                clearedOn: row.cleared_on,
                clearedBy: row.cleared_by,
                clearedVia: row.cleared_via,
                revision: Number(row.cleared_revision),
                withdrawnOn: row.withdrawn_on,
                withdrawnBy: row.withdrawn_by,
                withdrawReason: row.withdraw_reason,
              },
      },
    ]
  })
}

// The current entry of every purpose and provider outside the AI layer, with today in the org's
// time zone, against which the page judges review dates and the shared rules; the version and
// revision each edit names (seen); and the notice's markers, from the registers' copy the worker
// and the flags route read (compliance/registers.ts) and the Notice tab's draft. In a read-only
// transaction, so the acting session is re-read with no lock; the request counts as use of the
// session. Each read is a statement of its own, as in PR 1: a change committing between them shows
// at the next read.
export async function readRegisters(api: Api, session: SessionIds, info: ReqInfo): Promise<Answer> {
  const { orgId } = session
  const body = await inSession(
    api,
    info,
    session,
    async (trx): Promise<RegistersJSON> => {
      await authorise(trx, session, { action: 'register.read' }, 'forbidden', { lock: false })
      const { rows } = await sql<{ today: string }>`
        select ((now() at time zone time_zone)::date)::text as today from orgs where id = ${orgId}`.execute(trx)
      const today = rows[0]?.today
      // Past authorise() the org exists.
      if (today === undefined) throw new ApiError(404, 'not_found')
      const state = await readRegisterState(trx, orgId, { restrictions: false })
      const draft = await noticeDraft(trx, orgId)
      return {
        today,
        purposes: await readPurposes(trx, orgId, state),
        transfers: await readTransfers(trx, orgId, state),
        notice: noticeStatusOf(draft),
      }
    },
    { readOnly: true },
  )
  return { body }
}

// --- POST /api/admin/registers/purposes/set -------------------------------------------------------

// The DPO records a purpose's next version from the version the page showed (seen). Saving the
// entry as it is changes nothing and appends nothing.
export async function setPurpose(
  api: Api,
  body: z.output<typeof SetPurposeBody>,
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const { orgId } = session
  const written = await inSession(api, info, session, async trx => {
    await authorise(trx, session, { action: 'register.purpose.set', purpose: body.purpose }, 'forbidden')
    if (purposeProblems(body.purpose, body).length > 0) throw new ApiError(400, 'register_invalid')
    const { rows } = await refusing(
      sql<{ entry: string; version: number; changed: boolean }>`
        select entry, version, changed from public.set_register_purpose(${body.purpose}, ${body.seen}::integer,
          ${body.status}, ${body.basis}, ${body.basisReference}, ${body.optOutDays}::integer, ${body.retention},
          ${body.providers}::text[], ${info.requestId}, ${session.deviceId}::uuid, ${info.ip}::inet)`.execute(trx),
    )
    const row = rows[0]
    if (row === undefined) throw new Error('set_register_purpose() returned no row')
    if (row.changed) {
      await appendOutbox(trx, {
        orgId,
        type: 'register.purpose_changed',
        // The new version's row: each change is a version of its own (PD-04).
        entity: { type: 'processing_purpose', id: row.entry },
        subjects: [],
        purpose: 'service_operation',
        ids: { purpose: body.purpose, status: body.status },
      })
    }
    return row
  })
  const answer: PurposeWriteJSON = { entry: written.entry, version: written.version, changed: written.changed }
  return { body: answer }
}

// --- POST /api/admin/registers/transfers/{record,clear,withdraw} ----------------------------------

type TransferResult = { entry: string; revision: string; cleared: boolean; changed: boolean }

// The function's row, its event on a real change, and the answer.
async function transferWritten(
  trx: InOrg,
  orgId: string,
  provider: z.output<typeof ClearTransferBody>['provider'],
  rows: TransferResult[],
  name: string,
): Promise<TransferWriteJSON> {
  const row = rows[0]
  if (row === undefined) throw new Error(`${name}() returned no row`)
  if (row.changed) {
    await appendOutbox(trx, {
      orgId,
      type: 'register.transfer_changed',
      entity: { type: 'transfer_entry', id: row.entry },
      subjects: [],
      purpose: 'service_operation',
      ids: { provider, cleared: row.cleared },
    })
  }
  return { entry: row.entry, revision: Number(row.revision), cleared: row.cleared, changed: row.changed }
}

// The DPO records a provider's facts from the revision the page showed (seen). An open clearance
// ends (facts_changed), unless keepCleared ("Save and keep cleared") clears the new facts in the
// same transaction, which the clearance trigger refuses whole when they are incomplete (PD-05).
export async function recordTransfer(
  api: Api,
  body: z.output<typeof RecordTransferBody>,
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const { orgId } = session
  const answer = await inSession(api, info, session, async trx => {
    await authorise(
      trx,
      session,
      { action: 'register.transfer.set', provider: body.provider, op: 'record' },
      'forbidden',
    )
    // A certification is a safeguard only once its certificate is verified, which the table checks
    // on every save (transfer_register_certificate), not only when clearing.
    if (body.safeguard === 'certification' && body.certificateVerifiedOn === null) {
      throw new ApiError(400, 'register_invalid')
    }
    const { rows } = await refusing(
      sql<TransferResult>`
        select entry, revision, cleared, changed from public.record_transfer_entry(${body.provider},
          ${body.seen}::bigint, ${body.services}, ${body.dataTypes}, ${body.processingCountries}::text[],
          ${body.storageCountries}::text[], ${body.countriesConfirmed}, ${body.safeguard}, ${body.safeguardReference},
          ${body.certificateVerifiedOn}::date, ${body.dpaTermsConfirmed}::boolean, ${body.training},
          ${body.zeroRetention}, ${body.providerRetention}, ${body.retentionConfirmed}, ${body.onwardRecipients},
          ${body.reviewOn}::date, ${body.keepCleared}::boolean, ${info.requestId}, ${session.deviceId}::uuid,
          ${info.ip}::inet)`.execute(trx),
    )
    return transferWritten(trx, orgId, body.provider, rows, 'record_transfer_entry')
  })
  return { body: answer }
}

// The DPO clears a provider for use, on the revision the page showed (seen). The clearance trigger
// refuses until every fact PDPA-10 and D46 ask for is recorded (PD-12). One already cleared is
// answered as it is.
export async function clearTransfer(
  api: Api,
  body: z.output<typeof ClearTransferBody>,
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const { orgId } = session
  const answer = await inSession(api, info, session, async trx => {
    await authorise(
      trx,
      session,
      { action: 'register.transfer.set', provider: body.provider, op: 'clear' },
      'forbidden',
    )
    const { rows } = await refusing(
      sql<TransferResult>`
        select entry, revision, cleared, changed from public.clear_transfer_entry(${body.provider}, ${body.seen}::bigint,
          ${info.requestId}, ${session.deviceId}::uuid, ${info.ip}::inet)`.execute(trx),
    )
    return transferWritten(trx, orgId, body.provider, rows, 'clear_transfer_entry')
  })
  return { body: answer }
}

// The DPO withdraws a provider's clearance. It names no revision: a withdrawal is never refused
// for being made from an older page. With none open it changes nothing.
export async function withdrawTransfer(
  api: Api,
  body: z.output<typeof WithdrawTransferBody>,
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const { orgId } = session
  const answer = await inSession(api, info, session, async trx => {
    await authorise(
      trx,
      session,
      { action: 'register.transfer.set', provider: body.provider, op: 'withdraw' },
      'forbidden',
    )
    const { rows } = await refusing(
      sql<TransferResult>`
        select entry, revision, cleared, changed from public.withdraw_transfer_clearance(${body.provider},
          ${info.requestId}, ${session.deviceId}::uuid, ${info.ip}::inet)`.execute(trx),
    )
    return transferWritten(trx, orgId, body.provider, rows, 'withdraw_transfer_clearance')
  })
  return { body: answer }
}
