// The sign-in numbers (TECH-SPEC T14), in one place. PRD-53 sets the code and PIN limits; the
// rest are T14's defaults for the owner to confirm. The database keeps its own copies of two of
// them, which no code path may exceed: a session's 90-day cap (0006, sessions_at_most_90_days)
// and the PIN hash's cost (0006, users_pin_hash). Change those with a migration, never here alone.
import { GATEWAY_CLOSE } from '@hearth/shared'

// A sign-in code: 6 digits, valid 5 minutes, dead after 5 wrong tries (PRD-53). Its challenge record
// (codes.ts) is kept 10 minutes, so a check after the 5 minutes finds it and cancels the provider's
// code; checks are refused from 5 minutes after the request, on Valkey's clock.
// - verifyFloorMs: a refused check (code_wrong, code_dead, code_expired) answers no sooner than this
//   after the request arrived, so the provider's round trip for a roster number can't be timed
//   against a number off the roster (T14 item 3, T20). Successes aren't padded.
// - breaker: after `failures` provider failures within `windowMs`, every check answers 503
//   unavailable for `openMs` without asking the provider (T20).
export const OTP = {
  length: 6,
  ttlMs: 300_000,
  maxTries: 5,
  recordTtlMs: 600_000,
  verifyFloorMs: 2_000,
  breaker: { failures: 3, windowMs: 60_000, openMs: 30_000 },
} as const

// A sign-in attempt (the steps between asking for a code and signing in) lasts 10 minutes from
// the code request, never extended.
export const ATTEMPT_TTL_MS = 600_000

// A session (T5) lasts at most 90 days (2160 hours, 0006's cap), and ends after 30 days unused.
// Its last-seen time is written at most once a minute.
export const SESSION = {
  lifetime: '2160 hours',
  lifetimeSeconds: 7_776_000,
  idle: '30 days',
  touchEveryMs: 60_000,
} as const

// A session issued under the PIN rule, to a PIN-role holder (D46, AQ-05/06): 7 days, set at issue
// in expires_at like SESSION's, so every lookup enforces it with no role read. Must stay below
// SESSION.lifetime: re-authentication tells a session issued under the PIN rule by its shorter
// lifetime, and policy.test.ts pins that.
export const PIN_RULE_SESSION = { lifetime: '168 hours', lifetimeSeconds: 604_800 } as const

// Admin actions, and adding or removing a passkey, need a re-authentication from the last 5 minutes
// (§9.4): the PIN for a session issued under the PIN rule, a fresh SMS code for anyone else
// (D46, AQ-01; packages/access reauthMethodOf).
export const REAUTH = { window: '5 minutes', windowSeconds: 300 } as const

// PRD-53: 5 wrong PINs lock the PIN for 15 minutes, and every failure after that starts a new
// lock; 10 lock it until an admin resets it.
export const PIN = { timedLockAfter: 5, timedLockMs: 900_000, adminLockAfter: 10 } as const

// The one argon2id cost the server issues and accepts (0006's users_pin_hash names the same).
export const PIN_HASH = { memory: 19456, passes: 2, parallelism: 1, saltBytes: 16, tagBytes: 32 } as const

// At most 2 PIN hashes at once per process, and at most 16 waiting (libuv has 4 threads, which
// pg and ioredis also need).
export const PIN_SLOTS = { running: 2, waiting: 16 } as const

// How long a passkey challenge stays valid.
export const PASSKEY_CHALLENGE_TTL_MS = 120_000

// The sliding windows (auth/limiter.ts). Per-number windows count the number's keyed hash, per-IP
// windows an IPv4 address or an IPv6 /64. PRD-53 sets otp-n10m and otp-n24h; the rest are T14's.
export const LIMITS = {
  // Code requests across all numbers, checked first.
  otpAll: { name: 'otp-all', windowMs: 3_600_000, max: 600 },
  // Code requests per number: 3 per 10 minutes and 10 per day (PRD-53).
  otpPerNumber: [
    { name: 'otp-n10m', windowMs: 600_000, max: 3 },
    { name: 'otp-n24h', windowMs: 86_400_000, max: 10 },
  ],
  // Code checks per number per rolling day, the same for every number. A check the provider never
  // answered doesn't count, here or in reauthCheckPerPerson (sign-in.ts giveBack).
  verifyPerNumber: { name: 'otp-v24h', windowMs: 86_400_000, max: 10 },
  // Code requests per IP.
  otpPerIp: { name: 'otp-ip', windowMs: 600_000, max: 30 },
  // Every sign-in request per IP.
  authPerIp: { name: 'auth-ip', windowMs: 600_000, max: 100 },
  // Re-authentications per session (the PIN, and SMS code requests and checks alike).
  reauthPerSession: { name: 'reauth', windowMs: 600_000, max: 10 },
  // SMS re-authentication code requests, and code checks, per person per rolling day (D46, AQ-09).
  reauthCodePerPerson: { name: 'reauth-code-p24h', windowMs: 86_400_000, max: 20 },
  reauthCheckPerPerson: { name: 'reauth-check-p24h', windowMs: 86_400_000, max: 20 },
  // Code sends asked of the provider, across all numbers, sign-in and re-authentication alike: one
  // per code request Hearth delivers, checked before the provider is asked. A start's one retry, or
  // a foreign reply's cancel and second start, can add a text it doesn't count (TECH-SPEC T14 item 5).
  smsGlobal: { name: 'sms-global', windowMs: 3_600_000, max: 100 },
} as const

// A session that ends loses its sockets within this long (ACC-05, T5).
export const SOCKET_REVOKE_MS = 60_000

// The realtime role re-checks every open socket's session this often, and a session holds at most
// this many sockets. With realtime/socket.ts's 10 s deadline for one re-check, 15 s lets one failed
// re-check close nothing and still closes within SOCKET_REVOKE_MS: 2 × (15 + 10) s < 60 s.
export const SOCKET_RECHECK_MS = 15_000
export const SOCKETS_PER_SESSION = 8

// The close a socket gets when its session ends: the client doesn't reconnect. The gateway's
// protocol owns every close code (packages/shared GATEWAY_CLOSE, TECH-SPEC T19 item 10).
export const SIGNED_OUT_CLOSE = GATEWAY_CLOSE.signedOut

// D46: passkeys are kept, switched off. A passkey stands in for a set PIN, and only PIN-role
// holders have PINs. While off, the passkey routes aren't registered (an /api 404), the step-up
// reply has no passkey key and GET /api/devices lists no passkeys. policy.test.ts pins this false,
// so turning it on is a reviewed change; never a flag or an env var. Only tests turn them on
// (ApiDeps.passkeysForTests): the dormant integration suite, and one api.test.ts body-limit case.
export const PASSKEYS_ON = false
