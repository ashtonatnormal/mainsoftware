// The registers as the server judges work by them (C0.9, TECH-SPEC T22): the processing register
// (PDPA-01), the transfer register (PDPA-10) and the processing-restrictions hook (PDPA-04a), read
// from Postgres (migration 0009) into a RegisterState, and the pure predicates the purpose gate
// answers with (compliance/gate.ts).
//
// Two readers share readRegisterState(): the worker's flag cache, as hearth_queue, in the same
// read-only transaction as its flags (T22 item 9, flags/cache.ts), and the flags route, as the
// signed-in admin, in its own transaction (T22 item 11, flags/set.ts). Both read only the columns
// hearth_queue is granted. The api's sends never use a RegisterState: they ask transfer_cleared()
// in the transaction that decides each send (compliance/transfers.ts, PD-15).
//
// Every predicate fails closed: a register never read, or not read for 8 s (undefined here), allows
// only the pinned purposes, accounts and service_operation, which Hearth runs on whatever the
// register says (PD-07). An AI purpose or provider is never allowed before A0 (D41).
import { type Basis, isAiProvider, isAiPurpose, isPinnedPurpose, type PurposeStatus } from '@hearth/shared'
import { sql } from 'kysely'
import type { InOrg } from '#src/db/database.ts'

// A purpose's current entry: its highest version (PD-04).
export interface PurposeEntryState {
  version: number
  status: PurposeStatus
  basis: Basis | null
  providers: readonly string[]
}

// A provider's entry: the revision of its facts, its review date (YYYY-MM-DD, in the org's zone as
// the DPO set it) and its open clearance's id, if it has one (PD-05).
export interface ProviderEntryState {
  revision: number
  reviewOn: string | null
  clearance: string | null
}

// A live restriction (lifted_at empty): one person's withdrawal of one purpose, in effect from
// effectiveAt (epoch ms) (PDPA-04a).
export interface RestrictionState {
  id: string
  effectiveAt: number
}

export interface RegisterState {
  // By PURPOSES key. A purpose with no row reads as refused (PD-03).
  purposes: ReadonlyMap<string, PurposeEntryState>
  // By PROVIDERS key. A provider with no row reads as not cleared.
  providers: ReadonlyMap<string, ProviderEntryState>
  // The purposes the highest published notice lists (PD-08). C0.9 PR 2 fills it from the notice
  // versions; until then nothing is notified, so only the pinned purposes pass (PGT-04).
  notified: ReadonlySet<string>
  // By `${personId}:${purpose}`; undefined when the reader didn't ask for them (only the worker,
  // as hearth_queue, may: hearth_app has no grant on processing_restrictions).
  restrictions: ReadonlyMap<string, RestrictionState> | undefined
}

type PurposeRow = { purpose: string; version: number; status: PurposeStatus; basis: Basis | null; providers: string[] }
// revision is a bigint, which pg returns as a string; review_on is read as text, YYYY-MM-DD.
type ProviderRow = { provider: string; revision: unknown; review_on: string | null; clearance: string | null }
type RestrictionRow = { id: string; person_id: string; purpose: string; effective_at: Date }

// The org's registers, in the caller's transaction, with plain reads (no lock: a send's decision is
// transfer_cleared()'s, never this). Restrictions only when asked.
export async function readRegisterState(
  trx: InOrg,
  orgId: string,
  options: { restrictions: boolean },
): Promise<RegisterState> {
  const purposes = await sql<PurposeRow>`
    select distinct on (purpose) purpose, version, status, basis, providers
    from processing_register
    where org_id = ${orgId}
    order by purpose, version desc`.execute(trx)
  // At most one open clearance per provider (transfer_clearances_open).
  const providers = await sql<ProviderRow>`
    select r.provider, r.revision, r.review_on::text as review_on, c.id as clearance
    from transfer_register r
    left join transfer_clearances c
      on c.org_id = r.org_id and c.provider = r.provider and c.withdrawn_at is null
    where r.org_id = ${orgId}`.execute(trx)
  let restrictions: Map<string, RestrictionState> | undefined
  if (options.restrictions) {
    const { rows } = await sql<RestrictionRow>`
      select id, person_id, purpose, effective_at
      from processing_restrictions
      where org_id = ${orgId} and lifted_at is null`.execute(trx)
    restrictions = new Map(
      rows.map(row => [`${row.person_id}:${row.purpose}`, { id: row.id, effectiveAt: row.effective_at.getTime() }]),
    )
  }
  return {
    purposes: new Map(
      purposes.rows.map(row => [
        row.purpose,
        { version: row.version, status: row.status, basis: row.basis, providers: row.providers },
      ]),
    ),
    providers: new Map(
      providers.rows.map(row => [
        row.provider,
        // Revisions stay far below 2^53.
        { revision: Number(row.revision), reviewOn: row.review_on, clearance: row.clearance },
      ]),
    ),
    notified: new Set(),
    restrictions,
  }
}

