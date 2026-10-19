// Domain types and zod schemas shared by apps/web and apps/server (T1). The demo's
// src/types.ts is a starting point for the vocabulary, not the schema (BUILD-PLAN 1E.5).
//
// From C0.6: the purpose keys (PDPA-01), the feature flag registry (T17), the outbox event
// catalogue (T16) and the ids-only rule their schemas follow. From C0.7: the realtime gateway's
// protocol (T19 item 10). From C0.8: the sign-in and re-authentication contract (T20).
export * from './auth.ts'
export * from './events.ts'
export * from './flags.ts'
export * from './gateway.ts'
export * from './ids.ts'
export * from './purposes.ts'
