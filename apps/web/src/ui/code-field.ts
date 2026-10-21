// What a code or PIN field keeps of what was typed, pasted or autofilled (T21 item 13, T20;
// SHL-07, SHL-27, QA-04). Pure, so Node tests cover it.
//
// The text is first put in Unicode's compatibility form (NFKC), so the full-width digits an East
// Asian keyboard types (１２３) become ASCII ones; then everything but the ASCII digits goes
// (spaces, hyphens, letters, other scripts' digits); then it is cut at the code's length. A pasted
// "123 456" is 123456, where a maxlength of 6 would have cut it to "123 45" before anything could
// read it, so neither field sets maxlength.

// A PIN is 6 digits (SHL-49; packages/shared pin-policy.ts).
export const PIN_LENGTH = 6

export function normaliseCode(input: string, length: number): string {
  return input
    .normalize('NFKC')
    .replace(/[^0-9]/g, '')
    .slice(0, Math.max(0, length))
}
