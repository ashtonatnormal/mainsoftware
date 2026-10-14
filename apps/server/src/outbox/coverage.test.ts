import { EVENT_TYPES, EVENTS, isEmitted } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import { coverageOf, EMITTED_BY, grantKey, MATCH, WRITES, writeKey } from '#src/outbox/coverage.ts'

const GRANT = /^(hearth_[a-z_]+) ([a-z_]+)(?::(INSERT|DELETE)|\.([a-z_]+):UPDATE)$/
const FUNCTION = /^([a-z_]+)\(([a-z0-9_ [\],]*)\)$/
const WRITE = /^([a-z_]+)(?::(INSERT|DELETE)|\.([a-z_]+):UPDATE)$/

describe('C0.6 T16 item 7 every write is covered: the coverage table itself', () => {
  it('keys every entry as a grant or a function, and gives every function the writes it makes', () => {
    for (const [key, coverage] of Object.entries(WRITES)) {
      const grant = GRANT.test(key)
      expect(grant || FUNCTION.test(key), key).toBe(true)
      if (grant) expect(coverage.writes, key).toBeUndefined()
      else expect(Array.isArray(coverage.writes), key).toBe(true)
      for (const write of coverage.writes ?? []) expect(write, key).toMatch(WRITE)
      if ('exempt' in coverage) expect(coverage.exempt.length, key).toBeGreaterThan(10)
    }
  })

  it('names only catalogue event types, and only on writes whose table says which column an event must name', () => {
    for (const [key, coverage] of Object.entries(WRITES)) {
      if (!('events' in coverage)) continue
      expect(coverage.events.length, key).toBeGreaterThan(0)
      for (const type of coverage.events) expect(EVENT_TYPES, key).toContain(type)
      const tables = GRANT.test(key)
        ? [GRANT.exec(key)?.[2]]
        : (coverage.writes ?? []).map(write => WRITE.exec(write)?.[1])
      for (const table of tables) expect(MATCH[table ?? ''], `${key}: MATCH has no column for ${table}`).toBeDefined()
    }
  })

  it('gives no content table an exemption: a table one of whose writes appends a snapshot event is never exempt', () => {
    const contentTables = new Set<string>()
    const exemptTables = new Set<string>()
    for (const [key, coverage] of Object.entries(WRITES)) {
      const table = GRANT.exec(key)?.[2]
      if (table === undefined) continue
      if ('exempt' in coverage) exemptTables.add(table)
      else if (coverage.events.some(type => (EVENTS[type].acl as string) === 'snapshot')) contentTables.add(table)
    }
    expect([...contentTables].filter(table => exemptTables.has(table))).toEqual([])
  })

  it('assigns every emitted type to the suite that must append it, and nothing else', () => {
    expect(Object.keys(EMITTED_BY).sort()).toEqual(EVENT_TYPES.filter(type => isEmitted(type)).sort())
  })

  it('finds a write’s grant entry first, and otherwise every function that says it makes the write', () => {
    expect(coverageOf('hearth_app', 'people', 'UPDATE', 'deactivated_at')).toEqual([
      { key: 'hearth_app people.deactivated_at:UPDATE', coverage: { events: ['person.deactivated'] } },
    ])
    expect(coverageOf('hearth_app', 'feature_flags', 'UPDATE', 'revision').map(entry => entry.key)).toEqual([
      'set_feature_flag(text, boolean, text, uuid[], text[], text, uuid, inet)',
    ])
    // The clean-up's audit rows, written as hearth_job_purge, which has no grant on the audit log.
    expect(coverageOf('hearth_job_purge', 'audit_events', 'INSERT').map(entry => entry.key)).toEqual(
      expect.arrayContaining(['purge_outbox(integer)', 'purge_jobs(integer)', 'purge_schedule_runs(integer)']),
    )
    expect(coverageOf('hearth_app', 'people', 'UPDATE', 'phone')).toEqual([])
    expect(grantKey('hearth_app', 'users', 'INSERT')).toBe('hearth_app users:INSERT')
    expect(grantKey('hearth_app', 'users', 'UPDATE', 'pin_hash')).toBe('hearth_app users.pin_hash:UPDATE')
    expect(writeKey('jobs', 'DELETE')).toBe('jobs:DELETE')
  })
})
