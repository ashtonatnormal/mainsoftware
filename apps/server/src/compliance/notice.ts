// The privacy notice's routes (PDPA-02, PDPA-03, ACC-12; C0.9 PR 2, PD-36, PD-37, PD-42, PD-46,
// PD-48, PD-49; TECH-SPEC T22 items 25 and 26):
//   GET  /api/notice                  your standing, the current version, what changed since the
//                                     last generated version you acknowledged, and your own
//                                     acknowledgements (notice.read_own; /notice and Settings)
//   POST /api/notice/acknowledge      you acknowledge the version you read (notice.acknowledge_own)
//   GET  /api/admin/notice            the DPO's draft: what the registers make now, what holds it
//                                     back and what it warns of, the latest version's count of
//                                     acknowledgements, and the history (notice.read)
//   POST /api/admin/notice/publish    the DPO publishes the draft they previewed (notice.publish)
// and from C0.9 PR 3a (OD-10, OD-19; PD-69, PD-70, PD-75, PD-76; T22 items 38 to 49):
//   GET  /api/admin/notice/contact    the DPO's business contact, and whether the latest version
//                                     prints it (notice.read; its write, POST
//                                     /api/admin/notice/contact/set, is compliance/routes.ts's)
//   GET  /api/admin/notice/people     the people still at the organisation the DPO may record an
//                                     acknowledgement for: names, departments, managers and the
//                                     day each was added, never a number or who has acknowledged
//                                     (notice.people.read)
//   POST /api/admin/notice/acknowledgements/record
//                                     the DPO records that someone else acknowledged the latest
//                                     version outside Hearth, on a day and how
//                                     (notice.acknowledgement.record)
// The two of yours are exempt from the acknowledgement gate (packages/access NOTICE_FREE), so the
// notice can always be read and acknowledged; the DPO's pass it before any version exists, for the
// DPO alone (NOTICE_SETUP, OD-01: the draft, publishing and the contact, which publishing needs),
// and afterwards only once the DPO has acknowledged the latest. Listing the people and recording an
// acknowledgement aren't setup uses: before v0 there is nothing to record (PD-44).
//
// The draft (noticeDraft()) is generated on the server from the registers, in the request's own
// transaction, by packages/shared's generateNotice(), which is pure: the same registers always make
// the same words. Its digest (sha-256 of the words, the generator and the sources) ties what the
// DPO previewed to what is published: the publish route reads and regenerates the draft, refuses one
// with any problem (400 notice_invalid, the free-text check included, which publish_notice() leaves
// to this route, its one caller: C0.9 PD-62, B-14) or a digest the page didn't preview (409
// notice_changed), and then publish_notice() (migration 0010) locks the registers and the latest
// version and refuses unless the sources are still the ones the draft was made from. The registers'
// own answer reads the same draft for its notice marker (compliance/routes.ts).
//
// From PR 3a every generated version prints the DPO's business contact (generator c09.2, OD-11):
// the draft reads the current settings version (dpo_settings) into the generator's input, and
// publish_notice() (migration 0011) locks and compares it as one more source and links the version
// to it, so GET /api/notice answers the contact the latest version printed, from the same row.
//
// The answers carry ids, numbers, the notice's own words, the DPO's role contact and the names of
// who published, never anyone's number or who has acknowledged: the DPO sees a count (data
// minimisation, PD-48), and the people they may record for by name, never by standing (PD-76).
import { createHash } from 'node:crypto'
import {
  AcknowledgeBody,
  type AcknowledgeResponseJSON,
  aiCopyIn,
  type Basis,
  type ContactAdminJSON,
  type ContactRowJSON,
  type ContactStated,
  type DpoContact,
  flatText,
  generateNotice,
  isAiProvider,
  isProviderKey,
  NON_AI_PROVIDERS,
  NON_AI_PURPOSE_KEYS,
  NOTICE_GENERATOR,
  NOTICE_HISTORY_MAX,
  NOTICE_MINE_MAX,
  NOTICE_PEOPLE_MAX,
  type NoticeAdminJSON,
  type NoticeChangesJSON,
  type NoticeClearance,
  type NoticeContactJSON,
  type NoticeFacts,
  type NoticeInput,
  type NoticeJSON,
  type NoticePeopleJSON,
  type NoticeProblem,
  type NoticePurpose,
  type NoticeSources,
  type NoticeStanding,
  type NoticeWarning,
  noticeChanges,
  noticeDigestText,
  noticeDraftSources,
  noticeProblems,
  noticeSaysTheSame,
  noticeWarnings,
  type ProviderKey,
  type PublishBody,
  type PublishResponseJSON,
  type PurposeKey,
  type PurposeStatus,
  type RecordAcknowledgementBody,
  TRAINING,
} from '@hearth/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sql } from 'kysely'
import type { z } from 'zod'
import { authorise, consider } from '#src/access/world.ts'
import type { Api } from '#src/api.ts'
import { ApiError } from '#src/auth/errors.ts'
import { authenticate, inSession, requireSession, type SessionIds, signedOut } from '#src/auth/sessions.ts'
import type { InOrg } from '#src/db/database.ts'
import {
  INSUFFICIENT_PRIVILEGE,
  INVALID_PARAMETER,
  NOTICE_CHANGED,
  NOTICE_INVALID,
  sqlstateOf,
} from '#src/db/sqlstate.ts'
import { type Answer, parse, type ReqInfo, requestInfo, send } from '#src/http.ts'
import { appendOutbox } from '#src/outbox/append.ts'
import { keepCookie } from '#src/web/routes.ts'

