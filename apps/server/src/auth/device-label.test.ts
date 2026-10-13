import { describe, expect, it } from 'vitest'
import { deviceLabel } from '#src/auth/device-label.ts'

const AGENTS: [string, string][] = [
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    'iPhone · Safari',
  ],
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1',
    'iPhone · Chrome',
  ],
  [
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
    'Android · Chrome',
  ],
  [
    'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    'Android · Samsung Internet',
  ],
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
    'Mac · Safari',
  ],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:141.0) Gecko/20100101 Firefox/141.0', 'Mac · Firefox'],
  [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
    'Windows · Edge',
  ],
  [
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    'Chromebook · Chrome',
  ],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0', 'Linux · Firefox'],
  ['', 'Device · Browser'],
  ['curl/8.5.0', 'Device · Browser'],
]

describe('ACC-04 naming a device from its User-Agent', () => {
  it.each(AGENTS)('%s → %s', (agent, label) => {
    expect(deviceLabel(agent)).toBe(label)
  })

  it('names a request with no User-Agent', () => {
    expect(deviceLabel(undefined)).toBe('Device · Browser')
  })
})
