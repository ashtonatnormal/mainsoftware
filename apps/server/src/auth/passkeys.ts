// Passkeys (ACC-02) through SimpleWebAuthn: a quicker alternative to the PIN at the step after the
// SMS code and at re-authentication, never a way to skip the code. The relying party is the app's
// own host (never a parent domain, which would let a sibling origin such as the user-content one
// run ceremonies), and the expected origin is APP_ORIGIN exactly, the same value the Origin check
// compares. User verification is required, attestation is none, and challenges live in Valkey for
// 2 minutes and are read once (GETDEL).
//
// @simplewebauthn/server is loaded once, when the api role registers its routes (api.ts), with a
// literal dynamic import. The realtime and worker roles never load it (nor the global Reflect
// patch it brings), and a package the image left out fails the api role's start, not the first
// passkey request.
import type * as WebAuthn from '@simplewebauthn/server'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import type { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'

let library: typeof WebAuthn | undefined

export async function loadWebAuthn(): Promise<void> {
  library ??= await import('@simplewebauthn/server')
}

function webauthn(): typeof WebAuthn {
  if (library === undefined) throw new Error('@simplewebauthn/server is loaded when the api routes register')
  return library
}

export interface RelyingParty {
  rpID: string
  rpName: 'Hearth'
  origin: string
}

export function relyingParty(appOrigin: string): RelyingParty {
  return { rpID: new URL(appOrigin).hostname, rpName: 'Hearth', origin: appOrigin }
}

// EdDSA, ES256 and RS256. Naming them keeps the library from probing Node's experimental Web
// Crypto algorithms, which prints warnings outside the JSON logs.
export const ALGORITHMS = [-8, -7, -257]
export const CEREMONY_TIMEOUT_MS = 120_000

// The transports 0006's passkeys.transports accepts; a browser's newer ones are dropped.
const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])
const knownTransports = (transports: readonly string[]): string[] => [
  ...new Set(transports.filter(t => TRANSPORTS.has(t))),
]

export interface StoredCredential {
  credentialId: Buffer
  transports: readonly string[]
}

// A WebAuthn user handle (users.passkey_user_handle, random, never the phone number or the person
// id) as the 16 bytes of its uuid.
export function uuidBytes(uuid: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(uuid.replaceAll('-', ''), 'hex'))
}

const descriptor = (credential: StoredCredential) => ({
  id: credential.credentialId.toString('base64url'),
  transports: [...credential.transports],
})

export function registrationOptions(
  rp: RelyingParty,
  user: { handle: string; name: string },
  exclude: readonly StoredCredential[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return webauthn().generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.name,
    userDisplayName: user.name,
    userID: uuidBytes(user.handle),
    attestationType: 'none',
    excludeCredentials: exclude.map(descriptor),
    supportedAlgorithmIDs: ALGORITHMS,
    timeout: CEREMONY_TIMEOUT_MS,
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  })
}

export interface NewPasskey {
  credentialId: Buffer
  publicKey: Buffer
  counter: number
  transports: string[]
  backedUp: boolean
}

// The new credential, or undefined if the response doesn't verify. A failure is logged with the
// error's name only: its message can quote the challenge.
export async function verifyRegistration(
  rp: RelyingParty,
  response: RegistrationResponse,
  expectedChallenge: string,
  log: Pick<FastifyBaseLogger, 'info'>,
): Promise<NewPasskey | undefined> {
  try {
    const result = await webauthn().verifyRegistrationResponse({
      response: registrationJSON(response),
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    })
    if (!result.verified) {
      log.info({ event: 'passkey_registration_failed', error: 'unverified' })
      return undefined
    }
    const { credential, credentialBackedUp } = result.registrationInfo
    const passkey = {
      credentialId: Buffer.from(credential.id, 'base64url'),
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: knownTransports(credential.transports ?? response.response.transports ?? []),
      backedUp: credentialBackedUp,
    }
    // The sizes 0006's passkeys table accepts, so an odd authenticator is refused here, not by a
    // constraint that would answer 500.
    const fits =
      passkey.credentialId.length >= 16 &&
      passkey.credentialId.length <= 1023 &&
      passkey.publicKey.length >= 32 &&
      passkey.publicKey.length <= 2048
    if (!fits) {
      log.info({ event: 'passkey_registration_failed', error: 'size' })
      return undefined
    }
    return passkey
  } catch (error) {
    log.info({ event: 'passkey_registration_failed', error: errorName(error) })
    return undefined
  }
}

