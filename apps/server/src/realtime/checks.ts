// The gateway's checks against Postgres (BUILD-PLAN C0.7, TECH-SPEC T19 items 6 and 8): one shape
// for every question realtime asks of the database about its sockets.
//   - checkOrg() answers, for one org in one read-only transaction acting as the org's system
//     principal, whether each socket's session is still live (and if not, when it ended), whether
//     the admission hook (C0.9) still admits each person with a live session, whether each person may
//     hold each topic now (packages/access, through loadTopicWorld and canTopics), and when the
//     change that took each lost topic's token was made (for the latency metric). It takes no row
//     lock and writes nothing, so it never holds the outbox's horizon and never joins the lock order.
//   - The periodic check (realtime/socket.ts, every 15 s, with its own connection) asks it of every
//     open socket. The decision lane (DecisionLane) asks it for subscribe decisions, accept-time
//     checks and targeted re-checks, batched per org every 20 ms, one transaction at a time. A lane
//     that fails closes nothing: its subscribes answer retry, its targeted checks are logged, and the
//     periodic check stays the guarantee (P8, M1).
//   - TargetedQueue coalesces the people a revocation names for 100 ms before their re-check goes
//     into the lane (§8.3).
// The subscriber's org and id always come from the socket's server-side session, never from a
// frame (GW-13). The realtime role writes nothing to Postgres (scripts/guards/realtime-readonly).
import { parseTopic } from '@hearth/shared'
import { sql } from 'kysely'
import type { Logger } from 'pino'
import { loadTopicWorld } from '#src/access/world.ts'
import { SESSION } from '#src/auth/policy.ts'
import { type Database, type InOrg, NoSystemPrincipal, withOrg } from '#src/db/database.ts'
import { failureFields } from '#src/db/sqlstate.ts'
import { GATEWAY_POLICY, type GatewayPolicy } from '#src/realtime/policy.ts'
import { decideTopics } from '#src/realtime/topics.ts'

// C0.9's acknowledgement gate (BP:155, PDPA-03): of these people, those who may use Hearth now.
// Asked inside the gateway's own read-only transaction as the org's system principal, so its read
// adds no connection: at accept (as a targeted check), in each subscribe batch and in each periodic
// check (T19 item 10, S9). Someone it no longer admits has every socket closed with 4403.
export interface Admission {
  admits(trx: InOrg, orgId: string, people: readonly string[]): Promise<ReadonlySet<string>>
}

// What one check asks about one org. Every map is keyed by person.
export interface CheckRequest {
  // The sessions to confirm.
  sessions: readonly string[]
  // The topics to decide for each person.
  topics?: ReadonlyMap<string, ReadonlySet<string>>
  // Of those, the ones already held (granted earlier): a refusal of one is a loss, whose start
  // time is read (lostAt).
  held?: ReadonlyMap<string, ReadonlySet<string>>
}

// A session that is live, with its person; or one that has ended, and when (epoch ms) if known, by
// its base rows (startSource 'database', revocation/latency.ts): a revoking transaction's now(), its
// start, or an expiry's or the idle limit's own time. A session the database doesn't return has
// ended at an unknown time.
export type SessionCheck = { live: true; person: string } | { live: false; endedAt: number | undefined }

export interface CheckResult {
  sessions: ReadonlyMap<string, SessionCheck>
  // People with a live session whom the admission hook refused: nothing is decided for them.
  notAdmitted: ReadonlySet<string>
  // For each person decided (a live session, admitted): each topic asked, and whether it is allowed.
  topics: ReadonlyMap<string, ReadonlyMap<string, boolean>>
  // For each person: each held topic now refused, and the earliest time the base rows give for the
  // change that took its token (epoch ms; the revoking transaction's now(), its start), or undefined
  // if unknown.
  lostAt: ReadonlyMap<string, ReadonlyMap<string, number | undefined>>
}

// One org's check, in a transaction of its own (orgChecker in production; a fake in unit tests).
export type CheckOrg = (orgId: string, request: CheckRequest) => Promise<CheckResult>

const ms = (time: Date | null): number | undefined => (time === null ? undefined : time.getTime())

