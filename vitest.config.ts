import { defaultExclude, defineConfig } from 'vitest/config'

// One Vitest run covers every workspace and the guard tests in scripts/guards/, wherever a test sits
// in its workspace (src/, test/ or the root, such as packages/access/rules.test.ts). demo/ keeps its
// own node:test suite, which `npm test` runs after this one.
export default defineConfig({
  // Each file resolves `@/*` through its own app's tsconfig, so `@/` is apps/server/src in the
  // server and apps/web/src in the web app.
  resolve: { tsconfigPaths: true },
  test: {
    include: ['{apps,packages}/*/**/*.test.{ts,tsx}', 'infra/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: [...defaultExclude, '**/dist/**', '**/cdk.out/**'],
  },
})
