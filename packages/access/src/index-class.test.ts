// Unit tests for indexClassOf (index-class.ts; Rule 5, C0.6): an item whose place the snapshot
// can't resolve is never indexed, and a session keeps the class it was stamped with.
import { describe, expect, test } from 'vitest'
import { indexClassOf, readersOf } from './index.ts'
import { C, E, fixtureWorld, R, ref, S, TH } from './testing/index.ts'

const world = fixtureWorld()

describe('indexClassOf: what the snapshot can’t resolve is restricted', () => {
  test('a channel’s room, a meeting room, an event thread and their sessions are normal while their place resolves', () => {
    expect(indexClassOf(world, ref.room(R.ops))).toBe('normal')
    expect(indexClassOf(world, ref.room(R.q4))).toBe('normal')
    expect(indexClassOf(world, ref.thread(TH.q4Event))).toBe('normal')
    expect(indexClassOf(world, ref.session(S.standupFri))).toBe('normal')
  })

  test('without the channel or the event, the room and the thread are restricted', () => {
    const noEvent = fixtureWorld(f => ({ ...f, events: f.events.filter(e => e.id !== E.q4) }))
    expect(indexClassOf(noEvent, ref.room(R.q4))).toBe('restricted')
    expect(indexClassOf(noEvent, ref.thread(TH.q4Event))).toBe('restricted')
    const noChannel = fixtureWorld(f => ({ ...f, channels: f.channels.filter(c => c.id !== C.ops) }))
    expect(indexClassOf(noChannel, ref.room(R.ops))).toBe('restricted')
  })

  test('REC-20: a session follows its stamp: a space stamp needs its space; a meeting’s carries its own people', () => {
    const noChannel = fixtureWorld(f => ({ ...f, channels: f.channels.filter(c => c.id !== C.ops) }))
    expect(indexClassOf(noChannel, ref.session(S.standupFri))).toBe('restricted')
    expect(readersOf(noChannel, ref.session(S.standupFri))).toEqual([])
    // The Q4 review stamped its invitees at the start, so it keeps them, and its class, without the event.
    const noEvent = fixtureWorld(f => ({ ...f, events: f.events.filter(e => e.id !== E.q4) }))
    expect(indexClassOf(noEvent, ref.session(S.q4Review))).toBe('normal')
    expect(readersOf(noEvent, ref.session(S.q4Review))).toEqual(readersOf(world, ref.session(S.q4Review)))
  })
})
