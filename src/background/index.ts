import { CaptureService } from '../core/capture-service'
import { RecallService } from '../core/recall-service'
import { IndexingService } from '../core/indexing-service'
import { ParagraphChunker } from '../core/paragraph-chunker'
import { InlineEmbedder } from '../adapters/inline-embedder'
import { SqliteVectorStore } from '../adapters/sqlite-vector-store'
// Static import: Vite does NOT wrap static imports in __vitePreload lambdas,
// so this works inside a Chrome extension service worker where dynamic
// import() inside functions is disallowed by the HTML spec.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { Msg, MsgResult } from '../messaging'
import { INITIAL_MODEL_STATUS, reduceModelProgress } from '../core/model-progress'
import type { ModelStatus } from '../core/model-progress'

// Vite's module-preload error handler calls window.dispatchEvent(), which does
// not exist in a service worker.  Aliasing window -> self lets the error
// re-throw the original cause instead of masking it with
// "ReferenceError: window is not defined".
if (typeof window === 'undefined') {
  (self as unknown as { window: typeof globalThis }).window = self as unknown as typeof globalThis
}

console.log('[recall/bg] service worker evaluated')

let modelStatus: ModelStatus = INITIAL_MODEL_STATUS

function broadcastModelStatus(status: ModelStatus): void {
  chrome.runtime.sendMessage({ type: 'model-progress', status }).catch(() => {
    // Popup may be closed; ignore the error.
  })
}

function broadcastIndexingProgress(pending: number, embedded: number): void {
  chrome.runtime.sendMessage({ type: 'indexing-progress', pending, embedded }).catch(() => {
    // Popup may be closed; ignore the error.
  })
}

// Worker is not available in Chrome extension service workers.
// InlineEmbedder runs the ONNX model directly in the SW thread instead.
const embedder = new InlineEmbedder((e) => {
  console.log('[recall/bg] model progress:', e.status, e.progress ?? '')
  modelStatus = reduceModelProgress(modelStatus, e)
  broadcastModelStatus(modelStatus)
})
const chunker = new ParagraphChunker(220)

async function buildStore(): Promise<SqliteVectorStore> {
  const sqlite3 = await sqlite3InitModule()
  const hasOpfs = 'opfs' in sqlite3
  console.log('[recall/bg] storage backend:', hasOpfs ? 'OPFS (persistent)' : 'in-memory (NOT persistent across restarts)')
  const db = hasOpfs
    ? new (sqlite3 as any).oo1.OpfsDb('/recall.sqlite3')
    : new sqlite3.oo1.DB()
  return new SqliteVectorStore(db)
}

const ready = (async () => {
  const store = await buildStore()
  console.log('[recall/bg] services ready')
  return {
    capture: new CaptureService(chunker, store),
    recall: new RecallService(embedder, store),
    indexing: new IndexingService(store, embedder),
    store,
  }
})()

// Pre-warm: download and cache the model weights on install so the first
// capture does not have to wait for a ~135 MB download.
chrome.runtime.onInstalled.addListener(() => {
  console.log('[recall/bg] onInstalled: pre-warming model...')
  embedder.ensureLoaded().then(() => {
    console.log('[recall/bg] pre-warm complete: model ready')
    modelStatus = { state: 'ready', percent: 100 }
    broadcastModelStatus(modelStatus)
  }).catch((e) => {
    console.error('[recall/bg] pre-warm FAILED:', e)
    modelStatus = { state: 'error', percent: modelStatus.percent }
  })
})

// Guard so only one drain runs at a time (IndexingService already single-flights
// within a session; this flag also prevents concurrent runDrain() calls from
// stacking up in the background scope).
let drainInProgress = false

