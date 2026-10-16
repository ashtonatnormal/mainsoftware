// A stand-in for the api's flag cache in unit tests (test-only; the image leaves testing/ out): the
// registry the flags route reads, and track() and reload() that record their calls and touch no
// database.
import { FLAGS, type FlagSpec } from '@hearth/shared'
import { vi } from 'vitest'

export function staticFlags(registry: Readonly<Record<string, FlagSpec>> = FLAGS) {
  return {
    registry,
    track: vi.fn(async (_orgId: string) => {}),
    reload: vi.fn(async (_orgId: string) => {}),
  }
}
