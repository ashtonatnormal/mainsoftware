import { describe, expect, it } from 'vitest'
import { AVATAR_BG, avatarHue } from './avatar-hue.ts'

// A seeded generator, so the 1,000 ids are the same on every run.
function* ids(count: number): Generator<string> {
  let seed = 0x2545f491
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed
  }
  for (let i = 0; i < count; i++) {
    const hex = Array.from({ length: 4 }, () => next().toString(16).padStart(8, '0')).join('')
    yield `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
}

describe('T21: avatar colours', () => {
  it('AV-01 QA-01 T21 item 6: a person always gets the same colour', () => {
    const id = '7f3c2b1a-0d4e-4f5a-9b6c-1d2e3f4a5b6c'
    expect(avatarHue(id)).toBe(avatarHue(id))
    expect(avatarHue(id)).toBe(avatarHue(String(id)))
    // FNV-1a's published values ('' is 0x811c9dc5, 'a' is 0xe40c292c), mod 12, so a change to the
    // hash, which would recolour everyone, fails here first.
    expect(avatarHue('')).toBe(1)
    expect(avatarHue('a')).toBe(4)
  })

  it('AV-02: 1,000 random ids use all 12', () => {
    const seen = new Map<number, number>()
    for (const id of ids(1000)) {
      const hue = avatarHue(id)
      expect(Number.isInteger(hue) && hue >= 0 && hue < 12, id).toBe(true)
      seen.set(hue, (seen.get(hue) ?? 0) + 1)
    }
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    // No fill is much rarer than the rest: 1,000 / 12 is about 83.
    expect(Math.min(...seen.values())).toBeGreaterThan(40)
  })

  it('AV-03 QA-01: AVATAR_BG spells bg-avatar-0 … bg-avatar-11 whole, in order (Tailwind compiles only whole class names)', () => {
    expect(AVATAR_BG).toEqual(Array.from({ length: 12 }, (_, n) => `bg-avatar-${n}`))
  })
})
