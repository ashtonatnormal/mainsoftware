// What every /api route shares (C0.5): parsing a body with a strict zod object, the request facts
// a service needs, and how a service's answer becomes a reply. Services return an Answer or throw
// an ApiError (auth/errors.ts); they never touch the reply themselves, so they can be tested
// without Fastify.
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { addCookie } from '#src/auth/cookies.ts'
import { ApiError, type ErrorCode } from '#src/auth/errors.ts'

// Bodies are JSON of at most 16 KiB.
export const BODY_LIMIT = 16_384

// A uuid as people's ids are stored: lower case, so comparing it with an id read from the
// database (say, whether an admin names themselves) never depends on how the client wrote it.
export const Uuid = z.uuid().transform(value => value.toLowerCase())

// A route that takes no input accepts no body or {}.
export const Empty = z.strictObject({})

// The body as the schema reads it, or a 400 with the route's code. The input is never echoed.
export function parse<T extends z.ZodType>(schema: T, body: unknown, code: ErrorCode = 'invalid_request'): z.output<T> {
  const parsed = schema.safeParse(body ?? {})
  if (!parsed.success) throw new ApiError(400, code)
  return parsed.data
}

// What a service needs to know about the request, and how it queues work for after the reply.
export interface ReqInfo {
  // The client's address: X-Forwarded-For only through the TRUST_PROXY list (app.ts).
  ip: string
  // A random uuid per request, never the client's (app.ts), for audit rows and logs.
  requestId: string
  userAgent: string | undefined
  log: FastifyBaseLogger
  // Runs task once the response has ended, sent or abandoned by the client; its errors are logged
  // (AfterResponse below).
  after(task: () => Promise<void>): void
}

// A service's answer: the body, the status (200 unless named) and any Set-Cookie values.
export interface Answer {
  status?: number
  body: unknown
  cookies?: readonly string[]
}

export function send(reply: FastifyReply, answer: Answer): FastifyReply {
  for (const cookie of answer.cookies ?? []) addCookie(reply, cookie)
  return reply.code(answer.status ?? 200).send(answer.body)
}

function userAgentOf(request: FastifyRequest): string | undefined {
  const header = request.headers['user-agent']
  return typeof header === 'string' ? header : undefined
}

export function requestInfo(api: { afterResponse: AfterResponse }, request: FastifyRequest): ReqInfo {
  return {
    ip: request.ip,
    requestId: request.id,
    userAgent: userAgentOf(request),
    log: request.log,
    after: task => api.afterResponse.add(request, task),
  }
}

// Work a handler queues to run once its response has ended: the roster lookup and text after a
// code request, an audit row after a failed code, a session's last-use time. The api scope starts
// a request's tasks when its response ends, sent or abandoned (api.ts), and runs them one after
// another; each failure is logged. A client that goes away before the reply doesn't stop them, so
// it can't keep a failed code out of the audit log (BUILD-PLAN C0.5: an audit event for every
// failure); it gets no reply to time, so running the work then tells it nothing. A task queued
// after the response has ended (the client left while the handler was still working) runs at
// once. idle() resolves once every started task has settled: the integration harness awaits it
// after each request, so what a test checks next doesn't race the work, and the api scope's
// onClose awaits it (for at most 5 s), so a SIGTERM lets a pending text or audit row finish.
export class AfterResponse {
  readonly #queued = new WeakMap<FastifyRequest, Array<() => Promise<void>>>()
  // Requests whose response has ended, and the last run of tasks each started, so a task queued
  // later still runs after the earlier ones.
  readonly #ended = new WeakMap<FastifyRequest, Promise<void>>()
  readonly #running = new Set<Promise<void>>()

  add(request: FastifyRequest, task: () => Promise<void>): void {
    const tasks = this.#queued.get(request)
    if (tasks === undefined) this.#queued.set(request, [task])
    else tasks.push(task)
    if (this.#ended.has(request)) this.start(request)
  }

  // Called when the response ends; calling it again starts only what was queued since.
  start(request: FastifyRequest): void {
    const previous = this.#ended.get(request) ?? Promise.resolve()
    const tasks = this.#queued.get(request)
    this.#queued.delete(request)
    if (tasks === undefined) {
      this.#ended.set(request, previous)
      return
    }
    const run = previous.then(async () => {
      for (const task of tasks) {
        try {
          await task()
        } catch (error) {
          request.log.error({ err: error, event: 'after_response_failed' }, 'work after the response failed')
        }
      }
    })
    this.#ended.set(request, run)
    this.#running.add(run)
    void run.finally(() => this.#running.delete(run))
  }

  async idle(): Promise<void> {
    // Lets a response that has just ended reach the api scope's hooks first.
    await new Promise<void>(resolve => setImmediate(resolve))
    while (this.#running.size > 0) await Promise.allSettled([...this.#running])
  }
}
