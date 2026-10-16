// A wait a loop can be woken from: the worker's loops sleep between rounds, and stop() (or a job
// finishing, for the claim loop) wakes them at once rather than after the rest of their interval.
export class Sleeper {
  readonly #wakers = new Set<() => void>()

  sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const wake = () => {
        clearTimeout(timer)
        this.#wakers.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, Math.max(0, ms))
      this.#wakers.add(wake)
    })
  }

  wake(): void {
    for (const wake of [...this.#wakers]) wake()
  }
}

// Resolves when `work` settles or at `until` (on the given monotonic clock), whichever is first.
export async function settledBy(work: Promise<unknown>, until: number, now: () => number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    work.then(
      () => {},
      () => {},
    ),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, Math.max(0, until - now()))
    }),
  ])
  clearTimeout(timer)
}
