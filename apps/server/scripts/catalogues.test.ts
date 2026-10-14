import { FLAGS } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import type { Coverage } from '#src/outbox/coverage.ts'
import {
  contentProblems,
  coverageProblems,
  eventProblems,
  flagProblems,
  matchProblems,
  roleProblems,
} from './catalogues.ts'

const writes: Record<string, Coverage> = {
  'hearth_app people:INSERT': { events: ['person.added'] },
  'hearth_app people.full_name:UPDATE': { events: ['person.updated'] },
  'hearth_app audit_events:INSERT': { exempt: 'the audit log is itself the record of the change' },
  'keep_history()': { exempt: 'a check', writes: [] },
}
const grants = [
  { role: 'hearth_app', table: 'people', op: 'INSERT' },
  { role: 'hearth_app', table: 'people', op: 'UPDATE', column: 'full_name' },
  { role: 'hearth_app', table: 'audit_events', op: 'INSERT' },
] as const
const functions = [{ key: 'keep_history()', definer: false, trigger: true }]

describe('C0.6 T16 item 7 check-catalogues: every way to write is covered', () => {
  it('passes when every grant and reachable function has its entry and no entry is stale', () => {
    expect(coverageProblems(writes, grants, functions)).toEqual([])
  })

  it('names a grant with no entry, with the key to add', () => {
    const problems = coverageProblems(
      writes,
      [...grants, { role: 'hearth_app', table: 'people', op: 'UPDATE', column: 'phone' }],
      functions,
    )
    expect(problems).toEqual([
      "hearth_app may UPDATE public.people.phone, but apps/server/src/outbox/coverage.ts doesn't say which event covers it or why it's exempt: add 'hearth_app people.phone:UPDATE'",
    ])
  })

  it('names a new definer or trigger function with no entry, and one whose entry lists no writes', () => {
    const problems = coverageProblems({ ...writes, 'set_x(text)': { events: ['flag.changed'] } }, grants, [
      ...functions,
      { key: 'set_x(text)', definer: true, trigger: false },
      { key: 'zz()', definer: false, trigger: true },
    ])
    expect(problems).toEqual([
      "apps/server/src/outbox/coverage.ts's 'set_x(text)' must list the writes it makes (writes: [] if none)",
      expect.stringContaining('the trigger function public.zz() can run in a runtime transaction'),
    ])
  })

  it('names a stale entry: a grant or function that no longer exists', () => {
    expect(coverageProblems(writes, grants.slice(1), functions)).toEqual([
      expect.stringContaining(
        "covers 'hearth_app people:INSERT', which no runtime role's grant or reachable function matches",
      ),
    ])
  })

  it('needs MATCH for every table an event covers, naming a real column', () => {
    const columns = new Set(['people.id'])
    expect(matchProblems(writes, { people: 'id' }, columns)).toEqual([])
    expect(matchProblems(writes, {}, columns)).toEqual([
      expect.stringContaining("'hearth_app people:INSERT' needs an event, but MATCH"),
      expect.stringContaining("'hearth_app people.full_name:UPDATE' needs an event, but MATCH"),
    ])
    expect(matchProblems(writes, { people: 'person_id' }, columns)).toEqual([
      "apps/server/src/outbox/coverage.ts's MATCH names public.people.person_id, which doesn't exist",
    ])
    // A function's writes count too.
    expect(
      matchProblems({ 'f()': { events: ['flag.changed'], writes: ['feature_flags.enabled:UPDATE'] } }, {}, columns),
    ).toEqual([expect.stringContaining('which column of feature_flags the event must name')])
  })

  it('refuses an exemption for a content table: one whose writes append events with a snapshot', () => {
    const content: Record<string, Coverage> = {
      'hearth_app messages:INSERT': { events: ['message.created'] },
      'hearth_app messages.body:UPDATE': { exempt: 'nobody reads it' },
    }
    expect(contentProblems(content, type => type === 'message.created')).toEqual([
      expect.stringContaining("'hearth_app messages.body:UPDATE' is exempt, but messages holds content"),
    ])
    expect(contentProblems(content, () => false)).toEqual([])
    expect(contentProblems(writes)).toEqual([])
  })
})

describe('C0.6 check-catalogues: the catalogues equal the database', () => {
  it('compares the event names both ways', () => {
    expect(eventProblems(['a.done', 'b.done'], ['b.done', 'a.done'])).toEqual([])
    expect(eventProblems(['a.done', 'b.done'], ['b.done', 'c.done'])).toEqual([
      'a.done is in packages/shared EVENTS but not in outbox_events_type: a migration adds it',
      'c.done is in outbox_events_type but not in packages/shared EVENTS: add it to the catalogue',
    ])
  })

  it('compares the flag registry with feature_flag_defaults() both ways, and keeps every AI flag off and locked', () => {
    const defaults = Object.entries(FLAGS).map(([key, spec]) => ({ key, enabled: spec.default, locked: spec.locked }))
    expect(flagProblems(FLAGS, defaults)).toEqual([])
    const changed = defaults.map(row => (row.key === 'core.system' ? { ...row, locked: false } : row))
    expect(flagProblems(FLAGS, changed)).toEqual([
      'core.system: FLAGS says default true, locked true; feature_flag_defaults() says true, false',
    ])
    expect(flagProblems(FLAGS, [...defaults, { key: 'ai.extra', enabled: true, locked: false }])).toEqual([
      'ai.extra is in feature_flag_defaults() but not in packages/shared FLAGS: register it',
      'ai.extra is an AI flag, so feature_flag_defaults() must keep it off and locked until A0',
    ])
    expect(
      flagProblems(
        FLAGS,
        defaults.filter(row => row.key !== 'ai.ask'),
      ),
    ).toEqual(['ai.ask is in packages/shared FLAGS but not in feature_flag_defaults(): a migration adds it'])
    const unlocked = { ...FLAGS, 'ai.ask': { ...FLAGS['ai.ask'], locked: false } }
    expect(flagProblems(unlocked, defaults)).toContain(
      'ai.ask is an AI flag, so FLAGS must keep it off and locked until A0',
    )
  })

  it('compares the job roles both ways', () => {
    expect(roleProblems(['hearth_queue'], ['hearth_queue'])).toEqual([])
    expect(roleProblems(['hearth_queue', 'hearth_job_x'], ['hearth_queue', 'hearth_job_y'])).toEqual([
      "hearth_job_x is in apps/server/src/db/roles.ts JOB_ROLES, but hearth_worker can't SET it in the database",
      "hearth_worker can SET hearth_job_y, which apps/server/src/db/roles.ts JOB_ROLES doesn't list",
    ])
  })
})
