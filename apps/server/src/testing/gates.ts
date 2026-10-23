// Gates and register states for unit tests (test-only; the image leaves testing/ out).
//   coreOnlyGate    the worker's gate over a register never read (C0.9 PD-07): the pinned purposes
//                   pass, everything else is refused and no provider is cleared. It stands where
//                   C0.6's stand-in did, for tests whose work serves a pinned or an AI purpose.
//   registerStateOf a RegisterState from what a test names, for the predicates and the gate.
import type { Basis, PurposeStatus } from '@hearth/shared'
import { registerGate } from '#src/compliance/gate.ts'
import type { RegisterState } from '#src/compliance/registers.ts'
import type { Gate } from '#src/jobs/gate.ts'

export const coreOnlyGate: Gate = registerGate({ register: () => undefined })

export interface RegisterStateSpec {
  // Each purpose's current entry; version 2 unless given.
  purposes?: Record<string, { status: PurposeStatus; basis?: Basis | null; providers?: string[]; version?: number }>
  // The providers with an open clearance.
  cleared?: string[]
  notified?: string[]
  // The latest notice version (none unless given; C0.9 PR 2), the cleared providers it states, and
  // the pinned purposes it no longer describes.
  notice?: { id?: string; generated: boolean } | null
  stated?: string[]
  stale?: string[]
  // Live restrictions, each in effect from `effectiveAt` (epoch ms; 0 unless given).
  restrictions?: { person: string; purpose: string; effectiveAt?: number; id?: string }[]
}

export function registerStateOf(spec: RegisterStateSpec = {}): RegisterState {
  return {
    purposes: new Map(
      Object.entries(spec.purposes ?? {}).map(([purpose, entry]) => [
        purpose,
        {
          version: entry.version ?? 2,
          status: entry.status,
          basis: entry.basis ?? null,
          providers: entry.providers ?? [],
        },
      ]),
    ),
    providers: new Map(
      (spec.cleared ?? []).map((provider, n) => [
        provider,
        {
          revision: 2,
          reviewOn: null,
          clearance: `c0000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
          stated: (spec.stated ?? []).includes(provider),
        },
      ]),
    ),
    notified: new Set(spec.notified ?? []),
    notice:
      spec.notice === undefined || spec.notice === null
        ? null
        : { id: spec.notice.id ?? 'd0000000-0000-4000-8000-0000000000a1', generated: spec.notice.generated },
    stale: new Set(spec.stale ?? []),
    restrictions:
      spec.restrictions === undefined
        ? undefined
        : new Map(
            spec.restrictions.map((restriction, n) => [
              `${restriction.person}:${restriction.purpose}`,
              {
                id: restriction.id ?? `e0000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
                effectiveAt: restriction.effectiveAt ?? 0,
              },
            ]),
          ),
  }
}
