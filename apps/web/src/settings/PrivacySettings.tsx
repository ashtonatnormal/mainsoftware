// /settings/privacy (PDPA-02 "always available in Settings", PDPA-03, PDPA-13; C0.9 PD-47, OD-12,
// PD-69): how to reach the Data Protection Officer, the current privacy notice, whether and when you
// acknowledged it, and your own acknowledgements, newest first. It ports the demo's Privacy section
// (demo/src/screens/Settings.tsx), not its look. The contact comes first, as the latest version
// printed it (so it is what everyone was told), with mailto: and tel: links; C0.9 PR 3b adds the
// requests form and "Your requests" directly after it. An acknowledgement the DPO recorded shows
// the day you acknowledged outside Hearth and how (OD-19, PD-75). It reads GET /api/notice without
// /notice's poll: this page sends nobody anywhere, and the router's guard already keeps it from
// anyone who hasn't acknowledged the current version.

import { mailtoHref, type NoticeForClient, postalLines, telHref } from '@hearth/shared'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useId } from 'react'
import { noticeQuery } from '@/api/queries.ts'
import { useRuntime } from '@/app/runtime-context.ts'
import { dayText, type Formatters } from '@/lib/time.ts'
import { NoticeBody } from '@/notice/NoticeBody.tsx'
import { currentOf } from '@/notice/notice-model.ts'
import { ACK_METHODS, NOTICE, SETTINGS } from '@/strings/notice.ts'
import { Button } from '@/ui/Button.tsx'
import { cx } from '@/ui/cx.ts'
import { Page } from '@/ui/Page.tsx'

export function PrivacySettings() {
  const query = useQuery({ ...noticeQuery, refetchInterval: false })
  return (
    <Page>
      <PrivacyContent answer={query.data} failed={query.isError} retry={() => void query.refetch()} />
    </Page>
  )
}

// The page for an answer: exported so the markup tests render each state.
export function PrivacyContent({
  answer,
  failed,
  retry,
}: {
  answer: NoticeForClient | undefined
  failed: boolean
  retry(): void
}) {
  const { formatters } = useRuntime()
  const noticeId = useId()
  const historyId = useId()
  if (answer === undefined)
    return failed ? (
      <div className="flex flex-col items-start gap-3">
        <p>{NOTICE.loadFailed}</p>
        <Button onClick={retry}>{NOTICE.retry}</Button>
      </div>
    ) : (
      <p role="status" className="text-muted">
        {NOTICE.loading}
      </p>
    )
  const current = currentOf(answer)
  return (
    <div className="flex flex-col gap-6">
      <ContactSection contact={answer.contact} />
      <section
        aria-labelledby={noticeId}
        className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:p-5"
      >
        <h2 id={noticeId} className="font-display text-xl font-semibold">
          {SETTINGS.privacy.noticeTitle}
        </h2>
        {current === undefined ? (
          <p>{SETTINGS.privacy.none}</p>
        ) : (
          <>
            <p className="text-muted">
              {NOTICE.version(String(current.version), formatters.date(current.publishedAt))}
            </p>
            <p>{standingLine(answer, current.version, formatters)}</p>
            <NoticeBody body={current.body} level={3} />
          </>
        )}
      </section>
      <section aria-labelledby={historyId} className="flex flex-col gap-3">
        <h2 id={historyId} className="font-display text-xl font-semibold">
          {SETTINGS.privacy.historyTitle}
        </h2>
        {answer.mine.length === 0 ? (
          <p className="text-muted">{SETTINGS.privacy.noHistory}</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {answer.mine.map(ack => (
              <li key={`${ack.version} ${ack.acknowledgedAt}`} className="flex flex-col gap-0.5 px-4 py-3">
                <span>
                  {SETTINGS.privacy.history(String(ack.version), dayOf(ack, formatters), ACK_METHODS[ack.method])}
                </span>
                {ack.note !== null && (
                  <span className="break-words text-small text-muted">{SETTINGS.privacy.recordedHow(ack.note)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

type Acknowledgement = NoticeForClient['mine'][number]

// The day you acknowledged a version: the day the DPO recorded, for one you made outside Hearth
// (C0.9 PD-75), else the day of the moment you acknowledged it in the app, in your zone.
function dayOf(ack: Acknowledgement, formatters: Formatters): string {
  return ack.acknowledgedOn === null ? formatters.date(Date.parse(ack.acknowledgedAt)) : dayText(ack.acknowledgedOn)
}

// Whether, when and how you acknowledged the current version.
function standingLine(answer: NoticeForClient, version: number, formatters: Formatters): string {
  const mine = answer.mine.find(ack => ack.version === version)
  if (mine === undefined) return SETTINGS.privacy.notYet(String(version))
  return SETTINGS.privacy.acknowledged(String(version), dayOf(mine, formatters), ACK_METHODS[mine.method])
}

// One way to reach the DPO: its visible term, and a link (or, for the post, the address's lines) at
// least 44 px high whose text is the value itself; a long value breaks rather than scrolling
// sideways at 320 px.
function Channel({ term, children }: { term: string; children: ReactNode }) {
  return (
    <li className="flex flex-col px-4 py-1.5 sm:flex-row sm:items-center sm:gap-4">
      <span className="pt-1 text-small text-muted sm:w-16 sm:shrink-0 sm:pt-0">{term}</span>
      {children}
    </li>
  )
}

const VALUE_CLASS = 'flex min-h-11 min-w-0 items-center break-words [overflow-wrap:anywhere]'

// How to reach the Data Protection Officer (PDPA-13; C0.9 OD-10, OD-12, PD-69): the contact the
// latest version printed. None when it printed none (the seed's stand-in, or a version from before
// C0.9 PR 3a), and unreadable when the answer couldn't be read. Exported for the markup tests.
export function ContactSection({ contact }: { contact: NoticeForClient['contact'] }) {
  const id = useId()
  const words = SETTINGS.privacy.contact
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="font-display text-xl font-semibold">
        {words.title}
      </h2>
      <p>{words.body}</p>
      {contact === undefined ? (
        <p className="text-muted">{words.unreadable}</p>
      ) : contact === null ? (
        <p className="text-muted">{words.none}</p>
      ) : (
        <>
          <p className="break-words font-semibold [overflow-wrap:anywhere]">{contact.title}</p>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {contact.email !== null && (
              <Channel term={words.email}>
                <a href={mailtoHref(contact.email)} className={cx(VALUE_CLASS, 'text-accent-ink underline')}>
                  {contact.email}
                </a>
              </Channel>
            )}
            {contact.phone !== null && (
              <Channel term={words.phone}>
                <a href={telHref(contact.phone)} className={cx(VALUE_CLASS, 'text-accent-ink underline')}>
                  {contact.phone}
                </a>
              </Channel>
            )}
            {contact.postal !== null && (
              <Channel term={words.postal}>
                <p className={cx(VALUE_CLASS, 'whitespace-pre-line py-2.5')}>
                  {postalLines(contact.postal).join('\n')}
                </p>
              </Channel>
            )}
          </ul>
          <p className="text-small text-muted">{words.leaving}</p>
        </>
      )}
    </section>
  )
}
