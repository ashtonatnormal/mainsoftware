// The message composer: autosizing text box bound to the conversation's draft
// (drafts survive navigation), Enter to send, simulated voice recording
// (CHAT-07) and the assistant-draft banner (PA-08).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Mic, Paperclip, SendHorizontal, Sparkles, Trash } from 'lucide-react'
import type { Conversation } from '../../types'
import { useStore } from '../../store'
import { actionables as seedActionables, askAnswers } from '../../data/work'
import { ME } from '../../data/people'
import { AIMarker, Button, IconButton } from '../../ui'
import { duration } from '../../time'
import { defaultVoiceTranscript, myVoiceTranscripts } from './content'
import { convLabel } from './parts'

const MAX_VOICE_SEC = 600

export function Composer({ c }: { c: Conversation }) {
  const { state, setDraft, send, sendVoice, toast, dismissActionable } = useStore()
  const draft = state.drafts[c.id] ?? ''
  const ta = useRef<HTMLTextAreaElement>(null)
  const [recSec, setRecSec] = useState<number | null>(null)
  const usedDraftFrom = useRef<string | undefined>(undefined)
  const isAssistant = c.kind === 'assistant'
  const canVoice = c.kind !== 'assistant' && c.kind !== 'agent'
  const id = `composer-${c.id}`

  // PA-08: the assistant put this draft here; the user edits and sends it.
  const drafted = draft.trim()
    ? [...state.actionables, ...seedActionables].find(a => a.draft?.conversationId === c.id && a.draft.text === draft)
    : undefined
  if (drafted) usedDraftFrom.current = drafted.id

  // Suggested questions for the assistant, minus the ones you've already asked here.
  const asked = new Set(state.messages.filter(m => m.conversationId === c.id && m.authorId === ME).map(m => m.text))
  const suggestions = isAssistant ? askAnswers.filter(a => !asked.has(a.question)) : []

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [draft, recSec])

  // Desktop: put the cursor in the composer when a conversation opens.
  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches && ta.current) {
      const el = ta.current
      el.focus({ preventScroll: true })
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [])

  useEffect(() => {
    if (recSec === null) return
    const t = window.setInterval(() => setRecSec(s => (s === null ? s : Math.min(s + 1, MAX_VOICE_SEC))), 1000)
    return () => window.clearInterval(t)
  }, [recSec === null]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    send(c.id, text)
    const from = usedDraftFrom.current
    if (from && state.actionables.some(a => a.id === from)) dismissActionable(from)
    usedDraftFrom.current = undefined
  }

  const sendRecording = () => {
    const sec = Math.max(2, recSec ?? 0)
    setRecSec(null)
    sendVoice(c.id, sec, myVoiceTranscripts[c.id] ?? defaultVoiceTranscript)
  }

  if (recSec !== null) {
    return (
      <div className="border-t border-line bg-surface px-2 py-2 sm:px-4" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))' }}>
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
          <Button variant="ghost" size="sm" icon={<Trash size={15} />} onClick={() => setRecSec(null)}>
            Cancel
          </Button>
          <div className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-full bg-rec-soft px-4" role="status" aria-live="polite">
            <span className="size-2.5 shrink-0 rounded-full bg-rec anim-pulse" aria-hidden />
            <span className="shrink-0 font-semibold text-rec tabular" aria-label={`Recording, ${recSec} seconds`}>{duration(recSec)}</span>
            <span className="flex h-6 min-w-0 flex-1 items-center gap-[3px] overflow-hidden" aria-hidden>
              {Array.from({ length: 28 }, (_, i) => (
                <span key={i} className="h-full w-[3px] shrink-0 rounded-full bg-rec/60 anim-bar" style={{ animationDelay: `${(i % 7) * 0.12}s` }} />
              ))}
            </span>
            <span className="hidden shrink-0 text-xs text-rec sm:inline">Transcribed automatically</span>
          </div>
          <button
            onClick={sendRecording}
            aria-label="Send voice message"
            className="grid size-11 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition hover:brightness-105"
          >
            <SendHorizontal size={20} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="border-t border-line bg-surface px-2 pt-2 sm:px-4" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))' }}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {drafted && (
          <div className="anim-in flex items-center gap-2 rounded-xl bg-agent-soft px-3 py-2 text-[13px]">
            <AIMarker label="Draft" />
            <p className="min-w-0 flex-1 text-fg">Your assistant drafted this. Edit it, then send.</p>
            <button className="shrink-0 font-semibold text-agent hover:underline" onClick={() => setDraft(c.id, '')}>
              Clear
            </button>
          </div>
        )}

        {isAssistant && !draft && suggestions.length > 0 && (
          <div className="-mx-2 flex gap-1.5 overflow-x-auto px-2 [scrollbar-width:none] sm:-mx-0 sm:px-0" role="group" aria-label="Suggested questions">
            {suggestions.map(a => (
              <button
                key={a.id}
                onClick={() => send(c.id, a.question)}
                title={a.question}
                className="inline-flex h-8 max-w-64 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[13px] text-fg transition hover:border-agent hover:text-agent"
              >
                <Sparkles size={13} className="shrink-0 text-agent" aria-hidden />
                <span className="truncate">{a.question}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-end gap-1.5">
          <IconButton label="Attach a file" className="mb-0.5 text-muted" onClick={() => toast('Attachments come later in the demo.')}>
            <Paperclip size={20} />
          </IconButton>
          <label htmlFor={id} className="sr-only">
            {isAssistant ? 'Ask your assistant' : `Message ${convLabel(c)}`}
          </label>
          <textarea
            ref={ta}
            id={id}
            rows={1}
            value={draft}
            onChange={e => setDraft(c.id, e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={isAssistant ? 'Ask your assistant…' : `Message ${convLabel(c)}`}
            // The global :focus-visible outline squares the corners; the ring shows focus instead.
            style={{ outline: 'none', borderRadius: 22 }}
            className="max-h-42 min-h-11 min-w-0 flex-1 resize-none bg-surface-2 px-4 py-2.5 text-[15px] leading-6 text-fg placeholder:text-muted focus:ring-2 focus:ring-accent/40"
          />
          {draft.trim() || !canVoice ? (
            <button
              onClick={submit}
              disabled={!draft.trim()}
              aria-label="Send"
              className="mb-0.5 grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition hover:brightness-105 disabled:opacity-40"
            >
              <SendHorizontal size={19} />
            </button>
          ) : (
            <button
              onClick={() => setRecSec(0)}
              aria-label="Record a voice message"
              className="mb-0.5 grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-ink transition hover:brightness-95"
            >
              <Mic size={20} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
