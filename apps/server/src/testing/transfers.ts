// Stand-ins for the api's transfer gate in unit tests (test-only; the image leaves testing/ out):
// a test assigns one to Api.transfers in place of DB_TRANSFERS (compliance/transfers.ts), which only
// registerApi sets in production (scripts/guards/api-test-overrides.test.ts).
import type { ProviderKey } from '@hearth/shared'
import type { SendState, TransferCheck } from '#src/compliance/transfers.ts'
import type { InOrg } from '#src/db/database.ts'

// Clears no provider, and asks nothing.
export const NOTHING_CLEARED: TransferCheck = { cleared: async () => false, state: async () => 'not_cleared' }

// Clears the providers named and no other, the notice stating each ('cleared'), and keeps every ask
// of either check, with the transaction it came in.
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
    state: async (trx, provider) => {
      asked.push({ provider, trx })
      return providers.includes(provider) ? 'cleared' : 'not_cleared'
    },
  }
}

// Answers this send state for the provider named, and 'not_cleared' for any other (C0.9 PD-59);
// cleared() as transfer_cleared() would (true for 'cleared' and 'no_notice'). Keeps every ask.
export function STATE(
  provider: ProviderKey,
  state: SendState,
): TransferCheck & { asked: { provider: ProviderKey; trx: InOrg }[] } {
  const asked: { provider: ProviderKey; trx: InOrg }[] = []
  const of = (given: ProviderKey): SendState => (given === provider ? state : 'not_cleared')
  return {
    asked,
    cleared: async (trx, given) => {
      asked.push({ provider: given, trx })
      return of(given) === 'cleared' || of(given) === 'no_notice'
    },
    state: async (trx, given) => {
      asked.push({ provider: given, trx })
      return of(given)
    },
  }
}
