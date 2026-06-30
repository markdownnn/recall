import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

// Two SHORT articles (< 100 words each). Short content is blocked by the thin-page soft
// gate on AUTO-capture, but MANUAL "Capture this page" bypasses the soft gate. So only
// the test's deterministic manual captures exist -> no dwell auto-capture races the
// forget delete. Each stays semantically distinct so it is independently recallable.
const CORTISOL_HTML = `<!doctype html><html><head><title>Sleep and cortisol</title></head>
<body><article><p>Cortisol is a stress hormone made by the adrenal glands. It follows a
daily rhythm, high in the morning and falling at night so melatonin can rise and bring
sleep. When stress or late screen light keeps cortisol high in the evening it blocks
melatonin, and that is the hormone problem that ruins sleep, causing trouble falling
asleep and waking through the night.</p></article></body></html>`

const PLANTS_HTML = `<!doctype html><html><head><title>How plants make food</title></head>
<body><article><p>Photosynthesis is how a green plant makes its own food from sunlight. A
green pigment called chlorophyll inside the leaves catches the light energy. The plant
takes in water through its roots and carbon dioxide from the air, then joins them into
sugar using that captured energy. As a side effect it releases the oxygen that people and
animals breathe.</p></article></body></html>`

// Scenario: "Forget this site's history" must delete the captured pages + chunks for the
// site via the real delete SQL path. It must cover BOTH the exact-host branch (the apex)
// AND the subdomain branch (`LIKE '%.'||host`), and it must go through the confirm dialog.
// Coverage: integration (real extension; capture apex + subdomain -> forget parent -> both gone).
test('forget this site deletes apex + subdomain captured history', async () => {
  test.setTimeout(120_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  // Apex page (forget-test.example) -> cortisol article.
  const apexUrl = 'http://forget-test.example/article'
  const apex = await ctx.newPage()
  await apex.route(apexUrl, (route) => route.fulfill({ contentType: 'text/html', body: CORTISOL_HTML }))
  await apex.goto(apexUrl)

  // Subdomain page (sub.forget-test.example) -> plants article (distinct content).
  const subUrl = 'http://sub.forget-test.example/article'
  const sub = await ctx.newPage()
  await sub.route(subUrl, (route) => route.fulfill({ contentType: 'text/html', body: PLANTS_HTML }))
  await sub.goto(subUrl)

  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)
  // Accept the destructive-forget confirmation dialog (raised in the popup page).
  popup.on('dialog', (d) => d.accept())

  // Capture the apex page and wait until it is recallable.
  await apex.bringToFront()
  await popup.getByText('Capture this page').click()
  await expect(async () => {
    await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
    await popup.getByPlaceholder('recall...').press('Enter')
    await expect(popup.locator('article').first()).toContainText('Cortisol', { timeout: 5_000 })
  }).toPass({ timeout: 60_000 })

  // Capture the subdomain page and wait until ITS content is recallable.
  await sub.bringToFront()
  await popup.getByText('Capture this page').click()
  await expect(async () => {
    await popup.getByPlaceholder('recall...').fill('how do plants make food from sunlight')
    await popup.getByPlaceholder('recall...').press('Enter')
    await expect(popup.locator('article').first()).toContainText('chlorophyll', { timeout: 5_000 })
  }).toPass({ timeout: 60_000 })

  // Forget from the apex tab -> host = forget-test.example. This must delete the apex
  // (exact branch) AND sub.forget-test.example (LIKE '%.'||host subdomain branch).
  await apex.bringToFront()
  await popup.getByText("Forget this site's history").click()
  await expect(popup.getByText(/forgot everything from forget-test\.example/i)).toBeVisible({ timeout: 10_000 })

  // Apex content gone.
  await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
  await popup.getByPlaceholder('recall...').press('Enter')
  await popup.waitForTimeout(2_000)
  await expect(popup.locator('article')).toHaveCount(0)

  // Subdomain content gone too (proves the LIKE subdomain delete branch).
  await popup.getByPlaceholder('recall...').fill('how do plants make food from sunlight')
  await popup.getByPlaceholder('recall...').press('Enter')
  await popup.waitForTimeout(2_000)
  await expect(popup.locator('article')).toHaveCount(0)

  await ctx.close()
})
