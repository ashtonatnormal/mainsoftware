// A small TCP proxy for the integration tests (test-only; the image leaves testing/ out), standing in
// for the network between a process and the Compose stack's Postgres or Valkey (factored out of
// db/pool.integration.test.ts for C0.7's gateway suite). A client connects to it on 127.0.0.1, and
// each connection (a link) is forwarded to the target. A test can then:
//   - freeze() every link open now: nothing more is forwarded either way, not even a close, as with
//     a failover or a dropped path, where the peer just goes silent. Links made later forward as
//     before, unless held: freeze({ hold: true }) holds them silent too, until restore();
//   - cut() every link (both sides destroyed) and refuse new ones (each is closed at once), as with a
//     server that is down;
//   - restore(): new links forward again, and every frozen link is destroyed, since what it dropped
//     can't be sent again (its client sees the connection close, and makes a new one).
import { createServer, type Server, type Socket, connect as tcpConnect } from 'node:net'

interface Link {
  client: Socket
  upstream: Socket
  frozen: boolean
}

export interface TcpProxy {
  // The local port it listens on.
  readonly port: number
  // How many links it has accepted, closed ones included.
  opened(): number
  freeze(options?: { hold?: boolean }): void
  cut(): void
  restore(): void
  // Destroys every link and stops listening.
  close(): Promise<void>
}

export async function startProxy(target: { host: string; port: number }): Promise<TcpProxy> {
  const links = new Set<Link>()
  let opened = 0
  let holding = false
  let refusing = false
  const destroy = (link: Link) => {
    link.client.destroy()
    link.upstream.destroy()
    links.delete(link)
  }
  const server: Server = createServer(client => {
    opened++
    client.on('error', () => {})
    if (refusing) {
      client.destroy()
      return
    }
    const upstream = tcpConnect(target.port, target.host)
    upstream.on('error', () => {})
    const link: Link = { client, upstream, frozen: holding }
    links.add(link)
    client.on('data', chunk => {
      if (!link.frozen) upstream.write(chunk)
    })
    upstream.on('data', chunk => {
      if (!link.frozen) client.write(chunk)
    })
    // A side that closes closes the other, unless the link is frozen: a silent peer sends nothing,
    // not even its close.
    client.on('close', () => {
      upstream.destroy()
      links.delete(link)
    })
    upstream.on('close', () => {
      if (!link.frozen) {
        client.destroy()
        links.delete(link)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the proxy has no port')
  return {
    port: address.port,
    opened: () => opened,
    freeze(options = {}) {
      for (const link of links) link.frozen = true
      if (options.hold === true) holding = true
    },
    cut() {
      refusing = true
      for (const link of [...links]) destroy(link)
    },
    restore() {
      refusing = false
      holding = false
      for (const link of [...links]) if (link.frozen) destroy(link)
    },
    async close() {
      refusing = true
      for (const link of [...links]) destroy(link)
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
