import { defaultExclude, defineConfig } from 'vitest/config'

// One Vitest run covers every workspace and the guard tests in scripts/guards/, wherever a test sits
// in its workspace (src/, test/ or the root, such as packages/access/rules.test.ts). demo/ keeps its
// own node:test suite, which `npm test` runs after this one.
export default defineConfig({
  // apps/web resolves `@/*` through its tsconfig; the server's `#src/*` resolves from its
  // package.json `imports` map, as Node does (T2).
  resolve: { tsconfigPaths: true },
  test: {
    include: ['{apps,packages}/*/**/*.test.{ts,tsx}', 'infra/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: [...defaultExclude, '**/dist/**', '**/cdk.out/**'],
    // Tags on the Rule 1-9 suite (packages/access/rules.test.ts): one per rule, and on a todo the
    // kind of stage that builds it. `--tags-filter=ai` lists the AI cases.
    tags: [
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ name: `rule-${n}`, description: `PRD §7.2 Rule ${n}` })),
      { name: 'core', description: 'a non-AI case for a later core step' },
      { name: 'ai', description: 'a case for the AI layer (A0-A6)' },
    ],
  },
})
