// The seams where AI features will appear (T21 item 14, decision 8, D41). Each slot names the
// ai.* flag that will gate it and the stage that builds it, so an A-stage fills a slot and turns its
// flag on instead of changing the screens. Until then every slot renders nothing, twice over:
// - no slot has content (AI_SLOT_CONTENT is empty; C0–C6 make no model calls and show no AI);
// - every ai.* flag is client: false and locked off (packages/shared/src/flags.ts), so
//   GET /api/flags never sends one and its FlagSlot reads off.
// There is no placeholder, no "coming soon" and no AI copy (decision 8). Today's and Chats' screens
// mount theirs (screens/TabScreen.tsx), and the Search bar holds its own while it waits, unmounted,
// for C1.7 (OD-04).
import type { FlagKey } from '@hearth/shared'
import type { ComponentType, ReactNode } from 'react'
import { FlagSlot } from './FlagSlot.tsx'

export const AI_SLOTS = {
  'search.ask': { flag: 'ai.ask', stage: 'A3' },
  'today.catch_up': { flag: 'ai.catch_up', stage: 'A3' },
  'chats.agents_filter': { flag: 'ai.agents', stage: 'A5' },
} as const satisfies Record<string, { flag: FlagKey; stage: string }>

export type AiSlotName = keyof typeof AI_SLOTS

// Each slot's content, added by its A-stage behind its flag (A0 lifts the flags' lock). Empty
// until then (D41).
const AI_SLOT_CONTENT: Partial<Record<AiSlotName, ComponentType>> = {}

export function AiSlot({ name }: { name: AiSlotName }): ReactNode {
  const Content = AI_SLOT_CONTENT[name]
  return <FlagSlot flag={AI_SLOTS[name].flag}>{Content === undefined ? null : <Content />}</FlagSlot>
}
