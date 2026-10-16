import { setTimeout as delay } from 'node:timers/promises'
import { GATEWAY_CLOSE } from '@hearth/shared'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { loadTopicWorld } from '#src/access/world.ts'
import { NoSystemPrincipal, withOrg } from '#src/db/database.ts'
import {
  type Admission,
  type CheckOrg,
  type CheckRequest,
  type CheckResult,
  checkOrg,
  DecisionLane,
  mergeRequests,
  orgChecker,
  TargetedQueue,
} from '#src/realtime/checks.ts'
import { RevocationLatency } from '#src/revocation/latency.ts'
import {
  connected,
  type FakeChecks,
  known,
  ORG,
  OTHER_TEAM,
  orgTopic,
  personTopic,
  startGateway,
  TEAM,
  teamTopic,
  until,
} from '#src/testing/gateway.ts'
import { captureLogger } from '#src/testing/logs.ts'
import { pgError, type Statement, scriptedPool, systemPrincipal } from '#src/testing/pool.ts'

const SYSTEM = 'c0000000-0000-4000-8000-0000000000ff'
const A = known(1)
const B = known(2)
const ME = A.session.userId
const YOU = B.session.userId
const ENDED_AT = new Date('2026-10-16T01:00:00Z')
const REMOVED_AT = new Date('2026-10-16T00:30:00Z')
const JOINED_AT = new Date('2026-10-15T00:00:00Z')

const is = (prefix: string) => (statement: Statement) => statement.text.startsWith(prefix)
const isSessions = is('select s.id, s.user_id,')
const isPeople = is('select id, deactivated_at from people')
const isMembers = is('select team_id, person_id, removed_at from team_memberships')
const isRoles = is('select person_id, role, team_id, revoked_at from role_assignments')
const isTeams = is('select id, archived_at from teams')
const isLost = is('select x.person, x.topic,')
const isEras = is('select person_id, team_id, created_at from team_memberships')

// The org as the checks read it: A's session live, B's ended at ENDED_AT; A in TEAM, B in nothing
// any more (removed at REMOVED_AT); both on the roster.
function org(overrides: (statement: Statement) => unknown[] | undefined = () => undefined) {
  return scriptedPool(statement => {
    const answer = overrides(statement)
    if (answer !== undefined) return answer
    if (isSessions(statement)) {
      const ids = statement.values.find(Array.isArray) as string[]
      return [
        { id: A.session.sessionId, user_id: ME, live: true, ended_at: null },
        { id: B.session.sessionId, user_id: YOU, live: false, ended_at: ENDED_AT },
      ].filter(row => ids.includes(row.id))
    }
    if (isPeople(statement)) {
      return [
        { id: ME, deactivated_at: null },
        { id: YOU, deactivated_at: null },
      ]
    }
    if (isMembers(statement)) return [{ team_id: TEAM, person_id: ME, removed_at: null }]
    if (isRoles(statement)) return []
    if (isTeams(statement)) {
      return [
        { id: TEAM, archived_at: null },
        { id: OTHER_TEAM, archived_at: null },
      ]
    }
    if (isLost(statement)) {
      const [people, topics] = statement.values.filter(Array.isArray) as string[][]
      return (people ?? []).map((person, at) => ({ person, topic: topics?.[at], lost_at: REMOVED_AT }))
    }
    if (isEras(statement)) return [{ person_id: ME, team_id: TEAM, created_at: JOINED_AT }]
    return systemPrincipal(SYSTEM)(statement)
  })
}

const asked = (entries: [string, string[]][]) => new Map(entries.map(([person, topics]) => [person, new Set(topics)]))

