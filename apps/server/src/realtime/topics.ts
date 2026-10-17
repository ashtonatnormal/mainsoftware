// The gateway's topic kinds (BUILD-PLAN C0.7, TECH-SPEC T19 item 7) and how the gateway decides
// them. A topic is <kind>:<uuid> (packages/shared parseTopic), and packages/access decides it as
// { action: 'topic.subscribe', topic } through canTopics, which is can() for a list: a topic is
// allowed exactly while its token is among the subscriber's keys. Only people subscribe, and their
// id comes from the socket's server-side session, never from a frame (GW-13).
import { canTopics, type Topic, type World } from '@hearth/access'
import { type GatewayTopicKind, parseTopic } from '@hearth/shared'

export interface TopicKindSpec {
  // Whether each event on a topic of this kind must also pass a per-item check (canRead) before it
  // is sent (the gateway replays nothing, T19 item 9). C0.7's kinds need none: a person, org or team
  // topic is held at reader-set granularity, so everyone who holds its token may see every event on
  // it. C1.1's group-DM and space kinds will (membership eras), and the gateway runs that check
  // before such a kind is listed here.
  perItem: boolean
}

// One entry per kind the protocol names (GATEWAY_TOPIC_KINDS, which policy.test.ts pins to these
// keys and to packages/access's TOPIC_KINDS). C1.1 adds spaces, C2.3 rooms, C5.6 presentations.
export const TOPIC_KIND_SPECS: Readonly<Record<GatewayTopicKind, TopicKindSpec>> = {
  person: { perItem: false },
  org: { perItem: false },
  team: { perItem: false },
}

// Whether the person may hold each topic now: true or false for every topic given. A topic that
// doesn't parse is refused, exactly as a forbidden one is (PRD-108).
export function decideTopics(world: World, person: string, topics: Iterable<string>): Map<string, boolean> {
  const decisions = new Map<string, boolean>()
  const asked: string[] = []
  const parsed: Topic[] = []
  for (const topic of new Set(topics)) {
    const kind = parseTopic(topic)
    if (kind === undefined) {
      decisions.set(topic, false)
      continue
    }
    asked.push(topic)
    parsed.push(kind)
  }
  const allowed = canTopics(world, { kind: 'human', id: person }, parsed)
  asked.forEach((topic, at) => {
    decisions.set(topic, allowed[at] === true)
  })
  return decisions
}
