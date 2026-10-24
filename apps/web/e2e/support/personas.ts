// Who the e2e suite signs in as, and how many codes each number costs a run (T21 items 11 and 13;
// PRD-53). Every number here is fictional:
// the Tembusu seed's +65 8000 00NN people (db/seed/tembusu.sql), and numbers in the same +65 8000
// range that no one in the seed holds. This is the only file in e2e/ that may spell a number
// (scripts/guards/e2e-setup.test.ts, ES-11), so every number a spec uses is counted below.
//
// The budget. PRD-53's windows (apps/server/src/auth/policy.ts LIMITS): 3 code requests a number in
// 10 minutes (otp-n10m), 10 a day, 10 checks a number a day, and 30 code requests an IP in 10
// minutes (otp-ip; every request here comes from 127.0.0.1). So:
// - no number is asked for more than twice in a run;
// - a run asks for at most 25 codes in all (this table spends 23);
// - no number is used by two projects that can run at the same time (chromium, webkit and firefox
//   do; global setup runs before them and session-end after), because a second request for a number
//   replaces its code (T14 item 4) and the first test's code would stop working.
// Every run starts from a new hearth_e2e and an empty Valkey DB 9, so every run spends the same.
//
// The personas (T21 item 11): Marcus is the Chromium projects' signed-in state (a Team
// Admin, so he signs in on the code alone, D46); Kelvin is live.spec's own; Priya and Wei Ling hold
// PIN roles (Leadership; Wei Ling is also the Compliance Officer), for the PIN steps (AQ-02); Ashton
// (Owner, DPO) holds PIN roles too, and dpo.spec.ts signs him in once through the api, setting his
// PIN, for the DPO's registers and Notice tab (C0.9 PD-26, PD-48), and session-end.spec.ts once
// more, after every other project, to publish the notice's version 1 (SE-05, PD-55); Nadia is on
// the roster with no account yet (ACC-03: her first sign-in makes it); +65 8000 9999 and the +65
// 8000 90NN numbers are off the roster: they get the same answer and never a text (PRD-53). Ahmad
// (Leadership) and Arjun (Admin, AI Admin) are kept, for C0.16's re-authentication specs.
// CONTACT_PHONE, at the end, is a number no one is asked a code for.

export type Project = 'chromium' | 'webkit' | 'firefox' | 'chromium-session-end'
// Where a code is asked for: global setup (before every project), or a project's tests.
export type Stage = 'global-setup' | Project

export interface Use {
  // The case that asks, by its id.
  readonly what: string
  readonly stage: Stage
  // Code requests this use makes a run.
  readonly requests: number
}

export interface Persona {
  readonly name: string
  readonly e164: string
  // Has a phone_numbers row in the seed.
  readonly roster: boolean
  // Has a users row (has signed in before) and has acknowledged notice v0.
  readonly account: boolean
  // Holds a role only an Owner grants, so signs in with a PIN after the code (D46, AQ-02).
  readonly pinRole: boolean
  readonly uses: readonly Use[]
}

const person = (
  name: string,
  e164: string,
  facts: Pick<Persona, 'roster' | 'account' | 'pinRole'>,
  uses: readonly Use[],
): Persona => ({ name, e164, ...facts, uses })

const member = { roster: true, account: true, pinRole: false } as const
const offRoster = { roster: false, account: false, pinRole: false } as const

