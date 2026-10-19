// FlagSlot and the AI slots, rendered with react-dom/server under a seeded QueryClient (T21, D-03).
// Rendering on the server runs no effect, so nothing is fetched: what a slot shows depends only on
// the flags answer the cache holds, or the absence of one.
import { FLAGS, type FlagKey, isAiFlag, readFlagsAnswer } from '@hearth/shared'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createQueryClient } from '@/session/query-client.ts'
import { AI_SLOTS, AiSlot, type AiSlotName } from './ai-slots.tsx'
import { FlagSlot } from './FlagSlot.tsx'

// Renders under a QueryClient whose flags answer is `answer`, as the server's body would be read;
// undefined leaves the cache empty, as before the first answer (or after one that failed).
function render(element: ReactNode, answer?: unknown): string {
  const client = createQueryClient(() => {})
  if (answer !== undefined) client.setQueryData(['flags'], readFlagsAnswer(answer))
  return renderToStaticMarkup(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
}

const SLOT_NAMES = Object.keys(AI_SLOTS) as AiSlotName[]
const AI_KEYS = (Object.keys(FLAGS) as FlagKey[]).filter(isAiFlag)

describe('T21 OD-23: flag slots (flags/)', () => {
  it('FS-01 R-35 OD-23 R-53: FlagSlot renders children only for a true value; missing, false, unreadable or loading renders nothing', () => {
    const slot = (
      <FlagSlot flag="ai.ask">
        <span>shown</span>
      </FlagSlot>
    )
    expect(render(slot, { flags: { 'ai.ask': true } })).toBe('<span>shown</span>')
    expect(render(slot, { flags: { 'ai.ask': false } })).toBe('')
    expect(render(slot, { flags: { 'ai.ask': 'true' } })).toBe('')
    expect(render(slot, { flags: { 'ai.notes': true } })).toBe('')
    expect(render(slot, { flags: {} })).toBe('')
    expect(render(slot, 'not an answer')).toBe('')
    expect(render(slot)).toBe('')
  })

  it('FS-02 R-35 D41 decision 8: every AiSlot renders nothing, even with every ai.* flag on', () => {
    const allOn = { flags: Object.fromEntries(AI_KEYS.map(key => [key, true])) }
    expect(SLOT_NAMES.length).toBeGreaterThan(0)
    for (const name of SLOT_NAMES) {
      expect(render(<AiSlot name={name} />), name).toBe('')
      expect(render(<AiSlot name={name} />, allOn), name).toBe('')
    }
  })

  it('FS-03 R-35 T17: every AI_SLOTS flag is an ai.* key that FLAGS marks client: false, locked off, with a stage', () => {
    for (const name of SLOT_NAMES) {
      const { flag, stage } = AI_SLOTS[name]
      expect(isAiFlag(flag), name).toBe(true)
      expect(FLAGS[flag].client, name).toBe(false)
      expect(FLAGS[flag].default, name).toBe(false)
      expect(FLAGS[flag].locked, name).toBe(true)
      expect(stage, name).toMatch(/^A\d$/)
    }
  })
})
