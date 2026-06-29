import { test, expect, chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

// Scenario: "Forget this site's history" must actually DELETE the captured pages +
// chunks for the site (the user's right to be forgotten) via the real delete SQL path,
// not just show a popup message. Capture a site, confirm it's recallable, forget it,
// then confirm it's gone.
// Coverage: integration (real extension; capture -> index -> forget -> search empty).
test('forget this site deletes its captured history', async () => {
  test.setTimeout(120_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  // Serve the article at a real http host so the gate/store record a real hostname.
  const articleHtml = fs.readFileSync(path.resolve(dir, 'fixtures/article.html'), 'utf8')
  const url = 'http://forget-test.example/article'
  const articlePage = await ctx.newPage()
  await articlePage.route(url, (route) => route.fulfill({ contentType: 'text/html', body: articleHtml }))
  await articlePage.goto(url)

  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)
  await articlePage.bringToFront()

  // Capture the page and wait until it is indexed + recallable.
  await popup.getByText('Capture this page').click()
  await expect(async () => {
    await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
    await popup.getByPlaceholder('recall...').press('Enter')
    await expect(popup.locator('li').first()).toContainText('Cortisol', { timeout: 5_000 })
  }).toPass({ timeout: 60_000 })

  // Forget this site's history. The popup awaits the full round-trip
  // (popup -> SW -> offscreen -> deletePagesByHost) before showing the confirmation.
  await popup.getByText("Forget this site's history").click()
  await expect(popup.getByText(/forgot everything from forget-test\.example/i)).toBeVisible({ timeout: 10_000 })

  // Search again -> the page + chunks are gone -> no results.
  await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
  await popup.getByPlaceholder('recall...').press('Enter')
  await popup.waitForTimeout(2_000)
  await expect(popup.locator('li')).toHaveCount(0)

  await ctx.close()
})