// The codes the notice's routes and its gate answer, which the notice suite must see (and the
// sign-in suite's sweep of every code leaves to it).
export const NOTICE_ERRORS = ['notice_required', 'notice_changed', 'notice_invalid'] as const

// --- Reading the registers and the versions -------------------------------------------------------

// A version as the draft and the answers need it: its row, who published it (none for Hearth's, or
// a stand-in written as Hearth), and what it was built from.
export interface NoticeVersionRead {
  id: string
  version: number
  publishedAt: string
  publishedBy: string | null
  generated: boolean
  body: string
  sources: NoticeSources
}

// What the registers make now (C0.9 PD-36, PD-37): today in the org's zone, the generator's input,
// the DPO's current contact as its page shows it (null until one is recorded: C0.9 PD-70), the
// latest version (null while none is published), the number the draft would get, its words and
// digest (null while it can't be written or shown: UNSHOWN below), its sources, what holds it
// back, what it warns of, what changed since the latest version, and whether the published notice
// already says it.
export interface NoticeDraft {
  today: string
  input: NoticeInput
  contact: ContactRead | null
  latest: NoticeVersionRead | null
  version: number
  body: string | null
  digest: string | null
  sources: NoticeSources
  problems: NoticeProblem[]
  warnings: NoticeWarning[]
  changes: NoticeChangesJSON | null
  upToDate: boolean
}

type PurposeRow = {
  purpose: string
  version: number
  status: PurposeStatus
  basis: Basis | null
  basis_reference: string | null
  retention: string | null
  providers: string[]
}
type ClearanceRow = { id: string; provider: string; facts: unknown; review_on: string | null }
type VersionRow = {
  id: string
  version: number
  published_at: Date
  published_by: string | null
  generator: string | null
  body: string
  // The DPO's settings version it printed (C0.9 PD-66; none on a stand-in or a c09.1 version).
  dpo_settings_version: number | null
}
type ContactRow = { title: string; email: string | null; phone: string | null; postal: string | null }

// The DPO's current settings version (its highest) with their business contact, the day it was
// recorded in the org's zone and who recorded it, from the roster (C0.9 OD-10, PD-63, PD-70).
export type ContactRead = ContactRowJSON

// The current contact, in one statement, or null until the DPO records one. The draft's input and
// the contact page's answer read it.
export async function readContact(trx: InOrg, orgId: string): Promise<ContactRead | null> {
  const { rows } = await sql<ContactRow & { version: number; recorded_on: string; recorded_by: string | null }>`
    select s.version, s.contact_title as title, s.contact_email as email, s.contact_phone as phone,
      s.contact_postal as postal, ((s.recorded_at at time zone o.time_zone)::date)::text as recorded_on,
      p.full_name as recorded_by
    from dpo_settings s
    join orgs o on o.id = s.org_id
    left join people p on p.org_id = s.org_id and p.id = s.recorded_by
    where s.org_id = ${orgId}
    order by s.version desc
    limit 1`.execute(trx)
  const row = rows[0]
  if (row === undefined) return null
  return {
    version: row.version,
    title: row.title,
    email: row.email,
    phone: row.phone,
    postal: row.postal,
    recordedOn: row.recorded_on,
    recordedBy: row.recorded_by,
  }
}

const contactOf = (row: ContactRow): DpoContact => ({
  title: row.title,
  email: row.email,
  phone: row.phone,
  postal: row.postal,
})

const isNonAiPurpose = (key: string): key is PurposeKey => (NON_AI_PURPOSE_KEYS as readonly string[]).includes(key)
const isNonAiProvider = (key: string): key is ProviderKey =>
  isProviderKey(key) && !isAiProvider(key) && (NON_AI_PROVIDERS as readonly string[]).includes(key)

// A clearance's facts snapshot (transfer_register_facts(), migration 0009) as the stated facts the
// generator and the comparisons read: notice_facts()'s keys (NOTICE_TRANSFER_FACTS, which check 6
// holds equal), by NOTICE_FACT_FIELDS' names. A value of the wrong shape reads as not recorded, so
// nothing is claimed from it.
export function noticeFactsFrom(snapshot: unknown): NoticeFacts {
  const facts = typeof snapshot === 'object' && snapshot !== null ? (snapshot as Record<string, unknown>) : {}
  const text = (value: unknown) => (typeof value === 'string' ? value : null)
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((code): code is string => typeof code === 'string') : []
  return {
    services: text(facts.services),
    dataTypes: text(facts.data_types),
    processingCountries: list(facts.processing_countries),
    storageCountries: list(facts.storage_countries),
    training: TRAINING.find(value => value === facts.training) ?? null,
    providerRetention: text(facts.provider_retention),
    onwardRecipients: text(facts.onward_recipients),
  }
}

