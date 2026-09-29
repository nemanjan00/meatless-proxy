import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['packages/web/**', '**/node_modules/**'],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      ...(existsSync('packages/web/vitest.config.ts') ? ['packages/web'] : []),
    ],
  },
})
