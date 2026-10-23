// The gateway's admission (C0.9 PD-45; TECH-SPEC T19 item 10, T22 item 30): of the people with a
// live session, those who may hold a socket now. One rule, packages/access admitsSocket(): only
// someone who has acknowledged the org's latest notice, so while no version is published the
// gateway admits nobody, the DPO included (OD-01). The standing is the REST gate's own plain read
// (compliance/notice-standing.ts), asked inside the gateway's read-only transaction as the org's
// system principal (realtime/checks.ts): at accept, in each subscribe batch and in each periodic
// check, so a new version closes an unacknowledged person's sockets with 4403 within one check, and
// nothing is pushed. A read that fails fails the check, which grants nothing and closes nothing
// (T19's lapse bound). registerRealtime always wires it; only a test replaces it (index.ts).
import { admitsSocket } from '@hearth/access'
import { noticeStandings } from '#src/compliance/notice-standing.ts'
import type { Admission } from '#src/realtime/checks.ts'

export const NOTICE_ADMISSION: Admission = {
  async admits(trx, orgId, people) {
    const standings = await noticeStandings(trx, orgId, people)
    return new Set(people.filter(person => admitsSocket(standings.get(person) ?? 'required')))
  },
}
