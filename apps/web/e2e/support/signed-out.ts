// Which browser contexts the page guard (fixtures.ts) still treats as signed out (T21 item 11). A
// signed-out page's boot answers GET /api/session 401, which the guard expects of a context open()
// made signed out (or a spec marked so: sign-in.spec.ts's default context, and again before each
// sign-out there) only until that context is signed in, as a 2xx from GET /api/session there shows.
// From then on a session 401 is the test's to declare, so an unexpected one after a sign-in fails
// the test. It reads no DOM, so scripts/guards/e2e-setup.test.ts (ES-15) can test it in Node.

export const SESSION_401 = { path: '/api/session', status: 401 } as const

export class SignedOutContexts<Context extends object> {
  readonly #contexts = new WeakSet<Context>()

  // The context starts signed out.
  expect(context: Context): void {
    this.#contexts.add(context)
  }

  // A response from the app's origin in the context: a session answer signs it in.
  saw(context: Context, path: string, status: number): void {
    if (path === SESSION_401.path && status >= 200 && status < 300) this.#contexts.delete(context)
  }

  // Whether a response is a signed-out boot's session check in a context not yet signed in.
  allows(context: Context, path: string, status: number): boolean {
    return path === SESSION_401.path && status === SESSION_401.status && this.#contexts.has(context)
  }
}
