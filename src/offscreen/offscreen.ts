// Offscreen document: the engine room.
// Owns: WebGpuEmbedder, one SqliteWorkerClient (OPFS via worker), and
//       the three core services (Capture, Indexing, Recall).
// Handles high-level RPC ops from the SW: capture, recall, ensureLoaded, ping,
// get-settings, set-paused, deny-host.
// Drain (embedding queue) runs here so it stays alive independent of the SW.

import { installOffscreenRpcHandler } from './offscreen-rpc'
import { WebGpuEmbedder } from './webgpu-embedder'
import { WebGpuReranker } from './webgpu-reranker'
import { SqliteWorkerClient } from './sqlite-worker-client'
import { WorkerVectorStore } from './worker-vector-store'
import { WorkerSettingsStore } from './worker-settings-store'
import { CaptureService, pageIdFromUrl } from '../core/capture-service'
import { sanitizeUrl } from '../core/sanitize-url'
import { IndexingService } from '../core/indexing-service'
import { RecallService } from '../core/recall-service'
import { AskService } from '../core/ask-service'
import { ParagraphChunker } from '../core/paragraph-chunker'
import { CaptureGate } from '../core/capture-gate'
import { migrateEmbeddingModel } from '../core/embed-migration'
import { describeError } from '../core/describe-error'
import { EMBED_MODEL_VERSION } from '../core/embed-version'
import { INITIAL_ASK_MODEL_STATUS, reduceAskModelProgress } from '../core/ask-model-status'
import type { AskModelStatus } from '../core/ask-model-status'
import type { EmbeddingPort } from '../core/ports'
import type { AnswerGeneratorPort } from '../core/answer-generator'
import { WebLlmAnswerGenerator, createAskEngine, LLAMA_ASK_SPEC } from './webllm-answer-generator'

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

// Surface a WASM fallback (BGE runs but slow) to the SW -> side panel as a "running slow"
// notice. The side panel renders it as the persistent degraded-embedder banner.
embedder.setDegradedSink((info) => {
  chrome.runtime
    .sendMessage({ channel: 'rpc-event', kind: 'embedder-degraded', state: 'wasm', device: info.device })
    .catch(() => {})
})

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
// Fix 2: drop low-prose (citation/boilerplate) chunks at index time. 0.35 matches the eval
// harness threshold; the all-dropped guard inside CaptureService keeps table-heavy pages
// findable.
const capture = new CaptureService(chunker, store, 0.35)
const indexing = new IndexingService(store, localEmbedder)
// A1: a cross-encoder reranker re-scores the wide candidate pool from hybrid search into a better
// top-k (measured lift on the english golden set: P@1 0.58->0.83). Best-effort: if the model can't
// load on this device, RecallService silently falls back to the hybrid order.
const reranker = new WebGpuReranker()
const recall = new RecallService(localEmbedder, store, reranker)
let answerGeneratorP: Promise<AnswerGeneratorPort> | null = null
let answerGeneratorReady = false
let askModelStatus: AskModelStatus = INITIAL_ASK_MODEL_STATUS

function emitAskModelProgress(e: { status: string; progress?: number; error?: string }): void {
  askModelStatus = reduceAskModelProgress(askModelStatus, e)
  chrome.runtime
    .sendMessage({ channel: 'rpc-event', kind: 'ask-model-progress', status: e })
    .catch(() => {})
}

function getAnswerGenerator(): Promise<AnswerGeneratorPort> {
  if (!answerGeneratorP) {
    answerGeneratorReady = false
    // Composition root chooses the Ask model. Gemma 3 1B was tried (B2) but its WebLLM wasm
    // runtime crashed on this setup ("Program terminated with exit(1)") after a cascade of
    // config fixes, while Llama runs -- so Gemma3-1B isn't viable here. Back on Llama; swap the
    // spec (GEMMA_ASK_SPEC stays defined, model still hosted) if a future web-llm fixes Gemma3.
    answerGeneratorP = createAskEngine(LLAMA_ASK_SPEC, emitAskModelProgress)
      .then((engine) => {
        answerGeneratorReady = true
        askModelStatus = { state: 'ready', percent: 100 }
        return new WebLlmAnswerGenerator(engine)
      })
      .catch((err) => {
        answerGeneratorP = null
        answerGeneratorReady = false
        emitAskModelProgress({ status: 'error', error: describeError(err) })
        throw err
      })
  }
  return answerGeneratorP
}

