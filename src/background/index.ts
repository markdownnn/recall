import { CaptureService } from '../core/capture-service'
import { RecallService } from '../core/recall-service'
import { ParagraphChunker } from '../core/paragraph-chunker'
import { TransformersEmbedder } from '../adapters/transformers-embedder'
import { SqliteVectorStore } from '../adapters/sqlite-vector-store'
import type { Msg, MsgResult } from '../messaging'

async function buildStore(): Promise<SqliteVectorStore> {
  const sqlite3InitModule = (await import('@sqlite.org/sqlite-wasm')).default
  const sqlite3 = await sqlite3InitModule()
  const db = 'opfs' in sqlite3
    ? new (sqlite3 as any).oo1.OpfsDb('/recall.sqlite3')
    : new sqlite3.oo1.DB()
  return new SqliteVectorStore(db)
}

const worker = new Worker(new URL('../workers/embedder.worker.ts', import.meta.url), { type: 'module' })
const embedder = new TransformersEmbedder(worker)
const chunker = new ParagraphChunker(220)

const ready = (async () => {
  const store = await buildStore()
  return {
    capture: new CaptureService(chunker, embedder, store),
    recall: new RecallService(embedder, store),
  }
})()

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
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
