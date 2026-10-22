// Stand-ins for the api's transfer gate in unit tests (test-only; the image leaves testing/ out):
// a test assigns one to Api.transfers in place of DB_TRANSFERS (compliance/transfers.ts), which only
// registerApi sets in production (scripts/guards/api-test-overrides.test.ts).
import type { ProviderKey } from '@hearth/shared'
import type { TransferCheck } from '#src/compliance/transfers.ts'
import type { InOrg } from '#src/db/database.ts'

// Clears no provider, and asks nothing.
export const NOTHING_CLEARED: TransferCheck = { cleared: async () => false }

// Clears the providers named and no other, and keeps every ask, with the transaction it came in.
export function CLEARING(...providers: ProviderKey[]): TransferCheck & {
  asked: { provider: ProviderKey; trx: InOrg }[]
} {
  const asked: { provider: ProviderKey; trx: InOrg }[] = []
  return {
    asked,
    cleared: async (trx, provider) => {
      asked.push({ provider, trx })
      return providers.includes(provider)
    },
  }
}