describe('C0.7 T19 item 8: checkOrg, one read-only transaction as the org’s system principal', () => {
  it('T19 item 8 m5: reads only, as the system principal, with a 10 s transaction_timeout and no row lock', async () => {
    const pool = org()
    await orgChecker(pool.db)(ORG, { sessions: [A.session.sessionId] })
    const texts = pool.texts()
    expect(texts[0]).toBe('start transaction isolation level read committed read only')
    expect(texts[1]).toContain("set_config('transaction_timeout', '10s', true)")
    expect(pool.statements.find(s => s.text.startsWith("select set_config('app.user_id'"))?.values).toEqual([SYSTEM])
    expect(texts.at(-1)).toBe('commit')
    for (const text of texts) {
      expect(text).not.toMatch(/for (share|update|no key update)/)
      expect(text).not.toMatch(/^(insert|update|delete|merge)/)
    }
  })

  it('T19 item 8 S1 m3: a session’s rules are session_by_token’s, ended_at is the earliest of what ended it, and a session the database doesn’t return has ended at an unknown time', async () => {
    const pool = org()
    const gone = 'b0000000-0000-4000-8000-0000000000ef'
    const result = await withOrg(pool.db, { orgId: ORG, system: true }, trx =>
      checkOrg(trx, ORG, { sessions: [A.session.sessionId, B.session.sessionId, gone] }),
    )
    expect(result.sessions).toEqual(
      new Map([
        [A.session.sessionId, { live: true, person: ME }],
        [B.session.sessionId, { live: false, endedAt: ENDED_AT.getTime() }],
        [gone, { live: false, endedAt: undefined }],
      ]),
    )
    const query = pool.statements.find(isSessions)
    expect(query?.values).toEqual([
      '30 days',
      '30 days',
      '30 days',
      ORG,
      [A.session.sessionId, B.session.sessionId, gone],
    ])
    for (const rule of [
      's.revoked_at is null and s.expires_at > now() and s.last_seen_at > now() - $1::interval',
      'd.signed_out_at is null and p.deactivated_at is null) as live',
      'least(s.revoked_at, d.signed_out_at, p.deactivated_at,',
      'case when s.expires_at <= now() then s.expires_at end',
      'case when s.last_seen_at <= now() - $2::interval then s.last_seen_at + $3::interval end) as ended_at',
      'where s.org_id = $4 and s.id = any($5::uuid[])',
    ]) {
      expect(query?.text).toContain(rule)
    }
    // Nothing else is read when no topic is asked.
    expect(pool.statements.filter(s => isPeople(s) || isLost(s) || isEras(s))).toEqual([])
  })

  it('T19 item 7 §7.3: loadTopicWorld reads the listed people’s rows, live memberships and role rows, and every team, in the org', async () => {
    const pool = org()
    await withOrg(pool.db, { orgId: ORG, system: true }, trx => loadTopicWorld(trx, ORG, [ME, YOU, ME]))
    const read = pool.statements.filter(s => isPeople(s) || isMembers(s) || isRoles(s) || isTeams(s))
    expect(read.map(s => [s.text, s.values])).toEqual([
      ['select id, deactivated_at from people where org_id = $1 and id = any($2::uuid[])', [ORG, [ME, YOU]]],
      [
        'select team_id, person_id, removed_at from team_memberships where org_id = $1 and person_id = any($2::uuid[]) and removed_at is null',
        [ORG, [ME, YOU]],
      ],
      [
        'select person_id, role, team_id, revoked_at from role_assignments where org_id = $1 and person_id = any($2::uuid[]) and revoked_at is null',
        [ORG, [ME, YOU]],
      ],
      ['select id, archived_at from teams where org_id = $1', [ORG]],
    ])
  })

  it('GW-04 GW-05 PRD-108: each live person’s topics are decided by can(): their own, the org’s and their team’s are allowed; another’s, a team they left and an unknown one are refused alike', async () => {
    const pool = org()
    const result = await withOrg(pool.db, { orgId: ORG, system: true }, trx =>
      checkOrg(trx, ORG, {
        sessions: [A.session.sessionId, B.session.sessionId],
        topics: asked([
          [ME, [personTopic(1), orgTopic(), teamTopic(TEAM), personTopic(2), teamTopic(OTHER_TEAM), 'team:nope']],
          [YOU, [personTopic(2)]],
        ]),
      }),
    )
    expect(result.topics).toEqual(
      new Map([
        [
          ME,
          new Map([
            [personTopic(1), true],
            [orgTopic(), true],
            [teamTopic(TEAM), true],
            [personTopic(2), false],
            [teamTopic(OTHER_TEAM), false],
            ['team:nope', false],
          ]),
        ],
      ]),
    )
    // B's session has ended, so nothing is decided for B: their sockets close instead.
    expect(result.topics.has(YOU)).toBe(false)
    // Only the people decided are loaded.
    expect(pool.statements.find(isPeople)?.values).toEqual([ORG, [ME]])
  })

  it('m3 T19 item 13: a held topic now refused gets the earliest time its token has been absent, from least() over the deactivation and the last removal', async () => {
    const pool = org()
    const result = await withOrg(pool.db, { orgId: ORG, system: true }, trx =>
      checkOrg(trx, ORG, {
        sessions: [A.session.sessionId],
        topics: asked([[ME, [teamTopic(TEAM), teamTopic(OTHER_TEAM), personTopic(2)]]]),
        held: asked([[ME, [teamTopic(OTHER_TEAM), personTopic(2), teamTopic(TEAM)]]]),
      }),
    )
    // Only the refused held topics are asked about, team ids alongside (null for a person topic).
    const lost = pool.statements.find(isLost)
    expect(lost?.values.filter(Array.isArray)).toEqual([
      [ME, ME],
      [teamTopic(OTHER_TEAM), personTopic(2)],
      [OTHER_TEAM, null],
    ])
    for (const part of [
      'least(p.deactivated_at, case when x.team is not null and not exists (',
      'a.person_id = x.person and a.team_id = x.team and a.removed_at is null)',
      'then (select max(m.removed_at) from team_memberships m',
      'from unnest($3::uuid[], $4::text[], $5::uuid[]) as x(person, topic, team)',
      'join people p on p.org_id = $6 and p.id = x.person',
    ]) {
      expect(lost?.text).toContain(part)
    }
    expect(result.lostAt).toEqual(
      new Map([
        [
          ME,
          new Map([
            [teamTopic(OTHER_TEAM), REMOVED_AT.getTime()],
            [personTopic(2), REMOVED_AT.getTime()],
          ]),
        ],
      ]),
    )
  })

  it('GW-09 trace fix: the era read runs only for allowed team topics of a sub with since', async () => {
    const withSince = org()
    const result = await withOrg(withSince.db, { orgId: ORG, system: true }, trx =>
      checkOrg(trx, ORG, {
        sessions: [A.session.sessionId],
        topics: asked([[ME, [teamTopic(TEAM), teamTopic(OTHER_TEAM), personTopic(1)]]]),
        eras: asked([[ME, [teamTopic(TEAM), teamTopic(OTHER_TEAM), personTopic(1)]]]),
      }),
    )
    const eras = withSince.statements.filter(isEras)
    expect(eras.map(s => s.values)).toEqual([[ORG, [ME], [TEAM]]])
    expect(eras[0]?.text).toBe(
      'select person_id, team_id, created_at from team_memberships where org_id = $1 and removed_at is null and person_id = any($2::uuid[]) and team_id = any($3::uuid[])',
    )
    expect(result.eras).toEqual(new Map([[ME, new Map([[teamTopic(TEAM), JOINED_AT.getTime()]])]]))
    const without = org()
    await withOrg(without.db, { orgId: ORG, system: true }, trx =>
      checkOrg(trx, ORG, { sessions: [A.session.sessionId], topics: asked([[ME, [teamTopic(TEAM)]]]) }),
    )
    expect(without.statements.filter(isEras)).toEqual([])
  })

  it('S9 C0.9: with an admission hook, it is asked about the people with a live session inside the same transaction, and nothing is decided for those refused; with none, nothing is asked', async () => {
    const pool = org()
    const admits = vi.fn<Admission['admits']>(async () => new Set<string>())
    const result = await orgChecker(pool.db, { admission: { admits } })(ORG, {
      sessions: [A.session.sessionId, B.session.sessionId],
      topics: asked([[ME, [personTopic(1)]]]),
    })
    expect(admits).toHaveBeenCalledWith(expect.anything(), ORG, [ME])
    expect(result.notAdmitted).toEqual(new Set([ME]))
    expect(result.topics).toEqual(new Map())
    expect(pool.statements.filter(isPeople)).toEqual([])
    const plain = org()
    const allowed = await orgChecker(plain.db)(ORG, {
      sessions: [A.session.sessionId],
      topics: asked([[ME, [personTopic(1)]]]),
    })
    expect(allowed.notAdmitted).toEqual(new Set())
    expect(allowed.topics.get(ME)).toEqual(new Map([[personTopic(1), true]]))
  })

  it('OD-37: an org with no system principal throws NoSystemPrincipal, and any other failure is thrown as it is', async () => {
    const none = org(statement => (statement.text.includes("kind = 'system'") ? [] : undefined))
    await expect(orgChecker(none.db)(ORG, { sessions: [A.session.sessionId] })).rejects.toBeInstanceOf(
      NoSystemPrincipal,
    )
    const failing = org(statement => (isSessions(statement) ? (pgError('57P01') as never) : undefined))
    await expect(orgChecker(failing.db)(ORG, { sessions: [A.session.sessionId] })).rejects.toMatchObject({
      code: '57P01',
    })
  })
})

