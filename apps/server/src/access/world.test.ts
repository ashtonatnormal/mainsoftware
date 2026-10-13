import { describe, expect, it } from 'vitest'
import { actingSession, authorise, decide, loadWorld } from '#src/access/world.ts'
import { withOrg } from '#src/db/database.ts'
import { type Statement, scriptedPool } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const ADMIN = 'b0000000-0000-4000-8000-000000000001'
const OWNER = 'b0000000-0000-4000-8000-000000000002'
const MEMBER = 'b0000000-0000-4000-8000-000000000003'
const LEAVER = 'b0000000-0000-4000-8000-000000000004'
const TEAM = 'c0000000-0000-4000-8000-000000000001'
const MY_DEVICE = 'd0000000-0000-4000-8000-000000000001'
const OLD_DEVICE = 'd0000000-0000-4000-8000-000000000002'
const PASSKEY = 'e0000000-0000-4000-8000-000000000001'
const SESSION = 'f0000000-0000-4000-8000-000000000001'
const LEFT_AT = new Date('2026-10-01T00:00:00Z')

const session = (userId: string) => ({ sessionId: SESSION, orgId: ORG, userId, deviceId: MY_DEVICE })

// The org as the loader reads it: an Admin, an Owner, a member, a leaver, one team, and the
// requester's devices and passkey. `fresh` is the acting session's re-read, or 'ended'.
function org(fresh: boolean | 'ended' = true) {
  return scriptedPool((statement: Statement) => {
    const { text } = statement
    if (text.includes('from people p')) return fresh === 'ended' ? [] : [{ fresh }]
    if (text.startsWith('select "id", "deactivated_at" from "people"')) {
      return [
        ...[ADMIN, OWNER, MEMBER].map(id => ({ id, deactivated_at: null as Date | null })),
        { id: LEAVER, deactivated_at: LEFT_AT },
      ]
    }
    if (text.startsWith('select "person_id", "role"')) {
      return [
        { person_id: ADMIN, role: 'admin', team_id: null, revoked_at: null },
        { person_id: OWNER, role: 'owner', team_id: null, revoked_at: null },
        { person_id: MEMBER, role: 'team_admin', team_id: TEAM, revoked_at: null },
      ]
    }
    if (text.startsWith('select "id", "archived_at" from "teams"')) return [{ id: TEAM, archived_at: null }]
    if (text.startsWith('select "id", "user_id", "signed_out_at" from "devices"')) {
      const owner = statement.values[1]
      return [
        { id: MY_DEVICE, user_id: owner, signed_out_at: null },
        { id: OLD_DEVICE, user_id: owner, signed_out_at: LEFT_AT },
      ]
    }
    if (text.startsWith('select "id", "user_id", "removed_at" from "passkeys"')) {
      return [{ id: PASSKEY, user_id: statement.values[1], removed_at: null }]
    }
    return []
  })
}

describe('C0.5 §3.26 the acting session, re-read in the action’s own transaction', () => {
  it('locks person, device and session FOR SHARE by default, and says whether the re-authentication is fresh', async () => {
    const { db, statements } = org(true)
    const acting = await withOrg(db, { orgId: ORG, userId: ADMIN }, trx => actingSession(trx, session(ADMIN)))
    expect(acting).toEqual({ fresh: true })
    const read = statements.find(s => s.text.includes('from people p'))
    expect(read?.text).toMatch(/for share of p, d, s$/)
    expect(read?.text).toContain('s.reauthenticated_at > now() - $1::interval as fresh')
    expect(read?.values).toEqual(['5 minutes', ORG, ADMIN, MY_DEVICE, SESSION, '30 days'])
  })

  it('takes the person FOR NO KEY UPDATE for an action that ends all their sessions, and no lock for a GET', async () => {
    for (const [options, ending] of [
      [{ person: 'no_key_update' }, /for no key update of p for share of d, s$/],
      [{ lock: false }, /p\.deactivated_at is null$/],
    ] as const) {
      const { db, statements } = org(false)
      expect(
        await withOrg(db, { orgId: ORG, userId: ADMIN }, trx => actingSession(trx, session(ADMIN), options)),
      ).toEqual({
        fresh: false,
      })
      expect(statements.find(s => s.text.includes('from people p'))?.text).toMatch(ending)
    }
  })

  it('answers undefined when the person, device or session has ended', async () => {
    const { db } = org('ended')
    expect(await withOrg(db, { orgId: ORG, userId: ADMIN }, trx => actingSession(trx, session(ADMIN)))).toBeUndefined()
  })
})

