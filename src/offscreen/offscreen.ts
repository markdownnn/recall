// Offscreen document: the engine room.
// Owns: WebGpuEmbedder, one SqliteWorkerClient (OPFS via worker), and
//       the three core services (Capture, Indexing, Recall).
// Handles high-level RPC ops from the SW: capture, recall, ensureLoaded, ping,
// get-settings, set-paused, deny-host.
// Drain (embedding queue) runs here so it stays alive independent of the SW.

import { installOffscreenRpcHandler } from './offscreen-rpc'
import { WebGpuEmbedder } from './webgpu-embedder'
import { SqliteWorkerClient } from './sqlite-worker-client'
import { WorkerVectorStore } from './worker-vector-store'
import { WorkerSettingsStore } from './worker-settings-store'
import { CaptureService, pageIdFromUrl } from '../core/capture-service'
import { sanitizeUrl } from '../core/sanitize-url'
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

const worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' })
const client = new SqliteWorkerClient(worker as any)
const store = new WorkerVectorStore(client)      // VectorSearchPort
const settings = new WorkerSettingsStore(client)  // SettingsPort
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
      // Only emit when real work happened — emitting with totalEmbedded=0 would
      // falsely set the popup to "indexed" on every keep-alive ping or idle startup.
      if (totalEmbedded > 0) {
        chrome.runtime
          .sendMessage({ channel: 'rpc-event', kind: 'indexing-complete', totalEmbedded })
          .catch(() => {})
      }
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

  // --- capture: load settings, run gate, store chunks immediately, fire-and-forget drain ---
  if (op === 'capture') {
    const url = p.url as string
    const title = p.title as string
    const text = p.text as string
    const manual = p.manual as boolean
    const s = await settings.get()
    const decision = gate.decide({ url, text, manual }, s)
    if (!decision.capture) {
      return { captured: false, chunkCount: 0, reason: decision.reason }
    }
    // A manual save (side panel Capture/Update button, command shortcut) is explicit user
    // intent, so it FORCES (re)capture. The auto path (content-script dwell/engagement) is
    // not manual, so force=false and an already-saved page is skipped (dedup) by the service.
    const { chunkCount, skipped } = await capture.capture({ url, title, text, force: manual })
    if (skipped) {
      // Auto-path dedup: page already saved and not forced. The auto path discards this
      // response, so no UI reason is needed; just report not-captured.
      console.log(`[recall] skipped capture (${skipped})`)
      return { captured: false, chunkCount: 0 }
    }
    console.log(`[recall] captured ${chunkCount} chunks`)
    // Fire-and-forget: drain runs in background; the RPC reply returns immediately.
    runDrainWithProgress()
    return { captured: true, chunkCount }
  }

  // --- settings RPC ops: relay to WorkerSettingsStore ---
  if (op === 'get-settings') {
    return await settings.get()
  }

  if (op === 'set-paused') {
    await settings.setPaused(p.paused as boolean)
    return { ok: true }
  }

  if (op === 'deny-host') {
    await settings.addDenyHost(p.host as string)
    return { ok: true }
  }

  if (op === 'remove-deny-host') {
    await settings.removeDenyHost(p.host as string)
    return { ok: true }
  }

  if (op === 'forget-host') {
    await store.deletePagesByHost(p.host as string)
    return { ok: true }
  }

  // --- has-page: does the store already have this page? Drives the panel SAVED badge.
  //     Normalize the RAW tab url with the EXACT same two steps capture used
  //     (sanitizeUrl THEN pageIdFromUrl) so the badge id can't drift from the stored id. ---
  if (op === 'has-page') {
    const raw = p.url as string | undefined
    if (!raw) return { exists: false }
    try {
      const pageId = pageIdFromUrl(sanitizeUrl(raw))
      return { exists: await store.hasPage(pageId) }
    } catch {
      return { exists: false }
    }
  }

  // --- recent-pages: reverse-chronological browse for the History tab ---
  if (op === 'recent-pages') {
    const limit = p.limit as number
    const beforeTs = p.beforeTs as number | undefined
    return { pages: await store.recentPages(limit, beforeTs) }
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
    // Re-attempt any pending (un-embedded) chunks left by a failed/interrupted drain.
    // Single-flight + empty-fast, so this is free when there is nothing to do.
    runDrainWithProgress()
    return { ok: true }
  }
})

console.log('[recall/offscreen] document loaded, core services ready')
