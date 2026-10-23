// The DPO's business contact (PDPA-13, PDPA-02; C0.9 OD-10, OD-11, PD-64, PD-70), the DPO's page at
// /dpo/contact, beside the registers under the same links. It shows GET /api/admin/notice/contact's
// answer (dpo/contact-model.ts): the contact recorded now, or that there is none yet, which holds
// publishing back (dpo_contact_pending); and whether the published notice gives it. The notice
// prints the contact its version was published from, and Settings shows that one to everyone, so
// a change here reaches people only once the next version is published (OD-11), and the page says
// so before it saves.
//
// Record or Edit opens the kit's Dialog: a role title and at least one way to reach the DPO outside
// Hearth (an email address, a phone number or a postal address; OD-10), with what still holds the
// save back (contactProblems, on the body the save would send). Save sends the settings version the
// page read; the server refuses one that moved (409 register_changed, with Reload), a rule the page
// didn't catch (400 register_invalid), or asks for the PIN when the session's re-authentication is
// stale (the PIN step, then the same save once more). Nothing is kept outside the dialog's state:
// a reload loses an unsaved edit (WS-01). The router loads this module lazily (router/router.tsx).
import {
  CONTACT_EMAIL_MAX,
  CONTACT_PHONE_MAX,
  CONTACT_POSTAL_MAX,
  CONTACT_TITLE_MAX,
  type ContactAdminForClient,
  type SetContactJSON,
} from '@hearth/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Pencil } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { focusAfter } from '@/lib/focus.ts'
import { DPO } from '@/strings/dpo.ts'
import { CONTACT } from '@/strings/dpo-contact.ts'
import { Button, buttonClass } from '@/ui/Button.tsx'
import { cx } from '@/ui/cx.ts'
import { Dialog } from '@/ui/Dialog.tsx'
import { Page } from '@/ui/Page.tsx'
import { toast } from '@/ui/toast.ts'
import {
  type ContactForm,
  contactBodyOf,
  contactEditor,
  contactFormOf,
  contactRefusalOf,
  contactSavedText,
  contactView,
} from './contact-model.ts'
import { type Refusal, refusalOfError } from './model.ts'
import { NoticeBadge, SaveStopsNote } from './notice-markers.tsx'
import { Facts, Note, Pill, TextField } from './parts.tsx'
import { CONTACT_SAVE_MOVES, contactQuery, saveContact } from './queries.ts'
import { ReadRefusal, RegisterLinks, WriteRefusal } from './RegisterPage.tsx'

export function ContactScreen() {
  const query = useQuery(contactQuery)
  const refusal = query.error === null ? undefined : refusalOfError(query.error)
  const retry = () => void query.refetch()
  return (
    <Page>
      <div className="flex flex-col gap-5">
        {refusal?.kind !== 'forbidden' && (
          <RegisterLinks
            current="contact"
            badges={{ notice: query.data !== undefined && <NoticeBadge status={query.data.notice} /> }}
          />
        )}
        {refusal !== undefined && <ReadRefusal refusal={refusal} retry={retry} />}
        {query.isPending && (
          <p role="status" className="text-muted">
            {CONTACT.loading}
          </p>
        )}
        {query.data !== undefined && refusal?.kind !== 'forbidden' && <ContactContent answer={query.data} />}
      </div>
    </Page>
  )
}

// The answer, as the page shows it, with the dialog when it is open. Exported for its markup test
// (dpo/dpo.markup.test.tsx).
export function ContactContent({ answer }: { answer: ContactAdminForClient }) {
  const [editing, setEditing] = useState(false)
  const view = contactView(answer)
  const titleId = useId()
  // A first save swaps "Record contact details" for the contact and its Edit button before the
  // dialog closes, so the opener is gone and focus would drop to <body>: a save, or a reload after
  // register_changed, puts it on the card's button, Edit (or Record contact details while there is
  // still none; lib/focus.ts, the h1 if there is neither). Cancel and Escape leave the opener in
  // place, and the dialog gives focus back to it.
  // It moves from an effect, once the dialog has gone: a save lands outside any React event, so
  // React commits the close in a later task, and a frame can come first, while the modal dialog
  // still leaves the page behind it inert and focus() there does nothing. The dialog's own cleanup
  // has run by the time this effect does (React runs a removed component's cleanups first).
  const action = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    focusAfter(() => action.current)
  }, [editing])
  const saved = () => {
    refocus.current = true
    setEditing(false)
  }
  return (
    <>
      <p>{CONTACT.intro}</p>
      <section
        aria-labelledby={titleId}
        className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:p-5"
      >
        {view.kind === 'none' ? (
          <>
            <h2 id={titleId} className="font-semibold">
              {CONTACT.none.title}
            </h2>
            <p>{CONTACT.none.body}</p>
            <Button ref={action} variant="primary" className="self-start" onClick={() => setEditing(true)}>
              {CONTACT.none.record}
            </Button>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-start gap-2">
              <h2 id={titleId} className="min-w-0 flex-1 break-words font-semibold">
                {view.title}
              </h2>
              {view.pill !== undefined && <Pill tone={view.pill.tone}>{view.pill.text}</Pill>}
            </div>
            {view.line !== undefined && (
              <>
                <p>{view.line}</p>
                <Link
                  to="/dpo/notice"
                  activeOptions={{ exact: true }}
                  activeProps={{}}
                  className={cx(buttonClass(), 'self-start')}
                >
                  {CONTACT.toNotice}
                </Link>
              </>
            )}
            <Facts facts={view.facts} />
            <Button
              ref={action}
              icon={Pencil}
              className="self-start"
              aria-label={CONTACT.edit}
              onClick={() => setEditing(true)}
            >
              {DPO.editButton}
            </Button>
          </>
        )}
      </section>
      {editing && <ContactDialog answer={answer} onClose={() => setEditing(false)} onSaved={saved} />}
    </>
  )
}

