// Scenario: a user captures an article and later searches "hormone that ruins sleep";
// the cortisol paragraph must rank first, not the tax paragraph.
// This is the product's one-line promise end to end.
// Coverage: integration (built extension loaded in Chrome; real Readability + e5 embedding + sqlite + popup). Full real path.

import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
// dist-ext/ is the production build output (vite build).
// dist/ is written by the Vite dev server (npm run dev) and must NOT be used here.
const distPath = path.resolve(dir, '../../dist-ext')

test('capture an article then recall the matching chunk', async () => {
  // Allow up to 150s: first run downloads the e5-small model (~23 MB)
  test.setTimeout(150_000)

  // Launch Chrome with the built extension loaded.
  // headless:false is required for MV3 service workers in Playwright.
  // userDataDir '' tells Playwright to use a temporary directory.
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
    ],
  })

  // Set up the service-worker listener BEFORE checking existing ones
  // so we cannot miss the event in a race.
  const swPromise = ctx.waitForEvent('serviceworker')
  const existingSw = ctx.serviceWorkers()[0]
  const sw = existingSw ?? (await swPromise)
  const extId = sw.url().split('/')[2]

  // 1. Open the article page.  The content script is injected at document_idle.
  const page = await ctx.newPage()
  await page.goto('file://' + path.resolve(dir, 'fixtures/article.html'))

  // 2. Open the popup page (extension origin, has chrome.tabs access).
  //    Popup path comes from dist/manifest.json action.default_popup.
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

  // 3. Restore the article tab as the active tab.
  //    chrome.tabs.query({active:true, currentWindow:true}) inside the popup
  //    must return the article tab, not the popup tab itself.
  //    Playwright's CDP-based click() does NOT change which tab is active,
  //    so we can still interact with popup elements while article stays active.
  await page.bringToFront()

  // 4. Click "Capture this page".  Playwright dispatches the click via CDP
  //    without focusing the popup tab, so activeTab query returns the article.
  await popup.getByText('Capture this page').click()

  // 5. Wait for capture to complete (Readability extract -> background embed+store).
  //    First run downloads the e5-small model, hence the generous timeout.
  await expect(popup.getByText('captured')).toBeVisible({ timeout: 120_000 })

  // 6. Search for the hormone-related content.
  await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
  await popup.getByPlaceholder('recall...').press('Enter')

  // 7. The cortisol paragraph must be the top-ranked result.
  const first = popup.locator('li').first()
  await expect(first).toContainText('Cortisol', { timeout: 30_000 })

  await ctx.close()
})
