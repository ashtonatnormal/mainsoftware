// The DPO's Notice tab, pure (PDPA-02, PDPA-03; C0.9 PD-36, PD-37, PD-39, PD-48, PD-52, PD-59;
// TECH-SPEC T22 items 25 and 31): GET /api/admin/notice's answer as the page shows it, so every
// state is tested in Node with no DOM (dpo/notice-model.test.ts, NTW-09). The server decides
// everything here: it writes the draft from the registers, finds what holds it back and what it
// warns of, and checks the draft again when the DPO publishes (a digest the page didn't preview is
// 409 notice_changed). This module only words its codes (strings/dpo-notice.ts) and says which
// register page fixes each problem.
//
// The answer, as shown:
// - the published notice: its version, when and by whom, whether it is a placeholder (a stand-in,
//   before the first generated version) and whether it still says what the registers say, and how
//   many of the people at the organisation have acknowledged it (a count, never names);
// - the next version: what it changes since the published one, what holds publishing back (under
//   the purpose or provider each names, with a link to the page that fixes it), what to check, and
//   Publish, held while anything holds it back;
// - the draft's words, when the server could write and show them;
// - the versions published, newest first.
import {
  NOTICE_PROVIDER_NAMES,
  type NoticeAdminForClient,
  type NoticeChangesForClient,
  type NoticeStatus,
  PURPOSES,
  type PublishJSON,
  type PurposeKey,
} from '@hearth/shared'
import { DPO } from '@/strings/dpo.ts'
import { NOTICE_FIELD_LABELS, NOTICE_PROBLEM_COPY, NOTICE_TAB, NOTICE_WARNING_COPY } from '@/strings/dpo-notice.ts'
import { failureOf, providerName, type Refusal, refusalOf } from './model.ts'

const purposeName = (key: PurposeKey): string => PURPOSES[key].register
// A provider as the notice itself names it, so the change list reads as the preview below it and
// /notice's "What's changed" do; problems and warnings use the transfer register's names, the page
// that fixes them.
const noticeProviderName = (key: string): string =>
  Object.hasOwn(NOTICE_PROVIDER_NAMES, key) ? NOTICE_PROVIDER_NAMES[key as keyof typeof NOTICE_PROVIDER_NAMES] : key

// Where the server's answer stands, as the register pages' marker says it (compliance/notice.ts
// noticeStatusOf): none before any version, up to date while the latest version says what the
// draft would (a provider cleared again on the same facts included), out of date otherwise (a
// placeholder as the latest always is).
export function noticeStatusOf(answer: Pick<NoticeAdminForClient, 'latest' | 'draft'>): NoticeStatus {
  if (answer.latest === null) return 'none'
  return answer.draft.upToDate ? 'up_to_date' : 'out_of_date'
}

export interface ChangeGroup {
  readonly title: string
  readonly lines: readonly string[]
}

// What the next version changes since the published one: the purposes and providers it adds,
// changes or no longer lists, each group in the registries' order, purposes first, the providers by
// the notice's own names, and whether the notice's own wording changes. Undefined when it changes
// nothing it can name.
export function changeGroups(
  changes: NoticeChangesForClient | null,
): { readonly groups: readonly ChangeGroup[]; readonly wording: boolean } | undefined {
  if (changes === null) return undefined
  const lines = (kind: 'added' | 'changed' | 'removed') => [
    ...changes.purposes[kind].map(purposeName),
    ...changes.providers[kind].map(noticeProviderName),
  ]
  const groups = [
    { title: NOTICE_TAB.draft.added, lines: lines('added') },
    { title: NOTICE_TAB.draft.changed, lines: lines('changed') },
    { title: NOTICE_TAB.draft.removed, lines: lines('removed') },
  ].filter(group => group.lines.length > 0)
  return groups.length > 0 || changes.wording ? { groups, wording: changes.wording } : undefined
}

// What holds publishing back, under the purpose or provider each names (none for the draft as a
// whole), in the answer's order.
export interface ProblemGroup {
  readonly key: string
  readonly subject: string | undefined
  readonly lines: readonly string[]
}

export type FixPage = 'purposes' | 'transfers'

type Problem = NoticeAdminForClient['draft']['problems'][number]

function problemLine(problem: Problem): string {
  switch (problem.code) {
    case 'provider_not_cleared':
      return NOTICE_PROBLEM_COPY.provider_not_cleared(
        problem.provider === undefined ? DPO.notRecorded : providerName(problem.provider),
      )
    case 'free_text_ai_copy':
      return NOTICE_PROBLEM_COPY.free_text_ai_copy(
        problem.field === undefined ? DPO.notRecorded : NOTICE_FIELD_LABELS[problem.field],
      )
    default:
      return NOTICE_PROBLEM_COPY[problem.code]()
  }
}

// The page that fixes a problem: a purpose's entry on the processing register; a provider that
// isn't cleared, or a provider's own facts, on the transfer register. The draft matching the
// published notice is fixed nowhere: nothing needs publishing.
function fixPageOf(problem: Problem): FixPage | undefined {
  if (problem.code === 'provider_not_cleared') return 'transfers'
  if (problem.code === 'unchanged') return undefined
  return problem.purpose === undefined && problem.provider !== undefined ? 'transfers' : 'purposes'
}

