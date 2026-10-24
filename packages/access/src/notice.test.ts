// The privacy notice's gate (PDPA-03: "nobody can use Hearth until they acknowledge the current
// notice"; ACC-12; C0.9 OD-01, PD-43 to PD-45; TECH-SPEC T22 items 28 to 30): what noticeAdmits()
// lets through in each standing, for the DPO and for everyone else, and what admitsSocket() admits
// to the realtime gateway. Who may read, acknowledge and publish the notice at all is can()'s, in
// roles.test.ts (NTA-05). The server asks this before can() in consider(), actingBy() and the
// gateway's admission (apps/server, NTS-01 and NTS-04).
import { NOTICE_STANDINGS, type NoticeStanding } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { can } from './can.ts'
import { admitsSocket, NOTICE_FREE, NOTICE_SETUP, type NoticeUse, noticeAdmits } from './notice.ts'
import type { AdminRequest, ContentAction, Request, SelfRequest } from './requests.ts'
import { ADMIN_ACTIONS, SELF_ACTIONS, TOPIC_ACTIONS } from './requests.ts'
import { fixtureWorld, human, P } from './testing/index.ts'

const world = fixtureWorld()

// Every content action, so a new one is decided here too: a Record, so leaving one out of
// requests.ts's ContentRequest fails typecheck.
const CONTENT: Record<
  ContentAction | 'member.add' | 'member.remove' | 'set_visibility' | 'share.set' | 'transfer_ownership',
  true
> = {
  read: true,
  post: true,
  join: true,
  leave: true,
  manage: true,
  edit: true,
  delete: true,
  cancel: true,
  comment: true,
  resolve: true,
  view_history: true,
  share: true,
  present: true,
  present_anyway: true,
  trash: true,
  restore: true,
  purge: true,
  set_editors_can_share: true,
  limit_editing: true,
  correct: true,
  view_viewed_by: true,
  accept: true,
  dismiss: true,
  'member.add': true,
  'member.remove': true,
  set_visibility: true,
  'share.set': true,
  transfer_ownership: true,
}

// Every use the gate is asked about: every request's action, re-authentication and a socket.
const USES: readonly NoticeUse[] = [
  ...(Object.keys(CONTENT) as Request['action'][]),
  'create',
  ...([...ADMIN_ACTIONS] as AdminRequest['action'][]),
  ...([...SELF_ACTIONS] as SelfRequest['action'][]),
  ...([...TOPIC_ACTIONS] as Request['action'][]),
  'reauth',
  'gateway',
]

// Ashton holds dpo (with owner); Marcus doesn't; the DPO who has left still has the row, unrevoked.
const DPO = P.ashton
const OTHERS = [P.marcus, P.arjun, P.weiling, P.formerDpo] as const

describe('NTA-01 PDPA-03 C0.9 PD-43 PD-44: every use, in every standing, for the DPO and for everyone else', () => {
  it('NTA-01 PDPA-03: acknowledged lets every use through; required only the free ones, the DPO included', () => {
    for (const person of [DPO, ...OTHERS]) {
      for (const use of USES) {
        expect(noticeAdmits(world, person, use, 'acknowledged'), `${person} ${use}`).toBe(true)
        expect(noticeAdmits(world, person, use, 'required'), `${person} ${use}`).toBe(NOTICE_FREE.has(use))
      }
    }
  })

  it('NTA-01 OD-01 PD-44: before any version, the DPO also gets the setup uses, and nobody else does; the gateway admits nobody', () => {
    for (const use of USES) {
      const free = NOTICE_FREE.has(use)
      expect(noticeAdmits(world, DPO, use, 'unpublished'), use).toBe(free || NOTICE_SETUP.has(use))
      for (const person of OTHERS)
        expect(noticeAdmits(world, person, use, 'unpublished'), `${person} ${use}`).toBe(free)
    }
  })

  it('NTA-01 ACC-05 Rule 6: a DPO whose role was revoked, or who has left, gets no setup use', () => {
    const revoked = fixtureWorld(f => ({
      ...f,
      roles: f.roles.map(r => (r.personId === DPO && r.role === 'dpo' ? { ...r, revokedAt: 1 } : r)),
    }))
    expect(revoked.holds(DPO, 'owner')).toBe(true)
    expect(world.facts.roles.some(r => r.personId === P.formerDpo && r.role === 'dpo' && r.revokedAt === null)).toBe(
      true,
    )
    for (const use of NOTICE_SETUP) {
      expect(noticeAdmits(revoked, DPO, use, 'unpublished'), use).toBe(false)
      expect(noticeAdmits(world, P.formerDpo, use, 'unpublished'), use).toBe(false)
    }
  })

  it('NTA-01: a use the gate doesn’t know passes only once the latest version is acknowledged, where can() still decides it', () => {
    for (const forged of ['privileged.read', 'notice.publish_own', 'register.export', '']) {
      const use = forged as NoticeUse
      expect(noticeAdmits(world, DPO, use, 'unpublished'), forged).toBe(false)
      expect(noticeAdmits(world, DPO, use, 'required'), forged).toBe(false)
      expect(noticeAdmits(world, DPO, use, 'acknowledged'), forged).toBe(true)
    }
  })
})

