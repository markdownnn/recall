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
  await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)
  const pauseBox = popup.getByLabel(/pause/i)

  // The popup's mount effect loads settings asynchronously (get-settings) and can reset
  // the checkbox right after a click, so toggling is retried until the new state STICKS
  // (condition-based, no fixed sleep).
  const setPaused = async (on: boolean) => {
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

  // Search finds nothing while paused.
  await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
  await popup.getByPlaceholder('recall...').press('Enter')
  await popup.waitForTimeout(2_000)
  await expect(popup.locator('li')).toHaveCount(0)

  // Unpause, capture ONCE (article tab active), wait for it to land, then navigate the
  // article away so the dwell auto-capture can't re-run putChunks and wipe the chunk
  // vectors (NULL) mid-embed - that race would make recall flaky (same fix as
  // persistence.spec). Then retry only the SEARCH while indexing completes.
  await setPaused(false)
  await page.bringToFront()
  await popup.getByText('Capture this page').click()
  await expect(popup.getByText(/captured|indexing/i)).toBeVisible({ timeout: 30_000 })
  await page.goto('about:blank')
  await expect(async () => {
    await popup.getByPlaceholder('recall...').fill('hormone that ruins sleep')
    await popup.getByPlaceholder('recall...').press('Enter')
    await expect(popup.locator('li').first()).toContainText('Cortisol', { timeout: 5_000 })
  }).toPass({ timeout: 90_000 })

  await ctx.close()
})

// Scenario: clicking "Don't remember this site" must actually block a subsequent
// capture via the real worker+SQL path — not just show optimistic popup text.
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
  await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

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

  // Verify the denied page was NOT captured (no "captured" text).
  await expect(popup.getByText(/captured/i)).not.toBeVisible()

  // Cross-check: capture the file:// article (host='') on a different page to
  // confirm the denylist is host-specific and normal capture still works.
  const fileArticlePage = await ctx.newPage()
  await fileArticlePage.goto(articleUrl)
  await fileArticlePage.bringToFront()
  await popup.getByText('Capture this page').click()
  // file:// pages have host='' which is NOT deny-test.example, so capture
  // should proceed and produce chunks (the gate only checks thin/paused/denied).
  await expect(popup.getByText(/captured/i)).toBeVisible({ timeout: 10_000 })

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
  await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)
  await articlePage.bringToFront()

  // Deny the host; while denied, capture is blocked.
  await popup.getByText("Don't remember this site").click()
  await expect(popup.getByText(/won't remember remove-test\.example/i)).toBeVisible({ timeout: 10_000 })
  await popup.getByText('Capture this page').click()
  await expect(popup.getByText('not saved: this site is on the no-remember list')).toBeVisible({ timeout: 10_000 })

  // Remove it via the denylist editor's "remove" button (the only such button, since
  // exactly one host is denied) -> the user_denylist row must be deleted.
  await popup.getByRole('button', { name: 'remove' }).click()

  // Capture now succeeds -> proves the row was really deleted, not just hidden.
  await popup.getByText('Capture this page').click()
  await expect(popup.getByText(/captured/i)).toBeVisible({ timeout: 10_000 })

  await ctx.close()
})
