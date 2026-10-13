// The local SMS provider. Only on this machine: DEPLOY_ENV=local and a loopback APP_ORIGIN.
// config.ts refuses anything else, and so does this constructor. It prints the code to stderr,
// never to the JSON log stream, with the number masked, so a developer can sign in to the local
// stack. On ECS stderr reaches CloudWatch too, which is why two independent conditions guard it.
import { maskNumber } from '#src/auth/phone.ts'
import type { SmsProvider } from '#src/auth/sms/provider.ts'
import { isLoopbackOrigin } from '#src/config.ts'

export function createLogSmsProvider(options: {
  deployEnv: string
  appOrigin: string
  write?: (line: string) => void
}): SmsProvider {
  if (options.deployEnv !== 'local' || !isLoopbackOrigin(options.appOrigin)) {
    throw new Error('the log SMS provider runs only on this machine (DEPLOY_ENV local and a localhost APP_ORIGIN)')
  }
  const write = options.write ?? ((line: string) => process.stderr.write(line))
  return {
    name: 'log',
    async sendCode(to, code) {
      write(`[local only, not a log line] Hearth sign-in code for ${maskNumber(to)}: ${code}\n`)
    },
  }
}
