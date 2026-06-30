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
  test.setTimeout(240_000) // +model warm-up before the existing manual/auto legs
  const serpHtml = fs.readFileSync(path.resolve(dir, 'fixtures/serp.html'), 'utf8')
  const articleHtml = fs.readFileSync(path.resolve(dir, 'fixtures/article.html'), 'utf8')
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

  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)
  popup.on('dialog', (d) => d.accept()) // accept the forget-warmup confirm below

  // --- Warm-up: WITHOUT this, the auto-leg's toHaveCount(0) is FALSE-GREEN. On a cold model
  // the recall returns [] because the model is still downloading and nothing has embedded yet,
  // NOT because the gate blocked the SERP. So first capture+recall a NORMAL article until it is
  // recallable (model now loaded + embedding fast), then forget it so the index is clean. After
  // this, a 0-result auto leg can ONLY mean "gate blocked", because a captured page WOULD embed
  // and be recallable in the same window. ---
  const warmUrl = 'http://serp-warm.example/article'
  const warm = await ctx.newPage()
  await warm.route(warmUrl, (route) => route.fulfill({ contentType: 'text/html', body: articleHtml }))
  await warm.goto(warmUrl)
  await warm.bringToFront()
  await popup.getByText('Capture this page').click()
  await expect(async () => {
    await popup.getByRole('searchbox').fill('hormone that ruins sleep')
    await popup.getByRole('searchbox').press('Enter')
    await expect(popup.locator('article').first()).toContainText('Cortisol', { timeout: 5_000 })
  }).toPass({ timeout: 90_000 })
  // Forget the warm page (host-scoped) so it cannot satisfy the negative assertion below, then
  // navigate it away so its dwell can't re-capture it.
  await popup.getByText("Forget this site's history").click()
  await expect(popup.getByText(/forgot everything from serp-warm\.example/i)).toBeVisible({ timeout: 10_000 })
  await warm.goto('about:blank')
  // Confirm the index is actually clean now (the warm page is gone).
  await popup.getByRole('searchbox').fill('hormone that ruins sleep')
  await popup.getByRole('searchbox').press('Enter')
  await popup.waitForTimeout(2_000)
  await expect(popup.locator('article')).toHaveCount(0)

  // --- Auto leg (negative): keep the SERP visible past the dwell window, then confirm
  // nothing was auto-captured (the gate rejected it with reason 'serp'). The model is warm, so
  // 0 results means the gate blocked it, not that nothing had time to index. ---
  await page.bringToFront()
  await page.waitForTimeout(13_000) // visible dwell (10s) + extract + send

  await popup.getByRole('searchbox').fill(query)
  await popup.getByRole('searchbox').press('Enter')
  await popup.waitForTimeout(2_000)
  await expect(popup.locator('article')).toHaveCount(0)

  // --- Manual leg (positive): explicit save bypasses the SERP soft gate. ---
  await page.bringToFront()
  await popup.getByText('Capture this page').click()
  await expect(popup.getByText(/captured|indexing/i)).toBeVisible({ timeout: 30_000 })
  await page.goto('about:blank') // stop the dwell from re-running putChunks mid-embed

  await expect(async () => {
    await popup.getByRole('searchbox').fill(query)
    await popup.getByRole('searchbox').press('Enter')
    await expect(popup.locator('article').first()).toContainText('marsupial', { timeout: 5_000 })
  }).toPass({ timeout: 90_000 })

  await ctx.close()
})