describe('NTA-02 C0.9 PD-43 PD-44: what is open before acknowledging, exactly', () => {
  it('NTA-02 PD-43: the free uses are the shell’s two GETs, your devices and the notice’s own routes', () => {
    expect([...NOTICE_FREE].sort()).toEqual([
      'devices.list_own',
      'devices.sign_out_own',
      'notice.acknowledge_own',
      'notice.read_own',
      'session.read_own',
    ])
    // Each is a request about your own account that needs no re-authentication, so none reaches
    // anyone else's data and none is refused for a stale stamp (self.ts).
    for (const use of NOTICE_FREE) {
      expect(SELF_ACTIONS.has(use), use).toBe(true)
      expect(can(world, human(P.marcus), { action: use } as Request), use).toBe(true)
    }
    // Passkeys aren't free: adding or removing one changes how the account is signed in to.
    expect(NOTICE_FREE.has('passkeys.add_own')).toBe(false)
    expect(NOTICE_FREE.has('passkeys.remove_own')).toBe(false)
  })

  it('NTA-02 OD-01 PD-44 C0.9 OD-10: the setup uses are the registers, the notice’s admin routes, recording the DPO’s contact and re-authentication, and can() allows each only to a DPO', () => {
    expect([...NOTICE_SETUP].sort()).toEqual([
      'notice.contact.set',
      'notice.publish',
      'notice.read',
      'reauth',
      'register.purpose.set',
      'register.read',
      'register.transfer.set',
    ])
    const requests: AdminRequest[] = [
      { action: 'register.read' },
      { action: 'register.purpose.set', purpose: 'security_audit' },
      { action: 'register.transfer.set', provider: 'twilio', op: 'record' },
      { action: 'notice.read' },
      { action: 'notice.publish' },
      { action: 'notice.contact.set' },
    ]
    expect(requests.map(r => r.action).sort()).toEqual([...NOTICE_SETUP].filter(use => use !== 'reauth').sort())
    const everyone = world.facts.people.map(p => p.id)
    for (const request of requests) {
      expect(ADMIN_ACTIONS.has(request.action), request.action).toBe(true)
      for (const person of everyone) {
        if (can(world, human(person), request, { reauthenticated: true })) {
          expect(world.holds(person, 'dpo'), `${person} ${request.action}`).toBe(true)
        }
      }
      expect(can(world, human(DPO), request, { reauthenticated: true }), request.action).toBe(true)
    }
    // No use is both free and setup, and the gateway is neither.
    for (const use of NOTICE_SETUP) expect(NOTICE_FREE.has(use), use).toBe(false)
    expect(NOTICE_FREE.has('gateway') || NOTICE_SETUP.has('gateway')).toBe(false)
    // C0.9 OD-19 PD-44 PD-76: recording someone's acknowledgement, and listing the people to pick
    // from, are neither: before v0 there is nothing to record, and after it the DPO acknowledges the
    // latest version first. NTA-01 holds both refused to the DPO before v0, as it loops over every
    // admin action.
    for (const use of ['notice.acknowledgement.record', 'notice.people.read'] as const) {
      expect(ADMIN_ACTIONS.has(use), use).toBe(true)
      expect(NOTICE_SETUP.has(use) || NOTICE_FREE.has(use), use).toBe(false)
      expect(noticeAdmits(world, DPO, use, 'unpublished'), use).toBe(false)
      expect(noticeAdmits(world, DPO, use, 'required'), use).toBe(false)
      expect(noticeAdmits(world, DPO, use, 'acknowledged'), use).toBe(true)
    }
  })
})

describe('NTA-03 C0.9 PD-43 PD-44: re-authenticating', () => {
  it('NTA-03 PD-43: re-authentication passes once acknowledged, never while a version waits, and before any version only for the DPO', () => {
    for (const person of [DPO, ...OTHERS]) {
      expect(noticeAdmits(world, person, 'reauth', 'acknowledged'), person).toBe(true)
      expect(noticeAdmits(world, person, 'reauth', 'required'), person).toBe(false)
    }
    expect(noticeAdmits(world, DPO, 'reauth', 'unpublished')).toBe(true)
    // So nobody else can have a re-authentication code sent before v0 (B-03).
    for (const person of OTHERS) expect(noticeAdmits(world, person, 'reauth', 'unpublished'), person).toBe(false)
  })
})

describe('NTA-04 C0.9 PD-45 T19 item 10: the gateway', () => {
  it('NTA-04 PD-45: a socket is admitted only once the latest version is acknowledged, for everyone alike', () => {
    const admits: Record<NoticeStanding, boolean> = { acknowledged: true, required: false, unpublished: false }
    for (const standing of NOTICE_STANDINGS) {
      expect(admitsSocket(standing), standing).toBe(admits[standing])
      for (const person of [DPO, ...OTHERS]) {
        expect(noticeAdmits(world, person, 'gateway', standing), `${person} ${standing}`).toBe(admitsSocket(standing))
      }
    }
  })
})
