import { test, expect, chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')
const articleUrl = 'file://' + path.resolve(dir, 'fixtures/article.html')

// Scenario: pausing must stop capturing entirely (the privacy promise of the Pause
// control); unpausing must restore it. Uses manual capture for determinism (no dwell).
// Coverage: integration (built extension; real settings persistence + gate).
test('pause blocks capture; unpausing restores it', async () => {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  const page = await ctx.newPage()
  await page.goto(articleUrl)
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)
  // Pause now lives in the Settings tab (it is a GLOBAL setting, so it has one home there).
  // Search lives in the Search tab. The Capture button is in the always-visible per-page bar,
  // so it is reachable from any tab.
  const settingsTab = popup.getByRole('tab', { name: 'Settings' })
  const searchTab = popup.getByRole('tab', { name: 'Search' })
  const pauseBox = popup.getByLabel(/pause/i)

  // The Settings tab's mount effect loads settings asynchronously (get-settings) and can reset
  // the checkbox right after a click, so toggling is retried until the new state STICKS
  // (condition-based, no fixed sleep). Open the Settings tab first so the toggle is mounted.
  const setPaused = async (on: boolean) => {
    await settingsTab.click()
    await expect(async () => {
      if (on) await pauseBox.check()
      else await pauseBox.uncheck()
      await expect(pauseBox).toBeChecked({ checked: on, timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
  }

  // Pause, then manual-capture (article tab active so the capture really reaches the
  // gate) -> blocked. Keep the article in front; the popup button is clicked from the
  // background (Playwright clicks non-active tabs fine). Do NOT bring the popup to front,
  // or the popup would read ITSELF as the active tab and the capture would target the
  // wrong tab.
  await setPaused(true)
  await page.bringToFront()
  await popup.getByText('Capture this page').click()
  await popup.waitForTimeout(1_000)

  // Search finds nothing while paused. The searchbox lives in the Search tab, so switch back
  // to it (setPaused left the Settings tab open).
  await searchTab.click()
  await popup.getByRole('searchbox').fill('hormone that ruins sleep')
  await popup.getByRole('searchbox').press('Enter')
  await popup.waitForTimeout(2_000)
  await expect(popup.locator('article')).toHaveCount(0)

  // Unpause, capture ONCE (article tab active), wait for it to land, then navigate the
  // article away so the dwell auto-capture can't re-run putChunks and wipe the chunk
  // vectors (NULL) mid-embed - that race would make recall flaky (same fix as
  // persistence.spec). Then retry only the SEARCH while indexing completes.
  await setPaused(false)
  await page.bringToFront()
  await popup.getByText('Capture this page').click()
  // Capture registered (unpaused): the button leaves "Capture this page" for "Saving..." (or
  // "Update this page" if it embedded fast). Replaces the old "captured|indexing" status text.
  await expect(popup.locator('button.capture')).toHaveText(/Saving\.\.\.|Update this page/, { timeout: 30_000 })
  await page.goto('about:blank')
  // Back to the Search tab (the last setPaused left Settings open) before searching.
  await searchTab.click()
  await expect(async () => {
    await popup.getByRole('searchbox').fill('hormone that ruins sleep')
    await popup.getByRole('searchbox').press('Enter')
    await expect(popup.locator('article').first()).toContainText('Cortisol', { timeout: 5_000 })
  }).toPass({ timeout: 90_000 })

  await ctx.close()
})

// Scenario: clicking "Don't remember this site" must actually block a subsequent
// capture via the real worker+SQL path  -  not just show optimistic popup text.
// This is the end-to-end proof of the privacy promise.
//
// Approach: route 'http://deny-test.example/article' to serve the article HTML
// so the tab has a real hostname (deny-test.example) that the gate can block.
// Then deny the host, capture, and assert the gate returned 'denylisted'.
// Finally capture the file:// article (different host) to confirm only the denied
// host is blocked and normal capture still works.
//
// Coverage: integration (real extension, real SqliteWorkerClient, real gate SQL).
test('deny-host blocks capture via real SQL path', async () => {
  test.setTimeout(120_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  // Read the article fixture and serve it at a real http hostname via Playwright
  // route interception. Route is intercepted at the CDP level before DNS, so the
  // domain does not need to exist and no TLS handshake is required.
  const articleHtml = fs.readFileSync(path.resolve(dir, 'fixtures/article.html'), 'utf8')
  const denyArticleUrl = 'http://deny-test.example/article'

  const articlePage = await ctx.newPage()
  await articlePage.route(denyArticleUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: articleHtml }),
  )
  await articlePage.goto(denyArticleUrl)

  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)

  // Keep article page as the active tab so popup reads its URL for deny-host.
  await articlePage.bringToFront()

  // Click "Don't remember this site". The popup awaits the full round-trip
  // (popup -> SW -> offscreen -> SQLite addDenyHost) before setting denyStatus,
  // so when the status text appears the SQL write is already committed.
  await popup.getByText("Don't remember this site").click()
  await expect(popup.getByText(/won't remember deny-test\.example/i)).toBeVisible({ timeout: 10_000 })

  // Now try to capture the denied page. The gate reads userDenyHosts from
  // SQLite and must return reason='denylisted' for deny-test.example.
  await popup.getByText('Capture this page').click()
  await expect(
    popup.getByText('not saved: this site is on the no-remember list'),
  ).toBeVisible({ timeout: 10_000 })

  // Verify the denied page was NOT saved: its PAGE-scoped badge stays "not saved yet" (the
  // gate blocked it, so has-page is false). The denylisted note above is the positive proof.
  await expect(popup.getByText('not saved yet')).toBeVisible({ timeout: 10_000 })

  // Cross-check: capture the file:// article (host='') on a different page to
  // confirm the denylist is host-specific and normal capture still works.
  const fileArticlePage = await ctx.newPage()
  await fileArticlePage.goto(articleUrl)
  await fileArticlePage.bringToFront()
  await popup.getByText('Capture this page').click()
  // file:// pages have host='' which is NOT deny-test.example, so capture should proceed and
  // store the page -> the button leaves "Capture this page" for "Saving..."/"Update this page".
  await expect(popup.locator('button.capture')).toHaveText(/Saving\.\.\.|Update this page/, { timeout: 10_000 })

  await ctx.close()
})

// Scenario: the denylist editor's "remove" must actually delete the user_denylist row
// (not just hide it in the UI) so the site is captured again afterwards. Proven through
// the real worker SQL path.
// Coverage: integration (real extension; deny -> list -> remove -> capture succeeds).
test('removing a no-remember site re-enables capture (real SQL path)', async () => {
  test.setTimeout(120_000)

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const extId = sw.url().split('/')[2]

  const articleHtml = fs.readFileSync(path.resolve(dir, 'fixtures/article.html'), 'utf8')
  const url = 'http://remove-test.example/article'
  const articlePage = await ctx.newPage()
  await articlePage.route(url, (route) => route.fulfill({ contentType: 'text/html', body: articleHtml }))
  await articlePage.goto(url)

  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`)
  await articlePage.bringToFront()

  // Deny the host; while denied, capture is blocked.
  await popup.getByText("Don't remember this site").click()
  await expect(popup.getByText(/won't remember remove-test\.example/i)).toBeVisible({ timeout: 10_000 })
  await popup.getByText('Capture this page').click()
  await expect(popup.getByText('not saved: this site is on the no-remember list')).toBeVisible({ timeout: 10_000 })

  // The editable no-remember list now lives in the Settings tab. Open it; on mount it
  // re-fetches get-settings, so the host just denied from the per-page bar is listed.
  await popup.getByRole('tab', { name: 'Settings' }).click()

  // Remove it via the denylist editor's "remove" button (the only such button, since
  // exactly one host is denied) -> the user_denylist row must be deleted.
  await popup.getByRole('button', { name: 'remove' }).click()

  // Capture now succeeds -> proves the row was really deleted, not just hidden. The button
  // leaves "Capture this page" for "Saving..."/"Update this page" (replaces "captured" text).
  await expect(popup.locator('button.capture')).toHaveText(/Saving\.\.\.|Update this page/, { timeout: 10_000 })

  await ctx.close()
})
