// Scenario: a side-panel migration is planned. Before committing, prove the uncertain
// side-panel mechanics work from a side-panel-ORIGIN page: messaging to the SW (model
// status + recall), chrome.tabs.query returning the active CONTENT tab (active-tab
// reactivity crux), and a capture round-trip that stores the active article.
// The panel page is opened as an ordinary tab (Playwright cannot drive a real Chrome side
// panel); it is still an extension-origin page with chrome.tabs access - identical to how
// the popup page is driven. The sidePanel.open plumbing itself is build- + manual-verified.
// Coverage: integration (built extension loaded in Chrome; real content tab + offscreen
// pipeline + side-panel-origin page).

import { test, expect, chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

test('side panel page: active-tab host + capture + recall round-trip', async () => {
  // First run downloads the e5-small model (~23 MB) then indexes.
  test.setTimeout(270_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const swPromise = ctx.waitForEvent('serviceworker')
  const existingSw = ctx.serviceWorkers()[0]
  const sw = existingSw ?? (await swPromise)
  const extId = sw.url().split('/')[2]

  // Serve the article fixture at a real http hostname so the active tab has a non-empty
  // host the panel can show (file:// pages have host=''). Routing is intercepted at the
  // CDP level, so the domain need not resolve.
  const articleHtml = fs.readFileSync(path.resolve(dir, 'fixtures/article.html'), 'utf8')
  const articleUrl = 'http://panel-spike.example/article'

  const articlePage = await ctx.newPage()
  await articlePage.route(articleUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: articleHtml }),
  )
  await articlePage.goto(articleUrl)

  // Open the SIDE PANEL page as a normal tab (extension origin, has chrome.tabs access).
  const panel = await ctx.newPage()
  await panel.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)

  // Keep the article tab active so chrome.tabs.query({active,currentWindow}) inside the
  // panel returns the ARTICLE tab, not the panel tab itself. Playwright's CDP click does
  // not change the active tab, so we can still click panel controls.
  await articlePage.bringToFront()

  // PROOF (uncertainty #3): the panel's "this page" line shows the active CONTENT tab's
  // host - so tabs.query from the panel returns the content tab, and the on-activated /
  // on-mount refresh wired it up. toPass absorbs the brief async query.
  await expect(async () => {
    await expect(panel.locator('.thispage')).toContainText('panel-spike.example', { timeout: 2_000 })
  }).toPass({ timeout: 15_000 })

  // PROOF (uncertainty #4): capture round-trip from the panel page. Click "Capture this
  // page" -> panel asks the active content tab to extract-and-capture.
  await panel.getByText('Capture this page').click()
  await expect(panel.getByText('captured', { exact: false })).toBeVisible({ timeout: 30_000 })

  // Navigate the article away so the dwell auto-capture cannot re-run mid-embed (the
  // documented persistence-race fix). Then retry only the search while indexing finishes.
  await articlePage.goto('about:blank')

  // PROOF (uncertainty #2): recall round-trip from the panel page. Search via the SW and
  // render an <article> card. The recall message + model-status query both prove panel
  // -> SW messaging works.
  await expect(async () => {
    await panel.getByRole('searchbox').fill('hormone that ruins sleep')
    await panel.getByRole('searchbox').press('Enter')
    await expect(panel.locator('article').first()).toContainText('Cortisol', { timeout: 5_000 })
  }).toPass({ timeout: 200_000 })

  await ctx.close()
})
