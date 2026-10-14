// Whether a PIN can be tried now (PRD-53, ACC-02, ACC-06). Computed from the raw values on the
// users row and the database's clock, never stored, so changing the numbers in policy.ts applies
// to history (CLAUDE.md, Database).
import { PIN } from '#src/auth/policy.ts'

export type PinState =
  | { state: 'unset' }
  | { state: 'ok'; triesBeforeLock: number; triesBeforeAdminLock: number }
  | { state: 'locked'; until: Date }
  | { state: 'admin_locked' }

// No hash: unset. 10 failures: locked until an admin resets it. 5 or more, the last within 15
// minutes: locked until 15 minutes after it. Every failure from the 5th starts a new lock, so
// after a lock ends one more try is allowed before the next.
export function pinState(
  row: { pinHash: string | null; failures: number; lastFailedAt: Date | null },
  now: Date,
): PinState {
  if (row.pinHash === null) return { state: 'unset' }
  if (row.failures >= PIN.adminLockAfter) return { state: 'admin_locked' }
  if (row.failures >= PIN.timedLockAfter && row.lastFailedAt !== null) {
    const until = new Date(row.lastFailedAt.getTime() + PIN.timedLockMs)
    if (until > now) return { state: 'locked', until }
  }
  return {
    state: 'ok',
    triesBeforeLock: Math.max(PIN.timedLockAfter - row.failures, 1),
    triesBeforeAdminLock: PIN.adminLockAfter - row.failures,
  }
}
