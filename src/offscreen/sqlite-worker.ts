// Real sqlite worker: owns the OPFS SAH pool DB for the recall extension.
// Handles request messages { id, op, args } and replies { id, result } or { id, error }.
// Declarative SCHEMA array + op->handler MAP. Adding an op = adding a row to the map.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { cosineSimilarity } from '../core/cosine'

import type { CapturedPage, Chunk, RankedResult } from '../core/model'
import type { AppSettings } from '../core/ports'

// ---------------------------------------------------------------------------
// Schema — applied in order on startup
// ---------------------------------------------------------------------------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, url TEXT, title TEXT, capturedAt INTEGER)`,
  `CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, pageId TEXT, idx INTEGER, text TEXT, vector BLOB NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS user_denylist (host TEXT PRIMARY KEY)`,
]

// ---------------------------------------------------------------------------
// Handler functions (existing ops — behavior unchanged)
// ---------------------------------------------------------------------------

function opUpsertPage(db: any, page: CapturedPage): void {
  db.exec({
    sql: `INSERT OR REPLACE INTO pages (id, url, title, capturedAt) VALUES (?, ?, ?, ?)`,
    bind: [page.id, page.url, page.title, page.capturedAt],
  })
}

function opPutChunks(db: any, { pageId, chunks }: { pageId: string; chunks: Chunk[] }): void {
  db.exec({ sql: 'DELETE FROM chunks WHERE pageId = ?', bind: [pageId] })
  for (const chunk of chunks) {
    db.exec({
      sql: `INSERT INTO chunks (id, pageId, idx, text, vector) VALUES (?, ?, ?, ?, NULL)`,
      bind: [chunk.id, chunk.pageId, chunk.index, chunk.text],
    })
  }
}

function opPendingChunks(db: any, { limit }: { limit: number }): Chunk[] {
  const result: Chunk[] = []
  db.exec({
    sql: `SELECT id, pageId, idx, text FROM chunks WHERE vector IS NULL LIMIT ?`,
    bind: [limit],
    rowMode: 'object',
    callback: (r: any) => result.push({ id: r.id, pageId: r.pageId, index: r.idx, text: r.text }),
  })
  return result
}

function opSetVector(db: any, { id, vector }: { id: string; vector: Float32Array }): void {
  // vector arrives via structured clone — it is a real Float32Array.
  // Store the raw bytes as BLOB so we can reconstruct it on search.
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
  db.exec({
    sql: 'UPDATE chunks SET vector = ? WHERE id = ?',
    bind: [bytes, id],
  })
}

function opSearch(db: any, { query, k }: { query: Float32Array; k: number }): RankedResult[] {
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
      scored.push({ chunk, page, score: cosineSimilarity(query, vector) })
    },
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

function opGetSettings(db: any): AppSettings {
  let paused = false
  db.exec({
    sql: `SELECT value FROM settings WHERE key='paused'`,
    rowMode: 'array',
    callback: (r: any) => { paused = r[0] === '1' },
  })
  const userDenyHosts: string[] = []
  db.exec({
    sql: `SELECT host FROM user_denylist`,
    rowMode: 'array',
    callback: (r: any) => userDenyHosts.push(r[0]),
  })
  return { paused, userDenyHosts }
}

function opSetPaused(db: any, paused: boolean): void {
  db.exec({
    sql: `INSERT OR REPLACE INTO settings (key, value) VALUES ('paused', ?)`,
    bind: [paused ? '1' : '0'],
  })
}

function opAddDenyHost(db: any, host: string): void {
  db.exec({
    sql: `INSERT OR IGNORE INTO user_denylist (host) VALUES (?)`,
    bind: [host],
  })
}

// ---------------------------------------------------------------------------
// Op -> handler MAP (declarative)
// ---------------------------------------------------------------------------

const handlers: Record<string, (db: any, args: any) => unknown> = {
  upsertPage: (db, args) => { opUpsertPage(db, args as CapturedPage) },
  putChunks: (db, args) => { opPutChunks(db, args) },
  pendingChunks: (db, args) => opPendingChunks(db, args),
  setVector: (db, args) => { opSetVector(db, args) },
  search: (db, args) => opSearch(db, args),
  getSettings: (db) => opGetSettings(db),
  setPaused: (db, args) => { opSetPaused(db, args as boolean) },
  addDenyHost: (db, args) => { opAddDenyHost(db, args as string) },
}

// ---------------------------------------------------------------------------
// Init: OPFS SAH pool (unchanged)
// ---------------------------------------------------------------------------

let db: any = null

const initPromise: Promise<void> = (async () => {
  try {
    const sqlite3 = await sqlite3InitModule()
    const poolUtil = await (sqlite3 as any).installOpfsSAHPoolVfs({ name: 'recall-pool' })
    db = new poolUtil.OpfsSAHPoolDb('/recall.sqlite3')
    for (const sql of SCHEMA) {
      db.exec({ sql })
    }
    console.log('[recall-worker] sqlite OPFS SAH pool ready, schema created')
  } catch (e) {
    console.error('[recall-worker] init FAILED:', String(e))
    throw new Error(String(e))
  }
})()

// ---------------------------------------------------------------------------
// Message handler (declarative dispatch)
// ---------------------------------------------------------------------------

;(self as DedicatedWorkerGlobalScope).onmessage = async (e: MessageEvent) => {
  const { id, op, args } = e.data as { id: number; op: string; args: any }
  try {
    await initPromise
    const handler = handlers[op]
    if (!handler) throw new Error(`[recall-worker] unknown op: ${op}`)
    const result = handler(db, args)
    ;(self as DedicatedWorkerGlobalScope).postMessage({ id, result })
  } catch (err) {
    ;(self as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err) })
  }
}
