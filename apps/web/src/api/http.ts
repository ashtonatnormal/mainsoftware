// The web app's one way to the api (T21 item 3, D-01). Every request:
// - names a relative /api path from ApiPath, so it can only reach this page's own origin, where
//   the server's Origin check and the session cookie work (OD-11: CloudFront sends /api to the
//   ALB on the same host);
// - sends the session cookie (credentials same-origin) and is never cached (no-store); the
//   browser adds the Origin header to a POST by itself;
// - refuses to follow a redirect, since no /api answer redirects and following one could leave
//   the origin;
// - reads a 2xx body with the caller's schema, and a refusal leniently (ApiErrorBody, and the
//   extras through ErrorExtrasSchema), so a field the server adds later breaks nothing.
// Every failure is an ApiFailure: the server's code and British message, or a code of the
// client's own (network, invalid_response, halted) with copy from strings/api.ts.
//
// haltRequests() is step 2 of the session runtime's end() (session/runtime.ts): from then on
// every call rejects with halted and sends nothing, and an answer that arrives later is dropped.
// So once a session is ending nothing reaches the server, and a refetch can't carry the next
// person's cookie into this document. The latch is module state: it lives exactly as long as the
// document (D-01).
//
// scripts/guards/web-source.test.ts (WS-03) keeps fetch in this file alone.
import { ApiErrorBody, type ErrorExtras, ErrorExtrasSchema, MESSAGES } from '@hearth/shared'
import type { z } from 'zod'
import { API_COPY } from '@/strings/api.ts'

export type ApiPath =
  | '/api/session'
  | '/api/flags'
  | '/api/auth/otp/request'
  | '/api/auth/otp/verify'
  | '/api/auth/pin/set'
  | '/api/auth/pin/verify'
  | '/api/auth/sign-out'
  // Re-authenticating with the PIN, inline on the DPO pages until C0.16's sheet (C0.9 PD-26).
  | '/api/auth/reauth/pin'
  // The registers (C0.9 PD-20, dpo/queries.ts).
  | '/api/admin/registers'
  | '/api/admin/registers/purposes/set'
  | '/api/admin/registers/transfers/record'
  | '/api/admin/registers/transfers/clear'
  | '/api/admin/registers/transfers/withdraw'

// The client's own codes, for failures the server didn't name.
export type ClientFailureCode = 'network' | 'invalid_response' | 'halted'

export class ApiFailure extends Error {
  override name = 'ApiFailure'
  // The HTTP status, or 0 when no answer arrived (network, halted).
  readonly status: number
  // The server's `error` (an ErrorCode from @hearth/shared, or a bare 'Not Found' or 'Forbidden'
  // from a not-found handler or the Origin hook), or a ClientFailureCode.
  readonly code: string
  // The server's message; else MESSAGES' copy for a code it knows; else generic copy.
  readonly serverMessage: string
  // retryAfterSeconds, triesLeft, pin and method, each only when it was sent and reads.
  readonly extra: Readonly<ErrorExtras>

  constructor(status: number, code: string, serverMessage: string, extra: ErrorExtras = {}) {
    super(code)
    this.status = status
    this.code = code
    this.serverMessage = serverMessage
    this.extra = Object.freeze({ ...extra })
  }
}

export interface RequestOptions {
  // The fetch to use; the browser's own when absent.
  fetch?: typeof fetch
  // Ends the request early: Query's cancellation, the boot's 15 s limit (boot/load-session.ts,
  // T21 item 5), sign-in's 20 s limit (AbortSignal.timeout, T21 item 13) or sign-out's
  // (session/runtime.ts). An ended request reads as network.
  signal?: AbortSignal
}

// A path the server routes under /api: lower-case segments, no query, no dots, no second slash.
const API_PATH = /^\/api(?:\/[a-z0-9-]+)+$/

let halted = false

export function haltRequests(): void {
  halted = true
}

const haltedFailure = () => new ApiFailure(0, 'halted', MESSAGES.internal)
const networkFailure = () => new ApiFailure(0, 'network', API_COPY.network)
const unreadable = (status: number) => new ApiFailure(status, 'invalid_response', MESSAGES.internal)

// The copy for a refusal: the server's own, else MESSAGES' for a code it lists, else generic.
function messageFor(code: string, message: string | undefined): string {
  if (message !== undefined && message !== '') return message
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code as keyof typeof MESSAGES] : MESSAGES.internal
}

async function failureOf(response: Response): Promise<ApiFailure> {
  let json: unknown
  try {
    json = await response.json()
  } catch {
    return unreadable(response.status)
  }
  const body = ApiErrorBody.safeParse(json)
  if (!body.success) return unreadable(response.status)
  const extras = ErrorExtrasSchema.safeParse(json)
  return new ApiFailure(
    response.status,
    body.data.error,
    messageFor(body.data.error, body.data.message),
    extras.success ? withoutUndefined(extras.data) : {},
  )
}

// The extras that were sent and read, without the keys the lenient schema set to undefined.
function withoutUndefined(extras: ErrorExtras): ErrorExtras {
  return Object.fromEntries(Object.entries(extras).filter(([, value]) => value !== undefined)) as ErrorExtras
}

async function request<T>(
  path: ApiPath,
  init: { method: 'GET' | 'POST'; body?: string },
  schema: z.ZodType<T> | undefined,
  options: RequestOptions,
): Promise<T | undefined> {
  if (halted) throw haltedFailure()
  if (!API_PATH.test(path)) throw new Error(`Not an api path: ${path}`)
  const send = options.fetch ?? fetch
  let response: Response
  try {
    response = await send(path, {
      method: init.method,
      headers:
        init.body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      body: init.body,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: options.signal,
    })
  } catch {
    throw halted ? haltedFailure() : networkFailure()
  }
  // An answer that lands after the halt belongs to a session that is ending: drop it, whether the
  // halt came before its headers or while its body was read.
  if (halted) throw haltedFailure()
  if (!response.ok) {
    const failure = await failureOf(response)
    if (halted) throw haltedFailure()
    // A refusal whose body couldn't be read because the request was ended reads as network, as an
    // ended request does everywhere else here.
    if (failure.code === 'invalid_response' && options.signal?.aborted) throw networkFailure()
    throw failure
  }
  if (schema === undefined) return undefined
  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw options.signal?.aborted ? networkFailure() : unreadable(response.status)
  }
  if (halted) throw haltedFailure()
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw unreadable(response.status)
  return parsed.data
}

// GET a path and read its 2xx body with the schema.
export async function apiGet<T>(path: ApiPath, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
  return (await request(path, { method: 'GET' }, schema, options)) as T
}

// POST a JSON body. With a schema, the 2xx body is read with it; without one, the answer's body is
// not read and the call resolves to undefined.
export async function apiPost<T = undefined>(
  path: ApiPath,
  body: unknown,
  schema?: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T | undefined> {
  return request(path, { method: 'POST', body: JSON.stringify(body ?? {}) }, schema, options)
}
