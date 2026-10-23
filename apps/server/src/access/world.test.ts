import { readdirSync, readFileSync } from 'node:fs'
import type { NoticeStanding } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import {
  actingSession,
  authorise,
  consider,
  decide,
  holdsRoleNow,
  loadWorld,
  requireNotice,
} from '#src/access/world.ts'
import { noticeStandings } from '#src/compliance/notice-standing.ts'
import { withOrg } from '#src/db/database.ts'
import { type Statement, scriptedPool, standingsOf } from '#src/testing/pool.ts'

const ORG = 'a0000000-0000-4000-8000-000000000001'
const ADMIN = 'b0000000-0000-4000-8000-000000000001'
const OWNER = 'b0000000-0000-4000-8000-000000000002'
const MEMBER = 'b0000000-0000-4000-8000-000000000003'
const LEAVER = 'b0000000-0000-4000-8000-000000000004'
const DPO = 'b0000000-0000-4000-8000-000000000005'
const TEAM = 'c0000000-0000-4000-8000-000000000001'
const MY_DEVICE = 'd0000000-0000-4000-8000-000000000001'
const OLD_DEVICE = 'd0000000-0000-4000-8000-000000000002'
const PASSKEY = 'e0000000-0000-4000-8000-000000000001'
const SESSION = 'f0000000-0000-4000-8000-000000000001'
const LEFT_AT = new Date('2026-10-01T00:00:00Z')

const session = (userId: string) => ({ sessionId: SESSION, orgId: ORG, userId, deviceId: MY_DEVICE })

