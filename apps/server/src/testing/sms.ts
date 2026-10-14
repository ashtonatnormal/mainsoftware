// An SMS provider for tests: it keeps what it was asked to send, so a test can read a code.
import type { SmsProvider } from '#src/auth/sms/provider.ts'

export class MemorySms implements SmsProvider {
  readonly name = 'memory'
  readonly sent: { to: string; code: string; at: number }[] = []
  // How many codes nextCode() has handed out per number.
  readonly #taken = new Map<string, number>()
  readonly #waiting = new Set<() => void>()

  async sendCode(to: string, code: string): Promise<void> {
    this.sent.push({ to, code, at: Date.now() })
    for (const wake of this.#waiting) wake()
  }

  // The first code sent to `to` after the last one this method returned for `to` (counted, so a
  // second sign-in never gets the first code back). Rejects after timeoutMs.
  nextCode(to: string, timeoutMs = 2000): Promise<string> {
    return new Promise((resolve, reject) => {
      const take = () => {
        const index = this.#taken.get(to) ?? 0
        const next = this.sent.filter(entry => entry.to === to)[index]
        if (next === undefined) return false
        this.#taken.set(to, index + 1)
        resolve(next.code)
        return true
      }
      if (take()) return
      const wake = () => {
        if (!take()) return
        clearTimeout(timer)
        this.#waiting.delete(wake)
      }
      const timer = setTimeout(() => {
        this.#waiting.delete(wake)
        reject(new Error(`no code was sent within ${timeoutMs} ms`))
      }, timeoutMs)
      this.#waiting.add(wake)
    })
  }

  countTo(to: string): number {
    return this.sent.filter(entry => entry.to === to).length
  }
}
