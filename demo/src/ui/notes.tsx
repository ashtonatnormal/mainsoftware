// Meeting notes card (REC-11/12): used in chat (posted to the session's thread)
// and on the session page. Notes are AI-generated, so they carry the AI marker
// and a machine-generated label (PDPA-08).
import { useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronUp, CircleHelp, Gavel, Lock, Mic, PlayCircle } from 'lucide-react'
import { useStore } from '../store'
import { AIMarker, Avatar, Button, cx, personShort, Pill } from './index'
import { clock, minutesLabel, shortDay } from '../time'
import { ME } from '../data/people'

export function NotesCard({ sessionId, compact }: { sessionId: string; compact?: boolean }) {
  const { state, navigate, acceptSuggested } = useStore()
  const [open, setOpen] = useState(!compact)
  const session = state.sessions.find(s => s.id === sessionId)
  if (!session) return null
  const notes = session.notes
  const toSession = (t?: number) => navigate({ name: 'session', sessionId, t })
  const onSessionPage = state.route.name === 'session' && state.route.sessionId === sessionId

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="flex items-start gap-3 border-b border-line px-4 py-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink"><Mic size={18} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">Notes · {session.title}</p>
            <AIMarker />
            {session.restricted && <Pill tone="warn" icon={<Lock size={10} />}>Restricted</Pill>}
          </div>
          <p className="flex flex-wrap gap-x-1.5 text-xs text-muted">
            <span>{shortDay(session.startedAt)}, {clock(session.startedAt)}</span>
            <span aria-hidden>·</span>
            <span>{minutesLabel(session.durationSec)}</span>
            <span aria-hidden>·</span>
            <span>{session.participants.length} people</span>
          </p>
        </div>
      </div>

      {!notes ? (
        <div className="px-4 py-3 text-sm text-muted">Short session: transcript saved, no notes.</div>
      ) : (
        <div className="space-y-3 px-4 py-3 text-sm">
          {notes.incomplete && <Pill tone="warn">Incomplete transcript — notes will update</Pill>}
          <p>{notes.summary}</p>

          {open && (
            <>
              {notes.decisions.length > 0 && (
                <div>
                  <p className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted"><Gavel size={12} /> Decisions</p>
                  <ul className="space-y-1">
                    {notes.decisions.map((d, i) => <li key={i} className="flex gap-2"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />{d}</li>)}
                  </ul>
                </div>
              )}
              {notes.actionItems.length > 0 && (
                <div>
                  <p className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted"><CheckCircle2 size={12} /> Action items</p>
                  <ul className="space-y-1.5">
                    {notes.actionItems.map(a => {
                      const sg = state.suggested.find(s => s.id === `st_${a.id}`)
                      return (
                        <li key={a.id} className={cx('flex items-start gap-2 rounded-xl px-2 py-1.5', a.ownerId === ME && 'bg-accent-soft')}>
                          <Avatar id={a.ownerId} size="xs" className="mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <p>{a.text}</p>
                            <p className="text-xs text-muted">
                              {a.ownerId === ME ? 'You' : personShort(a.ownerId)}{a.due ? ` · ${a.due}` : ''}
                              {a.passageIndex !== undefined && (
                                <> · <button className="underline-offset-2 hover:underline" onClick={() => toSession(session.transcript[a.passageIndex!]?.startSec)}>{'at '}{Math.floor((session.transcript[a.passageIndex]?.startSec ?? 0) / 60)}:{String((session.transcript[a.passageIndex]?.startSec ?? 0) % 60).padStart(2, '0')}</button></>
                              )}
                            </p>
                          </div>
                          {sg && <Button size="sm" variant="primary" onClick={() => acceptSuggested(sg.id)}>Add to my tasks</Button>}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
              {notes.openQuestions.length > 0 && (
                <div>
                  <p className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted"><CircleHelp size={12} /> Open questions</p>
                  <ul className="space-y-1">{notes.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
                </div>
              )}
              <p className="text-[11px] text-muted">Machine-generated from the transcript. Check it against the recording before relying on it.</p>
            </>
          )}
        </div>
      )}

      {(!onSessionPage || (compact && notes)) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
          {!onSessionPage && <Button size="sm" variant="ghost" icon={<PlayCircle size={16} />} onClick={() => toSession()}>{compact ? 'Transcript' : 'Transcript & recording'}</Button>}
          {compact && notes && (
            <Button size="sm" variant="ghost" icon={open ? <ChevronUp size={16} /> : <ChevronDown size={16} />} onClick={() => setOpen(o => !o)}>
              {open ? 'Less' : 'Decisions & actions'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
