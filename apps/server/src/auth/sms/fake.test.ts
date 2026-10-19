import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeVerify, FakeVerify } from '#src/auth/sms/fake.ts'
import { SmsProviderError } from '#src/auth/sms/provider.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

// Fictional numbers from the seed's +65 8000 range.
const A = '+6580000001'
const B = '+6580000002'

describe('T20 OD-01 the fake Verify provider', () => {
  it('makes a code per verification and approves only the right one, once', async () => {
    const codes = ['111111', '222222']
    const sms = new FakeVerify({ codes: () => codes.shift() ?? '999999' })
    expect(sms.name).toBe('fake')
    expect(sms.transfer).toBeNull()
    const a = await sms.start(A)
    expect(a).toEqual({ ref: expect.stringMatching(/^VE[0-9a-f]{32}$/), foreign: false })
    const b = await sms.start(B)
    expect(b.ref).not.toBe(a.ref)
    expect(await sms.check(a.ref, '222222')).toBe('wrong')
    expect(await sms.check(a.ref, '111111')).toBe('approved')
    // Approved is used up: Twilio answers 404.
    expect(await sms.check(a.ref, '111111')).toBe('gone')
    expect(await sms.check('VE-unknown', '111111')).toBe('gone')
    expect(await sms.check(b.ref, '222222')).toBe('approved')
  })

  it('hands back a pending verification to a second start, with one more send, which reads as foreign', async () => {
    const sms = new FakeVerify()
    const first = await sms.start(A)
    const again = await sms.start(A)
    expect(again).toEqual({ ref: first.ref, foreign: true })
    expect(sms.sent.map(s => s.code)).toEqual([sms.sent[0]?.code, sms.sent[0]?.code])
    // After a cancel, a start makes a new one.
    await sms.cancel(first.ref)
    expect(await sms.check(first.ref, sms.sent[0]?.code ?? '')).toBe('gone')
    const fresh = await sms.start(A)
    expect(fresh.foreign).toBe(false)
    expect(fresh.ref).not.toBe(first.ref)
    // Cancelling an unknown or finished reference is done.
    await sms.cancel(first.ref)
    await sms.cancel('VE-unknown')
  })

  it("follows Verify's caps: a 6th send is refused (60203) and a 6th check is gone (60202)", async () => {
    const sms = new FakeVerify({ codes: () => '123456' })
    const { ref } = await sms.start(A)
    for (let send = 2; send <= 5; send++) await sms.start(A)
    await expect(sms.start(A)).rejects.toMatchObject({ kind: 'send_limit', providerCode: 60203 })
    for (let check = 1; check <= 5; check++) expect(await sms.check(ref, '000000')).toBe('wrong')
    expect(await sms.check(ref, '123456')).toBe('gone')
  })

  it('lets a verification expire after its validity, on an injected clock', async () => {
    let now = 0
    const sms = new FakeVerify({ now: () => now, codes: () => '123456', validityMs: 1000 })
    const { ref } = await sms.start(A)
    now = 1000
    expect(await sms.check(ref, '123456')).toBe('gone')
    expect((await sms.start(A)).ref).not.toBe(ref)
  })

  it('fails the next call of an operation on demand, as a provider that is down does', async () => {
    const sms = new FakeVerify()
    sms.failNext('start')
    await expect(sms.start(A)).rejects.toBeInstanceOf(SmsProviderError)
    const { ref } = await sms.start(A)
    sms.failNext('check')
    await expect(sms.check(ref, '000000')).rejects.toMatchObject({ kind: 'unavailable' })
    sms.failNext('cancel', new Error('cut off'))
    await expect(sms.cancel(ref)).rejects.toThrow('cut off')
  })

  it('returns codes in order, never the same one twice, and waits for one not sent yet', async () => {
    const codes = ['111111', '999999', '222222', '333333']
    const sms = new FakeVerify({ codes: () => codes.shift() ?? '000000' })
    const a1 = await sms.start(A)
    await sms.start(B)
    await sms.cancel(a1.ref)
    await sms.start(A)
    expect(await sms.nextCode(A)).toBe('111111')
    expect(await sms.nextCode(A)).toBe('222222')
    const third = sms.nextCode(A)
    await sms.cancel(sms.sent.at(-1)?.ref ?? '')
    await sms.start(A)
    expect(await third).toBe('333333')
    expect(await sms.nextCode(B)).toBe('999999')
    expect(sms.countTo(A)).toBe(3)
    await expect(sms.nextCode(B, 20)).rejects.toThrow(/no code was sent/)
  })

  it('takes a transfer key for the transfer-gate tests (PDPA-10)', () => {
    expect(new FakeVerify({ transfer: 'aws_sms' }).transfer).toBe('aws_sms')
  })
})

describe('T20 the guarded factory main.ts uses', () => {
  it('refuses to exist anywhere but this machine', () => {
    for (const deployEnv of ['nonprod', 'prod']) {
      expect(() => createFakeVerify({ deployEnv, appOrigin: 'http://localhost:5173' })).toThrow(/only on this machine/)
    }
    for (const deployEnv of ['local', 'test']) {
      for (const appOrigin of ['https://hearth.example', 'http://192.168.1.20:5173', 'not a url']) {
        expect(() => createFakeVerify({ deployEnv, appOrigin })).toThrow(/only on this machine/)
      }
      expect(createFakeVerify({ deployEnv, appOrigin: 'https://localhost:5180' })).toBeInstanceOf(FakeVerify)
    }
  })

  it('writes one purpose-neutral line per text, with the masked number and the code', async () => {
    const lines: string[] = []
    const sms = createFakeVerify({ deployEnv: 'local', appOrigin: 'http://localhost:5173', write: l => lines.push(l) })
    const { ref } = await sms.start('+6580000003')
    const code = sms.sent[0]?.code ?? ''
    expect(lines).toEqual([`[local only, not a log line] Hearth code for +65 xxxxxx03: ${code}\n`])
    expect(lines[0]).toMatch(/code for (\+\d+ x*\d{2}): (\d{6})$/m)
    expect(lines.join('')).not.toContain('80000003')
    expect(await sms.check(ref, code)).toBe('approved')
  })

  it('writes to stderr by default, never to the JSON log stream on stdout', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const sms = createFakeVerify({ deployEnv: 'test', appOrigin: 'http://127.0.0.1:5173' })
    await sms.start('+447700900123')
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/\+44 xxxxxxxx23: \d{6}\n$/)
  })
})
