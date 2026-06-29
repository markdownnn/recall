// Scenario: measures WebGPU vs WASM embedding speed on the same 32 passages using
// @huggingface/transformers v3. The benchmark runs inside a dedicated extension
// page (src/bench/bench.html) which has full WebGPU access.
// Results are written to chrome.storage.local; this test polls for them.
//
// Coverage: integration (real Chrome MV3 extension, real WebGPU, real model inference).
// Mock: N/A.
//
// Allow up to 300s: first run downloads the v3 model (~135MB from HuggingFace) + warms up.
// Subsequent runs are faster (HTTP cache).

import { test, expect, chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import fs from 'node:fs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(dir, '../../dist-ext')
// Separate profile from other spikes to avoid cross-test storage pollution.
const BENCH_PROFILE = path.join(os.tmpdir(), 'recall-webgpu-bench-profile')

test('WebGPU vs WASM embedding benchmark (spike)', async () => {
  test.setTimeout(480_000) // Allow up to 8 minutes for model download + all backends

  // Clean slate on each run so we do not mistake a stale result.
  if (fs.existsSync(BENCH_PROFILE)) {
    fs.rmSync(BENCH_PROFILE, { recursive: true, force: true })
  }

  const ctx = await chromium.launchPersistentContext(BENCH_PROFILE, {
    headless: false,
    args: [
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`,
      '--enable-unsafe-webgpu',           // expose WebGPU in extension contexts
      '--use-angle=default',               // use platform-native GPU backend
    ],
  })

  try {
    // Wait for the service worker to start so we can get the extension ID.
    const swPromise = ctx.waitForEvent('serviceworker', { timeout: 30_000 }).catch(() => null)
    const existingSw = ctx.serviceWorkers()[0]
    const sw = existingSw ?? (await swPromise)
    if (!sw) throw new Error('service worker never started')
    const extId = sw.url().split('/')[2]
    console.log('[bench-test] extension ID:', extId)

    // Open the popup page so we can read chrome.storage from it.
    const popupPage = await ctx.newPage()
    await popupPage.goto(`chrome-extension://${extId}/src/ui/popup/index.html`)

    // Clear any stale bench results from a previous run.
    await popupPage.evaluate(async () => {
      await new Promise<void>(resolve =>
        chrome.storage.local.remove(
          ['__webgpu_bench', '__webgpu_bench_started', '__run_bench_trigger'],
          resolve
        )
      )
    })

    // Navigate a NEW page to the dedicated bench page.
    // The bench page runs runBench() immediately on load — no trigger needed.
    // Playwright keeps this page alive for the duration of the test.
    console.log('[bench-test] opening bench page...')
    const benchPage = await ctx.newPage()
    await benchPage.goto(`chrome-extension://${extId}/src/bench/bench.html`)
    console.log('[bench-test] bench page opened, benchmark running in background...')

    // Poll chrome.storage from the popup page for results.
    // Allow 420s for model download + all backends on cold start.
    const POLL_DEADLINE_MS = 420_000
    const deadline = Date.now() + POLL_DEADLINE_MS
    let result: Record<string, unknown> | null = null
    let benchStarted = false

    while (Date.now() < deadline) {
      const storageState = await popupPage.evaluate(async () => {
        const d = await new Promise<Record<string, unknown>>(resolve =>
          chrome.storage.local.get(['__webgpu_bench', '__webgpu_bench_started'], resolve as any)
        )
        return {
          bench: (d['__webgpu_bench'] as Record<string, unknown>) ?? null,
          started: (d['__webgpu_bench_started'] as number) ?? null,
        }
      })

      if (!benchStarted && storageState.started) {
        benchStarted = true
        console.log(`[bench-test] benchmark started in bench page (ts=${storageState.started})`)
      }

      if (storageState.bench !== null && typeof storageState.bench.ts === 'number' && storageState.bench.ts > 0) {
        result = storageState.bench
        break
      }

      await popupPage.waitForTimeout(2_000)
    }

    if (!benchStarted) {
      throw new Error(
        `[bench-test] __webgpu_bench_started never appeared within ${POLL_DEADLINE_MS / 1000}s. ` +
        `The bench page (src/bench/bench.html) did not start the benchmark.`
      )
    }

    if (!result) {
      throw new Error(`[bench-test] Benchmark started but __webgpu_bench never appeared in storage after ${POLL_DEADLINE_MS / 1000}s`)
    }

    // ---- Log the deliverable ----
    console.log('\n========== WEBGPU BENCH RESULT ==========')
    console.log(JSON.stringify(result, null, 2))

    const webgpuMs = result.webgpuMsPerChunk as number | null
    const wasm1Ms = result.wasm1MsPerChunk as number | null
    const wasmMultiMs = result.wasmMultiMsPerChunk as number | null
    const cosine = result.accuracyCosine as number | null
    const coi = result.crossOriginIsolated as boolean

    console.log('\n---------- SUMMARY ----------')
    if (webgpuMs !== null) {
      console.log(`WebGPU:          ${webgpuMs.toFixed(1)} ms/chunk  (dtype: ${result.webgpuDtype})`)
    } else {
      console.log('WebGPU:          FAILED (see notes)')
    }
    if (wasm1Ms !== null) {
      console.log(`WASM single:     ${wasm1Ms.toFixed(1)} ms/chunk`)
    } else {
      console.log('WASM single:     FAILED (see notes)')
    }
    if (wasmMultiMs !== null) {
      console.log(`WASM multi:      ${wasmMultiMs.toFixed(1)} ms/chunk`)
    } else {
      console.log(`WASM multi:      unavailable (crossOriginIsolated=${coi})`)
    }
    if (webgpuMs !== null && wasm1Ms !== null) {
      const speedup = wasm1Ms / webgpuMs
      console.log(`WebGPU speedup:  ${speedup.toFixed(2)}x vs WASM-single`)
    }
    console.log(`crossOriginIsolated: ${coi}`)
    console.log(`accuracy cosine: ${cosine !== null ? cosine.toFixed(6) : 'N/A'}`)
    console.log('\nnotes:')
    const notes = result.notes as string[] | undefined
    ;(notes ?? []).forEach(n => console.log('  -', n))
    if (result.error) console.log('ERROR:', result.error)
    console.log('========================================\n')

    // ---- Assertions ----
    // Only assert liveness (it ran) and accuracy (no silent quality degradation).
    // Speed numbers are hardware-dependent and not asserted.

    if (webgpuMs !== null) {
      // WebGPU ran — assert it produced a positive time.
      expect(webgpuMs, 'webgpuMsPerChunk must be > 0').toBeGreaterThan(0)

      // Accuracy: WebGPU vectors must be very close to WASM vectors.
      expect(cosine, 'accuracyCosine must be > 0.99 (WebGPU must not degrade quality)').not.toBeNull()
      expect(cosine as number).toBeGreaterThan(0.99)
    } else {
      // WebGPU failed to initialize — this is a critical finding, fail the test.
      const errorNote = (notes ?? []).find(n => n.includes('WebGPU'))
      throw new Error(
        `CRITICAL: WebGPU failed to initialize. Check notes for error:\n${errorNote ?? 'no WebGPU note found'}`
      )
    }

    // WASM single must also have run (it is the baseline).
    expect(wasm1Ms, 'wasm1MsPerChunk must be > 0').not.toBeNull()
    expect(wasm1Ms as number).toBeGreaterThan(0)

  } finally {
    await ctx.close()
  }
})
