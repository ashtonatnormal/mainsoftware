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
// The two of yours are exempt from the acknowledgement gate (packages/access NOTICE_FREE), so the
// notice can always be read and acknowledged; the DPO's pass it before any version exists, for the
// DPO alone (NOTICE_SETUP, OD-01), and afterwards only once the DPO has acknowledged the latest.
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
// The answers carry ids, numbers, the notice's own words and the names of who published, never
// anyone's number or who has acknowledged: the DPO sees a count (data minimisation, PD-48).
import { createHash } from 'node:crypto'
import {
  AcknowledgeBody,
  type AcknowledgeResponseJSON,
  type Basis,
  generateNotice,
  isAiProvider,
  isProviderKey,
  NON_AI_PROVIDERS,
  NON_AI_PURPOSE_KEYS,
  NOTICE_GENERATOR,
  NOTICE_HISTORY_MAX,
  NOTICE_MINE_MAX,
  type NoticeAdminJSON,
  type NoticeChangesJSON,
  type NoticeClearance,
  type NoticeFacts,
  type NoticeInput,
  type NoticeJSON,
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
// the latest version (null while none is published), the number the draft would get, its words and
// digest (null while it can't be written or shown: UNSHOWN below), its sources, what holds it
// back, what it warns of, what changed since the latest version, and whether the published notice
// already says it.
export interface NoticeDraft {
  today: string
  input: NoticeInput
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
}

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
// clearances with the facts each rests on, from the link tables.
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
  for (const version of versions) {
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
  sources: sources ?? { generator: row.generator, body: row.body, purposes: [], clearances: [] },
})

// The org's latest version, with who published it from the roster (none when Hearth did).
async function readLatest(trx: InOrg, orgId: string): Promise<NoticeVersionRead | null> {
  const { rows } = await sql<VersionRow>`
    select v.id, v.version, v.published_at, p.full_name as published_by, v.generator, v.body
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
// basis or retention, or a consent-type basis), and free text the screens keep off (AI_COPY,
// PD-62), which the preview would otherwise show the DPO.
const UNSHOWN: ReadonlySet<NoticeProblem['code']> = new Set([
  'purpose_basis_missing',
  'purpose_retention_missing',
  'purpose_consent_basis',
  'free_text_ai_copy',
])

// sha-256, in hex, of what the digest covers (packages/shared noticeDigestText()).
export const noticeDigest = (sources: NoticeSources): string =>
  createHash('sha256').update(noticeDigestText(sources)).digest('hex')

// The draft the registers make now, read with plain statements in the caller's transaction (no
// lock: publish_notice() locks and compares what this read). A statement each, so at READ COMMITTED
// a change committing between them makes a draft whose sources disagree with the registers, which
// publish_notice() refuses (HF007), and the page reloads.
export async function noticeDraft(trx: InOrg, orgId: string): Promise<NoticeDraft> {
  const { rows } = await sql<{ name: string; today: string }>`
    select name, ((now() at time zone time_zone)::date)::text as today from orgs where id = ${orgId}`.execute(trx)
  const org = rows[0]
  // Past can() the org exists.
  if (org === undefined) throw new ApiError(404, 'not_found')
  const input: NoticeInput = {
    org: org.name,
    purposes: await readPurposes(trx, orgId),
    clearances: await readClearances(trx, orgId),
  }
  const latest = await readLatest(trx, orgId)
  const problems = noticeProblems(input, latest?.sources ?? null)
  const warnings = noticeWarnings(input, latest?.sources ?? null, org.today)
  const body = problems.some(problem => UNSHOWN.has(problem.code)) ? null : generateNotice(input)
  const sources = noticeDraftSources(input, body)
  return {
    today: org.today,
    input,
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

// What publish_notice() and acknowledge_notice() refuse with, as the api answers it (C0.9 PD-52). A
// lock not granted in time (55P03) or a deadlock is the api's 409 try_again already (auth/errors.ts
// fromDatabase). 42501 is the publisher's 403; acknowledging answers its own (signed_out).
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

type MineRow = { version: number; acknowledged_at: Date; method: 'in_app' | 'recorded_by_dpo' }

// Your standing, the current version, what changed since you last acknowledged a generated one, and
// your own acknowledgements, newest version first. In a read-only transaction that leaves the
// session's last use alone: /notice polls it every 30 s while visible (PD-46), as the shell polls
// its flags (OD-14). The standing is read with the latest version, in one statement, by the rule
// notice-standing.ts reads it by, so the two never disagree within an answer. The person is named,
// so a tab whose cookie now holds someone else's session ends its document (B-11).
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
      const { rows: latestRows } = await sql<VersionRow & { acknowledged: boolean }>`
        select v.id, v.version, v.published_at, null::text as published_by, v.generator, v.body,
          exists (select 1 from notice_acknowledgments a
            where a.org_id = v.org_id and a.person_id = ${userId} and a.notice_version_id = v.id) as acknowledged
        from notice_versions v
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
        select v.version, a.acknowledged_at, a.method
        from notice_acknowledgments a
        join notice_versions v on v.org_id = a.org_id and v.id = a.notice_version_id
        where a.org_id = ${orgId} and a.person_id = ${userId} and v.version <= ${current?.version ?? -1}
        order by v.version desc, a.acknowledged_at desc
        limit ${NOTICE_MINE_MAX}`.execute(trx)
      let changes: NoticeChangesJSON | null = null
      if (current !== undefined && current.generator !== null) {
        // The last generated version you acknowledged before this one.
        const { rows: before } = await sql<VersionRow>`
          select v.id, v.version, v.published_at, null::text as published_by, v.generator, v.body
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
        changes,
        mine: mine.map(row => ({
          version: row.version,
          acknowledgedAt: row.acknowledged_at.toISOString(),
          method: row.method,
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
// new draft), and any problem 400 notice_invalid (the page lists them); then publish_notice() locks
// the registers and the latest version, refuses sources that moved (HF007) or a rule (HF008), writes
// the version, its links and the audit row; and notice.published goes to the outbox in the same
// transaction (T16). Everyone, the DPO included, then acknowledges the new version before using
// Hearth again (PD-39): REST at once, sockets within a periodic check.
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
    const { rows } = await refusing(
      sql<{ notice: string; version: number }>`
        select notice, version from public.publish_notice(${body.seen}::integer, ${draft.body}, ${NOTICE_GENERATOR},
          ${draft.sources.purposes.map(purpose => purpose.key)}::text[],
          ${draft.sources.purposes.map(purpose => purpose.version)}::integer[],
          ${draft.sources.clearances.map(clearance => clearance.id)}::uuid[], ${info.requestId},
          ${session.deviceId}::uuid, ${info.ip}::inet)`.execute(trx),
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
