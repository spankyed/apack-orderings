import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const specs = ['tests/**/*.spec.ts']

export const shared = {
  // A spec run under every order takes as long as there are orders: a minute is for one that never comes to
  // rest, not for one that is slow.
  testTimeout: 60_000,
} as const

/** The specs in Node: what runs on three systems, and all a mutant is run against (`vitest.mutants.ts`). */
export const node = { extends: true as const, test: { name: 'node', include: specs } }

export default defineConfig({
  test: {
    ...shared,
    projects: [
      node,
      {
        extends: true,
        test: {
          name: 'browser',
          include: specs,
          fileParallelism: false,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [
              { browser: 'chromium' },
              { browser: 'firefox' },
              { browser: 'webkit' },
            ],
          },
        },
      },
    ],
  },
})
