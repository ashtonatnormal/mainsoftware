// What the register pages say about the published notice (C0.9 PD-39 to PD-41, PD-48, PD-59, PD-61;
// B-04, B-12, C-09; TECH-SPEC T22 items 27 and 31), from the registers' answer's markers: the
// Notice link's badge, a banner over the list, a line on a card, and a line or a confirmation in
// an edit dialog. Only the two register screens import this module, never RegisterPage.tsx, so it
// loads with the screens that show it, in a chunk of its own (B-12); its copy (strings/dpo-notice.ts)
// the Notice tab reads too. The server decides every marker; this only shows them:
// - the badge and the banner: none before any version is published; out of date while publishing
//   would write a new version (a placeholder as the latest always is); a pinned purpose stale when
//   the latest generated version lists an older version of it, which runs for everyone anyway
//   (PD-61), shown only once something is published (C-09);
// - a purpose card: active and not pinned, but not notified (the latest version doesn't list it at
//   this version), so the purpose gate refuses it (PD-40); or pinned and stale;
// - a provider card: cleared, but the latest generated version doesn't state its facts, so nothing
//   is sent to it (Twilio Verify: only the DPO gets sign-in codes) until the next publish (PD-41,
//   PD-59);
// - the dialogs, once a generated version is published: saving a pinned purpose asks first, since
//   the change applies to everyone at once (B-04); saving a notified purpose says the features that
//   serve it stop until the next publish; changing a fact the notice states about a cleared
//   provider says what stops until then.
//
// Whether the latest version is a generated one, the answer says only through the pinned purposes:
// every generated version lists every active purpose, and a pinned purpose is always active, so a
// pinned purpose is notified or stale exactly when the latest version is generated (C-09). A
// placeholder (a stand-in) lists nothing, and changes nothing a save could stop.
import {
  type NoticeStatus,
  PURPOSES,
  type PurposeRowForClient,
  type RegistersForClient,
  type TransferRowForClient,
} from '@hearth/shared'
import { Link } from '@tanstack/react-router'
import { NOTICE_MARKERS, NOTICE_STATUS_LABELS } from '@/strings/dpo-notice.ts'
import { buttonClass } from '@/ui/Button.tsx'
import { Note, Pill } from './parts.tsx'

// Cleared: an open clearance (transfers-model.ts isCleared, which only the transfer page loads).
const cleared = (row: TransferRowForClient): boolean => row.clearance !== null && row.clearance.withdrawnOn === null

export function noticeGenerated(registers: Pick<RegistersForClient, 'purposes'>): boolean {
  return registers.purposes.some(row => row.pinned && (row.notified || row.stale))
}

// --- The Notice link's badge and the banner -------------------------------------------------------

export function noticeBadgeText(status: NoticeStatus): string | undefined {
  return status === 'up_to_date' ? undefined : NOTICE_STATUS_LABELS[status]
}

export function NoticeBadge({ status }: { status: NoticeStatus }) {
  const text = noticeBadgeText(status)
  if (text === undefined) return null
  return <Pill tone={status === 'out_of_date' ? 'warn' : 'muted'}>{text}</Pill>
}

export type NoticeBannerView =
  | { readonly kind: 'none' | 'out_of_date'; readonly text: string }
  | { readonly kind: 'stale'; readonly text: string; readonly purposes: readonly string[] }

export function noticeBannerOf(
  registers: Pick<RegistersForClient, 'purposes' | 'notice'>,
): NoticeBannerView | undefined {
  if (registers.notice === 'none') return { kind: 'none', text: NOTICE_MARKERS.banner.none }
  const stale = registers.purposes.filter(row => row.stale).map(row => PURPOSES[row.purpose].register)
  if (stale.length > 0) return { kind: 'stale', text: NOTICE_MARKERS.banner.stale, purposes: stale }
  if (registers.notice === 'out_of_date') return { kind: 'out_of_date', text: NOTICE_MARKERS.banner.outOfDate }
  return undefined
}

export function NoticeBanner({ registers }: { registers: Pick<RegistersForClient, 'purposes' | 'notice'> }) {
  const banner = noticeBannerOf(registers)
  if (banner === undefined) return null
  return (
    // An info note whatever the kind: its link's focus ring is drawn against accent-soft, a pair
    // styles/contrast-pairs.ts holds to 3:1.
    <Note tone="info">
      <p>{banner.text}</p>
      {banner.kind === 'stale' && (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {banner.purposes.map(purpose => (
            <li key={purpose}>{purpose}</li>
          ))}
        </ul>
      )}
      <Link to="/dpo/notice" activeOptions={{ exact: true }} activeProps={{}} className={buttonClass()}>
        {NOTICE_MARKERS.banner.toNotice}
      </Link>
    </Note>
  )
}

// --- The cards --------------------------------------------------------------------------------------

export function purposeMarkerText(row: PurposeRowForClient): string | undefined {
  if (row.pinned) return row.stale ? NOTICE_MARKERS.pinnedStale : undefined
  return row.status === 'active' && !row.notified ? NOTICE_MARKERS.waitingForNotice : undefined
}

export function providerMarkerText(row: TransferRowForClient): string | undefined {
  if (!row.sendsWait || !cleared(row)) return undefined
  return row.provider === 'twilio' ? NOTICE_MARKERS.sendsWaitTwilio : NOTICE_MARKERS.sendsWait
}

// A card's line, as a warning note beside its other facts.
function Marker({ text }: { text: string | undefined }) {
  if (text === undefined) return null
  return (
    <Note tone="warn">
      <p>{text}</p>
    </Note>
  )
}

export const PurposeNoticeMarker = ({ row }: { row: PurposeRowForClient }) => <Marker text={purposeMarkerText(row)} />
export const ProviderNoticeMarker = ({ row }: { row: TransferRowForClient }) => (
  <Marker text={providerMarkerText(row)} />
)

// --- The dialogs ------------------------------------------------------------------------------------

// What saving a purpose's changed entry does to the notice, once a generated version is published:
//   confirm  a pinned purpose: it applies to everyone at once, so the page asks first (B-04)
//   stops    a notified purpose: it isn't notified at its new version until the next publish, so
//            the features that serve it stop (PD-40)
export function purposeSaveEffect(
  row: PurposeRowForClient,
  changed: boolean,
  generated: boolean,
): 'confirm' | 'stops' | undefined {
  if (!changed || !generated) return undefined
  if (row.pinned) return 'confirm'
  return row.notified ? 'stops' : undefined
}

// Whether saving changed stated facts of a provider stops sends to it: it is cleared, the latest
// generated version states its facts now (so they wait for nothing yet), and the change is to one
// the notice states (NOTICE_FACT_FIELDS; a review date, safeguard or confirmation stops nothing).
export function factsSaveStops(row: TransferRowForClient, statedChanged: boolean, generated: boolean): boolean {
  return statedChanged && generated && cleared(row) && !row.sendsWait
}

export function factsStopText(row: TransferRowForClient, name: string): string {
  return row.provider === 'twilio' ? NOTICE_MARKERS.factsStopTwilio : NOTICE_MARKERS.factsStop(name)
}

export function SaveStopsNote({ text }: { text: string }) {
  return (
    <Note tone="warn">
      <p>{text}</p>
    </Note>
  )
}
