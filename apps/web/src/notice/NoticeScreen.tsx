// /notice: the privacy notice a person reads and acknowledges before using Hearth (PDPA-02,
// PDPA-03, ACC-12; C0.9 PD-46, OD-01, OD-04; TECH-SPEC T22 item 31). It ports the behaviour of the
// demo's notice step (demo/src/screens/Onboarding.tsx NoticeStep), not its look, and sits outside
// the shell, in its own <main>, with one h1: nothing of the app is reachable from it but Sign out,
// and there is no Skip. The router brings a tab here whenever the person's standing isn't
// acknowledged (router/router.tsx); GET /api/notice decides what it shows (notice-model.ts):
// - the version and when it was published (in the person's zone), what changed since the version
//   they last acknowledged, and the body (NoticeBody) in a labelled, focusable scroll region;
// - a box to tick, "I've read the privacy notice, version N.", then Acknowledge. Pressed unticked,
//   it says "Tick the box to say you've read it." and moves focus to the box;
// - acknowledged, the notice store (session/notice.ts) starts or resumes the live connection, every
//   query is fetched again, the other tabs are told, and the router opens the path the tab was on
//   (else Chats). A 409 notice_changed (a newer version was published meanwhile) fetches the notice
//   again and says so; a 401 ends the session as any other does (session/query-client.ts).
// The answer is fetched again every 30 s while the page is visible, and on focus (api/queries.ts
// noticeQuery), so an acknowledgement made on another device moves this tab on too.
import { type AcknowledgeJSON, AcknowledgeResponseForClient, MESSAGES } from '@hearth/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Check, CircleAlert, Flame, Info } from 'lucide-react'
import { type ReactNode, useId, useRef, useState } from 'react'
import { ApiFailure, apiPost } from '@/api/http.ts'
import { noticeQuery, useSession } from '@/api/queries.ts'
import { useRuntime } from '@/app/runtime-context.ts'
import { focusAfter } from '@/lib/focus.ts'
import { signOutItem } from '@/shell/avatar-menu.ts'
import { NOTICE } from '@/strings/notice.ts'
import { SHELL } from '@/strings/shell.ts'
import { announce } from '@/ui/announce.ts'
import { Button, buttonClass } from '@/ui/Button.tsx'
import { cx } from '@/ui/cx.ts'
import { NoticeBody } from './NoticeBody.tsx'
import { type ChangeLines, type CurrentNotice, type NoticeView, noticeView } from './notice-model.ts'

export async function sendAcknowledgement(notice: string): Promise<void> {
  const body: AcknowledgeJSON = { notice }
  await apiPost('/api/notice/acknowledge', body, AcknowledgeResponseForClient)
}

export function NoticeScreen() {
  const query = useQuery(noticeQuery)
  const session = useSession()
  const view = noticeView(query.data, query.isError, session.capabilities.registers === true)
  return <NoticeFrame view={view} retry={() => void query.refetch()} />
}

// The screen for a view: exported so the markup tests render each state.
export function NoticeFrame({ view, retry }: { view: NoticeView; retry(): void }) {
  const runtime = useRuntime()
  const current = view.kind === 'acknowledged' || view.kind === 'required' ? view.current : undefined
  return (
    <main id="main" tabIndex={-1} className="wash flex h-dvh flex-col overflow-y-auto pt-safe pb-safe px-safe">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6 rail:py-10">
        <div className="flex flex-col gap-2">
          <span aria-hidden className="grid size-12 place-items-center rounded-2xl bg-accent text-accent-fg">
            <Flame size={26} />
          </span>
          <h1 tabIndex={-1} data-screen-title className="break-words font-display text-2xl font-semibold">
            {SHELL.notice}
          </h1>
          {current !== undefined && (
            <p className="text-muted">
              {NOTICE.version(String(current.version), runtime.formatters.date(current.publishedAt))}
            </p>
          )}
        </div>
        <NoticeState view={view} retry={retry} />
      </div>
    </main>
  )
}