// The current entry (its highest version) of every purpose outside the AI layer, in the generator's
// shape. An AI provider never reaches a non-AI purpose (0009 refuses listing one), and is left off
// if it somehow did, as the registers' answer leaves it off (C0.9 PD-27).
async function readPurposes(trx: InOrg, orgId: string): Promise<NoticePurpose[]> {
  const { rows } = await sql<PurposeRow>`
    select distinct on (purpose) purpose, version, status, basis, basis_reference, retention, providers
    from processing_register
    where org_id = ${orgId} and not ai
    order by purpose, version desc`.execute(trx)
  return rows.flatMap(row =>
    isNonAiPurpose(row.purpose)
      ? [
          {
            key: row.purpose,
            version: row.version,
            status: row.status,
            basis: row.basis,
            basisReference: row.basis_reference,
            retention: row.retention,
            providers: row.providers.filter(isNonAiProvider),
          },
        ]
      : [],
  )
}

// Every open clearance of a provider outside the AI layer (at most one each,
// transfer_clearances_open), with the facts it rests on and its entry's review date.
async function readClearances(trx: InOrg, orgId: string): Promise<NoticeClearance[]> {
  const { rows } = await sql<ClearanceRow>`
    select c.id, c.provider, c.facts, t.review_on::text as review_on
    from transfer_clearances c
    join transfer_register t on t.org_id = c.org_id and t.id = c.entry_id
    where c.org_id = ${orgId} and c.withdrawn_at is null and not t.ai
    order by c.provider`.execute(trx)
  return rows.flatMap(row =>
    isNonAiProvider(row.provider)
      ? [{ id: row.id, provider: row.provider, facts: noticeFactsFrom(row.facts), reviewOn: row.review_on }]
      : [],
  )
}

// What each of these versions lists (PD-34): its purposes at their register versions, and its
// clearances with the facts each rests on, from the link tables; and the DPO's settings version it
// printed, with the contact (C0.9 PD-66), or none.
async function readSources(
  trx: InOrg,
  orgId: string,
  versions: readonly VersionRow[],
): Promise<Map<string, NoticeSources>> {
  const sources = new Map<string, NoticeSources>()
  if (versions.length === 0) return sources
  const ids = versions.map(version => version.id)
  const { rows: purposes } = await sql<{ notice_version_id: string; purpose: string; register_version: number }>`
    select notice_version_id, purpose, register_version from notice_version_purposes
    where org_id = ${orgId} and notice_version_id = any(${ids}::uuid[])`.execute(trx)
  const { rows: clearances } = await sql<{ notice_version_id: string; id: string; provider: string; facts: unknown }>`
    select l.notice_version_id, c.id, c.provider, c.facts
    from notice_version_providers l
    join transfer_clearances c on c.org_id = l.org_id and c.id = l.clearance_id
    where l.org_id = ${orgId} and l.notice_version_id = any(${ids}::uuid[])`.execute(trx)
  const printed = versions.flatMap(version =>
    version.dpo_settings_version === null ? [] : [version.dpo_settings_version],
  )
  const { rows: contacts } =
    printed.length === 0
      ? { rows: [] }
      : await sql<ContactRow & { version: number }>`
          select version, contact_title as title, contact_email as email, contact_phone as phone,
            contact_postal as postal
          from dpo_settings
          where org_id = ${orgId} and version = any(${printed}::integer[])`.execute(trx)
  for (const version of versions) {
    const contact = contacts.find(row => row.version === version.dpo_settings_version)
    sources.set(version.id, {
      generator: version.generator,
      body: version.body,
      purposes: purposes
        .filter(link => link.notice_version_id === version.id)
        .flatMap(link => (isNonAiPurpose(link.purpose) ? [{ key: link.purpose, version: link.register_version }] : [])),
      clearances: clearances
        .filter(link => link.notice_version_id === version.id)
        .flatMap(link =>
          isNonAiProvider(link.provider)
            ? [{ id: link.id, provider: link.provider, facts: noticeFactsFrom(link.facts) }]
            : [],
        ),
      contact: contact === undefined ? null : { version: contact.version, facts: contactOf(contact) },
    })
  }
  return sources
}

const versionRead = (row: VersionRow, sources: NoticeSources | undefined): NoticeVersionRead => ({
  id: row.id,
  version: row.version,
  publishedAt: row.published_at.toISOString(),
  publishedBy: row.published_by,
  generated: row.generator !== null,
  body: row.body,
  sources: sources ?? { generator: row.generator, body: row.body, purposes: [], clearances: [], contact: null },
})

// The org's latest version, with who published it from the roster (none when Hearth did).
async function readLatest(trx: InOrg, orgId: string): Promise<NoticeVersionRead | null> {
  const { rows } = await sql<VersionRow>`
    select v.id, v.version, v.published_at, p.full_name as published_by, v.generator, v.body,
      v.dpo_settings_version
    from notice_versions v
    left join people p on p.org_id = v.org_id and p.id = v.published_by
    where v.org_id = ${orgId}
    order by v.version desc
    limit 1`.execute(trx)
  const row = rows[0]
  if (row === undefined) return null
  return versionRead(row, (await readSources(trx, orgId, [row])).get(row.id))
}

