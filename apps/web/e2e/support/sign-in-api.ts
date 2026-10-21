// Signing a persona in through the api, for the storage states (T21 items 11 and 13, T20). The same
// calls the sign-in screen makes, from the app's own origin through the preview, so the session
// cookie is the one a browser would get: request a code, read it from the api's log (codes.ts),
// check it, and keep the cookies. Only people who sign in on the code alone may be signed in this
// way: a holder of a PIN role (D46, AQ-02) gets code_verified, and the suite meets the PIN steps in
// sign-in.spec.ts instead.
//
// The request shapes live here and in apps/web/src/sign-in/api.ts only (T21 item 13).
import { request as playwrightRequest } from '@playwright/test'
import { logOffset, readCode } from './codes.ts'
import { E2E_ORIGIN } from './env.ts'
import type { Persona } from './personas.ts'

export async function signInViaApi(persona: Persona, statePath: string): Promise<void> {
  const context = await playwrightRequest.newContext({
    baseURL: E2E_ORIGIN,
    ignoreHTTPSErrors: true,
    // The server refuses a state change whose Origin isn't the app's (CLAUDE.md, Security).
    extraHTTPHeaders: { origin: E2E_ORIGIN },
  })
  try {
    const from = logOffset()
    const requested = await context.post('/api/auth/otp/request', { data: { phone: persona.e164 } })
    if (requested.status() !== 200) throw new Error(`code request for ${persona.name}: ${requested.status()}`)
    const code = await readCode(persona.e164, from)
    const verified = await context.post('/api/auth/otp/verify', { data: { code } })
    const body = (await verified.json()) as { status?: string }
    if (verified.status() !== 200) throw new Error(`code check for ${persona.name}: ${verified.status()}`)
    if (body.status === 'code_verified') {
      throw new Error(`persona ${persona.name} holds a PIN role (AQ-02); a storage state signs in on the code alone`)
    }
    if (body.status !== 'signed_in') throw new Error(`code check for ${persona.name} answered ${body.status}`)
    await context.storageState({ path: statePath })
  } finally {
    await context.dispose()
  }
}