function getReadyAnswerGenerator(): AnswerGeneratorPort | Promise<AnswerGeneratorPort> {
  if (!answerGeneratorReady || !answerGeneratorP) {
    throw new Error('WebLLM is not ready yet.')
  }
  return answerGeneratorP
}
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
    }, ({ chunks, ms }) => {
      console.log(`[Recall:perf] capture-indexed chunks=${chunks} ms=${ms}`)
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

// ---------------------------------------------------------------------------
// Re-index (model-swap migration) progress helpers. They reuse the existing
// indexing-progress rpc-event and ADD a `total` (the page count) so the side
// panel can render a real "N of M" bar. emitReindexTotal carries the page-level
// {done,total}; bumpReindexProgress keeps the per-page drain's chunk activity
// flowing so the bar still moves within a page.
// ---------------------------------------------------------------------------

let reindexEmbedded = 0
function bumpReindexProgress(n: number): void {
  reindexEmbedded += n
  chrome.runtime
    .sendMessage({ channel: 'rpc-event', kind: 'indexing-progress', embedded: reindexEmbedded })
    .catch(() => {})
}
function emitReindexTotal(p: { done: number; total: number }): void {
  chrome.runtime
    .sendMessage({ channel: 'rpc-event', kind: 'indexing-progress', embedded: p.done, total: p.total })
    .catch(() => {})
}

// On load: (1) load BGE; (2) if this profile's stored version differs from BGE's
// (e5-era profiles have none, or a legacy id), re-embed the corpus PAGE BY PAGE - so search
// degrades gradually (already-re-embedded pages keep serving) instead of going blank; (3) run
// the normal drain afterward to finish any chunks left pending (a fresh capture or an
// interrupted re-index). The migration + drain broadcast indexing-progress (now with a
// `total`), which the side panel renders as the "updating search index N of M" state.
// The store worker may still be initialising its OPFS DB; pendingChunks() waits for the
// worker's initPromise before replying, so this is safe to start now.
// Set once the model failed on BOTH WebGPU and WASM. After that, capture/ping/alarm re-drains
// MUST NOT re-attempt the doomed full model load every time (battery): capture still stores NULL
// chunks, but no drain is spun. Memoized so a 'give up' is decided exactly once per session.
let embedderUnavailable = false

embedder
  .ensureLoaded()
  .then(async () => {
    // Suppress capture/ping/alarm keep-alive drains for the duration of the model-swap migration
    // so they cannot steal the embed slot and defeat the gradual page-by-page re-index. The
    // migration drives indexing.drainForMigration() per page instead.
    indexing.beginMigration()
    try {
      await migrateEmbeddingModel(
        store,
        settings,
        EMBED_MODEL_VERSION,
        // Re-embed this page's freshly-nulled chunks to completion, even under a concurrent
        // keep-alive drain. Return the drain promise DIRECTLY (no new Promise(done=>...) wrapper)
        // so a drain rejection PROPAGATES to migrateEmbeddingModel -> the outer .catch, instead
        // of silently never resolving and hanging the whole offscreen init chain.
        () => indexing.drainForMigration((n) => bumpReindexProgress(n)),
        (p) => emitReindexTotal(p),
      )
    } finally {
      indexing.endMigration()
    }
    await runDrainWithProgress() // finish any freshly-captured chunks
  })
  .catch((e) => {
    // ensureLoaded rejects ONLY when BGE failed on BOTH WebGPU and WASM: this device cannot
    // run the on-device model. Surface an explicit "search unavailable on this hardware" state
    // so the user isn't left with capture silently piling up NULL-vector chunks that never
    // become searchable. Do NOT spin the drain - every embed would just fail.
    console.error('[recall/offscreen] BGE unavailable on this device:', e)
    embedderUnavailable = true
    chrome.runtime
      .sendMessage({ channel: 'rpc-event', kind: 'embedder-degraded', state: 'unavailable' })
      .catch(() => {})
  })

// Prewarm the cross-encoder reranker IN PARALLEL with the embedder above. Reranking is a core
// part of search, not an add-on, so we download it up front (alongside the embedding model)
// instead of lazily on the first query -- otherwise the first search pays a ~22MB fetch + load.
// Fully independent of the embedder chain: a reranker load failure never blocks capture/indexing
// or the embedder, and search still falls back to the raw hybrid order at query time.
reranker
  .ensureLoaded()
  .then(() => console.log(`[recall] reranker prewarmed (device=${reranker.device})`))
  .catch((e) => console.warn('[recall] reranker prewarm failed (search falls back to hybrid order):', String(e)))

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
    // If the model is known-unavailable on this device, store the NULL chunks but do NOT spin a
    // drain (every embed would just fail and re-pay the doomed model load - battery).
    if (!embedderUnavailable) runDrainWithProgress()
    return { captured: true, chunkCount }
  }

  // --- capture-text: seed PROVIDED text (onboarding try-it card, no active tab). Unlike
  //     `capture` this skips the gate on purpose: a seeded demo doc is always stored (the
  //     user clicked "Add 3 sample pages"). Reuses the SAME CaptureService.capture() + drain
  //     as a real capture. ---
  if (op === 'capture-text') {
    const url = p.url as string
    const title = p.title as string
    const text = p.text as string
    const { chunkCount } = await capture.capture({ url, title, text, force: true })
    console.log(`[recall] capture-text seeded ${chunkCount} chunks`)
    if (!embedderUnavailable) runDrainWithProgress()
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

  // --- page-pending: does THIS page still have un-embedded chunks? Drives the side panel's
  //     per-page indexing indicator. Normalize the RAW tab url with the EXACT same two steps
  //     capture + has-page use (sanitizeUrl THEN pageIdFromUrl) so the id can't drift. ---
  if (op === 'page-pending') {
    const raw = p.url as string | undefined
    if (!raw) return { pending: false }
    try {
      const pageId = pageIdFromUrl(sanitizeUrl(raw))
      return { pending: await store.pagePending(pageId) }
    } catch {
      return { pending: false }
    }
  }

  // --- recent-pages: reverse-chronological browse for the History tab ---
  if (op === 'recent-pages') {
    const limit = p.limit as number
    const beforeTs = p.beforeTs as number | undefined
    return { pages: await store.recentPages(limit, beforeTs) }
  }


  // --- recall: embed query, hybrid search, cross-encoder rerank ---
  if (op === 'recall') {
    const text = p.text as string
    const k = p.k as number
    // [Recall:perf] end-to-end recall latency incl. rerank. Read this in the offscreen console to
    // check the reranker isn't making search feel slow (the one thing not measurable offline).
    const t0 = performance.now()
    const results = await recall.recall({ text, k })
    console.log(`[recall] recalled ${results.length} results in ${Math.round(performance.now() - t0)}ms (device=${reranker.device ?? 'n/a'})`)
    return { results }
  }

  // --- ask: retrieve more context, then turn the best chunks into a cited answer ---
  if (op === 'ask') {
    const text = String(p.text ?? '')
    const retrieveK = Number(p.retrieveK ?? 12)
    const contextK = Number(p.contextK ?? 8)
    const ask = new AskService(localEmbedder, store, await getReadyAnswerGenerator(), undefined, reranker)
    const answer = await ask.ask({ text, retrieveK, contextK })
    return { answer }
  }

  if (op === 'ask-stream') {
    const requestId = String(p.requestId ?? '')
    const text = String(p.text ?? '')
    const retrieveK = Number(p.retrieveK ?? 12)
    const contextK = Number(p.contextK ?? 8)
    const ask = new AskService(localEmbedder, store, await getReadyAnswerGenerator(), undefined, reranker)
    const answer = await ask.askStream({ text, retrieveK, contextK }, (delta) => {
      chrome.runtime
        .sendMessage({ channel: 'rpc-event', kind: 'ask-answer-delta', requestId, text: delta })
        .catch(() => {})
    }, (event) => {
      if (event.type === 'expanded-queries') {
        chrome.runtime
          .sendMessage({ channel: 'rpc-event', kind: 'ask-answer-queries', requestId, queries: event.queries })
          .catch(() => {})
      }
    })
    chrome.runtime
      .sendMessage({ channel: 'rpc-event', kind: 'ask-answer-done', requestId, answer })
      .catch(() => {})
    return { ok: true }
  }

  if (op === 'prepare-ask-model') {
    await getAnswerGenerator()
    return { status: askModelStatus }
  }

  if (op === 'ask-model-status') {
    return { status: askModelStatus }
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

  // --- ping: keep-alive from the SW (20s setInterval while warm) OR the chrome.alarms
  //     re-drain (SW-independent, survives SW reaps). Both re-attempt any pending chunks left
  //     by a failed/interrupted drain so capture+embed completes even with the panel closed. ---
  if (op === 'ping') {
    // Re-attempt any pending (un-embedded) chunks left by a failed/interrupted drain.
    // Single-flight + empty-fast, so this is free when there is nothing to do. Skip entirely
    // when the model is known-unavailable (every embed would fail; don't re-pay the model load).
    if (!embedderUnavailable) runDrainWithProgress()
    return { ok: true }
  }
})

console.log('[recall/offscreen] document loaded, core services ready')
