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
import { CaptureGate } from '../core/capture-gate'
import type { EmbeddingPort } from '../core/ports'

// ---------------------------------------------------------------------------
// Core services
// ---------------------------------------------------------------------------

const embedder = new WebGpuEmbedder()

// Push model-load progress to the SW (which relays it to the popup). Wiring this
// as the embedder's default sink means the LAZY load path (a capture/recall that
// triggers the model load when it was not pre-warmed) also shows progress,
// instead of a silent ~20s wait.
function emitModelProgress(e: { status: string; progress?: number }): void {
  chrome.runtime
    .sendMessage({ channel: 'rpc-event', kind: 'model-progress', status: e })
    .catch(() => {})
}
embedder.setProgressSink(emitModelProgress)

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
const gate = new CaptureGate()

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
    .catch((e) => {
      // The drain runs fire-and-forget after capture returns, so an embedding
      // failure would otherwise die in console.error and leave the popup stuck
      // on "indexing..." forever. Surface it to the SW -> popup as well.
      console.error('[recall/offscreen] drain failed:', e)
      chrome.runtime
        .sendMessage({ channel: 'rpc-event', kind: 'indexing-error', error: String(e) })
        .catch(() => {})
    })
}

// On load: resume any pending chunks left from a previous session.
// The store worker may still be initialising its OPFS DB; pendingChunks() will
// wait for the worker's initPromise before replying, so this is safe to call now.
runDrainWithProgress()

// ---------------------------------------------------------------------------
// RPC handler: dispatches on payload.op
// ---------------------------------------------------------------------------

installOffscreenRpcHandler(async (payload: unknown) => {
  const p = (payload ?? {}) as Record<string, unknown>
  const op = p.op as string | undefined

  // --- capture: run gate, store chunks immediately, fire-and-forget drain ---
  if (op === 'capture') {
    const url = p.url as string
    const title = p.title as string
    const text = p.text as string
    const manual = p.manual as boolean
    const decision = gate.decide({ url, text, manual })
    if (!decision.capture) {
      return { captured: false, chunkCount: 0, reason: decision.reason }
    }
    const { chunkCount } = await capture.capture({ url, title, text })
    console.log(`[recall] captured ${chunkCount} chunks`)
    // Fire-and-forget: drain runs in background; the RPC reply returns immediately.
    runDrainWithProgress()
    return { captured: true, chunkCount }
  }

  // --- recall: embed query, cosine search ---
  if (op === 'recall') {
    const text = p.text as string
    const k = p.k as number
    const results = await recall.recall({ text, k })
    console.log(`[recall] recalled ${results.length} results`)
    return { results }
  }

  // --- ensureLoaded: warm up the model, push progress events ---
  if (op === 'ensureLoaded') {
    await embedder.ensureLoaded((e) => {
      chrome.runtime
        .sendMessage({ channel: 'rpc-event', kind: 'model-progress', status: e })
        .catch(() => {})
    })
    console.log('[recall] model ready, device =', embedder.device)
    return { device: embedder.device }
  }

  // --- status: report whether the model is already loaded (device != null).
  //     Lets a freshly-woken SW learn the real model state instead of reporting
  //     stale INITIAL_MODEL_STATUS. Cheap: just reads embedder.device. ---
  if (op === 'status') {
    return { device: embedder.device }
  }

  // --- ping: keep-alive from the SW ---
  if (op === 'ping') {
    return { pong: true }
  }
})

console.log('[recall/offscreen] document loaded, core services ready')
