// Scenario: a brand-new user rides the real flow once - the onboarding try-it card seeds
// bundled sample pages through the REAL capture pipeline, then searches them with the REAL
// on-device model and sees a real result card. This is the interactive card's whole promise.
// Coverage: integration (built extension in Chrome; real capture-text -> capture-service ->
// embed -> sqlite -> recall, rendered by the real try-it card). Full real path.

import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

test('onboarding try-it card seeds samples then searches them with the real engine', async () => {
  // First run downloads the e5-small model (~23 MB) then indexes 3 docs.
  test.setTimeout(300_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  const page = await ctx.newPage()
  await page.goto(`chrome-extension://${extId}/src/ui/onboarding/index.html`)

  // The scroll page is shown; the try-it card's seed button is present. Seed the samples.
  await expect(page.getByRole('button', { name: 'Add 3 sample pages' })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Add 3 sample pages' }).click()
  // "Sample pages added" appears only after the drain broadcasts pending===0 (model download
  // happens here on first run, so allow the long budget).
  await expect(page.getByText('Sample pages added')).toBeVisible({ timeout: 240_000 })

  // The searchbox is now revealed. Run a meaning query and expect the cortisol sample.
  await page.getByRole('searchbox').fill('the hormone that ruins sleep')
  await page.getByRole('searchbox').press('Enter')

  // A REAL result card must appear, and the cortisol sample must be the match (this is the
  // assertion that used to read the static mock).
  const cards = page.locator('article')
  await expect(cards.first()).toContainText('cortisol', { timeout: 30_000 })

  // Remove the demo data in one click and confirm it clears.
  await page.getByRole('button', { name: 'Remove demo data' }).click()
  await expect(page.getByText('Demo data removed')).toBeVisible({ timeout: 10_000 })

  await ctx.close()
})
