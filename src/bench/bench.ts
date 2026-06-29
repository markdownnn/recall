// Spike: WebGPU vs WASM embedding benchmark entry point.
// This page is opened by the Playwright test. It runs the benchmark immediately
// on load (no trigger mechanism needed — Playwright navigates here on purpose).
// Results are written to chrome.storage.local under '__webgpu_bench'.
//
// This is a dedicated spike page. It is NOT linked from the extension UI.
// It is ADDITIVE and isolated — it does not touch the existing capture/recall flow.

import { runBench } from '../offscreen/webgpu-bench'

;(async () => {
  console.log('[recall/bench-page] starting benchmark immediately...')
  await chrome.storage.local.set({ __webgpu_bench_started: Date.now() })
  try {
    const result = await runBench()
    console.log('[recall/bench-page] DONE', result)
    await chrome.storage.local.set({ __webgpu_bench: { ...result, ts: Date.now() } })
  } catch (e) {
    const errResult = {
      webgpuMsPerChunk: null,
      wasm1MsPerChunk: null,
      wasmMultiMsPerChunk: null,
      crossOriginIsolated: false,
      accuracyCosine: null,
      webgpuDtype: null,
      notes: [`bench threw: ${String(e)}`],
      ts: Date.now(),
      error: String(e),
    }
    console.error('[recall/bench-page] FAILED', e)
    await chrome.storage.local.set({ __webgpu_bench: errResult })
  }
})()
