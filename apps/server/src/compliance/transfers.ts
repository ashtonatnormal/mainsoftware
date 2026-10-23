// The api's transfer gate (PDPA-10, D46; C0.9 PD-15, TECH-SPEC T22 item 8): whether an outside
// provider may receive personal data for this send. It keeps no copy: transfer_cleared() (migration
// 0009) reads the org's open clearance FOR SHARE in the transaction that decides the send (sign-in's
// code delivery, a re-authentication's code), so an api that has never served the org sends at
// once, and a withdrawal applies to the next decision. A withdrawal in progress makes the read wait
// and then find nothing; one that starts later waits for the send's transaction. The provider is
// called only after that transaction commits, so a withdrawal that commits in between can't stop
// that one send (the bound T22 item 8 states). The function needs a read-write transaction (row
// locks), and the org the transaction set.
//
// Api.transfers is DB_TRANSFERS, which registerApi sets and nothing else may replace outside tests
// (testing/transfers.ts has theirs; scripts/guards/api-test-overrides.test.ts).
import type { ProviderKey } from '@hearth/shared'
import { sql } from 'kysely'
import type { InOrg } from '#src/db/database.ts'

export interface TransferCheck {
  cleared(trx: InOrg, provider: ProviderKey): Promise<boolean>
}

export const DB_TRANSFERS: TransferCheck = {
  async cleared(trx, provider) {
    const { rows } = await sql<{ cleared: boolean }>`select public.transfer_cleared(${provider}) as cleared`.execute(
      trx,
    )
    return rows[0]?.cleared === true
  },
}
