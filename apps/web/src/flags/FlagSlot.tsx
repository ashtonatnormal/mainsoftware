// A place in a screen that shows its children only while a client flag reads on for the person
// (T17 item 11, T21 item 14, decision 8). The flag comes from GET /api/flags (api/queries.ts): a
// key the answer doesn't hold as true, an answer not yet loaded, or one that failed with nothing
// before it, all read off, so a slot fails closed. A flag only shows or hides a feature: the server
// checks every action again with can(), and no flag gates an access check or a privacy or safety
// control (CLAUDE.md, Database), which is why sign-in and session code never read one (WS-11).
import type { FlagKey } from '@hearth/shared'
import type { ReactNode } from 'react'
import { useFlag } from '@/api/queries.ts'

export interface FlagSlotProps {
  flag: FlagKey
  children: ReactNode
}

export function FlagSlot({ flag, children }: FlagSlotProps): ReactNode {
  return useFlag(flag) ? children : null
}
