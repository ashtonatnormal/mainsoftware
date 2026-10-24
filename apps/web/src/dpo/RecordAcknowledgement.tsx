// Recording an acknowledgement made outside Hearth, from the Notice tab (PDPA-03, ACC-12; C0.9
// OD-19, PD-75, PD-76): for the latest version, for someone else still at the organisation, with
// the day they acknowledged it and a short note of how (for example, on paper at induction). A
// record lets that person use Hearth at once, and they see the day and the note in their Settings.
//
// "Record an acknowledgement" sits by the count of acknowledgements, once a version is published.
// It opens the kit's Dialog, which reads GET /api/admin/notice/people only while it is open
// (notice.people.read, the DPO alone): the people still at the organisation but the DPO, by name
// and department, then their manager and the day they were added where two would read the same
// (dpo/notice-model.ts recordOptions); never a number or whether they have acknowledged. The DPO
// picks the person, the day (from the version's publication day to today, in the org's zone) and
// how; what still holds the record back is listed (recordEditor), and Record posts it. The server
// decides again: 409 notice_changed (a newer version, with Reload), 400 notice_invalid, 403
// forbidden (yourself, or someone who has left), or the PIN step, then the same record once more.
// Once it lands the toast says whether it recorded anything (the person may have acknowledged
// already), the dialog closes, focus returns to the button, and the count is read again. The
// Notice tab imports this module, so it loads in the tab's chunk.
import { NOTICE_NOTE_MAX, type NoticePeopleForClient, type RecordAcknowledgementJSON } from '@hearth/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type RefObject, useEffect, useId, useRef, useState } from 'react'
import { DPO } from '@/strings/dpo.ts'
import { RECORD } from '@/strings/dpo-record.ts'
import { Button } from '@/ui/Button.tsx'
import { Dialog } from '@/ui/Dialog.tsx'
import { Select } from '@/ui/Select.tsx'
import { toast } from '@/ui/toast.ts'
import { dayText, type Refusal, refusalOfError } from './model.ts'
import {
  EMPTY_RECORD,
  type RecordEditor,
  type RecordForm,
  recordEditor,
  recordedText,
  recordRefusalOf,
} from './notice-model.ts'
import { DateField, Note, TextField } from './parts.tsx'
import { noticeAdminQuery, noticePeopleQuery, recordAcknowledgement } from './queries.ts'
import { ReadRefusal, WriteRefusal } from './RegisterPage.tsx'

// version: the latest version, as the Notice tab read it.
export function RecordAcknowledgement({ version }: { version: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button className="self-start" onClick={() => setOpen(true)}>
        {RECORD.open}
      </Button>
      {open && <RecordDialog version={version} onClose={() => setOpen(false)} />}
    </>
  )
}

// The record, and what the toast says once it lands.
interface Recording {
  readonly body: RecordAcknowledgementJSON
  readonly name: string
  readonly version: string
}

// One record, as the register writes send theirs (RegisterPage.tsx useRegisterWrite): its effects
// live on the mutation, so the count is read again and the toast shown even if the dialog has gone
// by the time it lands; done() closes the dialog.
function useRecord(done: () => void) {
  const queryClient = useQueryClient()
  const last = useRef<Recording | undefined>(undefined)
  const [refusal, setRefusal] = useState<Refusal | undefined>()
  const mutation = useMutation({
    mutationFn: (recording: Recording) => recordAcknowledgement(recording.body),
    onSuccess: async (result, recording) => {
      await queryClient.invalidateQueries({ queryKey: noticeAdminQuery.queryKey })
      toast({ text: recordedText(result, recording.name, recording.version) })
    },
  })
  const send = (recording: Recording) => {
    if (mutation.isPending) return
    last.current = recording
    setRefusal(undefined)
    mutation.mutate(recording, {
      onSuccess: () => done(),
      onError: error => setRefusal(recordRefusalOf(error, recording.version)),
    })
  }
  return {
    send,
    pending: mutation.isPending,
    refusal,
    // The PIN was confirmed: the refused record once more.
    retry: () => {
      if (last.current !== undefined) send(last.current)
    },
    // notice_changed: the Notice tab and the list are read again, then the dialog closes.
    reload: () => {
      setRefusal(undefined)
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: noticeAdminQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: noticePeopleQuery.queryKey }),
      ]).then(done)
    },
  }
}

