// What both DPO pages share (C0.9 PD-20, PD-25, PD-26, OD-03): the frame, the links between the
// two registers, the registers' answer with each way it can be refused, and the writes.
//
// The server decides who may read or change the registers (can(): the DPO alone, freshly
// re-authenticated, PD-20 and PD-30); the page only says what it answered:
// - forbidden: "This page is for the Data Protection Officer.", for anyone else's deep link;
// - reauth_required naming the PIN: the inline PIN step (ReauthPin), then the read again;
// - any other method: only a new sign-in mends it (SignOutNotice);
// - anything else: the server's words and Try again.
// A refusal of a later read keeps what the page already shows below it.
//
// useRegisterWrite() sends one write and reads the registers again when it lands. A refusal shows
// in the dialog that made it (WriteRefusal): the PIN step, after which the same write is sent once
// more; register_changed, with Reload (PD-25); or the server's words.

import type { RegistersForClient } from '@hearth/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check, ShieldX } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { DPO } from '@/strings/dpo.ts'
import { Button } from '@/ui/Button.tsx'
import { cx } from '@/ui/cx.ts'
import { EmptyState } from '@/ui/EmptyState.tsx'
import { Page } from '@/ui/Page.tsx'
import { toast } from '@/ui/toast.ts'
import { type Refusal, refusalOfError } from './model.ts'
import { Note } from './parts.tsx'
import { type RegisterWrite, registersQuery, sendWrite } from './queries.ts'
import { ReauthPin } from './ReauthPin.tsx'
import { SignOutNotice } from './SignOutNotice.tsx'

export type RegisterName = 'purposes' | 'transfers'

const REGISTER_PATHS = { purposes: '/dpo/purposes', transfers: '/dpo/transfers' } as const

// The two registers as links in a segmented track (finance's large segmented control, as the kit's
// Segmented draws it): each is a real URL, so Back and Forward move between them (X12), and the
// current one is marked by aria-current, the ink fill and a check mark, never colour alone.
function RegisterLinks({ current }: { current: RegisterName }) {
  return (
    <nav aria-label={DPO.tabs.label}>
      <div className="inline-flex max-w-full flex-wrap gap-2 rounded-2xl border border-line bg-surface p-1.5">
        {(['purposes', 'transfers'] as const).map(name => {
          const here = name === current
          return (
            <Link
              key={name}
              to={REGISTER_PATHS[name]}
              aria-current={here ? 'page' : undefined}
              activeOptions={{ exact: true }}
              activeProps={{}}
              className={cx(
                'inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 font-medium transition',
                here ? 'bg-fg text-surface' : 'text-fg hover:bg-bg',
              )}
            >
              {here && <Check aria-hidden size={16} className="shrink-0" />}
              {DPO.tabs[name]}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

// A refused read: what it asks of the person.
export function ReadRefusal({ refusal, retry }: { refusal: Refusal; retry(): void }) {
  switch (refusal.kind) {
    case 'pin':
      return <ReauthPin onConfirmed={retry} />
    case 'sign_in':
      return <SignOutNotice text={refusal.text} />
    case 'forbidden':
      return <EmptyState icon={ShieldX} title={refusal.text} />
    default:
      return (
        <Note tone="error">
          <p>{refusal.text}</p>
          <Button className="self-start" onClick={retry}>
            {DPO.retry}
          </Button>
        </Note>
      )
  }
}

export interface RegisterPageProps {
  current: RegisterName
  children(registers: RegistersForClient): ReactNode
}

export function RegisterPage({ current, children }: RegisterPageProps) {
  const query = useQuery(registersQuery)
  const refusal = query.error === null ? undefined : refusalOfError(query.error)
  const retry = () => void query.refetch()
  return (
    <Page>
      <div className="flex flex-col gap-5">
        {refusal?.kind !== 'forbidden' && <RegisterLinks current={current} />}
        {refusal !== undefined && <ReadRefusal refusal={refusal} retry={retry} />}
        {query.isPending && (
          <p role="status" className="text-muted">
            {DPO.loading}
          </p>
        )}
        {query.data !== undefined && refusal?.kind !== 'forbidden' && children(query.data)}
      </div>
    </Page>
  )
}

export interface RegisterWriter {
  // Sends a write; the dialog closes (done) once it lands and the registers are read again.
  send(write: RegisterWrite): void
  readonly pending: boolean
  readonly refusal: Refusal | undefined
  // The PIN was confirmed: the refused write once more.
  retry(): void
  // register_changed: read the registers again, then close.
  reload(): void
}

// done: called once a write has landed and the registers have been read again, with the toast's
// text; the caller closes its dialog.
export function useRegisterWrite(done: () => void, savedText: string = DPO.saved): RegisterWriter {
  const queryClient = useQueryClient()
  const last = useRef<RegisterWrite | undefined>(undefined)
  const [refusal, setRefusal] = useState<Refusal | undefined>()
  const mutation = useMutation({ mutationFn: sendWrite })
  const reread = () => queryClient.invalidateQueries({ queryKey: registersQuery.queryKey })

  const run = (write: RegisterWrite) => {
    if (mutation.isPending) return
    last.current = write
    setRefusal(undefined)
    mutation.mutate(write, {
      onSuccess: async () => {
        await reread()
        toast({ text: savedText })
        done()
      },
      onError: error => setRefusal(refusalOfError(error)),
    })
  }

  return {
    send: run,
    pending: mutation.isPending,
    refusal,
    retry: () => {
      if (last.current !== undefined) run(last.current)
    },
    reload: () => {
      setRefusal(undefined)
      void reread().then(done)
    },
  }
}

// A refused write, in its dialog.
export function WriteRefusal({ writer }: { writer: RegisterWriter }) {
  const refusal = writer.refusal
  if (refusal === undefined) return null
  switch (refusal.kind) {
    case 'pin':
      return <ReauthPin onConfirmed={writer.retry} />
    case 'sign_in':
      return <SignOutNotice text={refusal.text} />
    case 'changed':
      return (
        <Note tone="error">
          <p>{refusal.text}</p>
          <Button className="self-start" onClick={writer.reload}>
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
