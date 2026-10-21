// Joins class names, dropping the falsy ones, so a component can write `cond && 'class'` inline.
// Tailwind compiles only class names that appear whole in the source, so callers pass whole names,
// never a built-up `bg-${x}` (ui/avatar-hue.ts's AVATAR_BG shows the pattern).
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
