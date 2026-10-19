import { describe, expect, it } from 'vitest'
import { formatE164, maskNumber, normalisePhone } from './phone.ts'

describe('ACC-01 T14 normalising a phone number (any country, the owner decided 2026-10-13)', () => {
  it('reads a Singapore number however it is typed', () => {
    for (const input of [
      '+65 8123 4567',
      '+6581234567',
      '8123-4567',
      '8123 4567',
      '81234567',
      '0065 8123 4567',
      '(+65) 8123.4567',
      '+65 8123 4567',
      '+65‑8123–4567',
    ]) {
      expect(normalisePhone(input), input).toBe('+6581234567')
    }
    expect(normalisePhone(' 91234567 ')).toBe('+6591234567')
    expect(normalisePhone('(+65) 9123 4567')).toBe('+6591234567')
  })

  it('takes a bare 8-digit number starting 3, 6, 8 or 9 as Singaporean', () => {
    expect(normalisePhone('61234567')).toBe('+6561234567')
    expect(normalisePhone('31234567')).toBe('+6531234567')
    expect(normalisePhone('91234567')).toBe('+6591234567')
    for (const input of ['01234567', '11234567', '21234567', '41234567', '51234567', '71234567']) {
      expect(normalisePhone(input), input).toBeUndefined()
    }
  })

  it('reads any other country with + or 00 and its code', () => {
    expect(normalisePhone('+60 12-345 6789')).toBe('+60123456789')
    expect(normalisePhone('0060123456789')).toBe('+60123456789')
    expect(normalisePhone('+44 7700 900123')).toBe('+447700900123')
    expect(normalisePhone('+1 (415) 555-0123')).toBe('+14155550123')
    expect(normalisePhone('+852 9123 4567')).toBe('+85291234567')
    // E.164 allows up to 15 digits and at least 7 here, whatever the country.
    expect(normalisePhone('+123456789012345')).toBe('+123456789012345')
    expect(normalisePhone('+1234567')).toBe('+1234567')
  })

  it('needs the country code for anything but a bare Singapore number', () => {
    for (const input of ['6591234567', '07700 900123', '0123456789', '123456789', '812345678', '8123456']) {
      expect(normalisePhone(input), input).toBeUndefined()
    }
  })

  it('refuses what is not an E.164 number', () => {
    for (const input of [
      '',
      '+',
      '+65',
      '+123456',
      '+1234567890123456',
      '+0123456789',
      '000123456789',
      '+65 8123 4567 ext 2',
      '+65+81234567',
      'abc',
      '٩١٢٣٤٥٦٧',
      '+65٩١٢٣٤٥٦٧',
      '８１２３４５６７',
    ]) {
      expect(normalisePhone(input), input).toBeUndefined()
    }
  })
})

describe('T7 masking a number for the local log provider', () => {
  it('keeps the country code and the last two digits', () => {
    expect(maskNumber('+6581234567')).toBe('+65 xxxxxx67')
    expect(maskNumber('+60123456789')).toBe('+60 xxxxxxx89')
    expect(maskNumber('+14155550123')).toBe('+1 xxxxxxxx23')
    expect(maskNumber('+447700900123')).toBe('+44 xxxxxxxx23')
    expect(maskNumber('+85291234567')).toBe('+852 xxxxxx67')
    expect(maskNumber('+79161234567')).toBe('+7 xxxxxxxx67')
  })
})

describe('T20 showing a number back (formatE164)', () => {
  it('groups the rest in fours after the country code', () => {
    expect(formatE164('+6580000003')).toBe('+65 8000 0003')
    expect(formatE164('+14155550100')).toBe('+1 4155 5501 00')
  })
})
