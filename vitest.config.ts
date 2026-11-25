import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const specs = ['tests/**/*.spec.ts']
const nodeOnlySpecs = ['tests/node-exit.spec.ts']

export const shared = {
  // A spec run under every order takes as long as there are orders: a minute is for one that never comes to
  // rest, not for one that is slow.
  testTimeout: 60_000,
} as const

/** The specs in Node: what runs on three systems. */
export const node = { extends: true as const, test: { name: 'node', include: specs } }
/** In-process Node specs used for mutation testing (excludes child-process exit specs that bypass Stryker's sandbox). */
export const nodeMutants = { extends: true as const, test: { name: 'node', include: specs, exclude: nodeOnlySpecs } }

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
          exclude: nodeOnlySpecs,
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