function inner<K, V>(outer: Map<string, Map<K, V>>, key: string): Map<K, V> {
  let map = outer.get(key)
  if (map === undefined) {
    map = new Map()
    outer.set(key, map)
  }
  return map
}

export async function checkOrg(
  trx: InOrg,
  orgId: string,
  request: CheckRequest,
  options: { admission?: Admission | undefined; idle?: string } = {},
): Promise<CheckResult> {
  const idle = options.idle ?? SESSION.idle
  const ids = [...new Set(request.sessions)]
  const sessions = new Map<string, SessionCheck>()
  const live = new Set<string>()
  if (ids.length > 0) {
    // The rules of session_by_token (0006) and the api's acting-session re-read: not revoked, not
    // expired, used within the idle limit, on a device still signed in, of a person who hasn't left.
    // ended_at is the earliest of the times that ended it, by Postgres's clock (m3): a revocation's,
    // sign-out's or deactivation's is its transaction's now(), which comes before that transaction's
    // commit by however long it ran (T19 item 13).
    const { rows } = await sql<{ id: string; user_id: string; live: boolean; ended_at: Date | null }>`
      select s.id, s.user_id,
        (s.revoked_at is null and s.expires_at > now() and s.last_seen_at > now() - ${idle}::interval
          and d.signed_out_at is null and p.deactivated_at is null) as live,
        least(s.revoked_at, d.signed_out_at, p.deactivated_at,
          case when s.expires_at <= now() then s.expires_at end,
          case when s.last_seen_at <= now() - ${idle}::interval then s.last_seen_at + ${idle}::interval end) as ended_at
      from sessions s
      join devices d on d.org_id = s.org_id and d.user_id = s.user_id and d.id = s.device_id
      join people p on p.org_id = s.org_id and p.id = s.user_id
      where s.org_id = ${orgId} and s.id = any(${ids}::uuid[])`.execute(trx)
    for (const row of rows) {
      if (row.live) {
        sessions.set(row.id, { live: true, person: row.user_id })
        live.add(row.user_id)
      } else {
        sessions.set(row.id, { live: false, endedAt: ms(row.ended_at) })
      }
    }
  }
  for (const id of ids) if (!sessions.has(id)) sessions.set(id, { live: false, endedAt: undefined })

  let admitted: ReadonlySet<string> = live
  const notAdmitted = new Set<string>()
  if (options.admission !== undefined && live.size > 0) {
    const yes = await options.admission.admits(trx, orgId, [...live])
    admitted = new Set([...live].filter(person => yes.has(person)))
    for (const person of live) if (!admitted.has(person)) notAdmitted.add(person)
  }

  const topics = new Map<string, Map<string, boolean>>()
  const people = [...(request.topics?.keys() ?? [])].filter(person => admitted.has(person))
  if (people.length > 0) {
    const world = await loadTopicWorld(trx, orgId, people)
    for (const person of people) {
      topics.set(person, decideTopics(world, person, request.topics?.get(person) ?? []))
    }
  }

  const lostAt = new Map<string, Map<string, number | undefined>>()
  const lost: { person: string; topic: string; team: string | null }[] = []
  for (const person of people) {
    for (const topic of request.held?.get(person) ?? []) {
      if (topics.get(person)?.get(topic) !== false) continue
      const parsed = parseTopic(topic)
      if (parsed === undefined) continue
      lost.push({ person, topic, team: parsed.kind === 'team' ? parsed.id : null })
      inner(lostAt, person).set(topic, undefined)
    }
  }
  if (lost.length > 0) {
    // When the change that took each lost topic's token was made (m3): a person or org topic's is the
    // deactivation's; a team topic's the earlier of the deactivation's and, when no membership of
    // the team is active, the last removal's. Each is its transaction's now(), which comes before
    // its commit, when the token went, by however long it ran (T19 item 13). least() skips nulls,
    // so the answer is the earliest cause; null is an unknown start.
    const { rows } = await sql<{ person: string; topic: string; lost_at: Date | null }>`
      select x.person, x.topic,
        least(p.deactivated_at,
          case when x.team is not null and not exists (
                 select 1 from team_memberships a
                 where a.org_id = ${orgId} and a.person_id = x.person and a.team_id = x.team and a.removed_at is null)
               then (select max(m.removed_at) from team_memberships m
                     where m.org_id = ${orgId} and m.person_id = x.person and m.team_id = x.team)
          end) as lost_at
      from unnest(${lost.map(l => l.person)}::uuid[], ${lost.map(l => l.topic)}::text[],
                  ${lost.map(l => l.team)}::uuid[]) as x(person, topic, team)
      join people p on p.org_id = ${orgId} and p.id = x.person`.execute(trx)
    for (const row of rows) inner(lostAt, row.person).set(row.topic, ms(row.lost_at))
  }

  return { sessions, notAdmitted, topics, lostAt }
}

