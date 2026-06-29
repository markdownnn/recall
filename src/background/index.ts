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

// Vite's module-preload error handler calls window.dispatchEvent(), which does
// not exist in a service worker.  Aliasing window -> self lets the error
// re-throw the original cause instead of masking it with
// "ReferenceError: window is not defined".
if (typeof window === 'undefined') {
  (self as unknown as { window: typeof globalThis }).window = self as unknown as typeof globalThis
}

// Worker is not available in Chrome extension service workers.
// InlineEmbedder runs the ONNX model directly in the SW thread instead.
const embedder = new InlineEmbedder()
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

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.type !== 'capture' && msg.type !== 'recall') return false
  ;(async () => {
    try {
      const svc = await ready
      if (msg.type === 'capture') {
        await svc.capture.capture({ url: msg.url, title: msg.title, text: msg.text })
        sendResponse({ type: 'captured' } satisfies MsgResult)
      } else if (msg.type === 'recall') {
        const results = await svc.recall.recall({ text: msg.text, k: msg.k })
        sendResponse({ type: 'recalled', results } satisfies MsgResult)
      }
    } catch (err) {
      sendResponse({ type: 'error', error: String(err) } satisfies MsgResult)
    }
  })()
  return true
})
