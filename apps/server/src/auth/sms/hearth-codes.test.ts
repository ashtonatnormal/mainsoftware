import { describe, expect, it } from 'vitest'
import { deriveKeys } from '#src/auth/crypto.ts'
import { hearthCodes, type TextSender } from '#src/auth/sms/hearth-codes.ts'
import { SmsProviderError } from '#src/auth/sms/provider.ts'

// Fictional numbers from the seed's +65 8000 range; a low-entropy test secret.
const A = '+6580000001'
const keys = deriveKeys('test-secret-test-secret-test-secret')

function sender(): TextSender & { texts: { to: string; body: string }[] } {
  const texts: { to: string; body: string }[] = []
  return {
    name: 'aws_sms',
    transfer: 'aws_sms',
    texts,
    async sendText(to, body) {
      texts.push({ to, body })
    },
  }
}

const codeIn = (body: string | undefined) => /(\d{6})/.exec(body ?? '')?.[1] ?? ''

describe('T20 AQ-16 hearth-codes: Hearth makes the code, a send-only sender delivers it', () => {
  it('sends a 6-digit code and approves exactly that code, with a ref holding neither code nor number', async () => {
    const out = sender()
    const sms = hearthCodes(out, keys)
    expect([sms.name, sms.transfer]).toEqual(['aws_sms', 'aws_sms'])
    const { ref, foreign } = await sms.start(A)
    expect(foreign).toBe(false)
    const code = codeIn(out.texts[0]?.body)
    expect(out.texts).toEqual([{ to: A, body: `Your Hearth code is ${code}. Don't share it with anyone.` }])
    expect(ref).toMatch(/^h1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
    expect(ref).not.toContain(code)
    expect(ref).not.toContain(A.slice(1))
    expect(await sms.check(ref, code)).toBe('approved')
    expect(await sms.check(ref, code === '000000' ? '000001' : '000000')).toBe('wrong')
  })

  it('never answers gone: expiry and single use belong to the challenge record', async () => {
    const sms = hearthCodes(sender(), keys)
    for (const ref of ['', 'h1.x.y', 'VE0', `h1.${'a'.repeat(22)}.${'b'.repeat(43)}`]) {
      expect(await sms.check(ref, '123456'), ref).toBe('wrong')
    }
    await expect(sms.cancel('anything')).resolves.toBeUndefined()
  })

  it('a ref made under another secret never approves', async () => {
    const out = sender()
    const { ref } = await hearthCodes(out, keys).start(A)
    const other = hearthCodes(sender(), deriveKeys('other-secret-other-secret-other-secret'))
    expect(await other.check(ref, codeIn(out.texts[0]?.body))).toBe('wrong')
  })

  it("passes the sender's failure through, and makes no ref", async () => {
    const failing: TextSender = {
      name: 'aws_sms',
      transfer: 'aws_sms',
      sendText: async () => {
        throw new SmsProviderError('unavailable', undefined, 503)
      },
    }
    await expect(hearthCodes(failing, keys).start(A)).rejects.toMatchObject({ kind: 'unavailable' })
  })
})
