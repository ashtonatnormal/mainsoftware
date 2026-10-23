// What /notice shows, as plain values the markup reads (C0.9 PD-46; TECH-SPEC T22 item 31), so
// every state is tested in Node (notice.markup.test.tsx) with no DOM. GET /api/notice's answer
// decides, never the store's standing alone: a hint brings the tab here, and this answer says what
// is true now.
//   loading       no answer yet
//   failed        no answer could be read; Try again
//   unpublished   no version published yet (OD-01): the DPO is offered the registers and the
//                 Notice tab, anyone else is told Hearth isn't open yet
//   acknowledged  the current version is acknowledged: when, and Continue (a visit after the fact)
//   required      the current version to read and acknowledge, with what changed since the last
//                 version the person acknowledged
import { NOTICE_PROVIDER_NAMES, type NoticeChangesForClient, type NoticeForClient, PURPOSES } from '@hearth/shared'

export interface CurrentNotice {
  readonly id: string
  readonly version: number
  readonly publishedAt: number
  readonly body: string
}

// What changed, worded: the purposes' register wording and the providers' names, each group in
// the registries' order, purposes first.
export interface ChangeLines {
  readonly since: number
  readonly added: readonly string[]
  readonly changed: readonly string[]
  readonly removed: readonly string[]
  readonly wording: boolean
}

export type NoticeView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unpublished'; readonly dpo: boolean }
  | { readonly kind: 'acknowledged'; readonly current: CurrentNotice; readonly acknowledgedAt: number | undefined }
  | { readonly kind: 'required'; readonly current: CurrentNotice; readonly changes: ChangeLines | undefined }

const purposeLabel = (key: string): string =>
  Object.hasOwn(PURPOSES, key) ? PURPOSES[key as keyof typeof PURPOSES].register : key
const providerLabel = (key: string): string =>
  Object.hasOwn(NOTICE_PROVIDER_NAMES, key) ? NOTICE_PROVIDER_NAMES[key as keyof typeof NOTICE_PROVIDER_NAMES] : key

// The callout's lines, or undefined when nothing it can name changed.
export function changeLines(changes: NoticeChangesForClient | null): ChangeLines | undefined {
  if (changes === null) return undefined
  const lines = (kind: 'added' | 'changed' | 'removed') => [
    ...changes.purposes[kind].map(purposeLabel),
    ...changes.providers[kind].map(providerLabel),
  ]
  const result = {
    since: changes.since,
    added: lines('added'),
    changed: lines('changed'),
    removed: lines('removed'),
    wording: changes.wording,
  }
  const listed = result.added.length + result.changed.length + result.removed.length > 0
  return listed || result.wording ? result : undefined
}

export function currentOf(answer: NoticeForClient): CurrentNotice | undefined {
  const current = answer.current
  if (current === null) return undefined
  return { id: current.id, version: current.version, publishedAt: Date.parse(current.publishedAt), body: current.body }
}

// registers: the session answer's capability, which the DPO alone holds (C0.9 PD-26).
export function noticeView(answer: NoticeForClient | undefined, failed: boolean, registers: boolean): NoticeView {
  if (answer === undefined) return failed ? { kind: 'failed' } : { kind: 'loading' }
  const current = currentOf(answer)
  if (answer.standing === 'unpublished' || current === undefined) return { kind: 'unpublished', dpo: registers }
  if (answer.standing === 'acknowledged') {
    const mine = answer.mine.find(ack => ack.version === current.version)
    return {
      kind: 'acknowledged',
      current,
      acknowledgedAt: mine === undefined ? undefined : Date.parse(mine.acknowledgedAt),
    }
  }
  return { kind: 'required', current, changes: changeLines(answer.changes) }
}
