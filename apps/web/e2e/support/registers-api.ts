// The DPO's register writes through the api, for SE-05 (C0.9 PD-55, B-13): before the timed part
// of the forced re-acknowledgement, the DPO's business contact is recorded when there is none (C0.9
// OD-10, PD-68: publishing needs it), and every active purpose the seed leaves without a legal basis
// or a retention gets one, so the Notice tab's draft has nothing holding it back and the DPO can
// publish it from the page. The same calls the contact page and the processing register's page
// make, from the app's own origin, with the DPO's saved session (a new one, so it counts as
// re-authenticated for its first 5 minutes, §9.4); the answers are read with packages/shared's
// strict schemas, so a drift in the api's shape fails here first. What it records is made up and
// harmless, on a reserved domain: the e2e database is the seed's, rebuilt every run.
import {
  ContactAdminResponse,
  ContactWriteResponse,
  contactProblems,
  type PurposeKey,
  purposeProblems,
  RegistersResponse,
  RegisterWriteResponseForClient,
  type SetContactJSON,
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

// The DPO's api session, from the storage state at statePath.
const dpoContext = (statePath: string) =>
  playwrightRequest.newContext({
    baseURL: E2E_ORIGIN,
    ignoreHTTPSErrors: true,
    storageState: statePath,
    // The server refuses a state change whose Origin isn't the app's (CLAUDE.md, Security).
    extraHTTPHeaders: { origin: E2E_ORIGIN },
  })

// The contact SE-05 records, and the notice it publishes then prints under "Your rights" (C0.9
// PD-74): a role and a shared mailbox, as the contact page advises (OD-10).
export const E2E_CONTACT = {
  title: 'Data Protection Officer',
  email: 'dpo@tembusu.example',
  phone: null,
  postal: null,
} as const

// Records E2E_CONTACT as the DPO whose storage state is at statePath, while no contact is recorded;
// answers whether it recorded it.
export async function recordContactIfNone(statePath: string): Promise<boolean> {
  const context = await dpoContext(statePath)
  try {
    const read = await context.get('/api/admin/notice/contact')
    if (read.status() !== 200) throw new Error(`GET /api/admin/notice/contact: ${read.status()}`)
    if (ContactAdminResponse.parse(await read.json()).contact !== null) return false
    const body: SetContactJSON = { seen: null, ...E2E_CONTACT }
    // What the page would refuse to send, the helper refuses too.
    const problems = contactProblems(E2E_CONTACT)
    if (problems.length > 0) throw new Error(`the contact: ${problems.map(problem => problem.code).join(', ')}`)
    const written = await context.post('/api/admin/notice/contact/set', { data: body })
    if (written.status() !== 200) throw new Error(`recording the contact: ${written.status()}`)
    if (!ContactWriteResponse.parse(await written.json()).changed)
      throw new Error('recording the contact changed nothing')
    return true
  } finally {
    await context.dispose()
  }
}

// Records a basis and a retention for every active purpose missing either, as the DPO whose
// storage state is at statePath; answers the purposes it recorded, in the register's order.
export async function recordMissingEntries(statePath: string): Promise<PurposeKey[]> {
  const context = await dpoContext(statePath)
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
