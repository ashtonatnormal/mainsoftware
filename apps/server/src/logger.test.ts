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

  it("drops a failed Valkey command's arguments, which carry the password when AUTH fails", () => {
    const { logger, lines } = capture()
    const error = Object.assign(new Error('WRONGPASS invalid username-password pair'), {
      command: { name: 'hello', args: ['3', 'AUTH', 'hearth', 'valkey-password'] },
    })
    logger.warn({ err: error }, 'valkey connection error')
    logger.child({ reqId: 'req-1' }).warn({ check: 'valkey', err: error }, 'readiness check failed')
    const out = lines.join('')
    expect(out).not.toContain('valkey-password')
    expect(out).toContain('WRONGPASS')
    expect(JSON.parse(lines[0] ?? '{}').err.command).toEqual({ name: 'hello', args: CENSOR })
  })

  it('drops every credential in a whole config object', () => {
    const { logger, lines } = capture()
    logger.info({
      config: {
        databaseUrl: 'postgres://u:pg-secret@h/d',
        valkeyUrl: 'rediss://default:valkey-secret@cache:6379',
        s3: { credentials: { accessKeyId: 'hearth-local', secretAccessKey: 's3-secret' } },
      },
    })
    for (const secret of ['pg-secret', 'valkey-secret', 's3-secret']) expect(lines.join('')).not.toContain(secret)
  })

  it('keeps ordinary fields, and tags every line with the role', () => {
    const { logger, lines } = capture()
    logger.info({ method: 'GET', url: '/ready', statusCode: 200 }, 'done')
    const entry = JSON.parse(lines[0] ?? '{}')
    expect(entry).toMatchObject({ role: 'api', method: 'GET', url: '/ready', statusCode: 200, msg: 'done' })
  })
})

describe('C0.5 redacting sign-in values (PDPA; the C0.13 log seam)', () => {
  it("keeps a Postgres error's code but drops its detail, which names the row's values", () => {
    const { logger, lines } = capture()
    const error = Object.assign(new Error('duplicate key value violates unique constraint "phone_numbers_e164"'), {
      code: '23505',
      detail: 'Key (org_id, e164)=(a0000000-0000-4000-8000-000000000001, +6580000001) already exists.',
      hint: 'a hint quoting +6580000002',
      internalQuery: 'select +6580000003',
    })
    logger.error({ err: error }, 'insert failed')
    const out = lines.join('')
    for (const value of ['+6580000001', '+6580000002', '+6580000003']) expect(out).not.toContain(value)
    expect(JSON.parse(lines[0] ?? '{}').err).toMatchObject({ code: '23505', detail: CENSOR })
  })

  it('drops numbers, challenges, credential ids and attempt ids under their own keys', () => {
    const { logger, lines } = capture()
    logger.info({
      e164: '+6591234567',
      passkey: { challenge: 'a-challenge-value', credentialId: 'a-credential-id' },
      sign_in: { step: { attemptId: 'an-attempt-id' } },
    })
    const out = lines.join('')
    for (const value of ['+6591234567', 'a-challenge-value', 'a-credential-id', 'an-attempt-id']) {
      expect(out).not.toContain(value)
    }
  })
})
