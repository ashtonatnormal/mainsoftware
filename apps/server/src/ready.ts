// Readiness: whether this process can serve, checked against everything it depends on. /health
// only says the process is up; /ready also checks Postgres, Valkey and object storage (realtime,
// which never uses storage, its gateway instead), so a deploy waits for it and a load balancer can
// stop sending traffic while a dependency is down. Realtime's load balancer checks /ready/local
// instead, which fails only for reasons local to the process, so an outage of a shared dependency
// doesn't get every realtime task replaced at once (TECH-SPEC T19 item 12).

// A dependency check resolves when the dependency answers and rejects otherwise. The signal
// aborts it when the time allowed runs out, so it doesn't leave a request hanging.
export type Check = (signal: AbortSignal) => Promise<void>

export type CheckResult = 'ok' | 'failed' | 'timed out'

export interface Readiness {
  ready: boolean
  checks: Record<string, CheckResult>
}

// Each check gets at most this long, and they run at once, so /ready answers within about this
// time even when every dependency hangs.
export const CHECK_TIMEOUT_MS = 2000

export async function checkReadiness(
  checks: Record<string, Check>,
  onFailure: (name: string, error: unknown) => void,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<Readiness> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<[string, CheckResult]> => {
      const controller = new AbortController()
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<'timed out'>(resolve => {
        timer = setTimeout(() => {
          controller.abort(new Error(`${name} check timed out after ${timeoutMs} ms`))
          resolve('timed out')
        }, timeoutMs)
      })
      try {
        const result = await Promise.race([check(controller.signal).then(() => 'ok' as const), timeout])
        if (result === 'timed out') onFailure(name, controller.signal.reason)
        return [name, result]
      } catch (error) {
        onFailure(name, error)
        return [name, 'failed']
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  const results = Object.fromEntries(entries)
  return { ready: entries.every(([, result]) => result === 'ok'), checks: results }
}
