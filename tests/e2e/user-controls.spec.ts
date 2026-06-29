import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')
const articleUrl = 'file://' + path.resolve(dir, 'fixtures/article.html')

// Scenario: pausing must stop capturing entirely (the privacy promise of the Pause
// control); unpausing must restore it. Uses manual capture for determinism (no dwell).
// Coverage: integration (built extension; real settings persistence + gate).
test('pause blocks capture; unpausing restores it', async () => {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  const page = await ctx.newPage()
  await page.goto(articleUrl)
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

  // Pause, then manual-capture -> blocked.
  await popup.getByLabel(/pause/i).check()
  await page.bringToFront()
  await popup.bringToFront()
  await popup.getByText('Capture this page').click()
  await popup.waitForTimeout(1_000)

  // Search finds nothing while paused.
  await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
  await popup.getByPlaceholder('recall...').press('Enter')
  await popup.waitForTimeout(2_000)
  await expect(popup.locator('li')).toHaveCount(0)

  // Unpause, capture -> works, recallable.
  await popup.getByLabel(/pause/i).uncheck()
  await popup.getByText('Capture this page').click()
  await expect(async () => {
    await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
    await popup.getByPlaceholder('recall...').press('Enter')
    await expect(popup.locator('li').first()).toContainText('Cortisol', { timeout: 5_000 })
  }).toPass({ timeout: 60_000 })

  await ctx.close()
})