export const PERSONAS = {
  marcus: person('Marcus', '+6580000003', member, [
    { what: 'chromium storage state', stage: 'global-setup', requests: 1 },
  ]),
  farah: person('Farah', '+6580000004', member, [{ what: 'webkit storage state', stage: 'global-setup', requests: 1 }]),
  daniel: person('Daniel', '+6580000008', member, [
    { what: 'firefox storage state', stage: 'global-setup', requests: 1 },
  ]),
  kelvin: person('Kelvin', '+6580000011', member, [
    { what: 'live.spec storage state', stage: 'global-setup', requests: 1 },
    { what: 'SI-02 firefox', stage: 'firefox', requests: 1 },
  ]),
  rachel: person('Rachel', '+6580000007', member, [
    { what: 'SI-02 chromium', stage: 'chromium', requests: 1 },
    { what: 'SE-02', stage: 'chromium-session-end', requests: 1 },
  ]),
  huiMin: person('Hui Min', '+6580000009', member, [{ what: 'SI-02 webkit', stage: 'webkit', requests: 1 }]),
  nadia: person('Nadia', '+6580000012', { roster: true, account: false, pinRole: false }, [
    { what: 'SI-10 ACC-03', stage: 'chromium', requests: 1 },
  ]),
  ashton: person('Ashton', '+6580000001', { roster: true, account: true, pinRole: true }, [
    { what: 'DPP-E1 to DPP-E8 PDPA-13 the DPO, the PIN set', stage: 'chromium', requests: 1 },
    { what: 'SE-05 PDPA-03 the DPO publishes the notice', stage: 'chromium-session-end', requests: 1 },
  ]),
  priya: person('Priya', '+6580000002', { roster: true, account: true, pinRole: true }, [
    { what: 'SI-09 AQ-02 set the PIN, sign out, enter it', stage: 'chromium', requests: 2 },
  ]),
  weiLing: person('Wei Ling', '+6580000005', { roster: true, account: true, pinRole: true }, [
    { what: 'SI-11 AQ-02 PRD-53 set the PIN, sign out, lock it', stage: 'chromium', requests: 2 },
  ]),
  offRoster: person('not on the roster', '+6580009999', offRoster, [
    { what: 'SI-03 SI-05', stage: 'chromium', requests: 1 },
  ]),
  si01: person('not on the roster', '+6580009021', offRoster, [{ what: 'SI-01', stage: 'chromium', requests: 1 }]),
  si08: person('not on the roster', '+6580009023', offRoster, [{ what: 'SI-08', stage: 'chromium', requests: 2 }]),
  a11y: person('not on the roster', '+6580009024', offRoster, [{ what: 'A11Y-03', stage: 'chromium', requests: 1 }]),
  a11yWash: person('not on the roster', '+6580009027', offRoster, [
    { what: 'A11Y-04', stage: 'chromium', requests: 1 },
  ]),
  visual: person('not on the roster', '+6580009025', offRoster, [{ what: 'VS-01', stage: 'chromium', requests: 1 }]),
  nfr02: person('not on the roster', '+6580009026', offRoster, [
    { what: 'NF-01 NF-06', stage: 'chromium', requests: 1 },
  ]),
} as const satisfies Record<string, Persona>

export type PersonaKey = keyof typeof PERSONAS

// Whose session each storage state holds (global-setup.ts signs each in through the api, every run).
export const STATE_PERSONAS = {
  chromium: PERSONAS.marcus,
  webkit: PERSONAS.farah,
  firefox: PERSONAS.daniel,
  live: PERSONAS.kelvin,
} as const

// SI-02's roster sign-in, one number per browser project, since the three run at once.
export const SIGN_IN_PERSONAS: Readonly<Record<'chromium' | 'webkit' | 'firefox', Persona>> = {
  chromium: PERSONAS.rachel,
  webkit: PERSONAS.huiMin,
  firefox: PERSONAS.kelvin,
}

// A number as a person types it: the 8 digits of a Singapore number, which the phone step reads as
// +65 (normalisePhone).
export const typed = (persona: Persona): string => persona.e164.replace(/^\+65/, '')

// A number as the code step shows it back, "+65 8000 0003" (formatE164).
export const shown = (persona: Persona): string => persona.e164.replace(/^\+(65)(\d{4})(\d{4})$/, '+$1 $2 $3')

// A fictional PIN for the PIN steps: six digits, not one digit six times, not a run and not a
// common PIN, so the shared policy (pinProblem) accepts it. Not a secret: it guards a throwaway
// database's fictional people.
export const E2E_PIN = '284917'
// A PIN that is wrong for anyone who set E2E_PIN.
export const WRONG_PIN = '739164'

// The DPO's made-up business line, which NTE-01 plants in the contact Settings shows (C0.9 PD-69):
// in the seed's made-up range, held by no one in db/seed/tembusu.sql and by no persona above (NTE-01
// checks both), and never texted: Settings only links it, and no code is asked for it.
export const CONTACT_PHONE = '+65 8000 0199'
