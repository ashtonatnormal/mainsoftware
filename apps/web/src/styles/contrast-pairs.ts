// Every ink and ground the kit pairs, with the WCAG minimum each must keep in both themes (T21,
// X8, R-11, R-12). styles/contrast.test.ts reads the token values from tokens.css and fails on any
// pair below its minimum, so a token change that breaks contrast fails `npm test`. A kit piece
// that draws a new pair adds it here in the same change.
//
// Text (and initials) needs 4.5:1 (WCAG 1.4.3); a control's boundary, a focus ring or a state
// shown by colour alone needs 3:1 against what is next to it (WCAG 1.4.11). The --line hairline
// identifies nothing, so it is in neither list.

export type TokenName =
  | 'bg'
  | 'surface'
  | 'surface-2'
  | 'fg'
  | 'muted'
  | 'line-strong'
  | 'accent'
  | 'accent-fg'
  | 'accent-soft'
  | 'accent-ink'
  | 'accent-inverse'
  | 'agent'
  | 'agent-soft'
  | 'agent-fg'
  | 'rec'
  | 'rec-soft'
  | 'rec-fg'
  | 'ok'
  | 'ok-soft'
  | 'warn'
  | 'warn-soft'
  | 'wall'
  | `avatar-${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11}`
  | 'avatar-fg'

export type Pair = readonly [fg: TokenName, bg: TokenName, min: 4.5 | 3, why: string]

const GROUNDS = ['bg', 'surface', 'surface-2', 'wall'] as const
const AVATARS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const

export const TEXT_PAIRS: readonly Pair[] = [
  ...GROUNDS.map(ground => ['fg', ground, 4.5, 'body text'] as const),
  ...GROUNDS.map(ground => ['muted', ground, 4.5, 'secondary text'] as const),
  ...(['bg', 'surface', 'surface-2', 'accent-soft'] as const).map(
    ground => ['accent-ink', ground, 4.5, 'accent text, links, the current tab'] as const,
  ),
  ['accent-fg', 'accent', 4.5, 'a primary Button'],
  ['rec-fg', 'rec', 4.5, 'a danger Button; C2’s Leave (SHL-36)'],
  ['agent-fg', 'agent', 4.5, 'ink on an agent fill (RMS-36), kept so A5 can’t regress'],
  ...(['bg', 'surface', 'rec-soft'] as const).map(
    ground => ['rec', ground, 4.5, 'error text, the recording label'] as const,
  ),
  ['agent', 'agent-soft', 4.5, 'an agent chip'],
  ['ok', 'ok-soft', 4.5, 'a success note'],
  ['warn', 'warn-soft', 4.5, 'a warning note'],
  ['bg', 'fg', 4.5, 'an inverse toast'],
  ['accent-inverse', 'fg', 4.5, 'a toast’s action (SHL-35)'],
  ...AVATARS.map(n => ['avatar-fg', `avatar-${n}`, 4.5, 'avatar initials (QA-01)'] as const),
]

export const UI_PAIRS: readonly Pair[] = [
  ...GROUNDS.map(ground => ['accent', ground, 3, 'the focus ring, a Switch that is on'] as const),
  ['accent-inverse', 'fg', 3, 'the focus ring on an inverse ground (SHL-35)'],
  ...GROUNDS.map(ground => ['line-strong', ground, 3, 'a control’s border, the Switch’s off track (SHL-37)'] as const),
  ['muted', 'surface-2', 3, 'the Switch’s knob when off'],
  ['accent-fg', 'accent', 3, 'the Switch’s knob when on'],
]
