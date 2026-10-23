// Domain types and zod schemas shared by apps/web and apps/server (T1). The demo's
// src/types.ts is a starting point for the vocabulary, not the schema (BUILD-PLAN 1E.5).
//
// From C0.6: the purpose keys (PDPA-01), the feature flag registry (T17), the outbox event
// catalogue (T16) and the ids-only rule their schemas follow. From C0.7: the realtime gateway's
// protocol (T19 item 10). From C0.8: the sign-in and re-authentication contract (T20), and the web
// shell's answers and document headers, its Content Security Policy included (T21). From C0.9: the
// processing and transfer registers' vocabulary, shared rules, bodies and answers (T22), and from
// its PR 2 the privacy notice's (notice.ts), its generator (notice-text.ts, which only the server
// runs) and the words no screen holds before the AI stages (ai-copy.ts).

export * from './ai-copy.ts'
export * from './api-errors.ts'
export * from './auth.ts'
export * from './events.ts'
export * from './flags.ts'
export * from './gateway.ts'
export * from './ids.ts'
export * from './notice.ts'
export * from './notice-text.ts'
export * from './phone.ts'
export * from './pin-policy.ts'
export * from './purposes.ts'
export * from './registers.ts'
export * from './web.ts'
export * from './web-headers.ts'
