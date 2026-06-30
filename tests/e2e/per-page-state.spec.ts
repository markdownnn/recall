import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

// Two distinct routed http pages so each has a real, capturable host + the <all_urls> content
// script. Manual "Capture this page" bypasses the thin-page gate, so short bodies are fine.
const A_HTML = `<!doctype html><html><head><title>Page A about cortisol</title></head>
<body><article><p>Cortisol is a stress hormone made by the adrenal glands. It follows a
daily rhythm, high in the morning and falling at night so melatonin can rise.</p></article></body></html>`

const B_HTML = `<!doctype html><html><head><title>Page B about plants</title></head>
<body><article><p>Photosynthesis is how a green plant makes its own food from sunlight using
chlorophyll inside the leaves to join water and carbon dioxide into sugar.</p></article></body></html>`

// Scenario: a user saves page A, then switches to a fresh page B. The "this page" bar must show
// B's OWN state (not saved) instantly - it must NEVER keep showing A's "saved"/"Saving..." after
// the switch. Switching back to A must restore A's saved state. This proves the per-page save
// state is a clean function of the ACTIVE tab, with zero carryover between tabs.
// Coverage: integration (built extension; real capture + has-page/page-pending per active tab).
test('save state follows the active tab with no stale carryover', async () => {
  test.setTimeout(120_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  const aUrl = 'http://per-page-a.example/a'
  const pageA = await ctx.newPage()
  await pageA.route(aUrl, (r) => r.fulfill({ contentType: 'text/html', body: A_HTML }))
  await pageA.goto(aUrl)

  const bUrl = 'http://per-page-b.example/b'
  const pageB = await ctx.newPage()
  await pageB.route(bUrl, (r) => r.fulfill({ contentType: 'text/html', body: B_HTML }))
  await pageB.goto(bUrl)

  const panel = await ctx.newPage()
  await panel.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)
  const captureBtn = panel.locator('button.capture')

  // Save page A: the button leaves "Capture this page" for "Saving..." (or "Update this page"
  // if it embedded fast). A is now saved/saving.
  await pageA.bringToFront()
  await panel.getByText('Capture this page').click()
  await expect(captureBtn).toHaveText(/Saving\.\.\.|Update this page/, { timeout: 30_000 })

  // Switch to the FRESH page B. The bar must immediately reflect B's own state: NOT saved.
  // If the previous tab's state leaked, the button would still read "Saving..."/"Update this
  // page" and the badge "saved" - the exact stale-carryover bug this guards against.
  await pageB.bringToFront()
  await expect(captureBtn).toHaveText('Capture this page', { timeout: 10_000 })
  await expect(panel.getByText('not saved yet')).toBeVisible({ timeout: 10_000 })

  // Switch back to A: its saved state must return (state follows whichever tab is active).
  await pageA.bringToFront()
  await expect(captureBtn).toHaveText(/Saving\.\.\.|Update this page/, { timeout: 10_000 })

  await ctx.close()
})