describe('C0.7 T19 item 8: the decision lane and the targeted queue', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const empty = (): CheckResult => ({
    sessions: new Map(),
    notAdmitted: new Set(),
    topics: new Map(),
    lostAt: new Map(),
    eras: new Map(),
  })

  it('T19 item 8: asks within 20 ms become one check per org, their requests merged', async () => {
    vi.useFakeTimers()
    const check = vi.fn(async (_orgId: string, _request: CheckRequest) => empty())
    const lane = new DecisionLane({ check, logger: { warn: vi.fn(), error: vi.fn() } })
    const asks = [
      lane.decide(ORG, { sessions: ['s1'], topics: asked([[ME, [personTopic(1)]]]) }),
      lane.decide(ORG, {
        sessions: ['s2', 's1'],
        topics: asked([[ME, [orgTopic()]]]),
        held: asked([[ME, [orgTopic()]]]),
      }),
      lane.decide('a0000000-0000-4000-8000-000000000009', { sessions: ['s3'] }),
    ]
    expect(lane.waiting()).toBe(4)
    await vi.advanceTimersByTimeAsync(19)
    expect(check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all(asks)
    expect(check).toHaveBeenCalledTimes(2)
    expect(check.mock.calls[0]).toEqual([
      ORG,
      {
        sessions: ['s1', 's2'],
        topics: asked([[ME, [personTopic(1), orgTopic()]]]),
        held: asked([[ME, [orgTopic()]]]),
        eras: new Map(),
      },
    ])
    expect(lane.waiting()).toBe(0)
  })

  it('T19 item 8: 500 sessions waiting are decided at once, and a batch never names more than 500', async () => {
    vi.useFakeTimers()
    const check = vi.fn(async (_orgId: string, _request: CheckRequest) => empty())
    const lane = new DecisionLane({ check, logger: { warn: vi.fn(), error: vi.fn() } })
    const asks = Array.from({ length: 600 }, (_, i) => lane.decide(ORG, { sessions: [`s${i}`] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(check).toHaveBeenCalledTimes(2)
    await Promise.all(asks)
    expect(check.mock.calls.map(([, request]) => request.sessions.length)).toEqual([500, 100])
  })

  it('P8: a batch that fails, or doesn’t answer in time, rejects every ask in it, logs, and the lane moves on', async () => {
    const { logger, events } = captureLogger('realtime')
    let answer: 'fail' | 'hang' | 'ok' = 'fail'
    const check = vi.fn(async (): Promise<CheckResult> => {
      if (answer === 'fail') throw new NoSystemPrincipal()
      if (answer === 'hang') return new Promise(() => {})
      return empty()
    })
    const lane = new DecisionLane({
      check,
      logger,
      policy: { decisionBatchMs: 1, decisionBatchMax: 500, recheckTimeoutMs: 50 },
    })
    await expect(lane.decide(ORG, { sessions: ['s1'] })).rejects.toBeInstanceOf(NoSystemPrincipal)
    answer = 'hang'
    await expect(lane.decide(ORG, { sessions: ['s1'] })).rejects.toThrow(/timed out/)
    answer = 'ok'
    await expect(lane.decide(ORG, { sessions: ['s1'] })).resolves.toEqual(empty())
    expect(events('ws_decide_failed')).toEqual([
      expect.objectContaining({ level: 40, reason: 'no_system_principal', failures: 1 }),
      expect.objectContaining({ level: 40, failures: 2 }),
    ])
  })

  it('§8.3: the targeted queue coalesces each person for 100 ms, keeps their first trigger, and hands on at most 500 people a batch', () => {
    vi.useFakeTimers()
    const due = vi.fn()
    const queue = new TargetedQueue<string>(due, { delayMs: 100, max: 2 })
    queue.queue(ORG, ME, 'push')
    queue.queue(ORG, ME, 'durable')
    queue.queue(ORG, YOU, 'durable')
    queue.queue(ORG, 'third', 'push')
    expect(queue.size()).toBe(3)
    vi.advanceTimersByTime(99)
    expect(due).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(due.mock.calls).toEqual([
      [
        ORG,
        new Map([
          [ME, 'push'],
          [YOU, 'durable'],
        ]),
      ],
      [ORG, new Map([['third', 'push']])],
    ])
    expect(queue.size()).toBe(0)
  })

  it('§8.3: a later trigger replaces the one kept only where the queue prefers it', () => {
    vi.useFakeTimers()
    const due = vi.fn()
    const queue = new TargetedQueue<string>(due, {
      delayMs: 100,
      prefer: (kept, next) => kept === 'recheck' && next !== 'recheck',
    })
    queue.queue(ORG, ME, 'recheck')
    queue.queue(ORG, ME, 'push')
    queue.queue(ORG, ME, 'durable')
    queue.queue(ORG, YOU, 'durable')
    queue.queue(ORG, YOU, 'recheck')
    vi.advanceTimersByTime(100)
    expect(due.mock.calls).toEqual([
      [
        ORG,
        new Map([
          [ME, 'push'],
          [YOU, 'durable'],
        ]),
      ],
    ])
    vi.useRealTimers()
  })

  it('merges requests by person, without duplicates', () => {
    expect(
      mergeRequests([
        { sessions: ['s1'], eras: asked([[ME, [teamTopic()]]]) },
        { sessions: ['s1', 's2'], topics: asked([[YOU, [orgTopic()]]]), eras: asked([[ME, [teamTopic()]]]) },
      ]),
    ).toEqual({
      sessions: ['s1', 's2'],
      topics: asked([[YOU, [orgTopic()]]]),
      held: new Map(),
      eras: asked([[ME, [teamTopic()]]]),
    })
  })
})

describe('C0.7 T19 items 6 and 8: what the gateway does with what the checks find', () => {
  const running: FastifyInstance[] = []
  afterEach(async () => {
    for (const app of running.splice(0)) await app.close()
  })
  async function start(...args: Parameters<typeof startGateway>) {
    const gateway = await startGateway(...args)
    running.push(gateway.app)
    return gateway
  }

  it('S1 m2: a sub on a session that has ended is never acked ok: its socket closes with 4401, path recheck', async () => {
    const { url, server, checks } = await start()
    const client = await connected(url)
    checks.ended.set(A.session.sessionId, Date.now() - 2000)
    client.send({ v: 1, t: 'sub', id: 1, topics: [personTopic(1)] })
    expect(await client.closed).toEqual(GATEWAY_CLOSE.signedOut)
    expect(client.all('ack')).toEqual([])
    await until(() => server.counts().open === 0)
    expect(server.counts()).toMatchObject({ closedRecheck: 1, topics: 0 })
  })

  it('S9: a person the admission hook refuses gets 4403 from the lane and from the periodic check, and nothing is decided for them', async () => {
    const { url, server, checks } = await start({ recheckMs: 100, admission: true })
    const subscriber = await connected(url)
    const idle = await connected(url, B.token)
    checks.notAdmitted.add(ME)
    checks.notAdmitted.add(YOU)
    subscriber.send({ v: 1, t: 'sub', id: 1, topics: [personTopic(1)] })
    expect(await subscriber.closed).toEqual(GATEWAY_CLOSE.noticeRequired)
    expect(subscriber.all('ack')).toEqual([])
    // The other never asks for anything: the periodic check closes it.
    expect(await idle.closed).toEqual(GATEWAY_CLOSE.noticeRequired)
    expect(server.counts().closedNotAdmitted).toBe(2)
  })

  it('S9 C0.9: a sub’s not-admitted verdict closes only the person’s sockets open before its read, never one opened (and admitted) after it', async () => {
    // A check that reads its answer when called, as the lane's transaction reads admission, and
    // then, once armed, holds the rest of that transaction.
    let fake: FakeChecks | undefined
    let armed: Promise<void> | undefined
    let release: () => void = () => {}
    let calls = 0
    const check: CheckOrg = async (orgId, request) => {
      calls++
      const result = (fake as FakeChecks).answer(orgId, request)
      const wait = armed
      armed = undefined
      if (wait !== undefined) await wait
      return result
    }
    const { url, server, checks } = await start({ admission: true, check })
    fake = checks
    const before = await connected(url)
    // Its accept-time check admits it.
    await until(() => calls === 1)
    await delay(20)
    // A new notice version: the sub's decision reads the person as not admitted, and is held.
    checks.notAdmitted.add(ME)
    armed = new Promise(resolve => {
      release = resolve
    })
    before.send({ v: 1, t: 'sub', id: 1, topics: [personTopic(1)] })
    await until(() => calls === 2)
    // The person acknowledges in another tab, whose socket opens on the same session meanwhile.
    checks.notAdmitted.delete(ME)
    const after = await connected(url)
    release()
    expect(await before.closed).toEqual(GATEWAY_CLOSE.noticeRequired)
    // The later socket's own accept-time check runs once the lane is free, and admits it.
    await until(() => calls === 3)
    await delay(50)
    expect(after.ws.readyState).toBe(WebSocket.OPEN)
    expect(server.counts()).toMatchObject({ closedNotAdmitted: 1, open: 1 })
  })

  it('S9: with an admission hook, every accept is checked at once', async () => {
    const { url, checks } = await start({ admission: true })
    await connected(url)
    await until(() => checks.calls.some(call => call.request.sessions.includes(A.session.sessionId)))
  })

  it('P8 M1: a failed lane answers retry and closes nothing', async () => {
    const { url, server, checks } = await start()
    const client = await connected(url)
    checks.failNext(new Error('connection refused'))
    const ack = await client.sub([personTopic(1), orgTopic()])
    expect(ack).toMatchObject({ ok: [], refused: [], reset: [], retry: [personTopic(1), orgTopic()] })
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    expect(server.counts()).toMatchObject({ retried: 2, topics: 0, closedUnchecked: 0 })
    // Sent again, they are decided.
    expect((await client.sub([personTopic(1), orgTopic()])).ok).toEqual([personTopic(1), orgTopic()])
  })

  it('OD-37 P8: with no system principal, a lane answers retry, and the periodic check closes the org’s sockets with 1013, never 4401, logging an error', async () => {
    const { url, server, checks, events } = await start({ recheckMs: 100 })
    const client = await connected(url)
    checks.failAlways = new NoSystemPrincipal()
    expect((await client.sub([personTopic(1)])).retry).toEqual([personTopic(1)])
    expect(await client.closed).toEqual(GATEWAY_CLOSE.tryAgain)
    expect(events('ws_recheck_no_system_principal')).toEqual([expect.objectContaining({ level: 50, org: ORG })])
    expect(server.counts()).toMatchObject({ closedUnchecked: 1, closedRecheck: 0 })
  })

  it('Rule 6 T19 item 8 m3: the periodic check drops a topic lost meanwhile, keeping the socket and its other topics, and records the drop from when the token went', async () => {
    const { logger, events } = captureLogger('realtime')
    const { url, server, checks } = await start({
      recheckMs: 100,
      latency: new RevocationLatency({ logger, summaryMs: 0 }),
    })
    checks.allow(ME, teamTopic())
    const client = await connected(url)
    expect((await client.sub([teamTopic(), personTopic(1)])).ok).toEqual([teamTopic(), personTopic(1)])
    checks.deny(ME, teamTopic())
    checks.lostAt.set(ME, new Map([[teamTopic(), Date.now() - 3000]]))
    expect(await client.next('dropped')).toEqual({ v: 1, t: 'dropped', topics: [teamTopic()], reason: 'access' })
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    expect(server.counts()).toMatchObject({ topics: 1, dropped: { push: 0, durable: 0, recheck: 1 } })
    const [applied] = events('revocation_applied')
    expect(applied).toMatchObject({
      handler: 'topics',
      path: 'recheck',
      cause: 'keys_changed',
      count: 1,
      startSource: 'database',
    })
    expect(applied?.latencyMs).toBeGreaterThanOrEqual(3000)
    // The person topic is still live: it is re-checked, and stays.
    await delay(250)
    expect(client.all('dropped')).toHaveLength(1)
  })

  it('T19 items 5 and 6: a people signal re-checks that person’s sockets in the lane, labelled with its path, and a subscribe decided before the signal arrived is followed by a targeted re-check', async () => {
    const { logger, events } = captureLogger('realtime')
    const { url, server, checks } = await start({ latency: new RevocationLatency({ logger, summaryMs: 0 }) })
    checks.allow(ME, teamTopic())
    const client = await connected(url)
    // The decision is held; the removal commits and its signal arrives meanwhile.
    checks.hold()
    const sub = client.sub([teamTopic()])
    await until(() => checks.calls.length === 1)
    checks.deny(ME, teamTopic())
    server.peopleChanged(ORG, [ME], { path: 'push', cause: 'keys_changed', at: Date.now() })
    // The decision answers what it read before the removal: allowed.
    const answer = checks.answer.bind(checks)
    checks.answer = (orgId, request) => {
      checks.answer = answer
      const result = answer(orgId, request)
      return { ...result, topics: new Map([[ME, new Map([[teamTopic(), true]])]]) }
    }
    checks.release()
    expect((await sub).ok).toEqual([teamTopic()])
    // The targeted re-check drops it, labelled push.
    expect(await client.next('dropped')).toMatchObject({ topics: [teamTopic()] })
    expect(server.counts().dropped).toEqual({ push: 1, durable: 0, recheck: 0 })
    expect(events('revocation_applied')).toEqual([expect.objectContaining({ handler: 'topics', path: 'push' })])
  })

  it('OD-22 trace fix: two failed periodic checks in a row with sockets to check fail the gateway’s readiness; one success clears it, and so does a tick with no sockets', async () => {
    const { url, server, checks } = await start({ recheckMs: 50 })
    expect(server.checksFailing()).toBe(false)
    const client = await connected(url)
    checks.failAlways = new Error('connection refused')
    await until(() => server.checksFailing())
    checks.failAlways = undefined
    await until(() => !server.checksFailing())
    checks.failAlways = new Error('connection refused')
    await until(() => server.checksFailing())
    client.ws.close()
    await until(() => server.counts().open === 0)
    await until(() => !server.checksFailing())
  })
})
