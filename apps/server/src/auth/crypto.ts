// The sign-in secrets and hashes (T5, T6, T14). One server secret (AUTH_SECRET) feeds every key
// through HKDF-SHA256, salt 'hearth-auth-v1', with a different info label each: the key that
// MACs sign-in codes, the key that turns phone numbers and IPs into Valkey key names, the PIN
// pepper, and an 8-byte id for the pepper, stored beside each PIN hash so a hash made under
// another pepper can be told apart.
//
// node:crypto is imported as a namespace and crypto.argon2 read at call time: Node 22 has no
// argon2, and a named import would fail to link there and take every server test down with it.
// This way only the PIN functions fail on Node 22 (CLAUDE.md, Testing and CI). argon2 needs Node
// 24.7 or later.
import * as crypto from 'node:crypto'
import { OTP, PIN_HASH, PIN_SLOTS } from '#src/auth/policy.ts'

export interface AuthKeys {
  otp: Buffer
  tag: Buffer
  pinPepper: Buffer
  pinKeyId: string
}

const SALT = 'hearth-auth-v1'

function derive(secret: string, info: string, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', secret, SALT, info, length))
}

export function deriveKeys(secret: string): AuthKeys {
  return {
    otp: derive(secret, 'hearth/otp-mac/v1', 32),
    tag: derive(secret, 'hearth/valkey-tag/v1', 32),
    pinPepper: derive(secret, 'hearth/pin-pepper/v1', 32),
    pinKeyId: derive(secret, 'hearth/pin-key-id/v1', 8).toString('hex'),
  }
}

// A new random secret: a session token or a sign-in attempt's id (256 bits, 43 base64url chars).
export function newSecret(): string {
  return crypto.randomBytes(32).toString('base64url')
}

// A session token's stored hash (32 bytes; T5).
export function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest()
}

// A secret's name in a Valkey key (an attempt id's), so the key never holds the secret itself.
export function keyName(value: string): string {
  return sha256(value).toString('base64url')
}

// A keyed hash of an E.164 number, or of 'ip:' and a limit subject, for Valkey key names: 22
// base64url characters (132 bits), so no key holds a number or an address.
export function tag(keys: AuthKeys, value: string): string {
  return crypto.createHmac('sha256', keys.tag).update(value).digest('base64url').slice(0, 22)
}

// A new sign-in code: 6 uniformly random ASCII digits.
export function newOtp(): string {
  return crypto
    .randomInt(0, 10 ** OTP.length)
    .toString()
    .padStart(OTP.length, '0')
}

// The PHC string the server issues: exactly the cost in policy.ts, which 0006's users_pin_hash
// also names. b64 is standard base64 without padding (22 characters of salt, 43 of tag).
const PHC_PREFIX = `$argon2id$v=19$m=${PIN_HASH.memory},t=${PIN_HASH.passes},p=${PIN_HASH.parallelism}$`
const b64Length = (bytes: number) => Math.ceil((bytes * 4) / 3)
const ISSUED = new RegExp(
  `^${PHC_PREFIX.replaceAll('$', '\\$')}[A-Za-z0-9+/]{${b64Length(PIN_HASH.saltBytes)}}\\$[A-Za-z0-9+/]{${b64Length(PIN_HASH.tagBytes)}}$`,
)

function argon2id(pin: string, salt: Buffer, keys: AuthKeys): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // The callback form runs on libuv's thread pool, off the event loop.
    crypto.argon2(
      'argon2id',
      {
        message: pin,
        nonce: salt,
        parallelism: PIN_HASH.parallelism,
        tagLength: PIN_HASH.tagBytes,
        memory: PIN_HASH.memory,
        passes: PIN_HASH.passes,
        secret: keys.pinPepper,
      },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    )
  })
}

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '')

export async function hashPin(pin: string, keys: AuthKeys): Promise<string> {
  const salt = crypto.randomBytes(PIN_HASH.saltBytes)
  return `${PHC_PREFIX}${b64(salt)}$${b64(await argon2id(pin, salt, keys))}`
}

// True only for a hash at the cost the server issues. Anything else (another cost, a changed
// row) is never checked, so a row can't make a check allocate more.
export function isIssuedPinHash(phc: string): boolean {
  return ISSUED.test(phc)
}

export async function verifyPin(pin: string, phc: string, keys: AuthKeys): Promise<boolean> {
  if (!isIssuedPinHash(phc)) return false
  const [salt = '', expected = ''] = phc.slice(PHC_PREFIX.length).split('$')
  const actual = await argon2id(pin, Buffer.from(salt, 'base64'), keys)
  const wanted = Buffer.from(expected, 'base64')
  return wanted.length === actual.length && crypto.timingSafeEqual(actual, wanted)
}

export class PinSlotsFull extends Error {
  override name = 'PinSlotsFull'
  constructor() {
    super('too many PIN checks are waiting')
  }
}

// Runs work holding one of PIN_SLOTS.running slots, with at most PIN_SLOTS.waiting waiting; a
// full queue throws PinSlotsFull (503 unavailable). Callers wrap the whole PIN transaction, so a
// waiting check holds no pooled connection and no row lock.
export function pinSlots(limits: { running: number; waiting: number } = PIN_SLOTS) {
  let running = 0
  const waiting: (() => void)[] = []
  return async function withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (running < limits.running) {
      running++
    } else {
      if (waiting.length >= limits.waiting) throw new PinSlotsFull()
      // The slot is handed over by whoever finishes, so `running` doesn't change.
      await new Promise<void>(resolve => waiting.push(resolve))
    }
    try {
      return await work()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  }
}

export const withPinSlot = pinSlots()
