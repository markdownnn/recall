// Scenario: captured data (chunks + vectors) must survive a full browser restart,
// proving that storage is now OPFS-durable (not in-memory).
// Without the offscreen+worker+OPFS refactor this test always fails on run 2.
// Coverage: integration (two real Chrome instances, same userDataDir, real OPFS).

import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import fs from 'node:fs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')
// Fixed profile so OPFS data persists between the two launches.
const PROFILE = path.join(os.tmpdir(), 'recall-persistence-e2e-profile')

async function launchCtx() {
  return chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
    ],
  })
}

async function getExtId(ctx: Awaited<ReturnType<typeof launchCtx>>): Promise<string> {
  const swPromise = ctx.waitForEvent('serviceworker', { timeout: 30_000 }).catch(() => null)
  const existingSw = ctx.serviceWorkers()[0]
  const sw = existingSw ?? (await swPromise)
  if (!sw) throw new Error('service worker never started')
  return sw.url().split('/')[2]
}

test('captured data survives a full browser restart (OPFS persistence)', async () => {
  test.setTimeout(360_000)

  // Clean slate  -  ensures run starts with empty OPFS.
  if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true })

  // ==========================================================================
  // Session 1: capture the article, wait for indexing, verify search works.
  // ==========================================================================
  const ctx1 = await launchCtx()
  try {
    const extId = await getExtId(ctx1)

    const articlePage = await ctx1.newPage()
    await articlePage.goto('file://' + path.resolve(dir, 'fixtures/article.html'))

    const popup1 = await ctx1.newPage()
    await popup1.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

    // Keep the article page in front for the capture.
    await articlePage.bringToFront()

    // Capture.
    await popup1.getByText('Capture this page').click()
    await expect(popup1.getByText('captured', { exact: false })).toBeVisible({ timeout: 30_000 })

    // The manual capture is now committed. Navigate the source tab away so the dwell
    // auto-capture can't fire and re-run putChunks (which DELETEs + re-inserts the chunks
    // with NULL vectors) - that would race the restart and leave un-embedded chunks that
    // session 2's search can't find. (This test is about durability of stored data, not
    // auto-capture.) Honest stop: the page genuinely leaves; no sleep, no sensitivity trick.
    await articlePage.goto('about:blank')

    // Wait for indexing (model download + embed).
    await expect(popup1.getByText('indexed')).toBeVisible({ timeout: 240_000 })

    // Quick sanity: Cortisol ranks first in session 1.
    await popup1.getByPlaceholder('recall...').fill('hormone that ruins sleep')
    await popup1.getByPlaceholder('recall...').press('Enter')
    const items1 = popup1.locator('article')
    await expect(items1).toHaveCount(1, { timeout: 30_000 })
    await expect(items1.first()).toContainText('Cortisol', { timeout: 10_000 })

    // Set Paused = on in session 1 so we can assert it survives the restart. Retry until
    // the checked state STICKS (the popup's async settings mount can reset it right after
    // a click). The checkbox triggers set-paused -> offscreen -> SQLite setPaused.
    await expect(async () => {
      await popup1.getByLabel(/pause/i).check()
      await expect(popup1.getByLabel(/pause/i)).toBeChecked({ timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
    // Give the round-trip (popup -> SW -> offscreen -> SQLite) time to complete.
    await popup1.waitForTimeout(2_000)

    console.log('[persistence] session 1 OK  -  Cortisol ranked first, paused=true set, closing context...')
  } finally {
    await ctx1.close()
  }

  // Give Chrome time to release the profile directory lock.
  await new Promise<void>((r) => setTimeout(r, 3_000))

  // ==========================================================================
  // Session 2: same profile, NO capture. Assert Cortisol still ranks first.
  // ==========================================================================
  const ctx2 = await launchCtx()
  try {
    const extId = await getExtId(ctx2)

    const popup2 = await ctx2.newPage()
    await popup2.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

    // Do NOT capture. Just search immediately.
    await popup2.getByPlaceholder('recall...').fill('hormone that ruins sleep')
    await popup2.getByPlaceholder('recall...').press('Enter')

    // Cortisol must still rank first  -  from the OPFS-persisted data.
    // 30s timeout: model loads from cache (no download needed); OPFS read is fast.
    const items2 = popup2.locator('article')
    await expect(items2).toHaveCount(1, { timeout: 30_000 })
    await expect(items2.first()).toContainText('Cortisol', { timeout: 10_000 })

    // Assert that the Pause setting also survived the restart.
    // The popup reads settings via get-settings -> offscreen -> SQLite on mount,
    // so if the checkbox is checked the SQLite value persisted across the restart.
    await expect(popup2.getByLabel(/pause/i)).toBeChecked({ timeout: 10_000 })

    console.log('[persistence] session 2 OK  -  Cortisol ranked first WITHOUT re-capturing, pause setting persisted. OPFS persistence confirmed.')
  } finally {
    await ctx2.close()
  }
})
