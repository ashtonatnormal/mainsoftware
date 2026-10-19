import { describe, expect, it } from 'vitest'
import { isSubmitEnter } from './keys.ts'

describe('T21: isSubmitEnter (X15)', () => {
  it("KY-01 X15: Enter submits; Shift, Alt or Meta with Enter, isComposing and keyCode 229 don't", () => {
    expect(isSubmitEnter({ key: 'Enter', shiftKey: false })).toBe(true)
    expect(isSubmitEnter({ key: 'Enter', shiftKey: false, keyCode: 13, nativeEvent: { isComposing: false } })).toBe(
      true,
    )
    expect(isSubmitEnter({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(isSubmitEnter({ key: 'Enter', shiftKey: false, altKey: true })).toBe(false)
    expect(isSubmitEnter({ key: 'Enter', shiftKey: false, metaKey: true })).toBe(false)
    // An input method is composing: Enter confirms the text, it doesn't send.
    expect(isSubmitEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false)
    expect(isSubmitEnter({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true } })).toBe(false)
    expect(isSubmitEnter({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false)
    // Other keys never submit.
    expect(isSubmitEnter({ key: 'a', shiftKey: false })).toBe(false)
    expect(isSubmitEnter({ key: 'Process', shiftKey: false, keyCode: 229 })).toBe(false)
  })
})