export function authenticationOptions(
  rp: RelyingParty,
  allow: readonly StoredCredential[],
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return webauthn().generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: allow.map(descriptor),
    userVerification: 'required',
    timeout: CEREMONY_TIMEOUT_MS,
  })
}

// The credential's new signature counter, or undefined if the assertion doesn't verify: another
// origin or challenge, no user verification, a counter that went backwards (the library refuses
// one when either value is non-zero), or a user handle that isn't this account's. stored.counter
// is Number(row.counter): a bigint column comes back from pg as a string.
export async function verifyAuthentication(
  rp: RelyingParty,
  response: AuthenticationResponse,
  expectedChallenge: string,
  stored: StoredCredential & { publicKey: Buffer; counter: number },
  userHandle: string,
  log: Pick<FastifyBaseLogger, 'info'>,
): Promise<{ newCounter: number } | undefined> {
  const given = response.response.userHandle
  if (given !== undefined && given.replace(/=+$/, '') !== Buffer.from(uuidBytes(userHandle)).toString('base64url')) {
    log.info({ event: 'passkey_authentication_failed', error: 'user_handle' })
    return undefined
  }
  try {
    const result = await webauthn().verifyAuthenticationResponse({
      response: authenticationJSON(response),
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId.toString('base64url'),
        publicKey: new Uint8Array(stored.publicKey),
        counter: stored.counter,
        transports: [...stored.transports],
      },
    })
    if (!result.verified) {
      log.info({ event: 'passkey_authentication_failed', error: 'unverified' })
      return undefined
    }
    return { newCounter: result.authenticationInfo.newCounter }
  } catch (error) {
    log.info({ event: 'passkey_authentication_failed', error: errorName(error) })
    return undefined
  }
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

// What a browser sends (WebAuthn's RegistrationResponseJSON and AuthenticationResponseJSON),
// bounded. These are ordinary objects, so a browser's newer fields are dropped rather than
// refused; the request body around them is strict (§4).
const base64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/)
const credential = {
  // A credential id is at most 1023 bytes, 1364 characters.
  id: base64url(1400),
  rawId: base64url(1400),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
}

export const RegistrationResponse = z.object({
  ...credential,
  response: z.object({
    clientDataJSON: base64url(4096),
    attestationObject: base64url(16_384),
    transports: z.array(z.string().max(32)).max(8).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64url(4096).optional(),
    authenticatorData: base64url(16_384).optional(),
  }),
})
export type RegistrationResponse = z.infer<typeof RegistrationResponse>

export const AuthenticationResponse = z.object({
  ...credential,
  response: z.object({
    clientDataJSON: base64url(4096),
    authenticatorData: base64url(4096),
    signature: base64url(2048),
    userHandle: base64url(128).optional(),
  }),
})
export type AuthenticationResponse = z.infer<typeof AuthenticationResponse>

// The library reads no client extension results, so none are passed on.
function registrationJSON(response: RegistrationResponse): RegistrationResponseJSON {
  return {
    id: response.id,
    rawId: response.rawId,
    type: response.type,
    response: response.response,
    clientExtensionResults: {},
    ...(response.authenticatorAttachment ? { authenticatorAttachment: response.authenticatorAttachment } : {}),
  }
}

function authenticationJSON(response: AuthenticationResponse): AuthenticationResponseJSON {
  return {
    id: response.id,
    rawId: response.rawId,
    type: response.type,
    response: response.response,
    clientExtensionResults: {},
    ...(response.authenticatorAttachment ? { authenticatorAttachment: response.authenticatorAttachment } : {}),
  }
}
