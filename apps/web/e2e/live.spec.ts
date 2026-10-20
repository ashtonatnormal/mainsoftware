// The live connection in a real browser (T21 items 4 and 11; T19 items 10 and 11, T17 item 11,
// X11). Signed in as Kelvin, live.spec's own persona (T21 item 11),
// so closing, refusing and routing his sockets touches no other spec's session. The flags and socket
// paths run against the real servers; the failure cases put Playwright's routeWebSocket between the
// page and realtime, and the clock is Playwright's, so 30 s of reconnects take no 30 s. Nothing here
// ends Kelvin's session on the server: LV-05's 401s are routed answers.
import type { Page, WebSocketRoute } from '@playwright/test'
import { recordAnnouncements } from './support/checks.ts'
import { stateFile } from './support/env.ts'
import { expect, SESSION_401, test } from './support/fixtures.ts'

test.use({ storageState: stateFile('live') })

const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
// Marks the document, so a test can tell a new one: Playwright's clock fakes performance.timeOrigin,
// which the other specs use for that.
const markDocument = (page: Page) =>
  page.evaluate(() => {
    ;(window as unknown as { e2eOldDocument?: boolean }).e2eOldDocument = true
  })
const isOldDocument = (page: Page) =>
  page.evaluate(() => (window as unknown as { e2eOldDocument?: boolean }).e2eOldDocument === true)

// The session's own answer, from the page (the guard allows same-origin requests).
const personOf = (page: Page) =>
  page.evaluate(async () => {
    const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
    return ((await response.json()) as { personId: string }).personId
  })

test('LV-01 T17 item 11: the shell reads GET /api/flags (200, no-store, {flags:{}})', { tag: '@smoke' }, async ({
  page,
}) => {
  const flags = page.waitForResponse(response => new URL(response.url()).pathname === '/api/flags')
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  const response = await flags
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toBe('no-store')
  expect(await response.json()).toEqual({ flags: {} })
})

test('LV-02 T19 item 10: /ws on the app origin says hello first, gets welcome, subs person:<id> and gets it acked ok, with no close', {
  tag: '@smoke',
}, async ({ page }) => {
  const sent: { t?: string; topics?: string[] }[] = []
  const received: { t?: string; ok?: string[] }[] = []
  let closed = false
  let url = ''
  page.on('websocket', socket => {
    url = socket.url()
    socket.on('framesent', frame => sent.push(JSON.parse(String(frame.payload))))
    socket.on('framereceived', frame => received.push(JSON.parse(String(frame.payload))))
    socket.on('close', () => {
      closed = true
    })
  })
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  const topic = `person:${await personOf(page)}`
  await expect.poll(() => received.find(frame => frame.t === 'ack')?.ok ?? []).toContain(topic)
  expect(new URL(url).host).toBe(new URL(page.url()).host)
  expect(new URL(url).pathname).toBe('/ws')
  expect(sent[0]?.t).toBe('hello')
  expect(received[0]?.t).toBe('welcome')
  expect(sent.find(frame => frame.t === 'sub')?.topics).toContain(topic)
  expect(closed).toBe(false)
})

test('LV-03 T17 item 11: a nudge frame reaches the page and leads to GET /api/flags within the spread', async ({
  page,
}) => {
  await page.clock.install()
  let route: WebSocketRoute | undefined
  await page.routeWebSocket('/ws', ws => {
    route = ws
    ws.connectToServer()
  })
  const welcomed = page.waitForEvent('websocket').then(
    socket =>
      new Promise<void>(resolve =>
        socket.on('framereceived', frame => {
          if (String(frame.payload).includes('"t":"ack"')) resolve()
        }),
      ),
  )
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  await welcomed
  // The boot's own flags fetch is done; the next one is the nudge's.
  await page.waitForLoadState('networkidle')
  const refetch = page.waitForRequest(request => new URL(request.url()).pathname === '/api/flags')
  route?.send(JSON.stringify({ v: 1, t: 'nudge', what: 'flags' }))
  // The spread is at most 30 s (apps/server/src/realtime/policy.ts spreadMaxMs).
  await page.clock.fastForward(31_000)
  const request = await refetch
  expect(request.method()).toBe('GET')
})

// Puts a route between the page and realtime: each socket goes through to the server until
// `refuse` is set, after which each new one is closed at once with a going-away close (1001), which
// the client treats as it does a dropped connection (1006, which no endpoint can send). `drop()`
// closes the socket that is open now the same way.
async function routeSockets(page: Page) {
  const state = { refuse: false, current: undefined as WebSocketRoute | undefined, acked: 0 }
  await page.routeWebSocket('/ws', ws => {
    state.current = ws
    if (state.refuse) {
      ws.close({ code: 1001, reason: 'going away' })
      return
    }
    const server = ws.connectToServer()
    server.onMessage(message => {
      if (String(message).includes('"t":"ack"')) state.acked++
      ws.send(message)
    })
  })
  return {
    state,
    drop: () => {
      state.refuse = true
      state.current?.close({ code: 1001, reason: 'going away' })
    },
  }
}

// The connection banner's line (live/ConnectionBanner.tsx), inside <main>, not the announcer's copy
// of it, which sits outside.
const banner = (page: Page, text: string) => page.locator('#main').getByText(text, { exact: true })

