// A software WebAuthn authenticator for the integration test (test-only; the image leaves testing/
// out). It answers the server's options the way a phone's synced passkey would: ES256, attestation
// format "none", user present and verified, backed up (BE and BS set). No browser is needed, so
// both of SimpleWebAuthn's verify calls run for real.
//
// Each credential's key pair is made at run time with node:crypto. No key is ever written to a
// file: gitleaks and the checkpoint hook would refuse one.
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'

// Authenticator data flags (WebAuthn §6.1): user present, user verified, backup eligible, backed
// up, and attested credential data included (registration only).
const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40

// A CBOR head (RFC 8949 §3): the major type and the argument, in the shortest form.
function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value])
  if (value < 256) return Buffer.from([(major << 5) | 24, value])
  if (value < 65_536) {
    const bytes = Buffer.alloc(3)
    bytes[0] = (major << 5) | 25
    bytes.writeUInt16BE(value, 1)
    return bytes
  }
  const bytes = Buffer.alloc(5)
  bytes[0] = (major << 5) | 26
  bytes.writeUInt32BE(value, 1)
  return bytes
}

type Cbor = number | string | Buffer | Map<Cbor, Cbor>

// Just enough CBOR for a COSE key and an attestation object: integers, text, bytes and maps.
function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') {
    const text = Buffer.from(value)
    return Buffer.concat([head(3, text.length), text])
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])])
}

const b64url = (bytes: Buffer) => bytes.toString('base64url')
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest()

interface Credential {
  id: Buffer
  privateKey: KeyObject
  // The COSE form of the public key.
  cose: Buffer
  // The user handle the server gave at registration (base64url), returned with every assertion.
  userHandle: string
  counter: number
}

export interface Authenticator {
  // Answers registration options with a new credential, or with the last one again
  // (reuseCredential), as an authenticator that ignored excludeCredentials would. `uv: false`
  // leaves the user-verified flag out: only presence was checked, no device PIN or biometric.
  register(
    options: PublicKeyCredentialCreationOptionsJSON,
    opts?: { reuseCredential?: boolean; uv?: boolean },
  ): RegistrationResponseJSON
  // Answers authentication options with a credential the options allow. `origin` writes another
  // origin into clientDataJSON (a tampered assertion); `userHandle` replaces the handle sent;
  // `uv: false` leaves the user-verified flag out; `counter` sends that signature counter instead
  // of the next one (a cloned authenticator, or a replayed assertion).
  assert(
    options: PublicKeyCredentialRequestOptionsJSON,
    opts?: { origin?: string; userHandle?: string; uv?: boolean; counter?: number },
  ): AuthenticationResponseJSON
}

export function createAuthenticator(origin: string): Authenticator {
  const credentials: Credential[] = []

  function newCredential(userHandle: string): Credential {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = publicKey.export({ format: 'jwk' })
    if (jwk.x === undefined || jwk.y === undefined) throw new Error('the P-256 key has no coordinates')
    // kty EC2 (2), alg ES256 (-7), crv P-256 (1), x, y.
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    )
    return { id: randomBytes(16), privateKey, cose, userHandle, counter: 0 }
  }

  return {
    register(options, opts = {}) {
      const rpId = options.rp.id
      if (rpId === undefined) throw new Error('the registration options name no RP ID')
      let credential = opts.reuseCredential ? credentials.at(-1) : undefined
      if (credential === undefined) {
        credential = newCredential(options.user.id)
        credentials.push(credential)
      }
      const idLength = Buffer.alloc(2)
      idLength.writeUInt16BE(credential.id.length)
      const authData = Buffer.concat([
        sha256(rpId),
        Buffer.from([UP | (opts.uv === false ? 0 : UV) | BE | BS | AT]),
        Buffer.alloc(4),
        // The AAGUID: zeros, as attestation "none" allows.
        Buffer.alloc(16),
        idLength,
        credential.id,
        credential.cose,
      ])
      const clientData = Buffer.from(
        JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }),
      )
      const attestationObject = cbor(
        new Map<Cbor, Cbor>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      )
      return {
        id: b64url(credential.id),
        rawId: b64url(credential.id),
        type: 'public-key',
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: b64url(clientData),
          attestationObject: b64url(attestationObject),
          transports: ['internal', 'hybrid'],
        },
      }
    },

    assert(options, opts = {}) {
      const rpId = options.rpId
      if (rpId === undefined) throw new Error('the authentication options name no RP ID')
      const allowed = new Set((options.allowCredentials ?? []).map(c => c.id))
      const credential = credentials.find(c => allowed.size === 0 || allowed.has(b64url(c.id)))
      if (credential === undefined) throw new Error('this authenticator holds none of the allowed credentials')
      credential.counter += 1
      const counter = Buffer.alloc(4)
      counter.writeUInt32BE(opts.counter ?? credential.counter)
      const authData = Buffer.concat([
        sha256(rpId),
        Buffer.from([UP | (opts.uv === false ? 0 : UV) | BE | BS]),
        counter,
      ])
      const clientData = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: options.challenge,
          origin: opts.origin ?? origin,
          crossOrigin: false,
        }),
      )
      const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), {
        key: credential.privateKey,
        dsaEncoding: 'der',
      })
      return {
        id: b64url(credential.id),
        rawId: b64url(credential.id),
        type: 'public-key',
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: b64url(clientData),
          authenticatorData: b64url(authData),
          signature: b64url(signature),
          userHandle: opts.userHandle ?? credential.userHandle,
        },
      }
    },
  }
}
