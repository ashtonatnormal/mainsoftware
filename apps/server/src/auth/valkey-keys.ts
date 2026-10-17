// Every Valkey key and channel the server uses: sign-in's (C0.5), the flags channel (C0.6), and the
// realtime gateway's (C0.7, TECH-SPEC T19): the access channel, and each org's event stream and its
// epoch. No key, channel or entry holds a phone number, an IP address, a code, a token, an attempt
// id or content: only tag() and keyName() outputs (crypto.ts), uuids and the fixed subject `all`.
// All limiter keys share the hash tag {auth}, so one script can touch them all even on a clustered
// Valkey; an org's stream and its epoch share the hash tag {<org id>}, so the producer's one script
// (realtime/stream.ts) writes both on a cluster too.

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
    // The pub/sub channel on which the api tells the realtime role which sessions ended (v1, C0.5;
    // revocation/channels.ts).
    revoked: `${prefix}revoked`,
    // The pub/sub channel for everything newer about lost access (v1, C0.7): the worker's
    // revocation jobs' ended sessions and people whose keys changed (revocation/channels.ts).
    access: `${prefix}access`,
    // An org's stream of topic events, trimmed by age with a count cap as a memory backstop, read by
    // every realtime process for fan-out (T19 item 9). It is never replayed to a client, and neither
    // its ids nor its entries' numbers ever reach one (the producer answers the id to its api or
    // worker caller only).
    stream: (orgId: string) => `${prefix}rt:{${orgId}}`,
    // A random uuid that changes when the stream is lost (a Valkey restart or failover), so every
    // reader of the org finds the gap and tells its sockets to refetch.
    epoch: (orgId: string) => `${prefix}rt:{${orgId}}:epoch`,
    // The pub/sub channel that tells every process an org's flags changed (flags/channel.ts; T17).
    flags: `${prefix}flags`,
  }
}

export type ValkeyKeys = ReturnType<typeof valkeyKeys>
