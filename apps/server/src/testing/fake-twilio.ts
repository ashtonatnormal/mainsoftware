// A loopback HTTP stand-in for Twilio Verify's v2 API, for auth/sms/twilio.ts's contract tests
// (TECH-SPEC T7, T20). It listens on 127.0.0.1 only, never reaches Twilio, and answers with
// Verify's own semantics, JSON and error bodies: one pending verification per number within its
// validity, send_code_attempts growing on each start, 60203 on a 6th send, 60202 on a 6th check,
// and 404 (20404) for an approved, cancelled or unknown verification. It checks Basic auth and
// form encoding, records every request, and lets a test script the next replies (a status and
// body, a delay, or a dropped connection). Tests only: the sms-provider guard keeps it there.
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeTwilioOp = 'start' | 'check' | 'cancel'

export interface FakeTwilioRequest {
  op: FakeTwilioOp | 'unknown'
  method: string
  path: string
  contentType: string | undefined
  // Whether the Authorization header held exactly the expected key SID and secret.
  authorised: boolean
  form: Record<string, string>
}

// A scripted reply for the next request of one operation.
export type Scripted =
  | { status: number; body: unknown; delayMs?: number }
  | { drop: true; delayMs?: number }
  | { redirect: string }
  | { status: number; raw: string }

interface Verification {
  sid: string
  to: string
  code: string
  createdAt: number
  sends: number
  checks: number
  status: 'pending' | 'approved' | 'canceled'
}

export interface FakeTwilio {
  baseUrl: string
  serviceSid: string
  apiKeySid: string
  apiKeySecret: string
  requests: FakeTwilioRequest[]
  // The codes it sent, in order.
  sent: { to: string; code: string; sid: string }[]
  // The next request of `op` gets `reply` instead of Verify's own answer.
  script(op: FakeTwilioOp, reply: Scripted): void
  // Makes a pending verification for `to`, as one Hearth didn't start would be.
  seed(to: string): string
  close(): Promise<void>
}

const VALIDITY_MS = 600_000
const MAX = 5

// Twilio's error body: code, message, more_info and status. The message quotes nothing real here.
function twilioError(status: number, code: number, message: string) {
  return { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status }
}

// SIDs and the key's secret are built at run time, so no file holds a credential's shape.
const hex = (bytes: number) => randomBytes(bytes).toString('hex')

export async function startFakeTwilio(): Promise<FakeTwilio> {
  const serviceSid = `VA${hex(16)}`
  const apiKeySid = `SK${hex(16)}`
  const apiKeySecret = randomBytes(24)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, 'a')
    .slice(0, 32)
  const expectedAuth = `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64')}`
  const verifications = new Map<string, Verification>()
  const scripts: Record<FakeTwilioOp, Scripted[]> = { start: [], check: [], cancel: [] }
  const requests: FakeTwilioRequest[] = []
  const sent: { to: string; code: string; sid: string }[] = []
  const prefix = `/v2/Services/${serviceSid}`

  const live = (v: Verification | undefined): v is Verification =>
    v !== undefined && v.status === 'pending' && Date.now() - v.createdAt < VALIDITY_MS

  const newVerification = (to: string): Verification => {
    const v: Verification = {
      sid: `VE${hex(16)}`,
      to,
      code: String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'),
      createdAt: Date.now(),
      sends: 0,
      checks: 0,
      status: 'pending',
    }
    verifications.set(v.sid, v)
    return v
  }

  const verificationJson = (v: Verification) => ({
    sid: v.sid,
    service_sid: serviceSid,
    account_sid: `AC${'0'.repeat(32)}`,
    to: v.to,
    channel: 'sms',
    status: v.status,
    valid: v.status === 'approved',
    send_code_attempts: Array.from({ length: v.sends }, (_, i) => ({ attempt_sid: `VL${i}`, channel: 'sms' })),
  })

  function answer(op: FakeTwilioOp, path: string, form: Record<string, string>): { status: number; body: unknown } {
    if (op === 'start') {
      if (form.Channel !== 'sms' || form.To === undefined) {
        return { status: 400, body: twilioError(400, 60200, 'Invalid parameter') }
      }
      let v = [...verifications.values()].find(x => x.to === form.To && live(x))
      v ??= newVerification(form.To)
      if (v.sends >= MAX) return { status: 429, body: twilioError(429, 60203, 'Max send attempts reached') }
      v.sends++
      sent.push({ to: v.to, code: v.code, sid: v.sid })
      return { status: 201, body: verificationJson(v) }
    }
    if (op === 'check') {
      const v = verifications.get(form.VerificationSid ?? '')
      if (!live(v)) return { status: 404, body: twilioError(404, 20404, 'The requested resource was not found') }
      if (v.checks >= MAX) return { status: 429, body: twilioError(429, 60202, 'Max check attempts reached') }
      v.checks++
      if (form.Code === v.code) v.status = 'approved'
      return { status: 200, body: { ...verificationJson(v), status: v.status === 'approved' ? 'approved' : 'pending' } }
    }
    const sid = decodeURIComponent(path.slice(`${prefix}/Verifications/`.length))
    const v = verifications.get(sid)
    if (!live(v) || form.Status !== 'canceled') {
      return { status: 404, body: twilioError(404, 20404, 'The requested resource was not found') }
    }
    v.status = 'canceled'
    return { status: 200, body: verificationJson(v) }
  }

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const path = request.url ?? ''
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
      const op: FakeTwilioOp | 'unknown' =
        path === `${prefix}/Verifications`
          ? 'start'
          : path === `${prefix}/VerificationCheck`
            ? 'check'
            : path.startsWith(`${prefix}/Verifications/`)
              ? 'cancel'
              : 'unknown'
      requests.push({
        op,
        method: request.method ?? '',
        path,
        contentType: request.headers['content-type'],
        authorised: request.headers.authorization === expectedAuth,
        form,
      })
      const send = (status: number, body: string) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(body)
      }
      if (request.method !== 'POST' || op === 'unknown') {
        send(404, JSON.stringify(twilioError(404, 20404, 'The requested resource was not found')))
        return
      }
      if (request.headers.authorization !== expectedAuth) {
        send(401, JSON.stringify(twilioError(401, 20003, 'Authenticate')))
        return
      }
      if (request.headers['content-type'] !== 'application/x-www-form-urlencoded') {
        send(400, JSON.stringify(twilioError(400, 60200, 'Invalid parameter')))
        return
      }
      const scripted = scripts[op].shift()
      const reply = () => {
        if (scripted === undefined) {
          const { status, body } = answer(op, path, form)
          send(status, JSON.stringify(body))
        } else if ('drop' in scripted) {
          request.socket.destroy()
        } else if ('redirect' in scripted) {
          response.writeHead(307, { location: scripted.redirect })
          response.end()
        } else if ('raw' in scripted) {
          send(scripted.status, scripted.raw)
        } else {
          send(scripted.status, JSON.stringify(scripted.body))
        }
      }
      const delayMs = scripted !== undefined && 'delayMs' in scripted ? (scripted.delayMs ?? 0) : 0
      if (delayMs > 0) setTimeout(reply, delayMs)
      else reply()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    serviceSid,
    apiKeySid,
    apiKeySecret,
    requests,
    sent,
    script: (op, reply) => {
      scripts[op].push(reply)
    },
    seed: to => {
      const v = newVerification(to)
      v.sends = 1
      return v.sid
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