// runDrain: infrastructure-level drain wrapper.
// Owns the keepalive timer (infra, not core) and broadcasts progress to the popup.
async function runDrain(): Promise<void> {
  if (drainInProgress) return
  drainInProgress = true
  // Keepalive: reset the MV3 idle timer every 20s so the SW is not killed mid-drain.
  const ka = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}) }, 20_000)
  try {
    const svc = await ready
    let totalEmbedded = 0
    await svc.indexing.drain((embeddedCount) => {
      totalEmbedded += embeddedCount
      // Broadcast progress: pending is approximate (1 = still going, 0 = done).
      broadcastIndexingProgress(1, totalEmbedded)
    })
    // Drain complete: broadcast pending=0 so the popup can show "indexed".
    broadcastIndexingProgress(0, totalEmbedded)
    console.log('[recall/bg] drain complete, total embedded:', totalEmbedded)
    if (totalEmbedded > 0) {
      modelStatus = { state: 'ready', percent: 100 }
      broadcastModelStatus(modelStatus)
    }
  } finally {
    clearInterval(ka)
    drainInProgress = false
  }
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.type === 'model-status') {
    sendResponse({ type: 'model-status', status: modelStatus } satisfies MsgResult)
    return true
  }

  if (msg.type !== 'capture' && msg.type !== 'recall') return false
  ;(async () => {
    try {
      console.log('[recall/bg]', msg.type, ': waiting for services...')
      const svc = await ready
      if (msg.type === 'capture') {
        console.log('[recall/bg] capture: storing chunks, text length =', msg.text.length)
        const { chunkCount } = await svc.capture.capture({ url: msg.url, title: msg.title, text: msg.text })
        console.log('[recall/bg] capture: DONE, chunkCount =', chunkCount, ', responding immediately')
        // Respond immediately — embedding happens in the background.
        sendResponse({ type: 'captured', chunkCount } satisfies MsgResult)
        // Fire-and-forget: drain the embedding queue in the background.
        runDrain().catch((e) => console.error('[recall/bg] drain FAILED:', e))
      } else if (msg.type === 'recall') {
        const results = await svc.recall.recall({ text: msg.text, k: msg.k })
        console.log('[recall/bg] recall: DONE, results =', results.length)
        modelStatus = { state: 'ready', percent: 100 }
        broadcastModelStatus(modelStatus)
        sendResponse({ type: 'recalled', results } satisfies MsgResult)
      }
    } catch (err) {
      console.error('[recall/bg]', msg.type, 'FAILED:', err)
      modelStatus = { state: 'error', percent: modelStatus.percent }
      broadcastModelStatus(modelStatus)
      sendResponse({ type: 'error', error: String(err) } satisfies MsgResult)
    }
  })()
  return true
})

// On service-worker startup, resume embedding any chunks left pending from a
// previous session (durable queue: chunks live in SQLite with vector = NULL).
ready.then(() => {
  runDrain().catch((e) => console.error('[recall/bg] startup drain FAILED:', e))
})

// ---------------------------------------------------------------------------
// Spike: validate offscreen-document + dedicated-worker + OPFS SAH pool chain.
// This block is ADDITIVE and isolated — it does not affect capture / recall /
// embedding logic.  Remove it once the architecture decision is made.
// ---------------------------------------------------------------------------

async function ensureOffscreen(): Promise<void> {
  const exists = await chrome.offscreen?.hasDocument?.()
  if (exists) return
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('src/offscreen/offscreen.html'),
    reasons: ['BLOBS'],
    justification: 'sqlite OPFS persistence via dedicated worker (spike)',
  })
}

// The existing onMessage listener returns false for unknown types, so
// 'spike-bump' is ignored there and handled only by the offscreen document.
ready.then(() => {
  ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ type: 'spike-bump' }))
    .then((res: any) => {
      console.log('[recall/spike] persistent counter =', res?.counter, '| webgpu:', res?.webgpu)
      // Write to extension storage so the Playwright spike test can read the
      // counter from an extension page without parsing console output.
      chrome.storage.local.set({
        __spike_state: {
          counter: res?.counter ?? null,
          webgpu: res?.webgpu ?? 'unknown',
          error: res?.error ?? null,
          sessionId: Date.now(),
        },
      })
    })
    .catch((e) => console.error('[recall/spike] FAILED:', e))
})
