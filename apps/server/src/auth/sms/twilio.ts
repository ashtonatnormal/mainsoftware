// Twilio Verify behind the SmsProvider interface (OD-01, AQ-03; TECH-SPEC T7, T20). Twilio makes,
// sends and checks the code; Hearth's own rules live in the challenge record (auth/codes.ts).
// - Plain fetch, no twilio package (AQ-21): its auto-retry repeats 429s Twilio says must not be
//   retried, and it would add 48 packages.
// - Credentials: a Restricted API Key scoped to Verify, as HTTP Basic. The key holds create
//   Verification, create VerificationCheck and update Verification only, never a Service update,
//   which could turn on custom codes (C0.19 checks the key's reach).
// - Every request: redirect 'error', a timeout, a size cap before parsing, and zod on the fields
//   used. An error carries Twilio's numeric code and HTTP status only, never its message (which can
//   quote the number), a body, the number, the code or the auth header.
// - start: 4 s per try and one retry, only on a network error, a 5xx or 20429; check: one try of
//   4 s, never retried, since a check may have landed when its reply was lost; cancel: 3 s, no retry.
// - No webhook, and not on /ready.
// The TwilioVerify class takes its base URL: Twilio's, or a loopback http://127.0.0.1:<port> for
// the contract tests (testing/fake-twilio.ts). main.ts builds it only through createTwilioVerify(),
// which fixes Twilio's URL and refuses this machine (DEPLOY_ENV local or test, or a localhost
// APP_ORIGIN), independently of config.ts. It sends nothing until C0.9 clears 'twilio' in the
// transfer register (PDPA-10): sign-in asks the gate first.
import { z } from 'zod'
import { type SmsProvider, SmsProviderError, type SmsProviderErrorKind, type Verdict } from '#src/auth/sms/provider.ts'
import { isLoopbackOrigin } from '#src/config.ts'

const TWILIO_BASE_URL = 'https://verify.twilio.com'

export const TWILIO_TIMEOUTS = { startMs: 4000, checkMs: 4000, cancelMs: 3000 }

// Twilio's replies are small; anything larger is refused before it's parsed.
const MAX_REPLY_BYTES = 64 * 1024

// Twilio's API spec pattern for a Verification's SID: hex digits in either case.
const VERIFICATION_SID = /^VE[0-9a-fA-F]{32}$/

// Twilio's status has seven values; only 'approved' counts, so any other string is accepted.
// send_code_attempts is nullable in Twilio's spec: absent or null lists no sends (T20 item 10).
const verificationReply = z.object({
  sid: z.string().regex(VERIFICATION_SID),
  status: z.string(),
  send_code_attempts: z.array(z.unknown()).nullish(),
})
const checkReply = z.object({ status: z.string() })
const errorReply = z.object({ code: z.number().int() }).partial()

// Twilio's error codes, by what Hearth does about them.
const KIND_OF: Record<number, SmsProviderErrorKind> = {
  20003: 'auth',
  20429: 'unavailable',
  21211: 'invalid_number',
  21614: 'invalid_number',
  60200: 'bug',
  60203: 'send_limit',
  60212: 'send_limit',
  60205: 'blocked',
  60410: 'blocked',
  60605: 'blocked',
}

export interface TwilioVerifyOptions {
  apiKeySid: string
  apiKeySecret: string
  serviceSid: string
  // Twilio's own URL unless a test passes a loopback one.
  baseUrl?: string
  timeouts?: Partial<typeof TWILIO_TIMEOUTS>
}

interface Reply {
  status: number
  body: unknown
}

// A request that never reached Twilio, or whose reply never came back.
class NetworkError extends Error {
  override name = 'NetworkError'
}

export class TwilioVerify implements SmsProvider {
  readonly name = 'twilio'
  readonly transfer = 'twilio'
  readonly #service: string
  readonly #auth: string
  readonly #timeouts: typeof TWILIO_TIMEOUTS

  constructor(options: TwilioVerifyOptions) {
    const base = options.baseUrl ?? TWILIO_BASE_URL
    if (base !== TWILIO_BASE_URL && !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(base)) {
      throw new Error("Twilio Verify's base URL is Twilio's own, or a loopback one for tests")
    }
    this.#service = `${base}/v2/Services/${encodeURIComponent(options.serviceSid)}`
    this.#auth = `Basic ${Buffer.from(`${options.apiKeySid}:${options.apiKeySecret}`).toString('base64')}`
    this.#timeouts = { ...TWILIO_TIMEOUTS, ...options.timeouts }
  }

