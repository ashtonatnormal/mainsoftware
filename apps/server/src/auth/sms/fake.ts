// The local stand-in for Twilio Verify (OD-01, TECH-SPEC T20): it makes, keeps and checks codes in
// memory with Verify's semantics, and sends nothing anywhere.
// - A start for a number that still has a pending verification within its validity hands back the
//   same reference and code, with one more send listed, so a second start reads as foreign, as
//   Twilio's send_code_attempts makes it. A 6th send to one verification is refused (60203).
// - A check of an approved, cancelled, expired or unknown reference is gone (Twilio's 404), and so
//   is a 6th check of one verification (60202).
// The FakeVerify class has no guard and prints nothing: the integration harness and the unit tests
// construct it, and read the codes from `sent`. The only production path is createFakeVerify(),
// which main.ts calls: it refuses anywhere but this machine (DEPLOY_ENV local or test, and a
// loopback APP_ORIGIN; config.ts refuses the same, independently) and prints each code to stderr,
// never to the JSON log stream, with the number masked, so a developer or the e2e run can sign in.
// On ECS stderr reaches CloudWatch too, which is why two independent conditions guard it.
import { randomBytes, randomInt } from 'node:crypto'
import { maskNumber, type ProviderKey } from '@hearth/shared'
import { OTP } from '#src/auth/policy.ts'
import { type SmsProvider, SmsProviderError, type Verdict } from '#src/auth/sms/provider.ts'
import { isLoopbackOrigin } from '#src/config.ts'

// Twilio's defaults: a verification is valid 10 minutes, and takes at most 5 sends and 5 checks.
const VALIDITY_MS = 600_000
const MAX_SENDS = 5
const MAX_CHECKS = 5

interface Verification {
  to: string
  code: string
  createdAt: number
  sends: number
  checks: number
  status: 'pending' | 'approved' | 'canceled'
}

export interface FakeVerifyOptions {
  // The transfer-register entry it claims to need (a test of the transfer gate sets one).
  transfer?: ProviderKey | null
  // Validity of a verification, in ms.
  validityMs?: number
  now?: () => number
  // Makes each new code (6 random digits by default).
  codes?: () => string
  // Called with each text it would send (createFakeVerify prints it).
  onSend?: (to: string, code: string) => void
}

export class FakeVerify implements SmsProvider {
  readonly name = 'fake'
  readonly transfer: ProviderKey | null
  // Every text it would have sent, in order (a repeated start of one verification sends its code
  // again, as Twilio does).
  readonly sent: { to: string; code: string; ref: string; at: number }[] = []
  // Every check it was asked to make, by reference.
  readonly checks: { ref: string }[] = []
  // Every cancel it was asked to make.
  readonly cancels: { ref: string }[] = []
  readonly #verifications = new Map<string, Verification>()
  readonly #validityMs: number
  readonly #now: () => number
  readonly #codes: () => string
  readonly #onSend: ((to: string, code: string) => void) | undefined
  // Errors to throw from the next calls of each operation, in order.
  readonly #failures: Record<'start' | 'check' | 'cancel', Error[]> = { start: [], check: [], cancel: [] }
  // How many codes nextCode() has handed out per number.
  readonly #taken = new Map<string, number>()
  readonly #waiting = new Set<() => void>()

  constructor(options: FakeVerifyOptions = {}) {
    this.transfer = options.transfer ?? null
    this.#validityMs = options.validityMs ?? VALIDITY_MS
    this.#now = options.now ?? Date.now
    this.#codes =
      options.codes ??
      (() =>
        randomInt(0, 10 ** OTP.length)
          .toString()
          .padStart(OTP.length, '0'))
    this.#onSend = options.onSend
  }

  // The next call of `op` throws `error` (an SmsProviderError 'unavailable' by default), as a
  // provider that is down does.
  failNext(op: 'start' | 'check' | 'cancel', error: Error = new SmsProviderError('unavailable', undefined, 503)): void {
    this.#failures[op].push(error)
  }

