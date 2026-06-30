import { test, expect, chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

// Scenario: a Google results page must NOT be auto-captured (it is a navigational link
// list, not an article) even after the full dwell window, but an EXPLICIT manual save of
// it still works. This proves the SERP soft gate end to end in the built extension:
// content-script -> offscreen -> CaptureGate with the new 'serp' reason, auto-only.
// Coverage: integration (built extension; real content-script dwell + gate; the SERP url
//   is routed to a deterministic results-style fixture so location.href reads as the real
//   google.com/search host/path that isSerp parses).
test('SERP is skipped by auto-capture but savable manually', async () => {
  test.setTimeout(180_000)
  const serpHtml = fs.readFileSync(path.resolve(dir, 'fixtures/serp.html'), 'utf8')
  const serpUrl = 'https://www.google.com/search?q=marsupial+gestation'
  const query = 'how long do marsupials gestate in the pouch'

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  const page = await ctx.newPage()
  await page.route(serpUrl, (route) => route.fulfill({ contentType: 'text/html', body: serpHtml }))
  await page.goto(serpUrl)
  await page.bringToFront()

  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

  // --- Auto leg (negative): keep the SERP visible past the dwell window, then confirm
  // nothing was auto-captured (the gate rejected it with reason 'serp'). ---
  await page.bringToFront()
  await page.waitForTimeout(13_000) // visible dwell (10s) + extract + send

  await popup.getByPlaceholder('recall...').fill(query)
  await popup.getByPlaceholder('recall...').press('Enter')
  await popup.waitForTimeout(2_000)
  await expect(popup.locator('article')).toHaveCount(0)

  // --- Manual leg (positive): explicit save bypasses the SERP soft gate. ---
  await page.bringToFront()
  await popup.getByText('Capture this page').click()
  await expect(popup.getByText(/captured|indexing/i)).toBeVisible({ timeout: 30_000 })
  await page.goto('about:blank') // stop the dwell from re-running putChunks mid-embed

  await expect(async () => {
    await popup.getByPlaceholder('recall...').fill(query)
    await popup.getByPlaceholder('recall...').press('Enter')
    await expect(popup.locator('article').first()).toContainText('marsupial', { timeout: 5_000 })
  }).toPass({ timeout: 90_000 })

  await ctx.close()
})