function NoticeState({ view, retry }: { view: NoticeView; retry(): void }) {
  switch (view.kind) {
    case 'loading':
      return (
        <p role="status" className="text-muted">
          {NOTICE.loading}
        </p>
      )
    case 'failed':
      return (
        <>
          <p>{NOTICE.loadFailed}</p>
          <Actions>
            <Button variant="primary" onClick={retry}>
              {NOTICE.retry}
            </Button>
            <SignOutButton />
          </Actions>
        </>
      )
    case 'unpublished':
      return view.dpo ? (
        <Titled title={NOTICE.unpublished.dpoTitle}>
          <p>{NOTICE.unpublished.dpoBody}</p>
          <Actions>
            <Link to="/dpo/notice" activeOptions={{ exact: true }} activeProps={{}} className={buttonClass('primary')}>
              {NOTICE.unpublished.toNotice}
            </Link>
            <Link to="/dpo/purposes" activeOptions={{ exact: true }} activeProps={{}} className={buttonClass()}>
              {NOTICE.unpublished.toPurposes}
            </Link>
            <SignOutButton />
          </Actions>
        </Titled>
      ) : (
        <Titled title={NOTICE.unpublished.title}>
          <p>{NOTICE.unpublished.body}</p>
          <Actions>
            <SignOutButton />
          </Actions>
        </Titled>
      )
    case 'acknowledged':
      return <Acknowledged current={view.current} acknowledgedAt={view.acknowledgedAt} />
    case 'required':
      return <Required current={view.current} changes={view.changes} />
  }
}

