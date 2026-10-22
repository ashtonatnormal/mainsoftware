// The purpose gate over the registers (C0.9, TECH-SPEC T22 items 6, 7 and 9; T15 item 10): the
// worker's gate, which the job runner and the outbox consumers ask (jobs/gate.ts admit(),
// outbox/consumers.ts), judging each piece of work by the register copy the worker's flag cache
// keeps (flags/cache.ts register()). It reads memory only, so every check is synchronous; a copy
// never read, or not read for 8 s, reads as undefined, and then only the pinned purposes pass
// (PD-07). Spend caps are A0's: until then nothing is over one.
//
// A plain object of closures, as every Gate is, so a test can spread it and replace one check.
import { isProcessingAllowed, providerCleared, purposeAllowed } from '#src/compliance/registers.ts'
import type { FlagCache } from '#src/flags/cache.ts'
import type { Gate } from '#src/jobs/gate.ts'

export function registerGate(source: Pick<FlagCache, 'register'>): Gate {
  return {
    purposeAllowed: (orgId, purpose) => purposeAllowed(source.register(orgId), purpose),
    providerCleared: (orgId, provider) => providerCleared(source.register(orgId), provider),
    processingAllowed: (orgId, subjectId, purpose) => isProcessingAllowed(source.register(orgId), subjectId, purpose),
    overCap: () => false,
  }
}
