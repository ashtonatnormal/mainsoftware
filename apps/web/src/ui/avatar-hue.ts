// Which of the twelve avatar fills a person gets (QA-01, T21 item 6). The fill comes from the
// person's id, never their name, so it stays the same when they're renamed and two people with
// one name usually differ. The fills are --avatar-0 to --avatar-11 in styles/tokens.css, each at
// least 4.5:1 under --avatar-fg in both themes (styles/contrast.test.ts, TK-03).

export type AvatarHue = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11

// Every class name spelled whole, in order: Tailwind v4 compiles only class names that appear whole
// in the source, so a template such as `bg-avatar-${n}` would compile none of them (T21 item 12).
export const AVATAR_BG = [
  'bg-avatar-0',
  'bg-avatar-1',
  'bg-avatar-2',
  'bg-avatar-3',
  'bg-avatar-4',
  'bg-avatar-5',
  'bg-avatar-6',
  'bg-avatar-7',
  'bg-avatar-8',
  'bg-avatar-9',
  'bg-avatar-10',
  'bg-avatar-11',
] as const satisfies readonly string[] & { length: 12 }

const encoder = new TextEncoder()

// FNV-1a (32-bit) over the id's UTF-8 bytes, mod 12: cheap, stable across browsers, and spread
// evenly enough over UUIDs (AV-02).
export function avatarHue(personId: string): AvatarHue {
  let hash = 0x811c9dc5
  for (const byte of encoder.encode(personId)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash % AVATAR_BG.length) as AvatarHue
}
