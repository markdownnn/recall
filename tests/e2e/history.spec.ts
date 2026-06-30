import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

// Two SHORT, distinct articles (< 100 words). Thin pages are blocked by the auto-capture
// soft gate but MANUAL "Capture this page" bypasses it, so only the test's deterministic
// captures exist (no dwell auto-capture races the browse). Distinct titles let us assert
// newest-first ordering by title.
const CORTISOL_HTML = `<!doctype html><html><head><title>Sleep and cortisol</title></head>
<body><article><p>Cortisol is a stress hormone made by the adrenal glands. It follows a
daily rhythm, high in the morning and falling at night so melatonin can rise and bring
sleep, which is the hormone problem that ruins sleep.</p></article></body></html>`

const PLANTS_HTML = `<!doctype html><html><head><title>How plants make food</title></head>
<body><article><p>Photosynthesis is how a green plant makes its own food from sunlight. A
green pigment called chlorophyll inside the leaves catches the light energy and joins water
and carbon dioxide into sugar, releasing oxygen.</p></article></body></html>`

// Scenario: a user captures two pages, opens History, and sees both newest-first; clicking
// a row opens that page. This is the browse-my-memory payoff, distinct from Search.
// Coverage: integration (built extension; real capture + offscreen recent-pages + panel render).
test('History tab lists captured pages newest-first with working links', async () => {
  test.setTimeout(120_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  // First capture: cortisol (older).
  const cortisolUrl = 'http://history-test.example/cortisol'
  const cortisol = await ctx.newPage()
  await cortisol.route(cortisolUrl, (r) => r.fulfill({ contentType: 'text/html', body: CORTISOL_HTML }))
  await cortisol.goto(cortisolUrl)

  // Second capture: plants (newer).
  const plantsUrl = 'http://history-test.example/plants'
  const plants = await ctx.newPage()
  await plants.route(plantsUrl, (r) => r.fulfill({ contentType: 'text/html', body: PLANTS_HTML }))
  await plants.goto(plantsUrl)

  const panel = await ctx.newPage()
  await panel.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)

  // Capture cortisol first (older), then plants (newer), so plants sorts to the top.
  await cortisol.bringToFront()
  await panel.getByText('Capture this page').click()
  await expect(panel.getByText('captured', { exact: false })).toBeVisible({ timeout: 30_000 })

  await plants.bringToFront()
  await panel.getByText('Capture this page').click()
  await expect(panel.getByText('captured', { exact: false })).toBeVisible({ timeout: 30_000 })

  // Open the History tab (the second tab the scaffold now renders).
  await panel.getByRole('tab', { name: 'History' }).click()

  // Both titles appear, plants (newer) above cortisol (older).
  const rows = panel.locator('article')
  await expect(rows).toHaveCount(2, { timeout: 10_000 })
  await expect(rows.nth(0)).toContainText('How plants make food')
  await expect(rows.nth(1)).toContainText('Sleep and cortisol')

  // The newest row's link points at the captured page url (clicking it opens that page).
  await expect(rows.nth(0).locator('a')).toHaveAttribute('href', plantsUrl)

  await ctx.close()
})
