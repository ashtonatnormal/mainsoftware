// What a code or PIN field keeps of what was typed (T20, T21; AUTH-DESIGN §10.5, SHL-07, QA-04).
import { describe, expect, it } from 'vitest'
import { normaliseCode, PIN_LENGTH } from './code-field.ts'

describe('T21: normaliseCode (ui/code-field.ts)', () => {
  it('SM-08 SI-07 AUTH-DESIGN §10.5: NFKC and stripping turn "１２３ ４５６", "123-456" and "123 456" into 123456, and the result is cut at the length', () => {
    expect(normaliseCode('１２３ ４５６', 6)).toBe('123456')
    expect(normaliseCode('123-456', 6)).toBe('123456')
    expect(normaliseCode('123 456', 6)).toBe('123456')
    expect(normaliseCode(' 12a3 4.5,6 ', 6)).toBe('123456')
    expect(normaliseCode('1234567', 6)).toBe('123456')
    expect(normaliseCode('12345678', 8)).toBe('12345678')
    expect(normaliseCode('', 6)).toBe('')
  })

  it('only ASCII digits are kept: other scripts’ digits and letters go', () => {
    // Arabic-Indic digits are digits, but not ones the server reads; NFKC leaves them as they are.
    expect(normaliseCode('١٢٣456', 6)).toBe('456')
    expect(normaliseCode('abc', 6)).toBe('')
    expect(normaliseCode('123456', 0)).toBe('')
    expect(PIN_LENGTH).toBe(6)
  })
})
