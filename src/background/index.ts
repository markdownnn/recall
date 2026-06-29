import { CaptureService } from '../core/capture-service'
import { RecallService } from '../core/recall-service'
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

let modelStatus: ModelStatus = INITIAL_MODEL_STATUS

function broadcastModelStatus(status: ModelStatus): void {
  chrome.runtime.sendMessage({ type: 'model-progress', status }).catch(() => {
    // Popup may be closed; ignore the error.
  })
}

// Worker is not available in Chrome extension service workers.
// InlineEmbedder runs the ONNX model directly in the SW thread instead.
const embedder = new InlineEmbedder((e) => {
  modelStatus = reduceModelProgress(modelStatus, e)
  broadcastModelStatus(modelStatus)
})
const chunker = new ParagraphChunker(220)

async function buildStore(): Promise<SqliteVectorStore> {
  const sqlite3 = await sqlite3InitModule()
  const db = 'opfs' in sqlite3
    ? new (sqlite3 as any).oo1.OpfsDb('/recall.sqlite3')
    : new sqlite3.oo1.DB()
  return new SqliteVectorStore(db)
}

const ready = (async () => {
  const store = await buildStore()
  return {
    capture: new CaptureService(chunker, embedder, store),
    recall: new RecallService(embedder, store),
  }
})()

// Pre-warm: download and cache the model weights on install so the first
// capture does not have to wait for a ~135 MB download.
chrome.runtime.onInstalled.addListener(() => {
  embedder.ensureLoaded().then(() => {
    modelStatus = { state: 'ready', percent: 100 }
    broadcastModelStatus(modelStatus)
  }).catch(() => {
    modelStatus = { state: 'error', percent: modelStatus.percent }
  })
})

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.type === 'model-status') {
    sendResponse({ type: 'model-status', status: modelStatus } satisfies MsgResult)
    return true
  }

  if (msg.type !== 'capture' && msg.type !== 'recall') return false
  ;(async () => {
    try {
      const svc = await ready
      if (msg.type === 'capture') {
        await svc.capture.capture({ url: msg.url, title: msg.title, text: msg.text })
        modelStatus = { state: 'ready', percent: 100 }
        broadcastModelStatus(modelStatus)
        sendResponse({ type: 'captured' } satisfies MsgResult)
      } else if (msg.type === 'recall') {
        const results = await svc.recall.recall({ text: msg.text, k: msg.k })
        modelStatus = { state: 'ready', percent: 100 }
        broadcastModelStatus(modelStatus)
        sendResponse({ type: 'recalled', results } satisfies MsgResult)
      }
    } catch (err) {
      modelStatus = { state: 'error', percent: modelStatus.percent }
      broadcastModelStatus(modelStatus)
      sendResponse({ type: 'error', error: String(err) } satisfies MsgResult)
    }
  })()
  return true
})
