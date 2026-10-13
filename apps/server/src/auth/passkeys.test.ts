import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ALGORITHMS,
  AuthenticationResponse,
  authenticationOptions,
  loadWebAuthn,
  RegistrationResponse,
  registrationOptions,
  relyingParty,
  uuidBytes,
  verifyAuthentication,
  verifyRegistration,
} from '#src/auth/passkeys.ts'
import { createAuthenticator } from '#src/testing/authenticator.ts'

// The integration test runs full ceremonies through the routes. These cover the options Hearth
// asks for, what it refuses before the library is called, and, with the software authenticator,
// what the library is told to refuse: no user verification, and a signature counter that didn't
// go up.

const HANDLE = 'a1b2c3d4-0000-4000-8000-000000000001'
const rp = relyingParty('https://hearth.example.com')
const credential = (n: number) => ({ credentialId: Buffer.alloc(16, n), transports: ['internal', 'hybrid'] })
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

beforeAll(async () => {
  await loadWebAuthn()
})

const browserRegistration = {
  id: b64url(Buffer.alloc(16, 1)),
  rawId: b64url(Buffer.alloc(16, 1)),
  type: 'public-key',
  response: {
    clientDataJSON: b64url(Buffer.from('{}')),
    attestationObject: b64url(Buffer.alloc(64, 2)),
    transports: ['internal', 'a-transport-from-the-future'],
    publicKeyAlgorithm: -7,
    aNewerField: 'kept out',
  },
  clientExtensionResults: { credProps: { rk: true } },
  authenticatorAttachment: 'platform',
}

const browserAssertion = {
  id: b64url(Buffer.alloc(16, 1)),
  rawId: b64url(Buffer.alloc(16, 1)),
  type: 'public-key',
  response: {
    clientDataJSON: b64url(Buffer.from('{}')),
    authenticatorData: b64url(Buffer.alloc(37)),
    signature: b64url(Buffer.alloc(70, 3)),
  },
  clientExtensionResults: {},
}

describe('ACC-02 passkeys: the relying party and the options Hearth asks for', () => {
  it("is the app's own host, never a parent domain, and expects the app origin exactly", () => {
    expect(rp).toEqual({ rpID: 'hearth.example.com', rpName: 'Hearth', origin: 'https://hearth.example.com' })
    expect(relyingParty('http://localhost:5173').rpID).toBe('localhost')
  })

  it('names a user by their random handle as 16 bytes, never their phone number or person id', () => {
    expect(b64url(uuidBytes(HANDLE))).toBe(Buffer.from('a1b2c3d4000040008000000000000001', 'hex').toString('base64url'))
    expect(uuidBytes(HANDLE)).toHaveLength(16)
  })

  it('asks for user verification, no attestation, three algorithms, and excludes the passkeys already added', async () => {
    const options = await registrationOptions(rp, { handle: HANDLE, name: 'Wei Ling Tan' }, [credential(1)])
    expect(options.rp).toEqual({ id: 'hearth.example.com', name: 'Hearth' })
    expect(options.user).toEqual({ id: b64url(uuidBytes(HANDLE)), name: 'Wei Ling Tan', displayName: 'Wei Ling Tan' })
    expect(options.pubKeyCredParams.map(p => p.alg)).toEqual(ALGORITHMS)
    expect(options.attestation).toBe('none')
    expect(options.timeout).toBe(120_000)
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'preferred', userVerification: 'required' })
    expect(options.excludeCredentials).toEqual([
      { id: b64url(Buffer.alloc(16, 1)), type: 'public-key', transports: ['internal', 'hybrid'] },
    ])
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('asks for an assertion from the person’s own passkeys only, with user verification', async () => {
    const options = await authenticationOptions(rp, [credential(1), credential(2)])
    expect(options.rpId).toBe('hearth.example.com')
    expect(options.userVerification).toBe('required')
    expect(options.allowCredentials?.map(c => c.id)).toEqual([b64url(Buffer.alloc(16, 1)), b64url(Buffer.alloc(16, 2))])
  })
})

