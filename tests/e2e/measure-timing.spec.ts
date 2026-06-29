// Measurement test: capture the timing breakdown of the full pipeline.
// Does NOT assert specific times (hardware/network dependent).
// Its job is to print a TIMING SUMMARY block so we can see where the ~25s goes.
// Coverage: N/A (measurement only — no correctness assertion beyond plumbing working)

import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')

test('measure capture pipeline timing breakdown', async () => {
  test.setTimeout(180_000)

  // Collected values from SW logs.
  let pipelineMs: number | null = null
  let warmupMs: number | null = null
  let device: string | null = null
  let captureStoreMs: number | null = null
  // Post-capture drain tracking: only accept drain totals AFTER capture is acknowledged.
  let captureAcknowledged = false
  let drainTotalMs: number | null = null
  let embedMs: number | null = null
  let embedChunks: number | null = null
  let embedMsPerChunk: number | null = null

  // Resolve handles for waiting on key log lines.
  let resolveModelReady: () => void
  const modelReadyP = new Promise<void>((r) => { resolveModelReady = r })

  // -- Parse a log line and extract timing values. --
  function handleLog(text: string, source: string): void {
    console.log(`${source}: ${text}`)

    // [timing] model pipeline = X ms
    const pipeM = text.match(/\[timing\] model pipeline = (\d+) ms/)
    if (pipeM) pipelineMs = parseInt(pipeM[1], 10)

    // [timing] model warmup = X ms
    const warmupM = text.match(/\[timing\] model warmup = (\d+) ms/)
    if (warmupM) warmupMs = parseInt(warmupM[1], 10)

    // [timing] device = webgpu|wasm
    const deviceM = text.match(/\[timing\] device = (\S+)/)
    if (deviceM) device = deviceM[1]

    // [timing] capture store = X ms
    const captureM = text.match(/\[timing\] capture store = (\d+) ms/)
    if (captureM) captureStoreMs = parseInt(captureM[1], 10)

    // [timing] drain total = X ms — only record if capture was already acknowledged.
    // The startup drain (0 chunks, <5ms) fires before capture and should be ignored here.
    const drainM = text.match(/\[timing\] drain total = (\d+) ms/)
    if (drainM && captureAcknowledged) {
      drainTotalMs = parseInt(drainM[1], 10)
    }

    // [timing] embed N chunks = X ms (Y ms/chunk)
    const embedM = text.match(/\[timing\] embed (\d+) chunks = (\d+) ms \(([\d.]+) ms\/chunk\)/)
    if (embedM) {
      embedChunks = parseInt(embedM[1], 10)
      embedMs = parseInt(embedM[2], 10)
      embedMsPerChunk = parseFloat(embedM[3])
    }

    // Model ready signal.
    if (text.includes('[recall/bg] pre-warm complete')) {
      resolveModelReady()
    }
  }

  const tLaunch = Date.now()

  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
    ],
  })

  // Forward offscreen page console to stdout (if accessible).
  ctx.on('page', (p) => {
    p.on('console', (m) => handleLog(m.text(), 'OFFLOG'))
  })

  // Attach to service worker console.
  const swPromise = ctx.waitForEvent('serviceworker')
  const existingSw = ctx.serviceWorkers()[0]
  const sw = existingSw ?? (await swPromise)
  sw.on('console', (m) => handleLog(m.text(), 'SWLOG'))

  const extId = sw.url().split('/')[2]

  // Wait for model pre-warm to complete (or up to 150s).
  await Promise.race([
    modelReadyP,
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error('model ready timeout')), 150_000)),
  ]).catch(() => { console.log('NOTE: model-ready wait timed out, continuing anyway') })

  const tModelReady = Date.now()

  // Open the article fixture page.
  const page = await ctx.newPage()
  await page.goto('file://' + path.resolve(dir, 'fixtures/article.html'))

  // Open the popup page.
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

  // Restore article as active tab so chrome.tabs.query returns it.
  await page.bringToFront()

  // Click Capture.
  await popup.getByText('Capture this page').click()

  // Wait for the captured acknowledgement, then set the flag so subsequent
  // drain total logs are attributed to this capture's drain (not the startup drain).
  await expect(popup.getByText('captured', { exact: false })).toBeVisible({ timeout: 30_000 })
  captureAcknowledged = true

  // Wait for indexing to complete: popup shows "indexed" once the drain is done.
  // This is the same signal used by recall-flow.spec.ts.
  await expect(popup.getByText('indexed')).toBeVisible({ timeout: 120_000 })

  const tIndexed = Date.now()

  // Print the summary block.
  const launchToModelMs = tModelReady - tLaunch
  const launchToIndexedMs = tIndexed - tLaunch

  const pipelineStr = pipelineMs !== null ? `${pipelineMs}` : '(not captured)'
  const warmupStr = warmupMs !== null ? `${warmupMs}` : '(not captured)'
  const deviceStr = device !== null ? device : '(not captured)'
  const captureStr = captureStoreMs !== null ? `${captureStoreMs}` : '(not captured)'
  const drainStr = drainTotalMs !== null ? `${drainTotalMs}` : '(not captured — see drain complete log)'
  const embedStr = embedMs !== null && embedChunks !== null && embedMsPerChunk !== null
    ? `${embedMs} ms (${embedMsPerChunk} ms/chunk, ${embedChunks} chunks)`
    : '(not captured)'

  console.log('')
  console.log('===== TIMING SUMMARY =====')
  console.log(`launch -> model ready: ${launchToModelMs} ms`)
  console.log(`  model pipeline: ${pipelineStr} ms`)
  console.log(`  model warmup: ${warmupStr} ms`)
  console.log(`  device: ${deviceStr}`)
  console.log(`capture store: ${captureStr} ms`)
  console.log(`drain total: ${drainStr} ms`)
  console.log(`  embed per batch: ${embedStr}`)
  console.log(`total launch -> indexed: ${launchToIndexedMs} ms`)
  console.log('==========================')
  console.log('')

  await ctx.close()

  // The test's purpose is measurement, not assertion.
  expect(true).toBe(true)
})
