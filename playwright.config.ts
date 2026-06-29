import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  // globalSetup runs before the webServer so the production extension is
  // built into dist-ext/ before npm run dev can write dev-mode stubs to dist/.
  globalSetup: './tests/global-setup.ts',
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
  use: { baseURL: 'http://localhost:5173' },
})
