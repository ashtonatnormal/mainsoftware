// The dormant passkeys (D46): kept, switched off in production (auth/policy.ts PASSKEYS_ON), and
// switched on here alone, through the harness's passkeysForTests (scripts/guards/
// api-test-overrides.test.ts). This suite keeps the dormant code working, so turning passkeys back
// on is a reviewed change of a constant, not a rewrite. `npm run test:integration` runs it against
// the Compose stack, on a throwaway database and Valkey key prefix of its own.
//
// As in sign-in.integration.test.ts, each test makes its own people and clients, and PRD-53's 3
// code requests per number per 10 minutes aren't loosened: each test's first comment gives every
// person's budget. A passkey stands in for a set PIN, and only privileged holders have PINs, so the
// people who use one are privileged (D46).
//
// afterAll runs the sign-in suite's sweep (testing/leaks.ts): no log line or audit row holds a
// number, code, PIN, session token or attempt id; every /api reply was no-store, held no token or
// attempt id and none was a 500; no Node warning fired. It also checks that every committed write
// had its outbox event (testing/writes.ts), and, when every test ran and passed, that every dormant
// error code and audit action (testing/dormant.ts) and both passkey event types were seen.
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ATTEMPT_COOKIE, SESSION_COOKIE } from '#src/auth/cookies.ts'
import { tag } from '#src/auth/crypto.ts'
import { limitSubject } from '#src/auth/limiter.ts'
import { createAuthenticator } from '#src/testing/authenticator.ts'
import { DORMANT_ACTIONS, DORMANT_ERRORS } from '#src/testing/dormant.ts'
import { expectNothingLeaked } from '#src/testing/leaks.ts'
import { APP_ORIGIN, type Client, type Person, type Stack, startStack } from '#src/testing/stack.ts'
import { everyTestPassed, expectEveryWriteCovered } from '#src/testing/writes.ts'

type CreationOptions = { options: PublicKeyCredentialCreationOptionsJSON }
type RequestOptions = { options: PublicKeyCredentialRequestOptionsJSON }

interface AuditRow {
  action: string
  details: Record<string, unknown>
}

interface EventRow {
  type: string
  actor_id: string
  actor_kind: string
  entity_id: string
  subject_ids: string[]
  purpose: string
  ids: Record<string, unknown>
}

let s: Stack

const requestCode = (client: Client, phone: string) => client.post('/api/auth/otp/request', { phone })
const verifyCode = (client: Client, code: string) => client.post('/api/auth/otp/verify', { code })
const verifyPin = (client: Client, pin: string) => client.post('/api/auth/pin/verify', { pin })

// A PIN that isn't this one.
const another = (digits: string) => String((Number(digits) + 1) % 1_000_000).padStart(6, '0')

const pinOf = (person: Person): string => {
  if (person.pin === undefined) throw new Error('that person has no PIN yet')
  return person.pin
}

async function auditOf(person: Person): Promise<AuditRow[]> {
  return s.query<AuditRow>(
    'select action, details from audit_events where org_id = $1 and target_id = $2 order by id',
    [person.orgId, person.id],
  )
}

// The outbox events about a person, in the order consumers read them (C0.6, T16).
async function eventsOf(person: Person): Promise<EventRow[]> {
  return s.query<EventRow>(
    `select type, actor_id, actor_kind, entity_id, subject_ids, purpose, ids from outbox_events
     where org_id = $1 and (entity_id = $2 or $2 = any(subject_ids)) order by tx_id, id`,
    [person.orgId, person.id],
  )
}

// An event about one person, as the sign-in and passkey routes append them.
const about = (person: Person, type: string, actor: Person, ids: Record<string, unknown> = {}) => ({
  type,
  actor_id: actor.id,
  actor_kind: 'human',
  entity_id: person.id,
  subject_ids: [person.id],
  purpose: 'accounts',
  ids,
})

