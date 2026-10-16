import { keysOf, orgToken, personToken, teamToken } from './keys.ts'
import type { Subject, Token } from './model.ts'
import type { Topic, TopicKind, TopicRequest } from './requests.ts'
import type { World } from './world.ts'

// Live topics on the realtime gateway (BUILD-PLAN C0.7, TECH-SPEC T19 item 7). A topic stands for
// one access token, so holding the topic is holding the token: it is allowed exactly while the token
// is among the subscriber's keys, and lost with it (Rule 6). No role decides one (PRD-108), and no new
// fact is needed: keys are already the access model (T13). packages/shared's GATEWAY_TOPIC_KINDS must
// equal these kinds (the server's realtime/policy.test.ts).
export const TOPIC_KINDS: readonly TopicKind[] = ['person', 'org', 'team']

// The token a topic stands for: a person's own (p:), their org's (o:), or a team's (t:, an archived
// team's included while they are in it, T13 item 14).
export function topicToken(topic: Topic): Token {
  switch (topic.kind) {
    case 'person':
      return personToken(topic.id)
    case 'org':
      return orgToken(topic.id)
    case 'team':
      return teamToken(topic.id)
  }
}

// Whether the subject may hold the topic now. Only people may: an assistant, agent or system
// principal is refused, as with every self-service request (R9-03). An unknown team or another
// org's id gives false, exactly as a forbidden one does (PRD-108), and so does a kind this package
// doesn't know.
export function topicCan(world: World, subject: Subject, request: TopicRequest): boolean {
  if (subject.kind !== 'human' || !TOPIC_KINDS.includes(request.topic.kind)) return false
  return keysOf(world, subject).includes(topicToken(request.topic))
}

// The same for many topics of one subject, computing its keys once (the gateway's re-checks).
export function canTopics(world: World, subject: Subject, topics: readonly Topic[]): boolean[] {
  if (subject.kind !== 'human') return topics.map(() => false)
  const keys = new Set(keysOf(world, subject))
  return topics.map(topic => TOPIC_KINDS.includes(topic.kind) && keys.has(topicToken(topic)))
}