// The problems after which the draft is neither written nor shown: an entry it can't state (no
// basis or retention, or a basis no version states yet), no contact for the DPO, without which
// "Your rights" can't be written (C0.9 PD-68), and free text the screens keep off (AI_COPY, PD-62),
// which the preview would otherwise show the DPO. A purpose on deemed consent by conduct that
// CONDUCT_WITHDRAWABLE doesn't name (purpose_conduct_unstoppable, PD-86) is written and previewed:
// only publishing is held back.
const UNSHOWN: ReadonlySet<NoticeProblem['code']> = new Set([
  'purpose_basis_missing',
  'purpose_retention_missing',
  'purpose_consent_basis',
  'dpo_contact_pending',
  'free_text_ai_copy',
])

// sha-256, in hex, of what the digest covers (packages/shared noticeDigestText()).
export const noticeDigest = (sources: NoticeSources): string =>
  createHash('sha256').update(noticeDigestText(sources)).digest('hex')

// The draft the registers and the DPO's current contact make now, read with plain statements in the
// caller's transaction (no lock: publish_notice() locks and compares what this read). A statement
// each, so at READ COMMITTED a change committing between them makes a draft whose sources disagree
// with the registers or the contact, which publish_notice() refuses (HF007), and the page reloads.
export async function noticeDraft(trx: InOrg, orgId: string): Promise<NoticeDraft> {
  const { rows } = await sql<{ name: string; today: string }>`
    select name, ((now() at time zone time_zone)::date)::text as today from orgs where id = ${orgId}`.execute(trx)
  const org = rows[0]
  // Past can() the org exists.
  if (org === undefined) throw new ApiError(404, 'not_found')
  const contact = await readContact(trx, orgId)
  const input: NoticeInput = {
    org: org.name,
    purposes: await readPurposes(trx, orgId),
    clearances: await readClearances(trx, orgId),
    contact: contact === null ? null : { version: contact.version, ...contactOf(contact) },
  }
  const latest = await readLatest(trx, orgId)
  const problems = noticeProblems(input, latest?.sources ?? null)
  const warnings = noticeWarnings(input, latest?.sources ?? null, org.today)
  const body = problems.some(problem => UNSHOWN.has(problem.code)) ? null : generateNotice(input)
  const sources = noticeDraftSources(input, body)
  return {
    today: org.today,
    input,
    contact,
    latest,
    version: latest === null ? 0 : latest.version + 1,
    body,
    digest: body === null ? null : noticeDigest(sources),
    sources,
    problems,
    warnings,
    changes: latest === null ? null : { since: latest.version, ...noticeChanges(latest.sources, sources) },
    upToDate: latest !== null && body !== null && noticeSaysTheSame(sources, latest.sources),
  }
}

// What the notice marker on the register pages says (C0.9 PD-48): none before any version, up to
// date while the latest version says what the draft would (the same words and purposes, and every
// provider's stated facts: a provider cleared again on the same facts only warns, same_text), out
// of date otherwise (a stand-in as the latest always is).
export function noticeStatusOf(draft: Pick<NoticeDraft, 'latest' | 'upToDate'>): 'none' | 'up_to_date' | 'out_of_date' {
  if (draft.latest === null) return 'none'
  return draft.upToDate ? 'up_to_date' : 'out_of_date'
}

// --- The functions' refusals ----------------------------------------------------------------------

// What publish_notice(), acknowledge_notice() and record_notice_acknowledgement() refuse with, as
// the api answers it (C0.9 PD-52, PD-71). A lock not granted in time (55P03) or a deadlock is the
// api's 409 try_again already (auth/errors.ts fromDatabase). 42501 is the publisher's and the
// recorder's 403, in the api's own words (notice_check_dpo()'s message speaks of publishing);
// acknowledging answers its own (signed_out).
function refusalOf(error: unknown, insufficient: () => ApiError): ApiError | undefined {
  switch (sqlstateOf(error)) {
    case NOTICE_CHANGED:
      return new ApiError(409, 'notice_changed')
    case NOTICE_INVALID:
      return new ApiError(400, 'notice_invalid')
    case INVALID_PARAMETER:
      return new ApiError(404, 'not_found')
    case INSUFFICIENT_PRIVILEGE:
      return insufficient()
    default:
      return undefined
  }
}

async function refusing<T>(work: Promise<T>, insufficient: () => ApiError): Promise<T> {
  try {
    return await work
  } catch (error) {
    throw refusalOf(error, insufficient) ?? error
  }
}

// --- GET /api/notice ------------------------------------------------------------------------------

type MineRow = {
  version: number
  acknowledged_at: Date
  method: 'in_app' | 'recorded_by_dpo'
  acknowledged_on: string | null
  recorded_note: string | null
}
// The latest version, whether you acknowledged it, and the contact it printed (all null for none).
type CurrentRow = VersionRow & {
  acknowledged: boolean
  contact_title: string | null
  contact_email: string | null
  contact_phone: string | null
  contact_postal: string | null
}

// The contact a version printed, from its row's join, or none (a stand-in, a c09.1 version).
function printedContact(row: CurrentRow): NoticeContactJSON | null {
  if (row.contact_title === null) return null
  return { title: row.contact_title, email: row.contact_email, phone: row.contact_phone, postal: row.contact_postal }
}

