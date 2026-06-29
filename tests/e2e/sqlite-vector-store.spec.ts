import { test, expect } from '@playwright/test'

// Scenario: vectors stored in sqlite as BLOB must round-trip losslessly and rank the nearest chunk first,
// proving serialization correctness and the sqlite store path.
// Coverage: integration (real sqlite-wasm in a real browser). node cannot run OPFS/sqlite-wasm so Playwright is required.

// Strategy: we navigate to a Vite-served HTML fixture page whose <script type="module"> goes through
// Vite's transform pipeline, so bare specifiers like '@sqlite.org/sqlite-wasm' are resolved correctly.
// Results are written to window globals and read back here.

test('sqlite store ranks nearest chunk after round-trip', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/sqlite-test.html')

  const result = await page.waitForFunction(
    () => (window as any).__TEST_RESULT__ !== undefined || (window as any).__TEST_ERROR__ !== undefined,
    { timeout: 15000 }
  )

  const [top, err] = await page.evaluate(() => [
    (window as any).__TEST_RESULT__ as string | undefined,
    (window as any).__TEST_ERROR__ as string | undefined,
  ])

  expect(err, `sqlite test threw: ${err}`).toBeUndefined()
  expect(top).toBe('p1#0')
})
