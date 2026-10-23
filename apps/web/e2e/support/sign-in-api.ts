// Signing a persona in through the api, for the storage states (T21 items 11 and 13, T20). The same
// calls the sign-in screen makes, from the app's own origin through the preview, so the session
// cookie is the one a browser would get: request a code, read it from the api's log (codes.ts),
// check it, and keep the cookies. signInViaApi signs in only people who sign in on the code alone:
// a holder of a PIN role (D46, AQ-02) gets code_verified, and the suite meets the PIN steps in
// sign-in.spec.ts. signInWithPinViaApi is for a spec that needs a PIN-role holder signed in (the
// DPO, dpo.spec.ts, C0.9 PD-26): after the code it sets the PIN, or enters it if one is set, so the
// session is issued under the PIN rule, as the sign-in screen's would be.
//
// The request shapes live here and in apps/web/src/sign-in/api.ts only (T21 item 13).
import { request as playwrightRequest } from '@playwright/test'
import { logOffset, readCode } from './codes.ts'
import { E2E_ORIGIN } from './env.ts'
import type { Persona } from './personas.ts'

const newContext = () =>
  playwrightRequest.newContext({
    baseURL: E2E_ORIGIN,
    ignoreHTTPSErrors: true,
    // The server refuses a state change whose Origin isn't the app's (CLAUDE.md, Security).
    extraHTTPHeaders: { origin: E2E_ORIGIN },
  })

type Context = Awaited<ReturnType<typeof newContext>>

// Requests a code for the persona, reads it from the api's log and checks it: the check's answer.
async function checkCode(context: Context, persona: Persona): Promise<{ status?: string; next?: string }> {
  const from = logOffset()
  const requested = await context.post('/api/auth/otp/request', { data: { phone: persona.e164 } })
  if (requested.status() !== 200) throw new Error(`code request for ${persona.name}: ${requested.status()}`)
  const code = await readCode(persona.e164, from)
  const verified = await context.post('/api/auth/otp/verify', { data: { code } })
  if (verified.status() !== 200) throw new Error(`code check for ${persona.name}: ${verified.status()}`)
  return (await verified.json()) as { status?: string; next?: string }
}

export async function signInViaApi(persona: Persona, statePath: string): Promise<void> {
  const context = await newContext()
  try {
    const body = await checkCode(context, persona)
    if (body.status === 'code_verified') {
      throw new Error(`persona ${persona.name} holds a PIN role (AQ-02); a storage state signs in on the code alone`)
    }
    if (body.status !== 'signed_in') throw new Error(`code check for ${persona.name} answered ${body.status}`)
    await context.storageState({ path: statePath })
  } finally {
    await context.dispose()
  }
}

// A holder of a PIN role (D46, AQ-02): one code, then the PIN set (a first sign-in) or entered.
export async function signInWithPinViaApi(persona: Persona, pin: string, statePath: string): Promise<void> {
  if (!persona.pinRole) throw new Error(`persona ${persona.name} holds no PIN role; use signInViaApi`)
  const context = await newContext()
  try {
    const body = await checkCode(context, persona)
    if (body.status !== 'code_verified') throw new Error(`code check for ${persona.name} answered ${body.status}`)
    const path = body.next === 'set_pin' ? '/api/auth/pin/set' : '/api/auth/pin/verify'
    const answered = await context.post(path, { data: { pin } })
    const signedIn = (await answered.json()) as { status?: string }
    if (answered.status() !== 200 || signedIn.status !== 'signed_in') {
      throw new Error(`PIN step for ${persona.name}: ${answered.status()} ${signedIn.status}`)
    }
    await context.storageState({ path: statePath })
  } finally {
    await context.dispose()
  }
}
