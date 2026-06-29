// Offscreen document: the engine room.
// Owns: WebGpuEmbedder, OffscreenWorkerStore (OPFS via worker), and
//       the three core services (Capture, Indexing, Recall).
// Handles high-level RPC ops from the SW: capture, recall, ensureLoaded, ping.
// Drain (embedding queue) runs here so it stays alive independent of the SW.

import { installOffscreenRpcHandler } from './offscreen-rpc'
import { WebGpuEmbedder } from './webgpu-embedder'
import { OffscreenWorkerStore } from './offscreen-worker-store'
import { CaptureService } from '../core/capture-service'
import { IndexingService } from '../core/indexing-service'
import { RecallService } from '../core/recall-service'
import { ParagraphChunker } from '../core/paragraph-chunker'
import type { EmbeddingPort } from '../core/ports'

// ---------------------------------------------------------------------------
// Core services
// ---------------------------------------------------------------------------

const embedder = new WebGpuEmbedder()

// Adapter: WebGpuEmbedder.embed() returns number[][] (legacy type for RPC wire
// compatibility). Core services need Float32Array[]. Convert in one place.
const localEmbedder: EmbeddingPort = {
  async embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const vecs = await embedder.embed(texts, kind)
    return vecs.map((a) => new Float32Array(a))
  },
}

const store = new OffscreenWorkerStore()
const chunker = new ParagraphChunker(220)
const capture = new CaptureService(chunker, store)
const indexing = new IndexingService(store, localEmbedder)
const recall = new RecallService(localEmbedder, store)

// ---------------------------------------------------------------------------
// Drain helper: run drain and push progress events to the SW.
// The SW relays them to the popup as indexing-progress broadcast messages.
// ---------------------------------------------------------------------------

function runDrainWithProgress(): void {
  let totalEmbedded = 0
  indexing
    .drain((n) => {
      totalEmbedded += n
      chrome.runtime
        .sendMessage({ channel: 'rpc-event', kind: 'indexing-progress', embedded: totalEmbedded })
        .catch(() => {})
    })
    .then(() => {
      // Signal "drain complete" so the popup shows "indexed".
      chrome.runtime
        .sendMessage({ channel: 'rpc-event', kind: 'indexing-complete', totalEmbedded })
        .catch(() => {})
    })
    .catch((e) => console.error('[recall/offscreen] drain failed:', e))
}

// On load: resume any pending chunks left from a previous session.
// The store worker may still be initialising its OPFS DB; pendingChunks() will
// wait for the worker's initPromise before replying, so this is safe to call now.
runDrainWithProgress()

// ---------------------------------------------------------------------------
// WebGPU bench (additive, independent of storage/core).
// ---------------------------------------------------------------------------

let _benchRunning = false

async function _runBenchIfTriggered(): Promise<void> {
  if (_benchRunning) return
  const data = (await chrome.storage.local.get(['__run_bench_trigger'])) as Record<string, unknown>
  if (data['__run_bench_trigger'] !== true) return
  _benchRunning = true
  await chrome.storage.local.remove(['__run_bench_trigger'])
  console.log('[recall/offscreen] webgpu-bench: trigger detected, starting...')
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

let _pollCount = 0
setInterval(() => {
  _pollCount++
  chrome.storage.local.set({ __offscreen_heartbeat: _pollCount }).catch(console.error)
  _runBenchIfTriggered().catch(console.error)
}, 2_000)

// ---------------------------------------------------------------------------
// RPC handler: dispatches on payload.op
// ---------------------------------------------------------------------------

installOffscreenRpcHandler(async (payload: unknown) => {
  const p = (payload ?? {}) as Record<string, unknown>
  const op = p.op as string | undefined

  // --- capture: store chunks immediately, fire-and-forget drain ---
  if (op === 'capture') {
    const url = p.url as string
    const title = p.title as string
    const text = p.text as string
    const t0 = Date.now()
    const { chunkCount } = await capture.capture({ url, title, text })
    console.log(`[recall/offscreen] capture done: ${chunkCount} chunks in ${Date.now() - t0}ms`)
    // Fire-and-forget: drain runs in background; the RPC reply returns immediately.
    runDrainWithProgress()
    return { chunkCount }
  }

  // --- recall: embed query, cosine search ---
  if (op === 'recall') {
    const text = p.text as string
    const k = p.k as number
    const t0 = Date.now()
    const results = await recall.recall({ text, k })
    console.log(`[recall/offscreen] recall done: ${results.length} results in ${Date.now() - t0}ms`)
    return { results }
  }

  // --- ensureLoaded: warm up the model, push progress events ---
  if (op === 'ensureLoaded') {
    await embedder.ensureLoaded((e) => {
      chrome.runtime
        .sendMessage({ channel: 'rpc-event', kind: 'model-progress', status: e })
        .catch(() => {})
    })
    console.log('[recall/offscreen] ensureLoaded done, device =', embedder.device)
    return { device: embedder.device, pipelineMs: embedder.pipelineMs, warmupMs: embedder.warmupMs }
  }

  // --- embed: kept for any callers that still use direct embed RPC (spike tests) ---
  if (op === 'embed') {
    const texts = (p.texts as string[]) ?? []
    const kind = (p.kind as 'query' | 'passage') ?? 'passage'
    const t0 = Date.now()
    const vectors = await embedder.embed(texts, kind)
    return { vectors, embedMs: Date.now() - t0, chunkCount: texts.length }
  }

  // --- ping: keep-alive from the SW ---
  if (op === 'ping') {
    return { pong: true }
  }

  // --- default: echo (keeps rpc-stress spike test green) ---
  return {
    echoed: payload,
    n: ((p.n as number) ?? 0) + 1,
  }
})

console.log('[recall/offscreen] document loaded, core services ready')
