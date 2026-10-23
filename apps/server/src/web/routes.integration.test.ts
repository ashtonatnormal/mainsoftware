// GET /api/session and GET /api/flags on the Compose stack (T21 item 10, T17 item 11): the client
// flags a signed-in person gets as an Admin changes them through the production route, their
// cohorts, which GET counts as use of the session (OD-14), the session answer's fallbacks
// (T21 item 10, OD-10), and the refusals that never clear the cookie (T21 item 3, ACC-05). The test
// flag it.client is the harness's (testing/stack.ts TEST_FLAGS), the only client: true flag in its
// registry; no production flag is one yet (OD-13). `npm run test:integration` runs it with the
// stack up (`docker compose up -d --wait`).
//
// afterAll checks every reply was no-store and none a 500, and the outbox's contract for the run
// (every committed write covered: the sign-ins', the flag changes', the sign-out's and the
// deactivation's; these GETs write only the exempt last-use time).
import { FlagsResponse, MESSAGES, SessionResponse } from '@hearth/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client, Person, Stack } from '#src/testing/stack.ts'
import { startStack } from '#src/testing/stack.ts'
import { everyTestPassed, expectEveryWriteCovered } from '#src/testing/writes.ts'

const SESSION_COOKIE = '__Host-hearth_session'
const KEY = 'it.client'

let s: Stack
let admin: Person
let adminClient: Client

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Polls every 20 ms until check passes on what read gives, for at most `ms`.
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (check(value)) return value
    if (Date.now() > deadline) throw new Error(`still not as expected after ${ms} ms: ${JSON.stringify(value)}`)
    await sleep(20)
  }
}

// Sets it.client through the production route as the Admin, and waits until the api's own copy of
// the org's flags has the change (the route reloads it after the commit).
async function setClientFlag(change: {
  enabled: boolean
  audience?: 'org' | 'cohort'
  people?: string[]
  roles?: string[]
}): Promise<void> {
  await s.reauth(adminClient, admin)
  const reply = await adminClient.post('/api/admin/flags/set', { key: KEY, ...change })
  expect([reply.status, reply.error]).toEqual([200, undefined])
  const { revision } = reply.json<{ revision: number }>()
  await eventually(
    async () => s.apiFlags.revisionsOf(s.org.id, KEY)?.at(-1),
    seen => seen === revision,
  )
}

// The client flags as the person's browser gets them, strictly as the server types them.
async function flagsOf(client: Client): Promise<Record<string, boolean>> {
  const reply = await client.get('/api/flags')
  expect([reply.status, reply.error]).toEqual([200, undefined])
  return FlagsResponse.parse(reply.body).flags
}

async function lastSeen(sessionId: string): Promise<{ session: Date; device: Date }> {
  const [row] = await s.query<{ session: Date; device: Date }>(
    `select s.last_seen_at as session, d.last_seen_at as device
     from sessions s join devices d on d.id = s.device_id where s.id = $1`,
    [sessionId],
  )
  if (row === undefined) throw new Error('no such session')
  return row
}

