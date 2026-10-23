// The DPO pages' calls (C0.9 PD-20, PD-21, PD-26; TECH-SPEC T22 items 13 to 15), all through
// api/http.ts (WS-03) and read with packages/shared's schemas:
// - GET /api/admin/registers, under one Query key both pages share. It is read when a page opens and
//   again after each write; never on focus or reconnect, so a stale stamp doesn't turn a page the DPO
//   is reading into a PIN step, and an edit in progress keeps the version it started from (a stale
//   edit is refused with register_changed, PD-25).
// - the four writes, each answering only whether anything changed; the page reads the registers
//   again rather than trusting its own copy.
// - GET /api/admin/notice, the Notice tab's (C0.9 PD-48), under its own key with the same policy,
//   so a draft the DPO is reading is never swapped under them; and POST /api/admin/notice/publish,
//   which sends the latest version and the digest the tab previewed (PD-36), and answers the new
//   version's number.
// - GET /api/admin/notice/contact, the contact page's (C0.9 PD-70), under its own key with the
//   same policy; and POST /api/admin/notice/contact/set, which sends the settings version the page
//   read (PD-25's pattern) and answers whether it recorded anything. A save reads the contact, the
//   registers and the Notice tab again, since the registers' notice marker and the draft both move.
// - GET /api/admin/notice/people, the record dialog's list (C0.9 OD-19, PD-76), read only while the
//   dialog is open; and POST /api/admin/notice/acknowledgements/record, which answers as the
//   person's own acknowledgement does (whether it recorded anything).
// - POST /api/auth/reauth/pin, the inline PIN step's (C0.16's sheet replaces it). The PIN is never
//   the mutation's variables, which the document's MutationCache keeps after the step settles
//   (pinStepOptions).
// Nothing is kept outside Query's cache, which lives as long as the document and the person (D-01);
// an unsaved form is component state, never storage (WS-01).
import {
  AcknowledgeResponseForClient,
  type ClearTransferJSON,
  ContactAdminResponseForClient,
  ContactWriteResponseForClient,
  NoticeAdminResponseForClient,
  NoticePeopleResponseForClient,
  type PublishJSON,
  PublishResponseForClient,
  ReauthenticatedSchema,
  type RecordAcknowledgementJSON,
  type RecordTransferJSON,
  RegistersResponseForClient,
  RegisterWriteResponseForClient,
  type SetContactJSON,
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

export const noticeAdminQuery = queryOptions({
  queryKey: ['notice-admin'] as const,
  queryFn: ({ signal }) => apiGet('/api/admin/notice', NoticeAdminResponseForClient, { signal }),
  staleTime: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
})

export async function publishNotice(body: PublishJSON): Promise<{ version: number }> {
  const answer = await apiPost('/api/admin/notice/publish', body, PublishResponseForClient)
  // A 2xx is always read with the schema, so an answer is there.
  if (answer === undefined) throw new Error('publish answered nothing')
  return { version: answer.version }
}

// The DPO's business contact (C0.9 OD-10, PD-70).
export const contactQuery = queryOptions({
  queryKey: ['notice-contact'] as const,
  queryFn: ({ signal }) => apiGet('/api/admin/notice/contact', ContactAdminResponseForClient, { signal }),
  staleTime: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
})

export async function saveContact(body: SetContactJSON): Promise<{ version: number; changed: boolean }> {
  const answer = await apiPost('/api/admin/notice/contact/set', body, ContactWriteResponseForClient)
  // A 2xx is always read with the schema, so an answer is there.
  if (answer === undefined) throw new Error('the contact save answered nothing')
  return { version: answer.version, changed: answer.changed }
}

// What a contact save moves: the contact itself, the registers' notice marker and the Notice tab's
// draft (its problems, its changes and its words).
export const CONTACT_SAVE_MOVES = [contactQuery.queryKey, registersQuery.queryKey, noticeAdminQuery.queryKey] as const

// The people the DPO may record an acknowledgement for (C0.9 OD-19, PD-76), for the dialog alone.
export const noticePeopleQuery = queryOptions({
  queryKey: ['notice-people'] as const,
  queryFn: ({ signal }) => apiGet('/api/admin/notice/people', NoticePeopleResponseForClient, { signal }),
  staleTime: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
})

export async function recordAcknowledgement(
  body: RecordAcknowledgementJSON,
): Promise<{ version: number; changed: boolean }> {
  const answer = await apiPost('/api/admin/notice/acknowledgements/record', body, AcknowledgeResponseForClient)
  if (answer === undefined) throw new Error('the record answered nothing')
  return { version: answer.version, changed: answer.changed }
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
