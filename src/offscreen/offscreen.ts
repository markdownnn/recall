// Spike: offscreen document that owns a dedicated Worker running sqlite-wasm with
// the OPFS SAH pool VFS.  The service worker forwards 'spike-bump' messages here;
// we relay them to the worker and send the reply back.
//
// This file is ADDITIVE and isolated — it does not touch the existing
// capture / recall / embedding flow.

import { installOffscreenRpcHandler } from './offscreen-rpc'
import { WebGpuEmbedder } from './webgpu-embedder'

const worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' })

// Pending request map: id -> resolve function
const pending = new Map<number, (value: { counter?: number; error?: string }) => void>()
let nextId = 0

worker.onmessage = (e: MessageEvent) => {
  const { id, counter, error } = e.data as { id: number; counter?: number; error?: string }
  const resolve = pending.get(id)
  if (resolve) {
    pending.delete(id)
    resolve(error != null ? { error } : { counter })
  }
}

worker.onerror = (e) => {
  console.error('[recall/offscreen] worker error:', e.message)
}

function bumpCounter(): Promise<{ counter?: number; error?: string }> {
  return new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    worker.postMessage({ type: 'bump', id })
  })
}

// WebGPU probe — offscreen documents have DOM / navigator APIs.
async function checkWebGPU(): Promise<string> {
  const gpu = (navigator as any).gpu as any
  if (!gpu) return 'no navigator.gpu'
  try {
    const adapter = await gpu.requestAdapter()
    return adapter ? 'adapter OK' : 'no adapter'
  } catch (e) {
    return 'error: ' + String(e)
  }
}

// Cache the WebGPU result so the first bump response can include it.
const webgpuPromise = checkWebGPU()

// Only handle 'spike-bump'; return false for everything else so other
// listeners (popup, etc.) are not interfered with.
chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg.type !== 'spike-bump') return false
  ;(async () => {
    const [workerResult, webgpu] = await Promise.all([bumpCounter(), webgpuPromise])
    sendResponse({ ...workerResult, webgpu })
  })()
  return true // keep the message channel open for the async reply
})

// Spike: WebGPU vs WASM embedding benchmark.
// The Playwright test sets '__run_bench_trigger: true' in chrome.storage.local
// from the popup page.  We poll storage every 2 seconds so we don't depend on
// chrome.storage.onChanged or chrome.runtime.sendMessage, both of which have
// proven unreliable from SW/popup → offscreen document in this Chrome version.
let _benchRunning = false

async function _runBenchIfTriggered(): Promise<void> {
  if (_benchRunning) return
  const data = (await chrome.storage.local.get(['__run_bench_trigger'])) as Record<string, unknown>
  if (data['__run_bench_trigger'] !== true) return
  _benchRunning = true
  // Consume the trigger immediately so a restart does not re-fire.
  await chrome.storage.local.remove(['__run_bench_trigger'])
  console.log('[recall/offscreen] webgpu-bench: trigger detected via polling, starting...')
  await chrome.storage.local.set({ __webgpu_bench_started: Date.now() })
  try {
    const { runBench } = await import('./webgpu-bench')
    const result = await runBench()
    console.log('[recall/offscreen] webgpu-bench: DONE', result)
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
    console.error('[recall/offscreen] webgpu-bench: FAILED', e)
    await chrome.storage.local.set({ __webgpu_bench: errResult })
  } finally {
    _benchRunning = false
  }
}

// Poll every 2s.  2s latency is acceptable for a multi-minute benchmark.
// Also write a heartbeat counter so the Playwright test can confirm the loop is alive.
let _pollCount = 0
setInterval(() => {
  _pollCount++
  chrome.storage.local.set({ __offscreen_heartbeat: _pollCount }).catch(console.error)
  _runBenchIfTriggered().catch(console.error)
}, 2_000)

// ---------------------------------------------------------------------------
// Real embedder (multilingual-e5-small, WebGPU with WASM fallback) lives here.
// The SW holds only a proxy that forwards embed/ensureLoaded over RPC.
// ---------------------------------------------------------------------------
const embedder = new WebGpuEmbedder()

// RPC handler dispatches on payload.op:
//   'embed'        -> { vectors: number[][] }  (Float32Array can't cross the wire)
//   'ensureLoaded' -> { device }  + fire-and-forget model-progress events to the SW
//   (default)      -> echo {echoed, n+1}  (keeps the rpc-stress spike test green)
installOffscreenRpcHandler(async (payload: unknown) => {
  const p = (payload ?? {}) as Record<string, unknown>
  const op = p.op as string | undefined

  if (op === 'embed') {
    const texts = (p.texts as string[]) ?? []
    const kind = (p.kind as 'query' | 'passage') ?? 'passage'
    const vectors = await embedder.embed(texts, kind)
    return { vectors }
  }

  if (op === 'ensureLoaded') {
    await embedder.ensureLoaded((e) => {
      // Fire-and-forget: push download progress to the SW so the popup can show it.
      chrome.runtime
        .sendMessage({ channel: 'rpc-event', kind: 'model-progress', status: e })
        .catch(() => {
          // SW/popup may be closed; ignore.
        })
    })
    console.log('[recall/offscreen] ensureLoaded done, embedding device =', embedder.device)
    return { device: embedder.device }
  }

  // Default: echo (additive spike — proves RPC delivery/correlation under load).
  return {
    echoed: payload,
    n: ((p.n as number) ?? 0) + 1,
  }
})

console.log('[recall/offscreen] document loaded, worker spawned')