describe('C0.5 §3.26 T13 the World loader', () => {
  it("loads people, roles, teams and the named person's devices and passkeys, each query naming the org", async () => {
    const { db, statements } = org()
    const world = await withOrg(db, { orgId: ORG, userId: ADMIN }, trx => loadWorld(trx, ORG, { credentialsOf: ADMIN }))
    expect(world.orgId).toBe(ORG)
    expect(world.isActivePerson(ADMIN)).toBe(true)
    expect(world.isActivePerson(LEAVER)).toBe(false)
    expect(world.person(LEAVER)).toEqual({ id: LEAVER, deactivatedAt: LEFT_AT.getTime() })
    expect(world.holds(OWNER, 'owner')).toBe(true)
    expect(world.device(OLD_DEVICE)).toEqual({ id: OLD_DEVICE, userId: ADMIN, signedOutAt: LEFT_AT.getTime() })
    expect(world.passkey(PASSKEY)).toEqual({ id: PASSKEY, userId: ADMIN, removedAt: null })
    const reads = statements.filter(s => /^select "/.test(s.text))
    expect(reads).toHaveLength(5)
    for (const read of reads) {
      expect(read.text).toContain('where "org_id" = $1')
      expect(read.values[0]).toBe(ORG)
    }
  })
})

describe('C0.5 §9.4 T13 deciding a request with can()', () => {
  const world = async () => {
    const { db } = org()
    return withOrg(db, { orgId: ORG, userId: ADMIN }, trx => loadWorld(trx, ORG, { credentialsOf: ADMIN }))
  }

  it('allows an Admin action only with a fresh re-authentication, and says when that is all that is missing', async () => {
    const w = await world()
    const deactivate = { action: 'person.deactivate', person: MEMBER } as const
    expect(decide(w, ADMIN, deactivate, true)).toBe('allowed')
    expect(decide(w, ADMIN, deactivate, false)).toBe('reauth_required')
  })

  it("refuses what re-authenticating wouldn't allow: an Admin acting on the Owner, a member acting as an admin", async () => {
    const w = await world()
    expect(decide(w, ADMIN, { action: 'person.reset_pin', person: OWNER }, false)).toBe('refused')
    expect(decide(w, ADMIN, { action: 'person.reset_pin', person: OWNER }, true)).toBe('refused')
    expect(decide(w, MEMBER, { action: 'person.deactivate', person: ADMIN }, true)).toBe('refused')
  })

  it('ACC-04 ACC-02: your own devices need no re-authentication, your passkeys do, and only your live ones count', async () => {
    const w = await world()
    expect(decide(w, ADMIN, { action: 'devices.list_own' }, false)).toBe('allowed')
    expect(decide(w, ADMIN, { action: 'devices.sign_out_own', device: MY_DEVICE }, false)).toBe('allowed')
    expect(decide(w, ADMIN, { action: 'devices.sign_out_own', device: OLD_DEVICE }, true)).toBe('refused')
    expect(decide(w, ADMIN, { action: 'passkeys.remove_own', passkey: PASSKEY }, false)).toBe('reauth_required')
    expect(decide(w, ADMIN, { action: 'passkeys.remove_own', passkey: PASSKEY }, true)).toBe('allowed')
    expect(decide(w, ADMIN, { action: 'passkeys.add_own' }, false)).toBe('reauth_required')
  })

  it('authorise throws 401 signed_out (clearing the cookie), 403 reauth_required, or the refusal it is given', async () => {
    const ended = org('ended')
    await expect(
      withOrg(ended.db, { orgId: ORG, userId: ADMIN }, trx =>
        authorise(trx, session(ADMIN), { action: 'devices.list_own' }, 'not_found'),
      ),
    ).rejects.toMatchObject({ status: 401, code: 'signed_out', clear: ['session'] })
    const stale = org(false)
    await expect(
      withOrg(stale.db, { orgId: ORG, userId: ADMIN }, trx =>
        authorise(trx, session(ADMIN), { action: 'person.deactivate', person: MEMBER }, 'forbidden'),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'reauth_required' })
    const fresh = org(true)
    await expect(
      withOrg(fresh.db, { orgId: ORG, userId: ADMIN }, trx =>
        authorise(trx, session(ADMIN), { action: 'person.deactivate', person: OWNER }, 'forbidden'),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    const mine = org(true)
    await expect(
      withOrg(mine.db, { orgId: ORG, userId: ADMIN }, trx =>
        authorise(trx, session(ADMIN), { action: 'devices.sign_out_own', device: OLD_DEVICE }, 'not_found'),
      ),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' })
    const allowed = org(true)
    const w = await withOrg(allowed.db, { orgId: ORG, userId: ADMIN }, trx =>
      authorise(trx, session(ADMIN), { action: 'person.deactivate', person: MEMBER }, 'forbidden'),
    )
    expect(w.isActivePerson(MEMBER)).toBe(true)
  })
})
