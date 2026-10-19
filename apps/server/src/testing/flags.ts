// A stand-in for the api's flag cache in unit tests (test-only; the image leaves testing/ out): the
// registry the flags route reads, track() and reload() that record their calls and touch no
// database, and verdict(), which GET /api/flags asks about each client flag (T17 item 11): off for
// every key unless a test says otherwise.
import { FLAGS, type FlagSpec } from '@hearth/shared'
import { vi } from 'vitest'
import type { FlagVerdict } from '#src/flags/cache.ts'
import type { FlagSubject } from '#src/flags/evaluate.ts'

export function staticFlags(registry: Readonly<Record<string, FlagSpec>> = FLAGS) {
  return {
    registry,
    track: vi.fn(async (_orgId: string) => {}),
    reload: vi.fn(async (_orgId: string) => {}),
    verdict: vi.fn((_orgId: string, _key: string, _subject: FlagSubject | null): FlagVerdict => 'off'),
  }
}