test('LV-04 X11 T21 item 4: with every socket closed, Reconnecting… appears and is announced only after 30 s, and Connected again once on recovery', async ({
  page,
}) => {
  const said = await recordAnnouncements(page)
  await page.clock.install()
  const sockets = await routeSockets(page)
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  await expect.poll(() => sockets.state.acked).toBeGreaterThanOrEqual(1)

  // runFor fires every timer due on the way, the ones it makes included (each try, the stall).
  sockets.drop()
  await page.clock.runFor(29_000)
  await expect(banner(page, 'Reconnecting…')).toHaveCount(0)
  expect(await said()).not.toContain('Reconnecting…')
  await page.clock.runFor(2_000)
  await expect(banner(page, 'Reconnecting…')).toBeVisible()
  await expect.poll(said).toContain('Reconnecting…')

  // Back: the next try (at most 30 s away) reaches the server and is welcomed. fastForward fires
  // that try and stops, so the socket's welcome arrives in real time, before any timeout of its own.
  const acked = sockets.state.acked
  sockets.state.refuse = false
  await page.clock.fastForward(31_000)
  await expect.poll(() => sockets.state.acked).toBeGreaterThan(acked)
  await expect(banner(page, 'Reconnecting…')).toHaveCount(0)
  await expect.poll(said).toContain('Connected again.')
  const spoken = await said()
  expect(spoken.filter(text => text === 'Reconnecting…')).toHaveLength(1)
  expect(spoken.filter(text => text === 'Connected again.')).toHaveLength(1)
})

test("LV-05 T19 item 11: after 30 s of refused reconnects, the probe's 401 from GET /api/flags ends the session: a new document shows the sign-in step with You've been signed out.", async ({
  page,
  guard,
}) => {
  // Both answers are routed, so Kelvin's real session survives, and the new document's own boot
  // reads signed out too (else /sign-in would send it back to /chats).
  guard.expectResponses([{ path: '/api/flags', status: 401 }, SESSION_401])
  await page.clock.install()
  const sockets = await routeSockets(page)
  await page.goto('/chats')
  await expect(h1(page)).toHaveText('Chats')
  await expect.poll(() => sockets.state.acked).toBeGreaterThanOrEqual(1)
  await markDocument(page)
  const signedOut = {
    status: 401,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      error: 'signed_out',
      message: "You've been signed out. Sign in again to keep using Hearth.",
    }),
  }
  await page.route('**/api/flags', route => route.fulfill(signedOut))
  await page.route('**/api/session', route => route.fulfill(signedOut))

  sockets.drop()
  // 30 s into the episode the client stalls, and probes within the next 5 s; runFor fires every
  // timer due on the way, the probe's included.
  await page.clock.runFor(36_000)
  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(h1(page)).toHaveText('Sign in to Hearth')
  await expect(page.getByRole('status')).toHaveText("You've been signed out.")
  expect(await isOldDocument(page)).toBe(false)
})

test('LV-06 T21 item 4: a 4426 close reloads once, and a second within 60 s shows the update banner instead', async ({
  page,
}) => {
  const said = await recordAnnouncements(page)
  await page.routeWebSocket('/ws', ws => ws.close({ code: 4426, reason: 'client_outdated' }))
  let loads = 0
  page.on('load', () => {
    loads++
  })
  await page.goto('/chats')
  await expect(banner(page, 'Hearth has been updated. Reload to continue.')).toBeVisible()
  await expect(page.locator('#main').getByRole('button', { name: 'Reload' })).toBeVisible()
  await expect(h1(page)).toHaveText('Chats')
  // The first document reloaded itself once; the second didn't.
  expect(loads).toBe(2)
  await expect.poll(said).toContain('Hearth has been updated. Reload to continue.')
})

test("LV-07 T21 item 4 T19 item 11: with the 4426 reload held back on Rooms (no flags poll), the paused connection's probe still reads GET /api/flags, and its 401 ends the session", async ({
  page,
  guard,
}) => {
  // As LV-05, both answers are routed, so Kelvin's real session survives.
  guard.expectResponses([{ path: '/api/flags', status: 401 }, SESSION_401])
  await page.clock.install()
  await page.routeWebSocket('/ws', ws => ws.close({ code: 4426, reason: 'client_outdated' }))
  await page.goto('/rooms')
  await expect(banner(page, 'Hearth has been updated. Reload to continue.')).toBeVisible()
  await expect(h1(page)).toHaveText('Rooms')
  await markDocument(page)
  const signedOut = {
    status: 401,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      error: 'signed_out',
      message: "You've been signed out. Sign in again to keep using Hearth.",
    }),
  }
  await page.route('**/api/flags', route => route.fulfill(signedOut))
  await page.route('**/api/session', route => route.fulfill(signedOut))

  // Paused, the client probes at a random point in the first 30 s; Rooms shows no FlagSlot, so no
  // flags poll runs, and 31 s is under the session answer's minute.
  await page.clock.runFor(31_000)
  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(h1(page)).toHaveText('Sign in to Hearth')
  expect(await isOldDocument(page)).toBe(false)
})