describe('ACC-02 passkeys: what a browser may send', () => {
  it("keeps a browser's response to the known fields, dropping newer ones rather than refusing them", () => {
    const parsed = RegistrationResponse.parse(browserRegistration)
    expect(parsed.response).not.toHaveProperty('aNewerField')
    expect(parsed.response.transports).toEqual(['internal', 'a-transport-from-the-future'])
    expect(AuthenticationResponse.parse(browserAssertion).id).toBe(browserAssertion.id)
  })

  it('refuses ids that are not base64url, the wrong type, and oversized fields', () => {
    for (const bad of [
      { ...browserAssertion, id: 'not base64url!' },
      { ...browserAssertion, type: 'password' },
      { ...browserAssertion, id: 'A'.repeat(1401) },
      { ...browserAssertion, response: { ...browserAssertion.response, signature: 'A'.repeat(2049) } },
      { ...browserAssertion, response: { ...browserAssertion.response, userHandle: 'A'.repeat(129) } },
    ]) {
      expect(AuthenticationResponse.safeParse(bad).success).toBe(false)
    }
    expect(
      RegistrationResponse.safeParse({
        ...browserRegistration,
        response: { ...browserRegistration.response, attestationObject: 'A'.repeat(16_385) },
      }).success,
    ).toBe(false)
  })
})

describe('ACC-02 passkeys: verification failures', () => {
  it('answers undefined for a registration that does not verify, logging only the error name', async () => {
    const log = { info: vi.fn() }
    const challenge = 'c'.repeat(43)
    expect(
      await verifyRegistration(rp, RegistrationResponse.parse(browserRegistration), challenge, log),
    ).toBeUndefined()
    expect(log.info).toHaveBeenCalledTimes(1)
    const [line] = log.info.mock.calls[0] ?? []
    expect(line).toMatchObject({ event: 'passkey_registration_failed', error: expect.any(String) })
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(challenge)
  })

  it("refuses an assertion whose user handle is another account's, before verifying it", async () => {
    const log = { info: vi.fn() }
    const other = {
      ...browserAssertion,
      response: { ...browserAssertion.response, userHandle: b64url(uuidBytes(HANDLE)) },
    }
    const stored = { ...credential(1), publicKey: Buffer.alloc(77), counter: 0 }
    const result = await verifyAuthentication(
      rp,
      AuthenticationResponse.parse(other),
      'c'.repeat(43),
      stored,
      'a1b2c3d4-0000-4000-8000-000000000002',
      log,
    )
    expect(result).toBeUndefined()
    expect(log.info).toHaveBeenCalledWith({ event: 'passkey_authentication_failed', error: 'user_handle' })
  })

  it('answers undefined for an assertion that does not verify', async () => {
    const log = { info: vi.fn() }
    const stored = { ...credential(1), publicKey: Buffer.alloc(77), counter: 0 }
    const result = await verifyAuthentication(
      rp,
      AuthenticationResponse.parse(browserAssertion),
      'c'.repeat(43),
      stored,
      HANDLE,
      log,
    )
    expect(result).toBeUndefined()
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'passkey_authentication_failed' }))
  })
})

describe('ACC-02 T14 passkeys: user verification required, and a counter that must go up', () => {
  const log = { info: vi.fn() }

  // A passkey registered through the real options and verification, then stored with `counter`.
  async function registered(counter: number) {
    const authenticator = createAuthenticator(rp.origin)
    const options = await registrationOptions(rp, { handle: HANDLE, name: 'Wei Ling Tan' }, [])
    const added = await verifyRegistration(
      rp,
      RegistrationResponse.parse(authenticator.register(options)),
      options.challenge,
      log,
    )
    if (added === undefined) throw new Error('the control registration did not verify')
    return { authenticator, stored: { ...added, counter } }
  }

  // Asks for an assertion and verifies it against the stored passkey, as the step-up does.
  async function asserted(counter: number, opts: { uv?: boolean; counter?: number } = {}) {
    const { authenticator, stored } = await registered(counter)
    const options = await authenticationOptions(rp, [stored])
    const response = AuthenticationResponse.parse(authenticator.assert(options, opts))
    return verifyAuthentication(rp, response, options.challenge, stored, HANDLE, log)
  }

  it('verifies a user-verified assertion whose counter went up, and answers the new counter', async () => {
    expect(await asserted(0)).toEqual({ newCounter: 1 })
    expect(await asserted(5, { counter: 6 })).toEqual({ newCounter: 6 })
  })

  it('refuses an assertion without user verification (presence alone)', async () => {
    expect(await asserted(0, { uv: false })).toBeUndefined()
  })

  it('refuses a counter that did not go up: a replayed assertion or a cloned authenticator', async () => {
    expect(await asserted(5, { counter: 5 })).toBeUndefined()
    expect(await asserted(5, { counter: 3 })).toBeUndefined()
  })

  it('refuses a registration without user verification', async () => {
    const authenticator = createAuthenticator(rp.origin)
    const options = await registrationOptions(rp, { handle: HANDLE, name: 'Wei Ling Tan' }, [])
    const response = RegistrationResponse.parse(authenticator.register(options, { uv: false }))
    expect(await verifyRegistration(rp, response, options.challenge, log)).toBeUndefined()
  })
})
