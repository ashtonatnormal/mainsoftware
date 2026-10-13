// Which PINs people may choose (SHL-49): exactly 6 ASCII digits, and not one that is easy to guess.

// PINs people choose often that the repeat and run rules below don't already catch.
export const COMMON_PINS: ReadonlySet<string> = new Set([
  '121212',
  '112233',
  '123123',
  '123321',
  '111222',
  '000123',
  '101010',
  '102030',
  '131313',
  '159753',
  '147258',
  '258369',
  '696969',
  '520520',
  '789456',
  '456123',
  '246810',
  '135790',
  '112358',
  '199999',
  '200000',
])

// Each step between neighbouring digits is the same +1 or -1: 012345 … 456789, 987654 … 543210.
function isRun(pin: string): boolean {
  const steps = new Set<number>()
  for (let i = 1; i < pin.length; i++) steps.add(pin.charCodeAt(i) - pin.charCodeAt(i - 1))
  return steps.size === 1 && (steps.has(1) || steps.has(-1))
}

// Why a PIN can't be chosen, or undefined if it can: 'format' unless it is 6 ASCII digits;
// 'too_easy' for one digit six times, an ascending or descending run, or a common PIN.
export function pinProblem(pin: string): 'format' | 'too_easy' | undefined {
  if (!/^[0-9]{6}$/.test(pin)) return 'format'
  if (/^(.)\1{5}$/.test(pin) || isRun(pin) || COMMON_PINS.has(pin)) return 'too_easy'
  return undefined
}
