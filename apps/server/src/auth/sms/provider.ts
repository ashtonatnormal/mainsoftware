// How sign-in codes reach a phone (CLAUDE.md: one interface per swappable provider). C0.5 has
// only the local log provider; C0.12 adds AWS End User Messaging behind this interface, once C0.9
// has cleared it in the transfer register (PDPA-10), including texts to numbers outside Singapore.
// An implementation never puts the number or the code in an error it throws or logs, because
// errors are logged.
export interface SmsProvider {
  readonly name: string
  sendCode(to: string, code: string): Promise<void>
}