// Your standing, the current version with the DPO's contact it printed, what changed since you last
// acknowledged a generated one, and your own acknowledgements, newest version first, with the day
// and the note of one the DPO recorded (C0.9 PD-69, PD-75). In a read-only transaction that leaves
// the session's last use alone: /notice polls it every 30 s while visible (PD-46), as the shell
// polls its flags (OD-14). The standing and the contact are read with the latest version, in one
// statement, by the rule notice-standing.ts reads it by, so none of them disagree within an answer
// (Settings shows that contact, PD-69). The person is named, so a tab whose cookie now holds
// someone else's session ends its document (B-11).
export async function readNotice(api: Api, session: SessionIds, info: ReqInfo): Promise<Answer> {
  const { orgId, userId } = session
  const body = await inSession(
    api,
    info,
    session,
    async (trx): Promise<NoticeJSON> => {
      const { verdict } = await consider(trx, session, { action: 'notice.read_own' }, { lock: false })
      // The action's one refusal is someone no longer at the org, whose sessions a deactivation ends
      // in the same commit: an ended session, as readOwn() answers it (web/session.ts).
      if (verdict !== 'allowed') throw new ApiError(401, 'signed_out')
      const { rows: latestRows } = await sql<CurrentRow>`
        select v.id, v.version, v.published_at, null::text as published_by, v.generator, v.body,
          v.dpo_settings_version,
          exists (select 1 from notice_acknowledgments a
            where a.org_id = v.org_id and a.person_id = ${userId} and a.notice_version_id = v.id) as acknowledged,
          s.contact_title, s.contact_email, s.contact_phone, s.contact_postal
        from notice_versions v
        left join dpo_settings s on s.org_id = v.org_id and s.version = v.dpo_settings_version
        where v.org_id = ${orgId}
        order by v.version desc
        limit 1`.execute(trx)
      const current = latestRows[0]
      const standing: NoticeStanding =
        current === undefined ? 'unpublished' : current.acknowledged ? 'acknowledged' : 'required'
      // Up to the version this answer shows: each statement reads afresh (READ COMMITTED), so a
      // version published and acknowledged since the read above never lists here as acknowledged
      // while the answer asks for the older one.
      const { rows: mine } = await sql<MineRow>`
        select v.version, a.acknowledged_at, a.method, a.acknowledged_on::text as acknowledged_on, a.recorded_note
        from notice_acknowledgments a
        join notice_versions v on v.org_id = a.org_id and v.id = a.notice_version_id
        where a.org_id = ${orgId} and a.person_id = ${userId} and v.version <= ${current?.version ?? -1}
        order by v.version desc, a.acknowledged_at desc
        limit ${NOTICE_MINE_MAX}`.execute(trx)
      let changes: NoticeChangesJSON | null = null
      if (current !== undefined && current.generator !== null) {
        // The last generated version you acknowledged before this one.
        const { rows: before } = await sql<VersionRow>`
          select v.id, v.version, v.published_at, null::text as published_by, v.generator, v.body,
            v.dpo_settings_version
          from notice_versions v
          where v.org_id = ${orgId} and v.generator is not null and v.version < ${current.version}
            and exists (select 1 from notice_acknowledgments a
              where a.org_id = v.org_id and a.person_id = ${userId} and a.notice_version_id = v.id)
          order by v.version desc
          limit 1`.execute(trx)
        const since = before[0]
        if (since !== undefined) {
          const sources = await readSources(trx, orgId, [since, current])
          const was = sources.get(since.id)
          const now = sources.get(current.id)
          if (was !== undefined && now !== undefined) {
            changes = { since: since.version, ...noticeChanges(was, now) }
          }
        }
      }
      return {
        person: userId,
        standing,
        current:
          current === undefined
            ? null
            : {
                id: current.id,
                version: current.version,
                publishedAt: current.published_at.toISOString(),
                body: current.body,
              },
        contact: current === undefined ? null : printedContact(current),
        changes,
        mine: mine.map(row => ({
          version: row.version,
          acknowledgedAt: row.acknowledged_at.toISOString(),
          method: row.method,
          acknowledgedOn: row.acknowledged_on,
          note: row.recorded_note,
        })),
      }
    },
    { readOnly: true, touch: false },
  )
  return { body }
}

// --- POST /api/notice/acknowledge -----------------------------------------------------------------

