// Whether a key press should submit (T21; X15, SLD-04). Enter alone submits; Shift, Alt or Meta
// with Enter make a new line or belong to the system. While an input method is composing (Chinese,
// Japanese or Korean text, for instance), Enter confirms the composition, so it must never send:
// the browser says so with isComposing, and Safari, which can fire that keydown after
// compositionend, with keyCode 229. C1's composer is the first caller.

export interface EnterLike {
  key: string
  shiftKey: boolean
  altKey?: boolean
  metaKey?: boolean
  isComposing?: boolean
  keyCode?: number
  // React's synthetic event carries the composition flag on the native event only.
  nativeEvent?: { isComposing?: boolean }
}

export function isSubmitEnter(event: EnterLike): boolean {
  if (event.key !== 'Enter') return false
  if (event.shiftKey || event.altKey || event.metaKey) return false
  if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return false
  return true
}