// checkOrg in a transaction of its own for the org: read only, acting as the org's system principal,
// with a transaction_timeout of recheckTransactionTimeout (10 s). An org with no system principal
// throws NoSystemPrincipal.
export function orgChecker(
  db: Database,
  options: { admission?: Admission | undefined; policy?: GatewayPolicy; idle?: string } = {},
): CheckOrg {
  const policy = options.policy ?? GATEWAY_POLICY
  return (orgId, request) =>
    withOrg(db, { orgId, system: true }, trx => checkOrg(trx, orgId, request, options), {
      readOnly: true,
      transactionTimeout: policy.recheckTransactionTimeout,
    })
}

function union(into: Map<string, Set<string>>, from: ReadonlyMap<string, ReadonlySet<string>> | undefined): void {
  for (const [key, values] of from ?? []) {
    const set = into.get(key) ?? new Set<string>()
    for (const value of values) set.add(value)
    into.set(key, set)
  }
}

// The requests of one batch, asked as one.
export function mergeRequests(requests: readonly CheckRequest[]): CheckRequest {
  const topics = new Map<string, Set<string>>()
  const held = new Map<string, Set<string>>()
  for (const request of requests) {
    union(topics, request.topics)
    union(held, request.held)
  }
  return { sessions: [...new Set(requests.flatMap(request => request.sessions))], topics, held }
}

// The work, or a rejection once ms have passed. Work that settles later is still handled here, so
// its rejection is never unhandled.
export function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms))
  })
  return Promise.race([work, timedOut]).finally(() => clearTimeout(timer))
}

interface Ask {
  request: CheckRequest
  weight: number
  resolve: (result: CheckResult) => void
  reject: (error: unknown) => void
}

type LanePolicy = Pick<GatewayPolicy, 'decisionBatchMs' | 'decisionBatchMax' | 'recheckTimeoutMs'>

// The decision lane (T19 item 8): subscribe decisions, accept-time checks and targeted re-checks
// share it. It collects asks for decisionBatchMs (20 ms), or until they name decisionBatchMax (500)
// sessions, then asks each org once, one transaction at a time (the realtime pool keeps one
// connection for it). Each ask is answered with its batch's whole result, from which it reads its
// own sessions and topics. A batch that fails, or hasn't answered within recheckTimeoutMs, rejects
// every ask in it, and the lane moves on: a lane failure closes nothing (P8).
export class DecisionLane {
  readonly #check: CheckOrg
  readonly #policy: LanePolicy
  readonly #logger: Pick<Logger, 'warn' | 'error'>
  readonly #pending = new Map<string, Ask[]>()
  #weight = 0
  #timer: NodeJS.Timeout | undefined
  #running = false
  #stopped = false
  // Failed batches in a row, cleared by a successful one.
  #failures = 0

  constructor(options: { check: CheckOrg; policy?: LanePolicy; logger: Pick<Logger, 'warn' | 'error'> }) {
    this.#check = options.check
    this.#policy = options.policy ?? GATEWAY_POLICY
    this.#logger = options.logger
  }

