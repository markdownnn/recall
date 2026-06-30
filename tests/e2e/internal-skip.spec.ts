import { test, expect, chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

// Scenario: a page served from a private-IP host (10.0.0.5) must NOT be auto-captured -
// it is an internal/intranet page, not public content. Under Option A an EXPLICIT manual
// save of it still works.
// Coverage: integration (built extension, real content-script -> offscreen -> gate path).
test('internal host is skipped by auto-capture but savable manually', async () => {
  test.setTimeout(180_000) // +model warm-up before the existing auto/manual legs

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  // Read the article fixture and serve it at a private-IP host via Playwright route
  // interception. Route is intercepted at the CDP level before DNS, so 10.0.0.5 does not
  // need to resolve and the content script (matches <all_urls>) still injects on it.
  const articleHtml = fs.readFileSync(path.resolve(dir, 'fixtures/article.html'), 'utf8')
  const internalUrl = 'http://10.0.0.5/article'

  const articlePage = await ctx.newPage()
  await articlePage.route(internalUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: articleHtml }),
  )
  await articlePage.goto(internalUrl)

  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)
  popup.on('dialog', (d) => d.accept()) // accept the forget-warmup confirm below

  // --- Warm-up: WITHOUT this, the auto-leg's toHaveCount(0) is FALSE-GREEN. On a cold model
  // recall returns [] because nothing has embedded yet, NOT because the gate blocked the
  // internal host. Capture+recall a NORMAL article (on a PUBLIC host so the gate allows it)
  // until recallable, then forget it so the index is clean. After this, a 0-result auto leg
  // can ONLY mean "gate blocked". The warm article is the SAME cortisol fixture, so it is
  // forgotten before the negative 'hormone that ruins sleep' query runs. ---
  const warmUrl = 'http://internal-warm.example/article'
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
  await popup.getByText("Forget this site's history").click()
  await expect(popup.getByText(/forgot everything from internal-warm\.example/i)).toBeVisible({ timeout: 10_000 })
  await warm.goto('about:blank')
  // Confirm the index is clean (warm page gone) before the negative auto-leg assertion.
  await popup.getByRole('searchbox').fill('hormone that ruins sleep')
  await popup.getByRole('searchbox').press('Enter')
  await popup.waitForTimeout(2_000)
  await expect(popup.locator('article')).toHaveCount(0)

  // AUTO leg (negative): wait PAST the 10s dwell window, then recall -> nothing, because
  // the gate rejected the internal host with reason 'internal'. The model is warm, so 0
  // results means the gate blocked it, not that nothing had time to index.
  await articlePage.bringToFront()
  await popup.waitForTimeout(13_000)
  await popup.getByRole('searchbox').fill('hormone that ruins sleep')
  await popup.getByRole('searchbox').press('Enter')
  await popup.waitForTimeout(2_000)
  await expect(popup.locator('article')).toHaveCount(0)

  // MANUAL leg (Option A): an explicit save of the same internal page DOES work.
  await articlePage.bringToFront()
  await popup.getByText('Capture this page').click()
  await expect(popup.getByText(/captured|indexing/i)).toBeVisible({ timeout: 30_000 })
  await articlePage.goto('about:blank')
  await expect(async () => {
    await popup.getByRole('searchbox').fill('hormone that ruins sleep')
    await popup.getByRole('searchbox').press('Enter')
    await expect(popup.locator('article').first()).toContainText('Cortisol', { timeout: 5_000 })
  }).toPass({ timeout: 90_000 })

  await ctx.close()
})
