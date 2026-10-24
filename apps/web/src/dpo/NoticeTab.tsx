// The DPO's Notice tab, /dpo/notice (PDPA-02, PDPA-03; C0.9 PD-36, PD-37, PD-39, PD-48, OD-01,
// OD-03; TECH-SPEC T22 items 25 and 31). Beside the two registers, under the same links, it shows
// GET /api/admin/notice's answer (dpo/notice-model.ts):
// - the published notice: its version, when and by whom, whether it still says what the registers
//   say, and how many of the people at the organisation have acknowledged it (a count, never names),
//   with "Record an acknowledgement" beside the count for someone who acknowledged outside Hearth
//   (dpo/RecordAcknowledgement.tsx; C0.9 OD-19, PD-75, PD-76);
// - the next version: what it changes (the DPO's contact included), what holds publishing back with
//   links to the register page or the contact page that fixes it, what to check, and Publish;
// - a preview of its words, which are what people will acknowledge, drawn by the same reader as
//   /notice (NoticeBody), as text, never HTML;
// - the versions published.
//
// Publish asks first, saying everyone, the DPO included, acknowledges the new version before using
// Hearth again. It sends the latest version the tab showed and the digest of the draft it
// previewed; the server writes the draft again and refuses one that differs (409 notice_changed,
// with Reload) or that something holds back (400 notice_invalid), and asks for the PIN when the
// session's re-authentication is stale (the PIN step, then the same publish once more). Once it
// lands, the notice store's required() takes the DPO to /notice to acknowledge the version they
// published, and back here afterwards (router/router.tsx NoticeWatcher): /notice's "Version N,
// published <date>", its heading focused as the page loads, is the confirmation (a toast here
// would go with the shell before anyone saw it). The router loads this module lazily
// (router/router.tsx).
import type { NoticeAdminForClient } from '@hearth/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useId, useState } from 'react'
import { useRuntime } from '@/app/runtime-context.ts'
import { NoticeBody } from '@/notice/NoticeBody.tsx'
import { DPO } from '@/strings/dpo.ts'
import { NOTICE_STATUS_LABELS, NOTICE_TAB } from '@/strings/dpo-notice.ts'
import { Button, buttonClass } from '@/ui/Button.tsx'
import { Dialog } from '@/ui/Dialog.tsx'
import { Page } from '@/ui/Page.tsx'
import { type Refusal, refusalOfError } from './model.ts'
import { type NoticeTabView, noticeTabView, publishBodyOf, publishRefusalOf } from './notice-model.ts'
import { Note, Pill } from './parts.tsx'
import { noticeAdminQuery, publishNotice } from './queries.ts'
import { ReauthPin } from './ReauthPin.tsx'
import { RecordAcknowledgement } from './RecordAcknowledgement.tsx'
import { ReadRefusal, RegisterLinks } from './RegisterPage.tsx'
import { SignOutNotice } from './SignOutNotice.tsx'

const STATUS_TONE = { up_to_date: 'ok', out_of_date: 'warn', none: 'muted' } as const

const FIX_PATHS = { purposes: '/dpo/purposes', transfers: '/dpo/transfers', contact: '/dpo/contact' } as const
const FIX_LABELS = {
  purposes: NOTICE_TAB.draft.toPurposes,
  transfers: NOTICE_TAB.draft.toTransfers,
  contact: NOTICE_TAB.draft.toContact,
} as const

export function NoticeTab() {
  const query = useQuery(noticeAdminQuery)
  const refusal = query.error === null ? undefined : refusalOfError(query.error)
  const retry = () => void query.refetch()
  return (
    <Page>
      <div className="flex flex-col gap-5">
        {refusal?.kind !== 'forbidden' && <RegisterLinks current="notice" />}
        {refusal !== undefined && <ReadRefusal refusal={refusal} retry={retry} />}
        {query.isPending && (
          <p role="status" className="text-muted">
            {NOTICE_TAB.loading}
          </p>
        )}
        {query.data !== undefined && refusal?.kind !== 'forbidden' && <NoticeAdmin answer={query.data} />}
      </div>
    </Page>
  )
}

