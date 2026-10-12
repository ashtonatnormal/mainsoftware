import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { CENSOR, createLogger } from '#src/logger.ts'

function capture() {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk))
      done()
    },
  })
  const logger = createLogger({ logLevel: 'info', role: 'api' }, stream)
  return { logger, lines }
}

describe('C0.2 redacting logs', () => {
  it('replaces credentials and contact details wherever they sit, up to three levels down', () => {
    const { logger, lines } = capture()
    logger.info(
      {
        password: 'top-level-password',
        req: { headers: { authorization: 'Bearer abc.def', cookie: '__Host-session=s3cr3t' } },
        res: { headers: { 'set-cookie': '__Host-session=s3cr3t' } },
        person: { phone: '+6591234567', profile: { phoneNumber: '+6598765432' } },
        body: { pin: '123456', otp: '654321', token: 'opaque-token' },
        config: { databaseUrl: 'postgres://u:db-password@h/d' },
      },
      'request',
    )
    const line = lines.join('')
    for (const secret of [
      'top-level-password',
      'abc.def',
      's3cr3t',
      '+6591234567',
      '+6598765432',
      '123456',
      '654321',
      'opaque-token',
      'db-password',
    ]) {
      expect(line).not.toContain(secret)
    }
    expect(line).toContain(CENSOR)
  })

  it('keeps ordinary fields, and tags every line with the role', () => {
    const { logger, lines } = capture()
    logger.info({ method: 'GET', url: '/ready', statusCode: 200 }, 'done')
    const entry = JSON.parse(lines[0] ?? '{}')
    expect(entry).toMatchObject({ role: 'api', method: 'GET', url: '/ready', statusCode: 200, msg: 'done' })
  })
})
