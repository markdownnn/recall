import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/core/**/*.test.ts', 'tests/core/**/*.node.test.ts'],
    testTimeout: 120_000,
  },
})
