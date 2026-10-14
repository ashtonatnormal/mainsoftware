// Every Valkey key and channel the server uses: sign-in's (C0.5) and the flags channel (C0.6). No
// key or channel holds a phone number, an IP address, a code, a token or an attempt id: only tag()
// and keyName() outputs (crypto.ts), uuids and the fixed subject `all`. All limiter keys share the
// hash tag {auth}, so one script can touch them all even on a clustered Valkey.

// h:<DEPLOY_ENV>: so two environments that ever share a Valkey keep their limits, sign-in state and
// channels apart. Tests use it:<random>:.
export function valkeyPrefix(deployEnv: string): string {
  return `h:${deployEnv}:`
}

export function valkeyKeys(prefix: string) {
  return {
    // A sign-in code's challenge for one number (a hash: the attempt, the code's MAC, the tries).
    otp: (numberTag: string) => `${prefix}otp:{${numberTag}}`,
    // A sign-in attempt, by the hash of its id (a JSON string; attempts.ts).
    attempt: (attemptKey: string) => `${prefix}att:${attemptKey}`,
    // A passkey challenge: for a sign-in by attempt key, for re-auth or registration by session id.
    challenge: (kind: 'signin' | 'reauth' | 'register', id: string) => `${prefix}pk:${kind}:${id}`,
    // A sliding window (limiter.ts).
    limit: (name: string, subject: string) => `${prefix}rl:{auth}:${name}:${subject}`,
    // The pub/sub channel that tells the realtime role which sessions ended.
    revoked: `${prefix}revoked`,
    // The pub/sub channel that tells every process an org's flags changed (flags/channel.ts; T17).
    flags: `${prefix}flags`,
  }
}

export type ValkeyKeys = ReturnType<typeof valkeyKeys>
