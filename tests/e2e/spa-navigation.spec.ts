import { test, expect, chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

// Scenario: in a Single-Page App the URL changes via history.pushState WITHOUT a
// page reload, so the content script is never re-injected  -  the same instance must
// notice the virtual navigation (its 1s poll compares the hash-stripped URL key),
// reset the dwell timer, and auto-capture the NEW virtual page after a fresh dwell.
// This proves the SPA wiring in content/capture.ts (urlKey + poll + reset), which is
// otherwise only covered at the pure DwellTracker unit level.
// Coverage: integration (real extension; pushState nav + DOM swap -> two captures).
test('SPA pushState navigation resets dwell and captures the new virtual page', async () => {
  test.setTimeout(120_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  // Page A is the existing article fixture (recallable via "hormone that ruins sleep"
  // -> Cortisol). Served at a real http host so a real page id is recorded.
  const articleHtml = fs.readFileSync(path.resolve(dir, 'fixtures/article.html'), 'utf8')
  const urlA = 'http://spa-test.example/a'
  const page = await ctx.newPage()
  await page.route(urlA, (route) => route.fulfill({ contentType: 'text/html', body: articleHtml }))
  await page.goto(urlA)
  await page.bringToFront()

  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)
  await page.bringToFront()

  // Wait out the 10s visible dwell -> page A auto-captures and becomes recallable.
  await expect(async () => {
    await popup.bringToFront()
    await popup.getByRole('searchbox').fill('hormone that ruins sleep')
    await popup.getByRole('searchbox').press('Enter')
    await expect(popup.locator('article').first()).toContainText('Cortisol', { timeout: 5_000 })
    await page.bringToFront()
  }).toPass({ timeout: 60_000 })

  // SPA navigation: change the URL via pushState (no reload) AND swap in new content,
  // exactly as a client-side router would. The content script instance is unchanged.
  await page.evaluate(() => {
    const body = `
      <article>
        <h1>How plants make food from sunlight</h1>
        <p>Photosynthesis is the process a green plant uses to turn sunlight into food.
        Inside the leaves sits a green pigment called chlorophyll, and chlorophyll is the
        part that grabs the energy in light. The plant pulls in water through its roots and
        carbon dioxide from the air through tiny holes in its leaves.</p>
        <p>Using the captured light energy, the plant joins the water and the carbon dioxide
        together to build sugar, which is the food it lives on. As a side effect it releases
        oxygen back into the air, which is the oxygen that animals and people breathe. So a
        single leaf is a tiny solar-powered kitchen that feeds the whole plant and quietly
        cleans the air at the same time.</p>
      </article>`
    document.title = 'How plants make food'
    document.body.innerHTML = body
    history.pushState({}, '', '/b')
  })
  await page.bringToFront()

  // After a fresh 10s dwell on the new virtual page, page B auto-captures and is
  // recallable by ITS content -> proves the dwell reset + new-page capture.
  await expect(async () => {
    await popup.bringToFront()
    await popup.getByRole('searchbox').fill('how do plants make food from sunlight')
    await popup.getByRole('searchbox').press('Enter')
    await expect(popup.locator('article').first()).toContainText('chlorophyll', { timeout: 5_000 })
    await page.bringToFront()
  }).toPass({ timeout: 60_000 })

  // Page A is still recallable too -> the two virtual pages are stored separately.
  await popup.bringToFront()
  await popup.getByRole('searchbox').fill('hormone that ruins sleep')
  await popup.getByRole('searchbox').press('Enter')
  await expect(popup.locator('article').first()).toContainText('Cortisol', { timeout: 5_000 })

  await ctx.close()
})
