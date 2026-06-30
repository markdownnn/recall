import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  // Run e2e serially: each test launches a full Chrome with the WebGPU embedder, so
  // parallel workers contend for the GPU (flaky timeouts), and persistence.spec uses a
  // fixed user-data-dir that two Chrome instances cannot open at once.
  workers: 1,
  fullyParallel: false,
  // Heavy real-browser + WebGPU integration tests: running 9 of them back-to-back in one
  // suite can transiently exhaust the offscreen/GPU and time out a single capture RPC.
  // One retry absorbs that environmental flake; a real regression still fails both runs.
  retries: 1,
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
