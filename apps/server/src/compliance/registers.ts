// The registers as the server judges work by them (C0.9, TECH-SPEC T22): the processing register
// (PDPA-01), the transfer register (PDPA-10) and the processing-restrictions hook (PDPA-04a), read
// from Postgres (migration 0009) into a RegisterState, and the pure predicates the purpose gate
// answers with (compliance/gate.ts).
//
// Two readers share readRegisterState(): the worker's flag cache, as hearth_queue, in the same
// read-only transaction as its flags (T22 item 9, flags/cache.ts), and the flags route, as the
// signed-in admin, in its own transaction (T22 item 11, flags/set.ts). Both read only the columns
// hearth_queue is granted. The api's sends never use a RegisterState: they ask transfer_send_state()
// in the transaction that decides each send (compliance/transfers.ts, PD-15, PD-59).
//
// From C0.9 PR 2 it also reads the published notice (migration 0010): the latest version, whether
// Hearth generated it, the purposes it lists at which register version, and whether it states each
// open clearance's notice facts (notice_provider_states(), so neither reader sees a clearance's
// facts, B-06). From these: "notified" (PD-40), the provider-notice rule (PD-41, providerCleared)
// and the pinned purposes the published notice no longer describes (B-04, C-09).
//
// Every predicate fails closed: a register never read, or not read for 8 s (undefined here), allows
// only the pinned purposes, accounts and service_operation, which Hearth runs on whatever the
// register says (PD-07). An AI purpose or provider is never allowed before A0 (D41).
import {
  type Basis,
  isAiProvider,
  isAiPurpose,
  isPinnedPurpose,
  PINNED_PURPOSES,
  type PurposeStatus,
} from '@hearth/shared'
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
// the DPO set it), its open clearance's id, if it has one (PD-05), and whether the latest notice
// version links a clearance of this provider whose notice facts equal the open one's (false with no
// open clearance or no version; C0.9 PD-41).
export interface ProviderEntryState {
  revision: number
  reviewOn: string | null
  clearance: string | null
  stated: boolean
}

// The org's latest notice version: its id, and whether Hearth generated it (false for a stand-in,
// which only ever comes before the first generated version, PD-33).
export interface NoticeState {
  id: string
  generated: boolean
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
  // The purposes the highest published notice lists at their current register version, while that
  // version is active (PD-08, PD-40): any change to a purpose after publishing takes it out until the
  // next publish. Empty with no version, so only the pinned purposes pass (PGT-04).
  notified: ReadonlySet<string>
  // The latest notice version, or null when the org has none.
  notice: NoticeState | null
  // The pinned purposes (PD-07) the latest version, when Hearth generated it, doesn't list at their
  // current register version: they still run, and the published notice is out of date for everyone
  // (B-04, C-09). Empty with no version or a stand-in as the latest.
  stale: ReadonlySet<string>
  // By `${personId}:${purpose}`; undefined when the reader didn't ask for them (only the worker,
  // as hearth_queue, may: hearth_app has no grant on processing_restrictions).
  restrictions: ReadonlyMap<string, RestrictionState> | undefined
}

type PurposeRow = { purpose: string; version: number; status: PurposeStatus; basis: Basis | null; providers: string[] }
// revision is a bigint, which pg returns as a string; review_on is read as text, YYYY-MM-DD.
type ProviderRow = { provider: string; revision: unknown; review_on: string | null; clearance: string | null }
type RestrictionRow = { id: string; person_id: string; purpose: string; effective_at: Date }
// The latest version (id null when the org has none), the purposes it lists, and each open
// clearance's stated, as json arrays.
type NoticeRow = {
  id: string | null
  generated: boolean | null
  purposes: { purpose: string; version: number }[] | null
  providers: { provider: string; clearance: string; stated: boolean }[] | null
}

