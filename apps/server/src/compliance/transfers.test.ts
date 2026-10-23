// The api's transfer gate (compliance/transfers.ts): the code-send rule over transfer_send_state()'s
// four answers (C0.9 PD-59, B-03, C-01, C-02), and DB_TRANSFERS's two reads. The integration suite
// (sign-in.integration.test.ts XFR-I4 to I7) and db/tests/160_notice.sql (NTD-09) run them on
// Postgres.
import { describe, expect, it } from 'vitest'
import { codeHeldBack, codeMaySend, DB_TRANSFERS, SEND_STATES } from '#src/compliance/transfers.ts'
import { withOrg } from '#src/db/database.ts'
import { scriptedPool, systemPrincipal } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const SYSTEM = 'c0000000-0000-4000-8000-000000000001'

describe('XFR-03 C0.9 PD-59 B-03 codeMaySend: who gets a code through a provider in each send state', () => {
  it('sends to everyone while the notice states the clearance, to a holder of dpo alone before any version or once it no longer does, and to nobody without a clearance', () => {
    const rows = SEND_STATES.map(state => [state, codeMaySend(state, true), codeMaySend(state, false)])
    expect(rows).toEqual([
      ['not_cleared', false, false],
      ['no_notice', true, false],
      ['cleared', true, true],
      ['unstated', true, false],
    ])
  })

  it('names what a held-back code is audited as, and nothing for one that goes', () => {
    expect(SEND_STATES.map(state => [state, codeHeldBack(state, false), codeHeldBack(state, true)])).toEqual([
      ['not_cleared', 'skipped_not_cleared', 'skipped_not_cleared'],
      ['no_notice', 'skipped_no_notice', undefined],
      ['cleared', undefined, undefined],
      ['unstated', 'skipped_unstated', undefined],
    ])
  })
})

describe('XFR-03 C0.9 PD-15 PD-59 DB_TRANSFERS', () => {
  const asking = (answer: Record<string, unknown>) =>
    scriptedPool(statement => {
      if (statement.text.startsWith('select public.transfer_send_state(')) return [answer]
      if (statement.text.startsWith('select public.transfer_cleared(')) return [answer]
      return systemPrincipal(SYSTEM)(statement)
    })

  it('asks transfer_send_state() for the provider in the caller’s transaction, and reads an answer it never gives as not cleared', async () => {
    for (const state of [...SEND_STATES, 'something_else', null]) {
      const pool = asking({ state })
      const answered = await withOrg(pool.db, { orgId: ORG, system: true }, trx => DB_TRANSFERS.state(trx, 'twilio'))
      expect(answered, String(state)).toBe(SEND_STATES.some(known => known === state) ? state : 'not_cleared')
      const ask = pool.statements.find(s => s.text.startsWith('select public.transfer_send_state('))
      expect(ask).toEqual({ text: 'select public.transfer_send_state($1) as state', values: ['twilio'] })
      const texts = pool.texts()
      expect(texts.indexOf(ask?.text ?? '')).toBeGreaterThan(
        texts.indexOf('start transaction isolation level read committed'),
      )
    }
  })

  it('still asks transfer_cleared() for cleared(), true only when it answers true', async () => {
    for (const cleared of [true, false, null]) {
      const pool = asking({ cleared })
      expect(await withOrg(pool.db, { orgId: ORG, system: true }, trx => DB_TRANSFERS.cleared(trx, 'aws'))).toBe(
        cleared === true,
      )
      expect(pool.statements.find(s => s.text.startsWith('select public.transfer_cleared('))?.values).toEqual(['aws'])
    }
  })
})
