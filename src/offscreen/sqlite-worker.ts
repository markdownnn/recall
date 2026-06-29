// Real sqlite worker: owns the OPFS SAH pool DB for the recall extension.
// Handles request messages { id, op, args } and replies { id, result } or { id, error }.
// Ops mirror VectorSearchPort: upsertPage, putChunks, pendingChunks, setVector, search.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { cosineSimilarity } from '../core/cosine'

import type { CapturedPage, Chunk, RankedResult } from '../core/model'

let db: any = null

const initPromise: Promise<void> = (async () => {
  try {
    const sqlite3 = await sqlite3InitModule()
    const poolUtil = await (sqlite3 as any).installOpfsSAHPoolVfs({ name: 'recall-pool' })
    db = new poolUtil.OpfsSAHPoolDb('/recall.sqlite3')
    db.exec({ sql: `CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, url TEXT, title TEXT, capturedAt INTEGER)` })
    db.exec({ sql: `CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, pageId TEXT, idx INTEGER, text TEXT, vector BLOB NULL)` })
    console.log('[recall-worker] sqlite OPFS SAH pool ready, schema created')
  } catch (e) {
    console.error('[recall-worker] init FAILED:', String(e))
    throw new Error(String(e))
  }
})()

function opUpsertPage(page: CapturedPage): void {
  db.exec({
    sql: `INSERT OR REPLACE INTO pages (id, url, title, capturedAt) VALUES (?, ?, ?, ?)`,
    bind: [page.id, page.url, page.title, page.capturedAt],
  })
}

function opPutChunks(pageId: string, chunks: Chunk[]): void {
  db.exec({ sql: 'DELETE FROM chunks WHERE pageId = ?', bind: [pageId] })
  for (const chunk of chunks) {
    db.exec({
      sql: `INSERT INTO chunks (id, pageId, idx, text, vector) VALUES (?, ?, ?, ?, NULL)`,
      bind: [chunk.id, chunk.pageId, chunk.index, chunk.text],
    })
  }
}

function opPendingChunks(limit: number): Chunk[] {
  const result: Chunk[] = []
  db.exec({
    sql: `SELECT id, pageId, idx, text FROM chunks WHERE vector IS NULL LIMIT ?`,
    bind: [limit],
    rowMode: 'object',
    callback: (r: any) => result.push({ id: r.id, pageId: r.pageId, index: r.idx, text: r.text }),
  })
  return result
}

function opSetVector(chunkId: string, vectorF32: Float32Array): void {
  // vectorF32 arrives via structured clone — it is a real Float32Array.
  // Store the raw bytes as BLOB so we can reconstruct it on search.
  const bytes = new Uint8Array(vectorF32.buffer, vectorF32.byteOffset, vectorF32.byteLength)
  db.exec({
    sql: 'UPDATE chunks SET vector = ? WHERE id = ?',
    bind: [bytes, chunkId],
  })
}

function opSearch(queryF32: Float32Array, k: number): RankedResult[] {
  // Load all pages into a Map for O(1) lookup during chunk iteration.
  const pages = new Map<string, CapturedPage>()
  db.exec({
    sql: `SELECT id, url, title, capturedAt FROM pages`,
    rowMode: 'object',
    callback: (r: any) => pages.set(r.id, { id: r.id, url: r.url, title: r.title, capturedAt: r.capturedAt }),
  })

  const scored: RankedResult[] = []
  db.exec({
    sql: `SELECT id, pageId, idx, text, vector FROM chunks WHERE vector IS NOT NULL`,
    rowMode: 'object',
    callback: (r: any) => {
      const page = pages.get(r.pageId)
      if (!page) return
      // Safe blob -> Float32Array reconstruction (same pattern as SqliteVectorStore).
      const bytes = r.vector as Uint8Array
      const f32view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      // Copy to a standalone array so it outlives the callback frame.
      const vector = new Float32Array(f32view)
      const chunk: Chunk = { id: r.id, pageId: r.pageId, index: r.idx, text: r.text }
      scored.push({ chunk, page, score: cosineSimilarity(queryF32, vector) })
    },
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

;(self as DedicatedWorkerGlobalScope).onmessage = async (e: MessageEvent) => {
  const { id, op, args } = e.data as { id: number; op: string; args: any }
  try {
    await initPromise
    let result: unknown
    switch (op) {
      case 'upsertPage':
        opUpsertPage(args.page as CapturedPage)
        result = undefined
        break
      case 'putChunks':
        opPutChunks(args.pageId as string, args.chunks as Chunk[])
        result = undefined
        break
      case 'pendingChunks':
        result = opPendingChunks(args.limit as number)
        break
      case 'setVector':
        opSetVector(args.chunkId as string, args.vector as Float32Array)
        result = undefined
        break
      case 'search':
        result = opSearch(args.queryVector as Float32Array, args.k as number)
        break
      default:
        throw new Error(`[recall-worker] unknown op: ${op}`)
    }
    ;(self as DedicatedWorkerGlobalScope).postMessage({ id, result })
  } catch (err) {
    ;(self as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err) })
  }
}
