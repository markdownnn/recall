// e2e: the first-party granite artifact actually loads and retrieves through the real offscreen
// WebGPU/WASM path (a), and a relaunch on a MATCHING embed version does NOT re-index (b) - a
// buggy migration that re-cleared every launch would leave the page pending and return nothing.
// Drives the SW message router (type:'capture-text' / type:'recall') from an extension page,
// matching the production capture/recall envelope. The gradual "already-done pages stay
// searchable" property is proven at unit level (Task 3 peakPending===1).

import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import fs from 'node:fs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')
const PROFILE = path.join(os.tmpdir(), 'recall-granite-reindex-e2e-profile')

async function launchCtx() {
  return chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  })
}

async function getExtId(ctx: Awaited<ReturnType<typeof launchCtx>>): Promise<string> {
  const swPromise = ctx.waitForEvent('serviceworker', { timeout: 30000 }).catch(() => null)
  const sw = ctx.serviceWorkers()[0] ?? (await swPromise)
  if (!sw) throw new Error('service worker never started')
  return sw.url().split('/')[2]
}

// A side-panel page is an extension page (chrome.runtime available) so it can drive the SW
// message router directly. Reused for both seeding and recall.
async function extPage(ctx: Awaited<ReturnType<typeof launchCtx>>, extId: string) {
  const page = await ctx.newPage()
  await page.goto(`chrome-extension://${extId}/src/ui/sidepanel/index.html`).catch(() => {})
  return page
}

async function recall(ctx: Awaited<ReturnType<typeof launchCtx>>, extId: string, query: string) {
  const page = await extPage(ctx, extId)
  const ids = await page.evaluate(async (q) => {
    const res: any = await chrome.runtime.sendMessage({ type: 'recall', text: q, k: 5 })
    return (res?.results ?? []).map((r: any) => r.page.id)
  }, query)
  await page.close()
  return ids as string[]
}

async function seedAndWait(ctx: Awaited<ReturnType<typeof launchCtx>>, extId: string) {
  const page = await extPage(ctx, extId)
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({
      type: 'capture-text',
      url: 'http://example.test/bacteria',
      title: 'Bacteria',
      text: 'Bacteria are microscopic single-celled organisms studied in microbiology.',
    })
  })
  await page.close()
  await expect
    .poll(async () => (await recall(ctx, extId, 'microbiology bacteria')).length, { timeout: 180000 })
    .toBeGreaterThan(0)
}

test('granite loads on the real path and retrieves a captured page', async () => {
  test.setTimeout(360000)
  if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true })

  const ctx = await launchCtx()
  try {
    const extId = await getExtId(ctx)
    await seedAndWait(ctx, extId)
    const ids = await recall(ctx, extId, 'microbiology bacteria')
    expect(ids.length).toBeGreaterThan(0)
  } finally {
    await ctx.close()
  }
})

test('relaunch on a matching version is searchable immediately (no re-index storm)', async () => {
  test.setTimeout(360000)
  // Reuses the PROFILE seeded by the previous test (granite recorded as the version). If the
  // migration wrongly re-cleared on launch, the page would be pending and this would return
  // nothing.
  const ctx = await launchCtx()
  try {
    const extId = await getExtId(ctx)
    await expect
      .poll(async () => (await recall(ctx, extId, 'microbiology bacteria')).length, { timeout: 60000 })
      .toBeGreaterThan(0)
  } finally {
    await ctx.close()
  }
})
