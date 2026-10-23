// The DPO's register writes through the api, for SE-05 (C0.9 PD-55, B-13): before the timed part
// of the forced re-acknowledgement, every active purpose the seed leaves without a legal basis or a
// retention gets one, so the Notice tab's draft has nothing holding it back and the DPO can publish
// it from the page. The same calls the processing register's page makes, from the app's own
// origin, with the DPO's saved session (a new one, so it counts as re-authenticated for its first
// 5 minutes, §9.4); the answers are read with packages/shared's strict schemas, so a drift in the
// api's shape fails here first. What it records is made up and harmless: the e2e database is the
// seed's, rebuilt every run.
import {
  type PurposeKey,
  purposeProblems,
  RegistersResponse,
  RegisterWriteResponseForClient,
  type SetPurposeJSON,
} from '@hearth/shared'
import { request as playwrightRequest } from '@playwright/test'
import { E2E_ORIGIN } from './env.ts'

type Recorded = Pick<SetPurposeJSON, 'basis' | 'basisReference' | 'retention'>

// What each purpose a new org starts active with is recorded as (C0.9 PD-06): the pinned two, and
// security_audit and backups (which DPP-E2 may have recorded already, the same way).
const ENTRIES: Partial<Record<PurposeKey, Recorded>> = {
  accounts: { basis: 'employment', basisReference: null, retention: 'While you work here, then 30 days' },
  service_operation: {
    basis: 'legitimate_interests',
    basisReference: 'Assessment 1, in the DPO’s file',
    retention: '90 days',
  },
  security_audit: {
    basis: 'legitimate_interests',
    basisReference: 'Assessment 3, in the DPO’s file',
    retention: '13 months',
  },
  backups: { basis: 'legitimate_interests', basisReference: 'Assessment 2, in the DPO’s file', retention: '35 days' },
}
const OTHERWISE: Recorded = { basis: 'employment', basisReference: null, retention: '30 days' }

// Records a basis and a retention for every active purpose missing either, as the DPO whose
// storage state is at statePath; answers the purposes it recorded, in the register's order.
export async function recordMissingEntries(statePath: string): Promise<PurposeKey[]> {
  const context = await playwrightRequest.newContext({
    baseURL: E2E_ORIGIN,
    ignoreHTTPSErrors: true,
    storageState: statePath,
    // The server refuses a state change whose Origin isn't the app's (CLAUDE.md, Security).
    extraHTTPHeaders: { origin: E2E_ORIGIN },
  })
  try {
    const read = await context.get('/api/admin/registers')
    if (read.status() !== 200) throw new Error(`GET /api/admin/registers: ${read.status()}`)
    const registers = RegistersResponse.parse(await read.json())
    const recorded: PurposeKey[] = []
    for (const row of registers.purposes) {
      if (row.status !== 'active' || (row.basis !== null && row.retention !== null)) continue
      const entry = ENTRIES[row.purpose] ?? OTHERWISE
      const body: SetPurposeJSON = {
        purpose: row.purpose,
        seen: row.version,
        status: row.status,
        ...entry,
        optOutDays: null,
        providers: [...row.providers],
      }
      // What the page would refuse to send, the helper refuses too.
      const problems = purposeProblems(row.purpose, body)
      if (problems.length > 0) throw new Error(`${row.purpose}: ${problems.join(', ')}`)
      const written = await context.post('/api/admin/registers/purposes/set', { data: body })
      if (written.status() !== 200) throw new Error(`recording ${row.purpose}: ${written.status()}`)
      if (!RegisterWriteResponseForClient.parse(await written.json()).changed) {
        throw new Error(`recording ${row.purpose} changed nothing`)
      }
      recorded.push(row.purpose)
    }
    return recorded
  } finally {
    await context.dispose()
  }
}
