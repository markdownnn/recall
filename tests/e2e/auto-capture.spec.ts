import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

// Scenario: a user who just READS an article (never clicks capture) must still be
// able to recall it later. Auto-capture (load -> 10s dwell -> gate -> store) is the
// core product loop; this proves it works with no manual action.
// Coverage: integration (built extension, real content-script dwell + gate + offscreen pipeline).
test('auto-captures an article after dwell, recallable without clicking', async () => {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  // Open the article and DO NOTHING — no capture click. Dwell counts VISIBLE time,
  // so keep the article tab in the foreground while it accumulates ~10s of visible
  // time and auto-captures.
  const page = await ctx.newPage()
  await page.goto('file://' + path.resolve(dir, 'fixtures/article.html'))
  await page.bringToFront()
  await page.waitForTimeout(13_000) // visible dwell (10s) + extract + send

  // Now open the popup and recall — proves the article was auto-captured + indexed.
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

  await expect(async () => {
    await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
    await popup.getByPlaceholder('recall...').press('Enter')
    await expect(popup.locator('li').first()).toContainText('Cortisol', { timeout: 5_000 })
  }).toPass({ timeout: 90_000 })

  await ctx.close()
})