// You acknowledge the version you read, on this session's device (never one the request names),
// through acknowledge_notice() (0010), which re-reads you and the device FOR SHARE and refuses any
// version but the latest (HF007, 409 notice_changed: /notice reloads and shows the newer one). A
// second acknowledgement records nothing and appends nothing. A person or device the function finds
// gone is a session that has ended (401 signed_out, clearing the cookie), and a version that isn't
// the org's is 404.
export async function acknowledgeNotice(
  api: Api,
  body: z.output<typeof AcknowledgeBody>,
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const { orgId, userId } = session
  const answer = await inSession(api, info, session, async (trx): Promise<AcknowledgeResponseJSON> => {
    const { verdict } = await consider(trx, session, { action: 'notice.acknowledge_own' })
    if (verdict !== 'allowed') throw signedOut()
    const { rows } = await refusing(
      sql<{ version: number; changed: boolean }>`
        select version, changed from public.acknowledge_notice(${body.notice}::uuid, ${info.requestId},
          ${session.deviceId}::uuid, ${info.ip}::inet)`.execute(trx),
      signedOut,
    )
    const row = rows[0]
    if (row === undefined) throw new Error('acknowledge_notice() returned no row')
    if (row.changed) {
      await appendOutbox(trx, {
        orgId,
        type: 'notice.acknowledged',
        entity: { type: 'person', id: userId },
        subjects: [userId],
        purpose: 'accounts',
        ids: { notice: body.notice, version: row.version },
      })
    }
    return { version: row.version, changed: row.changed }
  })
  return { body: answer }
}

// --- GET /api/admin/notice ------------------------------------------------------------------------

type HistoryRow = { id: string; version: number; published_at: Date; published_by: string | null; generated: boolean }

// The DPO's Notice tab (C0.9 PD-48): the draft, the latest version with how many of the people
// still at the organisation have acknowledged it (a count, never names), and up to 100 versions,
// newest first. In a read-only transaction; the request counts as use of the session.
export async function readNoticeAdmin(api: Api, session: SessionIds, info: ReqInfo): Promise<Answer> {
  const { orgId } = session
  const body = await inSession(
    api,
    info,
    session,
    async (trx): Promise<NoticeAdminJSON> => {
      await authorise(trx, session, { action: 'notice.read' }, 'forbidden', { lock: false })
      const draft = await noticeDraft(trx, orgId)
      let latest: NoticeAdminJSON['latest'] = null
      if (draft.latest !== null) {
        // One statement, so the count acknowledged is never more than the people counted.
        const { rows } = await sql<{ people: number; acknowledged: number }>`
          select count(*)::int as people,
            count(*) filter (where exists (select 1 from notice_acknowledgments a
              where a.org_id = p.org_id and a.person_id = p.id and a.notice_version_id = ${draft.latest.id}))::int
              as acknowledged
          from people p
          where p.org_id = ${orgId} and p.deactivated_at is null`.execute(trx)
        const counts = rows[0] ?? { people: 0, acknowledged: 0 }
        latest = {
          id: draft.latest.id,
          version: draft.latest.version,
          publishedAt: draft.latest.publishedAt,
          publishedBy: draft.latest.publishedBy,
          generated: draft.latest.generated,
          acknowledged: counts.acknowledged,
          people: counts.people,
        }
      }
      const { rows: history } = await sql<HistoryRow>`
        select v.id, v.version, v.published_at, p.full_name as published_by, v.generator is not null as generated
        from notice_versions v
        left join people p on p.org_id = v.org_id and p.id = v.published_by
        where v.org_id = ${orgId}
        order by v.version desc
        limit ${NOTICE_HISTORY_MAX}`.execute(trx)
      return {
        today: draft.today,
        latest,
        draft: {
          version: draft.version,
          body: draft.body,
          digest: draft.digest,
          problems: draft.problems,
          warnings: draft.warnings,
          changes: draft.changes,
          upToDate: draft.upToDate,
        },
        history: history.map(row => ({
          id: row.id,
          version: row.version,
          publishedAt: row.published_at.toISOString(),
          publishedBy: row.published_by,
          generated: row.generated,
        })),
      }
    },
    { readOnly: true },
  )
  return { body }
}

// --- POST /api/admin/notice/publish ---------------------------------------------------------------

// The DPO publishes the draft they previewed (C0.9 PD-36, PD-37), with a fresh PIN (PD-30), in one
// transaction: can() decides (notice.publish); the draft is read and regenerated; a seen that isn't
// the latest version or a digest that isn't the draft's is 409 notice_changed (the page shows the
// new draft), and any problem 400 notice_invalid (the page lists them: no contact for the DPO and a
// purpose on deemed consent by conduct no procedure stops among them, from C0.9 PR 3a); then
// publish_notice() locks the registers, the DPO's contact and the latest version, refuses sources
// that moved (HF007) or a rule (HF008), writes the version, its links and the audit row; and
// notice.published goes to the outbox in the same transaction (T16). Everyone, the DPO included,
// then acknowledges the new version before using Hearth again (PD-39): REST at once, sockets within
// a periodic check.
export async function publishNotice(
  api: Api,
  body: z.output<typeof PublishBody>,
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const { orgId } = session
  const answer = await inSession(api, info, session, async (trx): Promise<PublishResponseJSON> => {
    await authorise(trx, session, { action: 'notice.publish' }, 'forbidden')
    const draft = await noticeDraft(trx, orgId)
    if (body.seen !== (draft.latest?.version ?? null)) throw new ApiError(409, 'notice_changed')
    if (draft.problems.length > 0 || draft.body === null) throw new ApiError(400, 'notice_invalid')
    // The free-text rule (free_text_ai_copy) is among the problems above, and only here:
    // publish_notice() is this route's alone (scripts/guards/api-test-overrides.test.ts), so SQL
    // doesn't repeat it (C0.9 PD-62, B-14).
    if (draft.digest !== body.digest) throw new ApiError(409, 'notice_changed')
    // The contact's settings version the draft printed (C0.9 PD-66): publish_notice() locks the
    // latest and refuses another (HF007), or none (HF008), and links the version to it.
    const { rows } = await refusing(
      sql<{ notice: string; version: number }>`
        select notice, version from public.publish_notice(${body.seen}::integer, ${draft.body}, ${NOTICE_GENERATOR},
          ${draft.sources.purposes.map(purpose => purpose.key)}::text[],
          ${draft.sources.purposes.map(purpose => purpose.version)}::integer[],
          ${draft.sources.clearances.map(clearance => clearance.id)}::uuid[],
          ${draft.sources.contact?.version ?? null}::integer, ${info.requestId}, ${session.deviceId}::uuid,
          ${info.ip}::inet)`.execute(trx),
      () => new ApiError(403, 'forbidden'),
    )
    const row = rows[0]
    if (row === undefined) throw new Error('publish_notice() returned no row')
    await appendOutbox(trx, {
      orgId,
      type: 'notice.published',
      entity: { type: 'notice', id: row.notice },
      subjects: [],
      purpose: 'accounts',
      ids: { version: row.version },
    })
    return { notice: row.notice, version: row.version }
  })
  return { body: answer }
}

