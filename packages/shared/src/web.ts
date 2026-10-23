// What the web shell reads from the api besides sign-in (T21 item 10, T17 item 11): who is signed
// in, the client flags evaluated for them, and the body of any refusal. Each answer has two
// schemas: a strict one the server types and tests its reply with, and a lenient reading for the
// web app, so a field the server adds later or a value it can't read never breaks the shell.
//
// The server loads this file on Node (T2), and the package compiles with lib ES2024 and no DOM or
// Node types, so it uses neither the URL global nor anything else outside the language.
import { z } from 'zod'
import { FLAG_KEY, FLAG_KEY_MAX, isFlagKey } from './flags.ts'
import { LowerUuid } from './ids.ts'

// The zone a time is shown in when the session answer names none the client can use (OD-10): the
// pilot org's. The server always sends one (the profile's, else the org's, which is NOT NULL).
export const DEFAULT_TIME_ZONE = 'Asia/Singapore'

// people.full_name holds 1 to 200 characters (migration 0002), and Postgres counts code points,
// where a JavaScript string's length counts UTF-16 units: a name of 200 emoji is 400 units long.
// So the name's bound is checked in code points, as the database checked it. Every answer that
// carries a person's name reads it with this (the session's, the registers' recorded and cleared
// by).
const NAME_MAX = 200
const codePoints = (text: string) => [...text].length
export const PersonName = z
  .string()
  .min(1)
  .refine(name => codePoints(name) <= NAME_MAX, { message: `at most ${NAME_MAX} characters` })

// Where someone stands with their org's privacy notice (PDPA-03, ACC-12; C0.9 PD-43, TECH-SPEC
// T22 item 28), read from the latest published version and their acknowledgements of it:
//   acknowledged  they acknowledged the latest version
//   required      a version is published and they haven't acknowledged the latest
//   unpublished   the org has published no version yet (OD-01)
// packages/access's noticeAdmits() decides what each lets through. Defined here, beside the session
// answer that carries it, so notice.ts can build on this file without a cycle.
export const NOTICE_STANDINGS = ['acknowledged', 'required', 'unpublished'] as const
export type NoticeStanding = (typeof NOTICE_STANDINGS)[number]

// GET /api/session (T21 item 10): what the shell needs and nothing more. No phone number and no
// roles: what the person may open is said by capability booleans decided by can(), never by roles.
//   registers  can() allows register.read: the DPO pages and their avatar-menu entry (C0.9 PD-26).
// C0.16 adds more as its screens need them. notice is the person's standing with the current
// privacy notice (C0.9 PD-46): the shell starts the gateway only once it is acknowledged, and sends
// the person to /notice otherwise.
export const SessionResponse = z.strictObject({
  personId: LowerUuid,
  name: PersonName,
  // An IANA zone name, as is_iana_time_zone() admits it (migration 0001); none is near 64 characters.
  timeZone: z.string().min(1).max(64),
  capabilities: z.strictObject({ registers: z.boolean() }),
  notice: z.enum(NOTICE_STANDINGS),
})
export type SessionJSON = z.infer<typeof SessionResponse>

// The web app's reading of the same answer: an empty or missing zone falls back to the pilot's,
// and extra fields are dropped, so neither stops the shell from starting. A capability reads true
// only when the answer says true; missing, of another type or under an unreadable capabilities
// field, it reads false, so the shell offers nothing the server didn't (P6). A standing it can't
// read reads as required, so the shell sends the person to /notice, whose own answer decides
// (C0.9 PD-46).
export const SessionResponseForClient = z.object({
  personId: z.string().min(1),
  name: z.string().min(1),
  timeZone: z.string().min(1).catch(DEFAULT_TIME_ZONE),
  capabilities: z.object({ registers: z.boolean().catch(false) }).catch({ registers: false }),
  notice: z.enum(NOTICE_STANDINGS).catch('required'),
})
export type SessionForClient = z.infer<typeof SessionResponseForClient>

// GET /api/flags (T17 item 11, T21 item 10): the person's own value of each flag the registry marks
// client: true, as a plain boolean. No cohort, no revision and nothing else: whether a flag is on
// for someone else is never the browser's business.
export const FlagsResponse = z.strictObject({
  flags: z.record(z.string().regex(FLAG_KEY).max(FLAG_KEY_MAX), z.boolean()),
})
export type FlagsJSON = z.infer<typeof FlagsResponse>

// The web app's reading of a flags answer (P6: a flag the client can't read is off). Only true
// reads true; any other value reads false; a key that isn't a flag key is dropped; and an answer
// of the wrong shape reads as no flags at all. The record has no prototype, so a key the answer
// doesn't hold (constructor, say) reads undefined, never an inherited value.
export function readFlagsAnswer(value: unknown): Readonly<Record<string, boolean>> {
  const flags: Record<string, boolean> = Object.create(null)
  const answer = isRecord(value) ? value.flags : undefined
  if (isRecord(answer)) {
    for (const [key, on] of Object.entries(answer)) if (isFlagKey(key)) flags[key] = on === true
  }
  return Object.freeze(flags)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Every /api refusal (apps/server/src/auth/errors.ts), read leniently: `error` is the code, and
// `message` the server's copy (MESSAGES). The not-found answers and the root Origin hook's 403
// carry no message ({ error: 'Not Found' }, { error: 'Forbidden' }), so it's optional, and the
// extras beside them (ErrorExtrasSchema) pass through to be read on their own.
export const ApiErrorBody = z
  .object({
    error: z.string().min(1).max(64),
    message: z.string().max(500).optional(),
  })
  .loose()
export type ApiErrorBodyJSON = z.infer<typeof ApiErrorBody>