  #fail(op: 'start' | 'check' | 'cancel'): void {
    const error = this.#failures[op].shift()
    if (error !== undefined) throw error
  }

  #live(verification: Verification | undefined): verification is Verification {
    return (
      verification !== undefined &&
      verification.status === 'pending' &&
      this.#now() - verification.createdAt < this.#validityMs
    )
  }

  async start(to: string): Promise<{ ref: string; foreign: boolean }> {
    this.#fail('start')
    let ref: string | undefined
    for (const [sid, verification] of this.#verifications) {
      if (verification.to === to && this.#live(verification)) ref = sid
    }
    let verification = ref === undefined ? undefined : this.#verifications.get(ref)
    if (ref === undefined || verification === undefined) {
      ref = `VE${randomBytes(16).toString('hex')}`
      verification = { to, code: this.#codes(), createdAt: this.#now(), sends: 0, checks: 0, status: 'pending' }
      this.#verifications.set(ref, verification)
    }
    if (verification.sends >= MAX_SENDS) throw new SmsProviderError('send_limit', 60203, 429)
    verification.sends++
    this.sent.push({ to, code: verification.code, ref, at: this.#now() })
    this.#onSend?.(to, verification.code)
    for (const wake of this.#waiting) wake()
    return { ref, foreign: verification.sends > 1 }
  }

  async check(ref: string, code: string): Promise<Verdict> {
    this.checks.push({ ref })
    this.#fail('check')
    const verification = this.#verifications.get(ref)
    if (!this.#live(verification)) return 'gone'
    if (verification.checks >= MAX_CHECKS) return 'gone'
    verification.checks++
    if (verification.code !== code) return 'wrong'
    verification.status = 'approved'
    return 'approved'
  }

  async cancel(ref: string): Promise<void> {
    this.cancels.push({ ref })
    this.#fail('cancel')
    const verification = this.#verifications.get(ref)
    if (verification?.status === 'pending') verification.status = 'canceled'
  }

  // The first code sent to `to` after the last one this method returned for `to` (counted, so a
  // second sign-in never gets the first code back). Rejects after timeoutMs.
  nextCode(to: string, timeoutMs = 2000): Promise<string> {
    return new Promise((resolve, reject) => {
      const take = () => {
        const index = this.#taken.get(to) ?? 0
        const next = this.sent.filter(entry => entry.to === to)[index]
        if (next === undefined) return false
        this.#taken.set(to, index + 1)
        resolve(next.code)
        return true
      }
      if (take()) return
      const wake = () => {
        if (!take()) return
        clearTimeout(timer)
        this.#waiting.delete(wake)
      }
      const timer = setTimeout(() => {
        this.#waiting.delete(wake)
        reject(new Error(`no code was sent within ${timeoutMs} ms`))
      }, timeoutMs)
      this.#waiting.add(wake)
    })
  }

  countTo(to: string): number {
    return this.sent.filter(entry => entry.to === to).length
  }
}

// The fake for main.ts: this machine only, printing each code to stderr (purpose-neutral, since
// re-authentication codes use it too; the e2e run reads the line).
export function createFakeVerify(options: {
  deployEnv: string
  appOrigin: string
  write?: (line: string) => void
}): FakeVerify {
  const localOrTest = options.deployEnv === 'local' || options.deployEnv === 'test'
  if (!localOrTest || !isLoopbackOrigin(options.appOrigin)) {
    throw new Error(
      'the fake SMS provider runs only on this machine (DEPLOY_ENV local or test, and a localhost APP_ORIGIN)',
    )
  }
  const write = options.write ?? ((line: string) => process.stderr.write(line))
  return new FakeVerify({
    onSend: (to, code) => write(`[local only, not a log line] Hearth code for ${maskNumber(to)}: ${code}\n`),
  })
}