async function userOf(person: Person): Promise<{ pin_failures: number } | undefined> {
  const [row] = await s.query<{ pin_failures: number }>('select pin_failures from users where id = $1', [person.id])
  return row
}

// A client that has asked for a code for the person and checked it: at the step after the code.
async function atStepUp(person: Person): Promise<{ client: Client; reply: Awaited<ReturnType<Client['post']>> }> {
  const client = s.client()
  const requested = await requestCode(client, person.e164)
  expect(requested.status).toBe(200)
  const reply = await verifyCode(client, await s.sms.nextCode(person.e164))
  expect(reply.status).toBe(200)
  return { client, reply }
}

// Adds a passkey for a signed-in person (signing in counts as a re-authentication). Returns its id.
async function addPasskey(client: Client, authenticator: ReturnType<typeof createAuthenticator>): Promise<string> {
  const options = await client.post('/api/auth/passkeys/register/options', {})
  expect(options.status).toBe(200)
  const registered = await client.post('/api/auth/passkeys/register/verify', {
    response: authenticator.register(options.json<CreationOptions>().options),
  })
  expect(registered.status).toBe(201)
  return registered.json<{ passkey: { id: string } }>().passkey.id
}

describe('D46 the dormant passkeys, switched on for this suite alone (ACC-02, T14 items 9-10)', () => {
  beforeAll(async () => {
    s = await startStack({ passkeysForTests: true })
  })

  // Each test starts with the global SMS cap (PRD-53: 100 texts an hour) empty, as in the sign-in
  // suite.
  beforeEach(async () => {
    if (s !== undefined) await s.valkey.del(s.names.limit('sms-global', 'all'))
  })

  // Vitest needs the first argument destructured; the second is this suite.
  // biome-ignore lint/correctness/noEmptyPattern: the hook takes no fixtures.
  afterAll(async ({}, suite) => {
    if (s === undefined) return
    try {
      // The sign-in suite's own sweep (testing/leaks.ts), over the passkey paths: no log line or
      // audit row holds a number, code, PIN, token or attempt id, every /api reply was no-store
      // with no token or attempt id and none a 500, and no Node warning fired (Web Crypto's
      // included, which only these paths can cause).
      await expectNothingLeaked(s)
      const all = everyTestPassed(suite) && suite.tasks.length > 0
      await expectEveryWriteCovered(s.superuser, 'passkeys', { allPassed: all })
      if (all) {
        const answered = new Set(s.replies.map(reply => reply.error))
        expect([...DORMANT_ERRORS].filter(code => !answered.has(code))).toEqual([])
        const written = new Set(
          (await s.query<{ action: string }>('select distinct action from audit_events')).map(r => r.action),
        )
        expect([...DORMANT_ACTIONS].filter(action => !written.has(action))).toEqual([])
      }
    } finally {
      await s.stop()
    }
  })

  it('D46 ACC-02: a passkey is added, used at step-up while the PIN is locked, used to re-authenticate, and removed', async () => {
    // Budgets: P 3 code requests, W 1. Both privileged: a passkey stands in for a set PIN (D46).
    const p = await s.person({ roles: ['leadership'] })
    const w = await s.person({ roles: ['leadership'], pin: s.newPin() })
    const authenticator = createAuthenticator(APP_ORIGIN)
    type CreationOptions = { options: PublicKeyCredentialCreationOptionsJSON }
    type RequestOptions = { options: PublicKeyCredentialRequestOptionsJSON }

    // Signing in counts as a re-authentication, so a passkey can be added at once.
    const first = await s.signIn(p)
    const options = await first.post('/api/auth/passkeys/register/options', {})
    expect(options.status).toBe(200)
    const created = options.json<CreationOptions>().options
    expect(created.rp).toEqual({ name: 'Hearth', id: 'hearth.test' })
    const registered = await first.post('/api/auth/passkeys/register/verify', {
      response: authenticator.register(created),
    })
    expect(registered.status).toBe(201)
    const passkeyId = registered.json<{ passkey: { id: string; backedUp: boolean } }>().passkey.id
    expect(registered.body).toMatchObject({ passkey: { id: passkeyId, backedUp: true } })
    expect((await auditOf(p)).map(row => row.action)).toContain('auth.passkey_added')
    const again = await first.post('/api/auth/passkeys/register/options', {})
    const duplicate = await first.post('/api/auth/passkeys/register/verify', {
      response: authenticator.register(again.json<CreationOptions>().options, { reuseCredential: true }),
    })
    expect([duplicate.status, duplicate.error]).toEqual([409, 'passkey_exists'])

    // On a new device, with the PIN locked, the passkey stands in for it.
    const { client: second, reply: stepUp } = await atStepUp(p)
    expect(stepUp.body).toMatchObject({ next: 'step_up', passkey: true })
    const wrongPin = another(pinOf(p))
    for (let failures = 1; failures <= 5; failures++) await verifyPin(second, wrongPin)
    const allow = await second.post('/api/auth/passkey/options', {})
    expect(allow.status).toBe(200)
    const request = allow.json<RequestOptions>().options
    const [credential] = await s.query<{ credential_id: Buffer }>('select credential_id from passkeys where id = $1', [
      passkeyId,
    ])
    expect(request.allowCredentials?.map(c => c.id)).toEqual([credential?.credential_id.toString('base64url')])
    const viaPasskey = await second.post('/api/auth/passkey/verify', { response: authenticator.assert(request) })
    expect(viaPasskey.status).toBe(200)
    expect(viaPasskey.body).toMatchObject({ status: 'signed_in' })
    expect((await userOf(p))?.pin_failures).toBe(5)
    const [stored] = await s.query<{ counter: string; last_used_at: Date | null }>(
      'select counter::text, last_used_at from passkeys where id = $1',
      [passkeyId],
    )
    expect(stored?.counter).toBe('1')
    expect(stored?.last_used_at).toBeInstanceOf(Date)
    expect((await auditOf(p)).filter(row => row.action === 'auth.sign_in').map(row => row.details.method)).toContain(
      'sms_passkey',
    )

    // Re-authenticating with the passkey leaves the PIN count alone; its challenge is single-use.
    const reauthOptions = await second.post('/api/auth/reauth/passkey/options', {})
    expect(reauthOptions.status).toBe(200)
    const assertion = authenticator.assert(reauthOptions.json<RequestOptions>().options)
    const reauth = await second.post('/api/auth/reauth/passkey/verify', { response: assertion })
    expect(reauth.status).toBe(200)
    expect(reauth.body).toEqual({ status: 'reauthenticated', validForSeconds: 300 })
    expect((await auditOf(p)).filter(row => row.action === 'auth.reauth').map(row => row.details.method)).toContain(
      'passkey',
    )
    expect((await userOf(p))?.pin_failures).toBe(5)
    const replayed = await second.post('/api/auth/reauth/passkey/verify', { response: assertion })
    expect([replayed.status, replayed.error]).toEqual([401, 'passkey_expired'])

    // A tampered assertion (another origin) fails, and its audit row commits.
    const { client: third } = await atStepUp(p)
    const tamperedOptions = await third.post('/api/auth/passkey/options', {})
    const tampered = await third.post('/api/auth/passkey/verify', {
      response: authenticator.assert(tamperedOptions.json<RequestOptions>().options, { origin: 'https://evil.test' }),
    })
    expect([tampered.status, tampered.error]).toEqual([401, 'passkey_failed'])
    expect((await auditOf(p)).filter(row => row.action === 'auth.passkey_failed')).toHaveLength(1)

    // T14: an assertion without user verification fails, and so does one whose signature counter
    // is the stored one (a replayed assertion, or a cloned authenticator).
    const thirdOptions = async () => (await third.post('/api/auth/passkey/options', {})).json<RequestOptions>().options
    const noUv = await third.post('/api/auth/passkey/verify', {
      response: authenticator.assert(await thirdOptions(), { uv: false }),
    })
    expect([noUv.status, noUv.error]).toEqual([401, 'passkey_failed'])
    const [now] = await s.query<{ counter: string }>('select counter::text from passkeys where id = $1', [passkeyId])
    expect(Number(now?.counter)).toBeGreaterThan(0)
    const cloned = await third.post('/api/auth/passkey/verify', {
      response: authenticator.assert(await thirdOptions(), { counter: Number(now?.counter) }),
    })
    expect([cloned.status, cloned.error]).toEqual([401, 'passkey_failed'])
    expect((await auditOf(p)).filter(row => row.action === 'auth.passkey_failed')).toHaveLength(3)

    // §9.4: adding or removing a passkey needs a re-authentication from the last 5 minutes.
    const { id: sessionId } = await s.sessionOf(second)
    await s.age(sessionId, '4 minutes')
    expect((await second.post('/api/auth/passkeys/register/options', {})).status).toBe(200)
    await s.age(sessionId, '2 minutes')
    const stale = await second.post('/api/auth/passkeys/remove', { passkey: passkeyId })
    expect([stale.status, stale.error]).toEqual([403, 'reauth_required'])
    const staleAdd = await second.post('/api/auth/passkeys/register/options', {})
    expect([staleAdd.status, staleAdd.error]).toEqual([403, 'reauth_required'])
    const fresh = await second.post('/api/auth/reauth/passkey/options', {})
    const refreshed = await second.post('/api/auth/reauth/passkey/verify', {
      response: authenticator.assert(fresh.json<RequestOptions>().options),
    })
    expect(refreshed.status).toBe(200)
    const removed = await second.post('/api/auth/passkeys/remove', { passkey: passkeyId })
    expect(removed.status).toBe(200)
    expect(removed.body).toEqual({ status: 'removed' })
    expect((await auditOf(p)).map(row => row.action)).toContain('auth.passkey_removed')
    // C0.6 T16: the passkey's events, the session's person acting; the passkey's sign-in.
    const events = await eventsOf(p)
    expect(events.filter(event => event.type.startsWith('account.passkey'))).toEqual([
      about(p, 'account.passkey_added', p, { passkey: passkeyId }),
      about(p, 'account.passkey_removed', p, { passkey: passkeyId }),
    ])
    expect(events.filter(event => event.type === 'signin.started').map(event => event.ids.method)).toEqual([
      'sms_new_pin',
      'sms_passkey',
    ])

    // Someone with no passkey is told so at step-up.
    const { client: wc } = await atStepUp(w)
    const none = await wc.post('/api/auth/passkey/options', {})
    expect([none.status, none.error]).toEqual([409, 'no_passkey'])
  })

  it('D46 AQ-05: a privileged passkey sign-in gets a 7-day session and its events, and GET /api/devices lists the passkey', async () => {
    // Budgets: P 2 code requests.
    const p = await s.person({ roles: ['owner'] })
    const authenticator = createAuthenticator(APP_ORIGIN)
    const first = await s.signIn(p)
    const passkeyId = await addPasskey(first, authenticator)

    const { client: second, reply: stepUp } = await atStepUp(p)
    expect(stepUp.body).toMatchObject({ next: 'step_up', passkey: true })
    const allow = await second.post('/api/auth/passkey/options', {})
    const signedIn = await second.post('/api/auth/passkey/verify', {
      response: authenticator.assert(allow.json<RequestOptions>().options),
    })
    expect(signedIn.status).toBe(200)
    const { id: sessionId, deviceId } = await s.sessionOf(second)
    expect(signedIn.setCookies).toEqual([
      `${SESSION_COOKIE}=${second.cookie(SESSION_COOKIE)}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`,
      `${ATTEMPT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    ])
    const [term] = await s.query<{ privileged: boolean }>(
      "select expires_at - created_at = interval '168 hours' as privileged from sessions where id = $1",
      [sessionId],
    )
    expect(term?.privileged).toBe(true)
    expect((await eventsOf(p)).filter(event => event.type === 'signin.started').at(-1)).toEqual(
      about(p, 'signin.started', p, { device: deviceId, session: sessionId, method: 'sms_passkey', privileged: true }),
    )

    const devices = await second.get('/api/devices')
    expect(devices.status).toBe(200)
    expect(devices.body).toMatchObject({ passkeys: [{ id: passkeyId, backedUp: true }] })
  })

  it('D46 I2: a code-only session never re-authenticates with a passkey (409 reauth_method {code})', async () => {
    // Budgets: M 1 code request.
    const m = await s.person()
    const mc = await s.signIn(m)
    for (const path of ['/api/auth/reauth/passkey/options', '/api/auth/reauth/passkey/verify']) {
      const body = path.endsWith('options')
        ? {}
        : {
            response: {
              id: Buffer.alloc(16, 1).toString('base64url'),
              rawId: Buffer.alloc(16, 1).toString('base64url'),
              type: 'public-key',
              response: {
                clientDataJSON: Buffer.from('{}').toString('base64url'),
                authenticatorData: Buffer.alloc(37).toString('base64url'),
                signature: Buffer.alloc(70, 3).toString('base64url'),
              },
              clientExtensionResults: {},
            },
          }
      const reply = await mc.post(path, body)
      expect([reply.status, reply.error, reply.body], path).toMatchObject([409, 'reauth_method', { method: 'code' }])
    }
  })

  it('PRD-53 T14: the passkey steps are refused from an address past its sign-in limit, and after the number is removed', async () => {
    // Budgets: P 1 code request, W 1. Both privileged, to reach the step-up (D46).
    const authIp = '192.0.2.79'
    const p = await s.person({ roles: ['leadership'], pin: s.newPin() })
    const atPin = s.client({ ip: authIp })
    expect((await requestCode(atPin, p.e164)).status).toBe(200)
    expect((await verifyCode(atPin, await s.sms.nextCode(p.e164))).status).toBe(200)
    const key = s.names.limit('auth-ip', tag(s.keys, `ip:${limitSubject(authIp)}`))
    const [seconds] = await s.valkey.time()
    const members: (string | number)[] = []
    for (let i = 0; i < 100; i++) members.push(Number(seconds) * 1000, `seeded-${i}`)
    await s.valkey.zadd(key, ...members)
    await s.valkey.pexpire(key, 86_400_000)
    // The limit is checked before the challenge is read, so a well-formed assertion is enough.
    const assertion = {
      id: Buffer.alloc(16, 1).toString('base64url'),
      rawId: Buffer.alloc(16, 1).toString('base64url'),
      type: 'public-key',
      response: {
        clientDataJSON: Buffer.from('{}').toString('base64url'),
        authenticatorData: Buffer.alloc(37).toString('base64url'),
        signature: Buffer.alloc(70, 3).toString('base64url'),
      },
      clientExtensionResults: {},
    }
    const refused = {
      options: await atPin.post('/api/auth/passkey/options', {}),
      check: await atPin.post('/api/auth/passkey/verify', { response: assertion }),
    }
    for (const [step, reply] of Object.entries(refused)) {
      expect([reply.status, reply.error], step).toEqual([429, 'too_many_requests'])
    }

    // A number removed at the step-up ends the attempt for the passkey steps too.
    const w = await s.person({ roles: ['admin'], pin: s.newPin() })
    const { client: wc } = await atStepUp(w)
    await s.query('update phone_numbers set removed_at = now(), removed_by = $2 where id = $1', [
      w.phoneNumberId,
      s.org.system,
    ])
    expect((await wc.post('/api/auth/passkey/options', {})).error).toBe('attempt_expired')
  })
})
