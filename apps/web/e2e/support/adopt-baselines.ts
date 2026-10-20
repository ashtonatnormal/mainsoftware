// Adopts the visual baselines from a failing CI run (T21 item 11, D-07). Baselines come only from
// CI's runner, so a person:
// 1. downloads the check job's e2e-report artifact and unpacks it into a folder of its own;
// 2. runs `node apps/web/e2e/support/adopt-baselines.ts <that folder>`;
// 3. looks at every PNG it copied, in both themes, and commits them.
// It copies only `<name>-actual.png` files whose name is in VISUAL_SHOTS, into
// e2e/__screenshots__/visual.spec.ts/<name>.png, and says which shots it found no file for. A
// failing run writes the actual of every missing or changed shot (playwright.config.ts), so one
// artifact holds all 34 on a first run, and on a later one every shot that changed. It runs under
// plain Node 24, so its relative imports name the .ts file.
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { WEB_DIR } from './env.ts'
import { VISUAL_SHOTS } from './visual-matrix.ts'

export const BASELINE_DIR = resolve(WEB_DIR, 'e2e/__screenshots__/visual.spec.ts')

// Every file under a folder.
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

// The baseline an actual screenshot stands for, or undefined when it isn't one of VISUAL_SHOTS.
export function baselineFor(actual: string): string | undefined {
  const match = /^(.+)-actual\.png$/.exec(basename(actual))
  const name = match ? `${match[1]}.png` : undefined
  return name !== undefined && VISUAL_SHOTS.includes(name) ? name : undefined
}

function main(): void {
  const from = process.argv[2]
  if (from === undefined) {
    console.error('Usage: node apps/web/e2e/support/adopt-baselines.ts <the unpacked e2e-report folder>')
    process.exit(2)
  }
  mkdirSync(BASELINE_DIR, { recursive: true })
  const adopted = new Set<string>()
  for (const file of filesUnder(resolve(from))) {
    const name = baselineFor(file)
    if (name === undefined) continue
    if (adopted.has(name)) {
      console.error(`Two files stand for ${name}; adopt from one run's artifact only.`)
      process.exit(1)
    }
    copyFileSync(file, join(BASELINE_DIR, name))
    adopted.add(name)
  }
  const missing = VISUAL_SHOTS.filter(name => !adopted.has(name))
  console.log(`Adopted ${adopted.size} of ${VISUAL_SHOTS.length} baselines into ${BASELINE_DIR}.`)
  if (missing.length > 0) console.log(`No actual screenshot for: ${missing.join(', ')}`)
  console.log('Look at every one, in both themes, before committing them.')
}

if (import.meta.main) main()
