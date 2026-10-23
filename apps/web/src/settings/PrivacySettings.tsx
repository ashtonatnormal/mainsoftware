// /settings/privacy (PDPA-02 "always available in Settings", PDPA-03; C0.9 PD-47): the current
// privacy notice, whether and when you acknowledged it, and your own acknowledgements, newest first.
// It ports the demo's Privacy section (demo/src/screens/Settings.tsx), not its look, and without its
// requests, which C0.9 PR 3 adds with the Data Protection Officer's contact. It reads GET
// /api/notice without /notice's poll: this page sends nobody anywhere, and the router's guard
// already keeps it from anyone who hasn't acknowledged the current version.

import type { NoticeForClient } from '@hearth/shared'
import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { noticeQuery } from '@/api/queries.ts'
import { useRuntime } from '@/app/runtime-context.ts'
import type { Formatters } from '@/lib/time.ts'
import { NoticeBody } from '@/notice/NoticeBody.tsx'
import { currentOf } from '@/notice/notice-model.ts'
import { ACK_METHODS, NOTICE, SETTINGS } from '@/strings/notice.ts'
import { Button } from '@/ui/Button.tsx'
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
              <li key={`${ack.version} ${ack.acknowledgedAt}`} className="px-4 py-3">
                {SETTINGS.privacy.history(
                  String(ack.version),
                  formatters.date(Date.parse(ack.acknowledgedAt)),
                  ACK_METHODS[ack.method],
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// Whether, when and how you acknowledged the current version.
function standingLine(answer: NoticeForClient, version: number, formatters: Formatters): string {
  const mine = answer.mine.find(ack => ack.version === version)
  if (mine === undefined) return SETTINGS.privacy.notYet(String(version))
  return SETTINGS.privacy.acknowledged(
    String(version),
    formatters.date(Date.parse(mine.acknowledgedAt)),
    ACK_METHODS[mine.method],
  )
}
