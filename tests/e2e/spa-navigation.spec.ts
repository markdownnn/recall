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
  // -> Cortisol). Served at a real http host so a real page id is recorded. NOTE: the host
  // must NOT be a reserved/internal TLD - this spec relies on AUTO-capture, and the internal-
  // network skip gate (isInternalHost) treats `.example`/`.test`/`.local` as private and
  // silently skips AUTO-capture there (manual capture would override, but this test is auto).
  // So we use a routable public-looking host (.io). The route interception is at the CDP
  // level before DNS, so the domain need not exist.
  const articleHtml = fs.readFileSync(path.resolve(dir, 'fixtures/article.html'), 'utf8')
  const urlA = 'http://spa-test.io/a'
  const page = await ctx.newPage()
  await page.route(urlA, (route) => route.fulfill({ contentType: 'text/html', body: articleHtml }))
  await page.goto(urlA)
  await page.bringToFront()

  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)
  await page.bringToFront()

  // Deterministic auto-capture for page A. Auto-capture needs BOTH a 10s VISIBLE dwell and
  // engagement (scrolled >=50% OR short page). We keep page A the visible foreground tab for
  // a CONTINUOUS >DWELL_MS window and scroll it once - we must NOT flip to the panel during
  // this window, because searching from the panel hides page A and STARVES the visible-dwell
  // accumulation (the old, flaky interleaved pattern only ever scraped ~9s of visible time in
  // the inter-retry gaps). Only AFTER capture has fired do we search (embedding may still be
  // finishing, hence the toPass on just the search).
  await page.bringToFront()
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(13_000) // > DWELL_MS (10s); page stays visible so dwell accrues continuously
  await expect(async () => {
    await popup.bringToFront()
    await popup.getByRole('searchbox').fill('hormone that ruins sleep')
    await popup.getByRole('searchbox').press('Enter')
    await expect(popup.locator('article').first()).toContainText('Cortisol', { timeout: 5_000 })
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
  // Same deterministic dwell for the NEW virtual page. The content script's 1s poll detects
  // the urlKey change (/a -> /b), resets dwell+engagement, so a fresh continuous-visible
  // window captures page B by its OWN content -> proves the dwell reset + new-page capture.
  await page.bringToFront()
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(13_000) // poll-detect (<=1s) + > DWELL_MS, all while visible
  await expect(async () => {
    await popup.bringToFront()
    await popup.getByRole('searchbox').fill('how do plants make food from sunlight')
    await popup.getByRole('searchbox').press('Enter')
    await expect(popup.locator('article').first()).toContainText('chlorophyll', { timeout: 5_000 })
  }).toPass({ timeout: 60_000 })

  // Page A is still recallable too -> the two virtual pages are stored separately.
  await popup.bringToFront()
  await popup.getByRole('searchbox').fill('hormone that ruins sleep')
  await popup.getByRole('searchbox').press('Enter')
  await expect(popup.locator('article').first()).toContainText('Cortisol', { timeout: 5_000 })

  await ctx.close()
})