// A state with its own heading, under the screen's h1.
function Titled({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="font-display text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>
}

function SignOutButton() {
  const runtime = useRuntime()
  const navigate = useNavigate()
  return (
    <Button variant="ghost" onClick={() => void signOutItem.run({ runtime, navigate: to => void navigate({ to }) })}>
      {NOTICE.signOut}
    </Button>
  )
}

// The body in its scroll region: labelled, and focusable so a keyboard can scroll it.
function BodyRegion({ current }: { current: CurrentNotice }) {
  return (
    <section
      aria-label={NOTICE.bodyLabel(String(current.version))}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region a keyboard must be able to reach and scroll (WCAG 2.1.1)
      tabIndex={0}
      className="min-h-40 flex-1 overflow-y-auto rounded-2xl border border-line bg-surface px-4 py-4 sm:px-5"
    >
      <NoticeBody body={current.body} />
    </section>
  )
}

function Acknowledged({ current, acknowledgedAt }: { current: CurrentNotice; acknowledgedAt: number | undefined }) {
  const runtime = useRuntime()
  const navigate = useNavigate()
  return (
    <>
      <BodyRegion current={current} />
      {acknowledgedAt !== undefined && (
        <p>{NOTICE.acknowledgedOn(String(current.version), runtime.formatters.date(acknowledgedAt))}</p>
      )}
      <Actions>
        <Button
          variant="primary"
          size="lg"
          onClick={() => void navigate({ to: runtime.notice.takeReturn() ?? '/chats', replace: true })}
        >
          {NOTICE.continue}
        </Button>
      </Actions>
    </>
  )
}

function Changes({ changes }: { changes: ChangeLines }) {
  const groups = [
    [NOTICE.changes.added, changes.added],
    [NOTICE.changes.changed, changes.changed],
    [NOTICE.changes.removed, changes.removed],
  ] as const
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-2 rounded-xl border border-line bg-accent-soft px-4 py-3 text-fg"
    >
      <h2 id={id} className="flex items-center gap-2 font-semibold">
        <Info aria-hidden size={18} className="shrink-0" />
        {NOTICE.changes.title(String(changes.since))}
      </h2>
      {groups.map(
        ([title, lines]) =>
          lines.length > 0 && (
            <div key={title} className="flex flex-col gap-1">
              <p className="font-medium">{title}</p>
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {lines.map(line => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ),
      )}
      {changes.wording && <p>{NOTICE.changes.wording}</p>}
    </section>
  )
}

function Required({ current, changes }: { current: CurrentNotice; changes: ChangeLines | undefined }) {
  const [newer, setNewer] = useState(false)
  return (
    <>
      {newer && (
        <p className="flex items-start gap-2 rounded-xl border border-line bg-accent-soft px-4 py-3 text-fg">
          <Info aria-hidden size={18} className="mt-0.5 shrink-0" />
          <span>{NOTICE.newer}</span>
        </p>
      )}
      {changes !== undefined && <Changes changes={changes} />}
      <BodyRegion current={current} />
      {/* A new version starts with the box unticked. */}
      <AcknowledgeForm key={current.id} current={current} onNewer={() => setNewer(true)} />
    </>
  )
}

function AcknowledgeForm({ current, onNewer }: { current: CurrentNotice; onNewer(): void }) {
  const runtime = useRuntime()
  const queryClient = useQueryClient()
  const [ticked, setTicked] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [refusal, setRefusal] = useState<string | undefined>()
  const box = useRef<HTMLInputElement>(null)
  const ids = useId()
  // Kept on the mutation, so it runs even if the screen has gone meanwhile.
  const mutation = useMutation({
    mutationFn: sendAcknowledgement,
    onSuccess: () => runtime.notice.acknowledged('here'),
  })

  const refused = (failure: unknown) => {
    if (!(failure instanceof ApiFailure)) {
      setRefusal(MESSAGES.internal)
      return
    }
    // The session is ending (the QueryClient saw the 401), or already has.
    if (failure.code === 'signed_out' || failure.code === 'halted') return
    // A newer version, or one this person can no longer see: read the notice again.
    if (failure.code === 'notice_changed' || failure.status === 404) {
      onNewer()
      announce(NOTICE.newer, 'assertive')
      void queryClient.invalidateQueries({ queryKey: noticeQuery.queryKey, exact: true })
      return
    }
    setRefusal(failure.serverMessage)
  }

  const submit = () => {
    if (mutation.isPending) return
    if (!ticked) {
      setError(NOTICE.tickFirst)
      if (box.current !== null && box.current === document.activeElement) announce(NOTICE.tickFirst, 'assertive')
      else focusAfter(() => box.current)
      return
    }
    setRefusal(undefined)
    mutation.mutate(current.id, { onError: refused })
  }

  const errorId = `${ids}error`
  return (
    <form
      method="post"
      noValidate
      onSubmit={event => {
        event.preventDefault()
        submit()
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <div className="relative flex min-h-11 items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2">
          <span
            aria-hidden
            className={cx(
              'inline-grid size-5 shrink-0 place-items-center rounded-md border',
              ticked ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong bg-surface',
            )}
          >
            {ticked && <Check size={14} strokeWidth={3} />}
          </span>
          <span id={`${ids}label`} className="min-w-0 flex-1">
            {NOTICE.confirm(String(current.version))}
          </span>
          <input
            ref={box}
            type="checkbox"
            name="read"
            checked={ticked}
            aria-labelledby={`${ids}label`}
            aria-describedby={error === undefined ? undefined : errorId}
            aria-invalid={error === undefined ? undefined : true}
            onChange={event => {
              setTicked(event.currentTarget.checked)
              if (event.currentTarget.checked) setError(undefined)
            }}
            // -inset-px, not inset-0: the box has a 1 px border, so the input covers its border box
            // (44 px tall, targets44) rather than the 42 px inside it.
            className="absolute -inset-px z-10 m-0 cursor-pointer appearance-none rounded-xl"
          />
        </div>
        {error !== undefined && (
          <p id={errorId} className="flex items-start gap-1.5 text-small text-rec">
            <CircleAlert aria-hidden size={16} className="mt-px shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </div>
      {refusal !== undefined && (
        <p className="flex items-start gap-2 rounded-xl border border-rec/30 bg-rec-soft px-4 py-3 text-rec">
          <CircleAlert aria-hidden size={18} className="mt-0.5 shrink-0" />
          <span>{refusal}</span>
        </p>
      )}
      <Actions>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full sm:w-auto"
          disabledReason={mutation.isPending ? NOTICE.acknowledging : undefined}
        >
          {mutation.isPending ? NOTICE.acknowledging : NOTICE.acknowledge}
        </Button>
        <SignOutButton />
      </Actions>
    </form>
  )
}
