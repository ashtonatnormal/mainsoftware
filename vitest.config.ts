import { defaultExclude, defineConfig } from 'vitest/config'

// One Vitest run covers every workspace and the guard tests in scripts/guards/, wherever a test sits
// in its workspace (src/, test/ or the root, such as packages/access/rules.test.ts). demo/ keeps its
// own node:test suite, which `npm test` runs after this one.
//
// The integration tests (`*.integration.test.ts`, wherever they sit in apps/*, packages/*, infra/ or
// scripts/) run only in the `integration` mode (`npm run test:integration`), because they need the
// Compose stack (`docker compose up -d --wait`): each run builds its own throwaway database and
// Valkey key prefix (apps/server/src/testing/stack.ts), so they can run one after another, one file
// at a time. `npm test` and `npm run check` leave them out, so those pass without Docker.
export default defineConfig(({ mode }) => {
  const integration = mode === 'integration'
  return {
    // apps/web resolves `@/*` through its tsconfig; the server's `#src/*` resolves from its
    // package.json `imports` map, as Node does (T2).
    resolve: { tsconfigPaths: true },
    test: integration
      ? {
          // Every file the default run leaves out as an integration test, so each test file runs in
          // one mode or the other (scripts/guards/test-modes.test.ts).
          include: [
            '{apps,packages}/*/**/*.integration.test.ts',
            'infra/**/*.integration.test.ts',
            'scripts/**/*.integration.test.ts',
          ],
          exclude: [...defaultExclude, '**/dist/**', '**/cdk.out/**'],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        }
      : {
          include: ['{apps,packages}/*/**/*.test.{ts,tsx}', 'infra/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: [...defaultExclude, '**/dist/**', '**/cdk.out/**', '**/*.integration.test.ts'],
          // The token tests read tokens.css and app.css with ?raw, which is '' unless CSS processing
          // is on for those files (T21). The pattern is matched against the module id, query
          // included, so it must allow the ?raw. The scope keeps every other test's CSS imports as
          // they are, and no Tailwind plugin runs here, so ?raw is the file as written.
          css: { include: [/apps\/web\/src\/styles\/[^/?]+\.css(?:\?|$)/] },
          // Tags on the Rule 1-9 suite (packages/access/rules.test.ts): one per rule, and on a todo
          // the kind of stage that builds it. `--tags-filter=ai` lists the AI cases.
          tags: [
            ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ name: `rule-${n}`, description: `PRD §7.2 Rule ${n}` })),
            { name: 'core', description: 'a non-AI case for a later core step' },
            { name: 'ai', description: 'a case for the AI layer (A0-A6)' },
          ],
        },
  }
})
