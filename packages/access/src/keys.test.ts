// Unit tests for keysOf (keys.ts; PRD-112, AGT-04): the principals that hold no keys read nothing
// through the key rule. The system principal's capabilities come with the jobs that need them
// (C0.6, C2.6, C2.8); change this test then, deliberately.
import { describe, expect, test } from 'vitest'
import { keysOf, listAccessible, type ResourceKind } from './index.ts'
import { AG, agent, fixtureWorld, system } from './testing/index.ts'

const world = fixtureWorld()
const KINDS: readonly ResourceKind[] = [
  'channel',
  'dm',
  'group_dm',
  'agent_dm',
  'assistant_chat',
  'room',
  'thread',
  'message',
  'session',
  'slide_copy',
  'event',
  'task',
  'suggested_task',
  'folder',
  'file',
  'comment',
  'derived',
]

describe('keysOf: principals with no keys', () => {
  test('PRD-112: the system principal holds no keys and reads nothing', () => {
    expect(keysOf(world, system)).toEqual([])
    for (const kind of KINDS) expect(listAccessible(world, system, kind), kind).toEqual([])
  })

  test('AGT-04: an agent holds no keys; it reads by its scope, never by tokens', () => {
    for (const id of Object.values(AG)) expect(keysOf(world, agent(id)), id).toEqual([])
  })
})