describe('C0.8 T21 item 10 T17 item 11 GET /api/session and GET /api/flags on the stack', () => {
  beforeAll(async () => {
    s = await startStack()
    admin = await s.person({ roles: ['admin'] })
    adminClient = await s.signIn(admin)
  })

  // biome-ignore lint/correctness/noEmptyPattern: the hook takes no fixtures.
  afterAll(async ({}, suite) => {
    if (s === undefined) return
    try {
      for (const reply of s.replies) {
        expect(reply.cacheControl, `${reply.method} ${reply.url}`).toBe('no-store')
        expect(reply.error, `${reply.method} ${reply.url}`).not.toBe('internal')
      }
      expect(s.warnings.map(warning => `${warning.name}: ${warning.message}`)).toEqual([])
      await expectEveryWriteCovered(s.superuser, 'web', { allPassed: everyTestPassed(suite) })
    } finally {
      await s.stop()
    }
  })

  it('WI-01 T17 item 11: a signed-in member gets it.client true while it is on for the org, false once off; no ai.* or client: false key ever appears', async () => {
    const member = await s.person()
    const client = await s.signIn(member)
    try {
      await setClientFlag({ enabled: true })
      // The first answer waits for the org's first read in this process, if it hasn't happened yet.
      expect(await flagsOf(client)).toEqual({ [KEY]: true })
      await setClientFlag({ enabled: false })
      expect(await flagsOf(client)).toEqual({ [KEY]: false })
    } finally {
      await setClientFlag({ enabled: true })
    }
    expect(await flagsOf(client)).toEqual({ [KEY]: true })
  })

  it('WI-02 T17 item 3: a cohort naming the person reads true, one leaving them out reads false, and no cohort or revision is sent', async () => {
    const member = await s.person()
    const leader = await s.person({ roles: ['leadership'] })
    const memberClient = await s.signIn(member)
    const leaderClient = await s.signIn(leader)
    try {
      await setClientFlag({ enabled: true, audience: 'cohort', people: [member.id] })
      expect(await flagsOf(memberClient)).toEqual({ [KEY]: true })
      expect(await flagsOf(leaderClient)).toEqual({ [KEY]: false })
      await setClientFlag({ enabled: true, audience: 'cohort', roles: ['leadership'] })
      expect(await flagsOf(leaderClient)).toEqual({ [KEY]: true })
      const left = await memberClient.get('/api/flags')
      expect(left.body).toEqual({ flags: { [KEY]: false } })
      // Nothing about who else it is on for, or which revision decided it.
      for (const word of ['cohort', 'audience', 'revision', 'leadership', member.id, leader.id]) {
        expect(left.text).not.toContain(word)
      }
    } finally {
      await setClientFlag({ enabled: true, audience: 'org' })
    }
  })

  it('WI-03 OD-14: GET /api/flags leaves the session’s last use as it was; GET /api/session then moves it', async () => {
    const member = await s.person()
    const client = await s.signIn(member)
    const { id } = await s.sessionOf(client)
    // Two minutes old, past the once-a-minute touch; this process has never touched the session,
    // and the flags poll comes first, so the throttle can't hide a touch.
    await s.age(id, '2 minutes')
    const before = await lastSeen(id)
    expect(await flagsOf(client)).toEqual({ [KEY]: true })
    await s.settled()
    expect(await lastSeen(id)).toEqual(before)
    const answered = await client.get('/api/session')
    expect(answered.status).toBe(200)
    await s.settled()
    const after = await lastSeen(id)
    expect(after.session.getTime()).toBeGreaterThan(before.session.getTime() + 60_000)
    expect(after.device.getTime()).toBeGreaterThan(before.device.getTime() + 60_000)
  })

  it('WI-04 T21 item 10 OD-10: GET /api/session gives the person’s id, display name and profile zone; without a profile, the full name and the org’s zone; capabilities.registers for the DPO alone (C0.9 PD-26)', async () => {
    const org = await s.newOrg()
    await s.query("update orgs set time_zone = 'Asia/Jakarta' where id = $1", [org.id])
    const ahmad = await s.person({ org })
    const other = await s.person({ org })
    await s.query(
      "insert into profiles (person_id, org_id, display_name, time_zone) values ($1, $2, 'Ahmad', 'Asia/Kuala_Lumpur')",
      [ahmad.id, org.id],
    )
    const withProfile = await (await s.signIn(ahmad)).get('/api/session')
    expect(withProfile.status).toBe(200)
    expect(SessionResponse.parse(withProfile.body)).toEqual({
      personId: ahmad.id,
      name: 'Ahmad',
      timeZone: 'Asia/Kuala_Lumpur',
      capabilities: { registers: false },
    })
    const without = await (await s.signIn(other)).get('/api/session')
    expect(without.status).toBe(200)
    expect(SessionResponse.parse(without.body)).toEqual({
      personId: other.id,
      name: `Person ${other.id.slice(0, 8)}`,
      timeZone: 'Asia/Jakarta',
      capabilities: { registers: false },
    })
    // The DPO may reach the registers (can() allows register.read once they re-authenticate),
    // which the shell shows as its "Data protection" entry; an Owner who isn't the DPO may not.
    const dpo = await s.person({ org, roles: ['dpo'] })
    const owner = await s.person({ org, roles: ['owner'] })
    const asDpo = await (await s.signIn(dpo)).get('/api/session')
    expect(SessionResponse.parse(asDpo.body).capabilities).toEqual({ registers: true })
    const asOwner = await (await s.signIn(owner)).get('/api/session')
    expect(SessionResponse.parse(asOwner.body).capabilities).toEqual({ registers: false })
    // No phone number, no roles.
    for (const reply of [withProfile, without, asDpo, asOwner]) {
      for (const person of [ahmad, other, dpo, owner]) expect(reply.text).not.toContain(person.local)
      expect(reply.text).not.toMatch(/"(dpo|owner)"/)
    }
  })

  it('WI-05 T21 item 3 ACC-05: after sign-out, or once the person is deactivated, both answer 401 signed_out with no Set-Cookie', async () => {
    const expectSignedOut = async (client: Client) => {
      for (const url of ['/api/session', '/api/flags']) {
        const reply = await client.get(url)
        expect([url, reply.status]).toEqual([url, 401])
        expect(reply.body).toEqual({ error: 'signed_out', message: MESSAGES.signed_out })
        expect(reply.setCookies).toEqual([])
      }
    }
    // Signed out: the browser still sends the old cookie (another tab's, say).
    const leaving = await s.person()
    const client = await s.signIn(leaving)
    const token = client.cookie(SESSION_COOKIE)
    if (token === undefined) throw new Error('the sign-in set no session cookie')
    expect((await client.get('/api/session')).status).toBe(200)
    expect((await client.post('/api/auth/sign-out', {})).status).toBe(200)
    client.setCookie(SESSION_COOKIE, token)
    await expectSignedOut(client)
    expect(client.cookie(SESSION_COOKIE)).toBe(token)

    // Deactivated by an Admin: every session of theirs ended.
    const leaver = await s.person()
    const leaverClient = await s.signIn(leaver)
    expect((await leaverClient.get('/api/flags')).status).toBe(200)
    await s.reauth(adminClient, admin)
    const deactivated = await adminClient.post('/api/admin/people/deactivate', { person: leaver.id })
    expect(deactivated.body).toEqual({ status: 'deactivated', sessionsEnded: 1 })
    await expectSignedOut(leaverClient)
    expect(leaverClient.cookie(SESSION_COOKIE)).toBeDefined()
  })
})
