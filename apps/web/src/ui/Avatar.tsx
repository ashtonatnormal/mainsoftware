// A person's initials on their avatar fill (T21; fixes SHL-41, QA-01). It takes the id and name as
// props, never from a store, so it renders the same wherever it is used. The fill is one of the
// twelve avatar tokens, picked by the id (ui/avatar-hue.ts), and the initials are --avatar-fg, at
// least 4.5:1 on every fill in both themes (TK-03); the demo's inline oklch style and text-white
// are gone. No status dot until presence exists (C1.3), and no agent or assistant branch: agents
// and assistants get their own marks with their stages.
import { AVATAR_BG, avatarHue } from './avatar-hue.ts'
import { cx } from './cx.ts'

export interface AvatarProps {
  personId: string
  name: string
  size?: 'sm' | 'md' | 'lg'
  // Hidden from assistive technology when the name is already said beside it, as on the avatar
  // menu's trigger.
  decorative?: boolean
}

// Text stays at 12 px or more (text-xs), in rem so it follows the person's text size.
const SIZES = {
  sm: 'size-8 text-xs',
  md: 'size-10 text-small',
  lg: 'size-12 text-body',
} as const

// The first letter of up to two words, by code point, so a name that starts outside the Basic
// Multilingual Plane keeps its whole first character.
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(word => Array.from(word)[0] ?? '')
    .join('')
    .toLocaleUpperCase('en-GB')
}

export function Avatar({ personId, name, size = 'md', decorative = false }: AvatarProps) {
  const label = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': name }
  // The initials are part of the image, so a screen reader hears the name once, not the letters.
  return (
    <span
      {...label}
      className={cx(
        'inline-grid shrink-0 select-none place-items-center rounded-full font-semibold text-avatar-fg',
        AVATAR_BG[avatarHue(personId)],
        SIZES[size],
      )}
    >
      <span aria-hidden>{initialsOf(name)}</span>
    </span>
  )
}