// The org's registers, in the caller's transaction, with plain reads (no lock: a send's decision is
// transfer_send_state()'s, never this). Restrictions only when asked. The notice is one statement,
// so the version, its links and what it states are one snapshot (notice_provider_states() is
// STABLE, and reads the same latest version); the registers' own reads are a statement each, as in
// PR 1, and a change committing between them shows at the next read.
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
  const { rows: notices } = await sql<NoticeRow>`
    select v.id, v.generator is not null as generated,
      (select json_agg(json_build_object('purpose', l.purpose, 'version', l.register_version))
        from notice_version_purposes l
        where l.org_id = ${orgId} and l.notice_version_id = v.id) as purposes,
      (select json_agg(json_build_object('provider', s.provider, 'clearance', s.clearance, 'stated', s.stated))
        from public.notice_provider_states() s) as providers
    from (values (1)) as one (n)
    left join lateral (
      select id, generator from notice_versions where org_id = ${orgId} order by version desc limit 1) v on true`.execute(
    trx,
  )
  const row = notices[0]
  const notice: NoticeState | null =
    row === undefined || row.id === null ? null : { id: row.id, generated: row.generated === true }
  // What the latest version lists, by purpose: the register version it was built from.
  const listed = new Map((notice === null ? [] : (row?.purposes ?? [])).map(link => [link.purpose, link.version]))
  // Which open clearances it states, by provider (one open clearance each).
  const stated = new Map((row?.providers ?? []).map(entry => [entry.provider, entry]))
  const current = new Map(
    purposes.rows.map(entry => [
      entry.purpose,
      { version: entry.version, status: entry.status, basis: entry.basis, providers: entry.providers },
    ]),
  )
  const notified = new Set(
    [...current]
      .filter(([purpose, entry]) => entry.status === 'active' && listed.get(purpose) === entry.version)
      .map(([purpose]) => purpose),
  )
  const stale = new Set(
    notice?.generated === true
      ? PINNED_PURPOSES.filter(purpose => listed.get(purpose) !== current.get(purpose)?.version)
      : [],
  )
  return {
    purposes: current,
    providers: new Map(
      providers.rows.map(entry => {
        const listedClearance = stated.get(entry.provider)
        return [
          entry.provider,
          {
            // Revisions stay far below 2^53.
            revision: Number(entry.revision),
            reviewOn: entry.review_on,
            clearance: entry.clearance,
            stated:
              entry.clearance !== null &&
              listedClearance?.clearance === entry.clearance &&
              listedClearance.stated === true,
          },
        ]
      }),
    ),
    notified,
    notice,
    stale,
    restrictions,
  }
}

// What a change to the registers moves (T22 item 9): each purpose's version, each provider's
// revision (any change of facts, a review date included, bumps it), open clearance and whether the
// notice states it, the latest notice version (whose links never change), and each live
// restriction. Two reads with the same digest found the same registers, so a publish logs
// register_changed in the worker within one poll.
export function registerDigest(state: RegisterState): string {
  const parts = [
    ...[...state.purposes].map(([purpose, entry]) => `purpose:${purpose}:${entry.version}`),
    ...[...state.providers].map(
      ([provider, entry]) =>
        `provider:${provider}:${entry.revision}:${entry.clearance ?? 'none'}:${entry.stated ? 'stated' : 'unstated'}`,
    ),
    `notice:${state.notice?.id ?? 'none'}`,
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
// clearance, and the published notice states it, or the org has no generated version yet (no
// version, or a stand-in as the latest: PR 1's rule; C0.9 PD-41, B-03, as transfer_cleared()
// answers). Never an AI provider before A0 (D41). The worker's view, a poll old at most; the api asks
// transfer_send_state() in the transaction that decides each send instead (PD-15).
export function providerCleared(state: RegisterState | undefined, provider: string): boolean {
  if (isAiProvider(provider) || state === undefined) return false
  const entry = state.providers.get(provider)
  if (entry === undefined || entry.clearance === null) return false
  return state.notice === null || !state.notice.generated || entry.stated
}

// Whether this person's processing for the purpose may go ahead (T22 item 7, PD-10; PDPA-04,
// PDPA-04a): yes for a pinned purpose; no for consent until consent records exist (C1.3; C0.9
// PD-38 refuses a consent-type basis at publishing until then); for deemed consent (by conduct, or
// by notification under s15A), yes unless a restriction of theirs is in effect; yes for any other
// recorded basis; no with no basis recorded, an AI purpose, a register not read, or restrictions
// not read.
//
// A register gone stale mid-round never withholds an event (A-12, PD-51): the consumer moves its
// checkpoint past an event it withholds, so withholding for an unknown register would drop it for
// good. When a subject's switch refuses an event while purposeAllowed() no longer allows the
// consumer's purpose, the round throws RoundRefused and rolls back, keeping its place
// (outbox/consumers.ts, T22 item 32); a refusal under an allowed purpose still withholds.
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
