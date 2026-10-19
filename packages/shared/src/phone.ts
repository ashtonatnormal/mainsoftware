// Phone numbers as people type them (ACC-01, T14). Any country's number is accepted: some of the
// team live overseas (the owner's decision, 2026-10-13). Codes still go only to numbers on the
// roster, so accepting any number sends nothing to strangers.

// Spaces (any Unicode space, NBSP included), hyphens and other dashes, dots and brackets.
const SEPARATORS = /[\s\-‐-―−.()]/g
// E.164: a plus, a country code that doesn't start with 0, at most 15 digits in all (0002's
// phone_numbers_e164 check). ASCII digits only.
const E164 = /^\+[1-9][0-9]{6,14}$/
// Most of the team is in Singapore, so a bare 8-digit Singapore number (fixed lines start with 6,
// mobiles with 8 or 9, and 3 is used for numbers such as VoIP) needs no country code.
const BARE_SINGAPORE = /^[3689][0-9]{7}$/

// What people type, as an E.164 number, or undefined. A leading 00 means +; a bare 8-digit number
// starting 3, 6, 8 or 9 is taken as Singaporean; anything else needs + and the country code.
export function normalisePhone(input: string): string | undefined {
  const compact = input.replace(SEPARATORS, '')
  let e164: string
  if (compact.startsWith('+')) e164 = compact
  else if (compact.startsWith('00')) e164 = `+${compact.slice(2)}`
  else if (BARE_SINGAPORE.test(compact)) e164 = `+65${compact}`
  else return undefined
  return E164.test(e164) ? e164 : undefined
}

// Country codes are 1 to 3 digits and none is a prefix of another (ITU-T E.164). The one-digit
// codes are 1 and 7, and these are the two-digit ones; every other code has three.
const ONE_DIGIT = /^[17]/
const TWO_DIGITS = /^(?:2[07]|3[0-469]|4[013-9]|5[1-8]|6[0-6]|8[1246]|9[0-58])/

function countryCodeLength(digits: string): number {
  if (ONE_DIGIT.test(digits)) return 1
  return TWO_DIGITS.test(digits) ? 2 : 3
}

// A number with everything but its country code and last two digits hidden, such as
// '+65 xxxxxx67'. For the local log provider only, so a developer can tell which number a code is for.
export function maskNumber(e164: string): string {
  const digits = e164.replace(/^\+/, '')
  const country = digits.slice(0, countryCodeLength(digits))
  const rest = digits.slice(country.length)
  return `+${country} ${'x'.repeat(Math.max(rest.length - 2, 0))}${rest.slice(-2)}`
}

// An E.164 number as people read it: the country code, then the rest in groups of four from the
// left, such as '+65 8000 0003'. For showing a number back to the person who typed it.
export function formatE164(e164: string): string {
  const digits = e164.replace(/^\+/, '')
  const country = digits.slice(0, countryCodeLength(digits))
  const groups = digits.slice(country.length).match(/.{1,4}/g) ?? []
  return [`+${country}`, ...groups].join(' ')
}
