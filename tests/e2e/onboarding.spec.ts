// Scenario: a user installs Recall; the welcome/onboarding tab must render the
// brand, an example "search by meaning" chip, the sample result card, and the
// "open the side panel" instruction so the first-run page is not blank/broken.
// Coverage: integration (built extension loaded in Chrome; real CRXJS-emitted
// onboarding page rendered by Preact). The auto-open-on-install trigger itself is
// build/eyeball-verified - asserting it deterministically across a fresh-profile
// launch is flaky, so this test loads the emitted page by URL instead.

import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

test('onboarding page renders key content', async () => {
  test.setTimeout(60_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
    ],
  })

  // Resolve the extension id from its service worker.
  const swPromise = ctx.waitForEvent('serviceworker')
  const existingSw = ctx.serviceWorkers()[0]
  const sw = existingSw ?? (await swPromise)
  const extId = sw.url().split('/')[2]

  const page = await ctx.newPage()
  await page.goto(`chrome-extension://${extId}/src/ui/onboarding/index.html`)

  // Brand.
  await expect(page.getByText('Recall', { exact: true })).toBeVisible({ timeout: 10_000 })
  // One example chip.
  await expect(page.getByText('that article about sleep and cortisol')).toBeVisible()
  // Sample result card mock - title is a link (the chip text is a separate element).
  await expect(page.getByRole('link', { name: 'How photosynthesis works' })).toBeVisible()
  await expect(page.getByText('wikipedia.org', { exact: false })).toBeVisible()
  // Side panel instruction.
  await expect(page.getByText('side panel', { exact: false })).toBeVisible()

  await ctx.close()
})