// The org as the loader reads it: an Admin, an Owner, a member, a leaver, the DPO, one team, and
// the requester's devices and passkey. `fresh` is the acting session's re-read, or 'ended'; `issued`
// whether that session was issued under the PIN rule (D46), whose person holds a PIN; `standing`
// what the notice's standing read finds for everyone it asks about (C0.9 PD-43), acknowledged
// unless given.
function org(fresh: boolean | 'ended' = true, issued = true, standing?: NoticeStanding) {
  return scriptedPool((statement: Statement) => {
    const { text } = statement
    if (text.includes('from people p')) {
      return fresh === 'ended' ? [] : [{ fresh, pin_set: true, issued_under_pin_rule: issued }]
    }
    if (standing !== undefined && text.startsWith('select x.person,')) {
      return standingsOf(statement.values.find(Array.isArray) as string[], standing)
    }
    if (text.startsWith('select "id", "deactivated_at" from "people"')) {
      return [
        ...[ADMIN, OWNER, MEMBER, DPO].map(id => ({ id, deactivated_at: null as Date | null })),
        { id: LEAVER, deactivated_at: LEFT_AT },
      ]
    }
    if (text.startsWith('select id, deactivated_at from people')) {
      return [{ id: DPO, deactivated_at: null }]
    }
    if (text.startsWith('select person_id, role, team_id, revoked_at from role_assignments')) {
      return [{ person_id: DPO, role: 'dpo', team_id: null, revoked_at: null }]
    }
    if (text.startsWith('select "person_id", "role"')) {
      return [
        { person_id: ADMIN, role: 'admin', team_id: null, revoked_at: null },
        { person_id: OWNER, role: 'owner', team_id: null, revoked_at: null },
        { person_id: MEMBER, role: 'team_admin', team_id: TEAM, revoked_at: null },
        { person_id: DPO, role: 'dpo', team_id: null, revoked_at: null },
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

describe('C0.5 T14 the acting session, re-read in the action’s own transaction', () => {
  it('locks person, device and session FOR SHARE by default, and says whether the re-authentication is fresh', async () => {
    const { db, statements } = org(true)
    const acting = await withOrg(db, { orgId: ORG, userId: ADMIN }, trx => actingSession(trx, session(ADMIN)))
    expect(acting).toEqual({ stampFresh: true, pinSet: true, issuedUnderPinRule: true })
    const read = statements.find(s => s.text.includes('from people p'))
    expect(read?.text).toMatch(/for share of p, d, s$/)
    expect(read?.text).toContain('s.reauthenticated_at > now() - $1::interval as fresh')
    // D46: the users row joins unlocked, and a session issued under the PIN rule is the one whose
    // lifetime is shorter than SESSION's.
    expect(read?.text).toContain('u.pin_hash is not null as pin_set')
    expect(read?.text).toContain('s.expires_at - s.created_at < $2::interval as issued_under_pin_rule')
    expect(read?.text).toContain('join users u on u.org_id = p.org_id and u.id = p.id')
    expect(read?.values).toEqual(['5 minutes', '2160 hours', ORG, ADMIN, MY_DEVICE, SESSION, '30 days'])
  })

  it('takes the person FOR NO KEY UPDATE for an action that ends all their sessions, and no lock for a GET', async () => {
    for (const [options, ending] of [
      [{ person: 'no_key_update' }, /for no key update of p for share of d, s$/],
      [{ lock: false }, /p\.deactivated_at is null$/],
    ] as const) {
      const { db, statements } = org(false)
      expect(
        await withOrg(db, { orgId: ORG, userId: ADMIN }, trx => actingSession(trx, session(ADMIN), options)),
      ).toEqual({ stampFresh: false, pinSet: true, issuedUnderPinRule: true })
      expect(statements.find(s => s.text.includes('from people p'))?.text).toMatch(ending)
    }
  })

  it('answers undefined when the person, device or session has ended', async () => {
    const { db } = org('ended')
    expect(await withOrg(db, { orgId: ORG, userId: ADMIN }, trx => actingSession(trx, session(ADMIN)))).toBeUndefined()
  })
})

describe('C0.5 T13 the World loader', () => {
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
    ).rejects.toMatchObject({ status: 403, code: 'reauth_required', extra: { method: 'pin' } })
    // D46: an Admin on a code-only session must sign in again, a fresh stamp notwithstanding.
    const codeOnly = org(true, false)
    await expect(
      withOrg(codeOnly.db, { orgId: ORG, userId: ADMIN }, trx =>
        authorise(trx, session(ADMIN), { action: 'person.deactivate', person: MEMBER }, 'forbidden'),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'reauth_required', extra: { method: 'sign_in' }, person: ADMIN })
    // A Team Admin on a code-only session re-authenticates by SMS code (AQ-01).
    const member = org(false, false)
    await expect(
      withOrg(member.db, { orgId: ORG, userId: MEMBER }, trx =>
        authorise(trx, session(MEMBER), { action: 'passkeys.add_own' }, 'forbidden'),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'reauth_required', extra: { method: 'code' } })
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

describe('C0.9 PD-43 PD-44 T22 items 28 and 29 the acknowledgement gate on REST (PDPA-03, ACC-12)', () => {
  const deactivate = { action: 'person.deactivate', person: MEMBER } as const
  const standingReads = (statements: readonly Statement[]) =>
    statements.filter(s => s.text.startsWith('select x.person,'))

  it('NTS-01: reads the standing plainly, once, for the org set, after the World and before can(); a refusal is 403 notice_required before any target lock', async () => {
    for (const standing of ['required', 'unpublished'] as const) {
      const { db, statements } = org(true, true, standing)
      await expect(
        withOrg(db, { orgId: ORG, userId: ADMIN }, trx =>
          authorise(trx, session(ADMIN), deactivate, 'forbidden', { target: MEMBER }),
        ),
        standing,
      ).rejects.toMatchObject({ status: 403, code: 'notice_required' })
      const reads = standingReads(statements)
      expect(reads, standing).toHaveLength(1)
      expect(reads[0]?.values).toEqual([ORG, [ADMIN], ORG])
      expect(reads[0]?.text).not.toMatch(/\bfor (share|update|no key update|key share)\b/)
      expect(reads[0]?.text).not.toContain('public.')
      const texts = statements.map(s => s.text)
      const read = texts.findIndex(text => text.startsWith('select x.person,'))
      expect(texts.findLastIndex(text => text.startsWith('select "id", "deactivated_at" from "people"'))).toBeLessThan(
        read,
      )
      // Refused before can() could allow the action and take the target's row.
      expect(texts.some(text => text.includes('for no key update'))).toBe(false)
    }
    // Acknowledged: can() decides, and the target's row is taken.
    const { db, statements } = org(true, true, 'acknowledged')
    await withOrg(db, { orgId: ORG, userId: ADMIN }, trx =>
      authorise(trx, session(ADMIN), deactivate, 'forbidden', { target: MEMBER }),
    )
    expect(statements.some(s => s.text.endsWith('for no key update'))).toBe(true)
  })

  it('NTS-01: refuses before can() decides: a request can() would refuse, or allow only once re-authenticated, still answers notice_required', async () => {
    const stale = org(false, true, 'required')
    await expect(
      withOrg(stale.db, { orgId: ORG, userId: ADMIN }, trx => authorise(trx, session(ADMIN), deactivate, 'forbidden')),
    ).rejects.toMatchObject({ status: 403, code: 'notice_required' })
    const member = org(true, true, 'required')
    await expect(
      withOrg(member.db, { orgId: ORG, userId: MEMBER }, trx =>
        consider(trx, session(MEMBER), { action: 'person.deactivate', person: ADMIN }),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'notice_required' })
    // An ended session is still 401 signed_out, before the notice is asked.
    const ended = org('ended', true, 'required')
    await expect(
      withOrg(ended.db, { orgId: ORG, userId: ADMIN }, trx => authorise(trx, session(ADMIN), deactivate, 'forbidden')),
    ).rejects.toMatchObject({ status: 401, code: 'signed_out' })
    expect(standingReads(ended.statements)).toEqual([])
  })

  it('NTS-01 PD-43: skips the read for the exempt uses, which pass in every standing', async () => {
    for (const request of [
      { action: 'session.read_own' },
      { action: 'devices.list_own' },
      { action: 'devices.sign_out_own', device: MY_DEVICE },
      { action: 'notice.read_own' },
      { action: 'notice.acknowledge_own' },
    ] as const) {
      const { db, statements } = org(true, true, 'required')
      const world = await withOrg(db, { orgId: ORG, userId: MEMBER }, trx =>
        authorise(trx, session(MEMBER), request, 'not_found', { lock: false }),
      )
      expect(world.isActivePerson(MEMBER), request.action).toBe(true)
      expect(standingReads(statements), request.action).toEqual([])
    }
  })

  it('NTS-01 OD-01 PD-44 C0.9 OD-10: before any version only the DPO passes, and only for the setup uses, recording their contact among them; once a version exists, nobody passes until they acknowledge it', async () => {
    const asks = async (me: string, use: Parameters<typeof requireNotice>[3], standing: NoticeStanding) => {
      const { db } = org(true, true, standing)
      return withOrg(db, { orgId: ORG, userId: me }, async trx => {
        const world = await loadWorld(trx, ORG)
        return requireNotice(trx, session(me), world, use).then(
          () => 'passed',
          (error: unknown) => (error as { code?: string }).code,
        )
      })
    }
    for (const use of [
      'register.read',
      'register.purpose.set',
      'register.transfer.set',
      'notice.read',
      'notice.publish',
      'notice.contact.set',
      'reauth',
    ] as const) {
      expect(await asks(DPO, use, 'unpublished'), use).toBe('passed')
      expect(await asks(OWNER, use, 'unpublished'), use).toBe('notice_required')
      // A version exists: the DPO acknowledges it first, like everyone.
      expect(await asks(DPO, use, 'required'), use).toBe('notice_required')
      expect(await asks(DPO, use, 'acknowledged'), use).toBe('passed')
    }
    expect(await asks(DPO, 'person.deactivate', 'unpublished')).toBe('notice_required')
    expect(await asks(ADMIN, 'person.deactivate', 'acknowledged')).toBe('passed')
    // C0.9 OD-19 PD-44 PD-76: listing the people and recording an acknowledgement aren't setup
    // uses: before v0 there is nothing to record, and afterwards the DPO acknowledges first.
    for (const use of ['notice.people.read', 'notice.acknowledgement.record'] as const) {
      expect(await asks(DPO, use, 'unpublished'), use).toBe('notice_required')
      expect(await asks(DPO, use, 'required'), use).toBe('notice_required')
      expect(await asks(DPO, use, 'acknowledged'), use).toBe('passed')
    }
  })

  it('C0.9 PD-43: the standing is unpublished with no version, acknowledged for the latest version only, and required otherwise; anyone the read misses reads as required', async () => {
    const { db, statements } = scriptedPool((statement: Statement) =>
      statement.text.startsWith('select x.person,') ? [{ person: ADMIN, standing: 'acknowledged' }] : [],
    )
    const standings = await withOrg(db, { orgId: ORG, userId: ADMIN }, trx =>
      noticeStandings(trx, ORG, [ADMIN, MEMBER, ADMIN]),
    )
    expect([...standings]).toEqual([
      [ADMIN, 'acknowledged'],
      [MEMBER, 'required'],
    ])
    const read = standingReads(statements)[0]
    expect(read?.values).toEqual([ORG, [ADMIN, MEMBER], ORG])
    expect(read?.text).toBe(
      "select x.person, case when v.id is null then 'unpublished' when exists ( select 1 from notice_acknowledgments a where a.org_id = $1 and a.person_id = x.person and a.notice_version_id = v.id) then 'acknowledged' else 'required' end as standing from unnest($2::uuid[]) as x(person) left join lateral ( select id from notice_versions where org_id = $3 order by version desc limit 1) v on true",
    )
    // Nobody asked about: no read.
    const none = scriptedPool()
    expect(await withOrg(none.db, { orgId: ORG, userId: ADMIN }, trx => noticeStandings(trx, ORG, []))).toEqual(
      new Map(),
    )
    expect(standingReads(none.statements)).toEqual([])
  })

  it('C0.9 PD-59 C-01: holdsRoleNow reads the person and their unrevoked roles with no lock, and packages/access decides', async () => {
    const { db, statements } = org()
    expect(await withOrg(db, { orgId: ORG, userId: DPO }, trx => holdsRoleNow(trx, ORG, DPO, 'dpo'))).toBe(true)
    expect(await withOrg(db, { orgId: ORG, userId: DPO }, trx => holdsRoleNow(trx, ORG, DPO, 'owner'))).toBe(false)
    const roles = statements.filter(s => s.text.includes('from role_assignments'))
    expect(roles.length).toBeGreaterThan(0)
    for (const read of roles) expect(read.text).not.toMatch(/\bfor (share|update|no key update|key share)\b/)
  })
})

describe('NTS-05 C0.9 PD-43 T22 item 28: the gate has no way round it', () => {
  // The server's runtime files, comments stripped (a // comment to the line's end; a /* */ block).
  const SRC = new URL('../', import.meta.url)
  const runtime = (readdirSync(SRC, { recursive: true }) as string[])
    .filter(path => path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.startsWith('testing/'))
    .map(path => ({
      path,
      code: readFileSync(new URL(path, SRC), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1'),
    }))

  it('only access/world.ts and auth/account.ts call actingSession(), each asking the gate beside it', () => {
    expect(runtime.length).toBeGreaterThan(50)
    const callers = runtime.filter(({ code }) => /\bactingSession\s*\(/.test(code)).map(({ path }) => path)
    expect(callers.sort()).toEqual(['access/world.ts', 'auth/account.ts'])
    const account = runtime.find(({ path }) => path === 'auth/account.ts')?.code ?? ''
    expect(account).toMatch(/requireNotice\(trx, session, world, 'reauth'\)/)
    const world = runtime.find(({ path }) => path === 'access/world.ts')?.code ?? ''
    expect(world).toMatch(/await requireNotice\(trx, session, world, request\.action\)/)
  })
})
