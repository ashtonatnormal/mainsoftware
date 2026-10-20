// Before every project (T21 item 11): signs in each storage state's persona through
// the api (support/sign-in-api.ts), every run, since every run starts from a new hearth_e2e and no
// saved session can still be valid. The web servers are up by now: Playwright starts them first.
import { mkdirSync } from 'node:fs'
import { AUTH_DIR, stateFile } from './support/env.ts'
import { STATE_PERSONAS } from './support/personas.ts'
import { signInViaApi } from './support/sign-in-api.ts'

export default async function globalSetup(): Promise<void> {
  mkdirSync(AUTH_DIR, { recursive: true })
  // One at a time, so each code's line is read after its own request.
  for (const [state, persona] of Object.entries(STATE_PERSONAS)) await signInViaApi(persona, stateFile(state))
}
