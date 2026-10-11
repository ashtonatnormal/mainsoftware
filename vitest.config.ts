import { defaultExclude, defineConfig } from 'vitest/config'

// One Vitest run covers every workspace and the guard tests in scripts/guards/. demo/ keeps its
// own node:test suite, which `npm test` runs after this one.
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.{ts,tsx}', 'infra/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: [...defaultExclude, '**/dist/**', '**/cdk.out/**'],
  },
})