interface ContactWriter {
  send(body: SetContactJSON): void
  readonly pending: boolean
  readonly refusal: Refusal | undefined
  // The PIN was confirmed: the refused save once more.
  retry(): void
  // register_changed: read the contact again, then close.
  reload(): void
}

// One save, as useRegisterWrite() sends a register's: its effects live on the mutation, so the
// contact, the registers and the Notice tab are read again and the toast shown even if the dialog
// has gone by the time it lands; done() closes the dialog once they have been.
function useContactWrite(done: () => void): ContactWriter {
  const queryClient = useQueryClient()
  const last = useRef<SetContactJSON | undefined>(undefined)
  const [refusal, setRefusal] = useState<Refusal | undefined>()
  const mutation = useMutation({
    mutationFn: saveContact,
    onSuccess: async result => {
      await Promise.all(CONTACT_SAVE_MOVES.map(queryKey => queryClient.invalidateQueries({ queryKey })))
      toast({ text: contactSavedText(result) })
    },
  })

  const run = (body: SetContactJSON) => {
    if (mutation.isPending) return
    last.current = body
    setRefusal(undefined)
    mutation.mutate(body, {
      onSuccess: () => done(),
      onError: error => setRefusal(contactRefusalOf(error)),
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
      void queryClient.invalidateQueries({ queryKey: contactQuery.queryKey }).then(done)
    },
  }
}

// Exported for its markup test (dpo/dpo.markup.test.tsx). onSaved closes it once a save, or a
// reload after register_changed, has been read again; onClose is Cancel and Escape.
export function ContactDialog({
  answer,
  onClose,
  onSaved = onClose,
}: {
  answer: ContactAdminForClient
  onClose(): void
  onSaved?: () => void
}) {
  const row = answer.contact
  const [form, setForm] = useState<ContactForm>(() => contactFormOf(row))
  const editor = contactEditor(form, answer)
  const writer = useContactWrite(onSaved)
  const formId = useId()
  const problemId = useId()
  const set = (change: Partial<ContactForm>) => setForm(before => ({ ...before, ...change }))
  const held = writer.pending ? DPO.saving : editor.problems.length > 0 ? DPO.fixFirst : undefined
  // Each field's problem lines, by the ids of their items in the list below the fields (a missing
  // channel's, which names no field, under undefined).
  const problemsOf = (field: keyof ContactForm | undefined) =>
    editor.problems.flatMap((problem, at) => (problem.field === field ? [`${problemId}${at}`] : []))
  const submit = () => {
    if (held === undefined) writer.send(contactBodyOf(row, form))
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={row === null ? CONTACT.dialog.recordTitle : CONTACT.dialog.editTitle}
      footer={
        <>
          <Button onClick={onClose}>{DPO.cancel}</Button>
          <Button type="submit" form={formId} variant="primary" disabledReason={held}>
            {DPO.save}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p>{CONTACT.advice}</p>
        <WriteRefusal writer={writer} />
        <form
          id={formId}
          method="post"
          noValidate
          onSubmit={event => {
            event.preventDefault()
            submit()
          }}
          className="flex flex-col gap-4"
        >
          <TextField
            label={CONTACT.dialog.title}
            name="contact-title"
            hint={CONTACT.dialog.titleHint}
            maxLength={CONTACT_TITLE_MAX}
            problems={problemsOf('title')}
            value={form.title}
            onChange={title => set({ title })}
          />
          {/* The three ways to reach the DPO are one group, and its legend says any one will do, so
              each field is heard with it (WCAG 1.3.1, 3.3.2); the line saying none is given yet
              describes the group. */}
          <fieldset
            aria-describedby={problemsOf(undefined).join(' ') || undefined}
            className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
          >
            <legend className="mb-4 p-0 text-small text-muted">{CONTACT.dialog.channels}</legend>
            <TextField
              label={CONTACT.dialog.email}
              name="contact-email"
              type="email"
              inputMode="email"
              hint={CONTACT.dialog.emailHint}
              maxLength={CONTACT_EMAIL_MAX}
              problems={problemsOf('email')}
              value={form.email}
              onChange={email => set({ email })}
            />
            <TextField
              label={CONTACT.dialog.phone}
              name="contact-phone"
              type="tel"
              inputMode="tel"
              hint={CONTACT.dialog.phoneHint}
              maxLength={CONTACT_PHONE_MAX}
              problems={problemsOf('phone')}
              value={form.phone}
              onChange={phone => set({ phone })}
            />
            <TextField
              label={CONTACT.dialog.postal}
              name="contact-postal"
              multiline
              rows={3}
              hint={CONTACT.dialog.postalHint}
              maxLength={CONTACT_POSTAL_MAX}
              problems={problemsOf('postal')}
              value={form.postal}
              onChange={postal => set({ postal })}
            />
          </fieldset>
          {editor.problems.length > 0 && (
            <Note tone="info" title={DPO.beforeSaving}>
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {editor.problems.map((problem, at) => (
                  <li key={`${problem.field}:${problem.text}`} id={`${problemId}${at}`}>
                    {problem.text}
                  </li>
                ))}
              </ul>
            </Note>
          )}
          {editor.stale && <SaveStopsNote text={CONTACT.dialog.staleWarning} />}
        </form>
      </div>
    </Dialog>
  )
}