  decide(orgId: string, request: CheckRequest): Promise<CheckResult> {
    if (this.#stopped) return Promise.reject(new Error('the gateway is stopping'))
    return new Promise((resolve, reject) => {
      const ask: Ask = { request, weight: Math.max(1, new Set(request.sessions).size), resolve, reject }
      const asks = this.#pending.get(orgId)
      if (asks === undefined) this.#pending.set(orgId, [ask])
      else asks.push(ask)
      this.#weight += ask.weight
      if (this.#running) return
      if (this.#weight >= this.#policy.decisionBatchMax) {
        clearTimeout(this.#timer)
        this.#timer = undefined
        void this.#run()
      } else {
        this.#timer ??= setTimeout(
          () => {
            this.#timer = undefined
            void this.#run()
          },
          Math.max(1, this.#policy.decisionBatchMs),
        )
      }
    })
  }

  // Sessions waiting for a decision (the gauges' decisionsWaiting).
  waiting(): number {
    return this.#weight
  }

  // Refuses whatever is still waiting; a batch in flight answers as it would.
  stop(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
    this.#timer = undefined
    const error = new Error('the gateway is stopping')
    for (const asks of this.#pending.values()) for (const ask of asks) ask.reject(error)
    this.#pending.clear()
    this.#weight = 0
  }

  async #run(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      for (let next = this.#pending.entries().next(); !next.done; next = this.#pending.entries().next()) {
        const [orgId, asks] = next.value
        const batch: Ask[] = []
        let weight = 0
        for (let ask = asks[0]; ask !== undefined; ask = asks[0]) {
          if (batch.length > 0 && weight + ask.weight > this.#policy.decisionBatchMax) break
          asks.shift()
          batch.push(ask)
          weight += ask.weight
        }
        if (asks.length === 0) this.#pending.delete(orgId)
        this.#weight -= weight
        let result: CheckResult
        try {
          const asked = this.#check(orgId, mergeRequests(batch.map(ask => ask.request)))
          result = await withDeadline(asked, this.#policy.recheckTimeoutMs, 'the decision timed out')
          this.#failures = 0
        } catch (error) {
          this.#failures++
          const fields = {
            event: 'ws_decide_failed',
            org: orgId,
            sessions: weight,
            failures: this.#failures,
            ...(error instanceof NoSystemPrincipal ? { reason: 'no_system_principal' } : {}),
            failure: failureFields(error),
          }
          if (this.#failures >= 3) this.#logger.error(fields, 'the gateway keeps failing to decide')
          else this.#logger.warn(fields, 'the gateway could not decide')
          for (const ask of batch) ask.reject(error)
          continue
        }
        for (const ask of batch) ask.resolve(result)
      }
    } finally {
      this.#running = false
    }
  }
}

// Coalesces the people whose access a revocation may have changed (§8.3): each (org, person) is
// queued with the label of its first trigger, unless a later one is preferred (the gateway prefers
// a people signal's to a plain re-check's, so the signal's drops carry its path), and after
// delayMs (100 ms) every org's people are handed on in chunks of at most max (500), for a
// re-check in the lane.
export class TargetedQueue<L> {
  readonly #due: (orgId: string, people: ReadonlyMap<string, L>) => void
  readonly #delayMs: number
  readonly #max: number
  readonly #prefer: (kept: L, next: L) => boolean
  #pending = new Map<string, Map<string, L>>()
  #timer: NodeJS.Timeout | undefined
  #stopped = false

  constructor(
    due: (orgId: string, people: ReadonlyMap<string, L>) => void,
    options: { delayMs?: number; max?: number; prefer?: (kept: L, next: L) => boolean } = {},
  ) {
    this.#due = due
    this.#delayMs = options.delayMs ?? GATEWAY_POLICY.targetedDelayMs
    this.#max = options.max ?? GATEWAY_POLICY.decisionBatchMax
    this.#prefer = options.prefer ?? (() => false)
  }

  queue(orgId: string, person: string, label: L): void {
    if (this.#stopped) return
    const people = inner(this.#pending, orgId)
    if (!people.has(person) || this.#prefer(people.get(person) as L, label)) people.set(person, label)
    if (this.#timer === undefined) {
      this.#timer = setTimeout(() => this.#fire(), Math.max(1, this.#delayMs))
      this.#timer.unref()
    }
  }

  // People waiting for their re-check.
  size(): number {
    let size = 0
    for (const people of this.#pending.values()) size += people.size
    return size
  }

  stop(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#pending.clear()
  }

  #fire(): void {
    this.#timer = undefined
    const pending = this.#pending
    this.#pending = new Map()
    for (const [orgId, people] of pending) {
      const all = [...people]
      for (let start = 0; start < all.length; start += this.#max) {
        this.#due(orgId, new Map(all.slice(start, start + this.#max)))
      }
    }
  }
}
