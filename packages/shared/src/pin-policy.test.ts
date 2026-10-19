import { describe, expect, it } from 'vitest'
import { COMMON_PINS, pinProblem } from './pin-policy.ts'

describe('SHL-49 choosing a PIN', () => {
  it('refuses one digit six times', () => {
    for (let digit = 0; digit <= 9; digit++) expect(pinProblem(String(digit).repeat(6))).toBe('too_easy')
  })

  it('refuses ascending and descending runs', () => {
    for (const pin of ['012345', '123456', '234567', '345678', '456789', '987654', '876543', '765432', '654321']) {
      expect(pinProblem(pin), pin).toBe('too_easy')
    }
    expect(pinProblem('543210')).toBe('too_easy')
  })

  it('refuses every common PIN', () => {
    expect(COMMON_PINS.size).toBe(21)
    for (const pin of COMMON_PINS) {
      expect(pin).toMatch(/^[0-9]{6}$/)
      expect(pinProblem(pin), pin).toBe('too_easy')
    }
  })

  it('needs exactly 6 ASCII digits', () => {
    for (const pin of ['', '12345', '1234567', '12a456', ' 38190', '381904 ', '３８１９０４', '٣٨١٩٠٤']) {
      expect(pinProblem(pin), pin).toBe('format')
    }
  })

  it('accepts a PIN that is none of these', () => {
    for (const pin of ['381904', '135792', '901234', '120345', '789012']) expect(pinProblem(pin), pin).toBeUndefined()
  })
})
