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
  },
})
