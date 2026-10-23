// The api's transfer gate (PDPA-10, D46; C0.9 PD-15, TECH-SPEC T22 item 8): whether an outside
// provider may receive personal data for this send. It keeps no copy: transfer_send_state() and
// transfer_cleared() (migrations 0009 and 0010) read the org's open clearance FOR SHARE in the
// transaction that decides the send (sign-in's code delivery, a re-authentication's code), so an
// api that has never served the org sends at once, and a withdrawal applies to the next decision. A
// withdrawal in progress makes the read wait and then find nothing; one that starts later waits for
// the send's transaction. The provider is called only after that transaction commits, so a
// withdrawal that commits in between can't stop that one send (the bound T22 item 8 states). The
// functions need a read-write transaction (row locks), and the org the transaction set.
//
// From C0.9 PR 2 the send state also says whether the published notice states the clearance (PD-41,
// PD-59, B-03): 'cleared' when it does (or the latest version is a stand-in), 'no_notice' before any
// version, 'unstated' once a generated version no longer states the clearance's notice facts. A
// sign-in code goes to everyone only while 'cleared', and to a holder of dpo alone otherwise
// (codeMaySend), so before v0 nobody's number but the DPO's reaches Twilio, and after a stated fact
// changes the DPO can still sign in and publish. transfer_cleared() keeps PR 1's meaning for every
// other sender: true for 'cleared' and 'no_notice'.
//
// Api.transfers is DB_TRANSFERS, which registerApi sets and nothing else may replace outside tests
// (testing/transfers.ts has theirs; scripts/guards/api-test-overrides.test.ts).
import type { ProviderKey } from '@hearth/shared'
import { sql } from 'kysely'
import type { InOrg } from '#src/db/database.ts'

// transfer_send_state()'s answers (0010), in the order the function decides them.
export const SEND_STATES = ['not_cleared', 'no_notice', 'cleared', 'unstated'] as const
export type SendState = (typeof SEND_STATES)[number]

export interface TransferCheck {
  // Whether the provider may receive personal data at all: an open clearance, and the notice states
  // it or no generated version exists yet (transfer_cleared()).
  cleared(trx: InOrg, provider: ProviderKey): Promise<boolean>
  // The provider's send state, for a sign-in code's decision (transfer_send_state()).
  state(trx: InOrg, provider: ProviderKey): Promise<SendState>
}

// Whether a sign-in or re-authentication code may go to this person through a provider in this
// state (C0.9 PD-59, B-03): always while the notice states the clearance; to a holder of dpo alone
// before any version is published or while the published one no longer states it; never without a
// clearance. holdsDpo is read in the deciding transaction, after the person's row (holdsRoleNow).
export function codeMaySend(state: SendState, holdsDpo: boolean): boolean {
  if (state === 'cleared') return true
  if (state === 'no_notice' || state === 'unstated') return holdsDpo
  return false
}

// What a code the send state holds back is audited as (auth.code_requested's send, auth/audit.ts),
// or undefined when it may go (codeMaySend).
export type HeldBack = 'skipped_not_cleared' | 'skipped_no_notice' | 'skipped_unstated'
export function codeHeldBack(state: SendState, holdsDpo: boolean): HeldBack | undefined {
  if (codeMaySend(state, holdsDpo)) return undefined
  if (state === 'no_notice') return 'skipped_no_notice'
  if (state === 'unstated') return 'skipped_unstated'
  return 'skipped_not_cleared'
}

const isSendState = (value: unknown): value is SendState => SEND_STATES.some(state => state === value)

export const DB_TRANSFERS: TransferCheck = {
  async cleared(trx, provider) {
    const { rows } = await sql<{ cleared: boolean }>`select public.transfer_cleared(${provider}) as cleared`.execute(
      trx,
    )
    return rows[0]?.cleared === true
  },
  // An answer the function never gives reads as not cleared (fail closed).
  async state(trx, provider) {
    const { rows } = await sql<{ state: unknown }>`select public.transfer_send_state(${provider}) as state`.execute(trx)
    const state = rows[0]?.state
    return isSendState(state) ? state : 'not_cleared'
  },
}