// --- GET /api/admin/notice/contact ----------------------------------------------------------------

// Whether the latest version prints this contact (C0.9 PD-70): none before any version; stated when
// the latest is generated and links the current settings version; not printed when it links none (a
// stand-in, a c09.1 version, or one published before any contact was recorded, since a version can
// link one only once one exists); not stated when it links an earlier one. So a contact recorded
// after a c09.1 latest reads as not printed, never as an earlier one, and no contact with a version
// never reads as stated.
export function contactStated(
  latest: Pick<NoticeVersionRead, 'generated' | 'sources'> | null,
  contact: Pick<ContactRead, 'version'> | null,
): ContactStated {
  if (latest === null) return 'unpublished'
  // A stand-in's words aren't the generator's, so it prints no contact whatever it links.
  const printed = latest.generated ? (latest.sources.contact?.version ?? null) : null
  if (contact !== null && printed === contact.version) return 'stated'
  if (contact === null || printed === null) return 'not_printed'
  return 'not_stated'
}

// The DPO's contact page (C0.9 OD-10, PD-70): whether the published notice is up to date with the
// registers (the Notice link's badge), the current contact (null until the DPO records one) and
// whether the latest version prints it, from one draft. In a read-only transaction, under
// notice.read: the DPO alone, before v0 too (NOTICE_SETUP); the request counts as use of the session.
export async function readContactAdmin(api: Api, session: SessionIds, info: ReqInfo): Promise<Answer> {
  const { orgId } = session
  const body = await inSession(
    api,
    info,
    session,
    async (trx): Promise<ContactAdminJSON> => {
      await authorise(trx, session, { action: 'notice.read' }, 'forbidden', { lock: false })
      // The contact the draft read, so the marker and the contact shown are one statement's.
      const draft = await noticeDraft(trx, orgId)
      return {
        notice: noticeStatusOf(draft),
        contact: draft.contact,
        stated: contactStated(draft.latest, draft.contact),
      }
    },
    { readOnly: true },
  )
  return { body }
}

// --- GET /api/admin/notice/people -----------------------------------------------------------------

type PeopleHead = { today: string; id: string | null; version: number | null; published_on: string | null }
type PersonRow = {
  id: string
  name: string
  department: string | null
  manager: string | null
  added_on: string
}

// The people the DPO may record an acknowledgement for (C0.9 OD-19, PD-76): today in the org's
// zone, the latest version a record would be for, and every person still at the organisation but
// the DPO, by name, department, manager and the day they were added, at most NOTICE_PEOPLE_MAX in
// name order, with more when there were others, so a cut list is never silent. Roster facts only:
// never a number, a device or who has acknowledged (notice.read still names nobody, PD-49). The
// manager and the day added let the dialog tell apart two people who would otherwise read the same.
// In a read-only transaction, under notice.people.read, which isn't a setup use: the gate has
// required the DPO to acknowledge the latest version, so a version exists, and with none this
// answers as the gate would (403 notice_required).
export async function readNoticePeople(api: Api, session: SessionIds, info: ReqInfo): Promise<Answer> {
  const { orgId, userId } = session
  const body = await inSession(
    api,
    info,
    session,
    async (trx): Promise<NoticePeopleJSON> => {
      await authorise(trx, session, { action: 'notice.people.read' }, 'forbidden', { lock: false })
      const { rows: heads } = await sql<PeopleHead>`
        select ((now() at time zone o.time_zone)::date)::text as today, v.id, v.version,
          ((v.published_at at time zone o.time_zone)::date)::text as published_on
        from orgs o
        left join lateral (
          select id, version, published_at from notice_versions where org_id = o.id order by version desc limit 1
        ) v on true
        where o.id = ${orgId}`.execute(trx)
      const head = heads[0]
      if (head === undefined || head.id === null || head.version === null || head.published_on === null) {
        throw new ApiError(403, 'notice_required')
      }
      const { rows } = await sql<PersonRow>`
        select p.id, p.full_name as name, d.name as department, m.full_name as manager,
          ((p.created_at at time zone o.time_zone)::date)::text as added_on
        from people p
        join orgs o on o.id = p.org_id
        left join departments d on d.org_id = p.org_id and d.id = p.department_id
        left join people m on m.org_id = p.org_id and m.id = p.manager_id
        where p.org_id = ${orgId} and p.deactivated_at is null and p.id <> ${userId}
        order by p.full_name collate "C", p.id
        limit ${NOTICE_PEOPLE_MAX + 1}`.execute(trx)
      return {
        today: head.today,
        latest: { notice: head.id, version: head.version, publishedOn: head.published_on },
        people: rows.slice(0, NOTICE_PEOPLE_MAX).map(row => ({
          id: row.id,
          name: row.name,
          department: row.department,
          manager: row.manager,
          addedOn: row.added_on,
        })),
        more: rows.length > NOTICE_PEOPLE_MAX,
      }
    },
    { readOnly: true },
  )
  return { body }
}

