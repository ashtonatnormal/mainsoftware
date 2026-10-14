// The gate work passes before it touches anyone's personal data (BUILD-PLAN 842; TECH-SPEC T15 item
// 10): a job before it runs, at every step and before every commit, and an outbox consumer before
// each round and for each event's subjects. Each check takes the work's registry entry (its
// purpose, the providers it names), never what a producer wrote into a row. The flags route asks
// it too before turning a feature on (T17 item 9).
//
// C0.6 has no processing register, transfer register or spend caps yet, so its stand-ins fail
// closed: C0.9 replaces the first three with the registers and isProcessingAllowed, and A0 the
// fourth with spend caps.
import { isAiPurpose, type ProviderKey, PURPOSES, type PurposeKey } from '@hearth/shared'

export interface Gate {
  // Whether the org may process personal data for this purpose at all. C0.6: never for an AI
  // purpose (D41: nothing calls a model before A0); C0.9's purpose gate is the second lock.
  purposeAllowed(orgId: string, purpose: PurposeKey): boolean
  // Whether an outside provider is cleared to receive personal data (PDPA-10). C0.6: none is, and
  // no C0.6 job or consumer names one.
  providerCleared(orgId: string, provider: ProviderKey): boolean
  // Whether this person's processing switch allows the purpose (PDPA-04, PDPA-04a). C0.6: only a
  // purpose that rests on something other than consent, until C0.9's isProcessingAllowed.
  processingAllowed(orgId: string, subjectId: string, purpose: PurposeKey): boolean
  // Whether an optional feature is over its spend cap (ADM-05). C0.6: nothing is. A cap can only
  // ever pause an optional feature, never an essential one (D10); the caller applies that rule.
  overCap(orgId: string, feature: string): boolean
}

export const C06_GATE: Gate = {
  purposeAllowed: (_orgId, purpose) => !isAiPurpose(purpose),
  providerCleared: () => false,
  processingAllowed: (_orgId, _subjectId, purpose) => PURPOSES[purpose]?.consent === false,
  overCap: () => false,
}
