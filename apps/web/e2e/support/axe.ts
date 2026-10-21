// axe-core in the browser (BUILD-PLAN C0.8 Done, T21 item 11, QA-10). A page passes when axe finds
// nothing serious or critical against WCAG 2.0, 2.1 and 2.2 A and AA, and nothing at all for the
// region rule (every piece of content in a landmark). Lesser findings and axe's "incomplete" list go
// to the test's report as an attachment, not a failure. axe checks 24 px targets; the house rule is
// 44 px, which checks.ts's targets44 holds instead (T21 item 11).
import { AxeBuilder } from '@axe-core/playwright'
import type { Page, TestInfo } from '@playwright/test'
import { expect } from './fixtures.ts'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

interface Finding {
  id: string
  impact?: string | null
  help: string
  nodes: { target: unknown }[]
}

const summary = (finding: Finding) =>
  `${finding.id} (${finding.impact ?? 'n/a'}): ${finding.help} at ${finding.nodes
    .map(node => JSON.stringify(node.target))
    .join(', ')}`

export async function expectAxeClean(page: Page, label: string, testInfo?: TestInfo): Promise<void> {
  // A scheme or size change starts colour transitions (on a page without reduced motion); axe reads
  // colours as they are, so it waits for them to end first.
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)))
  })
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  // axe ran and checked something, so an empty list below means something.
  expect(results.passes.length, `axe checked nothing, ${label}`).toBeGreaterThan(0)
  const serious = results.violations.filter(finding => finding.impact === 'serious' || finding.impact === 'critical')
  expect(serious.map(summary), `axe, ${label}`).toEqual([])
  const regions = await new AxeBuilder({ page }).withRules(['region']).analyze()
  expect(regions.violations.map(summary), `axe region, ${label}`).toEqual([])
  const rest = results.violations.filter(finding => !serious.includes(finding))
  if (testInfo && (rest.length > 0 || results.incomplete.length > 0)) {
    await testInfo.attach(`axe ${label}`, {
      body: JSON.stringify({ minor: rest.map(summary), incomplete: results.incomplete.map(summary) }, null, 2),
      contentType: 'application/json',
    })
  }
}
