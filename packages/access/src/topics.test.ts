// Live topics (BUILD-PLAN C0.7, TECH-SPEC T19 item 7): canTopics, the gateway's batch form, gives
// exactly can()'s answers, and each kind stands for its token. The Rule 6, 8 and 9 cases are in
// testing/rules/, and the keys-not-roles cases in roles.test.ts.
import { describe, expect, it } from 'vitest'
import { can } from './can.ts'
import { keysOf, orgToken, personToken, teamToken } from './keys.ts'
import type { Subject } from './model.ts'
import type { Topic, TopicKind } from './requests.ts'
import {
  AG,
  AS,
  agent,
  assistant,
  C,
  fixtureWorld,
  human,
  ORG,
  ORG_2,
  P,
  SEED_PEOPLE,
  system,
  T,
} from './testing/index.ts'
import { canTopics, TOPIC_KINDS, topicToken } from './topics.ts'

const world = fixtureWorld()
const UNKNOWN_TEAM = 'd0000000-0000-4000-8000-0000000000ff'
const everyone = [...SEED_PEOPLE, P.cfo, P.formerDpo, P.formerAdmin]
// Every topic the fixture can name: everyone's person topic, both orgs', every team's (the archived
// Night shift included) and a team that doesn't exist.
const TOPICS: readonly Topic[] = [
  ...everyone.map(id => ({ kind: 'person' as const, id })),
  { kind: 'org', id: ORG },
  { kind: 'org', id: ORG_2 },
  ...Object.values(T).map(id => ({ kind: 'team' as const, id })),
  { kind: 'team', id: UNKNOWN_TEAM },
]
const subscribe = (topic: Topic) => ({ action: 'topic.subscribe' as const, topic })

describe('T19 item 7: live topics', () => {
  it('T19 item 7: topicToken gives each kind’s token', () => {
    expect(TOPIC_KINDS).toEqual(['person', 'org', 'team'])
    expect(topicToken({ kind: 'person', id: P.marcus })).toBe(personToken(P.marcus))
    expect(topicToken({ kind: 'person', id: P.marcus })).toBe(`p:${P.marcus}`)
    expect(topicToken({ kind: 'org', id: ORG })).toBe(orgToken(ORG))
    expect(topicToken({ kind: 'org', id: ORG })).toBe(`o:${ORG}`)
    expect(topicToken({ kind: 'team', id: T.operations })).toBe(teamToken(T.operations))
    expect(topicToken({ kind: 'team', id: T.operations })).toBe(`t:${T.operations}`)
  })

  it('T19 item 8: canTopics equals can() element-wise for every person and topic in the fixture', () => {
    let allowed = 0
    for (const p of everyone) {
      const subject = human(p)
      const one = TOPICS.map(topic => can(world, subject, subscribe(topic)))
      expect(canTopics(world, subject, TOPICS), p).toEqual(one)
      // Each answer is the token's presence among the person's keys.
      const keys = keysOf(world, subject)
      expect(one, p).toEqual(TOPICS.map(topic => keys.includes(topicToken(topic))))
      allowed += one.filter(Boolean).length
    }
    // Both answers occur, so the comparison isn't of nothing with nothing.
    expect(allowed).toBeGreaterThan(everyone.length)
    expect(allowed).toBeLessThan(everyone.length * TOPICS.length)
    expect(canTopics(world, human(P.marcus), [])).toEqual([])
  })

  it('R9-03 T19 item 7: an assistant, an agent or the system principal holds no topic, whatever id it carries', () => {
    const nonHumans: Subject[] = [
      assistant(AS.ashton),
      agent(AG.it),
      system,
      { kind: 'assistant', id: P.marcus },
      { kind: 'agent', id: P.marcus },
      { kind: 'system', id: P.marcus },
    ]
    expect(canTopics(world, human(P.marcus), TOPICS)).toContain(true)
    for (const subject of nonHumans) {
      expect(canTopics(world, subject, TOPICS), `${subject.kind} ${subject.id}`).toEqual(TOPICS.map(() => false))
      for (const topic of TOPICS) expect(can(world, subject, subscribe(topic))).toBe(false)
    }
  })

  it('PRD-108: a kind this package doesn’t know is refused by both, like a forbidden topic', () => {
    // A channel topic is C1.1's; until then a request for one, even from a member, is refused.
    const channel = { kind: 'channel' as TopicKind, id: C.ops }
    expect(world.isCurrentMember(P.marcus, C.ops)).toBe(true)
    expect(can(world, human(P.marcus), subscribe(channel))).toBe(false)
    expect(canTopics(world, human(P.marcus), [channel])).toEqual([false])
  })
})