export function problemGroups(problems: readonly Problem[]): ProblemGroup[] {
  const groups = new Map<string, { subject: string | undefined; lines: string[] }>()
  for (const problem of problems) {
    // A purpose names the group; a provider only when the problem is about the provider's own facts.
    const subject =
      problem.purpose !== undefined
        ? { key: `purpose:${problem.purpose}`, name: purposeName(problem.purpose) }
        : problem.provider !== undefined && problem.code !== 'provider_not_cleared'
          ? { key: `provider:${problem.provider}`, name: providerName(problem.provider) }
          : { key: 'draft', name: undefined }
    const group = groups.get(subject.key) ?? { subject: subject.name, lines: [] }
    group.lines.push(problemLine(problem))
    groups.set(subject.key, group)
  }
  return [...groups].map(([key, group]) => ({ key, ...group }))
}

// The pages to open to fix the problems, in this order, each once.
export function fixPages(problems: readonly Problem[]): FixPage[] {
  const pages = new Set(problems.map(fixPageOf))
  return (['purposes', 'transfers'] as const).filter(page => pages.has(page))
}

type Warning = NoticeAdminForClient['draft']['warnings'][number]

export function warningLine(warning: Warning): string {
  const name = warning.provider === undefined ? DPO.notRecorded : providerName(warning.provider)
  switch (warning.code) {
    case 'provider_unlisted':
    case 'provider_review_due':
      return NOTICE_WARNING_COPY[warning.code](name)
    case 'sends_waiting':
      return warning.provider === 'twilio'
        ? NOTICE_WARNING_COPY.sends_waiting_twilio()
        : NOTICE_WARNING_COPY.sends_waiting(name)
    default:
      return NOTICE_WARNING_COPY[warning.code]()
  }
}

// POST /api/admin/notice/publish's body: the latest version the page showed (null before any), and
// the digest of the draft it previewed. None while the draft can't be published: no words, or
// anything holding it back.
export function publishBodyOf(answer: NoticeAdminForClient): PublishJSON | undefined {
  const { draft } = answer
  if (draft.body === null || draft.digest === null || draft.problems.length > 0) return undefined
  return { seen: answer.latest?.version ?? null, digest: draft.digest }
}

// Why Publish can't act, or undefined when it can: the published notice already says this (the
// only problem), anything else listed, or a draft the server couldn't write.
export function publishHeldOf(answer: NoticeAdminForClient): string | undefined {
  if (publishBodyOf(answer) !== undefined) return undefined
  const { problems } = answer.draft
  if (problems.length > 0 && problems.every(problem => problem.code === 'unchanged')) {
    return NOTICE_TAB.draft.alreadySays
  }
  return DPO.fixFirst
}

export interface NoticeTabView {
  readonly status: NoticeStatus
  // The published notice's lines, in order.
  readonly published: readonly string[]
  readonly version: string
  // The first version: there is nothing to compare it with.
  readonly first: boolean
  readonly changes: ReturnType<typeof changeGroups>
  readonly problems: readonly ProblemGroup[]
  readonly fixAt: readonly FixPage[]
  readonly warnings: readonly string[]
  readonly publishHeld: string | undefined
  readonly body: string | undefined
  readonly history: readonly { readonly id: string; readonly lines: readonly string[] }[]
}

// date: an instant as the person's zone shows it (the runtime's formatters).
export function noticeTabView(answer: NoticeAdminForClient, date: (ms: number) => string): NoticeTabView {
  const { latest, draft } = answer
  const publishedLine = (row: { version: number; publishedAt: string; publishedBy: string | null }) => {
    const day = date(Date.parse(row.publishedAt))
    return row.publishedBy === null
      ? NOTICE_TAB.published.version(String(row.version), day)
      : NOTICE_TAB.published.versionBy(String(row.version), day, row.publishedBy)
  }
  const status = noticeStatusOf(answer)
  const published: string[] = []
  if (latest === null) published.push(NOTICE_TAB.published.none)
  else {
    published.push(publishedLine(latest))
    if (!latest.generated) published.push(NOTICE_TAB.published.standIn)
    else published.push(status === 'up_to_date' ? NOTICE_TAB.published.upToDate : NOTICE_TAB.published.outOfDate)
    published.push(
      latest.people === 1
        ? NOTICE_TAB.published.acknowledgedOfOne(String(latest.acknowledged), String(latest.version))
        : NOTICE_TAB.published.acknowledged(String(latest.acknowledged), String(latest.people), String(latest.version)),
    )
  }
  return {
    status,
    published,
    version: String(draft.version),
    first: latest === null,
    changes: latest === null ? undefined : changeGroups(draft.changes),
    problems: problemGroups(draft.problems),
    fixAt: fixPages(draft.problems),
    warnings: draft.warnings.map(warningLine),
    publishHeld: publishHeldOf(answer),
    body: draft.body ?? undefined,
    history: answer.history.map(row => ({
      id: row.id,
      lines: row.generated ? [publishedLine(row)] : [publishedLine(row), NOTICE_TAB.history.standIn],
    })),
  }
}

// A refused publish, as the confirmation shows it: 409 notice_changed (the registers or the latest
// version moved since the page read them, PD-52) and 400 notice_invalid both offer Reload, in this
// page's words, since the server's are written for /notice; the rest as the register pages read
// them (the PIN step, a new sign-in, forbidden, or the server's words).
export function publishRefusalOf(error: unknown): Refusal {
  const failure = failureOf(error)
  if (failure.code === 'notice_changed') return { kind: 'changed', text: NOTICE_TAB.changedSince }
  if (failure.code === 'notice_invalid') return { kind: 'changed', text: NOTICE_TAB.invalid }
  return refusalOf(failure)
}