// --- POST /api/admin/notice/acknowledgements/record -----------------------------------------------

// The DPO records that someone else acknowledged the latest version outside Hearth (PDPA-03, ACC-12;
// C0.9 OD-19, PD-75, PD-76), with a fresh PIN (PD-30), in one transaction: can() decides
// (notice.acknowledgement.record: the DPO, for someone else still at the organisation, so yourself,
// a leaver, another org's person and an unknown id are 403 before the function); the note is held
// to AI_COPY, since the person sees it in Settings (400 notice_invalid: PD-65, the route's alone, as
// record_notice_acknowledgement() is its one caller), and a control character in it is refused here
// too (400 notice_invalid, as the function's HF008 answers one), because Postgres can't take a NUL
// as text at all and would refuse the parameter (22021) before the function runs; then the
// function re-checks the DPO, reads the person FOR SHARE, refuses any version but the latest
// (HF007, 409 notice_changed) and any other day or note it can't take (HF008, 400), and records the
// row on no device, with the day and the note, once per person and version. The audit row names the
// person, the version and the day, never the note. notice.acknowledged goes to the outbox in the
// same transaction when something was recorded, the DPO acting, for later consumers (catalogue:
// notice); nothing consumes it yet. The person is let in because the REST gate and the gateway's
// admission read the standing afresh (noticeStandings(), any method): at their next request, and
// for sockets at accept and in each check. The DPO's device comes from the session, never the body.
export async function recordAcknowledgement(
  api: Api,
  body: z.output<typeof RecordAcknowledgementBody>,
  session: SessionIds,
  info: ReqInfo,
): Promise<Answer> {
  const { orgId } = session
  const answer = await inSession(api, info, session, async (trx): Promise<AcknowledgeResponseJSON> => {
    await authorise(trx, session, { action: 'notice.acknowledgement.record', person: body.person }, 'forbidden')
    if (aiCopyIn(flatText(body.note)) !== undefined) throw new ApiError(400, 'notice_invalid')
    if (/\p{Cc}/u.test(body.note.trim())) throw new ApiError(400, 'notice_invalid')
    const { rows } = await refusing(
      sql<{ version: number; changed: boolean }>`
        select version, changed from public.record_notice_acknowledgement(${body.person}::uuid, ${body.notice}::uuid,
          ${body.acknowledgedOn}::date, ${body.note}, ${info.requestId}, ${session.deviceId}::uuid,
          ${info.ip}::inet)`.execute(trx),
      () => new ApiError(403, 'forbidden'),
    )
    const row = rows[0]
    if (row === undefined) throw new Error('record_notice_acknowledgement() returned no row')
    if (row.changed) {
      await appendOutbox(trx, {
        orgId,
        type: 'notice.acknowledged',
        entity: { type: 'person', id: body.person },
        subjects: [body.person],
        purpose: 'accounts',
        ids: { notice: body.notice, version: row.version },
      })
    }
    return { version: row.version, changed: row.changed }
  })
  return { body: answer }
}

// --- Routes ---------------------------------------------------------------------------------------

// The request's live session, or 401 signed_out without clearing the cookie (web/routes.ts): GET
// /api/notice is polled, and a poll's 401 that landed after another tab had signed in would delete
// that tab's new session (B-11).
async function pollingSession(api: Api, request: FastifyRequest): Promise<SessionIds> {
  const session = await authenticate(api.db, request)
  if (session === undefined) throw new ApiError(401, 'signed_out')
  return session
}

// /api/notice and /api/notice/acknowledge. The DPO's two are in admin/routes.ts.
export function noticeRoutes(api: Api) {
  return async (scope: FastifyInstance): Promise<void> => {
    scope.get('/notice', async (request, reply) =>
      send(
        reply,
        await keepCookie(async () => readNotice(api, await pollingSession(api, request), requestInfo(api, request))),
      ),
    )
    scope.post('/notice/acknowledge', async (request, reply) => {
      const body = parse(AcknowledgeBody, request.body)
      const session = await requireSession(api.db, request)
      return send(reply, await acknowledgeNotice(api, body, session, requestInfo(api, request)))
    })
  }
}
