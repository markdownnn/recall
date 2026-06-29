// Spike: offscreen document that owns a dedicated Worker running sqlite-wasm with
// the OPFS SAH pool VFS.  The service worker forwards 'spike-bump' messages here;
// we relay them to the worker and send the reply back.
//
// This file is ADDITIVE and isolated — it does not touch the existing
// capture / recall / embedding flow.

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

console.log('[recall/offscreen] document loaded, worker spawned')
