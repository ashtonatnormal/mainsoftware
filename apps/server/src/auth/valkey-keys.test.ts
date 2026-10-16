import { describe, expect, it } from 'vitest'
import { valkeyKeys, valkeyPrefix } from '#src/auth/valkey-keys.ts'

describe('T14 C0.6 T17 C0.7 T19 the Valkey keys and channels the server uses', () => {
  it('prefixes every key and channel with the environment', () => {
    expect(valkeyPrefix('local')).toBe('h:local:')
    expect(valkeyPrefix('prod')).toBe('h:prod:')
    const keys = valkeyKeys('h:prod:')
    expect(keys.otp('TAG')).toBe('h:prod:otp:{TAG}')
    expect(keys.attempt('KEY')).toBe('h:prod:att:KEY')
    expect(keys.challenge('signin', 'KEY')).toBe('h:prod:pk:signin:KEY')
    expect(keys.challenge('reauth', 'S')).toBe('h:prod:pk:reauth:S')
    expect(keys.revoked).toBe('h:prod:revoked')
    expect(keys.flags).toBe('h:prod:flags')
    expect(keys.access).toBe('h:prod:access')
    expect(keys.stream('a0000000-0000-4000-8000-000000000001')).toBe('h:prod:rt:{a0000000-0000-4000-8000-000000000001}')
    expect(keys.epoch('a0000000-0000-4000-8000-000000000001')).toBe(
      'h:prod:rt:{a0000000-0000-4000-8000-000000000001}:epoch',
    )
  })

  it('puts every limiter key in one hash slot, so one script can touch them all on a cluster', () => {
    const keys = valkeyKeys('h:local:')
    const slots = [keys.limit('otp-all', 'all'), keys.limit('otp-n10m', 'TAG'), keys.limit('auth-ip', 'IPTAG')].map(
      key => /\{([^}]*)\}/.exec(key)?.[1],
    )
    expect(slots).toEqual(['auth', 'auth', 'auth'])
    expect(keys.limit('otp-n10m', 'TAG')).toBe('h:local:rl:{auth}:otp-n10m:TAG')
  })

  it('T19 item 9: puts an org’s stream and its epoch in one hash slot, so the producer’s script runs on a cluster', () => {
    const keys = valkeyKeys('h:local:')
    const org = 'a0000000-0000-4000-8000-000000000001'
    expect([keys.stream(org), keys.epoch(org)].map(key => /\{([^}]*)\}/.exec(key)?.[1])).toEqual([org, org])
  })
})
