import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogSmsProvider } from '#src/auth/sms/log.ts'
import { MemorySms } from '#src/testing/sms.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('T7 T14 the local log SMS provider', () => {
  it('refuses to exist anywhere but this machine', () => {
    for (const deployEnv of ['test', 'nonprod', 'prod']) {
      expect(() => createLogSmsProvider({ deployEnv, appOrigin: 'http://localhost:5173' })).toThrow(
        /only on this machine/,
      )
    }
    for (const appOrigin of ['https://hearth.example', 'http://192.168.1.20:5173', 'not a url']) {
      expect(() => createLogSmsProvider({ deployEnv: 'local', appOrigin })).toThrow(/only on this machine/)
    }
  })

  it('writes one line with the masked number and the code', async () => {
    const lines: string[] = []
    const sms = createLogSmsProvider({
      deployEnv: 'local',
      appOrigin: 'http://localhost:5173',
      write: l => lines.push(l),
    })
    expect(sms.name).toBe('log')
    await sms.sendCode('+6581234567', '123456')
    expect(lines).toEqual(['[local only, not a log line] Hearth sign-in code for +65 xxxxxx67: 123456\n'])
    expect(lines.join('')).not.toContain('81234567')
  })

  it('writes to stderr by default, never to the JSON log stream on stdout', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const sms = createLogSmsProvider({ deployEnv: 'local', appOrigin: 'http://127.0.0.1:5173' })
    await sms.sendCode('+447700900123', '654321')
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0]?.[0])).toContain('+44 xxxxxxxx23: 654321')
  })
})

describe('T7 the in-memory SMS provider for tests', () => {
  it('returns codes in order, never the same one twice, and waits for one not sent yet', async () => {
    const sms = new MemorySms()
    await sms.sendCode('+6580000001', '111111')
    await sms.sendCode('+6580000002', '999999')
    await sms.sendCode('+6580000001', '222222')
    expect(await sms.nextCode('+6580000001')).toBe('111111')
    expect(await sms.nextCode('+6580000001')).toBe('222222')
    const third = sms.nextCode('+6580000001')
    await sms.sendCode('+6580000001', '333333')
    expect(await third).toBe('333333')
    expect(await sms.nextCode('+6580000002')).toBe('999999')
    expect(sms.countTo('+6580000001')).toBe(3)
    expect(sms.sent.map(s => s.code)).toEqual(['111111', '999999', '222222', '333333'])
  })

  it('gives up when no code comes', async () => {
    const sms = new MemorySms()
    await expect(sms.nextCode('+6580000001', 20)).rejects.toThrow(/no code was sent/)
    await sms.sendCode('+6580000001', '444444')
    expect(await sms.nextCode('+6580000001')).toBe('444444')
  })
})