// What a change to the registers moves (T22 item 9): each purpose's version, each provider's
// revision (any change of facts, a review date included, bumps it) and open clearance, and each
// live restriction. Two reads with the same digest found the same registers.
export function registerDigest(state: RegisterState): string {
  const parts = [
    ...[...state.purposes].map(([purpose, entry]) => `purpose:${purpose}:${entry.version}`),
    ...[...state.providers].map(
      ([provider, entry]) => `provider:${provider}:${entry.revision}:${entry.clearance ?? 'none'}`,
    ),
    ...[...(state.restrictions?.values() ?? [])].map(restriction => `restriction:${restriction.id}`),
  ]
  return parts.sort().join('|')
}

// Whether the org may process personal data for this purpose at all (T22 item 6, PD-09): never for
// an AI purpose (D41); always for a pinned one, in every register state (PD-07); otherwise only
// while its current version is active, the highest published notice lists it, and every provider
// that version lists has an open clearance.
export function purposeAllowed(state: RegisterState | undefined, purpose: string): boolean {
  if (isAiPurpose(purpose)) return false
  if (isPinnedPurpose(purpose)) return true
  if (state === undefined) return false
  const entry = state.purposes.get(purpose)
  if (entry === undefined || entry.status !== 'active' || !state.notified.has(purpose)) return false
  return entry.providers.every(provider => providerCleared(state, provider))
}

// Whether an outside provider may receive personal data now (PDPA-10): its entry has an open
// clearance. Never an AI provider before A0 (D41). The worker's view, a poll old at most; the api
// asks transfer_cleared() in the transaction that decides each send instead (PD-15).
export function providerCleared(state: RegisterState | undefined, provider: string): boolean {
  if (isAiProvider(provider)) return false
  return (state?.providers.get(provider)?.clearance ?? null) !== null
}

// Whether this person's processing for the purpose may go ahead (T22 item 7, PD-10; PDPA-04,
// PDPA-04a): yes for a pinned purpose; no for consent until consent records exist (C0.9 PR 2 or
// C1.3); for deemed consent (by conduct, or by notification under s15A), yes unless a restriction
// of theirs is in effect; yes for any other recorded basis; no with no basis recorded, an AI
// purpose, a register not read, or restrictions not read.
//
// In C0.9 PR 1 only pinned purposes pass the purpose gate, and G1 (every flag outside ai.* names
// only pinned purposes, packages/shared catalogues.test.ts) keeps every job and consumer on one,
// since each serves one of its flag's purposes; so nothing is ever withheld here. Before PR 2 lets
// a consumer serve another purpose, a register gone stale mid-round must skip or roll back the
// whole round (an 'unconfirmed' error, or one RegisterState per round for both checks), never
// withhold an event: the consumer moves its checkpoint past an event it withholds, so withholding
// for an unknown register would drop it for good (T22 item 7).
export function isProcessingAllowed(
  state: RegisterState | undefined,
  personId: string,
  purpose: string,
  at: number = Date.now(),
): boolean {
  if (isAiPurpose(purpose)) return false
  if (isPinnedPurpose(purpose)) return true
  const basis = state?.purposes.get(purpose)?.basis ?? null
  if (state === undefined || basis === null || basis === 'consent') return false
  if (basis === 'deemed_consent_conduct' || basis === 'deemed_consent_notification') {
    if (state.restrictions === undefined) return false
    const restriction = state.restrictions.get(`${personId}:${purpose}`)
    return restriction === undefined || restriction.effectiveAt > at
  }
  return true
}