  async start(to: string): Promise<{ ref: string; foreign: boolean }> {
    let tries = 0
    // The tries that may have reached Twilio, so may have sent: a network error, a timeout or a
    // 5xx counts; a 20429 doesn't, since Twilio never processed it. Counting one would let a
    // pending verification Hearth didn't start, with one send of its own, pass as this call's.
    let sends = 0
    let reply: Reply | undefined
    while (reply === undefined) {
      tries++
      let answer: Reply
      try {
        answer = await this.#post('/Verifications', { To: to, Channel: 'sms' }, this.#timeouts.startMs)
      } catch (error) {
        if (tries === 1 && error instanceof NetworkError) {
          sends++
          continue
        }
        throw unavailable(error)
      }
      if (codeOf(answer) !== 20429) sends++
      if (tries === 1 && retryable(answer)) continue
      reply = answer
    }
    if (reply.status !== 201 && reply.status !== 200) throw failure(reply)
    const parsed = verificationReply.safeParse(reply.body)
    if (!parsed.success) throw new SmsProviderError('bug', undefined, reply.status)
    // Twilio hands back a pending verification for the same number, with every send listed; more
    // sends than this call made means one Hearth didn't start here (sign-in.ts cancels it).
    const listed = (parsed.data.send_code_attempts ?? []).length
    return { ref: parsed.data.sid, foreign: listed > sends }
  }

  async check(ref: string, code: string): Promise<Verdict> {
    let reply: Reply
    try {
      reply = await this.#post('/VerificationCheck', { VerificationSid: ref, Code: code }, this.#timeouts.checkMs)
    } catch (error) {
      throw unavailable(error)
    }
    if (reply.status === 404 || codeOf(reply) === 60202) return 'gone'
    // Twilio's spec lists 201 and 200 for a check, so any 2xx is an answer. Reading a 201 as a
    // failure would give the try back on a check that approved and used up the verification.
    if (reply.status < 200 || reply.status > 299) throw failure(reply)
    const parsed = checkReply.safeParse(reply.body)
    if (!parsed.success) throw new SmsProviderError('bug', undefined, reply.status)
    return parsed.data.status === 'approved' ? 'approved' : 'wrong'
  }

  async cancel(ref: string): Promise<void> {
    let reply: Reply
    try {
      reply = await this.#post(
        `/Verifications/${encodeURIComponent(ref)}`,
        { Status: 'canceled' },
        this.#timeouts.cancelMs,
      )
    } catch (error) {
      throw unavailable(error)
    }
    // Unknown, finished or already cancelled counts as done.
    if (reply.status === 200 || reply.status === 404) return
    throw failure(reply)
  }

  async #post(path: string, form: Record<string, string>, timeoutMs: number): Promise<Reply> {
    let response: Response
    try {
      response = await fetch(`${this.#service}${path}`, {
        method: 'POST',
        headers: {
          authorization: this.#auth,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(form).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new NetworkError('the request to Twilio failed')
    }
    let text: string
    try {
      text = await readCapped(response, MAX_REPLY_BYTES)
    } catch (error) {
      if (error instanceof SmsProviderError) throw error
      throw new NetworkError("Twilio's reply was cut off")
    }
    let body: unknown
    try {
      body = text === '' ? undefined : JSON.parse(text)
    } catch {
      body = undefined
    }
    return { status: response.status, body }
  }
}

// Reads at most `limit` bytes of a reply, refusing a larger one without reading the rest.
async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > limit) {
    await response.body?.cancel()
    throw new SmsProviderError('bug', undefined, response.status)
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new SmsProviderError('bug', undefined, response.status)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function codeOf(reply: Reply): number | undefined {
  const parsed = errorReply.safeParse(reply.body)
  return parsed.success ? parsed.data.code : undefined
}

function retryable(reply: Reply): boolean {
  return reply.status >= 500 || codeOf(reply) === 20429
}

function failure(reply: Reply): SmsProviderError {
  const code = codeOf(reply)
  const kind = code === undefined ? undefined : KIND_OF[code]
  if (kind !== undefined) return new SmsProviderError(kind, code, reply.status)
  if (reply.status >= 500 || reply.status === 429) return new SmsProviderError('unavailable', code, reply.status)
  if (reply.status === 401 || reply.status === 403) return new SmsProviderError('auth', code, reply.status)
  return new SmsProviderError('bug', code, reply.status)
}

function unavailable(error: unknown): Error {
  return error instanceof SmsProviderError ? error : new SmsProviderError('unavailable')
}

// The provider for main.ts: Twilio's own URL, and never on this machine (DEPLOY_ENV anything but
// nonprod or prod, or a localhost APP_ORIGIN), refused here independently of config.ts.
export function createTwilioVerify(options: {
  deployEnv: string
  appOrigin: string
  apiKeySid: string
  apiKeySecret: string
  serviceSid: string
}): TwilioVerify {
  const deployed = options.deployEnv === 'nonprod' || options.deployEnv === 'prod'
  if (!deployed || isLoopbackOrigin(options.appOrigin)) {
    throw new Error(
      'Twilio Verify sends real texts, so it never runs on this machine (DEPLOY_ENV nonprod or prod, and an APP_ORIGIN other than localhost)',
    )
  }
  return new TwilioVerify({
    apiKeySid: options.apiKeySid,
    apiKeySecret: options.apiKeySecret,
    serviceSid: options.serviceSid,
  })
}