// Exported for its markup test (dpo/dpo.markup.test.tsx).
export function RecordDialog({ version, onClose }: { version: string; onClose(): void }) {
  const query = useQuery(noticePeopleQuery)
  const readRefusal = query.error === null ? undefined : refusalOfError(query.error)
  const [form, setForm] = useState<RecordForm>(EMPTY_RECORD)
  const record = useRecord(onClose)
  const formId = useId()
  // The first field: it takes focus as the dialog opens when the people are already read, else
  // once they arrive (RecordFields).
  const first = useRef<HTMLSelectElement>(null)
  const people = query.data
  const editor = people === undefined || people.people.length === 0 ? undefined : recordEditor(people, form)
  const held = record.pending ? RECORD.recording : editor?.recording === undefined ? DPO.fixFirst : undefined
  const submit = () => {
    const recording = editor?.recording
    if (held !== undefined || editor === undefined || recording === undefined) return
    record.send({ ...recording, version: editor.version })
  }
  return (
    <Dialog
      open
      onClose={onClose}
      initialFocus={first}
      title={RECORD.title(editor?.version ?? version)}
      footer={
        <>
          <Button onClick={onClose}>{DPO.cancel}</Button>
          {editor !== undefined && (
            <Button type="submit" form={formId} variant="primary" disabledReason={held}>
              {RECORD.record}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p>{RECORD.intro}</p>
        {readRefusal !== undefined && <ReadRefusal refusal={readRefusal} retry={() => void query.refetch()} />}
        {query.isPending && (
          <p role="status" className="text-muted">
            {RECORD.loadingPeople}
          </p>
        )}
        {people !== undefined && editor === undefined && <p>{RECORD.nobody}</p>}
        {people !== undefined && editor !== undefined && (
          <>
            {/* Outside the form: the PIN step it may show is a form of its own, and a form inside a
                form never sends its submit. */}
            <WriteRefusal writer={record} />
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
              <RecordFields
                first={first}
                people={people}
                editor={editor}
                form={form}
                onChange={change => setForm(before => ({ ...before, ...change }))}
              />
            </form>
          </>
        )}
      </div>
    </Dialog>
  )
}

function RecordFields({
  first,
  people,
  editor,
  form,
  onChange,
}: {
  first: RefObject<HTMLSelectElement | null>
  people: NoticePeopleForClient
  editor: RecordEditor
  form: RecordForm
  onChange(change: Partial<RecordForm>): void
}) {
  // The first field takes focus once the people have arrived (the dialog opens before they do).
  useEffect(() => {
    first.current?.focus()
  }, [first])
  // The line saying the list was cut is the person field's description, so it is heard on the field.
  const moreId = useId()
  return (
    <>
      {editor.same && (
        <Note tone="warn">
          <p>{RECORD.sameDetails}</p>
        </Note>
      )}
      <div className="flex flex-col gap-1.5">
        <Select
          ref={first}
          label={RECORD.person}
          name="person"
          value={form.person}
          options={editor.options}
          onChange={event => onChange({ person: event.currentTarget.value })}
          aria-describedby={people.more ? moreId : undefined}
        />
        {people.more && (
          <p id={moreId} className="text-small text-muted">
            {RECORD.more}
          </p>
        )}
      </div>
      <DateField
        label={RECORD.day}
        name="acknowledged-on"
        hint={RECORD.dayHint(dayText(people.latest.publishedOn), dayText(people.today))}
        min={people.latest.publishedOn}
        max={people.today}
        value={form.acknowledgedOn}
        onChange={acknowledgedOn => onChange({ acknowledgedOn })}
      />
      <TextField
        label={RECORD.how}
        name="note"
        hint={RECORD.howHint}
        maxLength={NOTICE_NOTE_MAX}
        value={form.note}
        onChange={note => onChange({ note })}
      />
      {editor.problems.length > 0 && <Note tone="info" title={RECORD.beforeRecording} items={editor.problems} />}
    </>
  )
}
