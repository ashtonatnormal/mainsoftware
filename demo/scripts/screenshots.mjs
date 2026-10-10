// Screenshot helper for the demo.
// Usage:
//   node scripts/screenshots.mjs --name today --route '{"name":"today"}'
//   node scripts/screenshots.mjs --name room --route '{"name":"rooms","roomId":"r_ops"}' --before 'h.joinRoom("r_ops")' --wait 1500
//   options: --viewport phone|desktop|both (default both)  --scheme light|dark|both (default both)
//            --onboarding (don't skip first-run)  --after 'js'  (runs after navigation, e.g. clicks)
// Writes shots/<name>-<viewport>-<scheme>.png and prints console errors. Run `npx vite build` first.
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { chromium } from 'playwright'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true])
  return acc
}, []))
const name = args.name || 'shot'
const route = args.route ? JSON.parse(args.route) : { name: 'today' }
const viewports = { phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } }
const vpList = args.viewport && args.viewport !== 'both' ? [args.viewport] : ['phone', 'desktop']
const schemes = args.scheme && args.scheme !== 'both' ? [args.scheme] : ['light', 'dark']

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
const server = createServer(async (req, res) => {
  const path = join('dist', decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]).replace(/\/$/, '/index.html'))
  try { res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }); res.end(await readFile(path)) }
  catch { res.writeHead(404); res.end('not found') }
})
await new Promise(r => server.listen(0, r))
const port = server.address().port
await mkdir('shots', { recursive: true })

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
let failures = 0
for (const vp of vpList) for (const scheme of schemes) {
  const ctx = await browser.newContext({ ...viewports[vp], colorScheme: scheme, timezoneId: 'Asia/Singapore' })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', m => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()))
  page.on('requestfailed', r => !/fonts\.(googleapis|gstatic)\.com/.test(r.url()) && errors.push(`request failed: ${r.url()}`))
  page.on('pageerror', e => errors.push(String(e)))
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort())
  if (!args.onboarding) await page.addInitScript(() => { try { localStorage.setItem('hearth-demo', JSON.stringify({ onboarded: true })) } catch {} })
  await page.goto(`http://127.0.0.1:${port}/index.html`)
  await page.waitForFunction(() => window.__hearth)
  if (args.before) await page.evaluate(code => { const h = window.__hearth; return eval(code) }, args.before)
  await page.evaluate(r => window.__hearth.navigate(r), route)
  await page.waitForTimeout(400)
  if (args.after) { await page.evaluate(code => { const h = window.__hearth; return eval(code) }, args.after); await page.waitForTimeout(300) }
  if (args.wait) await page.waitForTimeout(Number(args.wait))
  const file = `shots/${name}-${vp}-${scheme}.png`
  await page.screenshot({ path: file, fullPage: false })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
  console.log(`${file}${overflow ? '  ⚠ horizontal overflow' : ''}${errors.length ? `  ✖ ${errors.length} console error(s):\n    ${errors.join('\n    ')}` : ''}`)
  if (errors.length || overflow) failures++
  await ctx.close()
}
await browser.close()
server.close()
process.exit(failures ? 1 : 0)