// A titled part of the tab, under the shell's h1.
function Part({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h2 id={id} className="font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}

// The answer, as the tab shows it (noticeTabView), with Publish's confirmation when it is open.
function NoticeAdmin({ answer }: { answer: NoticeAdminForClient }) {
  const runtime = useRuntime()
  const view = noticeTabView(answer, ms => runtime.formatters.date(ms))
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <Part title={NOTICE_TAB.published.title}>
        <div className="flex flex-wrap items-start gap-2">
          <Pill tone={STATUS_TONE[view.status]}>{NOTICE_STATUS_LABELS[view.status]}</Pill>
        </div>
        {view.published.map(line => (
          <p key={line}>{line}</p>
        ))}
        {view.record !== undefined && <RecordAcknowledgement version={view.record.version} />}
      </Part>
      <Part title={NOTICE_TAB.draft.title(view.version)}>
        <Draft view={view} />
        <Button
          variant="primary"
          className="self-start"
          disabledReason={view.publishHeld}
          onClick={() => setConfirming(true)}
        >
          {NOTICE_TAB.draft.publish(view.version)}
        </Button>
      </Part>
      <Part title={NOTICE_TAB.preview.title(view.version)}>
        {view.body === undefined ? (
          <p className="text-muted">{NOTICE_TAB.preview.hidden}</p>
        ) : (
          <section
            aria-label={NOTICE_TAB.preview.label(view.version)}
            className="rounded-xl border border-line bg-bg px-4 py-4 sm:px-5"
          >
            <NoticeBody body={view.body} level={3} />
          </section>
        )}
      </Part>
      {view.history.length > 0 && (
        <Part title={NOTICE_TAB.history.title}>
          <ul className="flex flex-col gap-2">
            {view.history.map(row => (
              <li key={row.id} className="flex flex-col gap-0.5">
                {row.lines.map((line, at) => (
                  <span key={line} className={at === 0 ? undefined : 'text-small text-muted'}>
                    {line}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </Part>
      )}
      {confirming && <PublishDialog answer={answer} version={view.version} onClose={() => setConfirming(false)} />}
    </>
  )
}

// What the next version changes, holds it back and warns of.
function Draft({ view }: { view: NoticeTabView }) {
  return (
    <>
      {view.first && <p>{NOTICE_TAB.draft.first}</p>}
      {view.changes !== undefined && (
        <div className="flex flex-col gap-2">
          <p className="font-medium">{NOTICE_TAB.draft.changes}</p>
          {view.changes.groups.map(group => (
            <div key={group.title} className="flex flex-col gap-1">
              <p>{group.title}</p>
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {group.lines.map(line => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
          {view.changes.contact !== undefined && <p>{view.changes.contact}</p>}
          {view.changes.wording && <p>{NOTICE_TAB.draft.wording}</p>}
        </div>
      )}
      {view.problems.length > 0 && (
        <Note tone="info" title={NOTICE_TAB.draft.problems}>
          <ul className="flex list-disc flex-col gap-2 pl-5">
            {view.problems.map(group =>
              group.subject === undefined ? (
                group.lines.map(line => <li key={`${group.key}:${line}`}>{line}</li>)
              ) : (
                <li key={group.key} className="flex flex-col gap-1">
                  <span className="font-medium">{group.subject}</span>
                  <ul className="flex list-[circle] flex-col gap-1 pl-5">
                    {group.lines.map(line => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </li>
              ),
            )}
          </ul>
          <div className="flex flex-wrap gap-2 pt-1">
            {view.fixAt.map(page => (
              <Link
                key={page}
                to={FIX_PATHS[page]}
                activeOptions={{ exact: true }}
                activeProps={{}}
                className={buttonClass()}
              >
                {FIX_LABELS[page]}
              </Link>
            ))}
          </div>
        </Note>
      )}
      {view.warnings.length > 0 && <Note tone="warn" title={NOTICE_TAB.draft.warnings} items={view.warnings} />}
    </>
  )
}

// The confirmation, then the publish: a refusal shows here (the PIN step, after which the same
// publish is sent once more; Reload for a draft that moved; a new sign-in; or the server's words).
function PublishDialog({
  answer,
  version,
  onClose,
}: {
  answer: NoticeAdminForClient
  version: string
  onClose(): void
}) {
  const runtime = useRuntime()
  const queryClient = useQueryClient()
  const [refusal, setRefusal] = useState<Refusal | undefined>()
  // The publish's own effects live on the mutation, as the register writes' do (useRegisterWrite):
  // they run even if the dialog has gone by the time it lands.
  const mutation = useMutation({
    mutationFn: publishNotice,
    onSuccess: () => {
      // Everyone, the DPO included, acknowledges the new version before going on (PD-39): this tab
      // goes to /notice now, rather than at its next refused request, and /notice names the version.
      runtime.notice.required()
    },
  })
  const body = publishBodyOf(answer)
  const send = () => {
    if (mutation.isPending || body === undefined) return
    setRefusal(undefined)
    mutation.mutate(body, { onSuccess: onClose, onError: error => setRefusal(publishRefusalOf(error)) })
  }
  const reload = () => {
    setRefusal(undefined)
    void queryClient.invalidateQueries({ queryKey: noticeAdminQuery.queryKey }).then(onClose)
  }
  return (
    <Dialog
      open
      presentation="centred"
      onClose={onClose}
      title={NOTICE_TAB.confirm.title(version)}
      footer={
        <>
          <Button onClick={onClose}>{DPO.cancel}</Button>
          <Button
            variant="primary"
            disabledReason={mutation.isPending ? NOTICE_TAB.draft.publishing : undefined}
            onClick={send}
          >
            {NOTICE_TAB.draft.publish(version)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <PublishRefusal refusal={refusal} retry={send} reload={reload} />
        <p>{NOTICE_TAB.confirm.body(version)}</p>
      </div>
    </Dialog>
  )
}

function PublishRefusal({ refusal, retry, reload }: { refusal: Refusal | undefined; retry(): void; reload(): void }) {
  if (refusal === undefined) return null
  switch (refusal.kind) {
    case 'pin':
      return <ReauthPin onConfirmed={retry} />
    case 'sign_in':
      return <SignOutNotice text={refusal.text} />
    case 'changed':
      return (
        <Note tone="error">
          <p>{refusal.text}</p>
          <Button className="self-start" onClick={reload}>
            {DPO.reload}
          </Button>
        </Note>
      )
    default:
      return (
        <Note tone="error">
          <p>{refusal.text}</p>
        </Note>
      )
  }
}
