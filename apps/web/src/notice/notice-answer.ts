// The lenient reading of GET /api/notice (C0.9 PD-46), on its own so api/queries.ts's noticeQuery
// loads it only when it first fetches. The boot's bundle then carries none of the notice's schemas
// (packages/shared notice.ts) or the registers' they build on, which only /notice, Settings and
// the DPO's pages read.
export { NoticeResponseForClient } from '@hearth/shared'
