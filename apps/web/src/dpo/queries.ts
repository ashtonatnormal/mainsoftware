// The DPO pages' calls (C0.9 PD-20, PD-21, PD-26; TECH-SPEC T22 items 13 to 15), all through
// api/http.ts (WS-03) and read with packages/shared's schemas:
// - GET /api/admin/registers, under one Query key both pages share. It is read when a page opens and
//   again after each write; never on focus or reconnect, so a stale stamp doesn't turn a page the DPO
//   is reading into a PIN step, and an edit in progress keeps the version it started from (a stale
//   edit is refused with register_changed, PD-25).
// - the four writes, each answering only whether anything changed; the page reads the registers
//   again rather than trusting its own copy.
// - POST /api/auth/reauth/pin, the inline PIN step's (C0.16's sheet replaces it). The PIN is never
//   the mutation's variables, which the document's MutationCache keeps after the step settles
//   (pinStepOptions).
// Nothing is kept outside Query's cache, which lives as long as the document and the person (D-01);
// an unsaved form is component state, never storage (WS-01).
import {
  type ClearTransferJSON,
  ReauthenticatedSchema,
  type RecordTransferJSON,
  RegistersResponseForClient,
  RegisterWriteResponseForClient,
  type SetPurposeJSON,
  type WithdrawTransferJSON,
} from '@hearth/shared'
import { queryOptions } from '@tanstack/react-query'
import { type ApiPath, apiGet, apiPost } from '@/api/http.ts'

export const registersQuery = queryOptions({
  queryKey: ['registers'] as const,
  queryFn: ({ signal }) => apiGet('/api/admin/registers', RegistersResponseForClient, { signal }),
  staleTime: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
})

export type RegisterWrite =
  | { readonly kind: 'purpose'; readonly body: SetPurposeJSON }
  | { readonly kind: 'record'; readonly body: RecordTransferJSON }
  | { readonly kind: 'clear'; readonly body: ClearTransferJSON }
  | { readonly kind: 'withdraw'; readonly body: WithdrawTransferJSON }

export const WRITE_PATHS = {
  purpose: '/api/admin/registers/purposes/set',
  record: '/api/admin/registers/transfers/record',
  clear: '/api/admin/registers/transfers/clear',
  withdraw: '/api/admin/registers/transfers/withdraw',
} as const satisfies Record<RegisterWrite['kind'], ApiPath>

export async function sendWrite(write: RegisterWrite): Promise<{ changed: boolean }> {
  const answer = await apiPost(WRITE_PATHS[write.kind], write.body, RegisterWriteResponseForClient)
  return { changed: answer?.changed === true }
}

export async function reauthWithPin(pin: string): Promise<void> {
  await apiPost('/api/auth/reauth/pin', { pin }, ReauthenticatedSchema)
}

// The PIN step's mutation (ReauthPin). The PIN is read from the step's own holder on each try, so a
// retry after 409 try_again sends it again, and the holder is emptied once the step settles, even
// if the step has gone by then. The mutation takes no variables, so the cache's state never holds
// the PIN, and gcTime 0 drops the mutation as soon as no step observes it.
export function pinStepOptions(entered: { current: string }, send: (pin: string) => Promise<void> = reauthWithPin) {
  return {
    mutationFn: () => send(entered.current),
    onSettled: () => {
      entered.current = ''
    },
    gcTime: 0,
  }
}
